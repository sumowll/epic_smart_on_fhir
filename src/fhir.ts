import { AppError, ReconnectRequiredError, UpstreamError } from "./errors.js";
import { requestJson } from "./http.js";
import {
  assertSmartReadResourceAuthorized,
  authorizeSmartSearchWithContext,
  authorizedSmartReadGrants,
  parseSmartScopes,
  type SmartScopeConstraint,
} from "./smart-scopes.js";
import type {
  AppConfig,
  ConnectionRecord,
  FetchLike,
  FhirResourceCapability,
} from "./types.js";

const allowedSearchParameters = new Set([
  "_count",
  "_sort",
  "authoredon",
  "category",
  "class",
  "clinical-status",
  "code",
  "date",
  "docstatus",
  "status",
  "type",
]);

export function isUserControllableSearchParameter(name: string): boolean {
  return name !== "_count" && name !== "_sort" && allowedSearchParameters.has(name);
}

const fhirIdPattern = /^[A-Za-z0-9\-.]{1,64}$/;
const provenanceReverseInclude = "Provenance:target";

type ResourceSearchStrategy = "patient" | "scope-restricted" | "reference-only";

export interface FhirSearchResult {
  readonly bundle: unknown;
  readonly constraints: readonly SmartScopeConstraint[];
  readonly includeProvenance: boolean;
}

/**
 * Clinical and patient-compartment resources use the standard `patient`
 * search parameter. Supporting resources are searched only under the server's
 * patient-level SMART authorization and must never receive an invalid generic
 * `patient=` parameter. Binary is resolved by an authorized instance read from
 * a DocumentReference rather than listed as a standalone search.
 */
const resourceSearchStrategies: Readonly<Record<string, ResourceSearchStrategy>> = {
  AllergyIntolerance: "patient",
  Binary: "reference-only",
  CarePlan: "patient",
  CareTeam: "patient",
  Condition: "patient",
  Device: "patient",
  DiagnosticReport: "patient",
  DocumentReference: "patient",
  Encounter: "patient",
  Goal: "patient",
  Immunization: "patient",
  Location: "scope-restricted",
  Medication: "scope-restricted",
  MedicationRequest: "patient",
  Observation: "patient",
  Organization: "scope-restricted",
  Practitioner: "scope-restricted",
  PractitionerRole: "scope-restricted",
  Procedure: "patient",
  Provenance: "patient",
  RelatedPerson: "patient",
};

export function serverSupportsSmartSearch(
  resourceType: string,
  advertisedParameters: readonly string[],
  requestedParameters: Iterable<string> = [],
): boolean {
  const strategy = resourceSearchStrategies[resourceType];
  if (!strategy || strategy === "reference-only") return false;
  const advertised = new Set(advertisedParameters);
  const required = new Set(requestedParameters);
  if (strategy === "patient") required.add("patient");
  required.delete("_count");
  required.delete("_sort");
  return [...required].every((name) => advertised.has(name));
}

function hasOperationOutcomeIssue(json: unknown): boolean {
  if (!json || typeof json !== "object") return false;
  const outcome = json as Record<string, unknown>;
  if (outcome.resourceType !== "OperationOutcome" || !Array.isArray(outcome.issue)) {
    return false;
  }
  return outcome.issue.some((candidate) => candidate !== null && typeof candidate === "object");
}

function requireObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function invalidFhirResponse(message: string): UpstreamError {
  return new UpstreamError("invalid_fhir_response", message);
}

function validateReadResource(
  json: unknown,
  expectedResourceType: string,
  expectedId: string,
): Record<string, unknown> {
  const resource = requireObject(json);
  if (
    !resource ||
    resource.resourceType !== expectedResourceType ||
    resource.id !== expectedId
  ) {
    throw invalidFhirResponse(`Epic returned an invalid ${expectedResourceType} resource.`);
  }
  return resource;
}

function referenceTargetsSearchResult(
  reference: string,
  primaryResources: readonly {
    readonly relativeReference: string;
    readonly fullUrl?: string;
  }[],
  fhirBaseUrl: string,
): boolean {
  const normalized = reference.split(/[?#]/, 1)[0]!.replace(/\/+$/, "");
  return primaryResources.some(({ relativeReference, fullUrl }) => {
    if (
      reference === fullUrl ||
      normalized === relativeReference ||
      normalized.startsWith(`${relativeReference}/_history/`)
    ) {
      return true;
    }
    try {
      const absolute = new URL(normalized);
      const base = new URL(`${fhirBaseUrl.replace(/\/+$/, "")}/`);
      if (
        absolute.protocol !== base.protocol ||
        absolute.origin !== base.origin ||
        absolute.username ||
        absolute.password
      ) {
        return false;
      }
      const expected = new URL(relativeReference, base).toString().replace(/\/+$/, "");
      return absolute.toString() === expected ||
        absolute.toString().startsWith(`${expected}/_history/`);
    } catch {
      return false;
    }
  });
}

function validateSearchBundle(
  json: unknown,
  expectedResourceType: string,
  includeProvenance = false,
  fhirBaseUrl = "https://invalid.example/",
): Record<string, unknown> {
  const bundle = requireObject(json);
  if (!bundle || bundle.resourceType !== "Bundle" || bundle.type !== "searchset") {
    throw invalidFhirResponse(`Epic returned an invalid ${expectedResourceType} search Bundle.`);
  }
  if (bundle.entry === undefined) return bundle;
  if (!Array.isArray(bundle.entry)) {
    throw invalidFhirResponse(`Epic returned an invalid ${expectedResourceType} search Bundle.`);
  }
  const entries: Array<{
    readonly entry: Record<string, unknown>;
    readonly resource: Record<string, unknown>;
  }> = [];
  const primaryResources: Array<{
    readonly relativeReference: string;
    readonly fullUrl?: string;
  }> = [];
  for (const entry of bundle.entry) {
    const entryObject = requireObject(entry);
    const resource = requireObject(entryObject?.resource);
    if (
      !resource ||
      (
        resource.resourceType !== expectedResourceType &&
        resource.resourceType !== "OperationOutcome" &&
        !(includeProvenance && resource.resourceType === "Provenance")
      )
    ) {
      throw invalidFhirResponse(`Epic returned an unexpected resource in the ${expectedResourceType} search Bundle.`);
    }
    if (
      (resource.resourceType === expectedResourceType || resource.resourceType === "Provenance") &&
      (typeof resource.id !== "string" || !fhirIdPattern.test(resource.id))
    ) {
      throw invalidFhirResponse(`Epic returned an invalid resource in the ${expectedResourceType} search Bundle.`);
    }
    entries.push({ entry: entryObject!, resource });
    if (resource.resourceType === expectedResourceType) {
      primaryResources.push({
        relativeReference: `${expectedResourceType}/${resource.id as string}`,
        ...(typeof entryObject?.fullUrl === "string" ? { fullUrl: entryObject.fullUrl } : {}),
      });
    }
  }
  for (const { entry, resource } of entries) {
    if (!includeProvenance) break;
    if (resource.resourceType !== "Provenance") continue;
    const search = requireObject(entry.search);
    if (search?.mode !== "include" || !Array.isArray(resource.target)) {
      throw invalidFhirResponse(`Epic returned an invalid Provenance include in the ${expectedResourceType} search Bundle.`);
    }
    const targetsSearchResult = resource.target.some((candidate) => {
      const target = requireObject(candidate);
      return typeof target?.reference === "string" &&
        referenceTargetsSearchResult(target.reference, primaryResources, fhirBaseUrl);
    });
    if (!targetsSearchResult) {
      throw invalidFhirResponse(`Epic returned an unrelated Provenance include in the ${expectedResourceType} search Bundle.`);
    }
  }
  return bundle;
}

function parseRetryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? Math.min(seconds, 7 * 24 * 60 * 60) : undefined;
  }
  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) return undefined;
  return Math.min(Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000)), 7 * 24 * 60 * 60);
}

export class EpicRateLimitError extends AppError {
  public constructor(public readonly retryAfterSeconds?: number) {
    super(
      429,
      "epic_rate_limited",
      retryAfterSeconds === undefined
        ? "Epic is rate limiting requests. Please try again later."
        : `Epic is rate limiting requests. Please try again in ${retryAfterSeconds} seconds.`,
    );
    this.name = "EpicRateLimitError";
  }
}

function splitAuthenticateParameters(challenge: string): string[] {
  const parameters: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < challenge.length; index += 1) {
    const character = challenge[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === ",") {
      parameters.push(challenge.slice(start, index));
      start = index + 1;
    }
  }
  parameters.push(challenge.slice(start));
  return parameters;
}

function hasInsufficientScopeChallenge(response: Response): boolean {
  const challenge = response.headers.get("www-authenticate");
  if (challenge === null) return false;
  for (const parameter of splitAuthenticateParameters(challenge)) {
    const match = /(?:^|\s)error\s*=\s*(?:"([^"]*)"|([!#$%&'*+.^_`|~0-9A-Za-z-]+))\s*$/i.exec(parameter);
    if ((match?.[1] ?? match?.[2]) === "insufficient_scope") return true;
  }
  return false;
}

function forbiddenError(
  response: Response,
  json: unknown,
  resourceType: string,
  interaction: "read" | "search",
): AppError {
  if (hasInsufficientScopeChallenge(response)) {
    return new AppError(
      403,
      "fhir_scope_denied",
      `Epic accepted the access token, but this grant lacks ${resourceType} ${interaction} permission. Wait for the Epic app changes to sync, then disconnect and reconnect so Epic can issue a new grant.`,
    );
  }

  if (hasOperationOutcomeIssue(json)) {
    return new AppError(
      403,
      "fhir_access_denied",
      `Epic returned a FHIR access-denied outcome for ${resourceType} ${interaction}. This can reflect patient/user security, context, or client/API configuration; it is not proof that an Incoming API is missing.`,
    );
  }

  return new AppError(
    403,
    "fhir_access_denied",
    `Epic denied ${resourceType} ${interaction}. Confirm the matching R4 Incoming API is attached to this client ID, wait for Epic's app record to sync, then disconnect and reconnect.`,
  );
}

export function sanitizeSearchParameters(input: URLSearchParams): URLSearchParams {
  const output = new URLSearchParams();
  let valuesSeen = 0;
  for (const [key, value] of input) {
    valuesSeen += 1;
    if (valuesSeen > 30) {
      throw new AppError(400, "too_many_search_parameters", "Too many FHIR search parameters were supplied.");
    }
    if (!allowedSearchParameters.has(key)) {
      throw new AppError(400, "search_parameter_not_allowed", `FHIR search parameter is not allowed: ${key}`);
    }
    if (!value || value.length > 512 || /[\r\n\0]/.test(value)) {
      throw new AppError(400, "invalid_search_parameter", `FHIR search parameter is invalid: ${key}`);
    }
    if (key === "_count") {
      const count = Number(value);
      if (!Number.isInteger(count) || count < 1 || count > 100) {
        throw new AppError(400, "invalid_count", "_count must be an integer between 1 and 100.");
      }
    }
    output.append(key, value);
  }
  if (!output.has("_count")) output.set("_count", "50");
  return output;
}

export class EpicFhirClient {
  public constructor(
    private readonly config: AppConfig,
    private readonly fetch: FetchLike = globalThis.fetch,
  ) {}

  public async readPatient(record: ConnectionRecord): Promise<unknown> {
    const patientId = this.requireFhirId(record.patientId, "patient ID");
    this.requireFhirCapability(record, "Patient", "read");
    const grants = authorizedSmartReadGrants(record.scope, "Patient");
    const json = await this.get(record, `Patient/${encodeURIComponent(patientId)}`, "Patient", "read");
    const resource = validateReadResource(json, "Patient", patientId);
    assertSmartReadResourceAuthorized("Patient", resource, grants);
    return resource;
  }

  public async read(
    record: ConnectionRecord,
    resourceType: string,
    id: string,
  ): Promise<unknown> {
    this.requireAllowedType(resourceType);
    if (resourceType === "Binary") {
      throw new AppError(
        400,
        "binary_reference_required",
        "Direct Binary attachment access is disabled until a verified document-reference workflow is used.",
      );
    }
    this.requireFhirCapability(record, resourceType, "read");
    const resourceId = this.requireFhirId(id, "resource ID");
    const grants = authorizedSmartReadGrants(record.scope, resourceType);
    const json = await this.get(
      record,
      `${resourceType}/${encodeURIComponent(resourceId)}`,
      resourceType,
      "read",
    );
    const resource = validateReadResource(json, resourceType, resourceId);
    assertSmartReadResourceAuthorized(resourceType, resource, grants);
    return resource;
  }

  public async search(
    record: ConnectionRecord,
    resourceType: string,
    input: URLSearchParams,
  ): Promise<unknown> {
    return (await this.searchWithContext(record, resourceType, input)).bundle;
  }

  public async searchWithContext(
    record: ConnectionRecord,
    resourceType: string,
    input: URLSearchParams,
  ): Promise<FhirSearchResult> {
    this.requireAllowedType(resourceType);
    const capability = this.requireFhirCapability(record, resourceType, "search");
    const strategy = resourceSearchStrategies[resourceType];
    if (!strategy) {
      throw new AppError(
        403,
        "resource_search_strategy_missing",
        "That FHIR resource type does not have an approved patient-safe search strategy.",
      );
    }
    if (strategy === "reference-only") {
      throw new AppError(
        400,
        "resource_search_not_supported",
        `${resourceType} is available only when referenced by another authorized record.`,
      );
    }

    const parameters = sanitizeSearchParameters(input);
    if (strategy === "patient") {
      parameters.set("patient", this.requireFhirId(record.patientId, "patient ID"));
    }
    const authorization = authorizeSmartSearchWithContext(
      record.scope,
      resourceType,
      parameters,
    );
    if (!serverSupportsSmartSearch(
      resourceType,
      capability.searchParameters,
      authorization.parameters.keys(),
    )) {
      throw new AppError(
        409,
        "fhir_search_parameter_unavailable",
        `The connected Epic R4 endpoint does not advertise the parameters required for ${resourceType} search.`,
      );
    }
    const includeProvenance = this.supportsProvenanceReverseInclude(
      record,
      resourceType,
      capability,
    );
    if (includeProvenance) {
      authorization.parameters.set("_revinclude", provenanceReverseInclude);
    }
    const json = await this.get(
      record,
      `${resourceType}?${authorization.parameters.toString()}`,
      resourceType,
      "search",
    );
    return {
      bundle: validateSearchBundle(json, resourceType, includeProvenance, record.fhirBaseUrl),
      constraints: authorization.constraints,
      includeProvenance,
    };
  }

  public async page(
    record: ConnectionRecord,
    resourceType: string,
    nextUrl: string,
    constraints: readonly SmartScopeConstraint[] = [],
    includeProvenance = false,
  ): Promise<unknown> {
    this.requireAllowedType(resourceType);
    const capability = this.requireFhirCapability(record, resourceType, "search");
    if (record.fhirBaseUrl !== this.config.fhirBaseUrl) {
      throw new AppError(500, "issuer_mismatch", "The saved Epic connection has an unexpected issuer.");
    }
    const protectedParameters = new URLSearchParams();
    for (const { name, value } of constraints) protectedParameters.append(name, value);
    const currentAuthorization = authorizeSmartSearchWithContext(
      record.scope,
      resourceType,
      protectedParameters,
    );
    if (
      (constraints.length === 0 && currentAuthorization.constraints.length > 0) ||
      (constraints.length > 0 &&
        currentAuthorization.constraints.length > 0 &&
        !this.sameConstraints(constraints, currentAuthorization.constraints))
    ) {
      throw new AppError(
        403,
        "fhir_scope_constraint_conflict",
        `The ${resourceType} continuation no longer matches the current MyChart grant.`,
      );
    }
    if (!serverSupportsSmartSearch(
      resourceType,
      capability.searchParameters,
      constraints.map(({ name }) => name),
    )) {
      throw new AppError(
        409,
        "fhir_search_parameter_unavailable",
        `The connected Epic R4 endpoint does not advertise the parameters required for ${resourceType} search.`,
      );
    }
    if (
      includeProvenance &&
      !this.supportsProvenanceReverseInclude(record, resourceType, capability)
    ) {
      throw new AppError(
        409,
        "provenance_revinclude_unavailable",
        `The current MyChart connection no longer permits Provenance with ${resourceType} search.`,
      );
    }
    const url = this.requireSafePageUrl(
      record,
      resourceType,
      nextUrl,
      constraints,
      includeProvenance,
    );
    const json = await this.getUrl(record, url, resourceType, "search");
    return validateSearchBundle(json, resourceType, includeProvenance, record.fhirBaseUrl);
  }

  private supportsProvenanceReverseInclude(
    record: ConnectionRecord,
    resourceType: string,
    capability: FhirResourceCapability,
  ): boolean {
    if (
      resourceType === "Provenance" ||
      !this.config.allowedResourceTypes.has("Provenance") ||
      !(capability.searchRevIncludes ?? []).includes(provenanceReverseInclude)
    ) {
      return false;
    }
    const provenanceCapability = record.fhirCapabilities?.find(
      (candidate) => candidate.resourceType === "Provenance",
    );
    if (!provenanceCapability?.interactions.includes("read")) return false;
    return parseSmartScopes(record.scope).some((grant) =>
      grant.context === "patient" &&
      (grant.resourceType === "Provenance" || grant.resourceType === "*") &&
      grant.permissions.has("read") &&
      grant.constraints.length === 0);
  }

  private requireAllowedType(resourceType: string): void {
    if (!this.config.allowedResourceTypes.has(resourceType)) {
      throw new AppError(403, "resource_type_not_allowed", "That FHIR resource type is not enabled.");
    }
  }

  private requireFhirId(value: string, label: string): string {
    if (!fhirIdPattern.test(value)) {
      throw new AppError(400, "invalid_fhir_id", `The ${label} is invalid.`);
    }
    return value;
  }

  private requireFhirCapability(
    record: ConnectionRecord,
    resourceType: string,
    interaction: "read" | "search",
  ): FhirResourceCapability {
    const capability = record.fhirCapabilities?.find(
      (candidate) => candidate.resourceType === resourceType,
    );
    if (!capability?.interactions.includes(interaction)) {
      throw new AppError(
        409,
        "fhir_capability_unavailable",
        `The connected Epic R4 endpoint does not advertise ${resourceType} ${interaction}. Reconnect after the provider enables it.`,
      );
    }
    return capability;
  }

  private requireSafePageUrl(
    record: ConnectionRecord,
    resourceType: string,
    value: string,
    constraints: readonly SmartScopeConstraint[],
    includeProvenance: boolean,
  ): string {
    if (value.length > 8_192) {
      throw new AppError(400, "invalid_page_cursor", "The FHIR page cursor is invalid or expired.");
    }
    let page: URL;
    try {
      page = new URL(value);
    } catch (error) {
      throw new AppError(400, "invalid_page_cursor", "The FHIR page cursor is invalid or expired.", {
        cause: error,
      });
    }
    const base = new URL(`${record.fhirBaseUrl}/`);
    const expectedPath = `${base.pathname}${resourceType}`.replace(/\/{2,}/g, "/");
    if (
      page.protocol !== "https:" ||
      page.origin !== base.origin ||
      page.username ||
      page.password ||
      page.hash ||
      page.pathname.replace(/\/{2,}/g, "/") !== expectedPath
    ) {
      throw new AppError(400, "invalid_page_cursor", "The FHIR page cursor is invalid or expired.");
    }
    let count = 0;
    for (const [name, valuePart] of page.searchParams) {
      count += 1;
      if (
        count > 50 ||
        !name ||
        name.length > 128 ||
        !valuePart ||
        valuePart.length > 2_048 ||
        /[\r\n\0]/.test(name) ||
        /[\r\n\0]/.test(valuePart) ||
        /^(?:access_token|authorization|client_secret|code|id_token|refresh_token|token)$/i.test(name)
      ) {
        throw new AppError(400, "invalid_page_cursor", "The FHIR page cursor is invalid or expired.");
      }
    }
    const suppliedPatients = page.searchParams.getAll("patient");
    if (
      suppliedPatients.length > 0 &&
      (suppliedPatients.length !== 1 || suppliedPatients[0] !== record.patientId)
    ) {
      throw new AppError(400, "invalid_page_cursor", "The FHIR page cursor is invalid or expired.");
    }
    const suppliedReverseIncludes = page.searchParams.getAll("_revinclude");
    if (
      page.searchParams.has("_include") ||
      suppliedReverseIncludes.length > 1 ||
      (
        suppliedReverseIncludes.length === 1 &&
        (!includeProvenance || suppliedReverseIncludes[0] !== provenanceReverseInclude)
      )
    ) {
      throw new AppError(400, "invalid_page_cursor", "The FHIR page cursor is invalid or expired.");
    }
    const expectedByName = new Map<string, string[]>();
    for (const { name, value: constraintValue } of constraints) {
      const values = expectedByName.get(name) ?? [];
      values.push(constraintValue);
      expectedByName.set(name, values);
    }
    for (const [name, expectedValues] of expectedByName) {
      const suppliedValues = page.searchParams.getAll(name);
      if (
        suppliedValues.length > 0 &&
        !this.sameValues(suppliedValues, expectedValues)
      ) {
        throw new AppError(400, "invalid_page_cursor", "The FHIR page cursor is invalid or expired.");
      }
    }
    return page.toString();
  }

  private sameConstraints(
    left: readonly SmartScopeConstraint[],
    right: readonly SmartScopeConstraint[],
  ): boolean {
    const normalize = (values: readonly SmartScopeConstraint[]) => values
      .map(({ name, value }) => `${name}\0${value}`)
      .sort();
    return this.sameValues(normalize(left), normalize(right));
  }

  private sameValues(left: readonly string[], right: readonly string[]): boolean {
    const normalizedLeft = [...left].sort();
    const normalizedRight = [...right].sort();
    return normalizedLeft.length === normalizedRight.length &&
      normalizedLeft.every((value, index) => value === normalizedRight[index]);
  }

  private async get(
    record: ConnectionRecord,
    relativePath: string,
    resourceType: string,
    interaction: "read" | "search",
  ): Promise<unknown> {
    if (record.fhirBaseUrl !== this.config.fhirBaseUrl) {
      throw new AppError(500, "issuer_mismatch", "The saved Epic connection has an unexpected issuer.");
    }

    return this.getUrl(
      record,
      `${record.fhirBaseUrl}/${relativePath}`,
      resourceType,
      interaction,
    );
  }

  private async getUrl(
    record: ConnectionRecord,
    url: string,
    resourceType: string,
    interaction: "read" | "search",
  ): Promise<unknown> {
    const { response, json } = await requestJson(url, {
      fetch: this.fetch,
      timeoutMs: this.config.requestTimeoutMs,
      maxBytes: this.config.maxUpstreamBytes,
      expectedStatus: [200, 400, 401, 403, 404, 422, 429],
      init: {
        headers: {
          Accept: "application/fhir+json",
          Authorization: `Bearer ${record.accessToken}`,
        },
      },
    });

    switch (response.status) {
      case 200:
        return json;
      case 400:
      case 422:
        throw new AppError(
          response.status,
          hasOperationOutcomeIssue(json) ? "fhir_request_rejected" : "fhir_invalid_request",
          interaction === "search"
            ? `Epic rejected the ${resourceType} search parameters.`
            : `Epic rejected the ${resourceType} read request.`,
        );
      case 401:
        throw new ReconnectRequiredError();
      case 403:
        throw forbiddenError(response, json, resourceType, interaction);
      case 404:
        throw new AppError(404, "fhir_resource_not_found", "The requested FHIR resource was not found.");
      case 429:
        throw new EpicRateLimitError(parseRetryAfterSeconds(response));
      default:
        throw new UpstreamError("fhir_request_failed", "The FHIR request failed.", response.status);
    }
  }
}
