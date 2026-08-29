import { mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EncryptedFileConnectionStore } from "../src/store.js";
import type { ConnectionRecord } from "../src/types.js";

const record: ConnectionRecord = {
  oauthClientId: "test-client-id",
  fhirBaseUrl: "https://ehr.example.test/fhir",
  tokenEndpoint: "https://ehr.example.test/token",
  accessToken: "sensitive-access-token",
  refreshToken: "sensitive-refresh-token",
  tokenType: "Bearer",
  expiresAt: 2_000_000_000_000,
  scope: "patient/Patient.read",
  patientId: "sensitive-patient-id",
  oidcIssuer: "https://ehr.example.test/oauth2",
  oidcSubject: "sensitive-account-subject",
  consent: {
    policyVersion: "terms-2026-08",
    acceptedAt: 1_700_000_000_000,
    purpose: "patient-access",
    requestedScopes: ["openid", "fhirUser", "launch/patient"],
    allowedResourceScopes: ["patient/Patient.read"],
  },
  fhirCapabilities: [{
    resourceType: "Patient",
    interactions: ["read", "search"],
    searchParameters: ["_id"],
    searchRevIncludes: ["Provenance:target"],
  }],
  connectedAt: 1_700_000_000_000,
  lastAccessAt: 1_700_000_000_100,
  sessionExpiresAt: 2_000_000_000_000,
};

describe("encrypted connection store", () => {
  it("round-trips records without plaintext secrets on disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "epic-store-test-"));
    const path = join(directory, "connections.enc");
    const key = Buffer.alloc(32, 7);
    const store = new EncryptedFileConnectionStore(path, key);
    await store.initialize();
    await store.set("session-id", record);

    const disk = await readFile(path, "utf8");
    expect(disk).not.toContain(record.accessToken);
    expect(disk).not.toContain(record.refreshToken);
    expect(disk).not.toContain(record.patientId);

    await store.close();
    const reopened = new EncryptedFileConnectionStore(path, key);
    await reopened.initialize();
    expect(await reopened.get("session-id")).toEqual(record);
    await reopened.close();
  });

  it("fails closed when the encryption key is wrong", async () => {
    const directory = await mkdtemp(join(tmpdir(), "epic-store-test-"));
    const path = join(directory, "connections.enc");
    const store = new EncryptedFileConnectionStore(path, Buffer.alloc(32, 1));
    await store.initialize();
    await store.set("session-id", record);
    await store.close();

    const wrongKeyStore = new EncryptedFileConnectionStore(path, Buffer.alloc(32, 2));
    await expect(wrongKeyStore.initialize()).rejects.toThrow(/could not be opened/);

    const recovered = new EncryptedFileConnectionStore(path, Buffer.alloc(32, 1));
    await expect(recovered.initialize()).resolves.toBeUndefined();
    await recovered.close();
  });

  it("rolls back failed writes and does not poison the write queue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "epic-store-test-"));
    const path = join(directory, "connections.enc");
    const store = new EncryptedFileConnectionStore(path, Buffer.alloc(32, 3));
    await store.initialize();

    await mkdir(path);
    await expect(store.set("session-id", record)).rejects.toBeTruthy();
    expect(await store.get("session-id")).toBeUndefined();

    await rmdir(path);
    await expect(store.set("session-id", record)).resolves.toBeUndefined();
    expect(await store.get("session-id")).toEqual(record);
    await store.close();
  });

  it("refuses a second writer until the first store releases its lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "epic-store-test-"));
    const path = join(directory, "connections.enc");
    const key = Buffer.alloc(32, 4);
    const first = new EncryptedFileConnectionStore(path, key);
    const second = new EncryptedFileConnectionStore(path, key);

    await first.initialize();
    await expect(second.initialize()).rejects.toThrow(/is locked/);
    await first.close();
    await expect(second.initialize()).resolves.toBeUndefined();
    await second.close();
  });

  it("fails closed on stale locks and admits only one concurrent writer after manual recovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "epic-store-test-"));
    const path = join(directory, "connections.enc");
    const lockPath = `${path}.lock`;
    const key = Buffer.alloc(32, 5);
    await writeFile(lockPath, JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      owner: "stale-owner-that-is-long-enough-for-validation",
      startedAt: 1,
    }));

    const blocked = new EncryptedFileConnectionStore(path, key);
    await expect(blocked.initialize()).rejects.toThrow(/After a crash/);
    await unlink(lockPath);

    const contenders = Array.from(
      { length: 16 },
      () => new EncryptedFileConnectionStore(path, key),
    );
    const results = await Promise.allSettled(contenders.map((store) => store.initialize()));
    const winners = results
      .map((result, index) => result.status === "fulfilled" ? index : -1)
      .filter((index) => index >= 0);
    expect(winners).toHaveLength(1);
    await contenders[winners[0]!]!.close();
  });
});
