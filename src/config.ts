import { resolve } from "node:path";

import { z } from "zod";

import { AppError } from "./errors.js";
import {
  EPIC_PATIENT_RESOURCE_SCOPES,
  EPIC_STANDALONE_AUTHORIZATION_SCOPES,
  parseSmartScopes,
} from "./smart-scopes.js";
import type { AppConfig, TokenAuthMethod } from "./types.js";

const truthy = new Set(["1", "true", "yes", "on"]);
const falsy = new Set(["0", "false", "no", "off", ""]);

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (truthy.has(normalized)) return true;
  if (falsy.has(normalized)) return false;
  throw new AppError(500, "invalid_config", `Invalid boolean value: ${value}`);
}

export function normalizeFhirBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new AppError(500, "invalid_config", "EPIC_FHIR_BASE_URL must be an absolute URL.", { cause: error });
  }

  if (url.protocol !== "https:") {
    throw new AppError(500, "invalid_config", "EPIC_FHIR_BASE_URL must use HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AppError(
      500,
      "invalid_config",
      "EPIC_FHIR_BASE_URL cannot contain credentials, a query, or a fragment.",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function parseRedirectUri(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new AppError(500, "invalid_config", "EPIC_REDIRECT_URI must be an absolute URL.", { cause: error });
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new AppError(
      500,
      "invalid_config",
      "EPIC_REDIRECT_URI cannot contain credentials, a query, or a fragment.",
    );
  }
  const isLoopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new AppError(
      500,
      "invalid_config",
      "EPIC_REDIRECT_URI must use HTTPS, except for a loopback development callback.",
    );
  }
  if (url.pathname !== "/auth/callback") {
    throw new AppError(
      500,
      "invalid_config",
      "EPIC_REDIRECT_URI must use the connector's /auth/callback path.",
    );
  }
  return url;
}

function parseEncryptionKey(
  value: string | undefined,
  variableName = "TOKEN_ENCRYPTION_KEY",
): Buffer | undefined {
  if (!value?.trim()) return undefined;
  const encoded = value.trim();
  const key = Buffer.from(encoded, "base64");
  if (
    !/^[A-Za-z0-9+/]{43}=$/.test(encoded) ||
    key.length !== 32 ||
    key.toString("base64") !== encoded
  ) {
    throw new AppError(
      500,
      "invalid_config",
      `${variableName} must be a base64 encoding of exactly 32 bytes.`,
    );
  }
  return key;
}

function parseTrustedEndpointOrigins(
  value: string | undefined,
  fhirBaseUrl: string,
): ReadonlySet<string> {
  const configured = value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
  const origins = new Set<string>([new URL(fhirBaseUrl).origin]);
  for (const entry of configured) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch (error) {
      throw new AppError(500, "invalid_config", `Invalid trusted Epic endpoint origin: ${entry}`, {
        cause: error,
      });
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      throw new AppError(
        500,
        "invalid_config",
        `EPIC_TRUSTED_ENDPOINT_ORIGINS entries must be HTTPS origins: ${entry}`,
      );
    }
    origins.add(url.origin);
  }
  return origins;
}

const baseSchema = z.object({
  APP_LEGAL_NAME: z.string().trim().min(1).max(200),
  APP_LEGAL_CONTACT_EMAIL: z.string().trim().email().max(320),
  APP_LEGAL_EFFECTIVE_DATE: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must use YYYY-MM-DD format.")
    .refine(
      (value) => {
        const parsed = new Date(`${value}T00:00:00.000Z`);
        return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
      },
      "Must be a real calendar date.",
    ),
  APP_HOSTING_PROVIDER_NAME: z.string().trim().min(1).max(200),
  EPIC_CLIENT_ID: z.string().trim().min(1),
  EPIC_CLIENT_SECRET: z.string().optional(),
  EPIC_TOKEN_AUTH_METHOD: z
    .enum(["client_secret_basic", "private_key_jwt", "none"])
    .default("client_secret_basic"),
  EPIC_FHIR_BASE_URL: z
    .string()
    .default("https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4"),
  EPIC_PROVIDER_NAME: z.string().trim().min(1).default("Epic R4 Sandbox"),
  EPIC_REDIRECT_URI: z
    .string()
    .default("http://localhost:3000/auth/callback"),
  EPIC_SCOPES: z
    .string()
    .max(1_024)
    .default(EPIC_STANDALONE_AUTHORIZATION_SCOPES.join(" ")),
  EPIC_ALLOWED_RESOURCE_SCOPES: z
    .string()
    .max(16_384)
    .default(EPIC_PATIENT_RESOURCE_SCOPES.join(" ")),
  SESSION_SECRET: z.string().min(32),
  CONSENT_POLICY_VERSION: z.string().trim().min(1).max(100).optional(),
  SESSION_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(300).max(86_400).default(1_800),
  SESSION_MAX_LIFETIME_SECONDS: z.coerce.number().int().min(900).max(86_400).default(28_800),
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  TOKEN_STORAGE: z.enum(["memory", "encrypted-file"]).default("memory"),
  TOKEN_STORE_FILE: z.string().trim().min(1).default(".data/connections.enc"),
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  FHIR_HUB_ENABLED: z.string().optional(),
  FHIR_HUB_STORE_FILE: z.string().trim().min(1).default(".data/fhir-hub.enc"),
  FHIR_HUB_ENCRYPTION_KEY: z.string().optional(),
  FHIR_HUB_IDENTITY_KEY: z.string().optional(),
  FHIR_HUB_CONSENT_VERSION: z.string().trim().min(1).max(100).optional(),
  FHIR_HUB_RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).default(365),
  EPIC_ALLOWED_RESOURCE_TYPES: z
    .string()
    .max(4_096)
    .default(
      "AllergyIntolerance,Binary,CarePlan,CareTeam,Condition,Device,DiagnosticReport,DocumentReference,Encounter,Goal,Immunization,Location,Medication,MedicationRequest,Observation,Organization,Practitioner,PractitionerRole,Procedure,Provenance,RelatedPerson",
    ),
  EPIC_TRUSTED_ENDPOINT_ORIGINS: z.string().optional(),
  EPIC_PRIVATE_KEY_PATH: z.string().optional(),
  EPIC_PRIVATE_KEY_PEM: z.string().optional(),
  EPIC_PRIVATE_KEY_ALG: z.enum(["ES384", "RS384"]).optional(),
  EPIC_PRIVATE_KEY_KID: z.string().optional(),
});

export function loadConfig(
  environment: Record<string, string | undefined> = process.env,
): AppConfig {
  const result = baseSchema.safeParse(environment);
  if (!result.success) {
    const summary = result.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new AppError(500, "invalid_config", `Invalid Epic configuration: ${summary}`);
  }

  const env = result.data;
  if (env.APP_LEGAL_NAME === "replace-with-your-legal-entity-name") {
    throw new AppError(
      500,
      "invalid_config",
      "Replace the example APP_LEGAL_NAME before starting the connector.",
    );
  }
  if (env.APP_LEGAL_CONTACT_EMAIL === "privacy-contact@example.invalid") {
    throw new AppError(
      500,
      "invalid_config",
      "Replace the example APP_LEGAL_CONTACT_EMAIL before starting the connector.",
    );
  }
  if (env.APP_HOSTING_PROVIDER_NAME === "replace-with-your-hosting-provider-name") {
    throw new AppError(
      500,
      "invalid_config",
      "Replace the example APP_HOSTING_PROVIDER_NAME before starting the connector.",
    );
  }
  if (env.EPIC_CLIENT_ID === "replace-with-your-non-production-client-id") {
    throw new AppError(500, "invalid_config", "Replace the example EPIC_CLIENT_ID before starting the connector.");
  }
  if (env.SESSION_SECRET === "replace-with-at-least-32-random-characters") {
    throw new AppError(500, "invalid_config", "Generate a random SESSION_SECRET before starting the connector.");
  }
  const tokenAuthMethod = env.EPIC_TOKEN_AUTH_METHOD as TokenAuthMethod;
  const clientSecret = env.EPIC_CLIENT_SECRET?.trim();
  if (
    tokenAuthMethod === "client_secret_basic" &&
    clientSecret === "replace-with-your-sandbox-client-secret"
  ) {
    throw new AppError(500, "invalid_config", "Replace the example EPIC_CLIENT_SECRET before starting the connector.");
  }
  if (tokenAuthMethod === "client_secret_basic" && !clientSecret) {
    throw new AppError(
      500,
      "invalid_config",
      "EPIC_CLIENT_SECRET is required for client_secret_basic.",
    );
  }

  const privateKeyPath = env.EPIC_PRIVATE_KEY_PATH?.trim();
  const privateKeyPem = env.EPIC_PRIVATE_KEY_PEM?.trim();
  const privateKeyId = env.EPIC_PRIVATE_KEY_KID?.trim();
  const privateKeyAlgorithm = env.EPIC_PRIVATE_KEY_ALG;
  if (
    tokenAuthMethod === "private_key_jwt" &&
    ((!privateKeyPath && !privateKeyPem) || !privateKeyId || !privateKeyAlgorithm)
  ) {
    throw new AppError(
      500,
      "invalid_config",
      "private_key_jwt requires EPIC_PRIVATE_KEY_PEM or EPIC_PRIVATE_KEY_PATH, plus EPIC_PRIVATE_KEY_ALG and EPIC_PRIVATE_KEY_KID.",
    );
  }
  if (privateKeyPath && privateKeyPem) {
    throw new AppError(
      500,
      "invalid_config",
      "Set only one of EPIC_PRIVATE_KEY_PEM and EPIC_PRIVATE_KEY_PATH.",
    );
  }

  const tokenEncryptionKey = parseEncryptionKey(env.TOKEN_ENCRYPTION_KEY);
  if (env.TOKEN_STORAGE === "encrypted-file" && !tokenEncryptionKey) {
    throw new AppError(
      500,
      "invalid_config",
      "TOKEN_ENCRYPTION_KEY is required when TOKEN_STORAGE=encrypted-file.",
    );
  }

  const fhirHubEnabled = parseBoolean(env.FHIR_HUB_ENABLED, false);
  const fhirHubEncryptionKey = parseEncryptionKey(
    env.FHIR_HUB_ENCRYPTION_KEY,
    "FHIR_HUB_ENCRYPTION_KEY",
  );
  const fhirHubIdentityKey = parseEncryptionKey(
    env.FHIR_HUB_IDENTITY_KEY,
    "FHIR_HUB_IDENTITY_KEY",
  );
  if (fhirHubEnabled && (!fhirHubEncryptionKey || !fhirHubIdentityKey)) {
    throw new AppError(
      500,
      "invalid_config",
      "FHIR_HUB_ENABLED requires separate 32-byte FHIR_HUB_ENCRYPTION_KEY and FHIR_HUB_IDENTITY_KEY values.",
    );
  }
  if (
    fhirHubEnabled &&
    fhirHubEncryptionKey &&
    fhirHubIdentityKey &&
    (
      fhirHubEncryptionKey.equals(fhirHubIdentityKey) ||
      tokenEncryptionKey?.equals(fhirHubEncryptionKey) === true ||
      tokenEncryptionKey?.equals(fhirHubIdentityKey) === true ||
      env.FHIR_HUB_ENCRYPTION_KEY?.trim() === env.SESSION_SECRET ||
      env.FHIR_HUB_IDENTITY_KEY?.trim() === env.SESSION_SECRET
    )
  ) {
    throw new AppError(
      500,
      "invalid_config",
      "FHIR hub encryption, identity, and token-store keys must be distinct.",
    );
  }
  if (
    fhirHubEnabled &&
    resolve(env.FHIR_HUB_STORE_FILE) === resolve(env.TOKEN_STORE_FILE)
  ) {
    throw new AppError(
      500,
      "invalid_config",
      "FHIR_HUB_STORE_FILE must be separate from TOKEN_STORE_FILE.",
    );
  }

  const redirectUri = parseRedirectUri(env.EPIC_REDIRECT_URI);
  const scopes = env.EPIC_SCOPES.split(/\s+/).filter(Boolean);
  if (parseBoolean(environment.EPIC_REQUEST_OFFLINE_ACCESS, false) && !scopes.includes("offline_access")) {
    scopes.push("offline_access");
  }
  if (scopes.length === 0) {
    throw new AppError(500, "invalid_config", "EPIC_SCOPES must contain at least one scope.");
  }
  if (
    scopes.length > 32 ||
    scopes.some((scope) => scope.length > 256) ||
    new Set(scopes).size !== scopes.length
  ) {
    throw new AppError(
      500,
      "invalid_config",
      "EPIC_SCOPES must contain at most 32 unique, bounded authorization scope values.",
    );
  }
  const resourceScopes = scopes.filter((scope) => /^(?:patient|user|system)\//.test(scope));
  if (resourceScopes.length > 0) {
    throw new AppError(
      500,
      "invalid_config",
      "EPIC_SCOPES is serialized into Epic's standalone authorize URL and must not contain FHIR resource scopes. Configure those in EPIC_ALLOWED_RESOURCE_SCOPES.",
    );
  }

  const allowedResourceScopes = env.EPIC_ALLOWED_RESOURCE_SCOPES.split(/\s+/).filter(Boolean);
  if (allowedResourceScopes.length === 0) {
    throw new AppError(
      500,
      "invalid_config",
      "EPIC_ALLOWED_RESOURCE_SCOPES must contain at least one approved patient resource scope.",
    );
  }
  if (
    allowedResourceScopes.length > 256 ||
    allowedResourceScopes.some((scope) => scope.length > 2_048) ||
    new Set(allowedResourceScopes).size !== allowedResourceScopes.length
  ) {
    throw new AppError(
      500,
      "invalid_config",
      "EPIC_ALLOWED_RESOURCE_SCOPES must contain at most 256 unique, bounded scope values.",
    );
  }
  const parsedResourceGrants = parseSmartScopes(allowedResourceScopes);
  const parsedSourceScopes = new Set(
    parsedResourceGrants.flatMap((grant) => grant.sourceScopes),
  );
  if (
    allowedResourceScopes.some((scope) => !parsedSourceScopes.has(scope)) ||
    parsedResourceGrants.some((grant) =>
      grant.context !== "patient" ||
      grant.resourceType === "*" ||
      [...grant.permissions].some((permission) =>
        permission === "create" || permission === "update" || permission === "delete"))
  ) {
    throw new AppError(
      500,
      "invalid_config",
      "EPIC_ALLOWED_RESOURCE_SCOPES may contain only explicit patient-level read/search resource grants.",
    );
  }
  if (env.SESSION_IDLE_TIMEOUT_SECONDS > env.SESSION_MAX_LIFETIME_SECONDS) {
    throw new AppError(
      500,
      "invalid_config",
      "SESSION_IDLE_TIMEOUT_SECONDS cannot exceed SESSION_MAX_LIFETIME_SECONDS.",
    );
  }
  if (!scopes.includes("openid")) {
    throw new AppError(
      500,
      "invalid_config",
      "EPIC_SCOPES must include openid so the returned identity can be verified.",
    );
  }
  if (!scopes.includes("launch/patient")) {
    throw new AppError(
      500,
      "invalid_config",
      "EPIC_SCOPES must include launch/patient so Epic returns the authorized patient context.",
    );
  }
  if (tokenAuthMethod === "none" && scopes.includes("offline_access")) {
    throw new AppError(
      500,
      "invalid_config",
      "offline_access requires a confidential Epic client; use client_secret_basic or private_key_jwt.",
    );
  }

  const allowedResourceTypes = new Set(
    env.EPIC_ALLOWED_RESOURCE_TYPES.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  for (const resourceType of allowedResourceTypes) {
    if (!/^[A-Z][A-Za-z0-9]{0,63}$/.test(resourceType) || resourceType === "Patient") {
      throw new AppError(
        500,
        "invalid_config",
        `Invalid or reserved FHIR resource type in EPIC_ALLOWED_RESOURCE_TYPES: ${resourceType}`,
      );
    }
  }

  const fhirBaseUrl = normalizeFhirBaseUrl(env.EPIC_FHIR_BASE_URL);
  return {
    legalName: env.APP_LEGAL_NAME,
    legalContactEmail: env.APP_LEGAL_CONTACT_EMAIL,
    legalEffectiveDate: env.APP_LEGAL_EFFECTIVE_DATE,
    hostingProviderName: env.APP_HOSTING_PROVIDER_NAME,
    clientId: env.EPIC_CLIENT_ID,
    ...(clientSecret ? { clientSecret } : {}),
    tokenAuthMethod,
    fhirBaseUrl,
    providerName: env.EPIC_PROVIDER_NAME,
    redirectUri: redirectUri.toString(),
    publicOrigin: redirectUri.origin,
    scopes,
    allowedResourceScopes,
    sessionSecret: env.SESSION_SECRET,
    host: env.HOST,
    port: env.PORT,
    cookieSecure: redirectUri.protocol === "https:",
    cookieName: redirectUri.protocol === "https:" ? "__Host-epic_session" : "epic_session",
    consentPolicyVersion: env.CONSENT_POLICY_VERSION ?? env.APP_LEGAL_EFFECTIVE_DATE,
    sessionIdleTimeoutMs: env.SESSION_IDLE_TIMEOUT_SECONDS * 1_000,
    sessionMaxLifetimeMs: env.SESSION_MAX_LIFETIME_SECONDS * 1_000,
    tokenStorage: env.TOKEN_STORAGE,
    tokenStoreFile: resolve(env.TOKEN_STORE_FILE),
    ...(tokenEncryptionKey ? { tokenEncryptionKey } : {}),
    fhirHubEnabled,
    fhirHubStoreFile: resolve(env.FHIR_HUB_STORE_FILE),
    ...(fhirHubEncryptionKey ? { fhirHubEncryptionKey } : {}),
    ...(fhirHubIdentityKey ? { fhirHubIdentityKey } : {}),
    fhirHubConsentVersion: env.FHIR_HUB_CONSENT_VERSION ?? env.APP_LEGAL_EFFECTIVE_DATE,
    fhirHubRetentionMs: env.FHIR_HUB_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
    allowedResourceTypes,
    ...(privateKeyPath ? { privateKeyPath: resolve(privateKeyPath) } : {}),
    ...(privateKeyPem ? { privateKeyPem } : {}),
    ...(privateKeyAlgorithm ? { privateKeyAlgorithm } : {}),
    ...(privateKeyId ? { privateKeyId } : {}),
    requestTimeoutMs: 10_000,
    maxUpstreamBytes: 5 * 1024 * 1024,
    trustedEndpointOrigins: parseTrustedEndpointOrigins(
      env.EPIC_TRUSTED_ENDPOINT_ORIGINS,
      fhirBaseUrl,
    ),
  };
}
