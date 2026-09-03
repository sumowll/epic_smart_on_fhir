import { pathToFileURL } from "node:url";

export const DEFAULT_FHIR_PATH = "metadata?_format=json";
export const DEFAULT_TIMEOUT_MS = 10_000;
export const METADATA_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const RESOURCE_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const resourceTypePattern = /^[A-Z][A-Za-z0-9]{0,63}$/;
const fhirIdPattern = /^[A-Za-z0-9.-]{1,64}$/;
const forbiddenQueryNames = new Set([
  "access_token",
  "authorization",
  "client_secret",
  "id_token",
  "refresh_token",
  "token",
]);

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface EpicFhirRequestOptions {
  readonly fhirBaseUrl: string;
  readonly clientId: string;
  readonly accessToken?: string;
  readonly requestPath?: string;
  readonly fetchImplementation?: FetchImplementation;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface EpicFhirResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly contentType: string;
  readonly body: string;
}

function assertCapabilityStatement(body: string): void {
  let resource: unknown;
  try {
    resource = JSON.parse(body);
  } catch {
    throw new Error("Epic metadata was not a valid JSON CapabilityStatement.");
  }
  if (
    !resource ||
    typeof resource !== "object" ||
    Array.isArray(resource) ||
    !("resourceType" in resource) ||
    resource.resourceType !== "CapabilityStatement"
  ) {
    throw new Error("Epic metadata was not a valid JSON CapabilityStatement.");
  }
}

function requiredEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be configured.`);
  }
  return value;
}

function decodePathSegment(segment: string): string {
  let decoded = segment;
  try {
    for (let index = 0; index < 3; index += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    throw new Error("The FHIR request path contains invalid percent encoding.");
  }
  return decoded;
}

function validateFhirReadOrSearchPath(value: string): readonly string[] {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    throw new Error("The FHIR request path must be relative to EPIC_FHIR_BASE_URL.");
  }
  if (value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("The FHIR request path contains unsafe characters.");
  }

  const rawPath = value.split(/[?#]/, 1)[0]?.replace(/^\//, "") ?? "";
  const rawSegments = rawPath.split("/");
  if (!rawPath || rawSegments.some((segment) => segment.length === 0)) {
    throw new Error("The FHIR request path must identify metadata or a resource.");
  }

  const segments = rawSegments.map(decodePathSegment);
  if (segments.some((segment) =>
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\")
  )) {
    throw new Error("The FHIR request path cannot contain traversal segments.");
  }

  if (segments.length === 1 && segments[0] === "metadata") return segments;
  if (
    segments.length < 1 ||
    segments.length > 2 ||
    !resourceTypePattern.test(segments[0] ?? "") ||
    (segments.length === 2 && !fhirIdPattern.test(segments[1] ?? ""))
  ) {
    throw new Error(
      "Only CapabilityStatement, FHIR resource search, and FHIR instance read paths are allowed.",
    );
  }
  return segments;
}

export function buildFhirRequestUrl(
  fhirBaseUrl: string,
  requestPath = DEFAULT_FHIR_PATH,
): URL {
  let base: URL;
  try {
    base = new URL(fhirBaseUrl);
  } catch {
    throw new Error("EPIC_FHIR_BASE_URL must be an absolute HTTPS URL.");
  }

  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error(
      "EPIC_FHIR_BASE_URL must be an HTTPS URL without credentials, query, or fragment.",
    );
  }

  const value = requestPath.trim();
  if (!value) {
    throw new Error("The FHIR request path must identify metadata or a resource.");
  }
  validateFhirReadOrSearchPath(value);

  const basePath = base.pathname.replace(/\/+$/, "");
  base.pathname = `${basePath}/`;
  const target = new URL(value.replace(/^\//, ""), base);
  const requiredPathPrefix = `${basePath}/`;

  if (
    target.origin !== base.origin ||
    target.username ||
    target.password ||
    target.hash ||
    (basePath && !target.pathname.startsWith(requiredPathPrefix))
  ) {
    throw new Error("The FHIR request path must remain under EPIC_FHIR_BASE_URL.");
  }
  for (const [name] of target.searchParams) {
    if (forbiddenQueryNames.has(name.toLowerCase())) {
      throw new Error("Authentication credentials are not allowed in the request URL.");
    }
  }

  return target;
}

function targetsMetadata(fhirBaseUrl: string, target: URL): boolean {
  const base = new URL(fhirBaseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  return target.pathname.slice(`${basePath}/`.length) === "metadata";
}

async function readLimitedBody(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLengthValue = response.headers.get("content-length");
  const contentLength = contentLengthValue === null
    ? undefined
    : Number(contentLengthValue);
  if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Epic returned more than the ${maxBytes}-byte response limit.`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Epic returned more than the ${maxBytes}-byte response limit.`);
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  return body + decoder.decode();
}

export async function requestEpicFhir({
  fhirBaseUrl,
  clientId,
  accessToken,
  requestPath = DEFAULT_FHIR_PATH,
  fetchImplementation = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes,
}: EpicFhirRequestOptions): Promise<EpicFhirResponse> {
  const target = buildFhirRequestUrl(fhirBaseUrl, requestPath);
  const metadataRequest = targetsMetadata(fhirBaseUrl, target);
  const token = accessToken?.trim();
  if (!metadataRequest && !token) {
    throw new Error(
      "EPIC_FHIR_ACCESS_TOKEN is required for protected FHIR resource requests.",
    );
  }
  if (token && /\s/.test(token)) {
    throw new Error("EPIC_FHIR_ACCESS_TOKEN cannot contain whitespace.");
  }

  const headers = new Headers({
    Accept: "application/fhir+json, application/json",
    "Epic-Client-ID": clientId,
  });
  if (!metadataRequest && token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetchImplementation(target, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error("The Epic FHIR server could not be reached.");
  }

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Epic returned an unexpected redirect (${response.status}).`);
  }

  const responseLimit = maxResponseBytes ?? (
    metadataRequest ? METADATA_MAX_RESPONSE_BYTES : RESOURCE_MAX_RESPONSE_BYTES
  );
  if (!Number.isSafeInteger(responseLimit) || responseLimit <= 0) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("The response-size limit must be a positive integer.");
  }

  const body = await readLimitedBody(response, responseLimit);
  if (metadataRequest && response.ok) assertCapabilityStatement(body);

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get("content-type") ?? "",
    body,
  };
}

export function formatResponseBody(body: string): string {
  if (!body) return "";
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export function normalizeCommandArguments(args: readonly string[]): readonly string[] {
  return args[0] === "--" ? args.slice(1) : args;
}

function usage(): string {
  return [
    "Usage: pnpm run fhir:get -- [relative-fhir-path]",
    "",
    `Default path: ${DEFAULT_FHIR_PATH}`,
    "Examples:",
    "  pnpm run fhir:get",
    "  pnpm run fhir:get -- 'Patient/example-id'",
    "  pnpm run fhir:get -- 'Observation?patient=example-id&_count=5'",
    "",
    "Environment:",
    "  EPIC_FHIR_BASE_URL       Required Epic R4 base URL",
    "  EPIC_CLIENT_ID           Required Epic application client ID",
    "  EPIC_FHIR_ACCESS_TOKEN   Required only for protected resource calls",
  ].join("\n");
}

export async function run(
  args: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const commandArguments = normalizeCommandArguments(args);
  if (commandArguments.includes("--help") || commandArguments.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (commandArguments.length > 1 || commandArguments[0]?.startsWith("-")) {
    throw new Error(`Invalid arguments.\n\n${usage()}`);
  }

  const accessToken = environment.EPIC_FHIR_ACCESS_TOKEN;
  const result = await requestEpicFhir({
    fhirBaseUrl: requiredEnvironmentValue(environment, "EPIC_FHIR_BASE_URL"),
    clientId: requiredEnvironmentValue(environment, "EPIC_CLIENT_ID"),
    ...(accessToken === undefined ? {} : { accessToken }),
    requestPath: commandArguments[0] ?? DEFAULT_FHIR_PATH,
  });

  const label = result.statusText
    ? `${result.status} ${result.statusText}`
    : String(result.status);
  process.stderr.write(`Epic FHIR response: ${label}\n`);
  const formatted = formatResponseBody(result.body);
  if (formatted) process.stdout.write(`${formatted}\n`);
  return result.ok ? 0 : 1;
}

const entrypoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entrypoint === import.meta.url) {
  run()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown error";
      process.stderr.write(`Epic FHIR request failed: ${message}\n`);
      process.exitCode = 1;
    });
}
