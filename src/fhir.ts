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
    return this.get(record, `Patient/${encodeURIComponent(record.patientId)}`);
  }

  public async search(
    record: ConnectionRecord,
    resourceType: string,
    input: URLSearchParams,
  ): Promise<unknown> {
    this.requireAllowedType(resourceType);
    const parameters = sanitizeSearchParameters(input);
    parameters.set("patient", record.patientId);
    return this.get(record, `${resourceType}?${parameters.toString()}`);
  }

  private requireAllowedType(resourceType: string): void {
    if (!this.config.allowedResourceTypes.has(resourceType)) {
      throw new AppError(403, "resource_type_not_allowed", "That FHIR resource type is not enabled.");
    }
  }

  private async get(record: ConnectionRecord, relativePath: string): Promise<unknown> {
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
        throw new AppError(
          403,
          "fhir_scope_denied",
          "Epic denied this resource. Add the matching Incoming API to the Epic app and reconnect.",
        );
      case 404:
        throw new AppError(404, "fhir_resource_not_found", "The requested FHIR resource was not found.");
      case 429:
        throw new AppError(429, "epic_rate_limited", "Epic is rate limiting requests. Please try again later.");
      default:
        throw new UpstreamError("fhir_request_failed", "The FHIR request failed.", response.status);
    }
  }
}
