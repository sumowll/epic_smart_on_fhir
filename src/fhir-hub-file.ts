import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { z } from "zod";

import { AppError } from "./errors.js";
import {
  canonicalJson,
  cloneCanonicalJson,
} from "./canonical-json.js";
import {
  fhirHubStateSchema,
  StateBackedFhirHubRepository,
  type FhirHubState,
  type FhirHubStatePersistence,
} from "./fhir-hub.js";

const envelopeSchema = z.object({
  version: z.literal(1),
  iv: z.string().min(1),
  tag: z.string().min(1),
  ciphertext: z.string().min(1),
}).strict();

const lockSchema = z.object({
  version: z.literal(1),
  pid: z.number().int().positive(),
  owner: z.string().min(32),
  startedAt: z.number().int().positive(),
}).strict();

const additionalAuthenticatedData = Buffer.from("epic-private-fhir-hub:v1", "utf8");
const maxPlaintextBytes = 64 * 1_024 * 1_024;
const maxEnvelopeBytes = Math.ceil(maxPlaintextBytes / 3) * 4 + 64 * 1_024;

function decodeCanonicalBase64(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    throw new Error("Invalid encrypted envelope encoding.");
  }
  return decoded;
}

function cloneAndValidateState(state: FhirHubState): FhirHubState {
  return fhirHubStateSchema.parse(cloneCanonicalJson(state));
}

/**
 * Single-process encrypted persistence for the local Node deployment.
 *
 * The adjacent exclusive lock prevents two connector processes from replacing
 * the same whole-file vault concurrently. This is intentionally separate from
 * the OAuth token store and uses a distinct authenticated-encryption domain.
 */
export class EncryptedFileFhirHubStatePersistence implements FhirHubStatePersistence {
  public readonly durable = true;
  #initialized = false;
  #state: FhirHubState | undefined;
  #lockHandle: FileHandle | undefined;
  #lockOwner: string | undefined;
  #writeQueue: Promise<void> = Promise.resolve();
  readonly #key: Buffer;

  public constructor(
    private readonly filePath: string,
    key: Buffer,
  ) {
    if (key.length !== 32) {
      throw new AppError(
        500,
        "invalid_encryption_key",
        "The FHIR hub encryption key must be 32 bytes.",
      );
    }
    this.#key = Buffer.from(key);
  }

  public async initialize(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await this.acquireLock();
    try {
      await this.removeOrphanedTemporaryFiles();
      this.#state = await this.readEncryptedState();
      this.#initialized = true;
    } catch (error) {
      this.#state = undefined;
      await this.releaseLock().catch(() => undefined);
      throw error;
    }
  }

  public async load(): Promise<FhirHubState | undefined> {
    this.requireInitialized();
    return this.#state === undefined ? undefined : cloneAndValidateState(this.#state);
  }

  public async save(stateInput: FhirHubState): Promise<void> {
    this.requireInitialized();
    const state = cloneAndValidateState(stateInput);
    const operation = this.#writeQueue.then(async () => {
      this.requireInitialized();
      await this.persist(state);
      this.#state = cloneAndValidateState(state);
    });
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
  }

  public async checkReadiness(): Promise<void> {
    this.requireInitialized();
    const owner = this.#lockOwner;
    if (!owner) {
      throw new AppError(500, "fhir_hub_store_lock_lost", "The encrypted FHIR hub store lock was lost.");
    }
    try {
      const lock = lockSchema.parse(JSON.parse(await readFile(`${this.filePath}.lock`, "utf8")));
      if (lock.owner !== owner) {
        throw new AppError(500, "fhir_hub_store_lock_lost", "The encrypted FHIR hub store lock was lost.");
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        500,
        "fhir_hub_store_lock_lost",
        "The encrypted FHIR hub store lock could not be verified.",
        { cause: error },
      );
    }
  }

  public async close(): Promise<void> {
    await this.#writeQueue;
    this.#initialized = false;
    this.#state = undefined;
    await this.releaseLock();
  }

  private requireInitialized(): void {
    if (!this.#initialized) {
      throw new AppError(
        500,
        "fhir_hub_store_not_initialized",
        "The encrypted FHIR hub store is not initialized.",
      );
    }
  }

  private async readEncryptedState(): Promise<FhirHubState | undefined> {
    let serialized: string;
    try {
      const metadata = await stat(this.filePath);
      if (!metadata.isFile() || metadata.size > maxEnvelopeBytes) {
        throw new Error("The encrypted FHIR hub envelope exceeds its size limit.");
      }
      serialized = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new AppError(
        500,
        "fhir_hub_store_unreadable",
        "The encrypted FHIR hub store could not be opened. Check the encryption key and file integrity.",
        { cause: error },
      );
    }

    try {
      const envelope = envelopeSchema.parse(JSON.parse(serialized));
      const iv = decodeCanonicalBase64(envelope.iv);
      const tag = decodeCanonicalBase64(envelope.tag);
      const ciphertext = decodeCanonicalBase64(envelope.ciphertext);
      if (iv.length !== 12 || tag.length !== 16) {
        throw new Error("Invalid encrypted envelope parameters.");
      }
      const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
      decipher.setAAD(additionalAuthenticatedData);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return fhirHubStateSchema.parse(JSON.parse(plaintext.toString("utf8")));
    } catch (error) {
      throw new AppError(
        500,
        "fhir_hub_store_unreadable",
        "The encrypted FHIR hub store could not be opened. Check the encryption key and file integrity.",
        { cause: error },
      );
    }
  }

  private async acquireLock(): Promise<void> {
    const lockPath = `${this.filePath}.lock`;
    const owner = randomBytes(24).toString("base64url");
    const body = JSON.stringify({
      version: 1,
      pid: process.pid,
      owner,
      startedAt: Date.now(),
    });

    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(body, "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
      this.#lockHandle = handle;
      this.#lockOwner = owner;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new AppError(
          500,
          "fhir_hub_store_locked",
          "The encrypted FHIR hub store is locked. Stop other connector processes. After a crash, verify they are stopped and remove only the adjacent .lock file before retrying.",
        );
      }
      throw new AppError(
        500,
        "fhir_hub_store_lock_failed",
        "The encrypted FHIR hub store lock could not be created.",
        { cause: error },
      );
    }
  }

  private async removeOrphanedTemporaryFiles(): Promise<void> {
    const directory = dirname(this.filePath);
    const prefix = `${basename(this.filePath)}.`;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.startsWith(prefix) || !entry.name.endsWith(".tmp")) continue;
      const middle = entry.name.slice(prefix.length, -".tmp".length);
      if (!/^\d+\.[a-f0-9]{16}$/.test(middle)) continue;
      // Unlinking also safely removes a matching symlink itself; it never
      // follows the link or removes any non-exact adjacent filename.
      await unlink(join(directory, entry.name));
    }
  }

  private async releaseLock(): Promise<void> {
    const handle = this.#lockHandle;
    const owner = this.#lockOwner;
    this.#lockHandle = undefined;
    this.#lockOwner = undefined;
    if (!handle || !owner) return;

    await handle.close();
    const lockPath = `${this.filePath}.lock`;
    try {
      const lock = lockSchema.safeParse(JSON.parse(await readFile(lockPath, "utf8")));
      if (lock.success && lock.data.owner === owner) await unlink(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async persist(state: FhirHubState): Promise<void> {
    let plaintext: string;
    try {
      plaintext = canonicalJson(fhirHubStateSchema.parse(state));
      if (Buffer.byteLength(plaintext, "utf8") > maxPlaintextBytes) {
        throw new AppError(
          413,
          "fhir_hub_store_too_large",
          "The private health hub exceeds the 64 MiB local vault limit.",
        );
      }
    } catch (error) {
      if (error instanceof AppError && error.code === "fhir_hub_store_too_large") throw error;
      throw new AppError(
        500,
        "fhir_hub_store_invalid_state",
        "The FHIR hub state could not be serialized safely.",
        { cause: error },
      );
    }

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(additionalAuthenticatedData);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const envelope = JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });

    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let temporaryHandle: FileHandle | undefined;
    try {
      temporaryHandle = await open(temporaryPath, "wx", 0o600);
      await temporaryHandle.writeFile(envelope, "utf8");
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = undefined;
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await temporaryHandle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw new AppError(
        500,
        "fhir_hub_store_write_failed",
        "The encrypted FHIR hub store could not be saved.",
        { cause: error },
      );
    }
  }
}

export class EncryptedFileFhirHubRepository extends StateBackedFhirHubRepository {
  public constructor(filePath: string, key: Buffer) {
    super(new EncryptedFileFhirHubStatePersistence(filePath, key));
  }
}
