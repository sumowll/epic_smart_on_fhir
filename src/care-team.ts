import { createHash } from "node:crypto";

import { z } from "zod";

import {
  canonicalComparableJson,
  canonicalJson,
} from "./canonical-json.js";

const fhirIdSchema = z.string().regex(/^[A-Za-z0-9\-.]{1,64}$/);
const opaqueReferenceSchema = z.string().min(1).max(1_024).regex(/^[^\r\n\0]+$/);
const fhirStringSchema = z.string().max(64 * 1_024);
const fhirUriSchema = z.string().max(8_192);
const instantSchema = z.string().datetime({ offset: true });

export const fhirPeriodSchema = z.object({
  start: fhirStringSchema.optional(),
  end: fhirStringSchema.optional(),
}).passthrough();

export const fhirCodingSchema = z.object({
  system: fhirUriSchema.optional(),
  version: fhirStringSchema.optional(),
  code: fhirStringSchema.optional(),
  display: fhirStringSchema.optional(),
  userSelected: z.boolean().optional(),
}).passthrough();

export const fhirCodeableConceptSchema = z.object({
  coding: z.array(fhirCodingSchema).max(1_024).optional(),
  text: fhirStringSchema.optional(),
}).passthrough();

export const fhirIdentifierSchema = z.object({
  use: z.enum(["usual", "official", "temp", "secondary", "old"]).optional(),
  type: fhirCodeableConceptSchema.optional(),
  system: fhirUriSchema.optional(),
  value: fhirStringSchema.optional(),
  period: fhirPeriodSchema.optional(),
}).passthrough();

export const fhirReferenceSchema = z.object({
  reference: fhirStringSchema.optional(),
  type: fhirUriSchema.optional(),
  identifier: fhirIdentifierSchema.optional(),
  display: fhirStringSchema.optional(),
}).passthrough();

export const fhirContactPointSchema = z.object({
  system: z.enum(["phone", "fax", "email", "pager", "url", "sms", "other"]).optional(),
  value: fhirStringSchema.optional(),
  use: z.enum(["home", "work", "temp", "old", "mobile"]).optional(),
  rank: z.number().int().positive().optional(),
  period: fhirPeriodSchema.optional(),
}).passthrough();

export const fhirAnnotationSchema = z.object({
  authorReference: fhirReferenceSchema.optional(),
  authorString: fhirStringSchema.optional(),
  time: fhirStringSchema.optional(),
  text: fhirStringSchema,
}).passthrough();

export const careTeamParticipantSchema = z.object({
  role: z.array(fhirCodeableConceptSchema).max(1_024).optional(),
  member: fhirReferenceSchema.optional(),
  onBehalfOf: fhirReferenceSchema.optional(),
  period: fhirPeriodSchema.optional(),
}).passthrough();

const fhirMetaSchema = z.object({
  versionId: fhirIdSchema.optional(),
  lastUpdated: instantSchema.optional(),
  source: fhirUriSchema.optional(),
  profile: z.array(fhirUriSchema).max(1_024).optional(),
  security: z.array(fhirCodingSchema).max(1_024).optional(),
  tag: z.array(fhirCodingSchema).max(1_024).optional(),
}).passthrough();

/**
 * A retrieved R4 CareTeam. Every object is passthrough so extensions and
 * source-specific fields survive validation and can remain in the raw vault.
 */
export const careTeamResourceSchema = z.object({
  resourceType: z.literal("CareTeam"),
  id: fhirIdSchema,
  meta: fhirMetaSchema.optional(),
  identifier: z.array(fhirIdentifierSchema).max(1_024).optional(),
  status: z.enum(["proposed", "active", "suspended", "inactive", "entered-in-error"]).optional(),
  category: z.array(fhirCodeableConceptSchema).max(1_024).optional(),
  name: fhirStringSchema.optional(),
  subject: fhirReferenceSchema.optional(),
  encounter: fhirReferenceSchema.optional(),
  period: fhirPeriodSchema.optional(),
  participant: z.array(careTeamParticipantSchema).max(10_000).optional(),
  reasonCode: z.array(fhirCodeableConceptSchema).max(1_024).optional(),
  reasonReference: z.array(fhirReferenceSchema).max(1_024).optional(),
  managingOrganization: z.array(fhirReferenceSchema).max(1_024).optional(),
  telecom: z.array(fhirContactPointSchema).max(1_024).optional(),
  note: z.array(fhirAnnotationSchema).max(10_000).optional(),
}).passthrough();

export type CareTeamResource = z.infer<typeof careTeamResourceSchema>;

/** A stable citation to the exact persisted source version behind a record. */
export const sourceResourceVersionRefSchema = z.object({
  accountRef: opaqueReferenceSchema,
  sourceConnectionId: opaqueReferenceSchema,
  patientSubjectId: opaqueReferenceSchema,
  fhirIssuer: z.string().url().max(8_192),
  resourceType: z.string().regex(/^[A-Z][A-Za-z0-9]{0,63}$/),
  resourceId: fhirIdSchema,
  versionId: fhirIdSchema.optional(),
  lastUpdated: instantSchema.optional(),
  retrievedAt: instantSchema,
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).passthrough();

export type SourceResourceVersionRef = z.infer<typeof sourceResourceVersionRefSchema>;

export const normalizedCareTeamParticipantSchema = z.object({
  roles: z.array(fhirCodeableConceptSchema).max(1_024),
  member: fhirReferenceSchema.optional(),
  onBehalfOf: fhirReferenceSchema.optional(),
  period: fhirPeriodSchema.optional(),
  raw: careTeamParticipantSchema,
}).passthrough();

const normalizedCareTeamBaseSchema = z.object({
  accountRef: opaqueReferenceSchema,
  sourceConnectionId: opaqueReferenceSchema,
  patientSubjectId: opaqueReferenceSchema,
  provenance: sourceResourceVersionRefSchema,
  resourceType: z.literal("CareTeam"),
  resourceId: fhirIdSchema,
  status: z.enum(["proposed", "active", "suspended", "inactive", "entered-in-error"]).optional(),
  name: fhirStringSchema.optional(),
  identifiers: z.array(fhirIdentifierSchema).max(1_024),
  categories: z.array(fhirCodeableConceptSchema).max(1_024),
  subject: fhirReferenceSchema.optional(),
  encounter: fhirReferenceSchema.optional(),
  period: fhirPeriodSchema.optional(),
  participants: z.array(normalizedCareTeamParticipantSchema).max(10_000),
  reasonCodes: z.array(fhirCodeableConceptSchema).max(1_024),
  reasonReferences: z.array(fhirReferenceSchema).max(1_024),
  managingOrganizations: z.array(fhirReferenceSchema).max(1_024),
  telecom: z.array(fhirContactPointSchema).max(1_024),
  notes: z.array(fhirAnnotationSchema).max(10_000),
  raw: careTeamResourceSchema,
}).passthrough();

function addMismatch(
  context: z.core.$RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

function contentHashForRaw(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function buildCareTeamProjection(
  resource: CareTeamResource,
  provenance: SourceResourceVersionRef,
): Record<string, unknown> {
  const participants = (resource.participant ?? []).map((participant) => ({
    roles: participant.role ?? [],
    ...(participant.member === undefined ? {} : { member: participant.member }),
    ...(participant.onBehalfOf === undefined ? {} : { onBehalfOf: participant.onBehalfOf }),
    ...(participant.period === undefined ? {} : { period: participant.period }),
    raw: participant,
  }));
  return {
    accountRef: provenance.accountRef,
    sourceConnectionId: provenance.sourceConnectionId,
    patientSubjectId: provenance.patientSubjectId,
    provenance,
    resourceType: resource.resourceType,
    resourceId: resource.id,
    ...(resource.status === undefined ? {} : { status: resource.status }),
    ...(resource.name === undefined ? {} : { name: resource.name }),
    identifiers: resource.identifier ?? [],
    categories: resource.category ?? [],
    ...(resource.subject === undefined ? {} : { subject: resource.subject }),
    ...(resource.encounter === undefined ? {} : { encounter: resource.encounter }),
    ...(resource.period === undefined ? {} : { period: resource.period }),
    participants,
    reasonCodes: resource.reasonCode ?? [],
    reasonReferences: resource.reasonReference ?? [],
    managingOrganizations: resource.managingOrganization ?? [],
    telecom: resource.telecom ?? [],
    notes: resource.note ?? [],
    raw: resource,
  };
}

function hasUninterpretedModifierSemantics(resource: CareTeamResource): boolean {
  const modifierExtension = resource.modifierExtension;
  if (modifierExtension !== undefined && (
    !Array.isArray(modifierExtension) || modifierExtension.length > 0
  )) return true;
  if (resource.implicitRules !== undefined) return true;
  return (resource.participant ?? []).some((participant) => {
    const participantModifier = participant.modifierExtension;
    return participantModifier !== undefined && (
      !Array.isArray(participantModifier) || participantModifier.length > 0
    );
  });
}

export const normalizedCareTeamSchema = normalizedCareTeamBaseSchema.superRefine((value, context) => {
  if (hasUninterpretedModifierSemantics(value.raw)) {
    addMismatch(
      context,
      ["raw"],
      "CareTeam modifier semantics must be understood before creating a projection.",
    );
  }
  if (value.accountRef !== value.provenance.accountRef) {
    addMismatch(context, ["accountRef"], "Account reference does not match provenance.");
  }
  if (value.sourceConnectionId !== value.provenance.sourceConnectionId) {
    addMismatch(context, ["sourceConnectionId"], "Source connection does not match provenance.");
  }
  if (value.patientSubjectId !== value.provenance.patientSubjectId) {
    addMismatch(context, ["patientSubjectId"], "Patient subject does not match provenance.");
  }
  if (value.resourceType !== value.provenance.resourceType || value.raw.resourceType !== value.resourceType) {
    addMismatch(context, ["provenance", "resourceType"], "Resource type does not match the CareTeam.");
  }
  if (value.resourceId !== value.provenance.resourceId || value.raw.id !== value.resourceId) {
    addMismatch(context, ["provenance", "resourceId"], "Resource ID does not match the CareTeam.");
  }
  const rawVersionId = value.raw.meta?.versionId;
  if (value.provenance.versionId !== rawVersionId) {
    addMismatch(context, ["provenance", "versionId"], "FHIR version ID does not match the CareTeam metadata.");
  }
  const rawLastUpdated = value.raw.meta?.lastUpdated;
  if (value.provenance.lastUpdated !== rawLastUpdated) {
    addMismatch(context, ["provenance", "lastUpdated"], "Last-updated time does not match the CareTeam metadata.");
  }
  try {
    if (contentHashForRaw(value.raw) !== value.provenance.contentHash) {
      addMismatch(context, ["provenance", "contentHash"], "Content hash does not match the raw CareTeam.");
    }
    const expected = buildCareTeamProjection(value.raw, value.provenance);
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (canonicalComparableJson(value[key as keyof typeof value]) !==
        canonicalComparableJson(expectedValue)) {
        addMismatch(context, [key], "Projected CareTeam data does not match the raw resource.");
      }
    }
  } catch {
    addMismatch(context, ["raw"], "The CareTeam projection contains a non-JSON value.");
  }
});

export type NormalizedCareTeam = z.infer<typeof normalizedCareTeamSchema>;

const userConfirmationSchema = z.object({
  decision: z.enum(["confirmed", "corrected", "dismissed"]),
  accountRef: opaqueReferenceSchema,
  recordedAt: instantSchema,
  note: fhirStringSchema.optional(),
}).passthrough();

const insightGeneratorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rules"),
    rulesVersion: opaqueReferenceSchema,
  }).passthrough(),
  z.object({
    kind: z.literal("model"),
    provider: opaqueReferenceSchema,
    model: opaqueReferenceSchema,
    modelVersion: opaqueReferenceSchema,
    promptVersion: opaqueReferenceSchema,
  }).passthrough(),
]);

const insightRecordBaseSchema = z.object({
  insightId: opaqueReferenceSchema,
  accountRef: opaqueReferenceSchema,
  patientSubjectId: opaqueReferenceSchema,
  insightType: opaqueReferenceSchema,
  insight: z.string().min(1).max(1024 * 1024),
  sourceResourceVersions: z.array(sourceResourceVersionRefSchema).min(1).max(1_024),
  generatedAt: instantSchema,
  generator: insightGeneratorSchema,
  confidence: z.number().min(0).max(1).optional(),
  status: z.enum(["generated", "reviewed", "confirmed", "dismissed", "superseded"]),
  userConfirmation: userConfirmationSchema.optional(),
  supersedesInsightId: opaqueReferenceSchema.optional(),
}).passthrough();

export const insightRecordSchema = insightRecordBaseSchema.superRefine((value, context) => {
  for (const [index, source] of value.sourceResourceVersions.entries()) {
    if (source.accountRef !== value.accountRef) {
      addMismatch(context, ["sourceResourceVersions", index, "accountRef"], "Insight source belongs to another account.");
    }
    if (source.patientSubjectId !== value.patientSubjectId) {
      addMismatch(context, ["sourceResourceVersions", index, "patientSubjectId"], "Insight source belongs to another patient.");
    }
  }
  if (value.userConfirmation !== undefined && value.userConfirmation.accountRef !== value.accountRef) {
    addMismatch(context, ["userConfirmation", "accountRef"], "Confirmation belongs to another account.");
  }
  if (value.status === "confirmed" && (
    value.userConfirmation === undefined || value.userConfirmation.decision === "dismissed"
  )) {
    addMismatch(context, ["userConfirmation"], "A confirmed insight requires a confirming or correcting decision.");
  }
  if (value.status === "dismissed" && value.userConfirmation?.decision !== "dismissed") {
    addMismatch(context, ["userConfirmation"], "A dismissed insight requires a dismissal decision.");
  }
  if (
    value.userConfirmation !== undefined &&
    value.status !== "confirmed" &&
    value.status !== "dismissed" &&
    value.status !== "superseded"
  ) {
    addMismatch(context, ["status"], "Only confirmed, dismissed, or superseded insights may retain a decision.");
  }
  if (value.supersedesInsightId === value.insightId) {
    addMismatch(context, ["supersedesInsightId"], "An insight cannot supersede itself.");
  }
});

export type InsightRecord = z.infer<typeof insightRecordSchema>;

export function parseCareTeamResource(value: unknown): CareTeamResource {
  return careTeamResourceSchema.parse(value);
}

export function parseSourceResourceVersionRef(value: unknown): SourceResourceVersionRef {
  return sourceResourceVersionRefSchema.parse(value);
}

export function parseNormalizedCareTeam(value: unknown): NormalizedCareTeam {
  return normalizedCareTeamSchema.parse(value);
}

export function parseInsightRecord(value: unknown): InsightRecord {
  return insightRecordSchema.parse(value);
}

/**
 * Builds a query-friendly projection using only fields explicitly present in
 * the resource. The validated raw CareTeam remains attached and unaltered.
 */
export function normalizeCareTeam(
  raw: unknown,
  provenanceInput: SourceResourceVersionRef,
): NormalizedCareTeam {
  const resource = careTeamResourceSchema.parse(raw);
  if (hasUninterpretedModifierSemantics(resource)) {
    throw new Error("CareTeam modifier semantics must be understood before creating a projection.");
  }
  const provenance = sourceResourceVersionRefSchema.parse(provenanceInput);
  return normalizedCareTeamSchema.parse(buildCareTeamProjection(resource, provenance));
}

function conceptLabel(concept: z.infer<typeof fhirCodeableConceptSchema>): string | undefined {
  if (concept.text !== undefined) return concept.text;
  for (const coding of concept.coding ?? []) {
    if (coding.display !== undefined) return coding.display;
    if (coding.code !== undefined) return coding.code;
  }
  return undefined;
}

function referenceLabel(reference: z.infer<typeof fhirReferenceSchema>): string | undefined {
  return reference.display ?? reference.reference ?? reference.identifier?.value;
}

function periodLabel(period: z.infer<typeof fhirPeriodSchema>): string | undefined {
  if (period.start !== undefined && period.end !== undefined) return `${period.start} to ${period.end}`;
  if (period.start !== undefined) return `from ${period.start}`;
  if (period.end !== undefined) return `through ${period.end}`;
  return undefined;
}

function joinPresent(values: ReadonlyArray<string | undefined>): string | undefined {
  const present = values.filter((value): value is string => value !== undefined);
  return present.length === 0 ? undefined : present.join("; ");
}

/** Creates a deterministic, non-AI summary that cites the exact CareTeam version. */
export function createCareTeamSummaryInsight(
  careTeamInput: NormalizedCareTeam,
  generatedAt: string,
): InsightRecord {
  const careTeam = normalizedCareTeamSchema.parse(careTeamInput);
  const lines = [`Care team: ${careTeam.name ?? careTeam.resourceId}`];
  if (careTeam.status !== undefined) lines.push(`Status: ${careTeam.status}`);
  const categories = joinPresent(careTeam.categories.map(conceptLabel));
  if (categories !== undefined) lines.push(`Categories: ${categories}`);
  const period = careTeam.period === undefined ? undefined : periodLabel(careTeam.period);
  if (period !== undefined) lines.push(`Period: ${period}`);
  const subject = careTeam.subject === undefined ? undefined : referenceLabel(careTeam.subject);
  if (subject !== undefined) lines.push(`Subject: ${subject}`);
  const encounter = careTeam.encounter === undefined ? undefined : referenceLabel(careTeam.encounter);
  if (encounter !== undefined) lines.push(`Encounter: ${encounter}`);

  if (careTeam.participants.length > 0) {
    lines.push("Participants:");
    for (const participant of careTeam.participants) {
      const details: string[] = [];
      const member = participant.member === undefined ? undefined : referenceLabel(participant.member);
      if (member !== undefined) details.push(member);
      const roles = joinPresent(participant.roles.map(conceptLabel));
      if (roles !== undefined) details.push(`roles: ${roles}`);
      const organization = participant.onBehalfOf === undefined
        ? undefined
        : referenceLabel(participant.onBehalfOf);
      if (organization !== undefined) details.push(`on behalf of: ${organization}`);
      const participantPeriod = participant.period === undefined
        ? undefined
        : periodLabel(participant.period);
      if (participantPeriod !== undefined) details.push(`period: ${participantPeriod}`);
      lines.push(`- ${details.length === 0 ? "Participant" : details.join(" | ")}`);
    }
  }

  const organizations = joinPresent(careTeam.managingOrganizations.map(referenceLabel));
  if (organizations !== undefined) lines.push(`Managing organizations: ${organizations}`);
  const reasons = joinPresent([
    ...careTeam.reasonCodes.map(conceptLabel),
    ...careTeam.reasonReferences.map(referenceLabel),
  ]);
  if (reasons !== undefined) lines.push(`Reasons: ${reasons}`);
  const contacts = joinPresent(careTeam.telecom.map((contact) => {
    if (contact.value === undefined) return undefined;
    const qualifiers = joinPresent([contact.system, contact.use]);
    return qualifiers === undefined ? contact.value : `${qualifiers}: ${contact.value}`;
  }));
  if (contacts !== undefined) lines.push(`Contacts: ${contacts}`);
  if (careTeam.notes.length > 0) lines.push(`Notes: ${careTeam.notes.map((note) => note.text).join("; ")}`);

  const completeInsight = lines.join("\n");
  const maximumSummaryCharacters = 256 * 1_024;
  const omittedMarker = "[Additional source details omitted from this summary; review the cited raw CareTeam.]";
  let boundedInsight = completeInsight;
  if (completeInsight.length > maximumSummaryCharacters) {
    const retainedLines: string[] = [];
    let retainedCharacters = 0;
    for (const line of lines) {
      const separatorCharacters = retainedLines.length === 0 ? 0 : 1;
      if (
        retainedCharacters + separatorCharacters + line.length + 1 + omittedMarker.length >
        maximumSummaryCharacters
      ) break;
      retainedLines.push(line);
      retainedCharacters += separatorCharacters + line.length;
    }
    boundedInsight = [...retainedLines, omittedMarker].join("\n");
  }

  return insightRecordSchema.parse({
    insightId: `care-team-summary:v1:${careTeam.provenance.contentHash.slice("sha256:".length)}`,
    accountRef: careTeam.accountRef,
    patientSubjectId: careTeam.patientSubjectId,
    insightType: "care-team-summary",
    insight: boundedInsight,
    sourceResourceVersions: [careTeam.provenance],
    generatedAt,
    generator: {
      kind: "rules",
      rulesVersion: "care-team-summary-v1",
    },
    status: "generated",
  });
}
