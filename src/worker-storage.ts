import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { z } from "zod";

import { AppError } from "./errors.js";
import {
  connectionRecordSchema,
  parseConnectionRecord,
  parsePendingAuthorization,
} from "./records.js";
import type {
  ConnectionRecord,
  ConnectionStore,
  PendingAuthorization,
  PendingAuthorizationRepository,
} from "./types.js";

const envelopeSchema = z.object({
  version: z.literal(1),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

const keyIdPattern = /^[A-Za-z0-9._-]{1,64}$/;
const legacyKeyId = "legacy";
const legacyConnectionCleanupGraceMs = 30 * 24 * 60 * 60 * 1_000;
const latestStorageSchemaVersion = 2;

export interface DurableObjectEncryptionKeyring {
  readonly currentKeyId: string;
  readonly keys:
    | ReadonlyMap<string, Buffer>
    | Readonly<Record<string, Buffer>>;
}

interface NormalizedKeyring {
  readonly currentKeyId: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

const storedConnectionSchema = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{40,100}$/),
  record: connectionRecordSchema,
});

interface PayloadRow extends Record<string, SqlStorageValue> {
  readonly payload: string;
  readonly key_id: string | null;
}

interface ConnectionRow extends PayloadRow {
  readonly session_hash: string;
  readonly cleanup_after: number | null;
}

interface StatusRow extends Record<string, SqlStorageValue> {
  readonly status: string;
}

interface TableInfoRow extends Record<string, SqlStorageValue> {
  readonly name: string;
}

interface MigrationRow extends Record<string, SqlStorageValue> {
  readonly version: number;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function equal(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeKeyring(
  value: Buffer | DurableObjectEncryptionKeyring,
): NormalizedKeyring {
  const currentKeyId = Buffer.isBuffer(value) ? legacyKeyId : value.currentKeyId;
  if (!keyIdPattern.test(currentKeyId)) {
    throw new AppError(
      500,
      "invalid_encryption_key_id",
      "The token encryption key ID is invalid.",
    );
  }

  const entries = Buffer.isBuffer(value)
    ? [[legacyKeyId, value] as const]
    : value.keys instanceof Map
      ? [...value.keys]
      : Object.entries(value.keys);
  const keys = new Map<string, Buffer>();
  for (const [keyId, key] of entries) {
    if (!keyIdPattern.test(keyId)) {
      throw new AppError(
        500,
        "invalid_encryption_key_id",
        "A token encryption key ID is invalid.",
      );
    }
    if (!Buffer.isBuffer(key) || key.length !== 32) {
      throw new AppError(
        500,
        "invalid_encryption_key",
        "Every token encryption key must be 32 bytes.",
      );
    }
    keys.set(keyId, Buffer.from(key));
  }
  if (!keys.has(currentKeyId)) {
    throw new AppError(
      500,
      "invalid_encryption_keyring",
      "The current token encryption key ID is not present in the keyring.",
    );
  }
  return { currentKeyId, keys };
}

function encrypt(value: unknown, key: Buffer, additionalData: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(additionalData, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return JSON.stringify({
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
}

function decrypt(payload: string, key: Buffer, additionalData: string): unknown {
  const envelope = envelopeSchema.parse(JSON.parse(payload));
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAAD(Buffer.from(additionalData, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

function decryptWithKeyring(
  payload: string,
  keyring: NormalizedKeyring,
  keyId: string | null,
  additionalData: string,
): { readonly keyId: string; readonly value: unknown } {
  const candidateIds = [
    ...(keyId && keyring.keys.has(keyId) ? [keyId] : []),
    keyring.currentKeyId,
    ...keyring.keys.keys(),
  ];
  const attempted = new Set<string>();
  let firstError: unknown;
  for (const candidateId of candidateIds) {
    if (attempted.has(candidateId)) continue;
    attempted.add(candidateId);
    const key = keyring.keys.get(candidateId);
    if (!key) continue;
    try {
      return {
        keyId: candidateId,
        value: decrypt(payload, key, additionalData),
      };
    } catch (error) {
      firstError ??= error;
    }
  }
  throw firstError ?? new Error("No token encryption key could decrypt the record.");
}

function connectionAdditionalData(sessionHash: string): string {
  return `epic-worker-connection:v1:${sessionHash}`;
}

function pendingAdditionalData(stateHash: string): string {
  return `epic-worker-pending:v1:${stateHash}`;
}

function tableColumns(sql: SqlStorage, table: string): ReadonlySet<string> {
  return new Set(
    sql
      .exec<TableInfoRow>(`PRAGMA table_info(${table})`)
      .toArray()
      .map((column) => column.name),
  );
}

function addColumnIfMissing(
  sql: SqlStorage,
  table: string,
  column: string,
  definition: string,
): void {
  if (!tableColumns(sql, table).has(column)) {
    sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function applyStorageMigration(
  sql: SqlStorage,
  version: number,
  appliedAt: number,
): void {
  switch (version) {
    case 1:
      sql.exec(`
        CREATE TABLE IF NOT EXISTS connections (
          session_hash TEXT PRIMARY KEY,
          payload TEXT NOT NULL
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS pending_authorizations (
          state_hash TEXT PRIMARY KEY,
          session_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
        )
      `);
      addColumnIfMissing(
        sql,
        "pending_authorizations",
        "status",
        "TEXT NOT NULL DEFAULT 'pending'",
      );
      sql.exec(`
        DELETE FROM pending_authorizations
        WHERE rowid NOT IN (
          SELECT MAX(rowid) FROM pending_authorizations GROUP BY session_hash
        )
      `);
      sql.exec("DROP INDEX IF EXISTS pending_by_session");
      sql.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS pending_one_per_session ON pending_authorizations(session_hash)",
      );
      return;
    case 2:
      addColumnIfMissing(sql, "connections", "key_id", "TEXT");
      addColumnIfMissing(sql, "connections", "cleanup_after", "INTEGER");
      addColumnIfMissing(sql, "pending_authorizations", "key_id", "TEXT");
      // Legacy records did not expose their exact session expiry. The application's
      // maximum session lifetime is 30 days, so this is a conservative upper bound
      // that permits eventual deletion even when the legacy key has been lost.
      sql.exec(
        "UPDATE connections SET cleanup_after = ? WHERE cleanup_after IS NULL",
        appliedAt + legacyConnectionCleanupGraceMs,
      );
      return;
    default:
      throw new AppError(
        500,
        "unsupported_storage_schema",
        `Unsupported Durable Object storage migration: ${version}`,
      );
  }
}

function migrateStorage(sql: SqlStorage, now: number): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS epic_storage_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
  const applied = new Set(
    sql
      .exec<MigrationRow>(
        "SELECT version FROM epic_storage_migrations ORDER BY version",
      )
      .toArray()
      .map((row) => row.version),
  );
  if ([...applied].some((version) => version > latestStorageSchemaVersion)) {
    throw new AppError(
      500,
      "unsupported_storage_schema",
      "The Durable Object storage schema is newer than this application version.",
    );
  }
  for (let version = 1; version <= latestStorageSchemaVersion; version += 1) {
    if (applied.has(version)) continue;
    applyStorageMigration(sql, version, now);
    sql.exec(
      "INSERT INTO epic_storage_migrations (version, applied_at) VALUES (?, ?)",
      version,
      now,
    );
  }
}

export class DurableObjectConnectionStore implements ConnectionStore {
  public readonly durable = true;
  readonly #keyring: NormalizedKeyring;

  public constructor(
    private readonly sql: SqlStorage,
    key: Buffer | DurableObjectEncryptionKeyring,
    private readonly now: () => number = Date.now,
  ) {
    this.#keyring = normalizeKeyring(key);
  }

  public async initialize(): Promise<void> {
    migrateStorage(this.sql, this.now());
  }

  public async close(): Promise<void> {}

  public async get(sessionId: string): Promise<ConnectionRecord | undefined> {
    const sessionHash = hash(sessionId);
    const row = this.sql
      .exec<ConnectionRow>(
        `SELECT session_hash, payload, key_id, cleanup_after
         FROM connections WHERE session_hash = ?`,
        sessionHash,
      )
      .toArray()[0];
    if (!row) return undefined;
    let value: z.infer<typeof storedConnectionSchema>;
    let decryptedKeyId: string;
    try {
      const decrypted = decryptWithKeyring(
        row.payload,
        this.#keyring,
        row.key_id,
        connectionAdditionalData(sessionHash),
      );
      decryptedKeyId = decrypted.keyId;
      value = storedConnectionSchema.parse(decrypted.value);
      if (!equal(value.sessionId, sessionId)) {
        throw new Error("Session hash collision");
      }
    } catch (error) {
      if (row.cleanup_after !== null && row.cleanup_after <= this.now()) {
        this.sql.exec(
          "DELETE FROM connections WHERE session_hash = ?",
          sessionHash,
        );
        return undefined;
      }
      throw new AppError(
        500,
        "token_store_unreadable",
        "The encrypted token store could not be opened. Check the encryption key and stored data.",
        { cause: error },
      );
    }
    const record = parseConnectionRecord(value.record);
    this.reencryptConnectionIfNeeded(row, value.sessionId, record, decryptedKeyId);
    return record;
  }

  public async list(): Promise<ReadonlyArray<readonly [string, ConnectionRecord]>> {
    const records: Array<readonly [string, ConnectionRecord]> = [];
    for (const row of this.sql.exec<ConnectionRow>(
      "SELECT session_hash, payload, key_id, cleanup_after FROM connections",
    )) {
      let value: z.infer<typeof storedConnectionSchema>;
      let decryptedKeyId: string;
      try {
        const decrypted = decryptWithKeyring(
          row.payload,
          this.#keyring,
          row.key_id,
          connectionAdditionalData(row.session_hash),
        );
        decryptedKeyId = decrypted.keyId;
        value = storedConnectionSchema.parse(decrypted.value);
        if (!equal(hash(value.sessionId), row.session_hash)) {
          throw new Error("Stored connection key does not match its session");
        }
      } catch (error) {
        if (row.cleanup_after !== null && row.cleanup_after <= this.now()) {
          this.sql.exec(
            "DELETE FROM connections WHERE session_hash = ?",
            row.session_hash,
          );
          continue;
        }
        throw new AppError(
          500,
          "token_store_unreadable",
          "The encrypted token store could not be opened. Check the encryption key and stored data.",
          { cause: error },
        );
      }
      const record = parseConnectionRecord(value.record);
      this.reencryptConnectionIfNeeded(row, value.sessionId, record, decryptedKeyId);
      records.push([value.sessionId, record]);
    }
    return records;
  }

  public async set(sessionId: string, record: ConnectionRecord): Promise<void> {
    const sessionHash = hash(sessionId);
    const validated = parseConnectionRecord(record);
    const payload = encrypt(
      { sessionId, record: validated },
      this.#keyring.keys.get(this.#keyring.currentKeyId)!,
      connectionAdditionalData(sessionHash),
    );
    this.sql.exec(
      `INSERT INTO connections
         (session_hash, payload, key_id, cleanup_after)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_hash) DO UPDATE SET
         payload = excluded.payload,
         key_id = excluded.key_id,
         cleanup_after = excluded.cleanup_after`,
      sessionHash,
      payload,
      this.#keyring.currentKeyId,
      validated.sessionExpiresAt,
    );
  }

  public async delete(sessionId: string): Promise<void> {
    this.sql.exec("DELETE FROM connections WHERE session_hash = ?", hash(sessionId));
  }

  private reencryptConnectionIfNeeded(
    row: ConnectionRow,
    sessionId: string,
    record: ConnectionRecord,
    decryptedKeyId: string,
  ): void {
    if (
      row.key_id === this.#keyring.currentKeyId &&
      decryptedKeyId === this.#keyring.currentKeyId &&
      row.cleanup_after === record.sessionExpiresAt
    ) {
      return;
    }
    const payload = encrypt(
      { sessionId, record },
      this.#keyring.keys.get(this.#keyring.currentKeyId)!,
      connectionAdditionalData(row.session_hash),
    );
    this.sql.exec(
      `UPDATE connections
       SET payload = ?, key_id = ?, cleanup_after = ?
       WHERE session_hash = ?`,
      payload,
      this.#keyring.currentKeyId,
      record.sessionExpiresAt,
      row.session_hash,
    );
  }
}

export class DurableObjectPendingAuthorizationStore
implements PendingAuthorizationRepository {
  readonly #keyring: NormalizedKeyring;

  public constructor(
    private readonly sql: SqlStorage,
    key: Buffer | DurableObjectEncryptionKeyring,
    private readonly ttlMs = 10 * 60 * 1_000,
    private readonly now: () => number = Date.now,
  ) {
    this.#keyring = normalizeKeyring(key);
  }

  public initialize(): void {
    migrateStorage(this.sql, this.now());
  }

  public pruneExpired(): void {
    this.sql.exec(
      "DELETE FROM pending_authorizations WHERE created_at <= ?",
      this.now() - this.ttlMs,
    );
  }

  public hasAny(): boolean {
    this.pruneExpired();
    return Boolean(
      this.sql
        .exec<Record<string, SqlStorageValue>>(
          "SELECT 1 AS present FROM pending_authorizations LIMIT 1",
        )
        .toArray()[0],
    );
  }

  public async create(
    state: string,
    authorization: PendingAuthorization,
  ): Promise<void> {
    const validated = parsePendingAuthorization(authorization);
    const stateHash = hash(state);
    const sessionHash = hash(validated.sessionId);
    this.pruneExpired();
    const existing = this.sql
      .exec<StatusRow>(
        "SELECT status FROM pending_authorizations WHERE session_hash = ?",
        sessionHash,
      )
      .toArray()[0];
    if (existing?.status === "processing") {
      throw new AppError(
        409,
        "authorization_in_progress",
        "A MyChart authorization is already being completed. Wait a moment before trying again.",
      );
    }
    const connected = this.sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT 1 AS present FROM connections WHERE session_hash = ? LIMIT 1",
        sessionHash,
      )
      .toArray()[0];
    if (connected) {
      throw new AppError(
        409,
        "already_connected",
        "Disconnect the current MyChart account before connecting again.",
      );
    }
    const payload = encrypt(
      validated,
      this.#keyring.keys.get(this.#keyring.currentKeyId)!,
      pendingAdditionalData(stateHash),
    );
    this.sql.exec(
      "DELETE FROM pending_authorizations WHERE session_hash = ?",
      sessionHash,
    );
    this.sql.exec(
      `INSERT INTO pending_authorizations
         (state_hash, session_hash, created_at, payload, status, key_id)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      stateHash,
      sessionHash,
      validated.createdAt,
      payload,
      this.#keyring.currentKeyId,
    );
  }

  public async consume(
    state: string,
    sessionId: string,
  ): Promise<PendingAuthorization> {
    if (state.length < 32 || state.length > 512) {
      throw new AppError(400, "invalid_oauth_state", "The OAuth state is invalid or expired.");
    }

    const stateHash = hash(state);
    const sessionHash = hash(sessionId);
    const row = this.sql
      .exec<PayloadRow>(
        `UPDATE pending_authorizations SET status = 'processing'
         WHERE state_hash = ? AND session_hash = ? AND status = 'pending'
         RETURNING payload, key_id`,
        stateHash,
        sessionHash,
      )
      .toArray()[0];
    if (!row) {
      throw new AppError(400, "invalid_oauth_state", "The OAuth state is invalid or expired.");
    }

    let authorization: PendingAuthorization;
    try {
      const decrypted = decryptWithKeyring(
        row.payload,
        this.#keyring,
        row.key_id,
        pendingAdditionalData(stateHash),
      );
      authorization = parsePendingAuthorization(
        decrypted.value,
      );
      if (
        row.key_id !== this.#keyring.currentKeyId ||
        decrypted.keyId !== this.#keyring.currentKeyId
      ) {
        this.sql.exec(
          `UPDATE pending_authorizations
           SET payload = ?, key_id = ?
           WHERE state_hash = ?`,
          encrypt(
            authorization,
            this.#keyring.keys.get(this.#keyring.currentKeyId)!,
            pendingAdditionalData(stateHash),
          ),
          this.#keyring.currentKeyId,
          stateHash,
        );
      }
    } catch (error) {
      throw new AppError(
        500,
        "oauth_state_unreadable",
        "The stored authorization request could not be read. Start the connection again.",
        { cause: error },
      );
    }
    if (this.now() - authorization.createdAt > this.ttlMs) {
      throw new AppError(400, "invalid_oauth_state", "The OAuth state is invalid or expired.");
    }
    if (!equal(authorization.sessionId, sessionId)) {
      throw new AppError(
        400,
        "oauth_session_mismatch",
        "This authorization belongs to another browser session.",
      );
    }
    return authorization;
  }

  public async deleteForSession(sessionId: string): Promise<void> {
    this.sql.exec(
      "DELETE FROM pending_authorizations WHERE session_hash = ?",
      hash(sessionId),
    );
  }
}
