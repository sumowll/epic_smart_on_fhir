import { AppError, ReconnectRequiredError, UpstreamError } from "./errors.js";
import { requestJson } from "./http.js";
import type { AppConfig, ConnectionRecord, FetchLike } from "./types.js";

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

function hasOperationOutcomeIssue(json: unknown): boolean {
  if (!json || typeof json !== "object") return false;
  const outcome = json as Record<string, unknown>;
  if (outcome.resourceType !== "OperationOutcome" || !Array.isArray(outcome.issue)) {
    return false;
  }
  return outcome.issue.some((candidate) => candidate !== null && typeof candidate === "object");
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
    return this.get(record, `Patient/${encodeURIComponent(record.patientId)}`, "Patient", "read");
  }

  public async search(
    record: ConnectionRecord,
    resourceType: string,
    input: URLSearchParams,
  ): Promise<unknown> {
    this.requireAllowedType(resourceType);
    const parameters = sanitizeSearchParameters(input);
    parameters.set("patient", record.patientId);
    return this.get(record, `${resourceType}?${parameters.toString()}`, resourceType, "search");
  }

  private requireAllowedType(resourceType: string): void {
    if (!this.config.allowedResourceTypes.has(resourceType)) {
      throw new AppError(403, "resource_type_not_allowed", "That FHIR resource type is not enabled.");
    }
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

    const { response, json } = await requestJson(`${record.fhirBaseUrl}/${relativePath}`, {
      fetch: this.fetch,
      timeoutMs: this.config.requestTimeoutMs,
      maxBytes: this.config.maxUpstreamBytes,
      expectedStatus: [200, 401, 403, 404, 429],
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
      case 401:
        throw new ReconnectRequiredError();
      case 403:
        throw forbiddenError(response, json, resourceType, interaction);
      case 404:
        throw new AppError(404, "fhir_resource_not_found", "The requested FHIR resource was not found.");
      case 429:
        throw new AppError(429, "epic_rate_limited", "Epic is rate limiting requests. Please try again later.");
      default:
        throw new UpstreamError("fhir_request_failed", "The FHIR request failed.", response.status);
    }
  }
}
