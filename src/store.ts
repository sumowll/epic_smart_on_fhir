import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { AppError } from "./errors.js";
import type { ConnectionRecord, ConnectionStore } from "./types.js";

const connectionSchema = z.object({
  oauthClientId: z.string().min(1),
  fhirBaseUrl: z.string().url(),
  tokenEndpoint: z.string().url(),
  revocationEndpoint: z.string().url().optional(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  tokenType: z.literal("Bearer"),
  expiresAt: z.number().int().positive(),
  scope: z.string(),
  patientId: z.string().min(1),
  fhirUser: z.string().optional(),
  connectedAt: z.number().int().positive(),
  sessionExpiresAt: z.number().int().positive(),
});

const payloadSchema = z.object({
  version: z.literal(1),
  connections: z.record(z.string(), connectionSchema),
});

const envelopeSchema = z.object({
  version: z.literal(1),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

const lockSchema = z.object({
  version: z.literal(1),
  pid: z.number().int().positive(),
  owner: z.string().min(32),
  startedAt: z.number().int().positive(),
});

const additionalAuthenticatedData = Buffer.from("epic-mychart-token-store:v1", "utf8");

export class InMemoryConnectionStore implements ConnectionStore {
  readonly #connections = new Map<string, ConnectionRecord>();

  public async initialize(): Promise<void> {}

  public async close(): Promise<void> {
    this.#connections.clear();
  }

  public async get(sessionId: string): Promise<ConnectionRecord | undefined> {
    return this.#connections.get(sessionId);
  }

  public async list(): Promise<ReadonlyArray<readonly [string, ConnectionRecord]>> {
    return [...this.#connections.entries()];
  }

  public async set(sessionId: string, record: ConnectionRecord): Promise<void> {
    this.#connections.set(sessionId, record);
  }

  public async delete(sessionId: string): Promise<void> {
    this.#connections.delete(sessionId);
  }
}

export class EncryptedFileConnectionStore implements ConnectionStore {
  readonly #connections = new Map<string, ConnectionRecord>();
  #initialized = false;
  #lockHandle: FileHandle | undefined;
  #lockOwner: string | undefined;
  #writeQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly filePath: string,
    private readonly key: Buffer,
  ) {
    if (key.length !== 32) {
      throw new AppError(500, "invalid_encryption_key", "The token encryption key must be 32 bytes.");
    }
  }

  public async initialize(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await this.acquireLock();
    try {
      try {
        const envelope = envelopeSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
        const iv = Buffer.from(envelope.iv, "base64");
        const tag = Buffer.from(envelope.tag, "base64");
        const ciphertext = Buffer.from(envelope.ciphertext, "base64");
        const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
        decipher.setAAD(additionalAuthenticatedData);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        const payload = payloadSchema.parse(JSON.parse(plaintext.toString("utf8")));
        this.#connections.clear();
        for (const [sessionId, value] of Object.entries(payload.connections)) {
          const record: ConnectionRecord = {
            oauthClientId: value.oauthClientId,
            fhirBaseUrl: value.fhirBaseUrl,
            tokenEndpoint: value.tokenEndpoint,
            ...(value.revocationEndpoint ? { revocationEndpoint: value.revocationEndpoint } : {}),
            accessToken: value.accessToken,
            ...(value.refreshToken ? { refreshToken: value.refreshToken } : {}),
            tokenType: value.tokenType,
            expiresAt: value.expiresAt,
            scope: value.scope,
            patientId: value.patientId,
            ...(value.fhirUser ? { fhirUser: value.fhirUser } : {}),
            connectedAt: value.connectedAt,
            sessionExpiresAt: value.sessionExpiresAt,
          };
          this.#connections.set(sessionId, record);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new AppError(
            500,
            "token_store_unreadable",
            "The encrypted token store could not be opened. Check the encryption key and file integrity.",
            { cause: error },
          );
        }
      }
      this.#initialized = true;
    } catch (error) {
      await this.releaseLock().catch(() => undefined);
      throw error;
    }
  }

  public async close(): Promise<void> {
    await this.#writeQueue;
    this.#initialized = false;
    this.#connections.clear();
    await this.releaseLock();
  }

  public async get(sessionId: string): Promise<ConnectionRecord | undefined> {
    this.requireInitialized();
    return this.#connections.get(sessionId);
  }

  public async list(): Promise<ReadonlyArray<readonly [string, ConnectionRecord]>> {
    this.requireInitialized();
    return [...this.#connections.entries()];
  }

  public async set(sessionId: string, record: ConnectionRecord): Promise<void> {
    this.requireInitialized();
    await this.queueMutation(() => this.#connections.set(sessionId, record));
  }

  public async delete(sessionId: string): Promise<void> {
    this.requireInitialized();
    if (!this.#connections.has(sessionId)) return;
    await this.queueMutation(() => this.#connections.delete(sessionId));
  }

  private requireInitialized(): void {
    if (!this.#initialized) {
      throw new AppError(500, "token_store_not_initialized", "The token store is not initialized.");
    }
  }

  private async acquireLock(): Promise<void> {
    const lockPath = `${this.filePath}.lock`;
    const owner = randomBytes(24).toString("base64url");
    const lockBody = JSON.stringify({
      version: 1,
      pid: process.pid,
      owner,
      startedAt: Date.now(),
    });

    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(lockBody, "utf8");
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
          "token_store_locked",
          "The encrypted token store is locked. Stop other connector or purge processes. After a crash, verify they are stopped and remove only the adjacent .lock file before retrying.",
        );
      }
      throw new AppError(
        500,
        "token_store_lock_failed",
        "The encrypted token store lock could not be created.",
        { cause: error },
      );
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
      const parsed = lockSchema.safeParse(JSON.parse(await readFile(lockPath, "utf8")));
      if (parsed.success && parsed.data.owner === owner) await unlink(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async queueMutation(mutation: () => unknown): Promise<void> {
    const operation = this.#writeQueue.then(async () => {
      const before = new Map(this.#connections);
      mutation();
      try {
        await this.persist();
      } catch (error) {
        this.#connections.clear();
        for (const [sessionId, record] of before) this.#connections.set(sessionId, record);
        throw error;
      }
    });
    this.#writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private async persist(): Promise<void> {
    const payload = JSON.stringify({
      version: 1,
      connections: Object.fromEntries(this.#connections),
    });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(additionalAuthenticatedData);
    const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
    const envelope = JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });

    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporaryPath, envelope, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}
