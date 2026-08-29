import { describe, expect, it } from "vitest";

import type { SourceResourceVersionRef } from "../src/care-team.js";
import {
  assertNormalizedFhirResourceMatchesSource,
  createFhirResourceSummaryInsight,
  normalizeFhirResource,
  normalizedFhirResourceSchema,
  normalizedFhirResourceTypes,
  supportsNormalizedFhirResource,
  type NormalizedFhirResourceType,
} from "../src/fhir-intelligence.js";
import { fhirContentHash } from "../src/fhir-hub.js";

const generatedAt = "2026-08-26T14:30:00.000Z";
const retrievedAt = "2026-08-26T14:00:00.000Z";
const lastUpdated = "2026-08-25T10:00:00.000Z";
const binaryPlaintext = "VERY-SENSITIVE-BINARY-PAYLOAD";
const binaryPayload = Buffer.from(binaryPlaintext, "utf8").toString("base64");
const attachmentPlaintext = "PRIVATE-CLINICAL-ATTACHMENT-CONTENT";
const attachmentPayload = Buffer.from(attachmentPlaintext, "utf8").toString("base64");
const signaturePlaintext = "PRIVATE-SIGNATURE-BYTES";
const signaturePayload = Buffer.from(signaturePlaintext, "utf8").toString("base64");

type FhirJson = Record<string, unknown>;

function baseResource(
  resourceType: NormalizedFhirResourceType,
  fields: FhirJson,
): FhirJson {
  return {
    resourceType,
    id: `${resourceType.toLowerCase()}-1`,
    meta: {
      versionId: "7",
      lastUpdated,
      profile: [`https://ehr.example.test/fhir/StructureDefinition/${resourceType}`],
    },
    extension: [{
      url: "https://ehr.example.test/fhir/StructureDefinition/source-marker",
      valueString: "ordinary extensions remain raw and are not interpreted",
    }],
    ...fields,
  };
}

const fixtures: Record<NormalizedFhirResourceType, FhirJson> = {
  AllergyIntolerance: baseResource("AllergyIntolerance", {
    clinicalStatus: {
      coding: [{
        system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
        code: "active",
        display: "Active",
      }],
    },
    verificationStatus: {
      coding: [{
        system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification",
        code: "confirmed",
        display: "Confirmed",
      }],
    },
    code: { text: "Peanut allergy" },
    patient: { reference: "Patient/patient-1", display: "Patient" },
    onsetDateTime: "2020-03-02",
    reaction: [{
      manifestation: [{ text: "Hives" }],
      severity: "moderate",
    }],
  }),
  Binary: baseResource("Binary", {
    contentType: "application/pdf",
    securityContext: {
      reference: "DocumentReference/documentreference-1",
      display: "Clinical document security context",
    },
    data: binaryPayload,
  }),
  CarePlan: baseResource("CarePlan", {
    status: "active",
    intent: "plan",
    title: "Longitudinal care plan",
    subject: { reference: "Patient/patient-1", display: "Patient" },
    period: { start: "2026-01-01", end: "2026-12-31" },
    activity: [{
      detail: {
        status: "in-progress",
        code: { text: "Follow-up visit" },
      },
    }],
  }),
  CareTeam: baseResource("CareTeam", {
    status: "active",
    name: "Primary care team",
    subject: { reference: "Patient/patient-1", display: "Patient" },
    participant: [{
      role: [{ text: "Primary clinician" }],
      member: { reference: "Practitioner/practitioner-1", display: "Dr Example" },
    }],
  }),
  Condition: baseResource("Condition", {
    clinicalStatus: {
      coding: [{
        system: "http://terminology.hl7.org/CodeSystem/condition-clinical",
        code: "active",
        display: "Active",
      }],
    },
    verificationStatus: {
      coding: [{
        system: "http://terminology.hl7.org/CodeSystem/condition-ver-status",
        code: "confirmed",
        display: "Confirmed",
      }],
    },
    code: { text: "Hypertension" },
    subject: { reference: "Patient/patient-1", display: "Patient" },
    onsetDateTime: "2021-04-05",
  }),
  Device: baseResource("Device", {
    status: "active",
    deviceName: [{ name: "Home blood-pressure cuff", type: "user-friendly-name" }],
    type: { text: "Blood pressure monitor" },
    manufacturer: "Example Medical Devices",
    patient: { reference: "Patient/patient-1", display: "Patient" },
  }),
  DiagnosticReport: baseResource("DiagnosticReport", {
    status: "final",
    code: { text: "Metabolic panel" },
    subject: { reference: "Patient/patient-1", display: "Patient" },
    effectiveDateTime: "2026-08-25T08:00:00Z",
    conclusion: "Source-authored conclusion",
    presentedForm: [{
      contentType: "application/pdf",
      title: "Metabolic panel report",
      size: 1_024,
      data: attachmentPayload,
      url: "https://attachments.example.test/private/report.pdf",
    }],
  }),
  DocumentReference: baseResource("DocumentReference", {
    status: "current",
    docStatus: "final",
    description: "Discharge summary",
    type: { text: "Clinical note" },
    subject: { reference: "Patient/patient-1", display: "Patient" },
    content: [{
      attachment: {
        contentType: "text/plain",
        title: "Discharge summary attachment",
        size: 2_048,
        data: attachmentPayload,
        url: "https://attachments.example.test/private/discharge.txt",
      },
    }],
  }),
  Encounter: baseResource("Encounter", {
    status: "finished",
    class: {
      system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      code: "AMB",
      display: "Ambulatory",
    },
    type: [{ text: "Primary care visit" }],
    subject: { reference: "Patient/patient-1", display: "Patient" },
    period: { start: "2026-08-20T14:00:00Z", end: "2026-08-20T14:30:00Z" },
  }),
  Goal: baseResource("Goal", {
    lifecycleStatus: "active",
    achievementStatus: { text: "In progress" },
    description: { text: "Maintain source-recorded blood pressure goal" },
    subject: { reference: "Patient/patient-1", display: "Patient" },
    startDate: "2026-01-01",
    target: [{
      measure: { text: "Systolic blood pressure" },
      detailQuantity: { value: 130, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" },
      dueDate: "2026-12-31",
    }],
  }),
  Immunization: baseResource("Immunization", {
    status: "completed",
    vaccineCode: { text: "Influenza vaccine" },
    patient: { reference: "Patient/patient-1", display: "Patient" },
    occurrenceDateTime: "2025-10-10",
    primarySource: true,
    doseQuantity: { value: 0.5, unit: "mL", system: "http://unitsofmeasure.org", code: "mL" },
    protocolApplied: [{ series: "Seasonal influenza", doseNumberPositiveInt: 1 }],
  }),
  Location: baseResource("Location", {
    status: "active",
    name: "Example Health Downtown",
    type: [{ text: "Clinic" }],
    address: { line: ["100 Example Street"], city: "Boston", state: "MA" },
    hoursOfOperation: [{ daysOfWeek: ["mon", "tue"], openingTime: "08:00:00", closingTime: "17:00:00" }],
  }),
  Medication: baseResource("Medication", {
    status: "active",
    code: { text: "Example medication definition" },
    form: { text: "Tablet" },
    ingredient: [{
      itemCodeableConcept: { text: "Example ingredient" },
      isActive: true,
      strength: {
        numerator: { value: 10, unit: "mg" },
        denominator: { value: 1, unit: "tablet" },
      },
    }],
  }),
  MedicationRequest: baseResource("MedicationRequest", {
    status: "active",
    intent: "order",
    medicationCodeableConcept: { text: "Example prescribed medication" },
    subject: { reference: "Patient/patient-1", display: "Patient" },
    authoredOn: "2026-08-20",
    dosageInstruction: [{
      text: "Take exactly as recorded by the source",
      route: { text: "Oral" },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tablet" } }],
    }],
    dispenseRequest: {
      numberOfRepeatsAllowed: 2,
      quantity: { value: 30, unit: "tablet" },
    },
  }),
  Observation: baseResource("Observation", {
    status: "final",
    category: [{ text: "Vital signs" }],
    code: { text: "Systolic blood pressure" },
    subject: { reference: "Patient/patient-1", display: "Patient" },
    effectiveDateTime: "2026-08-25T08:00:00Z",
    valueQuantity: {
      value: 122,
      unit: "mmHg",
      system: "http://unitsofmeasure.org",
      code: "mm[Hg]",
    },
    referenceRange: [{
      low: { value: 90, unit: "mmHg" },
      high: { value: 130, unit: "mmHg" },
    }],
  }),
  Organization: baseResource("Organization", {
    active: true,
    name: "Example Health",
    type: [{ text: "Healthcare provider" }],
    telecom: [{ system: "phone", use: "work", value: "555-0100" }],
    contact: [{
      purpose: { text: "Patient support" },
      name: { text: "Support desk" },
    }],
  }),
  Patient: baseResource("Patient", {
    active: true,
    name: [{ given: ["Pat"], family: "Example" }],
    gender: "unknown",
    birthDate: "1980-01-02",
    address: [{ city: "Boston", state: "MA" }],
    managingOrganization: { reference: "Organization/organization-1", display: "Example Health" },
  }),
  Practitioner: baseResource("Practitioner", {
    active: true,
    name: [{ given: ["Ada"], family: "Example", prefix: ["Dr"] }],
    telecom: [{ system: "phone", use: "work", value: "555-0101" }],
    qualification: [{
      code: { text: "Medical doctor" },
      issuer: { reference: "Organization/organization-1", display: "Licensing organization" },
    }],
  }),
  PractitionerRole: baseResource("PractitionerRole", {
    active: true,
    practitioner: { reference: "Practitioner/practitioner-1", display: "Dr Example" },
    organization: { reference: "Organization/organization-1", display: "Example Health" },
    code: [{ text: "Primary care physician" }],
    specialty: [{ text: "Family medicine" }],
    availableTime: [{ daysOfWeek: ["mon"], availableStartTime: "09:00:00", availableEndTime: "17:00:00" }],
  }),
  Procedure: baseResource("Procedure", {
    status: "completed",
    code: { text: "Source-recorded procedure" },
    subject: { reference: "Patient/patient-1", display: "Patient" },
    performedDateTime: "2026-08-01T09:00:00Z",
    performer: [{
      actor: { reference: "Practitioner/practitioner-1", display: "Dr Example" },
    }],
  }),
  Provenance: baseResource("Provenance", {
    target: [{ reference: "Observation/observation-1", display: "Source observation" }],
    occurredDateTime: "2026-08-25T09:55:00Z",
    recorded: "2026-08-25T10:00:00Z",
    activity: { text: "Record update" },
    agent: [{
      type: { text: "Author" },
      who: { reference: "Practitioner/practitioner-1", display: "Dr Example" },
    }],
    signature: [{
      type: [{
        system: "urn:iso-astm:E1762-95:2013",
        code: "1.2.840.10065.1.12.1.1",
        display: "Author signature",
      }],
      when: "2026-08-25T10:00:00Z",
      who: { reference: "Practitioner/practitioner-1", display: "Dr Example" },
      sigFormat: "application/jose",
      data: signaturePayload,
    }],
  }),
  RelatedPerson: baseResource("RelatedPerson", {
    active: true,
    patient: { reference: "Patient/patient-1", display: "Patient" },
    relationship: [{ text: "Parent" }],
    name: [{ given: ["Riley"], family: "Example" }],
    period: { start: "2020-01-01" },
  }),
};

function fixture(resourceType: NormalizedFhirResourceType): FhirJson {
  return structuredClone(fixtures[resourceType]);
}

function provenanceFor(
  raw: FhirJson,
  overrides: Partial<SourceResourceVersionRef> = {},
): SourceResourceVersionRef {
  const meta = raw.meta as Record<string, unknown> | undefined;
  return {
    accountRef: "account-1",
    sourceConnectionId: "epic-connection-1",
    patientSubjectId: "patient-subject-1",
    fhirIssuer: "https://ehr.example.test/api/FHIR/R4",
    resourceType: raw.resourceType as string,
    resourceId: raw.id as string,
    ...(typeof meta?.versionId === "string" ? { versionId: meta.versionId } : {}),
    ...(typeof meta?.lastUpdated === "string" ? { lastUpdated: meta.lastUpdated } : {}),
    retrievedAt,
    contentHash: fhirContentHash(raw),
    ...overrides,
  };
}

function expectedInsightType(resourceType: string): string {
  return `${resourceType.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}-summary`;
}

function removeRootField(resourceType: NormalizedFhirResourceType, field: string): FhirJson {
  const raw = fixture(resourceType);
  delete raw[field];
  return raw;
}

describe("FHIR intelligence resource registry", () => {
  it("contains exactly the 22 configured intelligence resource types", () => {
    expect(normalizedFhirResourceTypes).toEqual([
      "AllergyIntolerance",
      "Binary",
      "CarePlan",
      "CareTeam",
      "Condition",
      "Device",
      "DiagnosticReport",
      "DocumentReference",
      "Encounter",
      "Goal",
      "Immunization",
      "Location",
      "Medication",
      "MedicationRequest",
      "Observation",
      "Organization",
      "Patient",
      "Practitioner",
      "PractitionerRole",
      "Procedure",
      "Provenance",
      "RelatedPerson",
    ]);
    expect(new Set(normalizedFhirResourceTypes).size).toBe(22);
    for (const resourceType of normalizedFhirResourceTypes) {
      expect(supportsNormalizedFhirResource(resourceType)).toBe(true);
    }
    expect(supportsNormalizedFhirResource("OperationOutcome")).toBe(false);
    expect(supportsNormalizedFhirResource("Bundle")).toBe(false);
    expect(supportsNormalizedFhirResource("observation")).toBe(false);
  });
});

describe("all 22 FHIR intelligence adapters", () => {
  it.each(normalizedFhirResourceTypes)(
    "normalizes %s and creates a deterministic, exactly cited summary",
    (resourceType) => {
      const raw = fixture(resourceType);
      const before = structuredClone(raw);
      const provenance = provenanceFor(raw);

      const firstProjection = normalizeFhirResource(raw, provenance);
      const secondProjection = normalizeFhirResource(raw, provenance);
      const firstInsight = createFhirResourceSummaryInsight(firstProjection, generatedAt);
      const secondInsight = createFhirResourceSummaryInsight(secondProjection, generatedAt);

      expect(firstProjection).toEqual(secondProjection);
      expect(firstProjection).toMatchObject({
        schemaVersion: 1,
        accountRef: provenance.accountRef,
        sourceConnectionId: provenance.sourceConnectionId,
        patientSubjectId: provenance.patientSubjectId,
        resourceType,
        resourceId: raw.id,
        provenance,
      });
      expect(firstProjection.resourceLabel.length).toBeGreaterThan(0);
      expect(firstProjection.headline.length).toBeGreaterThan(0);
      expect(firstProjection.facts.length).toBeGreaterThan(0);
      expect(firstProjection.facts.every((fact) => fact.sourcePath.startsWith(`${resourceType}.`)))
        .toBe(true);
      expect(firstInsight).toEqual(secondInsight);
      expect(firstInsight).toMatchObject({
        accountRef: provenance.accountRef,
        patientSubjectId: provenance.patientSubjectId,
        insightType: expectedInsightType(resourceType),
        sourceResourceVersions: [provenance],
        generatedAt,
        generator: {
          kind: "rules",
          rulesVersion: "normalized-fhir-resource-summary-v1",
        },
        status: "generated",
      });
      expect(firstInsight.insight).toContain(firstProjection.resourceLabel);
      expect(firstInsight.insight).toContain(firstProjection.headline);
      expect(raw).toEqual(before);
    },
  );

  it("ignores ordinary extensions without losing source-content integrity", () => {
    const raw = fixture("Observation");
    const projection = normalizeFhirResource(raw, provenanceFor(raw));
    expect(JSON.stringify(projection)).not.toContain("source-marker");
    expect(projection.provenance.contentHash).toBe(fhirContentHash(raw));
  });

  it("removes credentials, query strings, and fragments from projected references", () => {
    const raw = fixture("CareTeam");
    raw.participant = [{
      member: {
        reference: "https://user:password@ehr.example.test/Practitioner/123?access_token=secret#private",
      },
      onBehalfOf: {
        reference: "Organization/456?signature=secret#private",
      },
    }];
    const projection = normalizeFhirResource(raw, provenanceFor(raw));
    const serialized = JSON.stringify(projection);
    const member = projection.facts.find((candidate) =>
      candidate.sourcePath === "CareTeam.participant.member")?.values[0];
    const organization = projection.facts.find((candidate) =>
      candidate.sourcePath === "CareTeam.participant.onBehalfOf")?.values[0];

    expect(member).toMatchObject({
      kind: "reference",
      reference: "https://ehr.example.test/Practitioner/123",
      display: "https://ehr.example.test/Practitioner/123",
    });
    expect(organization).toMatchObject({
      kind: "reference",
      reference: "Organization/456",
      display: "Organization/456",
    });
    expect(serialized).not.toMatch(/user|password|access_token|signature|secret|private/);
  });
});

describe("exact source provenance", () => {
  it.each([
    ["resource type", { resourceType: "Condition" }],
    ["resource id", { resourceId: "another-observation" }],
    ["version", { versionId: "8" }],
    ["missing version", { versionId: undefined }],
    ["last updated", { lastUpdated: "2026-08-24T10:00:00.000Z" }],
    ["missing last updated", { lastUpdated: undefined }],
    ["content hash", { contentHash: `sha256:${"a".repeat(64)}` }],
  ] satisfies ReadonlyArray<readonly [string, Partial<SourceResourceVersionRef>]>) (
    "rejects a mismatched %s citation",
    (_label, overrides) => {
      const raw = fixture("Observation");
      expect(() => normalizeFhirResource(raw, provenanceFor(raw, overrides)))
        .toThrow(/identity or content does not match provenance/i);
    },
  );

  it("rejects a source changed after its citation was created", () => {
    const raw = fixture("Observation");
    const provenance = provenanceFor(raw);
    raw.valueQuantity = { value: 999, unit: "mmHg" };
    expect(() => normalizeFhirResource(raw, provenance)).toThrow(/content does not match provenance/i);
  });

  it("rejects cross-account, cross-source, and cross-patient projection envelopes", () => {
    const raw = fixture("Condition");
    const projection = normalizeFhirResource(raw, provenanceFor(raw));
    expect(() => normalizedFhirResourceSchema.parse({ ...projection, accountRef: "account-2" }))
      .toThrow(/Account reference/);
    expect(() => normalizedFhirResourceSchema.parse({
      ...projection,
      sourceConnectionId: "epic-connection-2",
    })).toThrow(/Source connection/);
    expect(() => normalizedFhirResourceSchema.parse({
      ...projection,
      patientSubjectId: "patient-subject-2",
    })).toThrow(/Patient subject/);
    expect(() => normalizedFhirResourceSchema.parse({
      ...projection,
      resourceId: "another-condition",
    })).toThrow(/Resource ID/);
  });
});

describe("modifier and implicit-rule safety", () => {
  it.each([
    ["root modifier", () => {
      const raw = fixture("Observation");
      raw.modifierExtension = [{
        url: "https://ehr.example.test/fhir/StructureDefinition/negates-observation",
        valueBoolean: true,
      }];
      return raw;
    }],
    ["root implicit rules", () => {
      const raw = fixture("Patient");
      raw.implicitRules = "https://ehr.example.test/fhir/Rules/private-patient-semantics";
      return raw;
    }],
    ["nested Observation component modifier", () => {
      const raw = fixture("Observation");
      raw.component = [{
        code: { text: "Component" },
        valueString: "value",
        modifierExtension: [{
          url: "https://ehr.example.test/fhir/StructureDefinition/negates-component",
          valueBoolean: true,
        }],
      }];
      return raw;
    }],
    ["nested CarePlan activity modifier", () => {
      const raw = fixture("CarePlan");
      ((raw.activity as FhirJson[])[0]!.detail as FhirJson).modifierExtension = [{
        url: "https://ehr.example.test/fhir/StructureDefinition/negates-activity",
        valueBoolean: true,
      }];
      return raw;
    }],
    ["nested dosage modifier", () => {
      const raw = fixture("MedicationRequest");
      (raw.dosageInstruction as FhirJson[])[0]!.modifierExtension = [{
        url: "https://ehr.example.test/fhir/StructureDefinition/anti-prescription",
        valueBoolean: true,
      }];
      return raw;
    }],
    ["deep contained-resource implicit rules", () => {
      const raw = fixture("DocumentReference");
      raw.contained = [{
        resourceType: "Organization",
        id: "contained-organization",
        implicitRules: "https://ehr.example.test/fhir/Rules/contained-semantics",
      }];
      return raw;
    }],
  ] satisfies ReadonlyArray<readonly [string, () => FhirJson]>) (
    "blocks %s",
    (_label, createRaw) => {
      const raw = createRaw();
      expect(() => normalizeFhirResource(raw, provenanceFor(raw))).toThrow(/modifier semantics/i);
    },
  );

  it("allows explicitly empty modifier arrays", () => {
    const raw = fixture("CareTeam");
    raw.modifierExtension = [];
    (raw.participant as FhirJson[])[0]!.modifierExtension = [];
    expect(normalizeFhirResource(raw, provenanceFor(raw))).toMatchObject({ resourceType: "CareTeam" });
  });
});

describe("FHIR required fields", () => {
  it.each([
    ["AllergyIntolerance", "patient"],
    ["Binary", "contentType"],
    ["CarePlan", "status"],
    ["CarePlan", "intent"],
    ["CarePlan", "subject"],
    ["Condition", "subject"],
    ["DiagnosticReport", "status"],
    ["DiagnosticReport", "code"],
    ["DocumentReference", "status"],
    ["DocumentReference", "content"],
    ["Encounter", "status"],
    ["Encounter", "class"],
    ["Goal", "lifecycleStatus"],
    ["Goal", "description"],
    ["Goal", "subject"],
    ["Immunization", "status"],
    ["Immunization", "vaccineCode"],
    ["Immunization", "patient"],
    ["MedicationRequest", "status"],
    ["MedicationRequest", "intent"],
    ["MedicationRequest", "subject"],
    ["Observation", "status"],
    ["Observation", "code"],
    ["Procedure", "status"],
    ["Procedure", "subject"],
    ["Provenance", "target"],
    ["Provenance", "recorded"],
    ["Provenance", "agent"],
    ["RelatedPerson", "patient"],
  ] satisfies ReadonlyArray<readonly [NormalizedFhirResourceType, string]>) (
    "rejects %s without required %s",
    (resourceType, field) => {
      const raw = removeRootField(resourceType, field);
      expect(() => normalizeFhirResource(raw, provenanceFor(raw))).toThrow(/required by FHIR R4/i);
    },
  );

  it("rejects a resource without its base FHIR id", () => {
    const raw = fixture("Observation");
    delete raw.id;
    expect(() => normalizeFhirResource(raw, provenanceFor({ ...raw, id: "temporary" }))).toThrow();
  });

  it("accepts optional Binary.data and Immunization.primarySource when absent", () => {
    for (const [resourceType, field] of [
      ["Binary", "data"],
      ["Immunization", "primarySource"],
    ] as const) {
      const raw = removeRootField(resourceType, field);
      expect(normalizeFhirResource(raw, provenanceFor(raw))).toMatchObject({ resourceType });
    }
  });
});

describe("FHIR choice elements", () => {
  it.each([
    ["AllergyIntolerance onset", () => ({ ...fixture("AllergyIntolerance"), onsetString: "childhood" })],
    ["Condition onset", () => ({ ...fixture("Condition"), onsetString: "several years ago" })],
    ["Condition abatement", () => ({
      ...fixture("Condition"),
      abatementDateTime: "2025-01-01",
      abatementString: "resolved",
    })],
    ["DiagnosticReport effective", () => ({
      ...fixture("DiagnosticReport"),
      effectivePeriod: { start: "2026-08-25" },
    })],
    ["Goal start", () => ({ ...fixture("Goal"), startCodeableConcept: { text: "After discharge" } })],
    ["Immunization occurrence", () => ({ ...fixture("Immunization"), occurrenceString: "Last autumn" })],
    ["MedicationRequest medication", () => ({
      ...fixture("MedicationRequest"),
      medicationReference: { reference: "Medication/medication-1" },
    })],
    ["MedicationRequest reported", () => ({
      ...fixture("MedicationRequest"),
      reportedBoolean: true,
      reportedReference: { reference: "Practitioner/practitioner-1" },
    })],
    ["Observation effective", () => ({
      ...fixture("Observation"),
      effectiveInstant: "2026-08-25T08:00:00Z",
    })],
    ["Observation value", () => ({ ...fixture("Observation"), valueString: "duplicate value" })],
    ["Patient deceased", () => ({
      ...fixture("Patient"),
      deceasedBoolean: true,
      deceasedDateTime: "2026-01-01T00:00:00Z",
    })],
    ["Patient multiple birth", () => ({
      ...fixture("Patient"),
      multipleBirthBoolean: true,
      multipleBirthInteger: 2,
    })],
    ["Procedure performed", () => ({ ...fixture("Procedure"), performedString: "Earlier this year" })],
    ["Provenance occurred", () => ({
      ...fixture("Provenance"),
      occurredPeriod: { start: "2026-08-25T09:00:00Z" },
    })],
  ] satisfies ReadonlyArray<readonly [string, () => FhirJson]>) (
    "rejects multiple values for %s[x]",
    (_label, createRaw) => {
      const raw = createRaw();
      expect(() => normalizeFhirResource(raw, provenanceFor(raw))).toThrow(/invalid FHIR choice/i);
    },
  );

  it.each([
    ["Immunization", "occurrenceDateTime"],
    ["MedicationRequest", "medicationCodeableConcept"],
  ] satisfies ReadonlyArray<readonly [NormalizedFhirResourceType, string]>) (
    "rejects %s without its required %s choice",
    (resourceType, field) => {
      const raw = removeRootField(resourceType, field);
      expect(() => normalizeFhirResource(raw, provenanceFor(raw))).toThrow(/invalid FHIR choice/i);
    },
  );

  it.each([
    ["CarePlan activity", () => {
      const raw = fixture("CarePlan");
      (raw.activity as FhirJson[])[0]!.reference = { reference: "Procedure/procedure-1" };
      return raw;
    }],
    ["Goal target detail", () => {
      const raw = fixture("Goal");
      (raw.target as FhirJson[])[0]!.detailString = "also a string";
      return raw;
    }],
    ["Immunization dose number", () => {
      const raw = fixture("Immunization");
      (raw.protocolApplied as FhirJson[])[0]!.doseNumberString = "one";
      return raw;
    }],
    ["Medication ingredient item", () => {
      const raw = fixture("Medication");
      (raw.ingredient as FhirJson[])[0]!.itemReference = { reference: "Medication/other" };
      return raw;
    }],
    ["MedicationRequest dose", () => {
      const raw = fixture("MedicationRequest");
      const doseAndRate = ((raw.dosageInstruction as FhirJson[])[0]!.doseAndRate as FhirJson[])[0]!;
      doseAndRate.doseRange = { low: { value: 1 }, high: { value: 2 } };
      return raw;
    }],
    ["MedicationRequest substitution", () => {
      const raw = fixture("MedicationRequest");
      raw.substitution = {
        allowedBoolean: true,
        allowedCodeableConcept: { text: "Allowed" },
      };
      return raw;
    }],
    ["Observation component value", () => {
      const raw = fixture("Observation");
      raw.component = [{
        code: { text: "Component" },
        valueString: "one",
        valueInteger: 2,
      }];
      return raw;
    }],
  ] satisfies ReadonlyArray<readonly [string, () => FhirJson]>) (
    "rejects multiple nested values for %s choice",
    (_label, createRaw) => {
      const raw = createRaw();
      expect(() => normalizeFhirResource(raw, provenanceFor(raw))).toThrow(/invalid FHIR choice/i);
    },
  );
});

describe("nested R4 required fields and temporal primitives", () => {
  it.each([
    ["DocumentReference content", () => {
      const raw = fixture("DocumentReference");
      raw.content = [{}];
      return raw;
    }],
    ["Provenance agent", () => {
      const raw = fixture("Provenance");
      raw.agent = [{}];
      return raw;
    }],
    ["Observation component", () => {
      const raw = fixture("Observation");
      raw.component = [{ valueString: "missing code" }];
      return raw;
    }],
    ["Patient link", () => {
      const raw = fixture("Patient");
      raw.link = [{ type: "replaced-by" }];
      return raw;
    }],
    ["Patient communication", () => {
      const raw = fixture("Patient");
      raw.communication = [{ preferred: true }];
      return raw;
    }],
    ["DocumentReference relationship", () => {
      const raw = fixture("DocumentReference");
      raw.relatesTo = [{ target: { reference: "DocumentReference/prior" } }];
      return raw;
    }],
    ["Encounter status history", () => {
      const raw = fixture("Encounter");
      raw.statusHistory = [{ period: { start: "2026-01-01" } }];
      return raw;
    }],
    ["PractitionerRole unavailability", () => {
      const raw = fixture("PractitionerRole");
      raw.notAvailable = [{ during: { start: "2026-01-01" } }];
      return raw;
    }],
    ["Provenance entity role", () => {
      const raw = fixture("Provenance");
      raw.entity = [{ what: { reference: "DocumentReference/source" } }];
      return raw;
    }],
  ] satisfies ReadonlyArray<readonly [string, () => FhirJson]>) (
    "rejects %s without its nested required field",
    (_label, createRaw) => {
      const raw = createRaw();
      expect(() => normalizeFhirResource(raw, provenanceFor(raw)))
        .toThrow(/required by FHIR R4/i);
    },
  );

  it.each([
    ["Observation effectiveDateTime", "Observation", "effectiveDateTime"],
    ["Patient birthDate", "Patient", "birthDate"],
    ["Provenance recorded", "Provenance", "recorded"],
  ] satisfies ReadonlyArray<readonly [string, NormalizedFhirResourceType, string]>) (
    "rejects an invalid %s",
    (_label, resourceType, path) => {
      const raw = fixture(resourceType);
      raw[path] = "NOT-A-FHIR-TEMPORAL-VALUE";
      expect(() => normalizeFhirResource(raw, provenanceFor(raw))).toThrow(/invalid R4/i);
    },
  );

  it.each([
    "2026-01-01T00:00:00+14:01",
    "0000-01-01T00:00:00Z",
    "2026-02-30T00:00:00Z",
  ])("rejects invalid R4 dateTime boundary %s", (value) => {
    const raw = fixture("Observation");
    raw.effectiveDateTime = value;
    expect(() => normalizeFhirResource(raw, provenanceFor(raw))).toThrow(/invalid R4/i);
  });

  it.each([
    "2026-01-01T00:00:00+14:00",
    "2016-12-31T23:59:60Z",
  ])("accepts valid R4 dateTime boundary %s", (value) => {
    const raw = fixture("Observation");
    raw.effectiveDateTime = value;
    expect(normalizeFhirResource(raw, provenanceFor(raw)).resourceId).toBe(raw.id);
  });
});

describe("FHIR primitive and complex datatype semantics", () => {
  it.each([
    ["fractional integer", () => {
      const raw = fixture("Observation");
      delete raw.valueQuantity;
      raw.valueInteger = 1.5;
      return raw;
    }],
    ["string boolean", () => {
      const raw = fixture("Observation");
      delete raw.valueQuantity;
      raw.valueBoolean = "true";
      return raw;
    }],
    ["nested fractional integer", () => {
      const raw = fixture("Observation");
      raw.component = [{ code: { text: "Component" }, valueInteger: 2.5 }];
      return raw;
    }],
    ["zero positiveInt", () => {
      const raw = fixture("Immunization");
      (raw.protocolApplied as FhirJson[])[0]!.doseNumberPositiveInt = 0;
      return raw;
    }],
    ["fractional positiveInt", () => {
      const raw = fixture("Immunization");
      (raw.protocolApplied as FhirJson[])[0]!.doseNumberPositiveInt = 1.5;
      return raw;
    }],
    ["negative unsignedInt", () => {
      const raw = fixture("MedicationRequest");
      (raw.dispenseRequest as FhirJson).numberOfRepeatsAllowed = -1;
      return raw;
    }],
  ] satisfies ReadonlyArray<readonly [string, () => FhirJson]>) (
    "rejects %s",
    (_label, createRaw) => {
      const raw = createRaw();
      expect(() => normalizeFhirResource(raw, provenanceFor(raw))).toThrow(/invalid R4/i);
    },
  );

  it.each([
    ["empty required Reference", () => {
      const raw = fixture("Condition");
      raw.subject = {};
      return raw;
    }],
    ["empty required CodeableConcept", () => {
      const raw = fixture("Observation");
      raw.code = {};
      return raw;
    }],
    ["empty required Attachment", () => {
      const raw = fixture("DocumentReference");
      raw.content = [{ attachment: {} }];
      return raw;
    }],
    ["empty required Coding", () => {
      const raw = fixture("Encounter");
      raw.class = {};
      return raw;
    }],
    ["empty required primitive", () => {
      const raw = fixture("Binary");
      raw.contentType = "";
      return raw;
    }],
    ["empty optional Binary data", () => {
      const raw = fixture("Binary");
      raw.data = "";
      return raw;
    }],
  ] satisfies ReadonlyArray<readonly [string, () => FhirJson]>) (
    "rejects %s",
    (_label, createRaw) => {
      const raw = createRaw();
      expect(() => normalizeFhirResource(raw, provenanceFor(raw)))
        .toThrow(/FHIR|canonical base64/i);
    },
  );

  it.each([
    ["reversed Period", () => {
      const raw = fixture("CarePlan");
      raw.period = { start: "2027-01-01", end: "2026-01-01" };
      return raw;
    }],
    ["reversed Range", () => {
      const raw = fixture("Observation");
      delete raw.valueQuantity;
      raw.valueRange = {
        low: { value: 140, unit: "mmHg" },
        high: { value: 90, unit: "mmHg" },
      };
      return raw;
    }],
    ["Quantity code without system", () => {
      const raw = fixture("Observation");
      raw.valueQuantity = { value: 1, unit: "mg", code: "mg" };
      return raw;
    }],
    ["incomplete Ratio", () => {
      const raw = fixture("Observation");
      delete raw.valueQuantity;
      raw.valueRatio = { numerator: { value: 1, unit: "mg" } };
      return raw;
    }],
    ["non-positive Ratio denominator", () => {
      const raw = fixture("Observation");
      delete raw.valueQuantity;
      raw.valueRatio = {
        numerator: { value: 1, unit: "mg" },
        denominator: { value: 0, unit: "mL" },
      };
      return raw;
    }],
  ] satisfies ReadonlyArray<readonly [string, () => FhirJson]>) (
    "rejects %s",
    (_label, createRaw) => {
      const raw = createRaw();
      expect(() => normalizeFhirResource(raw, provenanceFor(raw))).toThrow(/FHIR/i);
    },
  );
});

describe("required R4 lifecycle codes", () => {
  it.each([
    ["CarePlan", "status", "pending"],
    ["CarePlan", "intent", "directive"],
    ["CareTeam", "status", "draft"],
    ["Device", "status", "retired"],
    ["DiagnosticReport", "status", "active"],
    ["DocumentReference", "status", "active"],
    ["DocumentReference", "docStatus", "unknown"],
    ["Encounter", "status", "completed"],
    ["Goal", "lifecycleStatus", "draft"],
    ["Immunization", "status", "active"],
    ["Location", "status", "entered-in-error"],
    ["Medication", "status", "unknown"],
    ["MedicationRequest", "status", "proposed"],
    ["MedicationRequest", "intent", "directive"],
    ["Observation", "status", "active"],
    ["Procedure", "status", "final"],
  ] satisfies ReadonlyArray<readonly [NormalizedFhirResourceType, string, string]>) (
    "rejects invalid %s.%s code %s",
    (resourceType, field, invalidCode) => {
      const raw = fixture(resourceType);
      raw[field] = invalidCode;
      expect(() => normalizeFhirResource(raw, provenanceFor(raw))).toThrow(/invalid R4 code/i);
    },
  );

  it.each([
    [
      "AllergyIntolerance",
      "clinicalStatus",
      "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
    ],
    [
      "AllergyIntolerance",
      "verificationStatus",
      "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification",
    ],
    [
      "Condition",
      "clinicalStatus",
      "http://terminology.hl7.org/CodeSystem/condition-clinical",
    ],
    [
      "Condition",
      "verificationStatus",
      "http://terminology.hl7.org/CodeSystem/condition-ver-status",
    ],
  ] satisfies ReadonlyArray<readonly [NormalizedFhirResourceType, string, string]>) (
    "rejects a code outside the required %s.%s binding",
    (resourceType, field, system) => {
      const raw = fixture(resourceType);
      raw[field] = { coding: [{ system, code: "not-a-valid-r4-status" }] };
      expect(() => normalizeFhirResource(raw, provenanceFor(raw))).toThrow(/invalid R4 code/i);
    },
  );
});

describe("source lifecycle and modifier warnings", () => {
  it.each([
    ["entered in error", "Observation", (raw: FhirJson) => {
      raw.status = "entered-in-error";
    }, "The source marks this record as entered in error."],
    ["cancelled or revoked", "CarePlan", (raw: FhirJson) => {
      raw.status = "revoked";
    }, "The source marks this record as cancelled or revoked."],
    ["not performed", "Procedure", (raw: FhirJson) => {
      raw.status = "not-done";
    }, "The source states that this event was not performed."],
    ["stopped", "MedicationRequest", (raw: FhirJson) => {
      raw.status = "stopped";
    }, "The source marks this request or event as stopped."],
    ["refuted", "Condition", (raw: FhirJson) => {
      raw.verificationStatus = { coding: [{
        system: "http://terminology.hl7.org/CodeSystem/condition-ver-status",
        code: "refuted",
        display: "Refuted",
      }] };
    }, "The source marks this assertion as refuted."],
    ["verification entered in error", "AllergyIntolerance", (raw: FhirJson) => {
      delete raw.clinicalStatus;
      raw.verificationStatus = { coding: [{
        system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification",
        code: "entered-in-error",
        display: "Entered in error",
      }] };
    }, "The source verification status marks this assertion as entered in error."],
    ["do not perform", "MedicationRequest", (raw: FhirJson) => {
      raw.doNotPerform = true;
    }, "The source explicitly says not to perform this request or activity."],
    ["care-plan activity do not perform", "CarePlan", (raw: FhirJson) => {
      ((raw.activity as FhirJson[])[0]!.detail as FhirJson).doNotPerform = true;
    }, "The source explicitly says not to perform this request or activity."],
    ["subpotent", "Immunization", (raw: FhirJson) => {
      raw.isSubpotent = true;
    }, "The source marks this immunization as subpotent."],
    ["deceased", "Patient", (raw: FhirJson) => {
      raw.deceasedBoolean = true;
    }, "The source records this patient as deceased."],
    ["patient link", "Patient", (raw: FhirJson) => {
      raw.link = [{ other: { reference: "Patient/replacement" }, type: "replaced-by" }];
    }, "The source includes patient-record link semantics; review link type before identity decisions."],
  ] satisfies ReadonlyArray<readonly [
    string,
    NormalizedFhirResourceType,
    (raw: FhirJson) => void,
    string,
  ]>) (
    "preserves the %s warning in the projection and summary",
    (_label, resourceType, mutate, warning) => {
      const raw = fixture(resourceType);
      mutate(raw);
      const projection = normalizeFhirResource(raw, provenanceFor(raw));
      const insight = createFhirResourceSummaryInsight(projection, generatedAt);
      expect(projection.warnings).toContain(warning);
      expect(insight.insight).toContain(`Warning: ${warning}`);
      expect(insight.insight.indexOf("Warning:")).toBeLessThan(
        insight.insight.indexOf(`${projection.resourceLabel}:`),
      );
    },
  );
});

describe("opaque Binary, attachment, and signature content", () => {
  it("validates canonical Binary base64 but emits metadata and an explicit non-decoding notice only", () => {
    const raw = fixture("Binary");
    const projection = normalizeFhirResource(raw, provenanceFor(raw));
    const insight = createFhirResourceSummaryInsight(projection, generatedAt);
    const serializedProjection = JSON.stringify(projection);
    const serializedInsight = JSON.stringify(insight);

    expect(projection.facts.map((fact) => fact.sourcePath)).toEqual([
      "Binary.contentType",
      "Binary.securityContext",
    ]);
    expect(insight.insight).toContain("Binary payload: not decoded or interpreted");
    expect(serializedProjection).not.toContain(binaryPayload);
    expect(serializedProjection).not.toContain(binaryPlaintext);
    expect(serializedInsight).not.toContain(binaryPayload);
    expect(serializedInsight).not.toContain(binaryPlaintext);
  });

  it.each([
    "not base64!",
    "YWJjZA=",
    "YWJjZA===",
    "YWJjZA==\n",
  ])("rejects non-canonical Binary.data %j", (data) => {
    const raw = fixture("Binary");
    raw.data = data;
    expect(() => normalizeFhirResource(raw, provenanceFor(raw))).toThrow(/canonical base64/i);
  });

  it.each(["DiagnosticReport", "DocumentReference"] as const)(
    "does not copy, decode, or fetch %s attachment payloads",
    (resourceType) => {
      const raw = fixture(resourceType);
      const projection = normalizeFhirResource(raw, provenanceFor(raw));
      const insight = createFhirResourceSummaryInsight(projection, generatedAt);
      const output = JSON.stringify({ projection, insight });
      expect(output).toMatch(/application\/(?:pdf|json)|text\/plain/);
      expect(projection.facts.some((fact) =>
        fact.sourcePath === "DiagnosticReport.presentedForm" ||
        fact.sourcePath === "DocumentReference.content.attachment"
      )).toBe(true);
      expect(output).not.toContain(attachmentPayload);
      expect(output).not.toContain(attachmentPlaintext);
      expect(output).not.toContain("https://attachments.example.test/private/");
    },
  );

  it("surfaces Provenance signature metadata without copying or verifying signature bytes", () => {
    const raw = fixture("Provenance");
    const projection = normalizeFhirResource(raw, provenanceFor(raw));
    const insight = createFhirResourceSummaryInsight(projection, generatedAt);
    const output = JSON.stringify({ projection, insight });
    expect(output).toContain("Author signature");
    expect(output).toContain("application/jose");
    expect(output).not.toContain(signaturePayload);
    expect(output).not.toContain(signaturePlaintext);
    expect(output.toLowerCase()).not.toContain("verified");
  });
});

describe("projection/source tamper detection", () => {
  it("accepts an exact recomputed projection", () => {
    const raw = fixture("Observation");
    const provenance = provenanceFor(raw);
    const projection = normalizeFhirResource(raw, provenance);
    expect(assertNormalizedFhirResourceMatchesSource(raw, provenance, projection)).toEqual(projection);
  });

  it.each([
    ["headline", (projection: FhirJson) => {
      projection.headline = "Tampered clinical headline";
    }],
    ["fact display", (projection: FhirJson) => {
      const facts = projection.facts as FhirJson[];
      const values = facts[0]!.values as FhirJson[];
      values[0]!.display = "Tampered normalized value";
    }],
    ["warning", (projection: FhirJson) => {
      projection.warnings = ["Invented warning"];
    }],
    ["resource label", (projection: FhirJson) => {
      projection.resourceLabel = "Invented resource kind";
    }],
  ] satisfies ReadonlyArray<readonly [string, (projection: FhirJson) => void]>) (
    "rejects a tampered %s even when the projection remains structurally valid",
    (_label, mutate) => {
      const raw = fixture("Observation");
      const provenance = provenanceFor(raw);
      const projection = structuredClone(normalizeFhirResource(raw, provenance)) as FhirJson;
      mutate(projection);
      expect(normalizedFhirResourceSchema.parse(projection)).toEqual(projection);
      expect(() => assertNormalizedFhirResourceMatchesSource(raw, provenance, projection))
        .toThrow(/does not exactly match its raw source/i);
    },
  );

  it("rejects a projection whose embedded provenance was replaced", () => {
    const raw = fixture("Observation");
    const provenance = provenanceFor(raw);
    const projection = normalizeFhirResource(raw, provenance);
    const replaced = {
      ...projection,
      provenance: {
        ...projection.provenance,
        accountRef: "different-account",
      },
    };
    expect(() => assertNormalizedFhirResourceMatchesSource(raw, provenance, replaced))
      .toThrow(/Account reference/);
  });
});

describe("bounded deterministic output", () => {
  it("bounds individual source values and marks truncation", () => {
    const raw = fixture("Observation");
    raw.note = [{ text: "x".repeat(10_000) }];
    const projection = normalizeFhirResource(raw, provenanceFor(raw));
    const note = projection.facts.find((fact) => fact.sourcePath === "Observation.note");
    expect(note?.values[0]?.display.length).toBeLessThanOrEqual(4_096);
    expect(note?.values[0]).toMatchObject({ truncated: true });
    expect(note?.values[0]?.display).toContain("review cited raw resource");
  });

  it("bounds repeated facts and reports omitted values without losing the citation", () => {
    const raw = fixture("CareTeam");
    raw.participant = Array.from({ length: 300 }, (_unused, index) => ({
      member: {
        reference: `Practitioner/practitioner-${index}`,
        display: `Practitioner ${index}`,
      },
    }));
    const provenance = provenanceFor(raw);
    const projection = normalizeFhirResource(raw, provenance);
    const participants = projection.facts.find((fact) => fact.sourcePath === "CareTeam.participant.member");
    const insight = createFhirResourceSummaryInsight(projection, generatedAt);
    expect(participants?.values).toHaveLength(256);
    expect(participants?.omittedValues).toBe(44);
    expect(insight.insight).toContain("44 additional value(s) omitted");
    expect(insight.sourceResourceVersions).toEqual([provenance]);
  });

  it("handles very wide source arrays without argument-spread overflow", () => {
    const raw = fixture("Organization");
    raw.alias = Array.from({ length: 200_000 }, (_unused, index) => `Alias ${index}`);
    const projection = normalizeFhirResource(raw, provenanceFor(raw));
    const aliases = projection.facts.find((fact) =>
      fact.sourcePath === "Organization.alias");

    expect(aliases?.values).toHaveLength(256);
    expect(aliases?.omittedValues).toBe(199_744);
  });
});
