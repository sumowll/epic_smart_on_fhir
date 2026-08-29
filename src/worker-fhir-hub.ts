import { DurableObject } from "cloudflare:workers";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "./canonical-json.js";
import { AppError } from "./errors.js";
import {
  StateBackedFhirHubRepository,
  fhirHubIdentitySchema,
  fhirHubStateSchema,
  type FhirHubConsentReceipt,
  type FhirHubExport,
  type FhirHubIdentity,
  type FhirHubIngestResult,
  type FhirHubIntelligenceOptions,
  type FhirHubIntelligenceView,
  type FhirHubListOptions,
  type FhirHubRepository,
  type FhirHubResourceVersion,
  type FhirHubState,
  type FhirHubStatePersistence,
  type FhirHubStatus,
} from "./fhir-hub.js";

const accountReferencePattern = /^[A-Za-z0-9_-]{43}$/;
const hubStateAdditionalDataPrefix = "moonba:epic-fhir-hub-state:v2";

// Cloudflare SQLite limits a TEXT/BLOB value and a row to 2 MB. Keep every
// ciphertext row well below that boundary and cap the complete account state
// so decrypt/parse cannot consume an unbounded amount of Worker memory.
const hubStateFormatVersion = 2;
const hubStateChunkChars = 512 * 1_024;
const maxHubStatePlaintextBytes = 16 * 1_024 * 1_024;
const maxHubStateCiphertextChars = Math.ceil(maxHubStatePlaintextBytes / 3) * 4;
const maxHubStateChunks = Math.ceil(maxHubStateCiphertextChars / hubStateChunkChars);
const canonicalBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const generationPattern = /^[A-Za-z0-9_-]{22}$/;

export const fhirHubReadinessIdentity: FhirHubIdentity = {
  accountRef: "h".repeat(43),
  sourceConnectionId: "s".repeat(43),
  patientSubjectId: "p".repeat(43),
  fhirIssuer: "https://readiness.invalid/fhir",
};

const encryptedHubManifestSchema = z.object({
  formatVersion: z.literal(hubStateFormatVersion),
  algorithm: z.literal("A256GCM"),
  generation: z.string().regex(generationPattern),
  iv: z.string(),
  tag: z.string(),
  chunkCount: z.number().int().min(1).max(maxHubStateChunks),
  chunkSize: z.literal(hubStateChunkChars),
  ciphertextChars: z.number().int().min(1).max(maxHubStateCiphertextChars),
  cleanupAfter: z.number().int().nonnegative(),
});

type EncryptedHubManifest = z.infer<typeof encryptedHubManifestSchema>;

interface HubManifestRow extends Record<string, SqlStorageValue> {
  readonly formatVersion: number;
  readonly algorithm: string;
  readonly generation: string;
  readonly iv: string;
  readonly tag: string;
  readonly chunkCount: number;
  readonly chunkSize: number;
  readonly ciphertextChars: number;
  readonly cleanupAfter: number | null;
}

interface HubChunkRow extends Record<string, SqlStorageValue> {
  readonly chunkIndex: number;
  readonly ciphertext: string;
}

interface HubCleanupRow extends Record<string, SqlStorageValue> {
  readonly cleanupAfter: number | null;
}

interface HubManifestColumnRow extends Record<string, SqlStorageValue> {
  readonly name: string;
}

interface WorkerFhirHubBindings {
  readonly EPIC_FHIR_HUB: DurableObjectNamespace<EpicFhirHub>;
  readonly FHIR_HUB_ENCRYPTION_KEY?: string;
}

function requireHubEncryptionKey(encoded: string | undefined): Buffer {
  if (!encoded) {
    throw new AppError(
      500,
      "invalid_config",
      "FHIR_HUB_ENCRYPTION_KEY is required when the private health hub is enabled.",
    );
  }
  const normalized = encoded.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new AppError(
      500,
      "invalid_config",
      "FHIR_HUB_ENCRYPTION_KEY must be a base64-encoded 32-byte key.",
    );
  }
  const key = Buffer.from(normalized, "base64");
  if (key.length !== 32) {
    throw new AppError(
      500,
      "invalid_config",
      "FHIR_HUB_ENCRYPTION_KEY must decode to exactly 32 bytes.",
    );
  }
  return key;
}

function additionalData(objectId: string, generation: string): string {
  return `${hubStateAdditionalDataPrefix}:${objectId}:${generation}`;
}

function decodeCanonicalBase64(value: string, expectedBytes?: number): Buffer {
  if (!canonicalBase64Pattern.test(value)) {
    throw new Error("Invalid base64 in the FHIR hub encryption manifest.");
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.toString("base64") !== value ||
    (expectedBytes !== undefined && decoded.length !== expectedBytes)
  ) {
    throw new Error("Non-canonical base64 in the FHIR hub encryption manifest.");
  }
  return decoded;
}

function validateGeneration(value: string): void {
  if (!generationPattern.test(value)) {
    throw new Error("Invalid FHIR hub ciphertext generation.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 16 || decoded.toString("base64url") !== value) {
    throw new Error("Non-canonical FHIR hub ciphertext generation.");
  }
}

function createGeneration(): string {
  return randomBytes(16).toString("base64url");
}

function cleanupAfterForState(state: FhirHubState): number {
  const expiries = Object.values(state.resourceVersions)
    .map((version) => Date.parse(version.expiresAt));
  // If ciphertext is unreadable, individual expired versions cannot be pruned.
  // Delete the whole shard at the earliest deadline so no resource survives
  // past its own approved retention boundary.
  return expiries.length === 0 ? 0 : Math.min(...expiries);
}

function encryptState(
  state: FhirHubState,
  key: Buffer,
  objectId: string,
  generation: string,
): { readonly manifest: EncryptedHubManifest; readonly chunks: readonly string[] } {
  const plaintext = Buffer.from(canonicalJson(state), "utf8");
  if (plaintext.length > maxHubStatePlaintextBytes) {
    throw new AppError(
      413,
      "fhir_hub_store_too_large",
      "The private health hub exceeds the 16 MiB encrypted account-state limit.",
    );
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(additionalData(objectId, generation), "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);
  const encoded = ciphertext.toString("base64");
  const chunks: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += hubStateChunkChars) {
    chunks.push(encoded.slice(offset, offset + hubStateChunkChars));
  }
  if (chunks.length < 1 || chunks.length > maxHubStateChunks) {
    throw new AppError(
      413,
      "fhir_hub_store_too_large",
      "The private health hub exceeds the encrypted account-state chunk limit.",
    );
  }
  return {
    manifest: encryptedHubManifestSchema.parse({
      formatVersion: hubStateFormatVersion,
      algorithm: "A256GCM",
      generation,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      chunkCount: chunks.length,
      chunkSize: hubStateChunkChars,
      ciphertextChars: encoded.length,
      cleanupAfter: cleanupAfterForState(state),
    }),
    chunks,
  };
}

function validateManifest(row: HubManifestRow): EncryptedHubManifest {
  const manifest = encryptedHubManifestSchema.parse({
    ...row,
    // A null value exists only while initialize() is backfilling a manifest
    // created before the cleanup-deadline column was introduced.
    cleanupAfter: row.cleanupAfter ?? 0,
  });
  validateGeneration(manifest.generation);
  decodeCanonicalBase64(manifest.iv, 12);
  decodeCanonicalBase64(manifest.tag, 16);
  if (
    manifest.chunkCount !== Math.ceil(manifest.ciphertextChars / manifest.chunkSize)
  ) {
    throw new Error("The FHIR hub chunk manifest is inconsistent.");
  }
  return manifest;
}

function assembleCiphertext(
  manifest: EncryptedHubManifest,
  rows: readonly HubChunkRow[],
): Buffer {
  if (rows.length !== manifest.chunkCount) {
    throw new Error("The FHIR hub ciphertext has a missing or extra chunk.");
  }
  const chunks: string[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || row.chunkIndex !== index) {
      throw new Error("The FHIR hub ciphertext chunks are out of order.");
    }
    const expectedLength = index === manifest.chunkCount - 1
      ? manifest.ciphertextChars - (manifest.chunkSize * index)
      : manifest.chunkSize;
    if (
      typeof row.ciphertext !== "string" ||
      row.ciphertext.length !== expectedLength ||
      row.ciphertext.length > hubStateChunkChars
    ) {
      throw new Error("The FHIR hub ciphertext chunk length is invalid.");
    }
    // Chunks are cut on four-character boundaries. Padding is therefore valid
    // only in the final chunk, and the joined value must still round-trip.
    if (
      !/^[A-Za-z0-9+/]+={0,2}$/.test(row.ciphertext) ||
      (index < manifest.chunkCount - 1 && row.ciphertext.includes("="))
    ) {
      throw new Error("The FHIR hub ciphertext chunk is not canonical base64.");
    }
    chunks.push(row.ciphertext);
  }
  const encoded = chunks.join("");
  if (encoded.length !== manifest.ciphertextChars) {
    throw new Error("The FHIR hub ciphertext length does not match its manifest.");
  }
  return decodeCanonicalBase64(encoded);
}

function decryptState(
  manifest: EncryptedHubManifest,
  chunkRows: readonly HubChunkRow[],
  key: Buffer,
  objectId: string,
): FhirHubState {
  const iv = decodeCanonicalBase64(manifest.iv, 12);
  const tag = decodeCanonicalBase64(manifest.tag, 16);
  const ciphertext = assembleCiphertext(manifest, chunkRows);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(additionalData(objectId, manifest.generation), "utf8"));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  if (plaintext.length > maxHubStatePlaintextBytes) {
    throw new Error("The decrypted FHIR hub state exceeds its size limit.");
  }
  return fhirHubStateSchema.parse(JSON.parse(plaintext.toString("utf8")));
}

function manifestBindings(manifest: EncryptedHubManifest): readonly SqlStorageValue[] {
  return [
    manifest.formatVersion,
    manifest.algorithm,
    manifest.generation,
    manifest.iv,
    manifest.tag,
    manifest.chunkCount,
    manifest.chunkSize,
    manifest.ciphertextChars,
    manifest.cleanupAfter,
  ];
}

function manifestSql(): string {
  return `INSERT INTO fhir_hub_manifest (
      singleton, format_version, algorithm, generation, iv, tag,
      chunk_count, chunk_size, ciphertext_chars, cleanup_after, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET
      format_version = excluded.format_version,
      algorithm = excluded.algorithm,
      generation = excluded.generation,
      iv = excluded.iv,
      tag = excluded.tag,
      chunk_count = excluded.chunk_count,
      chunk_size = excluded.chunk_size,
      ciphertext_chars = excluded.ciphertext_chars,
      cleanup_after = excluded.cleanup_after,
      updated_at = excluded.updated_at`;
}

/**
 * An application-encrypted, generation-based state store for one account-
 * scoped Durable Object. The small manifest is an atomic pointer: a save writes
 * every new ciphertext chunk before switching it. The Durable Object ID and
 * generation are authenticated, so blobs cannot be moved across account shards
 * or mixed between generations.
 */
export class DurableObjectFhirHubStatePersistence implements FhirHubStatePersistence {
  public readonly durable = true;
  #cleanupDeadlineTrusted = true;

  public constructor(
    private readonly sql: SqlStorage,
    private readonly encryptionKey: Buffer,
    private readonly objectId: string,
    private readonly now: () => number = Date.now,
  ) {
    if (encryptionKey.length !== 32) {
      throw new AppError(
        500,
        "invalid_encryption_key",
        "The FHIR hub encryption key must be 32 bytes.",
      );
    }
    if (!objectId) {
      throw new AppError(
        500,
        "invalid_fhir_hub_object",
        "The FHIR hub storage object identifier is invalid.",
      );
    }
  }

  public async initialize(): Promise<void> {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS fhir_hub_manifest (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        format_version INTEGER NOT NULL CHECK (format_version = ${hubStateFormatVersion}),
        algorithm TEXT NOT NULL CHECK (algorithm = 'A256GCM'),
        generation TEXT NOT NULL CHECK (length(generation) = 22),
        iv TEXT NOT NULL CHECK (length(iv) = 16),
        tag TEXT NOT NULL CHECK (length(tag) = 24),
        chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 1 AND ${maxHubStateChunks}),
        chunk_size INTEGER NOT NULL CHECK (chunk_size = ${hubStateChunkChars}),
        ciphertext_chars INTEGER NOT NULL CHECK (ciphertext_chars BETWEEN 1 AND ${maxHubStateCiphertextChars}),
        cleanup_after INTEGER NOT NULL CHECK (cleanup_after >= 0),
        updated_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS fhir_hub_chunks (
        generation TEXT NOT NULL,
        chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND ${maxHubStateChunks - 1}),
        ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 1 AND ${hubStateChunkChars}),
        PRIMARY KEY (generation, chunk_index)
      )
    `);
    const manifestColumns = this.sql.exec<HubManifestColumnRow>(
      "PRAGMA table_info(fhir_hub_manifest)",
    ).toArray();
    if (!manifestColumns.some((column) => column.name === "cleanup_after")) {
      // SQLite cannot add a non-null column without assigning an indistinguishable
      // default to old rows. A temporary null is an explicit migration marker;
      // load() decrypts the legacy generation, derives the exact deadline, and
      // backfills it before repository initialization can succeed.
      this.sql.exec(
        `ALTER TABLE fhir_hub_manifest
         ADD COLUMN cleanup_after INTEGER CHECK (cleanup_after >= 0)`,
      );
    }
  }

  public async load(): Promise<FhirHubState | undefined> {
    const row = this.sql
      .exec<HubManifestRow>(
        `SELECT
           format_version AS formatVersion,
           algorithm,
           generation,
           iv,
           tag,
           chunk_count AS chunkCount,
           chunk_size AS chunkSize,
           ciphertext_chars AS ciphertextChars,
           cleanup_after AS cleanupAfter
         FROM fhir_hub_manifest
         WHERE singleton = 1`,
      )
      .toArray()[0];
    if (!row) {
      this.#cleanupDeadlineTrusted = true;
      return undefined;
    }
    try {
      const manifest = validateManifest(row);
      const chunks = this.sql.exec<HubChunkRow>(
        `SELECT chunk_index AS chunkIndex, ciphertext
         FROM fhir_hub_chunks
         WHERE generation = ?
         ORDER BY chunk_index ASC
         LIMIT ?`,
        manifest.generation,
        manifest.chunkCount + 1,
      ).toArray();
      const state = decryptState(
        manifest,
        chunks,
        this.encryptionKey,
        this.objectId,
      );
      const expectedCleanupAfter = cleanupAfterForState(state);
      if (
        row.cleanupAfter === null ||
        manifest.cleanupAfter !== expectedCleanupAfter
      ) {
        // A legacy writer or metadata corruption can leave this plaintext
        // derivative stale even though the authenticated state is readable.
        // Repair from that state, but prevent the recovery alarm from trusting
        // the old value unless the update can be read back exactly.
        this.#cleanupDeadlineTrusted = false;
        this.sql.exec(
          `UPDATE fhir_hub_manifest
           SET cleanup_after = ?
           WHERE singleton = 1 AND generation = ?`,
          expectedCleanupAfter,
          manifest.generation,
        );
        const repaired = this.readPersistedCleanupAfter();
        if (repaired !== expectedCleanupAfter) {
          throw new Error("The FHIR hub cleanup deadline repair was not durable.");
        }
      }
      this.#cleanupDeadlineTrusted = true;
      return state;
    } catch (error) {
      throw new AppError(
        503,
        "fhir_hub_store_unreadable",
        "The private health hub could not be read safely.",
        { cause: error },
      );
    }
  }

  public async save(stateInput: FhirHubState): Promise<void> {
    const state = fhirHubStateSchema.parse(stateInput);
    const generation = createGeneration();
    let encrypted: ReturnType<typeof encryptState>;
    try {
      encrypted = encryptState(
        state,
        this.encryptionKey,
        this.objectId,
        generation,
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "fhir_hub_store_too_large") {
        throw error;
      }
      throw new AppError(
        503,
        "fhir_hub_store_unavailable",
        "The private health hub could not be stored safely.",
        { cause: error },
      );
    }
    try {
      // INSERT (never UPSERT) prevents an astronomically unlikely generation
      // collision from overwriting chunks referenced by the current manifest.
      for (let index = 0; index < encrypted.chunks.length; index += 1) {
        this.sql.exec(
          `INSERT INTO fhir_hub_chunks (generation, chunk_index, ciphertext)
           VALUES (?, ?, ?)`,
          generation,
          index,
          encrypted.chunks[index]!,
        );
      }

      // This one SQLite statement is the commit point. Until it succeeds,
      // load() continues to select every chunk from the previous generation.
      this.sql.exec(
        manifestSql(),
        ...manifestBindings(encrypted.manifest),
        this.now(),
      );
      this.#cleanupDeadlineTrusted = true;
    } catch (error) {
      try {
        this.sql.exec(
          "DELETE FROM fhir_hub_chunks WHERE generation = ?",
          generation,
        );
      } catch {
        // An orphan is encrypted, unreferenced, and removed after the next
        // successful generation switch. Never mask the original write error.
      }
      throw new AppError(
        503,
        "fhir_hub_store_unavailable",
        "The private health hub could not be stored safely.",
        { cause: error },
      );
    }

    try {
      // The manifest now points only at this complete generation. Remove both
      // the former generation and any orphan left by an interrupted write.
      this.sql.exec(
        "DELETE FROM fhir_hub_chunks WHERE generation <> ?",
        generation,
      );
    } catch {
      // Cleanup is best-effort; encrypted orphans are never selected by load().
    }
  }

  public async checkReadiness(): Promise<void> {
    this.sql.exec<Record<string, SqlStorageValue>>(
      "SELECT 1 AS ready FROM fhir_hub_manifest LIMIT 1",
    );
    this.sql.exec<Record<string, SqlStorageValue>>(
      "SELECT 1 AS ready FROM fhir_hub_chunks LIMIT 1",
    );
  }

  public persistedCleanupAfter(): number | undefined {
    if (!this.#cleanupDeadlineTrusted) {
      throw new AppError(
        503,
        "fhir_hub_store_unreadable",
        "The private health hub cleanup deadline is not trusted.",
      );
    }
    return this.readPersistedCleanupAfter();
  }

  private readPersistedCleanupAfter(): number | undefined {
    const row = this.sql.exec<HubCleanupRow>(
      `SELECT cleanup_after AS cleanupAfter
       FROM fhir_hub_manifest
       WHERE singleton = 1`,
    ).toArray()[0];
    if (!row) return undefined;
    if (row.cleanupAfter === null || !Number.isInteger(row.cleanupAfter) || row.cleanupAfter < 0) {
      throw new AppError(
        503,
        "fhir_hub_store_unreadable",
        "The private health hub cleanup deadline is invalid.",
      );
    }
    return row.cleanupAfter;
  }

  public async ensureReadinessSentinel(): Promise<void> {
    const existing = await this.load();
    if (existing !== undefined) return;
    await this.save({
      schemaVersion: 1,
      profiles: {},
      resourceVersions: {},
      currentResources: {},
      insights: {},
    });
  }

  public async close(): Promise<void> {}

  public deletePersistedState(): void {
    // Remove the pointer first so no ciphertext generation remains readable if
    // execution is interrupted between the two deletion statements.
    this.sql.exec("DELETE FROM fhir_hub_manifest WHERE singleton = 1");
    this.sql.exec("DELETE FROM fhir_hub_chunks");
    this.#cleanupDeadlineTrusted = true;
  }

}

/**
 * Account-scoped PHI vault. Its object name is only the opaque, server-derived
 * HMAC account reference. The identity check prevents accidental cross-account
 * writes even if a caller addresses the wrong Durable Object stub.
 */
export class EpicFhirHub extends DurableObject<WorkerFhirHubBindings> {
  readonly #persistence: DurableObjectFhirHubStatePersistence;
  readonly #repository: StateBackedFhirHubRepository;
  readonly #ready: Promise<void>;
  #initializationFailed = false;
  #initializationError: unknown;

  public constructor(ctx: DurableObjectState, env: WorkerFhirHubBindings) {
    super(ctx, env);
    this.#persistence = new DurableObjectFhirHubStatePersistence(
      ctx.storage.sql,
      requireHubEncryptionKey(env.FHIR_HUB_ENCRYPTION_KEY),
      ctx.id.toString(),
    );
    this.#repository = new StateBackedFhirHubRepository(this.#persistence);
    this.#ready = ctx.blockConcurrencyWhile(async () => {
      try {
        await this.#repository.initialize();
      } catch (error) {
        // Keep the object callable so a verified account request or the
        // plaintext cleanup deadline can still physically erase unreadable
        // ciphertext. Every non-recovery operation remains fail closed.
        this.#initializationFailed = true;
        this.#initializationError = error;
      }
    });
  }

  public async checkReadiness(
    identityInput: FhirHubIdentity,
    ensureSentinel = false,
  ): Promise<true> {
    await this.#requireRepositoryReady();
    const identity = this.#requireAccountShard(identityInput);
    await this.#repository.checkReadiness();
    if (ensureSentinel) {
      if (
        identity.accountRef !== fhirHubReadinessIdentity.accountRef ||
        identity.sourceConnectionId !== fhirHubReadinessIdentity.sourceConnectionId ||
        identity.patientSubjectId !== fhirHubReadinessIdentity.patientSubjectId ||
        identity.fhirIssuer !== fhirHubReadinessIdentity.fhirIssuer
      ) {
        throw new AppError(
          400,
          "invalid_fhir_hub_readiness_identity",
          "The private health hub readiness identity is invalid.",
        );
      }
      // Persist a minimal authenticated sentinel on first use. Future startup
      // must decrypt it, so an accidental hub-key replacement fails readiness
      // even when no patient shard has yet been sampled.
      await this.#persistence.ensureReadinessSentinel();
    }
    return true;
  }

  public async enable(
    identityInput: FhirHubIdentity,
    receipt: FhirHubConsentReceipt,
  ): Promise<FhirHubStatus> {
    await this.#requireRepositoryReady();
    const identity = this.#requireAccountShard(identityInput);
    const status = await this.#repository.enable(identity, receipt);
    await this.#syncAlarm();
    return status;
  }

  public async status(
    identityInput: FhirHubIdentity,
    currentPolicyVersion: string,
    now: number,
  ): Promise<FhirHubStatus> {
    await this.#requireRepositoryReady();
    const identity = this.#requireAccountShard(identityInput);
    const status = await this.#repository.status(identity, currentPolicyVersion, now);
    await this.#syncAlarm();
    return status;
  }

  public async ingest(
    identityInput: FhirHubIdentity,
    value: unknown,
    currentPolicyVersion: string,
    retrievedAt: number,
  ): Promise<FhirHubIngestResult> {
    await this.#requireRepositoryReady();
    const identity = this.#requireAccountShard(identityInput);
    const result = await this.#repository.ingest(
      identity,
      value,
      currentPolicyVersion,
      retrievedAt,
    );
    await this.#syncAlarm();
    return result;
  }

  public async list(
    identityInput: FhirHubIdentity,
    options?: FhirHubListOptions,
  ): Promise<readonly FhirHubResourceVersion[]> {
    await this.#requireRepositoryReady();
    const identity = this.#requireAccountShard(identityInput);
    await this.#repository.pruneExpired(Date.now());
    const resources = await this.#repository.list(identity, options);
    await this.#syncAlarm();
    return resources;
  }

  public async intelligence(
    identityInput: FhirHubIdentity,
    options?: FhirHubIntelligenceOptions,
  ): Promise<FhirHubIntelligenceView> {
    await this.#requireRepositoryReady();
    const identity = this.#requireAccountShard(identityInput);
    await this.#repository.pruneExpired(Date.now());
    const intelligence = await this.#repository.intelligence(identity, options);
    await this.#syncAlarm();
    return intelligence;
  }

  public async exportAccount(
    identityInput: FhirHubIdentity,
    now: number,
  ): Promise<FhirHubExport> {
    await this.#requireRepositoryReady();
    const identity = this.#requireAccountShard(identityInput);
    const exported = await this.#repository.exportAccount(identity, now);
    await this.#syncAlarm();
    return exported;
  }

  public async deleteAccount(
    identityInput: FhirHubIdentity,
  ): Promise<{ readonly deleted: true; readonly resourcesDeleted: number | null }> {
    await this.#ready;
    const identity = this.#requireAccountShard(identityInput);
    if (this.#initializationFailed) {
      this.#persistence.deletePersistedState();
      await this.ctx.storage.deleteAlarm();
      await this.#recoverEmptyRepository();
      return { deleted: true, resourcesDeleted: null };
    }
    const result = await this.#repository.deleteAccount(identity);
    // The repository first clears its in-memory state. Removing the encrypted
    // row afterwards ensures deletion does not leave a recoverable PHI blob.
    this.#persistence.deletePersistedState();
    await this.#syncAlarm();
    return result;
  }

  public async pruneExpired(
    identityInput: FhirHubIdentity,
    now: number,
  ): Promise<number> {
    await this.#requireRepositoryReady();
    this.#requireAccountShard(identityInput);
    const deleted = await this.#repository.pruneExpired(now);
    await this.#syncAlarm();
    return deleted;
  }

  public override async alarm(): Promise<void> {
    await this.#ready;
    if (this.#initializationFailed) {
      // A storage/query error must not be mistaken for proof that no retained
      // data exists. Let Durable Objects retry the alarm; verified deletion is
      // still available because it does not need to read this deadline.
      const cleanupAfter = this.#persistence.persistedCleanupAfter();
      if (cleanupAfter === undefined || cleanupAfter === 0 || cleanupAfter <= Date.now()) {
        this.#persistence.deletePersistedState();
        await this.ctx.storage.deleteAlarm();
        await this.#recoverEmptyRepository();
      } else {
        await this.ctx.storage.setAlarm(cleanupAfter);
      }
      return;
    }
    await this.#repository.pruneExpired(Date.now());
    await this.#syncAlarm();
  }

  async #requireRepositoryReady(): Promise<void> {
    await this.#ready;
    if (this.#initializationFailed) throw this.#initializationError;
  }

  async #recoverEmptyRepository(): Promise<void> {
    this.#initializationFailed = false;
    this.#initializationError = undefined;
    try {
      await this.#repository.initialize();
    } catch (error) {
      this.#initializationFailed = true;
      this.#initializationError = error;
      throw error;
    }
  }

  #requireAccountShard(identityInput: FhirHubIdentity): FhirHubIdentity {
    const identity = fhirHubIdentitySchema.parse(identityInput);
    if (
      !accountReferencePattern.test(identity.accountRef) ||
      !this.ctx.id.equals(this.env.EPIC_FHIR_HUB.idFromName(identity.accountRef))
    ) {
      throw new AppError(
        409,
        "fhir_hub_account_mismatch",
        "The private health hub account context changed.",
      );
    }
    return identity;
  }

  async #syncAlarm(): Promise<void> {
    // Use the repository's already validated in-memory state. Reloading and
    // decrypting the full account here would nearly double CPU and peak memory
    // for every request.
    const nextExpiry = this.#repository.nextExpiry();
    const current = await this.ctx.storage.getAlarm();
    if (nextExpiry === undefined) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    const desired = Math.max(nextExpiry, Date.now() + 1_000);
    if (current === null || current !== desired) {
      await this.ctx.storage.setAlarm(desired);
    }
  }
}

/** Routes repository operations to account-scoped Durable Objects. */
export class WorkerFhirHubRepository implements FhirHubRepository {
  public readonly durable = true;
  readonly #seenAccountRefs = new Set<string>();

  public constructor(
    private readonly namespace: DurableObjectNamespace<EpicFhirHub>,
  ) {}

  public async initialize(): Promise<void> {}

  public async close(): Promise<void> {
    this.#seenAccountRefs.clear();
    this.#identities.clear();
  }

  public async checkReadiness(): Promise<void> {
    await Promise.all([...this.#seenAccountRefs].map((accountRef) =>
      this.namespace.getByName(accountRef).checkReadiness(
        // Readiness is only called after an identity-bearing operation has
        // registered the full identity through #stub. It is checked there.
        this.#identities.get(accountRef)!,
      )));
  }

  readonly #identities = new Map<string, FhirHubIdentity>();

  public async enable(
    identity: FhirHubIdentity,
    receipt: FhirHubConsentReceipt,
  ): Promise<FhirHubStatus> {
    return this.#stub(identity).enable(identity, receipt);
  }

  public async status(
    identity: FhirHubIdentity,
    currentPolicyVersion: string,
    now: number,
  ): Promise<FhirHubStatus> {
    return this.#stub(identity).status(identity, currentPolicyVersion, now);
  }

  public async ingest(
    identity: FhirHubIdentity,
    value: unknown,
    currentPolicyVersion: string,
    retrievedAt: number,
  ): Promise<FhirHubIngestResult> {
    return this.#stub(identity).ingest(identity, value, currentPolicyVersion, retrievedAt);
  }

  public async list(
    identity: FhirHubIdentity,
    options?: FhirHubListOptions,
  ): Promise<readonly FhirHubResourceVersion[]> {
    const stub = this.#stub(identity);
    return options === undefined
      ? stub.list(identity)
      : stub.list(identity, options);
  }

  public async intelligence(
    identity: FhirHubIdentity,
    options?: FhirHubIntelligenceOptions,
  ): Promise<FhirHubIntelligenceView> {
    const stub = this.#stub(identity);
    return options === undefined
      ? stub.intelligence(identity)
      : stub.intelligence(identity, options);
  }

  public async exportAccount(
    identity: FhirHubIdentity,
    now: number,
  ): Promise<FhirHubExport> {
    return this.#stub(identity).exportAccount(identity, now);
  }

  public async deleteAccount(
    identity: FhirHubIdentity,
  ): Promise<{ readonly deleted: true; readonly resourcesDeleted: number | null }> {
    return this.#stub(identity).deleteAccount(identity);
  }

  public async pruneExpired(now: number): Promise<number> {
    // Durable Objects cannot be enumerated. Prune shards observed by this
    // adapter now; every other shard has its own expiry alarm as the durable
    // backstop.
    const deleted = await Promise.all([...this.#identities.values()].map((identity) =>
      this.namespace.getByName(identity.accountRef).pruneExpired(identity, now)));
    return deleted.reduce((total, count) => total + count, 0);
  }

  #stub(identityInput: FhirHubIdentity): DurableObjectStub<EpicFhirHub> {
    const identity = fhirHubIdentitySchema.parse(identityInput);
    this.#seenAccountRefs.add(identity.accountRef);
    this.#identities.set(identity.accountRef, identity);
    return this.namespace.getByName(identity.accountRef);
  }
}
