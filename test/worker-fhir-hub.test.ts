import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    protected readonly ctx: unknown;
    protected readonly env: unknown;

    public constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import type {
  FhirHubIdentity,
  FhirHubState,
} from "../src/fhir-hub.js";
import { InMemoryFhirHubRepository } from "../src/fhir-hub.js";
import {
  DurableObjectFhirHubStatePersistence,
  WorkerFhirHubRepository,
} from "../src/worker-fhir-hub.js";

type FakeSqlValue = string | number | null;

interface FakeManifest extends Record<string, FakeSqlValue> {
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

class FakeCursor<T extends Record<string, FakeSqlValue>> {
  public constructor(private readonly rows: T[]) {}

  public toArray(): T[] {
    return [...this.rows];
  }

  public *[Symbol.iterator](): IterableIterator<T> {
    yield* this.rows;
  }
}

class FakeHubSqlStorage {
  public manifest: FakeManifest | undefined;
  public readonly chunks = new Map<string, Map<number, string>>();
  public manifestHasCleanupAfterColumn = true;
  public updatedAt: number | undefined;
  public failNextManifestWrite = false;
  public failCleanupDeadlineRepair = false;
  public failChunkInsertAt: number | undefined;
  #chunkInsertCount = 0;

  public exec(
    query: string,
    ...bindings: Array<string | number>
  ): FakeCursor<Record<string, FakeSqlValue>> {
    const sql = query.replace(/\s+/g, " ").trim().toUpperCase();
    if (
      sql.startsWith("CREATE TABLE IF NOT EXISTS FHIR_HUB_MANIFEST") ||
      sql.startsWith("CREATE TABLE IF NOT EXISTS FHIR_HUB_CHUNKS")
    ) {
      return new FakeCursor([]);
    }
    if (sql === "PRAGMA TABLE_INFO(FHIR_HUB_MANIFEST)") {
      return new FakeCursor([
        { name: "singleton" },
        ...(this.manifestHasCleanupAfterColumn ? [{ name: "cleanup_after" }] : []),
      ]);
    }
    if (sql.startsWith("ALTER TABLE FHIR_HUB_MANIFEST ADD COLUMN CLEANUP_AFTER")) {
      this.manifestHasCleanupAfterColumn = true;
      if (this.manifest) this.manifest = { ...this.manifest, cleanupAfter: null };
      return new FakeCursor([]);
    }
    if (sql.includes("FROM FHIR_HUB_MANIFEST") && sql.startsWith("SELECT FORMAT_VERSION")) {
      return new FakeCursor(this.manifest ? [{ ...this.manifest }] : []);
    }
    if (sql.startsWith("SELECT CLEANUP_AFTER AS CLEANUPAFTER FROM FHIR_HUB_MANIFEST")) {
      return new FakeCursor(this.manifest ? [{ cleanupAfter: this.manifest.cleanupAfter }] : []);
    }
    if (sql.startsWith("SELECT CHUNK_INDEX AS CHUNKINDEX, CIPHERTEXT FROM FHIR_HUB_CHUNKS")) {
      const generation = String(bindings[0]);
      const generationChunks = this.chunks.get(generation);
      const rows = generationChunks
        ? [...generationChunks.entries()]
          .sort(([left], [right]) => left - right)
          .map(([chunkIndex, ciphertext]) => ({ chunkIndex, ciphertext }))
        : [];
      return new FakeCursor(rows);
    }
    if (sql.startsWith("INSERT INTO FHIR_HUB_CHUNKS")) {
      this.#chunkInsertCount += 1;
      if (this.failChunkInsertAt === this.#chunkInsertCount) {
        throw new Error("simulated interrupted chunk write");
      }
      const generation = String(bindings[0]);
      const chunkIndex = Number(bindings[1]);
      const ciphertext = String(bindings[2]);
      const generationChunks = this.chunks.get(generation) ?? new Map<number, string>();
      if (generationChunks.has(chunkIndex)) throw new Error("duplicate chunk");
      generationChunks.set(chunkIndex, ciphertext);
      this.chunks.set(generation, generationChunks);
      return new FakeCursor([]);
    }
    if (sql.startsWith("INSERT INTO FHIR_HUB_MANIFEST")) {
      if (this.failNextManifestWrite) {
        this.failNextManifestWrite = false;
        throw new Error("simulated interrupted manifest switch");
      }
      this.manifest = {
        formatVersion: Number(bindings[0]),
        algorithm: String(bindings[1]),
        generation: String(bindings[2]),
        iv: String(bindings[3]),
        tag: String(bindings[4]),
        chunkCount: Number(bindings[5]),
        chunkSize: Number(bindings[6]),
        ciphertextChars: Number(bindings[7]),
        cleanupAfter: Number(bindings[8]),
      };
      this.updatedAt = Number(bindings[9]);
      return new FakeCursor([]);
    }
    if (sql.startsWith("UPDATE FHIR_HUB_MANIFEST SET CLEANUP_AFTER =")) {
      if (this.failCleanupDeadlineRepair) {
        throw new Error("simulated cleanup deadline repair failure");
      }
      if (
        this.manifest?.generation === String(bindings[1])
      ) {
        this.manifest = {
          ...this.manifest,
          cleanupAfter: Number(bindings[0]),
        };
      }
      return new FakeCursor([]);
    }
    if (sql.startsWith("SELECT 1 AS READY FROM FHIR_HUB_MANIFEST")) {
      return new FakeCursor(this.manifest ? [{ ready: 1 }] : []);
    }
    if (sql.startsWith("SELECT 1 AS READY FROM FHIR_HUB_CHUNKS")) {
      return new FakeCursor(this.chunks.size > 0 ? [{ ready: 1 }] : []);
    }
    if (sql.startsWith("DELETE FROM FHIR_HUB_MANIFEST")) {
      this.manifest = undefined;
      this.updatedAt = undefined;
      return new FakeCursor([]);
    }
    if (sql.startsWith("DELETE FROM FHIR_HUB_CHUNKS WHERE GENERATION <>")) {
      const generationToKeep = String(bindings[0]);
      for (const generation of this.chunks.keys()) {
        if (generation !== generationToKeep) this.chunks.delete(generation);
      }
      return new FakeCursor([]);
    }
    if (sql.startsWith("DELETE FROM FHIR_HUB_CHUNKS WHERE GENERATION =")) {
      this.chunks.delete(String(bindings[0]));
      return new FakeCursor([]);
    }
    if (sql === "DELETE FROM FHIR_HUB_CHUNKS") {
      this.chunks.clear();
      return new FakeCursor([]);
    }
    throw new Error(`Unexpected SQL in test: ${query}`);
  }
}

const accountRef = "a".repeat(43);
const sourceConnectionId = "s".repeat(43);
const patientSubjectId = "p".repeat(43);
const acceptedAt = "2026-08-25T12:00:00.000Z";
const encryptionKey = Buffer.alloc(32, 7);

const identity: FhirHubIdentity = {
  accountRef,
  sourceConnectionId,
  patientSubjectId,
  fhirIssuer: "https://ehr.example.test/fhir/R4",
};

function opaqueRef(fill: string, index: number): string {
  const suffix = index.toString(36);
  return `${fill.repeat(43 - suffix.length)}${suffix}`;
}

function hubState(additionalProfiles = 0): FhirHubState {
  const state: FhirHubState = {
    schemaVersion: 1,
    profiles: {
      [accountRef]: {
        identity,
        consent: {
          schemaVersion: 1,
          purpose: "longitudinal-health-hub",
          policyVersion: "hub-v1",
          acceptedAt,
          retentionMs: 86_400_000,
        },
        updatedAt: acceptedAt,
      },
    },
    resourceVersions: {},
    currentResources: {},
    insights: {},
  };
  for (let index = 1; index <= additionalProfiles; index += 1) {
    const extraAccountRef = opaqueRef("b", index);
    state.profiles[extraAccountRef] = {
      identity: {
        accountRef: extraAccountRef,
        sourceConnectionId: opaqueRef("s", index),
        patientSubjectId: opaqueRef("p", index),
        fhirIssuer: `https://ehr.example.test/fhir/R4/${index}`,
      },
      consent: {
        schemaVersion: 1,
        purpose: "longitudinal-health-hub",
        policyVersion: "hub-v1",
        acceptedAt,
        retentionMs: 86_400_000,
      },
      updatedAt: acceptedAt,
    };
  }
  return state;
}

async function hubStateWithExpiringResource(
  retrievedOffsets: readonly number[] = [1_000],
): Promise<FhirHubState> {
  const repository = new InMemoryFhirHubRepository();
  await repository.initialize();
  const accepted = Date.parse(acceptedAt);
  const consent = {
    schemaVersion: 1 as const,
    purpose: "longitudinal-health-hub" as const,
    policyVersion: "hub-v1",
    acceptedAt,
    retentionMs: 86_400_000,
  };
  await repository.enable(identity, consent);
  for (const [index, offset] of retrievedOffsets.entries()) {
    await repository.ingest(identity, {
      resourceType: "Observation",
      id: `observation-${index + 1}`,
      status: "final",
    }, consent.policyVersion, accepted + offset);
  }
  const versions = await repository.list(identity, { includeHistory: true });
  await repository.close();
  return {
    schemaVersion: 1,
    profiles: {
      [accountRef]: {
        identity,
        consent,
        updatedAt: acceptedAt,
      },
    },
    resourceVersions: Object.fromEntries(versions.map((version) =>
      [version.versionKey, version])),
    currentResources: Object.fromEntries(versions.map((version) =>
      [version.currentKey, version.versionKey])),
    insights: {},
  };
}

describe("Cloudflare FHIR hub state persistence", () => {
  let database: FakeHubSqlStorage;

  beforeEach(() => {
    database = new FakeHubSqlStorage();
  });

  it("round-trips a multi-chunk AES-GCM generation below the SQLite row limit", async () => {
    const persistence = new DurableObjectFhirHubStatePersistence(
      database as unknown as SqlStorage,
      encryptionKey,
      "durable-object-id-one",
      () => 123_456,
    );
    await persistence.initialize();
    const largeState = hubState(2_000);
    await persistence.save(largeState);

    expect(database.updatedAt).toBe(123_456);
    expect(database.manifest).toMatchObject({
      formatVersion: 2,
      algorithm: "A256GCM",
    });
    expect(database.manifest!.chunkCount).toBeGreaterThan(1);
    const activeChunks = database.chunks.get(database.manifest!.generation)!;
    expect(activeChunks).toHaveLength(database.manifest!.chunkCount);
    expect([...activeChunks.values()].every((chunk) => chunk.length <= 512 * 1_024)).toBe(true);

    const storageText = JSON.stringify({
      manifest: database.manifest,
      chunks: [...activeChunks.values()],
    });
    expect(storageText).not.toContain(accountRef);
    expect(storageText).not.toContain(patientSubjectId);
    expect(storageText).not.toContain("ehr.example.test");

    const reopened = new DurableObjectFhirHubStatePersistence(
      database as unknown as SqlStorage,
      encryptionKey,
      "durable-object-id-one",
    );
    await expect(reopened.load()).resolves.toEqual(largeState);
  });

  it("persists a minimal encrypted readiness sentinel and verifies its key", async () => {
    const persistence = new DurableObjectFhirHubStatePersistence(
      database as unknown as SqlStorage,
      encryptionKey,
      "readiness-object-id",
    );
    await persistence.initialize();
    await persistence.ensureReadinessSentinel();
    const generation = database.manifest?.generation;
    expect(generation).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await persistence.ensureReadinessSentinel();
    expect(database.manifest?.generation).toBe(generation);

    const wrongKey = new DurableObjectFhirHubStatePersistence(
      database as unknown as SqlStorage,
      Buffer.alloc(32, 9),
      "readiness-object-id",
    );
    await expect(wrongKey.ensureReadinessSentinel()).rejects.toMatchObject({
      code: "fhir_hub_store_unreadable",
    });
  });

  it("stores only the earliest plaintext cleanup deadline for unreadable-state recovery", async () => {
    const persistence = new DurableObjectFhirHubStatePersistence(
      database as unknown as SqlStorage,
      encryptionKey,
      "durable-object-id-one",
    );
    await persistence.initialize();
    const state = await hubStateWithExpiringResource([1_000, 5_000]);
    const expiries = Object.values(state.resourceVersions)
      .map((version) => Date.parse(version.expiresAt));
    await persistence.save(state);

    expect(persistence.persistedCleanupAfter()).toBe(Math.min(...expiries));
    expect(JSON.stringify(database.manifest)).not.toContain("observation-1");
    persistence.deletePersistedState();
    expect(persistence.persistedCleanupAfter()).toBeUndefined();
  });

  it("repairs a cleanup deadline that no longer matches authenticated state", async () => {
    const persistence = new DurableObjectFhirHubStatePersistence(
      database as unknown as SqlStorage,
      encryptionKey,
      "durable-object-id-one",
    );
    await persistence.initialize();
    const state = await hubStateWithExpiringResource();
    const expected = Math.min(...Object.values(state.resourceVersions)
      .map((version) => Date.parse(version.expiresAt)));
    await persistence.save(state);
    database.manifest = {
      ...database.manifest!,
      cleanupAfter: database.manifest!.cleanupAfter! + 1,
    };

    const loaded = await persistence.load();
    expect(loaded).toEqual(state);
    expect(persistence.persistedCleanupAfter()).toBe(expected);
  });

  it("never exposes a stale cleanup deadline when its repair fails", async () => {
    const persistence = new DurableObjectFhirHubStatePersistence(
      database as unknown as SqlStorage,
      encryptionKey,
      "durable-object-id-one",
    );
    await persistence.initialize();
    await persistence.save(await hubStateWithExpiringResource());
    database.manifest = {
      ...database.manifest!,
      cleanupAfter: database.manifest!.cleanupAfter! + 1,
    };
    database.failCleanupDeadlineRepair = true;

    await expect(persistence.load()).rejects.toMatchObject({
      code: "fhir_hub_store_unreadable",
    });
    expect(() => persistence.persistedCleanupAfter()).toThrowError(
      expect.objectContaining({ code: "fhir_hub_store_unreadable" }),
    );
  });

  it("adds and exactly backfills the cleanup deadline on a legacy manifest", async () => {
    const state = await hubStateWithExpiringResource([1_000, 5_000]);
    const writer = new DurableObjectFhirHubStatePersistence(
      database as unknown as SqlStorage,
      encryptionKey,
      "durable-object-id-one",
    );
    await writer.initialize();
    await writer.save(state);

    database.manifestHasCleanupAfterColumn = false;
    database.manifest = { ...database.manifest!, cleanupAfter: null };
    const migrated = new DurableObjectFhirHubStatePersistence(
      database as unknown as SqlStorage,
      encryptionKey,
      "durable-object-id-one",
    );
    await migrated.initialize();

    await expect(migrated.load()).resolves.toEqual(state);
    expect(database.manifestHasCleanupAfterColumn).toBe(true);
    expect(migrated.persistedCleanupAfter()).toBe(Math.min(
      ...Object.values(state.resourceVersions)
        .map((version) => Date.parse(version.expiresAt)),
    ));
  });

  it("rejects an oversized account generation without replacing readable state", async () => {
    const persistence = new DurableObjectFhirHubStatePersistence(
      database as unknown as SqlStorage,
      encryptionKey,
      "durable-object-id-one",
    );
    await persistence.initialize();
    const previous = hubState();
    await persistence.save(previous);
    const previousGeneration = database.manifest!.generation;
    const oversized = hubState(36_000);
    expect(Buffer.byteLength(JSON.stringify(oversized), "utf8")).toBeGreaterThan(16 * 1_024 * 1_024);

    await expect(persistence.save(oversized)).rejects.toMatchObject({
      statusCode: 413,
      code: "fhir_hub_store_too_large",
    });
    expect(database.manifest!.generation).toBe(previousGeneration);
    await expect(persistence.load()).resolves.toEqual(previous);
  });

  it("binds ciphertext to the hub-specific Durable Object identity", async () => {
    const writer = new DurableObjectFhirHubStatePersistence(
      database as unknown as SqlStorage,
      encryptionKey,
      "durable-object-id-one",
    );
    await writer.initialize();
    await writer.save(hubState());

    const movedBlobReader = new DurableObjectFhirHubStatePersistence(
      database as unknown as SqlStorage,
      encryptionKey,
      "durable-object-id-two",
    );
    await expect(movedBlobReader.load()).rejects.toMatchObject({
      code: "fhir_hub_store_unreadable",
    });

    const wrongKeyReader = new DurableObjectFhirHubStatePersistence(
      database as unknown as SqlStorage,
      Buffer.alloc(32, 8),
      "durable-object-id-one",
    );
    await expect(wrongKeyReader.load()).rejects.toMatchObject({
      code: "fhir_hub_store_unreadable",
    });
  });

  it("keeps the previous generation readable when the manifest switch is interrupted", async () => {
    const persistence = new DurableObjectFhirHubStatePersistence(
      database as unknown as SqlStorage,
      encryptionKey,
      "durable-object-id-one",
    );
    await persistence.initialize();
    const previousState = hubState();
    await persistence.save(previousState);
    const previousGeneration = database.manifest!.generation;

    database.failNextManifestWrite = true;
    await expect(persistence.save(hubState(2_000))).rejects.toMatchObject({
      code: "fhir_hub_store_unavailable",
    });

    expect(database.manifest!.generation).toBe(previousGeneration);
    expect([...database.chunks.keys()]).toEqual([previousGeneration]);
    await expect(persistence.load()).resolves.toEqual(previousState);
  });

  it("rejects swapped or missing ciphertext chunks", async () => {
    const persistence = new DurableObjectFhirHubStatePersistence(
      database as unknown as SqlStorage,
      encryptionKey,
      "durable-object-id-one",
    );
    await persistence.initialize();
    await persistence.save(hubState(2_000));

    const generation = database.manifest!.generation;
    const chunks = database.chunks.get(generation)!;
    const first = chunks.get(0)!;
    const second = chunks.get(1)!;
    chunks.set(0, second);
    chunks.set(1, first);
    await expect(persistence.load()).rejects.toMatchObject({
      code: "fhir_hub_store_unreadable",
    });

    chunks.set(0, first);
    chunks.set(1, second);
    chunks.delete(1);
    await expect(persistence.load()).rejects.toMatchObject({
      code: "fhir_hub_store_unreadable",
    });
  });

  it("rejects non-canonical manifest base64", async () => {
    const persistence = new DurableObjectFhirHubStatePersistence(
      database as unknown as SqlStorage,
      encryptionKey,
      "durable-object-id-one",
    );
    await persistence.initialize();
    await persistence.save(hubState());

    database.manifest = {
      ...database.manifest!,
      iv: `${database.manifest!.iv}=`,
    };
    await expect(persistence.load()).rejects.toMatchObject({
      code: "fhir_hub_store_unreadable",
    });
  });

  it("physically removes the encrypted manifest and every generation on deletion", async () => {
    const persistence = new DurableObjectFhirHubStatePersistence(
      database as unknown as SqlStorage,
      encryptionKey,
      "durable-object-id-one",
    );
    await persistence.initialize();
    await persistence.save(hubState());

    persistence.deletePersistedState();

    expect(database.manifest).toBeUndefined();
    expect(database.chunks.size).toBe(0);
    await expect(persistence.load()).resolves.toBeUndefined();
  });
});

describe("Worker FHIR hub repository routing", () => {
  it("uses only the opaque server-derived account reference as the object name", async () => {
    const objectNames: string[] = [];
    const status = {
      available: true,
      enabled: true,
      consentCurrent: true,
      consentPolicyVersion: "hub-v1",
      currentResourceCount: 0,
      resourceVersionCount: 0,
      careTeamCount: 0,
      insightCount: 0,
    };
    const stub = {
      status: vi.fn().mockResolvedValue(status),
    };
    const namespace = {
      getByName(name: string) {
        objectNames.push(name);
        return stub;
      },
    };
    const repository = new WorkerFhirHubRepository(
      namespace as unknown as DurableObjectNamespace<never>,
    );

    await expect(repository.status(identity, "hub-v1", Date.now())).resolves.toEqual(status);

    expect(objectNames).toEqual([accountRef]);
    expect(objectNames[0]).not.toContain("ehr.example.test");
    expect(stub.status).toHaveBeenCalledWith(identity, "hub-v1", expect.any(Number));
  });

  it("rejects an invalid account reference before selecting a Durable Object", async () => {
    const getByName = vi.fn();
    const repository = new WorkerFhirHubRepository(
      { getByName } as unknown as DurableObjectNamespace<never>,
    );

    await expect(repository.status(
      { ...identity, accountRef: "Patient/real-id" },
      "hub-v1",
      Date.now(),
    )).rejects.toBeDefined();
    expect(getByName).not.toHaveBeenCalled();
  });

  it("routes raw-free intelligence queries to the opaque account shard", async () => {
    const intelligence = {
      schemaVersion: 1 as const,
      projections: [],
      insights: [],
      hasMore: false,
    };
    const stub = {
      intelligence: vi.fn().mockResolvedValue(intelligence),
    };
    const getByName = vi.fn(() => stub);
    const repository = new WorkerFhirHubRepository(
      { getByName } as unknown as DurableObjectNamespace<never>,
    );

    await expect(repository.intelligence(identity, {
      resourceType: "Observation",
      includeHistory: true,
      includeSuperseded: true,
      limit: 25,
    })).resolves.toEqual(intelligence);
    expect(getByName).toHaveBeenCalledWith(accountRef);
    expect(stub.intelligence).toHaveBeenCalledWith(identity, {
      resourceType: "Observation",
      includeHistory: true,
      includeSuperseded: true,
      limit: 25,
    });
  });
});
