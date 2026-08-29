import { AppError } from "./errors.js";

export type SmartScopeContext = "patient" | "user" | "system";

export type SmartPermission = "create" | "read" | "update" | "delete" | "search";

export interface SmartScopeConstraint {
  readonly name: string;
  readonly value: string;
}

export interface SmartScopeGrant {
  readonly context: SmartScopeContext;
  readonly resourceType: string;
  readonly permissions: ReadonlySet<SmartPermission>;
  readonly constraints: readonly SmartScopeConstraint[];
  readonly sourceScopes: readonly string[];
}

export interface AuthorizedSmartSearch {
  readonly parameters: URLSearchParams;
  /** The exact fine-grained grant selected for continuation-page checks. */
  readonly constraints: readonly SmartScopeConstraint[];
}

/**
 * The 53 resource-scope values approved for this patient-facing Epic app.
 * Keep each fine-grained value separate: they are distinct authorization
 * grants even when they target the same resource and interaction.
 */
export const EPIC_PATIENT_RESOURCE_SCOPES = [
  "patient/AllergyIntolerance.r",
  "patient/AllergyIntolerance.s",
  "patient/Binary.r",
  "patient/Binary.s",
  "patient/CarePlan.r",
  "patient/CarePlan.s",
  "patient/CareTeam.r",
  "patient/CareTeam.s",
  "patient/Condition.r",
  "patient/Condition.r?category=http://hl7.org/fhir/us/core/CodeSystem/condition-category|health-concern",
  "patient/Condition.r?category=http://terminology.hl7.org/CodeSystem/condition-category|problem-list-item",
  "patient/Condition.s",
  "patient/Condition.s?category=http://hl7.org/fhir/us/core/CodeSystem/condition-category|health-concern",
  "patient/Condition.s?category=http://terminology.hl7.org/CodeSystem/condition-category|problem-list-item",
  "patient/Device.r",
  "patient/Device.s",
  "patient/DiagnosticReport.r",
  "patient/DiagnosticReport.s",
  "patient/DocumentReference.r",
  "patient/DocumentReference.r?category=http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category|clinical-note",
  "patient/DocumentReference.s",
  "patient/DocumentReference.s?category=http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category|clinical-note",
  "patient/Encounter.r",
  "patient/Encounter.s",
  "patient/Goal.r",
  "patient/Goal.s",
  "patient/Immunization.r",
  "patient/Immunization.s",
  "patient/Location.r",
  "patient/Location.s",
  "patient/Medication.r",
  "patient/Medication.s",
  "patient/MedicationRequest.r",
  "patient/MedicationRequest.s",
  "patient/Observation.r?category=http://terminology.hl7.org/CodeSystem/observation-category|laboratory",
  "patient/Observation.r?category=http://terminology.hl7.org/CodeSystem/observation-category|social-history",
  "patient/Observation.r?category=http://terminology.hl7.org/CodeSystem/observation-category|vital-signs",
  "patient/Observation.s?category=http://terminology.hl7.org/CodeSystem/observation-category|laboratory",
  "patient/Observation.s?category=http://terminology.hl7.org/CodeSystem/observation-category|social-history",
  "patient/Observation.s?category=http://terminology.hl7.org/CodeSystem/observation-category|vital-signs",
  "patient/Organization.r",
  "patient/Organization.s",
  "patient/Patient.r",
  "patient/Patient.s",
  "patient/Practitioner.r",
  "patient/Practitioner.s",
  "patient/PractitionerRole.r",
  "patient/PractitionerRole.s",
  "patient/Procedure.r",
  "patient/Procedure.s",
  "patient/Provenance.r",
  "patient/RelatedPerson.r",
  "patient/RelatedPerson.s",
] as const;

/**
 * The scopes sent in Epic's standalone authorization request. Epic adds the
 * patient resource grants configured as Incoming APIs on the app record, so
 * the 53-value resource policy must not be copied into the authorize URL.
 */
export const EPIC_STANDALONE_AUTHORIZATION_SCOPES = [
  "openid",
  "fhirUser",
  "launch/patient",
] as const;

/** The complete approved policy catalog, not the authorize-request value. */
export const EPIC_PRODUCTION_SCOPES = [
  ...EPIC_PATIENT_RESOURCE_SCOPES,
  ...EPIC_STANDALONE_AUTHORIZATION_SCOPES,
] as const;

const resourceTypePattern = /^(?:\*|[A-Z][A-Za-z0-9]{0,63})$/;
const smartScopePattern = /^(patient|user|system)\/(\*|[A-Z][A-Za-z0-9]{0,63})\.([A-Za-z*]+)(?:\?(.+))?$/;
const malformedPercentEncodingPattern = /%(?![0-9A-Fa-f]{2})/;

const v2PermissionMap: Readonly<Record<string, SmartPermission>> = {
  c: "create",
  r: "read",
  u: "update",
  d: "delete",
  s: "search",
};

function parsePermissions(value: string): ReadonlySet<SmartPermission> | undefined {
  switch (value) {
    case "read":
      // SMART v1's `read` permission covers both instance read and search.
      return new Set<SmartPermission>(["read", "search"]);
    case "write":
      return new Set<SmartPermission>(["create", "update", "delete"]);
    case "*":
      return new Set<SmartPermission>(["create", "read", "update", "delete", "search"]);
    default: {
      // SMART v2 permits only non-empty, in-order subsets of `cruds`.
      if (!/^(?!$)c?r?u?d?s?$/.test(value)) return undefined;
      const permissions = new Set<SmartPermission>();
      for (const character of value) {
        permissions.add(v2PermissionMap[character]!);
      }
      return permissions;
    }
  }
}

function parseConstraints(value: string | undefined): readonly SmartScopeConstraint[] | undefined {
  if (value === undefined) return [];
  if (
    value.length === 0 ||
    value.length > 8_192 ||
    /[\r\n\0#]/.test(value) ||
    malformedPercentEncodingPattern.test(value)
  ) {
    return undefined;
  }

  const parsed = new URLSearchParams(value);
  const constraints: SmartScopeConstraint[] = [];
  for (const [name, constraintValue] of parsed) {
    if (
      constraints.length >= 30 ||
      name.length === 0 ||
      name.length > 128 ||
      constraintValue.length === 0 ||
      constraintValue.length > 2_048 ||
      /[\r\n\0]/.test(name) ||
      /[\r\n\0]/.test(constraintValue)
    ) {
      return undefined;
    }
    constraints.push({ name, value: constraintValue });
  }
  if (constraints.length === 0) return undefined;
  constraints.sort((left, right) =>
    left.name.localeCompare(right.name) || left.value.localeCompare(right.value));
  return constraints;
}

function grantKey(
  context: SmartScopeContext,
  resourceType: string,
  constraints: readonly SmartScopeConstraint[],
): string {
  return JSON.stringify([context, resourceType, constraints.map(({ name, value }) => [name, value])]);
}

function constraintsAreAtLeastAsRestrictive(
  granted: readonly SmartScopeConstraint[],
  requested: readonly SmartScopeConstraint[],
): boolean {
  const grantedByName = constraintsByName(granted);
  for (const [name, requestedValues] of constraintsByName(requested)) {
    const grantedValues = grantedByName.get(name);
    if (!grantedValues || !sameValues(grantedValues, requestedValues)) return false;
  }
  return true;
}

function scopeValues(input: string | readonly string[]): string[] {
  return (typeof input === "string" ? [input] : input)
    .flatMap((value) => value.split(/\s+/))
    .filter(Boolean);
}

/**
 * Parses SMART v2 `cruds` and SMART v1 `read`/`write` resource scopes.
 * Non-resource OAuth scopes and malformed resource scopes are ignored, which
 * makes subsequent authorization checks fail closed when no valid grant exists.
 */
export function parseSmartScopes(input: string | readonly string[]): readonly SmartScopeGrant[] {
  const grants = new Map<
    string,
    {
      context: SmartScopeContext;
      resourceType: string;
      permissions: Set<SmartPermission>;
      constraints: readonly SmartScopeConstraint[];
      sourceScopes: string[];
    }
  >();

  for (const scope of scopeValues(input)) {
    const match = smartScopePattern.exec(scope);
    if (!match) continue;
    const context = match[1] as SmartScopeContext;
    const resourceType = match[2]!;
    const permissions = parsePermissions(match[3]!);
    const constraints = parseConstraints(match[4]);
    if (!permissions || !constraints || !resourceTypePattern.test(resourceType)) continue;

    const key = grantKey(context, resourceType, constraints);
    const existing = grants.get(key);
    if (existing) {
      for (const permission of permissions) existing.permissions.add(permission);
      existing.sourceScopes.push(scope);
      continue;
    }
    grants.set(key, {
      context,
      resourceType,
      permissions: new Set(permissions),
      constraints,
      sourceScopes: [scope],
    });
  }

  return [...grants.values()].map((grant) => ({
    context: grant.context,
    resourceType: grant.resourceType,
    permissions: grant.permissions,
    constraints: grant.constraints,
    sourceScopes: grant.sourceScopes,
  }));
}

/**
 * Validates Epic's issued scope against two distinct controls:
 *
 * - non-resource scopes must have been sent in the standalone authorize request;
 * - resource scopes must fit the operator-approved Incoming API allowlist.
 *
 * Epic may narrow a resource grant or combine separate `.r`/`.s` values into
 * one SMART v1/v2 value. It may not add an unapproved resource, interaction,
 * context, wildcard, or less-restricted query grant.
 */
export function assertGrantedSmartScopesWithinPolicy(
  grantedInput: string | readonly string[],
  requestedAuthorizationInput: string | readonly string[],
  allowedResourceInput: string | readonly string[],
): void {
  const grantedValues = scopeValues(grantedInput);
  const grantedResourceValues = grantedValues.filter((scope) =>
    /^(?:patient|user|system)\//.test(scope));
  const grantedNonResourceValues = grantedValues.filter((scope) =>
    !/^(?:patient|user|system)\//.test(scope));
  const requestedAuthorizationValues = new Set(scopeValues(requestedAuthorizationInput));
  const granted = parseSmartScopes(grantedResourceValues);
  const parsedSources = new Set(granted.flatMap((grant) => grant.sourceScopes));
  const allowedResources = parseSmartScopes(allowedResourceInput);

  const authorized = grantedNonResourceValues.every((scope) =>
    requestedAuthorizationValues.has(scope)) &&
    grantedResourceValues.every((scope) => parsedSources.has(scope)) &&
    granted.every((grant) => [...grant.permissions].every((permission) =>
      allowedResources.some((candidate) =>
        candidate.context === grant.context &&
        (candidate.resourceType === grant.resourceType || candidate.resourceType === "*") &&
        candidate.permissions.has(permission) &&
        constraintsAreAtLeastAsRestrictive(
          grant.constraints,
          candidate.constraints,
        ))));

  if (!authorized) {
    throw new AppError(
      502,
      "oauth_scope_escalation",
      "Epic returned access outside this application's approved scope policy. The grant was not saved.",
    );
  }
}

/**
 * Backward-compatible helper for callers whose resource request and policy are
 * intentionally the same value.
 */
export function assertGrantedSmartScopesWithinRequest(
  grantedInput: string | readonly string[],
  requestedInput: string | readonly string[],
): void {
  assertGrantedSmartScopesWithinPolicy(
    grantedInput,
    requestedInput,
    requestedInput,
  );
}

function grantsForInteraction(
  input: string | readonly string[],
  resourceType: string,
  permission: "read" | "search",
): readonly SmartScopeGrant[] {
  if (!resourceTypePattern.test(resourceType) || resourceType === "*") return [];
  return parseSmartScopes(input).filter((grant) =>
    grant.context === "patient" &&
    (grant.resourceType === resourceType || grant.resourceType === "*") &&
    grant.permissions.has(permission));
}

function constraintsByName(
  constraints: readonly SmartScopeConstraint[],
): ReadonlyMap<string, readonly string[]> {
  const output = new Map<string, string[]>();
  for (const { name, value } of constraints) {
    const values = output.get(name) ?? [];
    values.push(value);
    output.set(name, values);
  }
  for (const values of output.values()) values.sort();
  return output;
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function constraintState(
  parameters: URLSearchParams,
  constraints: readonly SmartScopeConstraint[],
): "satisfied" | "missing" | "conflict" {
  let missing = false;
  for (const [name, requiredValues] of constraintsByName(constraints)) {
    const suppliedValues = parameters.getAll(name).sort();
    if (suppliedValues.length === 0) {
      missing = true;
      continue;
    }
    if (!sameValues(suppliedValues, requiredValues)) return "conflict";
  }
  return missing ? "missing" : "satisfied";
}

function applyConstraints(
  parameters: URLSearchParams,
  constraints: readonly SmartScopeConstraint[],
): URLSearchParams {
  const output = new URLSearchParams(parameters);
  for (const [name, requiredValues] of constraintsByName(constraints)) {
    if (output.has(name)) continue;
    for (const value of requiredValues) output.append(name, value);
  }
  return output;
}

/**
 * Authorizes a FHIR search and returns the effective query. A single missing
 * fine-grained constraint is injected. When multiple alternative constrained
 * grants exist, the caller must select one by supplying its exact protected
 * query values; issuing a broader query is deliberately rejected.
 */
export function authorizeSmartSearch(
  input: string | readonly string[],
  resourceType: string,
  parameters: URLSearchParams,
): URLSearchParams {
  return authorizeSmartSearchWithContext(input, resourceType, parameters).parameters;
}

export function authorizeSmartSearchWithContext(
  input: string | readonly string[],
  resourceType: string,
  parameters: URLSearchParams,
): AuthorizedSmartSearch {
  const grants = grantsForInteraction(input, resourceType, "search");
  if (grants.length === 0) {
    throw new AppError(
      403,
      "fhir_scope_denied",
      `The current MyChart grant does not allow ${resourceType} search. Disconnect and reconnect after access is enabled.`,
    );
  }
  if (grants.some((grant) => grant.constraints.length === 0)) {
    return { parameters: new URLSearchParams(parameters), constraints: [] };
  }

  const satisfied = grants.filter(
    (grant) => constraintState(parameters, grant.constraints) === "satisfied",
  );
  if (satisfied.length > 0) {
    return {
      parameters: new URLSearchParams(parameters),
      constraints: satisfied[0]!.constraints,
    };
  }

  const viable = grants.filter(
    (grant) => constraintState(parameters, grant.constraints) === "missing",
  );
  if (viable.length === 1) {
    return {
      parameters: applyConstraints(parameters, viable[0]!.constraints),
      constraints: viable[0]!.constraints,
    };
  }
  if (viable.length === 0) {
    throw new AppError(
      403,
      "fhir_scope_constraint_conflict",
      `The requested ${resourceType} search conflicts with the query restrictions in the current MyChart grant.`,
    );
  }

  const names = [...new Set(viable.flatMap((grant) => grant.constraints.map(({ name }) => name)))];
  throw new AppError(
    400,
    "fhir_scope_constraint_required",
    `The ${resourceType} search requires one authorized ${names.join("/")} selection.`,
  );
}

export function authorizedSmartReadGrants(
  input: string | readonly string[],
  resourceType: string,
): readonly SmartScopeGrant[] {
  const grants = grantsForInteraction(input, resourceType, "read");
  if (grants.length === 0) {
    throw new AppError(
      403,
      "fhir_scope_denied",
      `The current MyChart grant does not allow ${resourceType} read. Disconnect and reconnect after access is enabled.`,
    );
  }
  return grants;
}

export function authorizedSmartSearchGrants(
  input: string | readonly string[],
  resourceType: string,
): readonly SmartScopeGrant[] {
  const grants = grantsForInteraction(input, resourceType, "search");
  if (grants.length === 0) {
    throw new AppError(
      403,
      "fhir_scope_denied",
      `The current MyChart grant does not allow ${resourceType} search. Disconnect and reconnect after access is enabled.`,
    );
  }
  return grants;
}

interface CodingLike {
  readonly system?: unknown;
  readonly code?: unknown;
}

function collectCodings(value: unknown): CodingLike[] {
  if (Array.isArray(value)) return value.flatMap(collectCodings);
  if (!value || typeof value !== "object") return [];
  const candidate = value as Record<string, unknown>;
  if (Array.isArray(candidate.coding)) return candidate.coding.flatMap(collectCodings);
  if (typeof candidate.code === "string") return [candidate];
  return [];
}

function codingMatchesToken(coding: CodingLike, token: string): boolean {
  const system = typeof coding.system === "string" ? coding.system : "";
  const code = typeof coding.code === "string" ? coding.code : "";
  const separator = token.indexOf("|");
  if (separator === -1) return code === token;
  const requiredSystem = token.slice(0, separator);
  const requiredCode = token.slice(separator + 1);
  return (requiredSystem.length === 0 ? system.length === 0 : system === requiredSystem) &&
    (requiredCode.length === 0 || code === requiredCode);
}

function resourceMatchesConstraint(
  resource: Record<string, unknown>,
  constraint: SmartScopeConstraint,
): boolean | undefined {
  if (constraint.name.includes(":")) return undefined;
  const value = resource[constraint.name];
  if (value === undefined) return false;

  if (typeof value === "string") {
    return constraint.value.split(",").some((candidate) => candidate === value);
  }
  const codings = collectCodings(value);
  if (codings.length === 0) return undefined;
  return constraint.value
    .split(",")
    .some((token) => codings.some((coding) => codingMatchesToken(coding, token)));
}

/**
 * Verifies a constrained instance-read result before releasing it to the
 * caller. Common primitive and Coding/CodeableConcept token constraints are
 * evaluated locally. Unknown modifiers/shapes fail closed.
 */
export function assertSmartReadResourceAuthorized(
  resourceType: string,
  resource: Record<string, unknown>,
  grants: readonly SmartScopeGrant[],
): void {
  if (grants.some((grant) => grant.constraints.length === 0)) return;

  let unsupported = false;
  for (const grant of grants) {
    let matches = true;
    for (const constraint of grant.constraints) {
      const result = resourceMatchesConstraint(resource, constraint);
      if (result === undefined) unsupported = true;
      if (result !== true) {
        matches = false;
        break;
      }
    }
    if (matches) return;
  }

  throw new AppError(
    403,
    unsupported ? "fhir_scope_constraint_unverifiable" : "fhir_scope_denied",
    unsupported
      ? `The ${resourceType} resource could not be safely verified against this grant's query restrictions.`
      : `The ${resourceType} resource is outside the query restrictions in the current MyChart grant.`,
  );
}
