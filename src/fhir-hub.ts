import { createHash, createHmac } from "node:crypto";

import { z } from "zod";

import {
  createCareTeamSummaryInsight,
  insightRecordSchema,
  normalizeCareTeam,
  normalizedCareTeamSchema,
  sourceResourceVersionRefSchema,
  type InsightRecord,
  type NormalizedCareTeam,
  type SourceResourceVersionRef,
} from "./care-team.js";
import {
  canonicalJson,
  cloneCanonicalJson,
} from "./canonical-json.js";
import { AppError } from "./errors.js";
import {
  assertNormalizedFhirResourceMatchesSource,
  createFhirResourceSummaryInsight,
  FhirNormalizationError,
  normalizeFhirResource,
  normalizedFhirResourceSchema,
  type FhirNormalizationErrorCode,
  type NormalizedFhirResource,
} from "./fhir-intelligence.js";
import type { AppConfig, ConnectionRecord } from "./types.js";

const opaqueRefSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const fhirTypeSchema = z.string().regex(/^[A-Z][A-Za-z0-9]{0,63}$/);
const fhirIdSchema = z.string().regex(/^[A-Za-z0-9\-.]{1,64}$/);
const instantSchema = z.string().datetime({ offset: true });
const jsonObjectSchema = z.record(z.string(), z.unknown());

export const fhirHubIdentitySchema = z.object({
  accountRef: opaqueRefSchema,
  sourceConnectionId: opaqueRefSchema,
  patientSubjectId: opaqueRefSchema,
  fhirIssuer: z.string().url().max(8_192),
});

export type FhirHubIdentity = z.infer<typeof fhirHubIdentitySchema>;

export const fhirHubConsentReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  purpose: z.literal("longitudinal-health-hub"),
  policyVersion: z.string().min(1).max(100),
  acceptedAt: instantSchema,
  retentionMs: z.number().int().positive().max(3_650 * 24 * 60 * 60 * 1_000),
});

export type FhirHubConsentReceipt = z.infer<typeof fhirHubConsentReceiptSchema>;

const normalizationRulesVersion = "normalized-fhir-resource-v1";

export const fhirNormalizationResultSchema = z.discriminatedUnion("status", [
  z.object({
    schemaVersion: z.literal(1),
    status: z.literal("normalized"),
    rulesVersion: z.literal(normalizationRulesVersion),
    projection: normalizedFhirResourceSchema,
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    status: z.literal("failed"),
    rulesVersion: z.literal(normalizationRulesVersion),
    code: z.enum([
      "invalid_resource_shape",
      "unsupported_resource_type",
      "unsupported_modifier_semantics",
    ]),
  }).strict(),
]);

export type FhirNormalizationResult = z.infer<typeof fhirNormalizationResultSchema>;

export const fhirHubResourceVersionSchema = z.object({
  schemaVersion: z.literal(1),
  versionKey: z.string().regex(/^[a-f0-9]{64}$/),
  currentKey: z.string().regex(/^[a-f0-9]{64}$/),
  provenance: sourceResourceVersionRefSchema,
  firstSeenAt: instantSchema,
  lastSeenAt: instantSchema,
  expiresAt: instantSchema,
  raw: jsonObjectSchema,
  normalization: fhirNormalizationResultSchema.optional(),
  normalizedCareTeam: normalizedCareTeamSchema.optional(),
  projectionError: z.enum(["care_team_normalization_failed"]).optional(),
}).superRefine((value, context) => {
  if (value.raw.resourceType !== value.provenance.resourceType ||
    value.raw.id !== value.provenance.resourceId) {
    context.addIssue({
      code: "custom",
      path: ["raw"],
      message: "The raw resource identity does not match its provenance.",
    });
  }
  if (fhirContentHash(value.raw) !== value.provenance.contentHash) {
    context.addIssue({
      code: "custom",
      path: ["provenance", "contentHash"],
      message: "The raw resource content hash does not match its provenance.",
    });
  }
  if (currentKeyForSource(value.provenance) !== value.currentKey) {
    context.addIssue({
      code: "custom",
      path: ["currentKey"],
      message: "The current-resource key does not match its provenance.",
    });
  }
  if (versionKeyForSource(value.provenance) !== value.versionKey) {
    context.addIssue({
      code: "custom",
      path: ["versionKey"],
      message: "The resource version key does not match its provenance.",
    });
  }
  if (value.normalization !== undefined) {
    try {
      const expected = deriveResourceIntelligence(value.raw, value.provenance).normalization;
      if (canonicalJson(expected) !== canonicalJson(value.normalization)) {
        context.addIssue({
          code: "custom",
          path: ["normalization"],
          message: "The normalization result does not match its raw source version.",
        });
      }
      if (value.normalization.status === "normalized") {
        assertNormalizedFhirResourceMatchesSource(
          value.raw,
          value.provenance,
          value.normalization.projection,
        );
      }
    } catch {
      context.addIssue({
        code: "custom",
        path: ["normalization"],
        message: "The normalization result is invalid for its raw source version.",
      });
    }
  }
  if (value.normalizedCareTeam !== undefined) {
    try {
      const expected = normalizeCareTeam(value.raw, value.provenance);
      if (canonicalJson(expected) !== canonicalJson(value.normalizedCareTeam)) {
        context.addIssue({
          code: "custom",
          path: ["normalizedCareTeam"],
          message: "The CareTeam projection does not match its raw source version.",
        });
      }
    } catch {
      context.addIssue({
        code: "custom",
        path: ["normalizedCareTeam"],
        message: "The CareTeam projection is invalid for its raw source version.",
      });
    }
  }
  if (value.provenance.resourceType === "CareTeam") {
    if ((value.normalizedCareTeam === undefined) === (value.projectionError === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["normalizedCareTeam"],
        message: "A CareTeam version must have exactly one projection or projection error.",
      });
    }
  } else if (value.normalizedCareTeam !== undefined || value.projectionError !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["normalizedCareTeam"],
      message: "Only CareTeam versions may carry a CareTeam projection result.",
    });
  }
});

export type FhirHubResourceVersion = z.infer<typeof fhirHubResourceVersionSchema>;

const profileSchema = z.object({
  identity: fhirHubIdentitySchema,
  consent: fhirHubConsentReceiptSchema,
  updatedAt: instantSchema,
});

const fhirHubStateValidatedSchema = z.object({
  schemaVersion: z.literal(1),
  profiles: z.record(z.string(), profileSchema),
  resourceVersions: z.record(z.string(), fhirHubResourceVersionSchema),
  currentResources: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  insights: z.record(z.string(), insightRecordSchema),
}).superRefine((value, context) => {
  for (const [accountRef, profile] of Object.entries(value.profiles)) {
    if (accountRef !== profile.identity.accountRef) {
      context.addIssue({
        code: "custom",
        path: ["profiles", accountRef],
        message: "The hub profile key does not match its account reference.",
      });
    }
    if (profile.updatedAt !== profile.consent.acceptedAt) {
      context.addIssue({
        code: "custom",
        path: ["profiles", accountRef, "updatedAt"],
        message: "The hub profile update time does not match its consent receipt.",
      });
    }
  }
  for (const [versionKey, version] of Object.entries(value.resourceVersions)) {
    if (versionKey !== version.versionKey) {
      context.addIssue({
        code: "custom",
        path: ["resourceVersions", versionKey],
        message: "The resource version map key is invalid.",
      });
    }
    const profile = value.profiles[version.provenance.accountRef];
    if (profile === undefined) {
      context.addIssue({
        code: "custom",
        path: ["resourceVersions", versionKey, "provenance", "accountRef"],
        message: "The resource version has no owning hub profile.",
      });
      continue;
    }
    if (version.firstSeenAt !== version.provenance.retrievedAt) {
      context.addIssue({
        code: "custom",
        path: ["resourceVersions", versionKey, "firstSeenAt"],
        message: "The resource first-seen time does not match its immutable provenance.",
      });
    }
    if (epoch(version.lastSeenAt) < epoch(version.firstSeenAt)) {
      context.addIssue({
        code: "custom",
        path: ["resourceVersions", versionKey, "lastSeenAt"],
        message: "The resource last-seen time precedes its first-seen time.",
      });
    }
    const retentionAnchor = Math.max(
      epoch(version.lastSeenAt),
      epoch(profile.consent.acceptedAt),
    );
    if (epoch(version.expiresAt) !== retentionAnchor + profile.consent.retentionMs) {
      context.addIssue({
        code: "custom",
        path: ["resourceVersions", versionKey, "expiresAt"],
        message: "The resource expiry does not match its approved retention window.",
      });
    }
    if (version.normalization?.status === "normalized") {
      const expectedRulesVersion = version.provenance.resourceType === "CareTeam"
        ? "care-team-summary-v1"
        : "normalized-fhir-resource-summary-v1";
      const deterministicSummaries = Object.values(value.insights).filter((insight) =>
        insight.generator.kind === "rules" &&
        insight.generator.rulesVersion === expectedRulesVersion &&
        insight.sourceResourceVersions.length === 1 &&
        versionKeyForSource(insight.sourceResourceVersions[0]!) === versionKey);
      if (deterministicSummaries.length !== 1) {
        context.addIssue({
          code: "custom",
          path: ["resourceVersions", versionKey, "normalization"],
          message: "A normalized resource version must have exactly one deterministic summary.",
        });
      }
    }
  }
  for (const [currentKey, versionKey] of Object.entries(value.currentResources)) {
    const version = value.resourceVersions[versionKey];
    if (!version || version.currentKey !== currentKey) {
      context.addIssue({
        code: "custom",
        path: ["currentResources", currentKey],
        message: "The current-resource pointer is invalid.",
      });
    }
  }
  for (const [insightId, insight] of Object.entries(value.insights)) {
    if (insightId !== insight.insightId || insight.sourceResourceVersions.some((source) => {
      const citedVersion = value.resourceVersions[versionKeyForSource(source)];
      return citedVersion === undefined ||
        canonicalJson(citedVersion.provenance) !== canonicalJson(source);
    })) {
      context.addIssue({
        code: "custom",
        path: ["insights", insightId],
        message: "The insight key or source-version citation is invalid.",
      });
    }
    if (
      insight.generator.kind === "rules" &&
      (
        insight.generator.rulesVersion === "care-team-summary-v1" ||
        insight.generator.rulesVersion === "normalized-fhir-resource-summary-v1"
      ) &&
      !deterministicRulesInsightMatchesSource(value, insight)
    ) {
      context.addIssue({
        code: "custom",
        path: ["insights", insightId, "insight"],
        message: "The deterministic insight does not match its cited source version.",
      });
    }
    if (
      insight.generator.kind === "rules" &&
      (
        insight.generator.rulesVersion === "care-team-summary-v1" ||
        insight.generator.rulesVersion === "normalized-fhir-resource-summary-v1"
      ) &&
      insight.sourceResourceVersions.some((source) =>
        value.resourceVersions[versionKeyForSource(source)]?.normalization?.status === "failed") &&
      insight.status !== "superseded"
    ) {
      context.addIssue({
        code: "custom",
        path: ["insights", insightId, "status"],
        message: "A deterministic summary for a failed normalization must be superseded.",
      });
    }
    if (insight.supersedesInsightId !== undefined) {
      const superseded = value.insights[insight.supersedesInsightId];
      if (
        superseded === undefined ||
        superseded.accountRef !== insight.accountRef ||
        superseded.patientSubjectId !== insight.patientSubjectId
      ) {
        context.addIssue({
          code: "custom",
          path: ["insights", insightId, "supersedesInsightId"],
          message: "The superseded-insight link is invalid.",
        });
      }
    }
  }
  for (const insightId of Object.keys(value.insights)) {
    const visited = new Set<string>([insightId]);
    let cursor = value.insights[insightId]?.supersedesInsightId;
    while (cursor !== undefined) {
      if (visited.has(cursor)) {
        context.addIssue({
          code: "custom",
          path: ["insights", insightId, "supersedesInsightId"],
          message: "The insight supersession chain contains a cycle.",
        });
        break;
      }
      visited.add(cursor);
      cursor = value.insights[cursor]?.supersedesInsightId;
    }
  }
});

export const fhirHubStateSchema = z.preprocess(
  migrateLegacyIntelligenceState,
  fhirHubStateValidatedSchema,
);

export type FhirHubState = z.infer<typeof fhirHubStateSchema>;

export interface FhirHubStatus {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly consentCurrent: boolean;
  readonly consentPolicyVersion: string;
  readonly acceptedAt?: string;
  readonly retentionDays?: number;
  readonly currentResourceCount: number;
  readonly resourceVersionCount: number;
  readonly careTeamCount: number;
  readonly normalizedResourceCount: number;
  readonly normalizationFailureCount: number;
  readonly insightCount: number;
  readonly oldestExpiry?: string;
}

export interface FhirHubIngestResult {
  readonly accepted: boolean;
  readonly resourcesSeen: number;
  readonly versionsCreated: number;
  readonly currentResourcesUpdated: number;
  readonly projectionsCreated: number;
  readonly projectionFailures: number;
}

export interface FhirHubListOptions {
  readonly resourceType?: string;
  readonly includeHistory?: boolean;
  readonly limit?: number;
}

export interface FhirHubIntelligenceOptions extends FhirHubListOptions {
  readonly includeSuperseded?: boolean;
}

export interface FhirHubProjectionView {
  readonly versionKey: string;
  readonly current: boolean;
  readonly provenance: SourceResourceVersionRef;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  readonly normalization?: FhirNormalizationResult;
  readonly projectionError?: "care_team_normalization_failed";
}

export interface FhirHubIntelligenceView {
  readonly schemaVersion: 1;
  readonly projections: readonly FhirHubProjectionView[];
  readonly insights: readonly InsightRecord[];
  readonly hasMore: boolean;
}

export interface FhirHubExport {
  readonly schemaVersion: 1;
  readonly intelligenceSchemaVersion: 1;
  readonly exportedAt: string;
  readonly accountRef: string;
  readonly consent: FhirHubConsentReceipt;
  readonly resourceVersions: readonly FhirHubResourceVersion[];
  readonly insights: readonly InsightRecord[];
}

export interface FhirHubRepository {
  readonly durable: boolean;
  initialize(): Promise<void>;
  close(): Promise<void>;
  checkReadiness(): Promise<void>;
  enable(identity: FhirHubIdentity, receipt: FhirHubConsentReceipt): Promise<FhirHubStatus>;
  status(
    identity: FhirHubIdentity,
    currentPolicyVersion: string,
    now: number,
  ): Promise<FhirHubStatus>;
  ingest(
    identity: FhirHubIdentity,
    value: unknown,
    currentPolicyVersion: string,
    retrievedAt: number,
  ): Promise<FhirHubIngestResult>;
  list(
    identity: FhirHubIdentity,
    options?: FhirHubListOptions,
  ): Promise<readonly FhirHubResourceVersion[]>;
  intelligence(
    identity: FhirHubIdentity,
    options?: FhirHubIntelligenceOptions,
  ): Promise<FhirHubIntelligenceView>;
  exportAccount(identity: FhirHubIdentity, now: number): Promise<FhirHubExport>;
  deleteAccount(identity: FhirHubIdentity): Promise<{
    readonly deleted: true;
    readonly resourcesDeleted: number | null;
  }>;
  pruneExpired(now: number): Promise<number>;
}

export interface FhirHubStatePersistence {
  readonly durable: boolean;
  initialize(): Promise<void>;
  load(): Promise<FhirHubState | undefined>;
  save(state: FhirHubState): Promise<void>;
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}

function emptyState(): FhirHubState {
  return {
    schemaVersion: 1,
    profiles: {},
    resourceVersions: {},
    currentResources: {},
    insights: {},
  };
}

class MemoryStatePersistence implements FhirHubStatePersistence {
  public readonly durable = false;
  #state: FhirHubState | undefined;

  public async initialize(): Promise<void> {}

  public async load(): Promise<FhirHubState | undefined> {
    return this.#state === undefined
      ? undefined
      : fhirHubStateSchema.parse(cloneCanonicalJson(this.#state));
  }

  public async save(state: FhirHubState): Promise<void> {
    this.#state = fhirHubStateSchema.parse(cloneCanonicalJson(state));
  }

  public async checkReadiness(): Promise<void> {}

  public async close(): Promise<void> {
    this.#state = undefined;
  }
}

function epoch(instant: string): number {
  return Date.parse(instant);
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function hashParts(domain: string, ...parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(domain, "utf8");
  for (const part of parts) {
    hash.update("\0", "utf8");
    hash.update(part, "utf8");
  }
  return hash.digest("hex");
}

export function fhirContentHash(value: unknown): string {
  try {
    return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
  } catch (error) {
    throw new AppError(502, "invalid_fhir_json", "FHIR returned invalid JSON.", { cause: error });
  }
}

function keyedReference(key: Buffer, domain: string, ...parts: readonly string[]): string {
  if (key.length !== 32) {
    throw new AppError(500, "invalid_encryption_key", "The FHIR hub identity key must be 32 bytes.");
  }
  const hmac = createHmac("sha256", key).update(domain, "utf8");
  for (const part of parts) hmac.update("\0", "utf8").update(part, "utf8");
  return hmac.digest("base64url");
}

/**
 * Produces provider-scoped opaque identifiers. It intentionally does not try
 * to merge patients across organizations using names, dates of birth, or MRNs.
 */
export function createFhirHubIdentity(
  config: AppConfig,
  record: ConnectionRecord,
): FhirHubIdentity {
  if (!config.fhirHubIdentityKey) {
    throw new AppError(503, "fhir_hub_unavailable", "The private health hub is not configured.");
  }
  if (!record.oidcIssuer || !record.oidcSubject) {
    throw new AppError(401, "reconnect_required", "Reconnect MyChart to verify the account identity.");
  }
  const accountRef = keyedReference(
    config.fhirHubIdentityKey,
    "fhir-hub-account:v1",
    record.oidcIssuer,
    record.oidcSubject,
  );
  const sourceConnectionId = keyedReference(
    config.fhirHubIdentityKey,
    "fhir-hub-source:v1",
    record.fhirBaseUrl,
    record.oauthClientId,
  );
  const patientSubjectId = keyedReference(
    config.fhirHubIdentityKey,
    "fhir-hub-patient:v1",
    accountRef,
    sourceConnectionId,
    record.patientId,
  );
  return fhirHubIdentitySchema.parse({
    accountRef,
    sourceConnectionId,
    patientSubjectId,
    fhirIssuer: record.fhirBaseUrl,
  });
}

function sourceResources(value: unknown): readonly Record<string, unknown>[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const candidate = value as Record<string, unknown>;
  if (candidate.resourceType !== "Bundle") return [candidate];
  if (!Array.isArray(candidate.entry)) return [];
  return candidate.entry.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const resource = (entry as Record<string, unknown>).resource;
    return resource && typeof resource === "object" && !Array.isArray(resource)
      ? [resource as Record<string, unknown>]
      : [];
  });
}

function provenanceFor(
  identity: FhirHubIdentity,
  raw: Record<string, unknown>,
  retrievedAt: number,
): SourceResourceVersionRef | undefined {
  const resourceType = fhirTypeSchema.safeParse(raw.resourceType);
  const resourceId = fhirIdSchema.safeParse(raw.id);
  if (!resourceType.success || !resourceId.success || resourceType.data === "OperationOutcome") return undefined;
  const meta = raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta)
    ? raw.meta as Record<string, unknown>
    : undefined;
  const versionId = fhirIdSchema.safeParse(meta?.versionId);
  const lastUpdated = instantSchema.safeParse(meta?.lastUpdated);
  return sourceResourceVersionRefSchema.parse({
    ...identity,
    resourceType: resourceType.data,
    resourceId: resourceId.data,
    ...(versionId.success ? { versionId: versionId.data } : {}),
    ...(lastUpdated.success ? { lastUpdated: lastUpdated.data } : {}),
    retrievedAt: iso(retrievedAt),
    contentHash: fhirContentHash(raw),
  });
}

function assertSameAccount(expected: FhirHubIdentity, actual: FhirHubIdentity): void {
  if (expected.accountRef !== actual.accountRef) {
    throw new AppError(409, "fhir_hub_identity_changed", "The health hub account context changed.");
  }
}

function belongsToAccount(version: FhirHubResourceVersion, accountRef: string): boolean {
  return version.provenance.accountRef === accountRef;
}

function currentKeyForSource(source: SourceResourceVersionRef): string {
  return hashParts(
    "fhir-hub-current:v1",
    source.accountRef,
    source.sourceConnectionId,
    source.patientSubjectId,
    source.resourceType,
    source.resourceId,
  );
}

function versionKeyForSource(source: SourceResourceVersionRef): string {
  return hashParts("fhir-hub-version:v1", currentKeyForSource(source), source.contentHash);
}

interface DerivedResourceIntelligence {
  readonly normalization: FhirNormalizationResult;
  readonly normalizedCareTeam?: NormalizedCareTeam;
  readonly legacyProjectionError?: "care_team_normalization_failed";
}

function failedNormalization(code: FhirNormalizationErrorCode): FhirNormalizationResult {
  return {
    schemaVersion: 1,
    status: "failed",
    rulesVersion: normalizationRulesVersion,
    code,
  };
}

function deriveResourceIntelligence(
  raw: unknown,
  provenance: SourceResourceVersionRef,
): DerivedResourceIntelligence {
  let projection: NormalizedFhirResource;
  try {
    projection = normalizeFhirResource(raw, provenance);
  } catch (error) {
    if (!(error instanceof FhirNormalizationError)) throw error;
    return {
      normalization: failedNormalization(error.code),
      ...(provenance.resourceType === "CareTeam"
        ? { legacyProjectionError: "care_team_normalization_failed" as const }
        : {}),
    };
  }

  if (provenance.resourceType === "CareTeam") {
    try {
      const normalizedCareTeam = normalizeCareTeam(raw, provenance);
      return {
        normalization: {
          schemaVersion: 1,
          status: "normalized",
          rulesVersion: normalizationRulesVersion,
          projection,
        },
        normalizedCareTeam,
      };
    } catch (error) {
      if (!(error instanceof z.ZodError) && !(
        error instanceof Error &&
        error.message === "CareTeam modifier semantics must be understood before creating a projection."
      )) throw error;
      return {
        normalization: failedNormalization(
          error instanceof z.ZodError
            ? "invalid_resource_shape"
            : "unsupported_modifier_semantics",
        ),
        legacyProjectionError: "care_team_normalization_failed",
      };
    }
  }

  return {
    normalization: {
      schemaVersion: 1,
      status: "normalized",
      rulesVersion: normalizationRulesVersion,
      projection,
    },
  };
}

function summaryInsightFor(
  derived: DerivedResourceIntelligence,
  provenance: SourceResourceVersionRef,
  generatedAt: string,
): InsightRecord | undefined {
  if (derived.normalization.status !== "normalized") return undefined;
  const base = provenance.resourceType === "CareTeam" && derived.normalizedCareTeam !== undefined
    ? createCareTeamSummaryInsight(derived.normalizedCareTeam, generatedAt)
    : createFhirResourceSummaryInsight(derived.normalization.projection, generatedAt);
  const insightId = provenance.resourceType === "CareTeam"
    ? `care-team-summary:v1:${hashParts(
      "fhir-hub-insight:v1",
      provenance.accountRef,
      provenance.sourceConnectionId,
      provenance.patientSubjectId,
      provenance.contentHash,
    )}`
    : `fhir-resource-summary:v1:${hashParts(
      "fhir-hub-insight:v2",
      provenance.accountRef,
      provenance.sourceConnectionId,
      provenance.patientSubjectId,
      provenance.resourceType,
      provenance.resourceId,
      provenance.contentHash,
      base.insightType,
      normalizationRulesVersion,
    )}`;
  return { ...base, insightId };
}

function migrateLegacyIntelligenceState(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const state = input as Record<string, unknown>;
  const resourceVersions = state.resourceVersions;
  const currentResources = state.currentResources;
  const storedInsights = state.insights;
  if (
    !resourceVersions || typeof resourceVersions !== "object" || Array.isArray(resourceVersions) ||
    !currentResources || typeof currentResources !== "object" || Array.isArray(currentResources) ||
    !storedInsights || typeof storedInsights !== "object" || Array.isArray(storedInsights)
  ) return input;

  const versionRecords = resourceVersions as Record<string, unknown>;
  const currentVersionKeys = new Set(
    Object.values(currentResources as Record<string, unknown>)
      .filter((value): value is string => typeof value === "string"),
  );
  const insights = { ...(storedInsights as Record<string, unknown>) };
  let changed = false;

  for (const [insightId, insightInput] of Object.entries(insights)) {
    const parsedInsight = insightRecordSchema.safeParse(insightInput);
    if (!parsedInsight.success) continue;
    const insight = parsedInsight.data;
    if (
      insight.generator.kind !== "rules" ||
      (
        insight.generator.rulesVersion !== "care-team-summary-v1" &&
        insight.generator.rulesVersion !== "normalized-fhir-resource-summary-v1"
      ) ||
      insight.status === "superseded"
    ) continue;
    const citesFailedNormalization = insight.sourceResourceVersions.some((source) => {
      const version = versionRecords[versionKeyForSource(source)];
      if (!version || typeof version !== "object" || Array.isArray(version)) return false;
      const normalization = (version as Record<string, unknown>).normalization;
      return normalization !== undefined &&
        typeof normalization === "object" &&
        !Array.isArray(normalization) &&
        (normalization as Record<string, unknown>).status === "failed";
    });
    if (!citesFailedNormalization) continue;
    insights[insightId] = { ...(insightInput as Record<string, unknown>), status: "superseded" };
    changed = true;
  }

  for (const [versionKey, versionInput] of Object.entries(versionRecords)) {
    const parsedVersion = fhirHubResourceVersionSchema.safeParse(versionInput);
    if (!parsedVersion.success || parsedVersion.data.normalization?.status !== "normalized") continue;
    const version = parsedVersion.data;
    const expectedRulesVersion = version.provenance.resourceType === "CareTeam"
      ? "care-team-summary-v1"
      : "normalized-fhir-resource-summary-v1";
    const hasSummary = Object.values(insights).some((insightInput) => {
      const parsedInsight = insightRecordSchema.safeParse(insightInput);
      return parsedInsight.success &&
        parsedInsight.data.generator.kind === "rules" &&
        parsedInsight.data.generator.rulesVersion === expectedRulesVersion &&
        parsedInsight.data.sourceResourceVersions.length === 1 &&
        versionKeyForSource(parsedInsight.data.sourceResourceVersions[0]!) === versionKey;
    });
    if (hasSummary) continue;
    const generated = summaryInsightFor(
      deriveResourceIntelligence(version.raw, version.provenance),
      version.provenance,
      version.firstSeenAt,
    );
    if (generated === undefined || insights[generated.insightId] !== undefined) continue;
    insights[generated.insightId] = currentVersionKeys.has(versionKey)
      ? generated
      : { ...generated, status: "superseded" };
    changed = true;
  }

  return changed ? { ...state, insights } : input;
}

function deterministicRulesInsightMatchesSource(
  state: FhirHubState,
  insight: InsightRecord,
): boolean {
  if (insight.sourceResourceVersions.length !== 1) return false;
  const source = insight.sourceResourceVersions[0]!;
  const version = state.resourceVersions[versionKeyForSource(source)];
  if (version === undefined) return false;
  try {
    const expected = insight.generator.kind === "rules" &&
        insight.generator.rulesVersion === "care-team-summary-v1"
      ? createCareTeamSummaryInsight(
        normalizeCareTeam(version.raw, version.provenance),
        insight.generatedAt,
      )
      : createFhirResourceSummaryInsight(
        normalizeFhirResource(version.raw, version.provenance),
        insight.generatedAt,
      );
    const immutableActual = {
      accountRef: insight.accountRef,
      patientSubjectId: insight.patientSubjectId,
      insightType: insight.insightType,
      insight: insight.insight,
      sourceResourceVersions: insight.sourceResourceVersions,
      generatedAt: insight.generatedAt,
      generator: insight.generator,
      ...(insight.confidence === undefined ? {} : { confidence: insight.confidence }),
    };
    const immutableExpected = {
      accountRef: expected.accountRef,
      patientSubjectId: expected.patientSubjectId,
      insightType: expected.insightType,
      insight: expected.insight,
      sourceResourceVersions: expected.sourceResourceVersions,
      generatedAt: expected.generatedAt,
      generator: expected.generator,
      ...(expected.confidence === undefined ? {} : { confidence: expected.confidence }),
    };
    return canonicalJson(immutableActual) === canonicalJson(immutableExpected);
  } catch {
    return false;
  }
}

function insightsForVersion(
  state: FhirHubState,
  versionKey: string | undefined,
): InsightRecord[] {
  if (versionKey === undefined) return [];
  return Object.values(state.insights).filter((candidate) =>
    candidate.sourceResourceVersions.some((source) => versionKeyForSource(source) === versionKey));
}

function reactivatedInsightStatus(insight: InsightRecord): InsightRecord["status"] {
  if (insight.userConfirmation?.decision === "dismissed") return "dismissed";
  if (
    insight.userConfirmation?.decision === "confirmed" ||
    insight.userConfirmation?.decision === "corrected"
  ) return "confirmed";
  return "generated";
}

function allInsightSourcesCurrent(
  state: FhirHubState,
  insight: InsightRecord,
  candidateCurrentKey: string,
  candidateVersionKey: string,
): boolean {
  return insight.sourceResourceVersions.every((source) => {
    const sourceCurrentKey = currentKeyForSource(source);
    const currentVersionKey = sourceCurrentKey === candidateCurrentKey
      ? candidateVersionKey
      : state.currentResources[sourceCurrentKey];
    return currentVersionKey === versionKeyForSource(source);
  });
}

function shouldBecomeCurrent(
  state: FhirHubState,
  currentKey: string,
  candidate: SourceResourceVersionRef,
  observedAt: number,
): boolean {
  const currentVersionKey = state.currentResources[currentKey];
  if (currentVersionKey === undefined || currentVersionKey === versionKeyForSource(candidate)) return true;
  const current = state.resourceVersions[currentVersionKey];
  if (!current) return true;
  const candidateUpdatedAt = candidate.lastUpdated === undefined
    ? undefined
    : epoch(candidate.lastUpdated);
  const currentUpdatedAt = current.provenance.lastUpdated === undefined
    ? undefined
    : epoch(current.provenance.lastUpdated);
  if (candidateUpdatedAt !== undefined && currentUpdatedAt !== undefined &&
    candidateUpdatedAt !== currentUpdatedAt) {
    return candidateUpdatedAt > currentUpdatedAt;
  }
  if (candidateUpdatedAt !== undefined && currentUpdatedAt === undefined) return true;
  if (candidateUpdatedAt === undefined && currentUpdatedAt !== undefined) return false;
  return observedAt >= epoch(current.lastSeenAt);
}

function applyDerivedIntelligence(
  version: FhirHubResourceVersion,
  derived: DerivedResourceIntelligence,
): void {
  version.normalization = derived.normalization;
  if (version.provenance.resourceType !== "CareTeam") return;
  if (derived.normalizedCareTeam !== undefined) {
    version.normalizedCareTeam = derived.normalizedCareTeam;
    delete version.projectionError;
  } else {
    delete version.normalizedCareTeam;
    version.projectionError = derived.legacyProjectionError ?? "care_team_normalization_failed";
  }
}

function ensureSummaryInsight(
  state: FhirHubState,
  version: FhirHubResourceVersion,
  derived: DerivedResourceIntelligence,
  generatedAt: string,
): InsightRecord | undefined {
  const generated = summaryInsightFor(derived, version.provenance, generatedAt);
  if (generated === undefined) return undefined;
  const existing = insightsForVersion(state, version.versionKey)
    .find((candidate) => sameDeterministicSummaryRule(candidate, generated));
  if (existing !== undefined) return existing;
  const isCurrent = state.currentResources[version.currentKey] === version.versionKey;
  const stored = isCurrent ? generated : { ...generated, status: "superseded" as const };
  state.insights[stored.insightId] = stored;
  return stored;
}

function sameDeterministicSummaryRule(
  candidate: InsightRecord,
  generated: InsightRecord,
): boolean {
  return candidate.insightType === generated.insightType &&
    candidate.generator.kind === "rules" &&
    generated.generator.kind === "rules" &&
    candidate.generator.rulesVersion === generated.generator.rulesVersion;
}

function supersedeInsightsForVersion(
  state: FhirHubState,
  versionKey: string,
): void {
  for (const insight of insightsForVersion(state, versionKey)) {
    if (insight.status === "superseded") continue;
    state.insights[insight.insightId] = {
      ...insight,
      status: "superseded",
    };
  }
}

function intelligenceSourceReference(
  source: SourceResourceVersionRef,
): SourceResourceVersionRef {
  return {
    accountRef: source.accountRef,
    sourceConnectionId: source.sourceConnectionId,
    patientSubjectId: source.patientSubjectId,
    fhirIssuer: source.fhirIssuer,
    resourceType: source.resourceType,
    resourceId: source.resourceId,
    ...(source.versionId === undefined ? {} : { versionId: source.versionId }),
    ...(source.lastUpdated === undefined ? {} : { lastUpdated: source.lastUpdated }),
    retrievedAt: source.retrievedAt,
    contentHash: source.contentHash,
  };
}

function intelligenceNormalization(
  normalization: FhirNormalizationResult,
): FhirNormalizationResult {
  if (normalization.status === "failed") {
    return {
      schemaVersion: 1,
      status: "failed",
      rulesVersion: normalization.rulesVersion,
      code: normalization.code,
    };
  }
  return {
    schemaVersion: 1,
    status: "normalized",
    rulesVersion: normalization.rulesVersion,
    projection: {
      ...normalization.projection,
      provenance: intelligenceSourceReference(normalization.projection.provenance),
    },
  };
}

function intelligenceInsight(insight: InsightRecord): InsightRecord {
  const generator = insight.generator.kind === "rules"
    ? {
      kind: "rules" as const,
      rulesVersion: insight.generator.rulesVersion,
    }
    : {
      kind: "model" as const,
      provider: insight.generator.provider,
      model: insight.generator.model,
      modelVersion: insight.generator.modelVersion,
      promptVersion: insight.generator.promptVersion,
    };
  const userConfirmation = insight.userConfirmation === undefined
    ? undefined
    : {
      decision: insight.userConfirmation.decision,
      accountRef: insight.userConfirmation.accountRef,
      recordedAt: insight.userConfirmation.recordedAt,
      ...(insight.userConfirmation.note === undefined
        ? {}
        : { note: insight.userConfirmation.note }),
    };
  return {
    insightId: insight.insightId,
    accountRef: insight.accountRef,
    patientSubjectId: insight.patientSubjectId,
    insightType: insight.insightType,
    insight: insight.insight,
    sourceResourceVersions: insight.sourceResourceVersions.map(intelligenceSourceReference),
    generatedAt: insight.generatedAt,
    generator,
    ...(insight.confidence === undefined ? {} : { confidence: insight.confidence }),
    status: insight.status,
    ...(userConfirmation === undefined ? {} : { userConfirmation }),
    ...(insight.supersedesInsightId === undefined
      ? {}
      : { supersedesInsightId: insight.supersedesInsightId }),
  };
}

export class StateBackedFhirHubRepository implements FhirHubRepository {
  public readonly durable: boolean;
  #state: FhirHubState = emptyState();
  #initialized = false;
  #queue: Promise<void> = Promise.resolve();

  public constructor(private readonly persistence: FhirHubStatePersistence) {
    this.durable = persistence.durable;
  }

  public async initialize(): Promise<void> {
    if (this.#initialized) return;
    await this.persistence.initialize();
    const saved = await this.persistence.load();
    this.#state = saved === undefined ? emptyState() : fhirHubStateSchema.parse(saved);
    this.#initialized = true;
  }

  public async close(): Promise<void> {
    await this.#queue;
    this.#initialized = false;
    this.#state = emptyState();
    await this.persistence.close();
  }

  public async checkReadiness(): Promise<void> {
    this.requireInitialized();
    await this.persistence.checkReadiness();
  }

  public async enable(
    identityInput: FhirHubIdentity,
    receiptInput: FhirHubConsentReceipt,
  ): Promise<FhirHubStatus> {
    const identity = fhirHubIdentitySchema.parse(identityInput);
    const receipt = fhirHubConsentReceiptSchema.parse(receiptInput);
    const acceptedAt = epoch(receipt.acceptedAt);
    // Never extend data that already crossed its prior retention boundary.
    await this.pruneExpired(acceptedAt);
    await this.mutate((state) => {
      const existing = state.profiles[identity.accountRef];
      if (existing) assertSameAccount(identity, existing.identity);
      state.profiles[identity.accountRef] = {
        identity,
        consent: receipt,
        updatedAt: receipt.acceptedAt,
      };
      for (const version of Object.values(state.resourceVersions)) {
        if (!belongsToAccount(version, identity.accountRef)) continue;
        version.expiresAt = iso(
          Math.max(acceptedAt, epoch(version.lastSeenAt)) + receipt.retentionMs,
        );
        // Historical raw data is normalized only after this explicit consent
        // receipt. Operators must issue a new policy version when expanding the
        // approved intelligence purpose; startup alone never backfills PHI.
        const derived = deriveResourceIntelligence(version.raw, version.provenance);
        applyDerivedIntelligence(version, derived);
        if (derived.normalization.status === "failed") {
          supersedeInsightsForVersion(state, version.versionKey);
        } else {
          ensureSummaryInsight(state, version, derived, receipt.acceptedAt);
        }
      }
    });
    return this.status(identity, receipt.policyVersion, acceptedAt);
  }

  public async status(
    identityInput: FhirHubIdentity,
    currentPolicyVersion: string,
    now: number,
  ): Promise<FhirHubStatus> {
    const identity = fhirHubIdentitySchema.parse(identityInput);
    await this.pruneExpired(now);
    const state = this.currentState();
    const profile = state.profiles[identity.accountRef];
    if (profile) assertSameAccount(identity, profile.identity);
    const versions = Object.values(state.resourceVersions)
      .filter((version) => belongsToAccount(version, identity.accountRef));
    const currentKeys = new Set(Object.values(state.currentResources));
    const current = versions.filter((version) => currentKeys.has(version.versionKey));
    const insights = Object.values(state.insights)
      .filter((insight) => insight.accountRef === identity.accountRef && insight.status !== "superseded");
    const expiries = versions.map((version) => version.expiresAt).sort();
    return {
      available: true,
      enabled: profile !== undefined,
      consentCurrent: profile !== undefined && profile.consent.policyVersion === currentPolicyVersion,
      consentPolicyVersion: currentPolicyVersion,
      ...(profile ? {
        acceptedAt: profile.consent.acceptedAt,
        retentionDays: Math.ceil(profile.consent.retentionMs / (24 * 60 * 60 * 1_000)),
      } : {}),
      currentResourceCount: current.length,
      resourceVersionCount: versions.length,
      careTeamCount: current.filter((version) => version.normalizedCareTeam !== undefined).length,
      normalizedResourceCount: current.filter((version) =>
        version.normalization?.status === "normalized").length,
      normalizationFailureCount: current.filter((version) =>
        version.normalization?.status === "failed").length,
      insightCount: insights.length,
      ...(expiries[0] ? { oldestExpiry: expiries[0] } : {}),
    };
  }

  public async ingest(
    identityInput: FhirHubIdentity,
    value: unknown,
    currentPolicyVersion: string,
    retrievedAt: number,
  ): Promise<FhirHubIngestResult> {
    const identity = fhirHubIdentitySchema.parse(identityInput);
    // A newly observed copy may start a new retention window, but an expired
    // copy must first be removed so its original first-seen history is not
    // silently resurrected.
    await this.pruneExpired(retrievedAt);
    const resources = sourceResources(value).map(cloneCanonicalJson);
    let versionsCreated = 0;
    let currentResourcesUpdated = 0;
    let projectionsCreated = 0;
    let projectionFailures = 0;
    let accepted = false;
    await this.mutate((state) => {
      const profile = state.profiles[identity.accountRef];
      if (!profile || profile.consent.policyVersion !== currentPolicyVersion) return;
      assertSameAccount(identity, profile.identity);
      accepted = true;
      for (const raw of resources) {
        const provenance = provenanceFor(identity, raw, retrievedAt);
        if (!provenance) continue;
        const currentKey = currentKeyForSource(provenance);
        const versionKey = hashParts("fhir-hub-version:v1", currentKey, provenance.contentHash);
        const seenAt = iso(retrievedAt);
        const expiresAt = iso(retrievedAt + profile.consent.retentionMs);
        const promoteToCurrent = shouldBecomeCurrent(
          state,
          currentKey,
          provenance,
          retrievedAt,
        );
        const existing = state.resourceVersions[versionKey];
        if (existing) {
          existing.lastSeenAt = seenAt;
          existing.expiresAt = expiresAt;
          const previousVersionKey = state.currentResources[currentKey];
          if (existing.normalization === undefined) {
            const derived = deriveResourceIntelligence(existing.raw, existing.provenance);
            applyDerivedIntelligence(existing, derived);
            if (derived.normalization.status === "normalized") projectionsCreated += 1;
            else projectionFailures += 1;
            const generated = summaryInsightFor(derived, existing.provenance, seenAt);
            if (derived.normalization.status === "failed") {
              supersedeInsightsForVersion(state, versionKey);
            }
            const alreadyStored = insightsForVersion(state, versionKey)
              .some((candidate) => generated !== undefined &&
                sameDeterministicSummaryRule(candidate, generated));
            if (generated !== undefined && !alreadyStored) {
              const previousSameType = insightsForVersion(state, previousVersionKey)
                .find((candidate) => sameDeterministicSummaryRule(candidate, generated));
              state.insights[generated.insightId] = promoteToCurrent
                ? previousSameType && previousVersionKey !== versionKey
                  ? { ...generated, supersedesInsightId: previousSameType.insightId }
                  : generated
                : { ...generated, status: "superseded" };
            }
          }
          if (promoteToCurrent && previousVersionKey !== versionKey) {
            const previousInsights = insightsForVersion(state, previousVersionKey);
            const reactivatedInsights = insightsForVersion(state, versionKey);
            for (const previousInsight of previousInsights) {
              if (previousInsight.status !== "superseded") {
                state.insights[previousInsight.insightId] = {
                  ...previousInsight,
                  status: "superseded",
                };
              }
            }
            for (const reactivatedInsight of reactivatedInsights) {
              if (
                existing.normalization?.status === "normalized" &&
                reactivatedInsight.status === "superseded" &&
                allInsightSourcesCurrent(state, reactivatedInsight, currentKey, versionKey)
              ) {
                state.insights[reactivatedInsight.insightId] = {
                  ...reactivatedInsight,
                  status: reactivatedInsightStatus(reactivatedInsight),
                };
              }
            }
            currentResourcesUpdated += 1;
          }
          if (promoteToCurrent) state.currentResources[currentKey] = versionKey;
          continue;
        }

        const version: FhirHubResourceVersion = {
          schemaVersion: 1,
          versionKey,
          currentKey,
          provenance,
          firstSeenAt: seenAt,
          lastSeenAt: seenAt,
          expiresAt,
          raw,
        };
        const previousVersionKey = promoteToCurrent
          ? state.currentResources[currentKey]
          : undefined;
        const previousInsights = insightsForVersion(state, previousVersionKey);
        const derived = deriveResourceIntelligence(raw, provenance);
        applyDerivedIntelligence(version, derived);
        if (derived.normalization.status === "normalized") projectionsCreated += 1;
        else projectionFailures += 1;
        if (promoteToCurrent) {
          for (const previousInsight of previousInsights) {
            if (previousInsight.status !== "superseded") {
              state.insights[previousInsight.insightId] = {
                ...previousInsight,
                status: "superseded",
              };
            }
          }
        }
        const generated = summaryInsightFor(derived, provenance, seenAt);
        if (generated !== undefined) {
          const previousSameType = previousInsights.find((previousInsight) =>
            sameDeterministicSummaryRule(previousInsight, generated));
          state.insights[generated.insightId] = promoteToCurrent
            ? previousSameType
              ? { ...generated, supersedesInsightId: previousSameType.insightId }
              : generated
            : { ...generated, status: "superseded" };
        }
        state.resourceVersions[versionKey] = fhirHubResourceVersionSchema.parse(version);
        if (promoteToCurrent) state.currentResources[currentKey] = versionKey;
        versionsCreated += 1;
        if (promoteToCurrent) currentResourcesUpdated += 1;
      }
    });
    return {
      accepted,
      resourcesSeen: resources.length,
      versionsCreated,
      currentResourcesUpdated,
      projectionsCreated,
      projectionFailures,
    };
  }

  public async list(
    identityInput: FhirHubIdentity,
    options: FhirHubListOptions = {},
  ): Promise<readonly FhirHubResourceVersion[]> {
    const identity = fhirHubIdentitySchema.parse(identityInput);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1_000);
    const currentKeys = new Set(Object.values(this.currentState().currentResources));
    const versions = Object.values(this.currentState().resourceVersions)
      .filter((version) =>
        version.provenance.accountRef === identity.accountRef &&
        version.provenance.sourceConnectionId === identity.sourceConnectionId &&
        version.provenance.patientSubjectId === identity.patientSubjectId &&
        (options.resourceType === undefined || version.provenance.resourceType === options.resourceType) &&
        (options.includeHistory === true || currentKeys.has(version.versionKey)))
      .sort((left, right) => right.provenance.retrievedAt.localeCompare(left.provenance.retrievedAt))
      .slice(0, limit);
    return cloneCanonicalJson(versions);
  }

  public async intelligence(
    identityInput: FhirHubIdentity,
    options: FhirHubIntelligenceOptions = {},
  ): Promise<FhirHubIntelligenceView> {
    const identity = fhirHubIdentitySchema.parse(identityInput);
    const state = this.currentState();
    const profile = state.profiles[identity.accountRef];
    if (!profile) {
      throw new AppError(404, "fhir_hub_not_enabled", "The private health hub has not been enabled.");
    }
    assertSameAccount(identity, profile.identity);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 250);
    const currentVersionKeys = new Set(Object.values(state.currentResources));
    const candidates = Object.values(state.resourceVersions)
      .filter((version) =>
        version.provenance.accountRef === identity.accountRef &&
        version.provenance.sourceConnectionId === identity.sourceConnectionId &&
        version.provenance.patientSubjectId === identity.patientSubjectId &&
        (options.resourceType === undefined || version.provenance.resourceType === options.resourceType) &&
        (options.includeHistory === true || currentVersionKeys.has(version.versionKey)) &&
        (
          version.normalization !== undefined ||
          version.normalizedCareTeam !== undefined ||
          version.projectionError !== undefined
        ))
      .sort((left, right) => right.provenance.retrievedAt.localeCompare(left.provenance.retrievedAt));
    const selected = candidates.slice(0, limit);
    const selectedVersionKeys = new Set(selected.map((version) => version.versionKey));
    const insightCandidates = Object.values(state.insights)
      .filter((insight) =>
        insight.accountRef === identity.accountRef &&
        insight.patientSubjectId === identity.patientSubjectId &&
        (options.includeSuperseded === true || insight.status !== "superseded") &&
        insight.sourceResourceVersions.every((source) =>
          selectedVersionKeys.has(versionKeyForSource(source))))
      .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
    const projections: FhirHubProjectionView[] = selected.map((version) => ({
      versionKey: version.versionKey,
      current: currentVersionKeys.has(version.versionKey),
      provenance: intelligenceSourceReference(version.provenance),
      firstSeenAt: version.firstSeenAt,
      lastSeenAt: version.lastSeenAt,
      expiresAt: version.expiresAt,
      ...(version.normalization === undefined
        ? {}
        : { normalization: intelligenceNormalization(version.normalization) }),
      ...(version.projectionError === undefined
        ? {}
        : { projectionError: version.projectionError }),
    }));
    return cloneCanonicalJson({
      schemaVersion: 1,
      projections,
      insights: insightCandidates.slice(0, limit).map(intelligenceInsight),
      hasMore: candidates.length > limit || insightCandidates.length > limit,
    });
  }

  public async exportAccount(
    identityInput: FhirHubIdentity,
    now: number,
  ): Promise<FhirHubExport> {
    const identity = fhirHubIdentitySchema.parse(identityInput);
    await this.pruneExpired(now);
    const state = this.currentState();
    const profile = state.profiles[identity.accountRef];
    if (!profile) {
      throw new AppError(404, "fhir_hub_not_enabled", "The private health hub has not been enabled.");
    }
    assertSameAccount(identity, profile.identity);
    return {
      schemaVersion: 1,
      intelligenceSchemaVersion: 1,
      exportedAt: iso(now),
      accountRef: identity.accountRef,
      consent: cloneCanonicalJson(profile.consent),
      resourceVersions: cloneCanonicalJson(Object.values(state.resourceVersions)
        .filter((version) => belongsToAccount(version, identity.accountRef))
        .sort((left, right) => left.provenance.retrievedAt.localeCompare(right.provenance.retrievedAt))),
      insights: cloneCanonicalJson(Object.values(state.insights)
        .filter((insight) => insight.accountRef === identity.accountRef)
        .sort((left, right) => left.generatedAt.localeCompare(right.generatedAt))),
    };
  }

  public async deleteAccount(
    identityInput: FhirHubIdentity,
  ): Promise<{ readonly deleted: true; readonly resourcesDeleted: number | null }> {
    const identity = fhirHubIdentitySchema.parse(identityInput);
    let resourcesDeleted = 0;
    await this.mutate((state) => {
      const profile = state.profiles[identity.accountRef];
      if (profile) assertSameAccount(identity, profile.identity);
      delete state.profiles[identity.accountRef];
      for (const [versionKey, version] of Object.entries(state.resourceVersions)) {
        if (!belongsToAccount(version, identity.accountRef)) continue;
        delete state.resourceVersions[versionKey];
        resourcesDeleted += 1;
      }
      for (const [currentKey, versionKey] of Object.entries(state.currentResources)) {
        if (state.resourceVersions[versionKey] === undefined) delete state.currentResources[currentKey];
      }
      for (const [insightId, insight] of Object.entries(state.insights)) {
        if (insight.accountRef === identity.accountRef) delete state.insights[insightId];
      }
    });
    return { deleted: true, resourcesDeleted };
  }

  public async pruneExpired(now: number): Promise<number> {
    let deleted = 0;
    await this.mutate((state) => {
      const removed = new Set<string>();
      for (const [versionKey, version] of Object.entries(state.resourceVersions)) {
        if (epoch(version.expiresAt) > now) continue;
        delete state.resourceVersions[versionKey];
        removed.add(versionKey);
        deleted += 1;
      }
      for (const [currentKey, versionKey] of Object.entries(state.currentResources)) {
        if (!removed.has(versionKey)) continue;
        const replacement = Object.values(state.resourceVersions)
          .filter((version) => version.currentKey === currentKey)
          .sort((left, right) => {
            const leftUpdated = left.provenance.lastUpdated;
            const rightUpdated = right.provenance.lastUpdated;
            if (leftUpdated !== undefined && rightUpdated !== undefined && leftUpdated !== rightUpdated) {
              const updatedOrder = epoch(rightUpdated) - epoch(leftUpdated);
              if (updatedOrder !== 0) return updatedOrder;
            }
            if (leftUpdated !== undefined && rightUpdated === undefined) return -1;
            if (leftUpdated === undefined && rightUpdated !== undefined) return 1;
            const seenOrder = right.lastSeenAt.localeCompare(left.lastSeenAt);
            return seenOrder === 0 ? left.versionKey.localeCompare(right.versionKey) : seenOrder;
          })[0];
        if (replacement) {
          state.currentResources[currentKey] = replacement.versionKey;
          const replacementInsights = insightsForVersion(state, replacement.versionKey);
          for (const replacementInsight of replacementInsights) {
            if (
              replacement.normalization?.status === "normalized" &&
              replacementInsight.status === "superseded" &&
              allInsightSourcesCurrent(
                state,
                replacementInsight,
                currentKey,
                replacement.versionKey,
              )
            ) {
              state.insights[replacementInsight.insightId] = {
                ...replacementInsight,
                status: reactivatedInsightStatus(replacementInsight),
              };
            }
          }
        } else {
          delete state.currentResources[currentKey];
        }
      }
      const remainingVersions = new Set(Object.keys(state.resourceVersions));
      for (const [insightId, insight] of Object.entries(state.insights)) {
        if (insight.sourceResourceVersions.some((source) =>
          !remainingVersions.has(versionKeyForSource(source)))) {
          delete state.insights[insightId];
        }
      }
      for (const [insightId, insight] of Object.entries(state.insights)) {
        if (
          insight.supersedesInsightId !== undefined &&
          state.insights[insight.supersedesInsightId] === undefined
        ) {
          const { supersedesInsightId: _removed, ...withoutExpiredLink } = insight;
          state.insights[insightId] = withoutExpiredLink;
        }
      }
    }, deleted > 0);
    return deleted;
  }

  /** Returns the next retained-version expiry from the already validated state. */
  public nextExpiry(): number | undefined {
    const expiries = Object.values(this.currentState().resourceVersions)
      .map((version) => epoch(version.expiresAt));
    return expiries.length === 0 ? undefined : Math.min(...expiries);
  }

  private requireInitialized(): void {
    if (!this.#initialized) {
      throw new AppError(500, "fhir_hub_not_initialized", "The private health hub is not initialized.");
    }
  }

  private currentState(): FhirHubState {
    this.requireInitialized();
    return this.#state;
  }

  private async mutate(
    mutation: (state: FhirHubState) => void,
    persistEvenWhenUnchanged = true,
  ): Promise<void> {
    this.requireInitialized();
    let operation!: Promise<void>;
    operation = this.#queue.then(async () => {
      const draft = cloneCanonicalJson(this.#state);
      mutation(draft);
      const parsed = fhirHubStateSchema.parse(draft);
      if (persistEvenWhenUnchanged || canonicalJson(parsed) !== canonicalJson(this.#state)) {
        await this.persistence.save(parsed);
      }
      this.#state = parsed;
    });
    this.#queue = operation.catch(() => undefined);
    await operation;
  }
}

export class InMemoryFhirHubRepository extends StateBackedFhirHubRepository {
  public constructor() {
    super(new MemoryStatePersistence());
  }
}

export class DisabledFhirHubRepository implements FhirHubRepository {
  public readonly durable = false;

  public async initialize(): Promise<void> {}
  public async close(): Promise<void> {}
  public async checkReadiness(): Promise<void> {}

  public async enable(): Promise<FhirHubStatus> {
    throw new AppError(503, "fhir_hub_unavailable", "The private health hub is not configured.");
  }

  public async status(
    _identity: FhirHubIdentity,
    currentPolicyVersion: string,
    _now: number,
  ): Promise<FhirHubStatus> {
    return {
      available: false,
      enabled: false,
      consentCurrent: false,
      consentPolicyVersion: currentPolicyVersion,
      currentResourceCount: 0,
      resourceVersionCount: 0,
      careTeamCount: 0,
      normalizedResourceCount: 0,
      normalizationFailureCount: 0,
      insightCount: 0,
    };
  }

  public async ingest(): Promise<FhirHubIngestResult> {
    return {
      accepted: false,
      resourcesSeen: 0,
      versionsCreated: 0,
      currentResourcesUpdated: 0,
      projectionsCreated: 0,
      projectionFailures: 0,
    };
  }

  public async list(): Promise<readonly FhirHubResourceVersion[]> {
    return [];
  }

  public async intelligence(): Promise<FhirHubIntelligenceView> {
    throw new AppError(503, "fhir_hub_unavailable", "The private health hub is not configured.");
  }

  public async exportAccount(): Promise<FhirHubExport> {
    throw new AppError(503, "fhir_hub_unavailable", "The private health hub is not configured.");
  }

  public async deleteAccount(): Promise<{
    readonly deleted: true;
    readonly resourcesDeleted: number | null;
  }> {
    return { deleted: true, resourcesDeleted: 0 };
  }

  public async pruneExpired(): Promise<number> {
    return 0;
  }
}

export type { InsightRecord, NormalizedCareTeam, SourceResourceVersionRef };
