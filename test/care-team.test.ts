import { describe, expect, it } from "vitest";

import {
  createCareTeamSummaryInsight,
  insightRecordSchema,
  normalizeCareTeam,
  parseCareTeamResource,
  parseInsightRecord,
  parseNormalizedCareTeam,
  parseSourceResourceVersionRef,
  sourceResourceVersionRefSchema,
  type SourceResourceVersionRef,
} from "../src/care-team.js";
import { fhirContentHash } from "../src/fhir-hub.js";

const retrievedAt = "2025-03-01T12:30:00.000Z";
const lastUpdated = "2025-02-28T10:00:00Z";
const contentHash = fhirContentHash(fullCareTeam());

function makeProvenance(
  overrides: Partial<SourceResourceVersionRef> = {},
): SourceResourceVersionRef {
  return {
    accountRef: "account-1",
    sourceConnectionId: "epic-connection-1",
    patientSubjectId: "subject-1",
    fhirIssuer: "https://ehr.example.test/api/FHIR/R4",
    resourceType: "CareTeam",
    resourceId: "care-team-1",
    versionId: "version-7",
    lastUpdated,
    retrievedAt,
    contentHash,
    ...overrides,
  };
}

function fullCareTeam(): Record<string, unknown> {
  return {
    resourceType: "CareTeam",
    id: "care-team-1",
    meta: {
      versionId: "version-7",
      lastUpdated,
      sourceSpecificMeta: { retained: true },
    },
    identifier: [{
      system: "https://ehr.example.test/care-team-id",
      value: "TEAM-42",
      sourceSpecificIdentifier: "kept",
    }],
    status: "active",
    category: [{
      coding: [{
        system: "https://example.test/team-category",
        code: "primary",
        display: "Primary care coding display",
        sourceSpecificCoding: 42,
      }],
      text: "Primary care",
      sourceSpecificCategory: ["kept"],
    }],
    name: "Neighborhood Care Team",
    subject: {
      reference: "Patient/patient-1",
      display: "Pat Example",
      sourceSpecificReference: true,
    },
    encounter: { reference: "Encounter/encounter-9" },
    period: { start: "2025-01-01", end: "2025-12-31" },
    participant: [
      {
        role: [{ text: "Primary care physician" }],
        member: {
          reference: "Practitioner/practitioner-1",
          display: "Dr Ada Example",
          sourceSpecificMember: "kept",
        },
        onBehalfOf: { reference: "Organization/org-1", display: "Example Clinic" },
        period: { start: "2025-01-15" },
        sourceSpecificParticipant: { retained: true },
      },
      {
        role: [{ coding: [{ code: "caregiver" }] }],
        member: { reference: "RelatedPerson/related-1" },
      },
    ],
    reasonCode: [{ text: "Longitudinal care coordination" }],
    reasonReference: [{ reference: "Condition/condition-1", display: "Complex care needs" }],
    managingOrganization: [{ reference: "Organization/org-1", display: "Example Clinic" }],
    telecom: [{ system: "phone", value: "555-0100", use: "work" }],
    note: [{ text: "Call the clinic before an urgent visit.", sourceSpecificNote: true }],
    sourceSpecificRoot: {
      nested: ["raw", "FHIR", "is", "retained"],
    },
  };
}

describe("CareTeam raw resource schema", () => {
  it("validates known R4 fields without stripping source-specific JSON", () => {
    const parsed = parseCareTeamResource(fullCareTeam());

    expect(parsed.sourceSpecificRoot).toEqual({
      nested: ["raw", "FHIR", "is", "retained"],
    });
    expect(parsed.meta?.sourceSpecificMeta).toEqual({ retained: true });
    expect(parsed.category?.[0]?.sourceSpecificCategory).toEqual(["kept"]);
    expect(parsed.category?.[0]?.coding?.[0]?.sourceSpecificCoding).toBe(42);
    expect(parsed.participant?.[0]?.sourceSpecificParticipant).toEqual({ retained: true });
    expect(parsed.participant?.[0]?.member?.sourceSpecificMember).toBe("kept");
    expect(parsed.note?.[0]?.sourceSpecificNote).toBe(true);
  });

  it.each([
    [{ resourceType: "Observation", id: "care-team-1", status: "active" }],
    [{ resourceType: "CareTeam", id: "bad/id", status: "active" }],
    [{ resourceType: "CareTeam", id: "care-team-1", status: "draft" }],
    [{ resourceType: "CareTeam", id: "care-team-1", status: "unknown" }],
  ])("rejects an invalid retrieved CareTeam: %j", (raw) => {
    expect(() => parseCareTeamResource(raw)).toThrow();
  });

  it.each([
    { resourceType: "CareTeam", id: "care-team-1" },
    { resourceType: "CareTeam", id: "care-team-1", status: "proposed" },
  ])("accepts the R4 optional/proposed status shape: %j", (raw) => {
    expect(parseCareTeamResource(raw)).toMatchObject(raw);
  });
});

describe("CareTeam source provenance", () => {
  it("requires a content-addressed version citation and preserves future metadata", () => {
    const parsed = parseSourceResourceVersionRef({
      ...makeProvenance(),
      retentionClass: "patient-controlled",
    });

    expect(parsed.contentHash).toBe(contentHash);
    expect(parsed.retentionClass).toBe("patient-controlled");
  });

  it.each([
    { contentHash: "sha256:not-a-hash" },
    { contentHash: `sha256:${"A".repeat(64)}` },
    { retrievedAt: "March 1, 2025" },
    { resourceId: "CareTeam/one" },
    { accountRef: "bad\naccount" },
  ])("rejects invalid provenance fields: %j", (override) => {
    expect(() => sourceResourceVersionRefSchema.parse(makeProvenance(override))).toThrow();
  });

  it("does not allow the required content hash to be omitted", () => {
    const { contentHash: _omitted, ...withoutHash } = makeProvenance();
    expect(() => parseSourceResourceVersionRef(withoutHash)).toThrow();
  });
});

describe("CareTeam normalization", () => {
  it("creates an explicit projection, retains raw JSON, and leaves the input untouched", () => {
    const raw = fullCareTeam();
    const before = structuredClone(raw);
    const normalized = normalizeCareTeam(raw, makeProvenance());

    expect(normalized).toMatchObject({
      accountRef: "account-1",
      sourceConnectionId: "epic-connection-1",
      patientSubjectId: "subject-1",
      resourceType: "CareTeam",
      resourceId: "care-team-1",
      status: "active",
      name: "Neighborhood Care Team",
    });
    expect(normalized.categories).toEqual((raw.category as unknown[]));
    expect(normalized.participants).toHaveLength(2);
    expect(normalized.participants[0]).toMatchObject({
      roles: [{ text: "Primary care physician" }],
      member: { reference: "Practitioner/practitioner-1", display: "Dr Ada Example" },
      onBehalfOf: { reference: "Organization/org-1", display: "Example Clinic" },
      period: { start: "2025-01-15" },
    });
    expect(normalized.participants[0]?.raw.sourceSpecificParticipant).toEqual({ retained: true });
    expect(normalized.raw.sourceSpecificRoot).toEqual(before.sourceSpecificRoot);
    expect(raw).toEqual(before);
  });

  it("uses empty collections for absent repeatable fields without inventing optional values", () => {
    const raw = { resourceType: "CareTeam", id: "care-team-2", status: "inactive" };
    const normalized = normalizeCareTeam(
      raw,
      makeProvenance({
        resourceId: "care-team-2",
        versionId: undefined,
        lastUpdated: undefined,
        contentHash: fhirContentHash(raw),
      }),
    );

    expect(normalized.identifiers).toEqual([]);
    expect(normalized.categories).toEqual([]);
    expect(normalized.participants).toEqual([]);
    expect(normalized.reasonCodes).toEqual([]);
    expect(normalized.reasonReferences).toEqual([]);
    expect(normalized.managingOrganizations).toEqual([]);
    expect(normalized.telecom).toEqual([]);
    expect(normalized.notes).toEqual([]);
    expect("name" in normalized).toBe(false);
    expect("subject" in normalized).toBe(false);
    expect("period" in normalized).toBe(false);
  });

  it.each([
    [makeProvenance({ resourceType: "Observation" }), /Resource type/],
    [makeProvenance({ resourceId: "another-team" }), /Resource ID/],
    [makeProvenance({ versionId: "version-8" }), /version ID/],
    [makeProvenance({ versionId: undefined }), /version ID/],
    [makeProvenance({ lastUpdated: "2025-02-27T10:00:00Z" }), /Last-updated/],
    [makeProvenance({ lastUpdated: undefined }), /Last-updated/],
  ])("rejects provenance that is not the exact raw resource version", (provenance, message) => {
    expect(() => normalizeCareTeam(fullCareTeam(), provenance)).toThrow(message);
  });

  it("rejects cross-account or cross-patient normalized records during later reads", () => {
    const normalized = normalizeCareTeam(fullCareTeam(), makeProvenance());
    expect(() => parseNormalizedCareTeam({
      ...normalized,
      accountRef: "account-2",
    })).toThrow(/Account reference/);
    expect(() => parseNormalizedCareTeam({
      ...normalized,
      patientSubjectId: "subject-2",
    })).toThrow(/Patient subject/);
    expect(() => parseNormalizedCareTeam({
      ...normalized,
      status: "inactive",
    })).toThrow(/Projected CareTeam/);
    expect(() => parseNormalizedCareTeam({
      ...normalized,
      provenance: {
        ...normalized.provenance,
        contentHash: `sha256:${"b".repeat(64)}`,
      },
    })).toThrow(/Content hash/);
  });

  it.each([
    { modifierExtension: [{ url: "https://ehr.example.test/modifier", valueBoolean: true }] },
    { implicitRules: "https://ehr.example.test/fhir/Rules/one" },
    { participant: [{ modifierExtension: [{ url: "https://ehr.example.test/modifier" }] }] },
  ])("refuses to interpret unknown modifier semantics while raw data remains parseable: %j", (override) => {
    const raw = { ...fullCareTeam(), ...override };
    expect(parseCareTeamResource(raw)).toMatchObject(override);
    expect(() => normalizeCareTeam(raw, makeProvenance({ contentHash: fhirContentHash(raw) })))
      .toThrow(/modifier semantics/);
  });
});

describe("CareTeam insights", () => {
  it("creates a deterministic rules summary using only explicit resource values", () => {
    const normalized = normalizeCareTeam(fullCareTeam(), makeProvenance());
    const insight = createCareTeamSummaryInsight(normalized, retrievedAt);

    expect(insight.insightId).toBe(`care-team-summary:v1:${contentHash.slice("sha256:".length)}`);
    expect(insight.insight).toBe([
      "Care team: Neighborhood Care Team",
      "Status: active",
      "Categories: Primary care",
      "Period: 2025-01-01 to 2025-12-31",
      "Subject: Pat Example",
      "Encounter: Encounter/encounter-9",
      "Participants:",
      "- Dr Ada Example | roles: Primary care physician | on behalf of: Example Clinic | period: from 2025-01-15",
      "- RelatedPerson/related-1 | roles: caregiver",
      "Managing organizations: Example Clinic",
      "Reasons: Longitudinal care coordination; Complex care needs",
      "Contacts: phone; work: 555-0100",
      "Notes: Call the clinic before an urgent visit.",
    ].join("\n"));
    expect(insight.sourceResourceVersions).toEqual([normalized.provenance]);
    expect(insight.generator).toEqual({
      kind: "rules",
      rulesVersion: "care-team-summary-v1",
    });
    expect(insight.status).toBe("generated");
    expect(insight.confidence).toBeUndefined();
    expect(insight.insight).not.toContain("sourceSpecific");
    expect(createCareTeamSummaryInsight(normalized, retrievedAt)).toEqual(insight);
  });

  it("does not infer a name, status, participant, category, or contact for a sparse resource", () => {
    const raw = { resourceType: "CareTeam", id: "care-team-2" };
    const normalized = normalizeCareTeam(
      raw,
      makeProvenance({
        resourceId: "care-team-2",
        versionId: undefined,
        lastUpdated: undefined,
        contentHash: fhirContentHash(raw),
      }),
    );

    expect(createCareTeamSummaryInsight(normalized, retrievedAt).insight)
      .toBe("Care team: care-team-2");
  });

  it("bounds large deterministic summaries and marks omitted source detail", () => {
    const raw = {
      ...fullCareTeam(),
      note: Array.from({ length: 5 }, () => ({ text: "x".repeat(64 * 1_024) })),
    };
    const normalized = normalizeCareTeam(
      raw,
      makeProvenance({ contentHash: fhirContentHash(raw) }),
    );
    const insight = createCareTeamSummaryInsight(normalized, retrievedAt);
    expect(insight.insight.length).toBeLessThanOrEqual(256 * 1_024);
    expect(insight.insight).toContain("Additional source details omitted");
    expect(insight.sourceResourceVersions).toEqual([normalized.provenance]);
  });

  it("accepts a fully versioned model insight while retaining forward-compatible fields", () => {
    const parsed = parseInsightRecord({
      insightId: "insight-1",
      accountRef: "account-1",
      patientSubjectId: "subject-1",
      insightType: "care-team-summary",
      insight: "A source-grounded summary.",
      sourceResourceVersions: [{
        ...makeProvenance(),
        sourceExtension: "retained",
      }],
      generatedAt: retrievedAt,
      generator: {
        kind: "model",
        provider: "baa-covered-provider",
        model: "clinical-summary-model",
        modelVersion: "2025-03-01",
        promptVersion: "care-team-v3",
        generatorExtension: true,
      },
      confidence: 0.75,
      status: "reviewed",
      recordExtension: { retained: true },
    });

    expect(parsed.recordExtension).toEqual({ retained: true });
    expect(parsed.sourceResourceVersions[0]?.sourceExtension).toBe("retained");
    expect(parsed.generator.generatorExtension).toBe(true);
  });

  it("rejects uncited, cross-patient, cross-account, and unversioned model insights", () => {
    const base = {
      insightId: "insight-1",
      accountRef: "account-1",
      patientSubjectId: "subject-1",
      insightType: "care-team-summary",
      insight: "Summary",
      sourceResourceVersions: [makeProvenance()],
      generatedAt: retrievedAt,
      generator: { kind: "rules", rulesVersion: "v1" },
      status: "generated",
    };

    expect(() => insightRecordSchema.parse({
      ...base,
      sourceResourceVersions: [],
    })).toThrow();
    expect(() => insightRecordSchema.parse({
      ...base,
      sourceResourceVersions: [makeProvenance({ patientSubjectId: "subject-2" })],
    })).toThrow(/another patient/);
    expect(() => insightRecordSchema.parse({
      ...base,
      sourceResourceVersions: [makeProvenance({ accountRef: "account-2" })],
    })).toThrow(/another account/);
    expect(() => insightRecordSchema.parse({
      ...base,
      generator: {
        kind: "model",
        provider: "provider",
        model: "model",
        promptVersion: "prompt-v1",
      },
    })).toThrow();
  });

  it("binds a user confirmation to the insight account", () => {
    const normalized = normalizeCareTeam(fullCareTeam(), makeProvenance());
    const insight = createCareTeamSummaryInsight(normalized, retrievedAt);

    expect(() => parseInsightRecord({
      ...insight,
      status: "confirmed",
      userConfirmation: {
        decision: "confirmed",
        accountRef: "account-2",
        recordedAt: retrievedAt,
      },
    })).toThrow(/Confirmation belongs to another account/);
  });

  it("enforces coherent insight decisions and non-self-referential lineage", () => {
    const normalized = normalizeCareTeam(fullCareTeam(), makeProvenance());
    const insight = createCareTeamSummaryInsight(normalized, retrievedAt);
    expect(() => parseInsightRecord({ ...insight, status: "confirmed" }))
      .toThrow(/requires a confirming/);
    expect(() => parseInsightRecord({
      ...insight,
      status: "dismissed",
      userConfirmation: {
        decision: "confirmed",
        accountRef: insight.accountRef,
        recordedAt: retrievedAt,
      },
    })).toThrow(/requires a dismissal/);
    expect(() => parseInsightRecord({
      ...insight,
      userConfirmation: {
        decision: "dismissed",
        accountRef: insight.accountRef,
        recordedAt: retrievedAt,
      },
    })).toThrow(/Only confirmed/);
    expect(() => parseInsightRecord({
      ...insight,
      supersedesInsightId: insight.insightId,
    })).toThrow(/supersede itself/);
  });
});
