import { describe, expect, it } from "vitest";

import type { ConnectionRecord, PendingAuthorization } from "../src/types.js";
import {
  DurableObjectConnectionStore,
  DurableObjectPendingAuthorizationStore,
} from "../src/worker-storage.js";

class FakeCursor<T extends Record<string, string | number>> {
  public constructor(private readonly rows: T[]) {}

  public toArray(): T[] {
    return [...this.rows];
  }

  public *[Symbol.iterator](): IterableIterator<T> {
    yield* this.rows;
  }
}

class FakeSqlStorage {
  public readonly connections = new Map<string, string>();
  public readonly pending = new Map<
    string,
    {
      readonly sessionHash: string;
      readonly createdAt: number;
      readonly payload: string;
      status: "pending" | "processing";
    }
  >();

  public exec(query: string, ...bindings: Array<string | number>): FakeCursor<Record<string, string | number>> {
    const sql = query.replace(/\s+/g, " ").trim().toUpperCase();
    if (
      sql.startsWith("CREATE TABLE") ||
      sql.startsWith("CREATE INDEX") ||
      sql.startsWith("CREATE UNIQUE INDEX") ||
      sql.startsWith("DROP INDEX") ||
      sql.startsWith("DELETE FROM PENDING_AUTHORIZATIONS WHERE ROWID")
    ) {
      return new FakeCursor([]);
    }
    if (sql.startsWith("PRAGMA TABLE_INFO")) {
      return new FakeCursor([{ name: "status" }]);
    }
    if (sql.startsWith("SELECT PAYLOAD FROM CONNECTIONS WHERE SESSION_HASH")) {
      const payload = this.connections.get(String(bindings[0]));
      return new FakeCursor(payload ? [{ payload }] : []);
    }
    if (sql.startsWith("SELECT SESSION_HASH, PAYLOAD FROM CONNECTIONS")) {
      return new FakeCursor(
        [...this.connections].map(([session_hash, payload]) => ({ session_hash, payload })),
      );
    }
    if (sql.startsWith("INSERT INTO CONNECTIONS")) {
      this.connections.set(String(bindings[0]), String(bindings[1]));
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
      return new FakeCursor(this.connections.has(String(bindings[0])) ? [{ present: 1 }] : []);
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
      return new FakeCursor([{ payload: value.payload }]);
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
  },
};

describe("Cloudflare Durable Object storage", () => {
  it("persists encrypted connection records across store instances", async () => {
    const database = new FakeSqlStorage();
    const first = new DurableObjectConnectionStore(
      database as unknown as SqlStorage,
      encryptionKey,
    );
    await first.initialize();
    await first.set(sessionId, connection);

    const stored = [...database.connections.values()][0]!;
    expect(stored).not.toContain(sessionId);
    expect(stored).not.toContain(connection.accessToken);
    expect(stored).not.toContain(connection.refreshToken!);
    expect(stored).not.toContain(connection.patientId);

    const reopened = new DurableObjectConnectionStore(
      database as unknown as SqlStorage,
      encryptionKey,
    );
    await reopened.initialize();
    await expect(reopened.get(sessionId)).resolves.toEqual(connection);
    await expect(reopened.list()).resolves.toEqual([[sessionId, connection]]);

    const wrongKey = new DurableObjectConnectionStore(
      database as unknown as SqlStorage,
      Buffer.alloc(32, 9),
    );
    await expect(wrongKey.get(sessionId)).rejects.toMatchObject({
      code: "token_store_unreadable",
    });
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
});
