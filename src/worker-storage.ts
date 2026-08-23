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

const storedConnectionSchema = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{40,100}$/),
  record: connectionRecordSchema,
});

interface PayloadRow extends Record<string, SqlStorageValue> {
  readonly payload: string;
}

interface ConnectionRow extends PayloadRow {
  readonly session_hash: string;
}

interface StatusRow extends Record<string, SqlStorageValue> {
  readonly status: string;
}

interface TableInfoRow extends Record<string, SqlStorageValue> {
  readonly name: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function equal(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
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

function connectionAdditionalData(sessionHash: string): string {
  return `epic-worker-connection:v1:${sessionHash}`;
}

function pendingAdditionalData(stateHash: string): string {
  return `epic-worker-pending:v1:${stateHash}`;
}

export class DurableObjectConnectionStore implements ConnectionStore {
  public readonly durable = true;

  public constructor(
    private readonly sql: SqlStorage,
    private readonly key: Buffer,
  ) {
    if (key.length !== 32) {
      throw new AppError(
        500,
        "invalid_encryption_key",
        "The token encryption key must be 32 bytes.",
      );
    }
  }

  public async initialize(): Promise<void> {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS connections (
        session_hash TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      )
    `);
  }

  public async close(): Promise<void> {}

  public async get(sessionId: string): Promise<ConnectionRecord | undefined> {
    const sessionHash = hash(sessionId);
    const row = this.sql
      .exec<PayloadRow>(
        "SELECT payload FROM connections WHERE session_hash = ?",
        sessionHash,
      )
      .toArray()[0];
    if (!row) return undefined;
    try {
      const value = storedConnectionSchema.parse(
        decrypt(row.payload, this.key, connectionAdditionalData(sessionHash)),
      );
      if (!equal(value.sessionId, sessionId)) {
        throw new Error("Session hash collision");
      }
      return parseConnectionRecord(value.record);
    } catch (error) {
      throw new AppError(
        500,
        "token_store_unreadable",
        "The encrypted token store could not be opened. Check the encryption key and stored data.",
        { cause: error },
      );
    }
  }

  public async list(): Promise<ReadonlyArray<readonly [string, ConnectionRecord]>> {
    const records: Array<readonly [string, ConnectionRecord]> = [];
    for (const row of this.sql.exec<ConnectionRow>(
      "SELECT session_hash, payload FROM connections",
    )) {
      try {
        const value = storedConnectionSchema.parse(
          decrypt(
            row.payload,
            this.key,
            connectionAdditionalData(row.session_hash),
          ),
        );
        if (!equal(hash(value.sessionId), row.session_hash)) {
          throw new Error("Stored connection key does not match its session");
        }
        records.push([value.sessionId, parseConnectionRecord(value.record)]);
      } catch (error) {
        throw new AppError(
          500,
          "token_store_unreadable",
          "The encrypted token store could not be opened. Check the encryption key and stored data.",
          { cause: error },
        );
      }
    }
    return records;
  }

  public async set(sessionId: string, record: ConnectionRecord): Promise<void> {
    const sessionHash = hash(sessionId);
    const validated = parseConnectionRecord(record);
    const payload = encrypt(
      { sessionId, record: validated },
      this.key,
      connectionAdditionalData(sessionHash),
    );
    this.sql.exec(
      `INSERT INTO connections (session_hash, payload) VALUES (?, ?)
       ON CONFLICT(session_hash) DO UPDATE SET payload = excluded.payload`,
      sessionHash,
      payload,
    );
  }

  public async delete(sessionId: string): Promise<void> {
    this.sql.exec("DELETE FROM connections WHERE session_hash = ?", hash(sessionId));
  }
}

export class DurableObjectPendingAuthorizationStore
implements PendingAuthorizationRepository {
  public constructor(
    private readonly sql: SqlStorage,
    private readonly key: Buffer,
    private readonly ttlMs = 10 * 60 * 1_000,
    private readonly now: () => number = Date.now,
  ) {
    if (key.length !== 32) {
      throw new AppError(
        500,
        "invalid_encryption_key",
        "The token encryption key must be 32 bytes.",
      );
    }
  }

  public initialize(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_authorizations (
        state_hash TEXT PRIMARY KEY,
        session_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      )
    `);
    const columns = this.sql
      .exec<TableInfoRow>("PRAGMA table_info(pending_authorizations)")
      .toArray();
    if (!columns.some((column) => column.name === "status")) {
      this.sql.exec(
        "ALTER TABLE pending_authorizations ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'",
      );
    }
    this.sql.exec(`
      DELETE FROM pending_authorizations
      WHERE rowid NOT IN (
        SELECT MAX(rowid) FROM pending_authorizations GROUP BY session_hash
      )
    `);
    this.sql.exec("DROP INDEX IF EXISTS pending_by_session");
    this.sql.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS pending_one_per_session ON pending_authorizations(session_hash)",
    );
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
      this.key,
      pendingAdditionalData(stateHash),
    );
    this.sql.exec(
      "DELETE FROM pending_authorizations WHERE session_hash = ?",
      sessionHash,
    );
    this.sql.exec(
      `INSERT INTO pending_authorizations
         (state_hash, session_hash, created_at, payload, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      stateHash,
      sessionHash,
      validated.createdAt,
      payload,
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
         RETURNING payload`,
        stateHash,
        sessionHash,
      )
      .toArray()[0];
    if (!row) {
      throw new AppError(400, "invalid_oauth_state", "The OAuth state is invalid or expired.");
    }

    let authorization: PendingAuthorization;
    try {
      authorization = parsePendingAuthorization(
        decrypt(row.payload, this.key, pendingAdditionalData(stateHash)),
      );
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
