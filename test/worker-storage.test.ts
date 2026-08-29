import { describe, expect, it } from "vitest";

import type { ConnectionRecord, PendingAuthorization } from "../src/types.js";
import {
  DurableObjectConnectionStore,
  DurableObjectPendingAuthorizationStore,
} from "../src/worker-storage.js";

type FakeSqlValue = string | number | null;

class FakeCursor<T extends Record<string, FakeSqlValue>> {
  public constructor(private readonly rows: T[]) {}

  public toArray(): T[] {
    return [...this.rows];
  }

  public *[Symbol.iterator](): IterableIterator<T> {
    yield* this.rows;
  }
}

class FakeSqlStorage {
  public readonly connections = new Map<
    string,
    {
      payload: string;
      keyId: string | null;
      cleanupAfter: number | null;
    }
  >();
  public readonly pending = new Map<
    string,
    {
      readonly sessionHash: string;
      readonly createdAt: number;
      payload: string;
      keyId: string | null;
      status: "pending" | "processing";
    }
  >();
  public readonly migrations = new Map<number, number>();
  public readonly columns = new Map<string, Set<string>>();
  public readonly indexes = new Set<string>();
  public migrationWrites = 0;

  public downgradeToLegacySchema(): void {
    this.migrations.clear();
    this.columns.set("connections", new Set(["session_hash", "payload"]));
    this.columns.set(
      "pending_authorizations",
      new Set(["state_hash", "session_hash", "created_at", "payload"]),
    );
    this.columns.delete("epic_storage_migrations");
    this.indexes.clear();
    for (const connection of this.connections.values()) {
      connection.keyId = null;
      connection.cleanupAfter = null;
    }
    for (const pending of this.pending.values()) pending.keyId = null;
  }

  public exec(
    query: string,
    ...bindings: Array<string | number>
  ): FakeCursor<Record<string, FakeSqlValue>> {
    const sql = query.replace(/\s+/g, " ").trim().toUpperCase();
    if (sql.startsWith("CREATE TABLE IF NOT EXISTS EPIC_STORAGE_MIGRATIONS")) {
      this.columns.set(
        "epic_storage_migrations",
        this.columns.get("epic_storage_migrations") ?? new Set(["version", "applied_at"]),
      );
      return new FakeCursor([]);
    }
    if (sql.startsWith("CREATE TABLE IF NOT EXISTS CONNECTIONS")) {
      this.columns.set(
        "connections",
        this.columns.get("connections") ?? new Set(["session_hash", "payload"]),
      );
      return new FakeCursor([]);
    }
    if (sql.startsWith("CREATE TABLE IF NOT EXISTS PENDING_AUTHORIZATIONS")) {
      this.columns.set(
        "pending_authorizations",
        this.columns.get("pending_authorizations") ?? new Set([
          "state_hash",
          "session_hash",
          "created_at",
          "payload",
          "status",
        ]),
      );
      return new FakeCursor([]);
    }
    if (sql.startsWith("SELECT VERSION FROM EPIC_STORAGE_MIGRATIONS")) {
      return new FakeCursor(
        [...this.migrations.keys()].sort().map((version) => ({ version })),
      );
    }
    if (sql.startsWith("INSERT INTO EPIC_STORAGE_MIGRATIONS")) {
      this.migrations.set(Number(bindings[0]), Number(bindings[1]));
      this.migrationWrites += 1;
      return new FakeCursor([]);
    }
    if (sql.startsWith("PRAGMA TABLE_INFO(")) {
      const table = sql.slice("PRAGMA TABLE_INFO(".length, -1).toLowerCase();
      return new FakeCursor(
        [...(this.columns.get(table) ?? [])].map((name) => ({ name })),
      );
    }
    if (sql.startsWith("ALTER TABLE ")) {
      const match = /^ALTER TABLE ([A-Z_]+) ADD COLUMN ([A-Z_]+)/.exec(sql);
      if (!match) throw new Error(`Unexpected ALTER TABLE in test: ${query}`);
      const table = match[1]!.toLowerCase();
      const column = match[2]!.toLowerCase();
      this.columns.get(table)?.add(column);
      return new FakeCursor([]);
    }
    if (sql.startsWith("CREATE UNIQUE INDEX IF NOT EXISTS")) {
      this.indexes.add("pending_one_per_session");
      return new FakeCursor([]);
    }
    if (sql.startsWith("DROP INDEX IF EXISTS")) {
      this.indexes.delete("pending_by_session");
      return new FakeCursor([]);
    }
    if (sql.startsWith("DELETE FROM PENDING_AUTHORIZATIONS WHERE ROWID")) {
      return new FakeCursor([]);
    }
    if (
      sql.startsWith(
        "UPDATE CONNECTIONS SET CLEANUP_AFTER = ? WHERE CLEANUP_AFTER IS NULL",
      )
    ) {
      for (const connection of this.connections.values()) {
        connection.cleanupAfter ??= Number(bindings[0]);
      }
      return new FakeCursor([]);
    }
    if (
      sql.startsWith(
        "SELECT SESSION_HASH, PAYLOAD, KEY_ID, CLEANUP_AFTER FROM CONNECTIONS WHERE SESSION_HASH",
      )
    ) {
      const session_hash = String(bindings[0]);
      const value = this.connections.get(session_hash);
      return new FakeCursor(value ? [{
        session_hash,
        payload: value.payload,
        key_id: value.keyId,
        cleanup_after: value.cleanupAfter,
      }] : []);
    }
    if (
      sql.startsWith(
        "SELECT SESSION_HASH, PAYLOAD, KEY_ID, CLEANUP_AFTER FROM CONNECTIONS",
      )
    ) {
      return new FakeCursor(
        [...this.connections].map(([session_hash, value]) => ({
          session_hash,
          payload: value.payload,
          key_id: value.keyId,
          cleanup_after: value.cleanupAfter,
        })),
      );
    }
    if (sql.startsWith("INSERT INTO CONNECTIONS")) {
      this.connections.set(String(bindings[0]), {
        payload: String(bindings[1]),
        keyId: String(bindings[2]),
        cleanupAfter: Number(bindings[3]),
      });
      return new FakeCursor([]);
    }
    if (sql.startsWith("UPDATE CONNECTIONS SET PAYLOAD")) {
      const value = this.connections.get(String(bindings[3]));
      if (value) {
        value.payload = String(bindings[0]);
        value.keyId = String(bindings[1]);
        value.cleanupAfter = Number(bindings[2]);
      }
      return new FakeCursor([]);
    }
    if (sql.startsWith("DELETE FROM CONNECTIONS WHERE SESSION_HASH")) {
      this.connections.delete(String(bindings[0]));
      return new FakeCursor([]);
    }
    if (sql.startsWith("DELETE FROM PENDING_AUTHORIZATIONS WHERE CREATED_AT")) {
      const cutoff = Number(bindings[0]);
      for (const [key, value] of this.pending) {
        if (value.createdAt < cutoff) this.pending.delete(key);
      }
      return new FakeCursor([]);
    }
    if (sql.startsWith("INSERT INTO PENDING_AUTHORIZATIONS")) {
      this.pending.set(String(bindings[0]), {
        sessionHash: String(bindings[1]),
        createdAt: Number(bindings[2]),
        payload: String(bindings[3]),
        keyId: String(bindings[4]),
        status: "pending",
      });
      return new FakeCursor([]);
    }
    if (sql.startsWith("SELECT STATUS FROM PENDING_AUTHORIZATIONS WHERE SESSION_HASH")) {
      const sessionHash = String(bindings[0]);
      const value = [...this.pending.values()].find(
        (candidate) => candidate.sessionHash === sessionHash,
      );
      return new FakeCursor(value ? [{ status: value.status }] : []);
    }
    if (sql.startsWith("SELECT 1 AS PRESENT FROM CONNECTIONS WHERE SESSION_HASH")) {
      return new FakeCursor(
        this.connections.has(String(bindings[0])) ? [{ present: 1 }] : [],
      );
    }
    if (sql.startsWith("SELECT 1 AS PRESENT FROM PENDING_AUTHORIZATIONS LIMIT 1")) {
      return new FakeCursor(this.pending.size > 0 ? [{ present: 1 }] : []);
    }
    if (
      sql.startsWith(
        "UPDATE PENDING_AUTHORIZATIONS SET STATUS = 'PROCESSING' WHERE STATE_HASH = ? AND SESSION_HASH = ? AND STATUS = 'PENDING' RETURNING PAYLOAD",
      )
    ) {
      const key = String(bindings[0]);
      const value = this.pending.get(key);
      if (
        !value ||
        value.sessionHash !== String(bindings[1]) ||
        value.status !== "pending"
      ) {
        return new FakeCursor([]);
      }
      value.status = "processing";
      return new FakeCursor([{ payload: value.payload, key_id: value.keyId }]);
    }
    if (sql.startsWith("UPDATE PENDING_AUTHORIZATIONS SET PAYLOAD")) {
      const value = this.pending.get(String(bindings[2]));
      if (value) {
        value.payload = String(bindings[0]);
        value.keyId = String(bindings[1]);
      }
      return new FakeCursor([]);
    }
    if (sql.startsWith("DELETE FROM PENDING_AUTHORIZATIONS WHERE SESSION_HASH")) {
      const sessionHash = String(bindings[0]);
      for (const [key, value] of this.pending) {
        if (value.sessionHash === sessionHash) this.pending.delete(key);
      }
      return new FakeCursor([]);
    }
    throw new Error(`Unexpected SQL in test: ${query}`);
  }
}

const sessionId = "s".repeat(43);
const encryptionKey = Buffer.alloc(32, 7);
const rotatedEncryptionKey = Buffer.alloc(32, 8);
const testNow = 1_001_000;

function keyring(
  currentKeyId: string,
  entries: ReadonlyArray<readonly [string, Buffer]>,
) {
  return { currentKeyId, keys: new Map(entries) };
}

const connection: ConnectionRecord = {
  oauthClientId: "client-id",
  fhirBaseUrl: "https://ehr.example.test/fhir",
  tokenEndpoint: "https://ehr.example.test/token",
  accessToken: "sensitive-access-token",
  refreshToken: "sensitive-refresh-token",
  tokenType: "Bearer",
  expiresAt: 2_000_000,
  scope: "patient/Patient.read",
  patientId: "sensitive-patient-id",
  connectedAt: 1_000_000,
  sessionExpiresAt: 3_000_000,
};

const authorization: PendingAuthorization = {
  sessionId,
  createdAt: 1_000_000,
  codeVerifier: "v".repeat(64),
  nonce: "n".repeat(43),
  consent: {
    policyVersion: "test-v1",
    acceptedAt: 999_000,
    purpose: "patient-access",
    requestedScopes: ["openid", "launch/patient"],
    allowedResourceScopes: ["patient/Patient.r"],
  },
  discovery: {
    fhirBaseUrl: "https://ehr.example.test/fhir",
    smart: {
      authorizationEndpoint: "https://ehr.example.test/authorize",
      tokenEndpoint: "https://ehr.example.test/token",
      capabilities: ["launch-standalone"],
      codeChallengeMethods: ["S256"],
      tokenAuthMethods: ["client_secret_basic"],
    },
    oidc: {
      issuer: "https://ehr.example.test/oauth2",
      jwksUri: "https://ehr.example.test/jwks",
      idTokenAlgorithms: ["ES384"],
    },
    fhirVersion: "4.0.1",
    fhirCapabilities: [{
      resourceType: "Patient",
      interactions: ["read"],
      searchParameters: ["_id"],
    }],
  },
};

describe("Cloudflare Durable Object storage", () => {
  it("persists encrypted connection records across store instances", async () => {
    const database = new FakeSqlStorage();
    const first = new DurableObjectConnectionStore(
      database as unknown as SqlStorage,
      encryptionKey,
      () => testNow,
    );
    await first.initialize();
    await first.set(sessionId, connection);

    const stored = [...database.connections.values()][0]!;
    expect(stored.payload).not.toContain(sessionId);
    expect(stored.payload).not.toContain(connection.accessToken);
    expect(stored.payload).not.toContain(connection.refreshToken!);
    expect(stored.payload).not.toContain(connection.patientId);
    expect(stored.keyId).toBe("legacy");
    expect(stored.cleanupAfter).toBe(connection.sessionExpiresAt);

    const reopened = new DurableObjectConnectionStore(
      database as unknown as SqlStorage,
      encryptionKey,
      () => testNow,
    );
    await reopened.initialize();
    await expect(reopened.get(sessionId)).resolves.toEqual(connection);
    await expect(reopened.list()).resolves.toEqual([[sessionId, connection]]);

    const wrongKey = new DurableObjectConnectionStore(
      database as unknown as SqlStorage,
      Buffer.alloc(32, 9),
      () => testNow,
    );
    await expect(wrongKey.get(sessionId)).rejects.toMatchObject({
      code: "token_store_unreadable",
    });
  });

  it("reads an old key and lazily rewrites the connection with the current key", async () => {
    const database = new FakeSqlStorage();
    const oldStore = new DurableObjectConnectionStore(
      database as unknown as SqlStorage,
      keyring("old", [["old", encryptionKey]]),
      () => testNow,
    );
    await oldStore.initialize();
    await oldStore.set(sessionId, connection);
    const oldPayload = [...database.connections.values()][0]!.payload;

    const rotatedStore = new DurableObjectConnectionStore(
      database as unknown as SqlStorage,
      keyring("current", [
        ["old", encryptionKey],
        ["current", rotatedEncryptionKey],
      ]),
      () => testNow,
    );
    await rotatedStore.initialize();
    await expect(rotatedStore.get(sessionId)).resolves.toEqual(connection);

    const rotated = [...database.connections.values()][0]!;
    expect(rotated.keyId).toBe("current");
    expect(rotated.payload).not.toBe(oldPayload);
    const currentOnly = new DurableObjectConnectionStore(
      database as unknown as SqlStorage,
      keyring("current", [["current", rotatedEncryptionKey]]),
      () => testNow,
    );
    await currentOnly.initialize();
    await expect(currentOnly.get(sessionId)).resolves.toEqual(connection);
  });

  it("migrates and reads a legacy row without key metadata", async () => {
    const database = new FakeSqlStorage();
    const original = new DurableObjectConnectionStore(
      database as unknown as SqlStorage,
      encryptionKey,
      () => testNow,
    );
    await original.initialize();
    await original.set(sessionId, connection);
    database.downgradeToLegacySchema();

    const migrationTime = 1_500_000;
    const migrated = new DurableObjectConnectionStore(
      database as unknown as SqlStorage,
      keyring("current", [
        ["old", encryptionKey],
        ["current", rotatedEncryptionKey],
      ]),
      () => migrationTime,
    );
    await migrated.initialize();

    expect([...database.migrations.keys()]).toEqual([1, 2]);
    expect(database.columns.get("connections")).toEqual(new Set([
      "session_hash",
      "payload",
      "key_id",
      "cleanup_after",
    ]));
    expect([...database.connections.values()][0]!.cleanupAfter).toBe(
      migrationTime + 30 * 24 * 60 * 60 * 1_000,
    );
    await expect(migrated.get(sessionId)).resolves.toEqual(connection);
    expect([...database.connections.values()][0]).toMatchObject({
      keyId: "current",
      cleanupAfter: connection.sessionExpiresAt,
    });
  });

  it("deletes an expired record even when its encryption key is missing", async () => {
    const database = new FakeSqlStorage();
    const original = new DurableObjectConnectionStore(
      database as unknown as SqlStorage,
      keyring("old", [["old", encryptionKey]]),
      () => testNow,
    );
    await original.initialize();
    await original.set(sessionId, connection);

    const missingOldKey = new DurableObjectConnectionStore(
      database as unknown as SqlStorage,
      keyring("current", [["current", rotatedEncryptionKey]]),
      () => connection.sessionExpiresAt + 1,
    );
    await missingOldKey.initialize();
    await expect(missingOldKey.list()).resolves.toEqual([]);
    expect(database.connections.size).toBe(0);
  });

  it("eventually deletes an unreadable legacy row using its migration cleanup bound", async () => {
    const database = new FakeSqlStorage();
    const original = new DurableObjectConnectionStore(
      database as unknown as SqlStorage,
      encryptionKey,
      () => testNow,
    );
    await original.initialize();
    await original.set(sessionId, connection);
    database.downgradeToLegacySchema();

    let now = 2_000_000;
    const missingLegacyKey = new DurableObjectConnectionStore(
      database as unknown as SqlStorage,
      keyring("current", [["current", rotatedEncryptionKey]]),
      () => now,
    );
    await missingLegacyKey.initialize();
    await expect(missingLegacyKey.list()).rejects.toMatchObject({
      code: "token_store_unreadable",
    });

    now += 30 * 24 * 60 * 60 * 1_000 + 1;
    await expect(missingLegacyKey.list()).resolves.toEqual([]);
    expect(database.connections.size).toBe(0);
  });

  it("records schema migrations once and upgrades the legacy pending schema", async () => {
    const database = new FakeSqlStorage();
    database.downgradeToLegacySchema();
    const store = new DurableObjectConnectionStore(
      database as unknown as SqlStorage,
      encryptionKey,
      () => testNow,
    );
    const pending = new DurableObjectPendingAuthorizationStore(
      database as unknown as SqlStorage,
      encryptionKey,
      10_000,
      () => testNow,
    );

    await store.initialize();
    pending.initialize();
    await store.initialize();

    expect([...database.migrations.keys()]).toEqual([1, 2]);
    expect(database.migrationWrites).toBe(2);
    expect(database.columns.get("pending_authorizations")).toEqual(new Set([
      "state_hash",
      "session_hash",
      "created_at",
      "payload",
      "status",
      "key_id",
    ]));
    expect(database.indexes).toContain("pending_one_per_session");
  });

  it("persists encrypted state and atomically consumes it once", async () => {
    const database = new FakeSqlStorage();
    const state = "a".repeat(43);
    const first = new DurableObjectPendingAuthorizationStore(
      database as unknown as SqlStorage,
      encryptionKey,
      10_000,
      () => 1_001_000,
    );
    first.initialize();
    await first.create(state, authorization);

    const stored = [...database.pending.values()][0]!.payload;
    expect(stored).not.toContain(sessionId);
    expect(stored).not.toContain(authorization.codeVerifier);
    expect(stored).not.toContain(authorization.nonce);

    const reopened = new DurableObjectPendingAuthorizationStore(
      database as unknown as SqlStorage,
      encryptionKey,
      10_000,
      () => 1_001_000,
    );
    reopened.initialize();
    await expect(reopened.consume(state, "x".repeat(43))).rejects.toMatchObject({
      code: "invalid_oauth_state",
    });
    await expect(reopened.consume(state, sessionId)).resolves.toEqual(authorization);
    await expect(reopened.consume(state, sessionId)).rejects.toMatchObject({
      code: "invalid_oauth_state",
    });
    await expect(
      reopened.create("b".repeat(43), { ...authorization, createdAt: 1_001_000 }),
    ).rejects.toMatchObject({ code: "authorization_in_progress" });

    await reopened.deleteForSession(sessionId);
    await expect(
      reopened.create("b".repeat(43), { ...authorization, createdAt: 1_001_000 }),
    ).resolves.toBeUndefined();
  });

  it("rotates pending authorization encryption to the current key", async () => {
    const database = new FakeSqlStorage();
    const state = "r".repeat(43);
    const oldStore = new DurableObjectPendingAuthorizationStore(
      database as unknown as SqlStorage,
      keyring("old", [["old", encryptionKey]]),
      10_000,
      () => testNow,
    );
    oldStore.initialize();
    await oldStore.create(state, authorization);

    const rotated = new DurableObjectPendingAuthorizationStore(
      database as unknown as SqlStorage,
      keyring("current", [
        ["old", encryptionKey],
        ["current", rotatedEncryptionKey],
      ]),
      10_000,
      () => testNow,
    );
    rotated.initialize();
    await expect(rotated.consume(state, sessionId)).resolves.toEqual(authorization);
    const row = [...database.pending.values()][0]!;
    expect(row.keyId).toBe("current");

    row.status = "pending";
    const currentOnly = new DurableObjectPendingAuthorizationStore(
      database as unknown as SqlStorage,
      keyring("current", [["current", rotatedEncryptionKey]]),
      10_000,
      () => testNow,
    );
    currentOnly.initialize();
    await expect(currentOnly.consume(state, sessionId)).resolves.toEqual(authorization);
  });
});
