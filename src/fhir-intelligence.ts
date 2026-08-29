import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "./canonical-json.js";

import {
  fhirAnnotationSchema,
  fhirCodeableConceptSchema,
  fhirCodingSchema,
  fhirContactPointSchema,
  fhirIdentifierSchema,
  fhirPeriodSchema,
  fhirReferenceSchema,
  insightRecordSchema,
  sourceResourceVersionRefSchema,
  type InsightRecord,
  type SourceResourceVersionRef,
} from "./care-team.js";

export const normalizedFhirResourceTypes = [
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
] as const;

export type NormalizedFhirResourceType = typeof normalizedFhirResourceTypes[number];

export type FhirNormalizationErrorCode =
  | "invalid_resource_shape"
  | "unsupported_resource_type"
  | "unsupported_modifier_semantics";

export class FhirNormalizationError extends Error {
  public constructor(
    public readonly code: FhirNormalizationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FhirNormalizationError";
  }
}

const supportedResourceTypeSchema = z.enum(normalizedFhirResourceTypes);
const fhirIdSchema = z.string().regex(/^[A-Za-z0-9\-.]{1,64}$/);
const opaqueReferenceSchema = z.string().min(1).max(1_024).regex(/^[^\r\n\0]+$/);
const instantSchema = z.string().datetime({ offset: true });
const boundedStringSchema = z.string().max(64 * 1_024);

const fhirMetaSchema = z.object({
  versionId: fhirIdSchema.optional(),
  lastUpdated: instantSchema.optional(),
}).passthrough();

const supportedResourceSchema = z.object({
  resourceType: supportedResourceTypeSchema,
  id: fhirIdSchema,
  meta: fhirMetaSchema.optional(),
}).passthrough();

const normalizedTextValueSchema = z.object({
  kind: z.literal("text"),
  display: boundedStringSchema,
  truncated: z.literal(true).optional(),
}).strict();

const normalizedCodeValueSchema = z.object({
  kind: z.literal("code"),
  display: boundedStringSchema,
  system: boundedStringSchema.optional(),
  code: boundedStringSchema.optional(),
  truncated: z.literal(true).optional(),
}).strict();

const normalizedReferenceValueSchema = z.object({
  kind: z.literal("reference"),
  display: boundedStringSchema,
  reference: boundedStringSchema.optional(),
  referenceType: boundedStringSchema.optional(),
  truncated: z.literal(true).optional(),
}).strict();

const normalizedTemporalValueSchema = z.object({
  kind: z.literal("temporal"),
  display: boundedStringSchema,
  start: boundedStringSchema.optional(),
  end: boundedStringSchema.optional(),
  truncated: z.literal(true).optional(),
}).strict();

const normalizedQuantityValueSchema = z.object({
  kind: z.literal("quantity"),
  display: boundedStringSchema,
  value: z.number().finite().optional(),
  comparator: boundedStringSchema.optional(),
  unit: boundedStringSchema.optional(),
  system: boundedStringSchema.optional(),
  code: boundedStringSchema.optional(),
  truncated: z.literal(true).optional(),
}).strict();

const normalizedBooleanValueSchema = z.object({
  kind: z.literal("boolean"),
  display: boundedStringSchema,
  value: z.boolean(),
}).strict();

const normalizedNumberValueSchema = z.object({
  kind: z.literal("number"),
  display: boundedStringSchema,
  value: z.number().finite(),
}).strict();

export const normalizedFhirValueSchema = z.discriminatedUnion("kind", [
  normalizedTextValueSchema,
  normalizedCodeValueSchema,
  normalizedReferenceValueSchema,
  normalizedTemporalValueSchema,
  normalizedQuantityValueSchema,
  normalizedBooleanValueSchema,
  normalizedNumberValueSchema,
]);

export type NormalizedFhirValue = z.infer<typeof normalizedFhirValueSchema>;

export const normalizedFhirFactSchema = z.object({
  sourcePath: z.string().regex(/^[A-Z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*(?:\[\])?)*$/),
  label: z.string().min(1).max(256),
  values: z.array(normalizedFhirValueSchema).min(1).max(256),
  omittedValues: z.number().int().positive().optional(),
}).strict();

export type NormalizedFhirFact = z.infer<typeof normalizedFhirFactSchema>;

const normalizedFhirResourceBaseSchema = z.object({
  schemaVersion: z.literal(1),
  accountRef: opaqueReferenceSchema,
  sourceConnectionId: opaqueReferenceSchema,
  patientSubjectId: opaqueReferenceSchema,
  provenance: sourceResourceVersionRefSchema,
  resourceType: supportedResourceTypeSchema,
  resourceId: fhirIdSchema,
  resourceLabel: z.string().min(1).max(256),
  headline: boundedStringSchema,
  facts: z.array(normalizedFhirFactSchema).max(256),
  warnings: z.array(z.string().min(1).max(1_024)).max(32),
}).strict();

function addMismatch(
  context: z.core.$RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

export const normalizedFhirResourceSchema = normalizedFhirResourceBaseSchema.superRefine(
  (value, context) => {
    if (value.accountRef !== value.provenance.accountRef) {
      addMismatch(context, ["accountRef"], "Account reference does not match provenance.");
    }
    if (value.sourceConnectionId !== value.provenance.sourceConnectionId) {
      addMismatch(context, ["sourceConnectionId"], "Source connection does not match provenance.");
    }
    if (value.patientSubjectId !== value.provenance.patientSubjectId) {
      addMismatch(context, ["patientSubjectId"], "Patient subject does not match provenance.");
    }
    if (
      value.resourceType !== value.provenance.resourceType
    ) {
      addMismatch(context, ["provenance", "resourceType"], "Resource type does not match provenance.");
    }
    if (
      value.resourceId !== value.provenance.resourceId
    ) {
      addMismatch(context, ["provenance", "resourceId"], "Resource ID does not match provenance.");
    }
  },
);

export type NormalizedFhirResource = z.infer<typeof normalizedFhirResourceSchema>;

type FactKind =
  | "primitive"
  | "concept"
  | "coding"
  | "reference"
  | "period"
  | "quantity"
  | "range"
  | "ratio"
  | "identifier"
  | "humanName"
  | "address"
  | "contact"
  | "annotation"
  | "attachment";

interface FactDefinition {
  readonly path: string;
  readonly label: string;
  readonly kind: FactKind;
  readonly headline?: true;
}

interface ResourceDefinition {
  readonly label: string;
  readonly facts: readonly FactDefinition[];
}

function fact(
  path: string,
  label: string,
  kind: FactKind,
  headline = false,
): FactDefinition {
  return { path, label, kind, ...(headline ? { headline: true as const } : {}) };
}

const resourceDefinitions: Readonly<Record<NormalizedFhirResourceType, ResourceDefinition>> = {
  AllergyIntolerance: {
    label: "Allergy or intolerance",
    facts: [
      fact("code", "Allergy or intolerance", "concept", true),
      fact("clinicalStatus", "Clinical status", "concept"),
      fact("verificationStatus", "Verification status", "concept"),
      fact("type", "Type", "primitive"),
      fact("category", "Category", "primitive"),
      fact("criticality", "Criticality", "primitive"),
      fact("patient", "Patient", "reference"),
      fact("encounter", "Encounter", "reference"),
      fact("onsetDateTime", "Onset", "primitive"),
      fact("onsetAge", "Onset age", "quantity"),
      fact("onsetPeriod", "Onset period", "period"),
      fact("onsetRange", "Onset range", "range"),
      fact("onsetString", "Onset", "primitive"),
      fact("recordedDate", "Recorded", "primitive"),
      fact("recorder", "Recorder", "reference"),
      fact("asserter", "Asserter", "reference"),
      fact("lastOccurrence", "Last occurrence", "primitive"),
      fact("reaction.substance", "Reaction substance", "concept"),
      fact("reaction.manifestation", "Reaction manifestation", "concept"),
      fact("reaction.description", "Reaction description", "primitive"),
      fact("reaction.onset", "Reaction onset", "primitive"),
      fact("reaction.severity", "Reaction severity", "primitive"),
      fact("reaction.exposureRoute", "Exposure route", "concept"),
      fact("reaction.note", "Reaction note", "annotation"),
      fact("note", "Note", "annotation"),
    ],
  },
  Binary: {
    label: "Binary document",
    facts: [
      fact("contentType", "Content type", "primitive", true),
      fact("securityContext", "Security context", "reference"),
    ],
  },
  CarePlan: {
    label: "Care plan",
    facts: [
      fact("title", "Title", "primitive", true),
      fact("status", "Status", "primitive"),
      fact("intent", "Intent", "primitive"),
      fact("category", "Category", "concept"),
      fact("description", "Description", "primitive"),
      fact("subject", "Subject", "reference"),
      fact("encounter", "Encounter", "reference"),
      fact("period", "Period", "period"),
      fact("created", "Created", "primitive"),
      fact("author", "Author", "reference"),
      fact("contributor", "Contributor", "reference"),
      fact("careTeam", "Care team", "reference"),
      fact("addresses", "Addresses", "reference"),
      fact("supportingInfo", "Supporting information", "reference"),
      fact("goal", "Goal", "reference"),
      fact("activity.outcomeCodeableConcept", "Activity outcome", "concept"),
      fact("activity.outcomeReference", "Activity outcome", "reference"),
      fact("activity.progress", "Activity progress", "annotation"),
      fact("activity.reference", "Activity definition", "reference"),
      fact("activity.detail.status", "Activity status", "primitive"),
      fact("activity.detail.statusReason", "Activity status reason", "concept"),
      fact("activity.detail.doNotPerform", "Do not perform", "primitive"),
      fact("activity.detail.code", "Activity", "concept"),
      fact("activity.detail.reasonCode", "Activity reason", "concept"),
      fact("activity.detail.reasonReference", "Activity reason", "reference"),
      fact("activity.detail.location", "Activity location", "reference"),
      fact("activity.detail.performer", "Activity performer", "reference"),
      fact("activity.detail.scheduledPeriod", "Activity schedule", "period"),
      fact("activity.detail.scheduledString", "Activity schedule", "primitive"),
      fact("activity.detail.productCodeableConcept", "Activity product", "concept"),
      fact("activity.detail.productReference", "Activity product", "reference"),
      fact("note", "Note", "annotation"),
    ],
  },
  CareTeam: {
    label: "Care team",
    facts: [
      fact("name", "Name", "primitive", true),
      fact("status", "Status", "primitive"),
      fact("category", "Category", "concept"),
      fact("subject", "Subject", "reference"),
      fact("encounter", "Encounter", "reference"),
      fact("period", "Period", "period"),
      fact("participant.role", "Participant role", "concept"),
      fact("participant.member", "Participant", "reference"),
      fact("participant.onBehalfOf", "Participant organization", "reference"),
      fact("reasonCode", "Reason", "concept"),
      fact("reasonReference", "Reason", "reference"),
      fact("managingOrganization", "Managing organization", "reference"),
      fact("telecom", "Contact", "contact"),
      fact("note", "Note", "annotation"),
    ],
  },
  Condition: {
    label: "Condition",
    facts: [
      fact("code", "Condition", "concept", true),
      fact("clinicalStatus", "Clinical status", "concept"),
      fact("verificationStatus", "Verification status", "concept"),
      fact("category", "Category", "concept"),
      fact("severity", "Severity", "concept"),
      fact("bodySite", "Body site", "concept"),
      fact("subject", "Subject", "reference"),
      fact("encounter", "Encounter", "reference"),
      fact("onsetDateTime", "Onset", "primitive"),
      fact("onsetAge", "Onset age", "quantity"),
      fact("onsetPeriod", "Onset period", "period"),
      fact("onsetRange", "Onset range", "range"),
      fact("onsetString", "Onset", "primitive"),
      fact("abatementDateTime", "Abatement", "primitive"),
      fact("abatementAge", "Abatement age", "quantity"),
      fact("abatementPeriod", "Abatement period", "period"),
      fact("abatementRange", "Abatement range", "range"),
      fact("abatementString", "Abatement", "primitive"),
      fact("recordedDate", "Recorded", "primitive"),
      fact("recorder", "Recorder", "reference"),
      fact("asserter", "Asserter", "reference"),
      fact("stage.summary", "Stage", "concept"),
      fact("stage.assessment", "Stage assessment", "reference"),
      fact("evidence.code", "Evidence", "concept"),
      fact("evidence.detail", "Evidence detail", "reference"),
      fact("note", "Note", "annotation"),
    ],
  },
  Device: {
    label: "Device",
    facts: [
      fact("deviceName.name", "Device name", "primitive", true),
      fact("type", "Type", "concept"),
      fact("status", "Status", "primitive"),
      fact("statusReason", "Status reason", "concept"),
      fact("manufacturer", "Manufacturer", "primitive"),
      fact("modelNumber", "Model", "primitive"),
      fact("partNumber", "Part number", "primitive"),
      fact("lotNumber", "Lot number", "primitive"),
      fact("serialNumber", "Serial number", "primitive"),
      fact("manufactureDate", "Manufactured", "primitive"),
      fact("expirationDate", "Expires", "primitive"),
      fact("version.value", "Version", "primitive"),
      fact("patient", "Patient", "reference"),
      fact("owner", "Owner", "reference"),
      fact("location", "Location", "reference"),
      fact("contact", "Contact", "contact"),
      fact("safety", "Safety", "concept"),
      fact("parent", "Parent device", "reference"),
      fact("note", "Note", "annotation"),
    ],
  },
  DiagnosticReport: {
    label: "Diagnostic report",
    facts: [
      fact("code", "Report", "concept", true),
      fact("status", "Status", "primitive"),
      fact("category", "Category", "concept"),
      fact("basedOn", "Based on", "reference"),
      fact("subject", "Subject", "reference"),
      fact("encounter", "Encounter", "reference"),
      fact("effectiveDateTime", "Effective", "primitive"),
      fact("effectivePeriod", "Effective period", "period"),
      fact("issued", "Issued", "primitive"),
      fact("performer", "Performer", "reference"),
      fact("resultsInterpreter", "Results interpreter", "reference"),
      fact("specimen", "Specimen", "reference"),
      fact("result", "Result", "reference"),
      fact("imagingStudy", "Imaging study", "reference"),
      fact("media.comment", "Media comment", "primitive"),
      fact("media.link", "Media", "reference"),
      fact("conclusion", "Conclusion", "primitive"),
      fact("conclusionCode", "Coded conclusion", "concept"),
      fact("presentedForm", "Presented form", "attachment"),
    ],
  },
  DocumentReference: {
    label: "Document",
    facts: [
      fact("description", "Description", "primitive", true),
      fact("type", "Type", "concept"),
      fact("status", "Status", "primitive"),
      fact("docStatus", "Document status", "primitive"),
      fact("category", "Category", "concept"),
      fact("subject", "Subject", "reference"),
      fact("date", "Indexed", "primitive"),
      fact("author", "Author", "reference"),
      fact("authenticator", "Authenticator", "reference"),
      fact("custodian", "Custodian", "reference"),
      fact("relatesTo.target", "Related document", "reference"),
      fact("securityLabel", "Security label", "concept"),
      fact("content.attachment", "Content", "attachment"),
      fact("content.format", "Format", "coding"),
      fact("context.encounter", "Encounter", "reference"),
      fact("context.event", "Event", "concept"),
      fact("context.period", "Context period", "period"),
      fact("context.facilityType", "Facility type", "concept"),
      fact("context.practiceSetting", "Practice setting", "concept"),
      fact("context.sourcePatientInfo", "Source patient", "reference"),
      fact("context.related", "Related resource", "reference"),
    ],
  },
  Encounter: {
    label: "Encounter",
    facts: [
      fact("type", "Encounter type", "concept", true),
      fact("status", "Status", "primitive"),
      fact("class", "Class", "coding"),
      fact("serviceType", "Service type", "concept"),
      fact("priority", "Priority", "concept"),
      fact("subject", "Subject", "reference"),
      fact("episodeOfCare", "Episode of care", "reference"),
      fact("basedOn", "Based on", "reference"),
      fact("participant.type", "Participant type", "concept"),
      fact("participant.individual", "Participant", "reference"),
      fact("appointment", "Appointment", "reference"),
      fact("period", "Period", "period"),
      fact("length", "Length", "quantity"),
      fact("reasonCode", "Reason", "concept"),
      fact("reasonReference", "Reason", "reference"),
      fact("diagnosis.condition", "Diagnosis", "reference"),
      fact("diagnosis.use", "Diagnosis use", "concept"),
      fact("hospitalization.origin", "Origin", "reference"),
      fact("hospitalization.admitSource", "Admit source", "concept"),
      fact("hospitalization.destination", "Destination", "reference"),
      fact("hospitalization.dischargeDisposition", "Discharge disposition", "concept"),
      fact("location.location", "Location", "reference"),
      fact("location.status", "Location status", "primitive"),
      fact("serviceProvider", "Service provider", "reference"),
      fact("partOf", "Part of", "reference"),
    ],
  },
  Goal: {
    label: "Goal",
    facts: [
      fact("description", "Goal", "concept", true),
      fact("lifecycleStatus", "Lifecycle status", "primitive"),
      fact("achievementStatus", "Achievement status", "concept"),
      fact("category", "Category", "concept"),
      fact("priority", "Priority", "concept"),
      fact("subject", "Subject", "reference"),
      fact("startDate", "Start", "primitive"),
      fact("startCodeableConcept", "Start", "concept"),
      fact("target.measure", "Target measure", "concept"),
      fact("target.detailQuantity", "Target", "quantity"),
      fact("target.detailRange", "Target range", "range"),
      fact("target.detailCodeableConcept", "Target", "concept"),
      fact("target.detailString", "Target", "primitive"),
      fact("target.detailBoolean", "Target", "primitive"),
      fact("target.detailInteger", "Target", "primitive"),
      fact("target.detailRatio", "Target", "ratio"),
      fact("target.dueDate", "Target due", "primitive"),
      fact("target.dueDuration", "Target due", "quantity"),
      fact("statusDate", "Status date", "primitive"),
      fact("statusReason", "Status reason", "primitive"),
      fact("expressedBy", "Expressed by", "reference"),
      fact("addresses", "Addresses", "reference"),
      fact("note", "Note", "annotation"),
      fact("outcomeCode", "Outcome", "concept"),
      fact("outcomeReference", "Outcome", "reference"),
    ],
  },
  Immunization: {
    label: "Immunization",
    facts: [
      fact("vaccineCode", "Vaccine", "concept", true),
      fact("status", "Status", "primitive"),
      fact("statusReason", "Status reason", "concept"),
      fact("patient", "Patient", "reference"),
      fact("encounter", "Encounter", "reference"),
      fact("occurrenceDateTime", "Occurrence", "primitive"),
      fact("occurrenceString", "Occurrence", "primitive"),
      fact("recorded", "Recorded", "primitive"),
      fact("primarySource", "Primary source", "primitive"),
      fact("reportOrigin", "Report origin", "concept"),
      fact("location", "Location", "reference"),
      fact("manufacturer", "Manufacturer", "reference"),
      fact("lotNumber", "Lot number", "primitive"),
      fact("expirationDate", "Expiration", "primitive"),
      fact("site", "Site", "concept"),
      fact("route", "Route", "concept"),
      fact("doseQuantity", "Dose", "quantity"),
      fact("performer.actor", "Performer", "reference"),
      fact("reasonCode", "Reason", "concept"),
      fact("reasonReference", "Reason", "reference"),
      fact("isSubpotent", "Subpotent", "primitive"),
      fact("subpotentReason", "Subpotent reason", "concept"),
      fact("programEligibility", "Program eligibility", "concept"),
      fact("fundingSource", "Funding source", "concept"),
      fact("reaction.date", "Reaction date", "primitive"),
      fact("reaction.detail", "Reaction detail", "reference"),
      fact("reaction.reported", "Reaction reported", "primitive"),
      fact("protocolApplied.series", "Series", "primitive"),
      fact("protocolApplied.doseNumberPositiveInt", "Dose number", "primitive"),
      fact("protocolApplied.doseNumberString", "Dose number", "primitive"),
      fact("protocolApplied.seriesDosesPositiveInt", "Series doses", "primitive"),
      fact("protocolApplied.seriesDosesString", "Series doses", "primitive"),
      fact("note", "Note", "annotation"),
    ],
  },
  Location: {
    label: "Location",
    facts: [
      fact("name", "Name", "primitive", true),
      fact("status", "Status", "primitive"),
      fact("operationalStatus", "Operational status", "coding"),
      fact("alias", "Alias", "primitive"),
      fact("description", "Description", "primitive"),
      fact("mode", "Mode", "primitive"),
      fact("type", "Type", "concept"),
      fact("telecom", "Contact", "contact"),
      fact("address", "Address", "address"),
      fact("physicalType", "Physical type", "concept"),
      fact("managingOrganization", "Managing organization", "reference"),
      fact("partOf", "Part of", "reference"),
      fact("hoursOfOperation.daysOfWeek", "Open days", "primitive"),
      fact("hoursOfOperation.allDay", "Open all day", "primitive"),
      fact("hoursOfOperation.openingTime", "Opening time", "primitive"),
      fact("hoursOfOperation.closingTime", "Closing time", "primitive"),
      fact("availabilityExceptions", "Availability exceptions", "primitive"),
      fact("endpoint", "Endpoint", "reference"),
    ],
  },
  Medication: {
    label: "Medication",
    facts: [
      fact("code", "Medication", "concept", true),
      fact("status", "Status", "primitive"),
      fact("manufacturer", "Manufacturer", "reference"),
      fact("form", "Form", "concept"),
      fact("amount", "Amount", "ratio"),
      fact("ingredient.itemCodeableConcept", "Ingredient", "concept"),
      fact("ingredient.itemReference", "Ingredient", "reference"),
      fact("ingredient.isActive", "Active ingredient", "primitive"),
      fact("ingredient.strength", "Ingredient strength", "ratio"),
      fact("batch.lotNumber", "Lot number", "primitive"),
      fact("batch.expirationDate", "Expiration", "primitive"),
    ],
  },
  MedicationRequest: {
    label: "Medication request",
    facts: [
      fact("medicationCodeableConcept", "Medication", "concept", true),
      fact("medicationReference", "Medication", "reference", true),
      fact("status", "Status", "primitive"),
      fact("statusReason", "Status reason", "concept"),
      fact("intent", "Intent", "primitive"),
      fact("category", "Category", "concept"),
      fact("priority", "Priority", "primitive"),
      fact("doNotPerform", "Do not perform", "primitive"),
      fact("reportedBoolean", "Reported", "primitive"),
      fact("reportedReference", "Reported by", "reference"),
      fact("subject", "Subject", "reference"),
      fact("encounter", "Encounter", "reference"),
      fact("authoredOn", "Authored", "primitive"),
      fact("requester", "Requester", "reference"),
      fact("performer", "Performer", "reference"),
      fact("performerType", "Performer type", "concept"),
      fact("recorder", "Recorder", "reference"),
      fact("reasonCode", "Reason", "concept"),
      fact("reasonReference", "Reason", "reference"),
      fact("courseOfTherapyType", "Course of therapy", "concept"),
      fact("note", "Note", "annotation"),
      fact("dosageInstruction.text", "Dosage instructions", "primitive"),
      fact("dosageInstruction.patientInstruction", "Patient instructions", "primitive"),
      fact("dosageInstruction.route", "Route", "concept"),
      fact("dosageInstruction.method", "Method", "concept"),
      fact("dosageInstruction.doseAndRate.doseRange", "Dose range", "range"),
      fact("dosageInstruction.doseAndRate.doseQuantity", "Dose", "quantity"),
      fact("dosageInstruction.doseAndRate.rateRatio", "Rate", "ratio"),
      fact("dosageInstruction.doseAndRate.rateRange", "Rate range", "range"),
      fact("dosageInstruction.doseAndRate.rateQuantity", "Rate", "quantity"),
      fact("dispenseRequest.validityPeriod", "Dispense validity", "period"),
      fact("dispenseRequest.numberOfRepeatsAllowed", "Repeats allowed", "primitive"),
      fact("dispenseRequest.quantity", "Dispense quantity", "quantity"),
      fact("dispenseRequest.expectedSupplyDuration", "Expected supply", "quantity"),
      fact("substitution.allowedBoolean", "Substitution allowed", "primitive"),
      fact("substitution.allowedCodeableConcept", "Substitution", "concept"),
      fact("substitution.reason", "Substitution reason", "concept"),
    ],
  },
  Observation: {
    label: "Observation",
    facts: [
      fact("code", "Observation", "concept", true),
      fact("status", "Status", "primitive"),
      fact("category", "Category", "concept"),
      fact("subject", "Subject", "reference"),
      fact("focus", "Focus", "reference"),
      fact("encounter", "Encounter", "reference"),
      fact("effectiveDateTime", "Effective", "primitive"),
      fact("effectivePeriod", "Effective period", "period"),
      fact("effectiveTiming.code", "Effective timing", "concept"),
      fact("effectiveInstant", "Effective", "primitive"),
      fact("issued", "Issued", "primitive"),
      fact("performer", "Performer", "reference"),
      fact("valueQuantity", "Value", "quantity"),
      fact("valueCodeableConcept", "Value", "concept"),
      fact("valueString", "Value", "primitive"),
      fact("valueBoolean", "Value", "primitive"),
      fact("valueInteger", "Value", "primitive"),
      fact("valueRange", "Value range", "range"),
      fact("valueRatio", "Value ratio", "ratio"),
      fact("valueTime", "Value", "primitive"),
      fact("valueDateTime", "Value", "primitive"),
      fact("valuePeriod", "Value period", "period"),
      fact("dataAbsentReason", "Data absent reason", "concept"),
      fact("interpretation", "Interpretation", "concept"),
      fact("note", "Note", "annotation"),
      fact("bodySite", "Body site", "concept"),
      fact("method", "Method", "concept"),
      fact("specimen", "Specimen", "reference"),
      fact("device", "Device", "reference"),
      fact("referenceRange.low", "Reference low", "quantity"),
      fact("referenceRange.high", "Reference high", "quantity"),
      fact("referenceRange.type", "Reference range type", "concept"),
      fact("referenceRange.text", "Reference range", "primitive"),
      fact("hasMember", "Has member", "reference"),
      fact("derivedFrom", "Derived from", "reference"),
      fact("component.code", "Component", "concept"),
      fact("component.valueQuantity", "Component value", "quantity"),
      fact("component.valueCodeableConcept", "Component value", "concept"),
      fact("component.valueString", "Component value", "primitive"),
      fact("component.valueBoolean", "Component value", "primitive"),
      fact("component.valueInteger", "Component value", "primitive"),
      fact("component.valueRange", "Component range", "range"),
      fact("component.valueRatio", "Component ratio", "ratio"),
      fact("component.valueTime", "Component value", "primitive"),
      fact("component.valueDateTime", "Component value", "primitive"),
      fact("component.valuePeriod", "Component period", "period"),
      fact("component.dataAbsentReason", "Component data absent reason", "concept"),
      fact("component.interpretation", "Component interpretation", "concept"),
    ],
  },
  Organization: {
    label: "Organization",
    facts: [
      fact("name", "Name", "primitive", true),
      fact("active", "Active", "primitive"),
      fact("type", "Type", "concept"),
      fact("alias", "Alias", "primitive"),
      fact("telecom", "Contact", "contact"),
      fact("address", "Address", "address"),
      fact("partOf", "Part of", "reference"),
      fact("contact.purpose", "Contact purpose", "concept"),
      fact("contact.name", "Contact name", "humanName"),
      fact("contact.telecom", "Contact details", "contact"),
      fact("contact.address", "Contact address", "address"),
      fact("endpoint", "Endpoint", "reference"),
    ],
  },
  Patient: {
    label: "Patient profile",
    facts: [
      fact("name", "Name", "humanName", true),
      fact("active", "Active", "primitive"),
      fact("telecom", "Contact", "contact"),
      fact("gender", "Administrative gender", "primitive"),
      fact("birthDate", "Birth date", "primitive"),
      fact("deceasedBoolean", "Deceased", "primitive"),
      fact("deceasedDateTime", "Deceased", "primitive"),
      fact("address", "Address", "address"),
      fact("maritalStatus", "Marital status", "concept"),
      fact("multipleBirthBoolean", "Multiple birth", "primitive"),
      fact("multipleBirthInteger", "Birth order", "primitive"),
      fact("contact.relationship", "Contact relationship", "concept"),
      fact("contact.name", "Contact name", "humanName"),
      fact("contact.telecom", "Contact details", "contact"),
      fact("contact.address", "Contact address", "address"),
      fact("contact.gender", "Contact gender", "primitive"),
      fact("communication.language", "Language", "concept"),
      fact("communication.preferred", "Preferred language", "primitive"),
      fact("generalPractitioner", "General practitioner", "reference"),
      fact("managingOrganization", "Managing organization", "reference"),
      fact("link.other", "Linked record", "reference"),
      fact("link.type", "Link type", "primitive"),
    ],
  },
  Practitioner: {
    label: "Practitioner",
    facts: [
      fact("name", "Name", "humanName", true),
      fact("active", "Active", "primitive"),
      fact("telecom", "Contact", "contact"),
      fact("address", "Address", "address"),
      fact("gender", "Administrative gender", "primitive"),
      fact("birthDate", "Birth date", "primitive"),
      fact("photo", "Photo metadata", "attachment"),
      fact("qualification.code", "Qualification", "concept"),
      fact("qualification.period", "Qualification period", "period"),
      fact("qualification.issuer", "Qualification issuer", "reference"),
      fact("communication", "Language", "concept"),
    ],
  },
  PractitionerRole: {
    label: "Practitioner role",
    facts: [
      fact("code", "Role", "concept", true),
      fact("active", "Active", "primitive"),
      fact("period", "Period", "period"),
      fact("practitioner", "Practitioner", "reference"),
      fact("organization", "Organization", "reference"),
      fact("specialty", "Specialty", "concept"),
      fact("location", "Location", "reference"),
      fact("healthcareService", "Healthcare service", "reference"),
      fact("telecom", "Contact", "contact"),
      fact("availableTime.daysOfWeek", "Available days", "primitive"),
      fact("availableTime.allDay", "Available all day", "primitive"),
      fact("availableTime.availableStartTime", "Available from", "primitive"),
      fact("availableTime.availableEndTime", "Available until", "primitive"),
      fact("notAvailable.description", "Not available", "primitive"),
      fact("notAvailable.during", "Unavailable period", "period"),
      fact("availabilityExceptions", "Availability exceptions", "primitive"),
      fact("endpoint", "Endpoint", "reference"),
    ],
  },
  Procedure: {
    label: "Procedure",
    facts: [
      fact("code", "Procedure", "concept", true),
      fact("status", "Status", "primitive"),
      fact("statusReason", "Status reason", "concept"),
      fact("category", "Category", "concept"),
      fact("subject", "Subject", "reference"),
      fact("encounter", "Encounter", "reference"),
      fact("performedDateTime", "Performed", "primitive"),
      fact("performedPeriod", "Performed period", "period"),
      fact("performedString", "Performed", "primitive"),
      fact("performedAge", "Performed age", "quantity"),
      fact("performedRange", "Performed range", "range"),
      fact("recorder", "Recorder", "reference"),
      fact("asserter", "Asserter", "reference"),
      fact("performer.function", "Performer role", "concept"),
      fact("performer.actor", "Performer", "reference"),
      fact("performer.onBehalfOf", "Performer organization", "reference"),
      fact("location", "Location", "reference"),
      fact("reasonCode", "Reason", "concept"),
      fact("reasonReference", "Reason", "reference"),
      fact("bodySite", "Body site", "concept"),
      fact("outcome", "Outcome", "concept"),
      fact("report", "Report", "reference"),
      fact("complication", "Complication", "concept"),
      fact("complicationDetail", "Complication detail", "reference"),
      fact("followUp", "Follow-up", "concept"),
      fact("note", "Note", "annotation"),
      fact("usedReference", "Used resource", "reference"),
      fact("usedCode", "Used item", "concept"),
    ],
  },
  Provenance: {
    label: "Provenance record",
    facts: [
      fact("activity", "Activity", "concept", true),
      fact("target", "Target", "reference"),
      fact("occurredPeriod", "Occurred", "period"),
      fact("occurredDateTime", "Occurred", "primitive"),
      fact("recorded", "Recorded", "primitive"),
      fact("location", "Location", "reference"),
      fact("reason", "Reason", "concept"),
      fact("agent.type", "Agent type", "concept"),
      fact("agent.role", "Agent role", "concept"),
      fact("agent.who", "Agent", "reference"),
      fact("agent.onBehalfOf", "Agent represented", "reference"),
      fact("entity.role", "Entity role", "primitive"),
      fact("entity.what", "Entity", "reference"),
      fact("entity.agent.who", "Entity agent", "reference"),
      fact("signature.type", "Signature type", "coding"),
      fact("signature.when", "Signed", "primitive"),
      fact("signature.who", "Signer", "reference"),
      fact("signature.onBehalfOf", "Signed on behalf of", "reference"),
      fact("signature.sigFormat", "Signature format", "primitive"),
      fact("signature.targetFormat", "Signed content format", "primitive"),
    ],
  },
  RelatedPerson: {
    label: "Related person",
    facts: [
      fact("name", "Name", "humanName", true),
      fact("active", "Active", "primitive"),
      fact("patient", "Patient", "reference"),
      fact("relationship", "Relationship", "concept"),
      fact("telecom", "Contact", "contact"),
      fact("gender", "Administrative gender", "primitive"),
      fact("birthDate", "Birth date", "primitive"),
      fact("address", "Address", "address"),
      fact("photo", "Photo metadata", "attachment"),
      fact("period", "Period", "period"),
      fact("communication.language", "Language", "concept"),
      fact("communication.preferred", "Preferred language", "primitive"),
    ],
  },
};

interface StatusBinding {
  readonly path: string;
  readonly allowed: ReadonlySet<string>;
}

interface RequiredConceptBinding extends StatusBinding {
  readonly system: string;
}

const requiredPaths: Readonly<Partial<Record<NormalizedFhirResourceType, readonly string[]>>> = {
  AllergyIntolerance: ["patient"],
  Binary: ["contentType"],
  CarePlan: ["status", "intent", "subject"],
  Condition: ["subject"],
  DiagnosticReport: ["status", "code"],
  DocumentReference: ["status", "content"],
  Encounter: ["status", "class"],
  Goal: ["lifecycleStatus", "description", "subject"],
  Immunization: ["status", "vaccineCode", "patient"],
  MedicationRequest: ["status", "intent", "subject"],
  Observation: ["status", "code"],
  Procedure: ["status", "subject"],
  Provenance: ["target", "recorded", "agent"],
  RelatedPerson: ["patient"],
};

const choiceGroups: Readonly<Partial<Record<
  NormalizedFhirResourceType,
  readonly { readonly paths: readonly string[]; readonly required?: true }[]
>>> = {
  AllergyIntolerance: [{
    paths: ["onsetDateTime", "onsetAge", "onsetPeriod", "onsetRange", "onsetString"],
  }],
  Condition: [
    { paths: ["onsetDateTime", "onsetAge", "onsetPeriod", "onsetRange", "onsetString"] },
    { paths: ["abatementDateTime", "abatementAge", "abatementPeriod", "abatementRange", "abatementString"] },
  ],
  DiagnosticReport: [{ paths: ["effectiveDateTime", "effectivePeriod"] }],
  Goal: [{ paths: ["startDate", "startCodeableConcept"] }],
  Immunization: [{ paths: ["occurrenceDateTime", "occurrenceString"], required: true }],
  MedicationRequest: [
    { paths: ["medicationCodeableConcept", "medicationReference"], required: true },
    { paths: ["reportedBoolean", "reportedReference"] },
  ],
  Observation: [
    { paths: ["effectiveDateTime", "effectivePeriod", "effectiveTiming", "effectiveInstant"] },
    {
      paths: [
        "valueQuantity",
        "valueCodeableConcept",
        "valueString",
        "valueBoolean",
        "valueInteger",
        "valueRange",
        "valueRatio",
        "valueSampledData",
        "valueTime",
        "valueDateTime",
        "valuePeriod",
      ],
    },
  ],
  Patient: [
    { paths: ["deceasedBoolean", "deceasedDateTime"] },
    { paths: ["multipleBirthBoolean", "multipleBirthInteger"] },
  ],
  Procedure: [{
    paths: ["performedDateTime", "performedPeriod", "performedString", "performedAge", "performedRange"],
  }],
  Provenance: [{ paths: ["occurredPeriod", "occurredDateTime"] }],
};

interface NestedChoiceBinding {
  readonly path: string;
  readonly choices: readonly string[];
  readonly required?: true;
}

const nestedChoiceBindings: Readonly<Partial<Record<
  NormalizedFhirResourceType,
  readonly NestedChoiceBinding[]
>>> = {
  CarePlan: [
    { path: "activity", choices: ["reference", "detail"], required: true },
    {
      path: "activity.detail",
      choices: ["scheduledTiming", "scheduledPeriod", "scheduledString"],
    },
    {
      path: "activity.detail",
      choices: ["productCodeableConcept", "productReference"],
    },
  ],
  Goal: [
    {
      path: "target",
      choices: [
        "detailQuantity",
        "detailRange",
        "detailCodeableConcept",
        "detailString",
        "detailBoolean",
        "detailInteger",
        "detailRatio",
      ],
    },
    { path: "target", choices: ["dueDate", "dueDuration"] },
  ],
  Immunization: [
    {
      path: "protocolApplied",
      choices: ["doseNumberPositiveInt", "doseNumberString"],
      required: true,
    },
    {
      path: "protocolApplied",
      choices: ["seriesDosesPositiveInt", "seriesDosesString"],
    },
  ],
  Medication: [{
    path: "ingredient",
    choices: ["itemCodeableConcept", "itemReference"],
    required: true,
  }],
  MedicationRequest: [
    {
      path: "dosageInstruction.doseAndRate",
      choices: ["doseRange", "doseQuantity"],
    },
    {
      path: "dosageInstruction.doseAndRate",
      choices: ["rateRatio", "rateRange", "rateQuantity"],
    },
    {
      path: "substitution",
      choices: ["allowedBoolean", "allowedCodeableConcept"],
      required: true,
    },
  ],
  Observation: [{
    path: "component",
    choices: [
      "valueQuantity",
      "valueCodeableConcept",
      "valueString",
      "valueBoolean",
      "valueInteger",
      "valueRange",
      "valueRatio",
      "valueSampledData",
      "valueTime",
      "valueDateTime",
      "valuePeriod",
    ],
  }],
};

interface NestedRequiredBinding {
  readonly path: string;
  readonly requiredPaths: readonly string[];
}

const nestedRequiredBindings: Readonly<Partial<Record<
  NormalizedFhirResourceType,
  readonly NestedRequiredBinding[]
>>> = {
  AllergyIntolerance: [{ path: "reaction", requiredPaths: ["manifestation"] }],
  CarePlan: [{ path: "activity.detail", requiredPaths: ["status"] }],
  Device: [
    { path: "deviceName", requiredPaths: ["name", "type"] },
    { path: "version", requiredPaths: ["value"] },
  ],
  DiagnosticReport: [{ path: "media", requiredPaths: ["link"] }],
  DocumentReference: [
    { path: "content", requiredPaths: ["attachment"] },
    { path: "relatesTo", requiredPaths: ["code", "target"] },
  ],
  Encounter: [
    { path: "statusHistory", requiredPaths: ["status", "period"] },
    { path: "classHistory", requiredPaths: ["class", "period"] },
    { path: "diagnosis", requiredPaths: ["condition"] },
    { path: "location", requiredPaths: ["location"] },
  ],
  Immunization: [{ path: "performer", requiredPaths: ["actor"] }],
  Observation: [{ path: "component", requiredPaths: ["code"] }],
  Patient: [
    { path: "communication", requiredPaths: ["language"] },
    { path: "link", requiredPaths: ["other", "type"] },
  ],
  Practitioner: [{ path: "qualification", requiredPaths: ["code"] }],
  PractitionerRole: [{ path: "notAvailable", requiredPaths: ["description"] }],
  Procedure: [
    { path: "performer", requiredPaths: ["actor"] },
    { path: "focalDevice", requiredPaths: ["manipulated"] },
  ],
  Provenance: [
    { path: "agent", requiredPaths: ["who"] },
    { path: "entity", requiredPaths: ["role", "what"] },
    { path: "entity.agent", requiredPaths: ["who"] },
    { path: "signature", requiredPaths: ["type", "when", "who"] },
  ],
  RelatedPerson: [{ path: "communication", requiredPaths: ["language"] }],
};

type TemporalPrimitiveKind = "date" | "dateTime" | "instant" | "time";

interface TemporalBinding {
  readonly path: string;
  readonly kind: TemporalPrimitiveKind;
}

const temporalBindings: Readonly<Partial<Record<
  NormalizedFhirResourceType,
  readonly TemporalBinding[]
>>> = {
  AllergyIntolerance: [
    { path: "onsetDateTime", kind: "dateTime" },
    { path: "recordedDate", kind: "dateTime" },
    { path: "lastOccurrence", kind: "dateTime" },
    { path: "reaction.onset", kind: "dateTime" },
  ],
  CarePlan: [{ path: "created", kind: "dateTime" }],
  Condition: [
    { path: "onsetDateTime", kind: "dateTime" },
    { path: "abatementDateTime", kind: "dateTime" },
    { path: "recordedDate", kind: "dateTime" },
  ],
  Device: [
    { path: "manufactureDate", kind: "dateTime" },
    { path: "expirationDate", kind: "dateTime" },
  ],
  DiagnosticReport: [
    { path: "effectiveDateTime", kind: "dateTime" },
    { path: "issued", kind: "instant" },
  ],
  DocumentReference: [{ path: "date", kind: "instant" }],
  Goal: [
    { path: "startDate", kind: "date" },
    { path: "target.dueDate", kind: "date" },
    { path: "statusDate", kind: "date" },
  ],
  Immunization: [
    { path: "occurrenceDateTime", kind: "dateTime" },
    { path: "recorded", kind: "dateTime" },
    { path: "expirationDate", kind: "date" },
    { path: "reaction.date", kind: "dateTime" },
  ],
  Location: [
    { path: "hoursOfOperation.openingTime", kind: "time" },
    { path: "hoursOfOperation.closingTime", kind: "time" },
  ],
  Medication: [{ path: "batch.expirationDate", kind: "dateTime" }],
  MedicationRequest: [{ path: "authoredOn", kind: "dateTime" }],
  Observation: [
    { path: "effectiveDateTime", kind: "dateTime" },
    { path: "effectiveInstant", kind: "instant" },
    { path: "issued", kind: "instant" },
    { path: "valueTime", kind: "time" },
    { path: "valueDateTime", kind: "dateTime" },
    { path: "component.valueTime", kind: "time" },
    { path: "component.valueDateTime", kind: "dateTime" },
  ],
  Patient: [
    { path: "birthDate", kind: "date" },
    { path: "deceasedDateTime", kind: "dateTime" },
  ],
  Practitioner: [{ path: "birthDate", kind: "date" }],
  Procedure: [{ path: "performedDateTime", kind: "dateTime" }],
  Provenance: [
    { path: "occurredDateTime", kind: "dateTime" },
    { path: "recorded", kind: "instant" },
    { path: "signature.when", kind: "instant" },
  ],
  RelatedPerson: [{ path: "birthDate", kind: "date" }],
};

type PrimitiveValueKind = "boolean" | "integer" | "positiveInt" | "unsignedInt";

interface PrimitiveValueBinding {
  readonly path: string;
  readonly kind: PrimitiveValueKind;
}

const primitiveValueBindings: Readonly<Partial<Record<
  NormalizedFhirResourceType,
  readonly PrimitiveValueBinding[]
>>> = {
  CarePlan: [{ path: "activity.detail.doNotPerform", kind: "boolean" }],
  Goal: [
    { path: "target.detailBoolean", kind: "boolean" },
    { path: "target.detailInteger", kind: "integer" },
  ],
  Immunization: [
    { path: "primarySource", kind: "boolean" },
    { path: "isSubpotent", kind: "boolean" },
    { path: "reaction.reported", kind: "boolean" },
    { path: "protocolApplied.doseNumberPositiveInt", kind: "positiveInt" },
    { path: "protocolApplied.seriesDosesPositiveInt", kind: "positiveInt" },
  ],
  Location: [{ path: "hoursOfOperation.allDay", kind: "boolean" }],
  Medication: [{ path: "ingredient.isActive", kind: "boolean" }],
  MedicationRequest: [
    { path: "doNotPerform", kind: "boolean" },
    { path: "reportedBoolean", kind: "boolean" },
    { path: "dispenseRequest.numberOfRepeatsAllowed", kind: "unsignedInt" },
    { path: "substitution.allowedBoolean", kind: "boolean" },
  ],
  Observation: [
    { path: "valueBoolean", kind: "boolean" },
    { path: "valueInteger", kind: "integer" },
    { path: "component.valueBoolean", kind: "boolean" },
    { path: "component.valueInteger", kind: "integer" },
  ],
  Organization: [{ path: "active", kind: "boolean" }],
  Patient: [
    { path: "active", kind: "boolean" },
    { path: "deceasedBoolean", kind: "boolean" },
    { path: "multipleBirthBoolean", kind: "boolean" },
    { path: "multipleBirthInteger", kind: "positiveInt" },
    { path: "communication.preferred", kind: "boolean" },
  ],
  Practitioner: [{ path: "active", kind: "boolean" }],
  PractitionerRole: [
    { path: "active", kind: "boolean" },
    { path: "availableTime.allDay", kind: "boolean" },
  ],
  RelatedPerson: [
    { path: "active", kind: "boolean" },
    { path: "communication.preferred", kind: "boolean" },
  ],
};

function strings(values: readonly string[]): ReadonlySet<string> {
  return new Set(values);
}

const statusBindings: Readonly<Partial<Record<
  NormalizedFhirResourceType,
  readonly StatusBinding[]
>>> = {
  CarePlan: [
    { path: "status", allowed: strings(["draft", "active", "on-hold", "revoked", "completed", "entered-in-error", "unknown"]) },
    { path: "intent", allowed: strings(["proposal", "plan", "order", "option"]) },
    { path: "activity.detail.status", allowed: strings(["not-started", "scheduled", "in-progress", "on-hold", "completed", "cancelled", "stopped", "unknown", "entered-in-error"]) },
  ],
  CareTeam: [{
    path: "status",
    allowed: strings(["proposed", "active", "suspended", "inactive", "entered-in-error"]),
  }],
  Device: [
    {
      path: "status",
      allowed: strings(["active", "inactive", "entered-in-error", "unknown"]),
    },
    {
      path: "deviceName.type",
      allowed: strings(["udi-label-name", "user-friendly-name", "patient-reported-name", "manufacturer-name", "model-name", "other"]),
    },
  ],
  DiagnosticReport: [{
    path: "status",
    allowed: strings(["registered", "partial", "preliminary", "final", "amended", "corrected", "appended", "cancelled", "entered-in-error", "unknown"]),
  }],
  DocumentReference: [
    { path: "status", allowed: strings(["current", "superseded", "entered-in-error"]) },
    { path: "docStatus", allowed: strings(["preliminary", "final", "amended", "entered-in-error"]) },
    { path: "relatesTo.code", allowed: strings(["replaces", "transforms", "signs", "appends"]) },
  ],
  Encounter: [
    {
      path: "status",
      allowed: strings(["planned", "arrived", "triaged", "in-progress", "onleave", "finished", "cancelled", "entered-in-error", "unknown"]),
    },
    {
      path: "statusHistory.status",
      allowed: strings(["planned", "arrived", "triaged", "in-progress", "onleave", "finished", "cancelled", "entered-in-error", "unknown"]),
    },
  ],
  Goal: [{
    path: "lifecycleStatus",
    allowed: strings(["proposed", "planned", "accepted", "active", "on-hold", "completed", "cancelled", "entered-in-error", "rejected"]),
  }],
  Immunization: [{
    path: "status",
    allowed: strings(["completed", "entered-in-error", "not-done"]),
  }],
  Location: [{
    path: "status",
    allowed: strings(["active", "suspended", "inactive"]),
  }],
  Medication: [{
    path: "status",
    allowed: strings(["active", "inactive", "entered-in-error"]),
  }],
  MedicationRequest: [
    { path: "status", allowed: strings(["active", "on-hold", "cancelled", "completed", "entered-in-error", "stopped", "draft", "unknown"]) },
    { path: "intent", allowed: strings(["proposal", "plan", "order", "original-order", "reflex-order", "filler-order", "instance-order", "option"]) },
  ],
  Observation: [{
    path: "status",
    allowed: strings(["registered", "preliminary", "final", "amended", "corrected", "cancelled", "entered-in-error", "unknown"]),
  }],
  Procedure: [{
    path: "status",
    allowed: strings(["preparation", "in-progress", "not-done", "on-hold", "stopped", "completed", "entered-in-error", "unknown"]),
  }],
  Patient: [{
    path: "link.type",
    allowed: strings(["replaced-by", "replaces", "refer", "seealso"]),
  }],
  Provenance: [{
    path: "entity.role",
    allowed: strings(["derivation", "revision", "quotation", "source", "removal"]),
  }],
};

const requiredConceptBindings: Readonly<Partial<Record<
  NormalizedFhirResourceType,
  readonly RequiredConceptBinding[]
>>> = {
  AllergyIntolerance: [
    {
      path: "clinicalStatus",
      system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
      allowed: strings(["active", "inactive", "resolved"]),
    },
    {
      path: "verificationStatus",
      system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification",
      allowed: strings(["unconfirmed", "confirmed", "refuted", "entered-in-error"]),
    },
  ],
  Condition: [
    {
      path: "clinicalStatus",
      system: "http://terminology.hl7.org/CodeSystem/condition-clinical",
      allowed: strings(["active", "recurrence", "relapse", "inactive", "remission", "resolved"]),
    },
    {
      path: "verificationStatus",
      system: "http://terminology.hl7.org/CodeSystem/condition-ver-status",
      allowed: strings([
        "unconfirmed",
        "provisional",
        "differential",
        "confirmed",
        "refuted",
        "entered-in-error",
      ]),
    },
  ],
};

const fhirYearSource = "(?!0000)\\d{4}";
const fhirDatePattern = new RegExp(
  `^${fhirYearSource}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\\d|3[01]))?)?$`,
);
const fhirFullDateSource = `${fhirYearSource}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])`;
const fhirTimeSource = "(?:[01]\\d|2[0-3]):[0-5]\\d:(?:[0-5]\\d|60)(?:\\.\\d+)?";
const fhirZoneSource = "(?:Z|[+-](?:(?:0\\d|1[0-3]):[0-5]\\d|14:00))";
const fhirDateTimePattern = new RegExp(
  `^(?:${fhirDatePattern.source.slice(1, -1)}|${fhirFullDateSource}T${fhirTimeSource}${fhirZoneSource})$`,
);
const fhirInstantPattern = new RegExp(
  `^${fhirFullDateSource}T${fhirTimeSource}${fhirZoneSource}$`,
);
const fhirTimePattern = new RegExp(`^${fhirTimeSource}$`);

function validCalendarDate(value: string): boolean {
  const [yearText, monthText, dayText] = value.slice(0, 10).split("-");
  if (yearText === undefined || yearText === "0000") return false;
  if (monthText === undefined || dayText === undefined) return true;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (daysInMonth[month - 1] ?? 0);
}

function validTemporalPrimitive(value: unknown, kind: TemporalPrimitiveKind): boolean {
  if (typeof value !== "string") return false;
  if (kind === "date") return fhirDatePattern.test(value) && validCalendarDate(value);
  if (kind === "dateTime") {
    return fhirDateTimePattern.test(value) && validCalendarDate(value);
  }
  if (kind === "instant") {
    return fhirInstantPattern.test(value) && validCalendarDate(value);
  }
  return fhirTimePattern.test(value);
}

function hasRequiredElementContent(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (value === null || value === undefined) return false;
  if (typeof value !== "object") return true;
  if (Array.isArray(value)) return value.length > 0;
  return Object.keys(value as Record<string, unknown>).length > 0;
}

function validateRequiredResourceShape(
  resource: z.infer<typeof supportedResourceSchema>,
): void {
  for (const path of requiredPaths[resource.resourceType] ?? []) {
    const requiredValues = valuesAtPath(resource, path);
    if (requiredValues.length === 0 || requiredValues.some((value) =>
      !hasRequiredElementContent(value))) {
      throw new FhirNormalizationError(
        "invalid_resource_shape",
        `${resource.resourceType}.${path} is required by FHIR R4.`,
      );
    }
  }
  for (const group of choiceGroups[resource.resourceType] ?? []) {
    const present = group.paths.filter((path) => valuesAtPath(resource, path).length > 0);
    if (present.length > 1 || (group.required && present.length !== 1)) {
      throw new FhirNormalizationError(
        "invalid_resource_shape",
        `${resource.resourceType} has an invalid FHIR choice element.`,
      );
    }
  }
  for (const binding of nestedChoiceBindings[resource.resourceType] ?? []) {
    for (const [index, node] of valuesAtPath(resource, binding.path).entries()) {
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        throw new FhirNormalizationError(
          "invalid_resource_shape",
          `${resource.resourceType}.${binding.path}[${index}] has an invalid R4 shape.`,
        );
      }
      const present = binding.choices.filter((path) => valuesAtPath(node, path).length > 0);
      if (present.length > 1 || (binding.required && present.length !== 1)) {
        throw new FhirNormalizationError(
          "invalid_resource_shape",
          `${resource.resourceType}.${binding.path}[${index}] has an invalid FHIR choice element.`,
        );
      }
    }
  }
  for (const binding of nestedRequiredBindings[resource.resourceType] ?? []) {
    for (const [index, node] of valuesAtPath(resource, binding.path).entries()) {
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        throw new FhirNormalizationError(
          "invalid_resource_shape",
          `${resource.resourceType}.${binding.path}[${index}] has an invalid R4 shape.`,
        );
      }
      for (const requiredPath of binding.requiredPaths) {
        const requiredValues = valuesAtPath(node, requiredPath);
        if (requiredValues.length === 0 || requiredValues.some((value) =>
          !hasRequiredElementContent(value))) {
          throw new FhirNormalizationError(
            "invalid_resource_shape",
            `${resource.resourceType}.${binding.path}[${index}].${requiredPath} is required by FHIR R4.`,
          );
        }
      }
    }
  }
  for (const binding of temporalBindings[resource.resourceType] ?? []) {
    for (const value of valuesAtPath(resource, binding.path)) {
      if (!validTemporalPrimitive(value, binding.kind)) {
        throw new FhirNormalizationError(
          "invalid_resource_shape",
          `${resource.resourceType}.${binding.path} has an invalid R4 ${binding.kind}.`,
        );
      }
    }
  }
  for (const binding of primitiveValueBindings[resource.resourceType] ?? []) {
    for (const value of valuesAtPath(resource, binding.path)) {
      const valid = binding.kind === "boolean"
        ? typeof value === "boolean"
        : typeof value === "number" &&
          Number.isInteger(value) &&
          value >= (binding.kind === "positiveInt" ? 1 : binding.kind === "unsignedInt" ? 0 : -2_147_483_648) &&
          value <= 2_147_483_647;
      if (!valid) {
        throw new FhirNormalizationError(
          "invalid_resource_shape",
          `${resource.resourceType}.${binding.path} has an invalid R4 ${binding.kind}.`,
        );
      }
    }
  }
  for (const binding of statusBindings[resource.resourceType] ?? []) {
    for (const value of valuesAtPath(resource, binding.path)) {
      if (typeof value !== "string" || !binding.allowed.has(value)) {
        throw new FhirNormalizationError(
          "invalid_resource_shape",
          `${resource.resourceType}.${binding.path} has an invalid R4 code.`,
        );
      }
    }
  }
  for (const binding of requiredConceptBindings[resource.resourceType] ?? []) {
    for (const value of valuesAtPath(resource, binding.path)) {
      const concept = fhirCodeableConceptSchema.safeParse(value);
      const systemCodings = concept.success
        ? (concept.data.coding ?? []).filter((coding) => coding.system === binding.system)
        : [];
      if (
        systemCodings.length === 0 ||
        !systemCodings.some((coding) =>
          coding.code !== undefined && binding.allowed.has(coding.code)) ||
        systemCodings.some((coding) =>
          coding.code === undefined || !binding.allowed.has(coding.code))
      ) {
        throw new FhirNormalizationError(
          "invalid_resource_shape",
          `${resource.resourceType}.${binding.path} has an invalid R4 code.`,
        );
      }
    }
  }
  if (resource.resourceType === "Binary") {
    const data = resource.data;
    if (
      data !== undefined && (
        typeof data !== "string" ||
        data.length === 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
      )
    ) {
      throw new FhirNormalizationError(
        "invalid_resource_shape",
        "Binary.data must be canonical base64.",
      );
    }
  }
  if (
    resource.resourceType === "Immunization" &&
    resource.primarySource !== undefined &&
    typeof resource.primarySource !== "boolean"
  ) {
    throw new FhirNormalizationError(
      "invalid_resource_shape",
      "Immunization.primarySource must be a boolean.",
    );
  }
  if (resource.resourceType === "Observation") {
    const valueChoices = [
      "valueQuantity",
      "valueCodeableConcept",
      "valueString",
      "valueBoolean",
      "valueInteger",
      "valueRange",
      "valueRatio",
      "valueSampledData",
      "valueTime",
      "valueDateTime",
      "valuePeriod",
    ];
    if (
      valueChoices.some((path) => valuesAtPath(resource, path).length > 0) &&
      valuesAtPath(resource, "dataAbsentReason").length > 0
    ) {
      throw new FhirNormalizationError(
        "invalid_resource_shape",
        "Observation.dataAbsentReason cannot accompany Observation.value[x].",
      );
    }
    for (const component of valuesAtPath(resource, "component")) {
      if (
        valueChoices.some((path) => valuesAtPath(component, path).length > 0) &&
        valuesAtPath(component, "dataAbsentReason").length > 0
      ) {
        throw new FhirNormalizationError(
          "invalid_resource_shape",
          "Observation.component.dataAbsentReason cannot accompany component.value[x].",
        );
      }
    }
  }
}

function conceptCodesAtPath(resource: unknown, path: string): string[] {
  return valuesAtPath(resource, path).flatMap((value) => {
    const parsed = fhirCodeableConceptSchema.safeParse(value);
    if (!parsed.success) return [];
    return (parsed.data.coding ?? []).flatMap((coding) =>
      coding.code === undefined ? [] : [coding.code.toLowerCase()]);
  });
}

function warningsForResource(
  resource: z.infer<typeof supportedResourceSchema>,
  facts: readonly NormalizedFhirFact[],
): string[] {
  const warnings: string[] = [];
  const primitiveStatusValues = facts
    .filter((candidate) => /(?:Status|status)$/.test(candidate.sourcePath))
    .flatMap((candidate) => candidate.values.map((value) => value.display.toLowerCase()));
  if (primitiveStatusValues.includes("entered-in-error")) {
    warnings.push("The source marks this record as entered in error.");
  }
  if (primitiveStatusValues.includes("cancelled") || primitiveStatusValues.includes("revoked")) {
    warnings.push("The source marks this record as cancelled or revoked.");
  }
  if (primitiveStatusValues.includes("not-done")) {
    warnings.push("The source states that this event was not performed.");
  }
  if (primitiveStatusValues.includes("stopped")) {
    warnings.push("The source marks this request or event as stopped.");
  }
  const verificationCodes = conceptCodesAtPath(resource, "verificationStatus");
  if (verificationCodes.includes("refuted")) {
    warnings.push("The source marks this assertion as refuted.");
  }
  if (verificationCodes.includes("entered-in-error")) {
    warnings.push("The source verification status marks this assertion as entered in error.");
  }
  if (
    valuesAtPath(resource, "doNotPerform").includes(true) ||
    valuesAtPath(resource, "activity.detail.doNotPerform").includes(true)
  ) {
    warnings.push("The source explicitly says not to perform this request or activity.");
  }
  if (valuesAtPath(resource, "isSubpotent").includes(true)) {
    warnings.push("The source marks this immunization as subpotent.");
  }
  if (
    valuesAtPath(resource, "deceasedBoolean").includes(true) ||
    valuesAtPath(resource, "deceasedDateTime").length > 0
  ) {
    warnings.push("The source records this patient as deceased.");
  }
  if (resource.resourceType === "Patient" && valuesAtPath(resource, "link").length > 0) {
    warnings.push("The source includes patient-record link semantics; review link type before identity decisions.");
  }
  return [...new Set(warnings)];
}

const quantitySchema = z.object({
  value: z.number().finite().optional(),
  comparator: boundedStringSchema.optional(),
  unit: boundedStringSchema.optional(),
  system: boundedStringSchema.optional(),
  code: boundedStringSchema.optional(),
}).passthrough();

const rangeSchema = z.object({
  low: quantitySchema.optional(),
  high: quantitySchema.optional(),
}).passthrough();

const ratioSchema = z.object({
  numerator: quantitySchema.optional(),
  denominator: quantitySchema.optional(),
}).passthrough();

const humanNameSchema = z.object({
  text: boundedStringSchema.optional(),
  family: boundedStringSchema.optional(),
  given: z.array(boundedStringSchema).max(1_024).optional(),
  prefix: z.array(boundedStringSchema).max(1_024).optional(),
  suffix: z.array(boundedStringSchema).max(1_024).optional(),
}).passthrough();

const addressSchema = z.object({
  text: boundedStringSchema.optional(),
  line: z.array(boundedStringSchema).max(1_024).optional(),
  city: boundedStringSchema.optional(),
  district: boundedStringSchema.optional(),
  state: boundedStringSchema.optional(),
  postalCode: boundedStringSchema.optional(),
  country: boundedStringSchema.optional(),
}).passthrough();

const attachmentSchema = z.object({
  contentType: boundedStringSchema.optional(),
  language: boundedStringSchema.optional(),
  title: boundedStringSchema.optional(),
  creation: boundedStringSchema.optional(),
  size: z.number().int().nonnegative().optional(),
}).passthrough();

const maximumDisplayCharacters = 4_096;
const maximumValuesPerFact = 256;
const truncationMarker = "… [truncated; review cited raw resource]";

function boundedDisplay(value: string): { readonly display: string; readonly truncated?: true } {
  const singleLine = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (singleLine.length <= maximumDisplayCharacters) return { display: singleLine };
  return {
    display: `${singleLine.slice(0, maximumDisplayCharacters - truncationMarker.length)}${truncationMarker}`,
    truncated: true,
  };
}

function textValue(value: string): NormalizedFhirValue {
  const bounded = boundedDisplay(value);
  if (bounded.display.length === 0) {
    throw new FhirNormalizationError(
      "invalid_resource_shape",
      "FHIR primitive strings must not be empty.",
    );
  }
  return normalizedTextValueSchema.parse({ kind: "text", ...bounded });
}

function codeValue(
  display: string,
  coding?: z.infer<typeof fhirCodingSchema>,
): NormalizedFhirValue {
  if (coding !== undefined && [coding.system, coding.code, coding.display].some((value) => value === "")) {
    throw new FhirNormalizationError(
      "invalid_resource_shape",
      "FHIR Coding primitives must not be empty.",
    );
  }
  if (boundedDisplay(display).display.length === 0) {
    throw new FhirNormalizationError(
      "invalid_resource_shape",
      "FHIR coded values must not be empty.",
    );
  }
  return normalizedCodeValueSchema.parse({
    kind: "code",
    ...boundedDisplay(display),
    ...(coding?.system === undefined ? {} : { system: coding.system }),
    ...(coding?.code === undefined ? {} : { code: coding.code }),
  });
}

function referenceValue(
  reference: z.infer<typeof fhirReferenceSchema>,
): NormalizedFhirValue[] {
  const safeReference = reference.reference === undefined
    ? undefined
    : sanitizeReference(reference.reference);
  if (
    reference.reference === "" ||
    reference.display === "" ||
    reference.identifier?.value === ""
  ) {
    throw new FhirNormalizationError(
      "invalid_resource_shape",
      "FHIR Reference primitives must not be empty.",
    );
  }
  const rawDisplay = reference.display ?? safeReference ?? reference.identifier?.value;
  if (rawDisplay === undefined || rawDisplay.length === 0) {
    throw new FhirNormalizationError(
      "invalid_resource_shape",
      "FHIR Reference must identify or describe its target.",
    );
  }
  return [normalizedReferenceValueSchema.parse({
    kind: "reference",
    ...boundedDisplay(rawDisplay),
    ...(safeReference === undefined ? {} : { reference: safeReference }),
    ...(reference.type === undefined ? {} : { referenceType: reference.type }),
  })];
}

function sanitizeReference(reference: string): string {
  let sanitized = reference;
  try {
    const parsed = new URL(reference);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      sanitized = parsed.toString();
    } else {
      sanitized = reference.split("?", 1)[0]!.split("#", 1)[0]!;
    }
  } catch {
    const query = reference.indexOf("?");
    const fragment = reference.startsWith("#") ? -1 : reference.indexOf("#");
    const cutAt = [query, fragment]
      .filter((index) => index >= 0)
      .reduce((earliest, index) => Math.min(earliest, index), reference.length);
    sanitized = reference.slice(0, cutAt);
  }
  return boundedDisplay(sanitized).display;
}

function validateQuantity(quantity: z.infer<typeof quantitySchema>): void {
  for (const value of [quantity.comparator, quantity.unit, quantity.system, quantity.code]) {
    if (value === "") {
      throw new FhirNormalizationError(
        "invalid_resource_shape",
        "FHIR Quantity primitives must not be empty.",
      );
    }
  }
  if (
    quantity.comparator !== undefined &&
    !["<", "<=", ">=", ">"].includes(quantity.comparator)
  ) {
    throw new FhirNormalizationError(
      "invalid_resource_shape",
      "FHIR Quantity has an invalid comparator.",
    );
  }
  if (quantity.code !== undefined && quantity.system === undefined) {
    throw new FhirNormalizationError(
      "invalid_resource_shape",
      "FHIR Quantity.code requires Quantity.system.",
    );
  }
}

function quantityDisplay(quantity: z.infer<typeof quantitySchema>): string | undefined {
  validateQuantity(quantity);
  const numeric = quantity.value === undefined
    ? undefined
    : `${quantity.comparator ?? ""}${quantity.value}`;
  const unit = quantity.unit ?? quantity.code;
  if (numeric !== undefined && unit !== undefined) return `${numeric} ${unit}`;
  return numeric ?? unit;
}

function quantityValue(
  quantity: z.infer<typeof quantitySchema>,
): NormalizedFhirValue[] {
  const display = quantityDisplay(quantity);
  if (display === undefined) {
    throw new FhirNormalizationError(
      "invalid_resource_shape",
      "FHIR Quantity must contain a value or unit.",
    );
  }
  return [normalizedQuantityValueSchema.parse({
    kind: "quantity",
    ...boundedDisplay(display),
    ...(quantity.value === undefined ? {} : { value: quantity.value }),
    ...(quantity.comparator === undefined ? {} : { comparator: quantity.comparator }),
    ...(quantity.unit === undefined ? {} : { unit: quantity.unit }),
    ...(quantity.system === undefined ? {} : { system: quantity.system }),
    ...(quantity.code === undefined ? {} : { code: quantity.code }),
  })];
}

function valuesAtPath(root: unknown, path: string): unknown[] {
  let cursors: unknown[] = [root];
  for (const segment of path.split(".")) {
    const next: unknown[] = [];
    for (const cursor of cursors) {
      const candidates = Array.isArray(cursor) ? cursor : [cursor];
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
        if (Object.prototype.hasOwnProperty.call(candidate, segment)) {
          const selected = (candidate as Record<string, unknown>)[segment];
          if (Array.isArray(selected)) {
            for (const item of selected) next.push(item);
          }
          else if (selected !== undefined) next.push(selected);
        }
      }
    }
    cursors = next;
  }
  return cursors;
}

function formatConcept(value: unknown): NormalizedFhirValue[] {
  const concept = fhirCodeableConceptSchema.parse(value);
  const codings = concept.coding ?? [];
  const values = concept.text === undefined ? [] : [textValue(concept.text)];
  values.push(...codings.flatMap((coding) => {
    const display = coding.display ?? coding.code;
    return display === undefined ? [] : [codeValue(display, coding)];
  }));
  if (values.length === 0) {
    throw new FhirNormalizationError(
      "invalid_resource_shape",
      "FHIR CodeableConcept must contain text or a displayable coding.",
    );
  }
  return values;
}

function formatPeriod(value: unknown): NormalizedFhirValue[] {
  const period = fhirPeriodSchema.parse(value);
  if (
    (period.start !== undefined && !validTemporalPrimitive(period.start, "dateTime")) ||
    (period.end !== undefined && !validTemporalPrimitive(period.end, "dateTime"))
  ) {
    throw new FhirNormalizationError(
      "invalid_resource_shape",
      "FHIR Period contains an invalid R4 dateTime.",
    );
  }
  if (period.start !== undefined && period.end !== undefined) {
    const start = Date.parse(period.start);
    const end = Date.parse(period.end);
    if (
      (Number.isFinite(start) && Number.isFinite(end) && start > end) ||
      (!Number.isFinite(start) && !Number.isFinite(end) && period.start > period.end)
    ) {
      throw new FhirNormalizationError(
        "invalid_resource_shape",
        "FHIR Period.start must not be later than Period.end.",
      );
    }
  }
  if (period.start === undefined && period.end === undefined) return [];
  const display = period.start !== undefined && period.end !== undefined
    ? `${period.start} to ${period.end}`
    : period.start !== undefined
      ? `from ${period.start}`
      : `through ${period.end!}`;
  return [normalizedTemporalValueSchema.parse({
    kind: "temporal",
    ...boundedDisplay(display),
    ...(period.start === undefined ? {} : { start: period.start }),
    ...(period.end === undefined ? {} : { end: period.end }),
  })];
}

function formatHumanName(value: unknown): NormalizedFhirValue[] {
  const name = humanNameSchema.parse(value);
  const display = name.text ?? [
    ...(name.prefix ?? []),
    ...(name.given ?? []),
    name.family,
    ...(name.suffix ?? []),
  ].filter((part): part is string => part !== undefined).join(" ");
  return display.length === 0 ? [] : [textValue(display)];
}

function formatAddress(value: unknown): NormalizedFhirValue[] {
  const address = addressSchema.parse(value);
  const display = address.text ?? [
    ...(address.line ?? []),
    address.city,
    address.district,
    address.state,
    address.postalCode,
    address.country,
  ].filter((part): part is string => part !== undefined).join(", ");
  return display.length === 0 ? [] : [textValue(display)];
}

function formatAttachment(value: unknown): NormalizedFhirValue[] {
  const attachment = attachmentSchema.parse(value);
  const rawAttachment = value as Record<string, unknown>;
  const payloadData = rawAttachment.data;
  const payloadUrl = rawAttachment.url;
  const payloadHash = rawAttachment.hash;
  if (
    (typeof payloadData === "string" && payloadData.length === 0) ||
    (typeof payloadUrl === "string" && payloadUrl.length === 0) ||
    (typeof payloadHash === "string" && payloadHash.length === 0) ||
    [attachment.contentType, attachment.language, attachment.title, attachment.creation]
      .some((candidate) => candidate === "")
  ) {
    throw new FhirNormalizationError(
      "invalid_resource_shape",
      "FHIR Attachment primitives must not be empty.",
    );
  }
  if (
    payloadData !== undefined && (
      typeof payloadData !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payloadData) ||
      attachment.contentType === undefined
    )
  ) {
    throw new FhirNormalizationError(
      "invalid_resource_shape",
      "FHIR Attachment.data requires contentType and canonical base64.",
    );
  }
  if (payloadUrl !== undefined && typeof payloadUrl !== "string") {
    throw new FhirNormalizationError(
      "invalid_resource_shape",
      "FHIR Attachment.url must be a string.",
    );
  }
  if (
    payloadHash !== undefined && (
      typeof payloadHash !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payloadHash)
    )
  ) {
    throw new FhirNormalizationError(
      "invalid_resource_shape",
      "FHIR Attachment.hash must be canonical base64.",
    );
  }
  if (
    attachment.creation !== undefined &&
    !validTemporalPrimitive(attachment.creation, "dateTime")
  ) {
    throw new FhirNormalizationError(
      "invalid_resource_shape",
      "FHIR Attachment.creation has an invalid R4 dateTime.",
    );
  }
  const details = [
    attachment.title,
    attachment.contentType,
    attachment.language === undefined ? undefined : `language ${attachment.language}`,
    attachment.creation === undefined ? undefined : `created ${attachment.creation}`,
    attachment.size === undefined ? undefined : `${attachment.size} bytes`,
  ].filter((part): part is string => part !== undefined);
  if (details.length > 0) return [textValue(details.join(" | "))];
  if (payloadData !== undefined || payloadUrl !== undefined || payloadHash !== undefined) {
    return [textValue("Attachment present; payload omitted—review cited raw resource if authorized.")];
  }
  throw new FhirNormalizationError(
    "invalid_resource_shape",
    "FHIR Attachment must contain a value or child element.",
  );
}

function formatNode(kind: FactKind, value: unknown): NormalizedFhirValue[] {
  switch (kind) {
    case "primitive": {
      if (typeof value === "string") return [textValue(value)];
      if (typeof value === "boolean") {
        return [normalizedBooleanValueSchema.parse({
          kind: "boolean",
          display: value ? "Yes" : "No",
          value,
        })];
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        return [normalizedNumberValueSchema.parse({
          kind: "number",
          display: String(value),
          value,
        })];
      }
      throw new FhirNormalizationError(
        "invalid_resource_shape",
        "FHIR primitive field has an invalid value.",
      );
    }
    case "concept":
      return formatConcept(value);
    case "coding": {
      const coding = fhirCodingSchema.parse(value);
      const display = coding.display ?? coding.code;
      if (display === undefined) {
        throw new FhirNormalizationError(
          "invalid_resource_shape",
          "FHIR Coding must contain a code or display.",
        );
      }
      return [codeValue(display, coding)];
    }
    case "reference":
      return referenceValue(fhirReferenceSchema.parse(value));
    case "period":
      return formatPeriod(value);
    case "quantity":
      return quantityValue(quantitySchema.parse(value));
    case "range": {
      const range = rangeSchema.parse(value);
      const low = range.low === undefined ? undefined : quantityDisplay(range.low);
      const high = range.high === undefined ? undefined : quantityDisplay(range.high);
      if (
        range.low?.value !== undefined &&
        range.high?.value !== undefined &&
        range.low.value > range.high.value
      ) {
        throw new FhirNormalizationError(
          "invalid_resource_shape",
          "FHIR Range.low must not exceed Range.high.",
        );
      }
      const display = low !== undefined && high !== undefined
        ? `${low} to ${high}`
        : low !== undefined
          ? `at least ${low}`
          : high !== undefined
            ? `up to ${high}`
            : undefined;
      if (display === undefined) {
        throw new FhirNormalizationError(
          "invalid_resource_shape",
          "FHIR Range must contain a low or high value.",
        );
      }
      return [textValue(display)];
    }
    case "ratio": {
      const ratio = ratioSchema.parse(value);
      if ((ratio.numerator === undefined) !== (ratio.denominator === undefined)) {
        throw new FhirNormalizationError(
          "invalid_resource_shape",
          "FHIR Ratio numerator and denominator must both be present or both be absent.",
        );
      }
      if (ratio.denominator?.value !== undefined && ratio.denominator.value <= 0) {
        throw new FhirNormalizationError(
          "invalid_resource_shape",
          "FHIR Ratio denominator must be greater than zero.",
        );
      }
      const numerator = ratio.numerator === undefined ? undefined : quantityDisplay(ratio.numerator);
      const denominator = ratio.denominator === undefined ? undefined : quantityDisplay(ratio.denominator);
      const display = numerator !== undefined && denominator !== undefined
        ? `${numerator} per ${denominator}`
        : numerator ?? denominator;
      if (display === undefined) {
        throw new FhirNormalizationError(
          "invalid_resource_shape",
          "FHIR Ratio must contain numerator and denominator values.",
        );
      }
      return [textValue(display)];
    }
    case "identifier": {
      const identifier = fhirIdentifierSchema.parse(value);
      const type = identifier.type === undefined ? undefined : formatConcept(identifier.type)[0]?.display;
      const display = [type, identifier.value].filter((part): part is string => part !== undefined).join(": ");
      return display.length === 0 ? [] : [textValue(display)];
    }
    case "humanName":
      return formatHumanName(value);
    case "address":
      return formatAddress(value);
    case "contact": {
      const contact = fhirContactPointSchema.parse(value);
      if (contact.value === undefined) return [];
      return [textValue([
        contact.system,
        contact.use,
        contact.value,
      ].filter((part): part is string => part !== undefined).join(": "))];
    }
    case "annotation": {
      const annotation = fhirAnnotationSchema.parse(value);
      if (annotation.time !== undefined && !validTemporalPrimitive(annotation.time, "dateTime")) {
        throw new FhirNormalizationError(
          "invalid_resource_shape",
          "FHIR Annotation.time has an invalid R4 dateTime.",
        );
      }
      return [textValue(annotation.text)];
    }
    case "attachment":
      return formatAttachment(value);
  }
}

function buildNormalizedProjection(
  resourceInput: z.infer<typeof supportedResourceSchema>,
  provenanceInput: SourceResourceVersionRef,
): Record<string, unknown> {
  const resource = supportedResourceSchema.parse(resourceInput);
  const provenance = sourceResourceVersionRefSchema.parse(provenanceInput);
  const definition = resourceDefinitions[resource.resourceType];
  validateRequiredResourceShape(resource);
  const facts: NormalizedFhirFact[] = [];
  let headline: string | undefined;
  for (const definitionFact of definition.facts) {
    const values: NormalizedFhirValue[] = [];
    let omittedValues = 0;
    for (const sourceValue of valuesAtPath(resource, definitionFact.path)) {
      for (const normalizedValue of formatNode(definitionFact.kind, sourceValue)) {
        if (values.length < maximumValuesPerFact) values.push(normalizedValue);
        else omittedValues += 1;
      }
    }
    if (values.length === 0) continue;
    const normalizedFact = normalizedFhirFactSchema.parse({
      sourcePath: `${resource.resourceType}.${definitionFact.path}`,
      label: definitionFact.label,
      values,
      ...(omittedValues > 0 ? { omittedValues } : {}),
    });
    facts.push(normalizedFact);
    if (headline === undefined && definitionFact.headline) {
      headline = values[0]?.display;
    }
  }
  return {
    schemaVersion: 1,
    accountRef: provenance.accountRef,
    sourceConnectionId: provenance.sourceConnectionId,
    patientSubjectId: provenance.patientSubjectId,
    provenance,
    resourceType: resource.resourceType,
    resourceId: resource.id,
    resourceLabel: definition.label,
    headline: headline ?? `${definition.label} ${resource.id}`,
    facts,
    warnings: warningsForResource(resource, facts),
  };
}

function hasUninterpretedModifierSemantics(value: unknown): boolean {
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
      continue;
    }
    const record = current as Record<string, unknown>;
    if (record.implicitRules !== undefined) return true;
    if (record.modifierExtension !== undefined && (
      !Array.isArray(record.modifierExtension) || record.modifierExtension.length > 0
    )) return true;
    for (const nested of Object.values(record)) pending.push(nested);
  }
  return false;
}

function contentHashForRaw(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

export function supportsNormalizedFhirResource(
  resourceType: string,
): resourceType is NormalizedFhirResourceType {
  return supportedResourceTypeSchema.safeParse(resourceType).success;
}

export function normalizeFhirResource(
  raw: unknown,
  provenanceInput: SourceResourceVersionRef,
): NormalizedFhirResource {
  const resourceResult = supportedResourceSchema.safeParse(raw);
  if (!resourceResult.success) {
    const resourceType = raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).resourceType
      : undefined;
    throw new FhirNormalizationError(
      typeof resourceType === "string" && !supportsNormalizedFhirResource(resourceType)
        ? "unsupported_resource_type"
        : "invalid_resource_shape",
      "The source is not a supported, minimally valid R4 resource.",
      { cause: resourceResult.error },
    );
  }
  const resource = resourceResult.data;
  if (hasUninterpretedModifierSemantics(resource)) {
    throw new FhirNormalizationError(
      "unsupported_modifier_semantics",
      "FHIR modifier semantics must be understood before creating a projection.",
    );
  }
  const provenanceResult = sourceResourceVersionRefSchema.safeParse(provenanceInput);
  if (!provenanceResult.success) {
    throw new FhirNormalizationError(
      "invalid_resource_shape",
      "FHIR source provenance is invalid.",
      { cause: provenanceResult.error },
    );
  }
  const provenance = provenanceResult.data;
  if (
    resource.resourceType !== provenance.resourceType ||
    resource.id !== provenance.resourceId ||
    resource.meta?.versionId !== provenance.versionId ||
    resource.meta?.lastUpdated !== provenance.lastUpdated ||
    contentHashForRaw(resource) !== provenance.contentHash
  ) {
    throw new FhirNormalizationError(
      "invalid_resource_shape",
      "FHIR resource identity or content does not match provenance.",
    );
  }
  try {
    return normalizedFhirResourceSchema.parse(buildNormalizedProjection(resource, provenance));
  } catch (error) {
    if (error instanceof FhirNormalizationError) throw error;
    if (error instanceof z.ZodError) {
      throw new FhirNormalizationError(
        "invalid_resource_shape",
        "A projected FHIR field does not match its R4 datatype.",
        { cause: error },
      );
    }
    throw error;
  }
}

export function assertNormalizedFhirResourceMatchesSource(
  raw: unknown,
  provenance: SourceResourceVersionRef,
  projectionInput: unknown,
): NormalizedFhirResource {
  const projection = normalizedFhirResourceSchema.parse(projectionInput);
  const expected = normalizeFhirResource(raw, provenance);
  if (canonicalJson(projection) !== canonicalJson(expected)) {
    throw new Error("The normalized FHIR projection does not exactly match its raw source.");
  }
  return projection;
}

function resourceInsightType(resourceType: NormalizedFhirResourceType): string {
  return `${resourceType.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}-summary`;
}

/** Creates a deterministic summary containing only exact normalized source facts. */
export function createFhirResourceSummaryInsight(
  projectionInput: NormalizedFhirResource,
  generatedAt: string,
): InsightRecord {
  const projection = normalizedFhirResourceSchema.parse(projectionInput);
  const lines = [
    ...projection.warnings.map((warning) => `Warning: ${warning}`),
    `${projection.resourceLabel}: ${projection.headline}`,
  ];
  for (const factValue of projection.facts) {
    const displays = factValue.values.map((value) => value.display);
    const omitted = factValue.omittedValues === undefined
      ? ""
      : `; ${factValue.omittedValues} additional value(s) omitted—review cited raw resource`;
    lines.push(`${factValue.label}: ${displays.join("; ")}${omitted}`);
  }
  if (projection.resourceType === "Binary") {
    lines.push("Binary payload: not decoded or interpreted; review the cited raw resource if authorized.");
  }

  const maximumSummaryCharacters = 256 * 1_024;
  const omissionMarker = "[Additional normalized facts omitted; review the cited raw resource.]";
  let summary = lines.join("\n");
  if (summary.length > maximumSummaryCharacters) {
    const retained: string[] = [];
    let retainedCharacters = 0;
    for (const line of lines) {
      const separator = retained.length === 0 ? 0 : 1;
      if (
        retainedCharacters + separator + line.length + 1 + omissionMarker.length >
        maximumSummaryCharacters
      ) break;
      retained.push(line);
      retainedCharacters += separator + line.length;
    }
    summary = [...retained, omissionMarker].join("\n");
  }

  return insightRecordSchema.parse({
    insightId: `fhir-resource-summary:v1:${projection.provenance.contentHash.slice("sha256:".length)}`,
    accountRef: projection.accountRef,
    patientSubjectId: projection.patientSubjectId,
    insightType: resourceInsightType(projection.resourceType),
    insight: summary,
    sourceResourceVersions: [projection.provenance],
    generatedAt,
    generator: {
      kind: "rules",
      rulesVersion: "normalized-fhir-resource-summary-v1",
    },
    status: "generated",
  });
}
