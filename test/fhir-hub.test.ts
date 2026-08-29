import { describe, expect, it } from "vitest";

import {
  createCareTeamSummaryInsight,
  normalizeCareTeam,
} from "../src/care-team.js";
import {
  canonicalComparableJson,
  canonicalJson,
} from "../src/canonical-json.js";
import {
  InMemoryFhirHubRepository,
  StateBackedFhirHubRepository,
  createFhirHubIdentity,
  fhirContentHash,
  fhirHubResourceVersionSchema,
  fhirHubStateSchema,
  type FhirHubIdentity,
  type FhirHubState,
  type FhirHubStatePersistence,
} from "../src/fhir-hub.js";
import type { ConnectionRecord } from "../src/types.js";
import { makeConfig } from "./helpers.js";

const now = Date.parse("2026-08-25T12:00:00.000Z");
const policy = "hub-v1";
const retentionMs = 30 * 24 * 60 * 60 * 1_000;

function identity(character = "a"): FhirHubIdentity {
  return {
    accountRef: character.repeat(43),
    sourceConnectionId: "s".repeat(43),
    patientSubjectId: "p".repeat(43),
    fhirIssuer: "https://ehr.example.test/api/FHIR/R4",
  };
}

async function enabledHub(identityValue = identity()): Promise<InMemoryFhirHubRepository> {
  const hub = new InMemoryFhirHubRepository();
  await hub.initialize();
  await hub.enable(identityValue, {
    schemaVersion: 1,
    purpose: "longitudinal-health-hub",
    policyVersion: policy,
    acceptedAt: new Date(now).toISOString(),
    retentionMs,
  });
  return hub;
}

function careTeam(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceType: "CareTeam",
    id: "team-1",
    meta: {
      versionId: "3",
      lastUpdated: "2026-08-24T10:11:12.000Z",
    },
    status: "active",
    name: "Complex Care Team",
    category: [{ text: "Longitudinal care-coordination" }],
    participant: [{
      role: [{ coding: [{ code: "primary", display: "Primary clinician" }] }],
      member: { reference: "Practitioner/123", display: "Dr. Rivera" },
      extension: [{ url: "https://ehr.example.test/ext/scheduling", valueBoolean: true }],
    }],
    managingOrganization: [{ reference: "Organization/456", display: "Example Health" }],
    extension: [{ url: "https://ehr.example.test/ext/team-kind", valueString: "specialty" }],
    ...overrides,
  };
}

describe("FHIR hub", () => {
  it("uses canonical object ordering for source hashes", () => {
    expect(canonicalJson({ b: [2, { d: "x", c: true }], a: 1 }))
      .toBe('{"a":1,"b":[2,{"c":true,"d":"x"}]}');
    expect(canonicalComparableJson({ b: undefined, a: [undefined] }))
      .toBe('{"a":[undefined]}');
    expect(fhirContentHash({ b: 2, a: { d: 4, c: 3 } }))
      .toBe(fhirContentHash({ a: { c: 3, d: 4 }, b: 2 }));
    expect(fhirContentHash({ a: [1, 2] })).not.toBe(fhirContentHash({ a: [2, 1] }));

    const deeplyNested: Record<string, unknown> = {};
    let cursor = deeplyNested;
    for (let depth = 0; depth < 20_000; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expect(fhirContentHash(deeplyNested)).toMatch(/^sha256:[a-f0-9]{64}$/);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cycle/i);
  });

  it("derives stable provider-scoped identities without demographic matching", () => {
    const config = makeConfig({
      FHIR_HUB_ENABLED: "true",
      FHIR_HUB_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      FHIR_HUB_IDENTITY_KEY: Buffer.alloc(32, 2).toString("base64"),
    });
    const record: ConnectionRecord = {
      oauthClientId: config.clientId,
      tokenAuthMethod: config.tokenAuthMethod,
      fhirBaseUrl: config.fhirBaseUrl,
      tokenEndpoint: "https://ehr.example.test/token",
      accessToken: "access",
      tokenType: "Bearer",
      expiresAt: now + 60_000,
      scope: "patient/CareTeam.rs",
      patientId: "patient-1",
      oidcIssuer: "https://ehr.example.test/oauth2",
      oidcSubject: "account-1",
      connectedAt: now,
      sessionExpiresAt: now + 60_000,
    };
    const first = createFhirHubIdentity(config, record);
    const second = createFhirHubIdentity(config, { ...record, accessToken: "rotated" });
    const dependent = createFhirHubIdentity(config, { ...record, patientId: "patient-2" });
    expect(second).toEqual(first);
    expect(dependent.accountRef).toBe(first.accountRef);
    expect(dependent.sourceConnectionId).toBe(first.sourceConnectionId);
    expect(dependent.patientSubjectId).not.toBe(first.patientSubjectId);
    expect(JSON.stringify(first)).not.toContain("account-1");
    expect(JSON.stringify(first)).not.toContain("patient-1");
  });

  it("does not persist before explicit current-policy consent", async () => {
    const hub = new InMemoryFhirHubRepository();
    await hub.initialize();
    try {
      const result = await hub.ingest(identity(), careTeam(), policy, now);
      expect(result).toMatchObject({ accepted: false, versionsCreated: 0 });
      expect(await hub.list(identity())).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  it("stores and normalizes deeply nested ordinary extensions without recursive clone overflow", async () => {
    let nestedExtension: Record<string, unknown> = {
      url: "https://ehr.example.test/fhir/StructureDefinition/deep-leaf",
      valueString: "leaf",
    };
    for (let depth = 0; depth < 5_000; depth += 1) {
      nestedExtension = {
        url: `https://ehr.example.test/fhir/StructureDefinition/deep-${depth}`,
        extension: [nestedExtension],
      };
    }
    const hub = await enabledHub();
    try {
      const result = await hub.ingest(identity(), {
        resourceType: "Organization",
        id: "deep-extension-organization",
        name: "Deep extension organization",
        extension: [nestedExtension],
      }, policy, now + 1_000);
      expect(result).toMatchObject({
        versionsCreated: 1,
        projectionsCreated: 1,
        projectionFailures: 0,
      });
      expect((await hub.intelligence(identity())).projections[0]?.normalization)
        .toMatchObject({
          status: "normalized",
          projection: { headline: "Deep extension organization" },
        });
    } finally {
      await hub.close();
    }
  });

  it("stores individual bundle resources, raw extensions, normalized projections, and cited insights", async () => {
    const hub = await enabledHub();
    try {
      const result = await hub.ingest(identity(), {
        resourceType: "Bundle",
        type: "searchset",
        entry: [
          { resource: careTeam() },
          { resource: {
            resourceType: "Observation",
            id: "obs-1",
            status: "final",
            code: { text: "Status check" },
            valueString: "ok",
          } },
          { resource: { resourceType: "OperationOutcome", id: "ignored", issue: [] } },
        ],
      }, policy, now + 1_000);
      expect(result).toEqual({
        accepted: true,
        resourcesSeen: 3,
        versionsCreated: 2,
        currentResourcesUpdated: 2,
        projectionsCreated: 2,
        projectionFailures: 0,
      });

      const stored = await hub.list(identity(), { includeHistory: true });
      expect(stored).toHaveLength(2);
      const team = stored.find((version) => version.provenance.resourceType === "CareTeam");
      expect(team?.raw).toMatchObject({
        extension: [{ valueString: "specialty" }],
        participant: [{ extension: [{ valueBoolean: true }] }],
      });
      expect(team?.normalizedCareTeam).toMatchObject({
        name: "Complex Care Team",
        participants: [{ member: { display: "Dr. Rivera" } }],
      });
      expect(team?.provenance.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      const observation = stored.find((version) =>
        version.provenance.resourceType === "Observation");
      expect(observation?.normalization).toMatchObject({
        status: "normalized",
        projection: {
          resourceType: "Observation",
          headline: "Status check",
          facts: expect.arrayContaining([
            expect.objectContaining({ sourcePath: "Observation.valueString" }),
          ]),
        },
      });

      const exported = await hub.exportAccount(identity(), now + 2_000);
      expect(exported).toMatchObject({ schemaVersion: 1, intelligenceSchemaVersion: 1 });
      expect(exported.insights).toHaveLength(2);
      const careTeamInsight = exported.insights.find((insight) =>
        insight.insightType === "care-team-summary");
      expect(careTeamInsight).toMatchObject({
        insightType: "care-team-summary",
        status: "generated",
        sourceResourceVersions: [{ contentHash: team?.provenance.contentHash }],
      });
      expect(careTeamInsight?.insight).toContain("Dr. Rivera");
      expect(exported.insights.find((insight) =>
        insight.insightType === "observation-summary")?.insight).toContain("Status check");
      const intelligence = await hub.intelligence(identity(), {
        includeHistory: true,
        includeSuperseded: true,
      });
      expect(intelligence.schemaVersion).toBe(1);
      expect(intelligence.hasMore).toBe(false);
      expect(intelligence.projections).toHaveLength(2);
      expect(intelligence.insights).toHaveLength(2);
      expect(intelligence.projections.every((projection) =>
        projection.current && projection.normalization?.status === "normalized")).toBe(true);
      expect(intelligence.insights.map((insight) => insight.insightType).sort()).toEqual([
        "care-team-summary",
        "observation-summary",
      ]);
      expect(JSON.stringify(intelligence)).not.toContain('"raw"');
      expect(JSON.stringify(intelligence)).not.toContain("normalizedCareTeam");
    } finally {
      await hub.close();
    }
  });

  it("retains unsupported raw resources with a typed normalization failure", async () => {
    const hub = await enabledHub();
    try {
      const questionnaire = {
        resourceType: "Questionnaire",
        id: "questionnaire-1",
        status: "active",
        title: "Patient intake",
      };
      const result = await hub.ingest(identity(), questionnaire, policy, now + 1_000);
      expect(result).toMatchObject({
        accepted: true,
        versionsCreated: 1,
        currentResourcesUpdated: 1,
        projectionsCreated: 0,
        projectionFailures: 1,
      });
      const [stored] = await hub.list(identity());
      expect(stored).toMatchObject({
        raw: questionnaire,
        normalization: {
          schemaVersion: 1,
          status: "failed",
          code: "unsupported_resource_type",
        },
      });
      expect((await hub.intelligence(identity())).insights).toEqual([]);
      expect(await hub.status(identity(), policy, now + 2_000)).toMatchObject({
        normalizedResourceCount: 0,
        normalizationFailureCount: 1,
        insightCount: 0,
      });
    } finally {
      await hub.close();
    }
  });

  it("backfills legacy raw versions only after a new explicit consent receipt", async () => {
    const seed = await enabledHub();
    await seed.ingest(identity(), {
      resourceType: "Observation",
      id: "obs-legacy",
      status: "final",
      code: { text: "Legacy measurement" },
      valueString: "recorded",
    }, policy, now + 1_000);
    const [seededVersion] = await seed.list(identity(), { includeHistory: true });
    const seededExport = await seed.exportAccount(identity(), now + 2_000);
    await seed.close();
    const { normalization: _normalization, ...legacyVersion } = seededVersion!;
    let persisted: FhirHubState = fhirHubStateSchema.parse({
      schemaVersion: 1,
      profiles: {
        [identity().accountRef]: {
          identity: identity(),
          consent: seededExport.consent,
          updatedAt: seededExport.consent.acceptedAt,
        },
      },
      resourceVersions: { [legacyVersion.versionKey]: legacyVersion },
      currentResources: { [legacyVersion.currentKey]: legacyVersion.versionKey },
      insights: {},
    });
    const persistence: FhirHubStatePersistence = {
      durable: false,
      initialize: async () => undefined,
      load: async () => structuredClone(persisted),
      save: async (state) => { persisted = structuredClone(state); },
      checkReadiness: async () => undefined,
      close: async () => undefined,
    };
    const hub = new StateBackedFhirHubRepository(persistence);
    await hub.initialize();
    try {
      expect((await hub.list(identity()))[0]?.normalization).toBeUndefined();
      expect(await hub.intelligence(identity())).toMatchObject({
        projections: [],
        insights: [],
      });

      const renewedAt = now + 3_000;
      await hub.enable(identity(), {
        schemaVersion: 1,
        purpose: "longitudinal-health-hub",
        policyVersion: "hub-v2-all-resource-intelligence",
        acceptedAt: new Date(renewedAt).toISOString(),
        retentionMs,
      });
      expect((await hub.list(identity()))[0]?.normalization).toMatchObject({
        status: "normalized",
        projection: { resourceType: "Observation", resourceId: "obs-legacy" },
      });
      expect(await hub.intelligence(identity())).toMatchObject({
        projections: [{ normalization: { status: "normalized" } }],
        insights: [{ insightType: "observation-summary", status: "generated" }],
      });
    } finally {
      await hub.close();
    }
  });

  it("migrates current-code summary lifecycle gaps before validating persisted state", async () => {
    const normalizedSeed = await enabledHub();
    await normalizedSeed.ingest(identity(), {
      resourceType: "Observation",
      id: "observation-missing-summary",
      status: "final",
      code: { text: "Oxygen saturation" },
      valueQuantity: { value: 98, unit: "%" },
    }, policy, now + 1_000);
    const [normalizedVersion] = await normalizedSeed.list(identity(), { includeHistory: true });
    const normalizedExport = await normalizedSeed.exportAccount(identity(), now + 2_000);
    await normalizedSeed.close();

    const restored = fhirHubStateSchema.parse({
      schemaVersion: 1,
      profiles: {
        [identity().accountRef]: {
          identity: identity(),
          consent: normalizedExport.consent,
          updatedAt: normalizedExport.consent.acceptedAt,
        },
      },
      resourceVersions: { [normalizedVersion!.versionKey]: normalizedVersion },
      currentResources: { [normalizedVersion!.currentKey]: normalizedVersion!.versionKey },
      insights: {},
    });
    expect(Object.values(restored.insights)).toMatchObject([{
      insightType: "observation-summary",
      status: "generated",
    }]);

    const unsafeRaw = careTeam({
      note: [{
        text: "Legacy note",
        modifierExtension: [{
          url: "https://ehr.example.test/fhir/StructureDefinition/note-meaning",
          valueBoolean: true,
        }],
      }],
    });
    const failedSeed = await enabledHub();
    await failedSeed.ingest(identity(), unsafeRaw, policy, now + 3_000);
    const [failedVersion] = await failedSeed.list(identity(), { includeHistory: true });
    const failedExport = await failedSeed.exportAccount(identity(), now + 4_000);
    await failedSeed.close();
    const staleSummary = createCareTeamSummaryInsight(
      normalizeCareTeam(unsafeRaw, failedVersion!.provenance),
      failedVersion!.firstSeenAt,
    );
    const migrated = fhirHubStateSchema.parse({
      schemaVersion: 1,
      profiles: {
        [identity().accountRef]: {
          identity: identity(),
          consent: failedExport.consent,
          updatedAt: failedExport.consent.acceptedAt,
        },
      },
      resourceVersions: { [failedVersion!.versionKey]: failedVersion },
      currentResources: { [failedVersion!.currentKey]: failedVersion!.versionKey },
      insights: { [staleSummary.insightId]: staleSummary },
    });
    expect(migrated.insights[staleSummary.insightId]?.status).toBe("superseded");
  });

  it("supersedes a legacy CareTeam summary when consented backfill finds unsafe modifiers", async () => {
    const legacyRaw = careTeam({
      note: [{
        text: "Legacy note",
        modifierExtension: [{
          url: "https://ehr.example.test/fhir/StructureDefinition/note-meaning",
          valueBoolean: true,
        }],
      }],
    });
    const seed = await enabledHub();
    await seed.ingest(identity(), legacyRaw, policy, now + 1_000);
    const [failedVersion] = await seed.list(identity(), { includeHistory: true });
    const seededExport = await seed.exportAccount(identity(), now + 2_000);
    await seed.close();

    const legacyVersion = structuredClone(failedVersion!);
    delete legacyVersion.normalization;
    delete legacyVersion.projectionError;
    legacyVersion.normalizedCareTeam = normalizeCareTeam(
      legacyRaw,
      legacyVersion.provenance,
    );
    const legacyInsight = {
      ...createCareTeamSummaryInsight(
        legacyVersion.normalizedCareTeam,
        legacyVersion.firstSeenAt,
      ),
      status: "confirmed" as const,
      userConfirmation: {
        decision: "confirmed" as const,
        accountRef: identity().accountRef,
        recordedAt: new Date(now + 1_500).toISOString(),
      },
    };
    let persisted: FhirHubState = fhirHubStateSchema.parse({
      schemaVersion: 1,
      profiles: {
        [identity().accountRef]: {
          identity: identity(),
          consent: seededExport.consent,
          updatedAt: seededExport.consent.acceptedAt,
        },
      },
      resourceVersions: { [legacyVersion.versionKey]: legacyVersion },
      currentResources: { [legacyVersion.currentKey]: legacyVersion.versionKey },
      insights: { [legacyInsight.insightId]: legacyInsight },
    });
    const persistence: FhirHubStatePersistence = {
      durable: false,
      initialize: async () => undefined,
      load: async () => structuredClone(persisted),
      save: async (state) => { persisted = structuredClone(state); },
      checkReadiness: async () => undefined,
      close: async () => undefined,
    };
    const hub = new StateBackedFhirHubRepository(persistence);
    await hub.initialize();
    try {
      expect((await hub.intelligence(identity())).insights).toHaveLength(1);
      await hub.enable(identity(), {
        schemaVersion: 1,
        purpose: "longitudinal-health-hub",
        policyVersion: "hub-v2-all-resource-intelligence",
        acceptedAt: new Date(now + 3_000).toISOString(),
        retentionMs,
      });
      const current = (await hub.intelligence(identity())).projections[0];
      expect(current?.normalization).toMatchObject({
        status: "failed",
        code: "unsupported_modifier_semantics",
      });
      expect((await hub.intelligence(identity())).insights).toEqual([]);
      const superseded = (await hub.intelligence(identity(), {
        includeSuperseded: true,
      })).insights[0];
      expect(superseded).toMatchObject({
        insightId: legacyInsight.insightId,
        status: "superseded",
        userConfirmation: legacyInsight.userConfirmation,
      });
    } finally {
      await hub.close();
    }
  });

  it("clones ingested raw JSON so later caller mutation cannot alter immutable history", async () => {
    const hub = await enabledHub();
    try {
      const raw = careTeam();
      await hub.ingest(identity(), raw, policy, now + 1_000);
      ((raw.participant as Array<Record<string, unknown>>)[0]!.member as Record<string, unknown>).display =
        "Mutated after ingestion";

      const [stored] = await hub.list(identity());
      expect(stored?.raw).not.toEqual(raw);
      expect(stored?.raw).toMatchObject({
        participant: [{ member: { display: "Dr. Rivera" } }],
      });
      expect(() => fhirHubResourceVersionSchema.parse(stored)).not.toThrow();
      expect(() => fhirHubResourceVersionSchema.parse({
        ...stored,
        projectionError: "care_team_normalization_failed",
      })).toThrow(/exactly one projection/);
    } finally {
      await hub.close();
    }
  });

  it("keeps raw CareTeam data when projection validation fails", async () => {
    const hub = await enabledHub();
    try {
      const invalidProjection = careTeam({ status: "unknown-vendor-status" });
      const result = await hub.ingest(identity(), invalidProjection, policy, now + 1_000);
      expect(result).toMatchObject({
        versionsCreated: 1,
        projectionsCreated: 0,
        projectionFailures: 1,
      });
      const [stored] = await hub.list(identity());
      expect(stored?.raw).toEqual(invalidProjection);
      expect(stored?.projectionError).toBe("care_team_normalization_failed");
      expect(stored?.normalizedCareTeam).toBeUndefined();
    } finally {
      await hub.close();
    }
  });

  it("retains raw CareTeam modifier semantics without interpreting them", async () => {
    const hub = await enabledHub();
    try {
      const modified = careTeam({
        modifierExtension: [{
          url: "https://ehr.example.test/fhir/StructureDefinition/changes-meaning",
          valueBoolean: true,
        }],
      });
      const result = await hub.ingest(identity(), modified, policy, now + 1_000);
      expect(result).toMatchObject({
        versionsCreated: 1,
        projectionsCreated: 0,
        projectionFailures: 1,
      });
      const [stored] = await hub.list(identity());
      expect(stored?.raw).toEqual(modified);
      expect(stored?.normalizedCareTeam).toBeUndefined();
      expect((await hub.exportAccount(identity(), now + 2_000)).insights).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  it("supersedes the prior insight when a newer CareTeam cannot be projected", async () => {
    const hub = await enabledHub();
    try {
      await hub.ingest(identity(), careTeam(), policy, now + 1_000);
      const invalidProjection = careTeam({
        meta: { versionId: "4", lastUpdated: "2026-08-25T10:00:00.000Z" },
        status: "unknown-vendor-status",
      });
      const result = await hub.ingest(identity(), invalidProjection, policy, now + 2_000);
      expect(result).toMatchObject({
        versionsCreated: 1,
        currentResourcesUpdated: 1,
        projectionsCreated: 0,
        projectionFailures: 1,
      });
      expect((await hub.list(identity()))[0]?.raw).toEqual(invalidProjection);
      const exported = await hub.exportAccount(identity(), now + 3_000);
      expect(exported.insights).toHaveLength(1);
      expect(exported.insights[0]?.status).toBe("superseded");
      expect((await hub.status(identity(), policy, now + 3_000)).insightCount).toBe(0);
    } finally {
      await hub.close();
    }
  });

  it("keeps identical source JSON isolated between opaque accounts", async () => {
    const firstIdentity = identity("a");
    const secondIdentity = identity("b");
    const hub = await enabledHub(firstIdentity);
    try {
      await hub.enable(secondIdentity, {
        schemaVersion: 1,
        purpose: "longitudinal-health-hub",
        policyVersion: policy,
        acceptedAt: new Date(now).toISOString(),
        retentionMs,
      });
      await hub.ingest(firstIdentity, careTeam(), policy, now + 1_000);
      await hub.ingest(secondIdentity, careTeam(), policy, now + 1_000);
      const firstExport = await hub.exportAccount(firstIdentity, now + 2_000);
      const secondExport = await hub.exportAccount(secondIdentity, now + 2_000);
      expect(firstExport.resourceVersions).toHaveLength(1);
      expect(secondExport.resourceVersions).toHaveLength(1);
      expect(firstExport.insights).toHaveLength(1);
      expect(secondExport.insights).toHaveLength(1);
      expect(firstExport.insights[0]?.accountRef).toBe(firstIdentity.accountRef);
      expect(secondExport.insights[0]?.accountRef).toBe(secondIdentity.accountRef);
      expect(firstExport.insights[0]?.insightId).not.toBe(secondExport.insights[0]?.insightId);
      const firstIntelligence = await hub.intelligence(firstIdentity);
      const secondIntelligence = await hub.intelligence(secondIdentity);
      expect(firstIntelligence.projections).toHaveLength(1);
      expect(secondIntelligence.projections).toHaveLength(1);
      expect(firstIntelligence.projections[0]?.provenance.accountRef).toBe(firstIdentity.accountRef);
      expect(secondIntelligence.projections[0]?.provenance.accountRef).toBe(secondIdentity.accountRef);
      expect(firstIntelligence.insights[0]?.accountRef).toBe(firstIdentity.accountRef);
      expect(secondIntelligence.insights[0]?.accountRef).toBe(secondIdentity.accountRef);
    } finally {
      await hub.close();
    }
  });

  it("keeps intelligence isolated by source connection and patient within one account", async () => {
    const firstIdentity = identity();
    const secondIdentity: FhirHubIdentity = {
      ...firstIdentity,
      sourceConnectionId: "t".repeat(43),
      patientSubjectId: "q".repeat(43),
      fhirIssuer: "https://second-ehr.example.test/fhir/R4",
    };
    const hub = await enabledHub(firstIdentity);
    try {
      await hub.ingest(firstIdentity, careTeam({ name: "First source team" }), policy, now + 1_000);
      await hub.enable(secondIdentity, {
        schemaVersion: 1,
        purpose: "longitudinal-health-hub",
        policyVersion: policy,
        acceptedAt: new Date(now + 2_000).toISOString(),
        retentionMs,
      });
      await hub.ingest(secondIdentity, careTeam({ name: "Second source team" }), policy, now + 3_000);

      const first = await hub.intelligence(firstIdentity);
      const second = await hub.intelligence(secondIdentity);
      expect(first.projections).toHaveLength(1);
      expect(second.projections).toHaveLength(1);
      expect(first.projections[0]?.normalization).toMatchObject({
        projection: { headline: "First source team" },
      });
      expect(second.projections[0]?.normalization).toMatchObject({
        projection: { headline: "Second source team" },
      });
      expect(first.projections[0]?.provenance.sourceConnectionId)
        .toBe(firstIdentity.sourceConnectionId);
      expect(second.projections[0]?.provenance.patientSubjectId)
        .toBe(secondIdentity.patientSubjectId);
    } finally {
      await hub.close();
    }
  });

  it("deduplicates identical JSON and preserves immutable history when content changes", async () => {
    const hub = await enabledHub();
    try {
      await hub.ingest(identity(), careTeam(), policy, now + 1_000);
      const duplicate = await hub.ingest(identity(), careTeam(), policy, now + 2_000);
      expect(duplicate).toMatchObject({ versionsCreated: 0, currentResourcesUpdated: 0 });
      await hub.ingest(identity(), careTeam({
        meta: { versionId: "4", lastUpdated: "2026-08-25T10:00:00.000Z" },
        name: "Updated Care Team",
      }), policy, now + 3_000);

      expect(await hub.list(identity())).toHaveLength(1);
      expect((await hub.list(identity()))[0]?.raw).toMatchObject({ name: "Updated Care Team" });
      expect(await hub.list(identity(), { includeHistory: true })).toHaveLength(2);
      const exported = await hub.exportAccount(identity(), now + 4_000);
      expect(exported.insights).toHaveLength(2);
      expect(exported.insights.map((insight) => insight.status).sort())
        .toEqual(["generated", "superseded"]);
    } finally {
      await hub.close();
    }
  });

  it("supersedes every insight for an old source version and links only the same type", async () => {
    const seed = await enabledHub();
    await seed.ingest(identity(), careTeam(), policy, now + 1_000);
    const [version] = await seed.list(identity(), { includeHistory: true });
    const seedExport = await seed.exportAccount(identity(), now + 2_000);
    const rulesInsight = seedExport.insights[0]!;
    await seed.close();

    const modelInsight = {
      ...rulesInsight,
      insightId: "model-care-team-context-v1",
      insightType: "care-team-context",
      insight: "A separate model-derived artifact.",
      generator: {
        kind: "model" as const,
        provider: "approved-provider",
        model: "approved-model",
        modelVersion: "model-v1",
        promptVersion: "prompt-v1",
      },
    };
    let persisted: FhirHubState = fhirHubStateSchema.parse({
      schemaVersion: 1,
      profiles: {
        [identity().accountRef]: {
          identity: identity(),
          consent: seedExport.consent,
          updatedAt: seedExport.consent.acceptedAt,
        },
      },
      resourceVersions: { [version!.versionKey]: version },
      currentResources: { [version!.currentKey]: version!.versionKey },
      insights: {
        [rulesInsight.insightId]: rulesInsight,
        [modelInsight.insightId]: modelInsight,
      },
    });
    const persistence: FhirHubStatePersistence = {
      durable: false,
      initialize: async () => undefined,
      load: async () => structuredClone(persisted),
      save: async (state) => { persisted = structuredClone(state); },
      checkReadiness: async () => undefined,
      close: async () => undefined,
    };
    const hub = new StateBackedFhirHubRepository(persistence);
    await hub.initialize();
    try {
      await hub.ingest(identity(), careTeam({
        meta: { versionId: "4", lastUpdated: "2026-08-25T10:00:00.000Z" },
        name: "Updated Care Team",
      }), policy, now + 3_000);
      const insights = (await hub.exportAccount(identity(), now + 4_000)).insights;
      expect(insights.filter((insight) => insight.status === "superseded")).toHaveLength(2);
      const generated = insights.find((insight) => insight.status === "generated")!;
      expect(generated.insightType).toBe("care-team-summary");
      expect(generated.supersedesInsightId).toBe(rulesInsight.insightId);
      expect(generated.supersedesInsightId).not.toBe(modelInsight.insightId);
    } finally {
      await hub.close();
    }
  });

  it("reactivates a multi-source insight only when every cited version is current", async () => {
    const careTeamOne = careTeam();
    delete careTeamOne.meta;
    const observationOne = {
      resourceType: "Observation",
      id: "obs-1",
      status: "final",
      code: { text: "Test observation" },
      valueString: "first",
    };
    const seed = await enabledHub();
    await seed.ingest(identity(), {
      resourceType: "Bundle",
      entry: [
        { resource: careTeamOne },
        { resource: observationOne },
      ],
    }, policy, now + 1_000);
    const versions = await seed.list(identity(), { includeHistory: true });
    const teamVersion = versions.find((version) => version.provenance.resourceType === "CareTeam")!;
    const observationVersion = versions.find((version) => version.provenance.resourceType === "Observation")!;
    const seedExport = await seed.exportAccount(identity(), now + 2_000);
    const rulesInsight = seedExport.insights[0]!;
    await seed.close();

    const multiSourceInsight = {
      ...rulesInsight,
      insightId: "multi-source-care-context-v1",
      insightType: "multi-source-care-context",
      insight: "Derived from the care team and an observation.",
      sourceResourceVersions: [teamVersion.provenance, observationVersion.provenance],
      generator: {
        kind: "model" as const,
        provider: "approved-provider",
        model: "approved-model",
        modelVersion: "model-v1",
        promptVersion: "prompt-v1",
      },
    };
    let persisted: FhirHubState = fhirHubStateSchema.parse({
      schemaVersion: 1,
      profiles: {
        [identity().accountRef]: {
          identity: identity(),
          consent: seedExport.consent,
          updatedAt: seedExport.consent.acceptedAt,
        },
      },
      resourceVersions: Object.fromEntries(versions.map((version) => [version.versionKey, version])),
      currentResources: Object.fromEntries(versions.map((version) => [version.currentKey, version.versionKey])),
      insights: {
        [rulesInsight.insightId]: rulesInsight,
        [multiSourceInsight.insightId]: multiSourceInsight,
      },
    });
    const persistence: FhirHubStatePersistence = {
      durable: false,
      initialize: async () => undefined,
      load: async () => structuredClone(persisted),
      save: async (state) => { persisted = structuredClone(state); },
      checkReadiness: async () => undefined,
      close: async () => undefined,
    };
    const hub = new StateBackedFhirHubRepository(persistence);
    await hub.initialize();
    try {
      const observationTwo = { ...observationOne, valueString: "second" };
      const careTeamTwo = { ...careTeamOne, name: "Second Care Team View" };
      await hub.ingest(identity(), observationTwo, policy, now + 3_000);
      await hub.ingest(identity(), careTeamTwo, policy, now + 4_000);
      await hub.ingest(identity(), careTeamOne, policy, now + 5_000);
      let insight = (await hub.exportAccount(identity(), now + 6_000)).insights
        .find((candidate) => candidate.insightId === multiSourceInsight.insightId);
      expect(insight?.status).toBe("superseded");

      await hub.ingest(identity(), observationOne, policy, now + 7_000);
      insight = (await hub.exportAccount(identity(), now + 8_000)).insights
        .find((candidate) => candidate.insightId === multiSourceInsight.insightId);
      expect(insight?.status).toBe("generated");
    } finally {
      await hub.close();
    }
  });

  it("keeps the newer FHIR version current when older content arrives late", async () => {
    const hub = await enabledHub();
    try {
      const original = careTeam();
      const updated = careTeam({
        meta: { versionId: "4", lastUpdated: "2026-08-25T10:00:00.000Z" },
        name: "Updated Care Team",
      });
      await hub.ingest(identity(), original, policy, now + 1_000);
      await hub.ingest(identity(), updated, policy, now + 2_000);
      const returned = await hub.ingest(identity(), original, policy, now + 3_000);
      expect(returned).toMatchObject({ versionsCreated: 0, currentResourcesUpdated: 0 });
      expect((await hub.list(identity()))[0]?.raw).toEqual(updated);
      const insights = (await hub.exportAccount(identity(), now + 4_000)).insights;
      const originalHash = fhirContentHash(original);
      expect(insights.find((insight) =>
        insight.sourceResourceVersions[0]?.contentHash === originalHash)?.status).toBe("superseded");
      expect(insights.filter((insight) => insight.status === "superseded")).toHaveLength(1);
    } finally {
      await hub.close();
    }
  });

  it("reactivates the best retained insight when the current version expires first", async () => {
    const hub = await enabledHub();
    try {
      const original = careTeam();
      const updated = careTeam({
        meta: { versionId: "4", lastUpdated: "2026-08-25T10:00:00.000Z" },
        name: "Updated Care Team",
      });
      await hub.ingest(identity(), original, policy, now + 1_000);
      await hub.ingest(identity(), updated, policy, now + 2_000);
      await hub.ingest(identity(), original, policy, now + 3_000);

      expect(await hub.pruneExpired(now + 2_000 + retentionMs)).toBe(1);
      expect((await hub.list(identity()))[0]?.raw).toEqual(original);
      const exported = await hub.exportAccount(identity(), now + 2_000 + retentionMs);
      expect(exported.resourceVersions).toHaveLength(1);
      expect(exported.insights).toHaveLength(1);
      expect(exported.insights[0]?.status).toBe("generated");
      expect(exported.insights[0]?.sourceResourceVersions[0]?.contentHash)
        .toBe(fhirContentHash(original));
    } finally {
      await hub.close();
    }
  });

  it("reactivates a known cited insight when undated source content returns", async () => {
    const hub = await enabledHub();
    try {
      const original = careTeam();
      delete original.meta;
      const updated = { ...original, name: "Updated Care Team" };
      await hub.ingest(identity(), original, policy, now + 1_000);
      await hub.ingest(identity(), updated, policy, now + 2_000);
      const returned = await hub.ingest(identity(), original, policy, now + 3_000);
      expect(returned).toMatchObject({ versionsCreated: 0, currentResourcesUpdated: 1 });
      expect((await hub.list(identity()))[0]?.raw).toEqual(original);
      const insights = (await hub.exportAccount(identity(), now + 4_000)).insights;
      const originalHash = fhirContentHash(original);
      expect(insights.find((insight) =>
        insight.sourceResourceVersions[0]?.contentHash === originalHash)?.status).toBe("generated");
      expect(insights.filter((insight) => insight.status === "superseded")).toHaveLength(1);
    } finally {
      await hub.close();
    }
  });

  it("stops ingestion after a policy change while preserving export and deletion control", async () => {
    const hub = await enabledHub();
    try {
      await hub.ingest(identity(), careTeam(), policy, now + 1_000);
      const stale = await hub.ingest(
        identity(),
        { resourceType: "Observation", id: "obs-2", status: "final" },
        "hub-v2",
        now + 2_000,
      );
      expect(stale.accepted).toBe(false);
      expect(await hub.status(identity(), "hub-v2", now + 3_000)).toMatchObject({
        enabled: true,
        consentCurrent: false,
        currentResourceCount: 1,
      });
      expect((await hub.exportAccount(identity(), now + 3_000)).resourceVersions).toHaveLength(1);
      await expect(hub.deleteAccount(identity())).resolves.toEqual({
        deleted: true,
        resourcesDeleted: 1,
      });
      expect(await hub.list(identity(), { includeHistory: true })).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  it("prunes resource versions and their derived insights at the receipt retention boundary", async () => {
    const hub = await enabledHub();
    try {
      await hub.ingest(identity(), careTeam(), policy, now + 1_000);
      expect(await hub.pruneExpired(now + 1_000 + retentionMs - 1)).toBe(0);
      expect(await hub.pruneExpired(now + 1_000 + retentionMs)).toBe(1);
      expect(await hub.list(identity(), { includeHistory: true })).toEqual([]);
      expect((await hub.exportAccount(identity(), now + 1_000 + retentionMs)).insights).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  it("applies a newly accepted shorter retention period to existing versions", async () => {
    const hub = await enabledHub();
    try {
      await hub.ingest(identity(), careTeam(), policy, now + 1_000);
      const renewedAt = now + 2_000;
      await hub.enable(identity(), {
        schemaVersion: 1,
        purpose: "longitudinal-health-hub",
        policyVersion: "hub-v2",
        acceptedAt: new Date(renewedAt).toISOString(),
        retentionMs: 24 * 60 * 60 * 1_000,
      });
      const [version] = await hub.list(identity());
      expect(version?.expiresAt).toBe(new Date(renewedAt + 24 * 60 * 60 * 1_000).toISOString());
      expect(await hub.pruneExpired(renewedAt + 24 * 60 * 60 * 1_000)).toBe(1);
    } finally {
      await hub.close();
    }
  });

  it("does not reactivate a legacy summary when expiry fallback selects a failed projection", async () => {
    const unsafe = careTeam({
      meta: { versionId: "3", lastUpdated: "2026-08-24T10:11:12.000Z" },
      note: [{
        text: "Legacy note",
        modifierExtension: [{
          url: "https://ehr.example.test/fhir/StructureDefinition/note-meaning",
          valueBoolean: true,
        }],
      }],
    });
    const safe = careTeam({
      meta: { versionId: "4", lastUpdated: "2026-08-25T10:11:12.000Z" },
      name: "Newer safe team",
    });
    const seed = await enabledHub();
    await seed.ingest(identity(), unsafe, policy, now + 1_000);
    await seed.ingest(identity(), safe, policy, now + 2_000);
    await seed.ingest(identity(), unsafe, policy, now + 3_000);
    const versions = await seed.list(identity(), { includeHistory: true });
    const unsafeVersion = versions.find((candidate) =>
      candidate.provenance.contentHash === fhirContentHash(unsafe))!;
    const safeVersion = versions.find((candidate) =>
      candidate.provenance.contentHash === fhirContentHash(safe))!;
    const exported = await seed.exportAccount(identity(), now + 4_000);
    await seed.close();

    expect(unsafeVersion.normalization?.status).toBe("failed");
    const legacySummary = {
      ...createCareTeamSummaryInsight(
        normalizeCareTeam(unsafe, unsafeVersion.provenance),
        unsafeVersion.firstSeenAt,
      ),
      status: "superseded" as const,
    };
    let persisted = fhirHubStateSchema.parse({
      schemaVersion: 1,
      profiles: {
        [identity().accountRef]: {
          identity: identity(),
          consent: exported.consent,
          updatedAt: exported.consent.acceptedAt,
        },
      },
      resourceVersions: Object.fromEntries(versions.map((version) => [version.versionKey, version])),
      currentResources: { [safeVersion.currentKey]: safeVersion.versionKey },
      insights: {
        ...Object.fromEntries(exported.insights.map((insight) => [insight.insightId, insight])),
        [legacySummary.insightId]: legacySummary,
      },
    });
    const persistence: FhirHubStatePersistence = {
      durable: false,
      initialize: async () => undefined,
      load: async () => structuredClone(persisted),
      save: async (state) => { persisted = structuredClone(state); },
      checkReadiness: async () => undefined,
      close: async () => undefined,
    };
    const hub = new StateBackedFhirHubRepository(persistence);
    await hub.initialize();
    try {
      await hub.pruneExpired(Date.parse(safeVersion.expiresAt));
      const current = await hub.list(identity());
      expect(current).toHaveLength(1);
      expect(current[0]?.versionKey).toBe(unsafeVersion.versionKey);
      expect((await hub.intelligence(identity())).insights).toEqual([]);
      expect((await hub.intelligence(identity(), {
        includeSuperseded: true,
      })).insights).toMatchObject([{ status: "superseded" }]);
    } finally {
      await hub.close();
    }
  });

  it("prunes expired history before renewed consent can extend it", async () => {
    const hub = await enabledHub();
    try {
      await hub.ingest(identity(), careTeam(), policy, now + 1_000);
      const renewedAt = now + 1_000 + retentionMs;
      await hub.enable(identity(), {
        schemaVersion: 1,
        purpose: "longitudinal-health-hub",
        policyVersion: "hub-v2",
        acceptedAt: new Date(renewedAt).toISOString(),
        retentionMs,
      });
      expect(await hub.list(identity(), { includeHistory: true })).toEqual([]);
      expect((await hub.status(identity(), "hub-v2", renewedAt)).resourceVersionCount).toBe(0);
    } finally {
      await hub.close();
    }
  });

  it("treats identical content retrieved after expiry as a newly observed version", async () => {
    const hub = await enabledHub();
    try {
      const raw = careTeam();
      await hub.ingest(identity(), raw, policy, now + 1_000);
      const retrievedAgainAt = now + 1_000 + retentionMs;
      const result = await hub.ingest(identity(), raw, policy, retrievedAgainAt);
      expect(result).toMatchObject({ versionsCreated: 1, currentResourcesUpdated: 1 });
      const [stored] = await hub.list(identity(), { includeHistory: true });
      expect(stored?.firstSeenAt).toBe(new Date(retrievedAgainAt).toISOString());
    } finally {
      await hub.close();
    }
  });

  it("rejects insight citations whose lineage metadata differs from the stored version", async () => {
    const hub = await enabledHub();
    try {
      await hub.ingest(identity(), careTeam(), policy, now + 1_000);
      const [version] = await hub.list(identity(), { includeHistory: true });
      const exported = await hub.exportAccount(identity(), now + 2_000);
      const insight = exported.insights[0]!;
      const tamperedInsight = {
        ...insight,
        sourceResourceVersions: [{
          ...insight.sourceResourceVersions[0]!,
          retrievedAt: new Date(now + 500).toISOString(),
        }],
      };
      expect(() => fhirHubStateSchema.parse({
        schemaVersion: 1,
        profiles: {
          [identity().accountRef]: {
            identity: identity(),
            consent: exported.consent,
            updatedAt: exported.consent.acceptedAt,
          },
        },
        resourceVersions: { [version!.versionKey]: version },
        currentResources: { [version!.currentKey]: version!.versionKey },
        insights: { [insight.insightId]: tamperedInsight },
      })).toThrow(/citation/);
    } finally {
      await hub.close();
    }
  });

  it("rejects deterministic summary content that no longer matches its cited source", async () => {
    const hub = await enabledHub();
    try {
      await hub.ingest(identity(), {
        resourceType: "Observation",
        id: "observation-summary-integrity",
        status: "final",
        code: { text: "Pulse" },
        valueQuantity: { value: 72, unit: "beats/min" },
      }, policy, now + 1_000);
      const [version] = await hub.list(identity(), { includeHistory: true });
      const exported = await hub.exportAccount(identity(), now + 2_000);
      const insight = exported.insights[0]!;
      const tampered = { ...insight, insight: "Invented deterministic summary." };

      expect(() => fhirHubStateSchema.parse({
        schemaVersion: 1,
        profiles: {
          [identity().accountRef]: {
            identity: identity(),
            consent: exported.consent,
            updatedAt: exported.consent.acceptedAt,
          },
        },
        resourceVersions: { [version!.versionKey]: version },
        currentResources: { [version!.currentKey]: version!.versionKey },
        insights: { [insight.insightId]: tampered },
      })).toThrow(/deterministic insight/i);
    } finally {
      await hub.close();
    }
  });

  it("field-picks the intelligence response even when migrated passthrough fields contain raw data", async () => {
    const seed = await enabledHub();
    await seed.ingest(identity(), {
      resourceType: "Observation",
      id: "observation-raw-free-boundary",
      status: "final",
      code: { text: "Respiratory rate" },
      valueQuantity: { value: 16, unit: "breaths/min" },
    }, policy, now + 1_000);
    const [seededVersion] = await seed.list(identity(), { includeHistory: true });
    const seededExport = await seed.exportAccount(identity(), now + 2_000);
    await seed.close();

    const sentinel = "SECRET_RAW_PASSTHROUGH_SENTINEL";
    const version = structuredClone(seededVersion!);
    (version.provenance as Record<string, unknown>).raw = sentinel;
    if (version.normalization?.status !== "normalized") {
      throw new Error("Expected a normalized seed version.");
    }
    (version.normalization.projection.provenance as Record<string, unknown>).raw = sentinel;
    const deterministicInsight = structuredClone(seededExport.insights[0]!);
    (deterministicInsight as unknown as Record<string, unknown>).raw = sentinel;
    (deterministicInsight.sourceResourceVersions[0] as Record<string, unknown>).raw = sentinel;
    const modelInsight = {
      ...deterministicInsight,
      insightId: "model-raw-free-boundary-v1",
      insightType: "model-raw-free-boundary",
      insight: "Model output with an intentionally poisoned persisted envelope.",
      generator: {
        kind: "model" as const,
        provider: "approved-provider",
        model: "approved-model",
        modelVersion: "model-v1",
        promptVersion: "prompt-v1",
        raw: sentinel,
      },
    };
    const initialState = fhirHubStateSchema.parse({
      schemaVersion: 1,
      profiles: {
        [identity().accountRef]: {
          identity: identity(),
          consent: seededExport.consent,
          updatedAt: seededExport.consent.acceptedAt,
        },
      },
      resourceVersions: { [version.versionKey]: version },
      currentResources: { [version.currentKey]: version.versionKey },
      insights: {
        [deterministicInsight.insightId]: deterministicInsight,
        [modelInsight.insightId]: modelInsight,
      },
    });
    expect(JSON.stringify(initialState)).toContain(sentinel);
    let persisted = structuredClone(initialState);
    const persistence: FhirHubStatePersistence = {
      durable: false,
      initialize: async () => undefined,
      load: async () => structuredClone(persisted),
      save: async (state) => { persisted = structuredClone(state); },
      checkReadiness: async () => undefined,
      close: async () => undefined,
    };
    const hub = new StateBackedFhirHubRepository(persistence);
    await hub.initialize();
    try {
      const intelligence = await hub.intelligence(identity(), {
        includeHistory: true,
        includeSuperseded: true,
      });
      const serialized = JSON.stringify(intelligence);
      expect(intelligence.insights).toHaveLength(2);
      expect(serialized).not.toContain(sentinel);
      expect(serialized).not.toContain('"raw"');
    } finally {
      await hub.close();
    }
  });

  it("rejects inconsistent observation and retention timestamps in persisted state", async () => {
    const hub = await enabledHub();
    try {
      await hub.ingest(identity(), {
        resourceType: "Observation",
        id: "observation-retention-integrity",
        status: "final",
        code: { text: "Temperature" },
        valueQuantity: { value: 98.6, unit: "degF" },
      }, policy, now + 1_000);
      const [version] = await hub.list(identity(), { includeHistory: true });
      const exported = await hub.exportAccount(identity(), now + 2_000);
      const baseState: FhirHubState = {
        schemaVersion: 1,
        profiles: {
          [identity().accountRef]: {
            identity: identity(),
            consent: exported.consent,
            updatedAt: exported.consent.acceptedAt,
          },
        },
        resourceVersions: { [version!.versionKey]: version! },
        currentResources: { [version!.currentKey]: version!.versionKey },
        insights: Object.fromEntries(exported.insights.map((insight) => [insight.insightId, insight])),
      };

      const firstSeenTamper = structuredClone(baseState);
      firstSeenTamper.resourceVersions[version!.versionKey]!.firstSeenAt =
        new Date(now + 500).toISOString();
      expect(() => fhirHubStateSchema.parse(firstSeenTamper)).toThrow(/first-seen/i);

      const lastSeenTamper = structuredClone(baseState);
      lastSeenTamper.resourceVersions[version!.versionKey]!.lastSeenAt =
        new Date(now).toISOString();
      expect(() => fhirHubStateSchema.parse(lastSeenTamper)).toThrow(/last-seen/i);

      const expiryTamper = structuredClone(baseState);
      expiryTamper.resourceVersions[version!.versionKey]!.expiresAt =
        new Date(Date.parse(version!.expiresAt) + 1).toISOString();
      expect(() => fhirHubStateSchema.parse(expiryTamper)).toThrow(/retention window/i);

      const profileTamper = structuredClone(baseState);
      profileTamper.profiles[identity().accountRef]!.updatedAt =
        new Date(now + 1).toISOString();
      expect(() => fhirHubStateSchema.parse(profileTamper)).toThrow(/consent receipt/i);
    } finally {
      await hub.close();
    }
  });
});
