import { createDecipheriv } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  EncryptedFileFhirHubRepository,
  EncryptedFileFhirHubStatePersistence,
} from "../src/fhir-hub-file.js";
import { fhirHubStateSchema, type FhirHubIdentity, type FhirHubState } from "../src/fhir-hub.js";

const identity: FhirHubIdentity = {
  accountRef: "a".repeat(43),
  sourceConnectionId: "s".repeat(43),
  patientSubjectId: "p".repeat(43),
  fhirIssuer: "https://ehr.example.test/fhir",
};

const acceptedAt = 1_700_000_000_000;
const policyVersion = "hub-policy-2026-08";

const emptyState: FhirHubState = {
  schemaVersion: 1,
  profiles: {},
  resourceVersions: {},
  currentResources: {},
  insights: {},
};

async function enable(repository: EncryptedFileFhirHubRepository): Promise<void> {
  await repository.enable(identity, {
    schemaVersion: 1,
    purpose: "longitudinal-health-hub",
    policyVersion,
    acceptedAt: new Date(acceptedAt).toISOString(),
    retentionMs: 365 * 24 * 60 * 60 * 1_000,
  });
}

describe("encrypted file FHIR hub persistence", () => {
  it("round-trips raw FHIR without putting PHI in plaintext on disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "epic-fhir-hub-test-"));
    const directory = join(root, "private-hub");
    const path = join(directory, "hub.enc");
    const key = Buffer.alloc(32, 11);
    const repository = new EncryptedFileFhirHubRepository(path, key);
    await repository.initialize();
    await enable(repository);

    const result = await repository.ingest(identity, {
      resourceType: "Patient",
      id: "sensitive-patient-id",
      name: [{ text: "Very Sensitive Patient Name" }],
    }, policyVersion, acceptedAt + 1_000);
    expect(result).toMatchObject({ accepted: true, versionsCreated: 1 });

    const disk = await readFile(path, "utf8");
    expect(disk).not.toContain("Very Sensitive Patient Name");
    expect(disk).not.toContain("sensitive-patient-id");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);

    const envelope = JSON.parse(disk) as { iv: string; tag: string; ciphertext: string };
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from("epic-private-fhir-hub:v1", "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    expect(() => fhirHubStateSchema.parse(JSON.parse(plaintext.toString("utf8")))).not.toThrow();

    await repository.close();
    await expect(access(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });

    const reopened = new EncryptedFileFhirHubRepository(path, key);
    await reopened.initialize();
    const resources = await reopened.list(identity);
    expect(resources).toHaveLength(1);
    expect(resources[0]?.raw).toMatchObject({
      resourceType: "Patient",
      id: "sensitive-patient-id",
      name: [{ text: "Very Sensitive Patient Name" }],
    });
    await reopened.close();
  });

  it("fails closed with the wrong key and releases the failed opener's lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "epic-fhir-hub-test-"));
    const path = join(root, "hub.enc");
    const correctKey = Buffer.alloc(32, 12);
    const repository = new EncryptedFileFhirHubRepository(path, correctKey);
    await repository.initialize();
    await enable(repository);
    await repository.close();

    const wrongKey = new EncryptedFileFhirHubRepository(path, Buffer.alloc(32, 13));
    await expect(wrongKey.initialize()).rejects.toThrow(/could not be opened/);
    await expect(access(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });

    const recovered = new EncryptedFileFhirHubRepository(path, correctKey);
    await expect(recovered.initialize()).resolves.toBeUndefined();
    await recovered.close();
  });

  it("rejects corrupt envelopes instead of replacing them with an empty vault", async () => {
    const root = await mkdtemp(join(tmpdir(), "epic-fhir-hub-test-"));
    const path = join(root, "hub.enc");
    await writeFile(path, JSON.stringify({
      version: 1,
      iv: Buffer.alloc(12).toString("base64"),
      tag: Buffer.alloc(16).toString("base64"),
      ciphertext: Buffer.from("not-valid-ciphertext").toString("base64"),
    }), { mode: 0o600 });

    const persistence = new EncryptedFileFhirHubStatePersistence(path, Buffer.alloc(32, 14));
    await expect(persistence.initialize()).rejects.toThrow(/file integrity/);
    expect(await readFile(path, "utf8")).toContain("ciphertext");
    await expect(access(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("admits only one writer until the owner closes cleanly", async () => {
    const root = await mkdtemp(join(tmpdir(), "epic-fhir-hub-test-"));
    const path = join(root, "hub.enc");
    const key = Buffer.alloc(32, 15);
    const first = new EncryptedFileFhirHubStatePersistence(path, key);
    const second = new EncryptedFileFhirHubStatePersistence(path, key);

    await first.initialize();
    await expect(first.checkReadiness()).resolves.toBeUndefined();
    expect((await stat(`${path}.lock`)).mode & 0o777).toBe(0o600);
    await expect(second.initialize()).rejects.toThrow(/is locked/);
    await first.close();
    await expect(second.initialize()).resolves.toBeUndefined();
    await second.close();
  });

  it("removes only exact orphaned vault temporary files while holding the lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "epic-fhir-hub-test-"));
    const path = join(root, "hub.enc");
    const orphan = `${path}.1234.0123456789abcdef.tmp`;
    const unrelated = `${path}.keep.tmp`;
    await writeFile(orphan, "encrypted PHI envelope", { mode: 0o600 });
    await writeFile(unrelated, "unrelated", { mode: 0o600 });

    const persistence = new EncryptedFileFhirHubStatePersistence(path, Buffer.alloc(32, 18));
    await persistence.initialize();
    await expect(access(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(unrelated, "utf8")).resolves.toBe("unrelated");
    await persistence.close();
  });

  it("keeps the last good state after a failed atomic write and recovers its queue", async () => {
    const root = await mkdtemp(join(tmpdir(), "epic-fhir-hub-test-"));
    const path = join(root, "hub.enc");
    const persistence = new EncryptedFileFhirHubStatePersistence(path, Buffer.alloc(32, 16));
    await persistence.initialize();
    await persistence.save(emptyState);

    await unlink(path);
    await mkdir(path);
    await expect(persistence.save(emptyState)).rejects.toThrow(/could not be saved/);
    expect(await persistence.load()).toEqual(emptyState);

    await rmdir(path);
    await expect(persistence.save(emptyState)).resolves.toBeUndefined();
    expect((await readFile(path, "utf8")).length).toBeGreaterThan(0);
    await persistence.close();
  });

  it("rejects invalid keys and invalid state before writing", async () => {
    expect(() => new EncryptedFileFhirHubStatePersistence("hub.enc", Buffer.alloc(31)))
      .toThrow(/must be 32 bytes/);

    const root = await mkdtemp(join(tmpdir(), "epic-fhir-hub-test-"));
    const path = join(root, "hub.enc");
    const persistence = new EncryptedFileFhirHubStatePersistence(path, Buffer.alloc(32, 17));
    await persistence.initialize();
    await expect(persistence.save({ ...emptyState, schemaVersion: 2 } as unknown as FhirHubState))
      .rejects.toBeTruthy();
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    await persistence.close();
  });
});
