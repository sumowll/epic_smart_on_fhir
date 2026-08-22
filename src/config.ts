import { resolve } from "node:path";

import { z } from "zod";

import { AppError } from "./errors.js";
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

function parseEncryptionKey(value: string | undefined): Buffer | undefined {
  if (!value?.trim()) return undefined;
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== 32) {
    throw new AppError(
      500,
      "invalid_config",
      "TOKEN_ENCRYPTION_KEY must be a base64 encoding of exactly 32 bytes.",
    );
  }
  return key;
}

const baseSchema = z.object({
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
  EPIC_SCOPES: z.string().default("openid fhirUser launch/patient"),
  SESSION_SECRET: z.string().min(32),
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  TOKEN_STORAGE: z.enum(["memory", "encrypted-file"]).default("memory"),
  TOKEN_STORE_FILE: z.string().trim().min(1).default(".data/connections.enc"),
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  EPIC_ALLOWED_RESOURCE_TYPES: z
    .string()
    .default(
      "AllergyIntolerance,Condition,DiagnosticReport,DocumentReference,Encounter,Immunization,MedicationRequest,Observation,Procedure",
    ),
  EPIC_PRIVATE_KEY_PATH: z.string().optional(),
  EPIC_PRIVATE_KEY_ALG: z.enum(["ES384", "RS384"]).optional(),
  EPIC_PRIVATE_KEY_KID: z.string().optional(),
});

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = baseSchema.safeParse(environment);
  if (!result.success) {
    const summary = result.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new AppError(500, "invalid_config", `Invalid Epic configuration: ${summary}`);
  }

  const env = result.data;
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
  const privateKeyId = env.EPIC_PRIVATE_KEY_KID?.trim();
  const privateKeyAlgorithm = env.EPIC_PRIVATE_KEY_ALG;
  if (
    tokenAuthMethod === "private_key_jwt" &&
    (!privateKeyPath || !privateKeyId || !privateKeyAlgorithm)
  ) {
    throw new AppError(
      500,
      "invalid_config",
      "private_key_jwt requires EPIC_PRIVATE_KEY_PATH, EPIC_PRIVATE_KEY_ALG, and EPIC_PRIVATE_KEY_KID.",
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

  const redirectUri = parseRedirectUri(env.EPIC_REDIRECT_URI);
  const scopes = env.EPIC_SCOPES.split(/\s+/).filter(Boolean);
  if (parseBoolean(environment.EPIC_REQUEST_OFFLINE_ACCESS, false) && !scopes.includes("offline_access")) {
    scopes.push("offline_access");
  }
  if (scopes.length === 0) {
    throw new AppError(500, "invalid_config", "EPIC_SCOPES must contain at least one scope.");
  }
  if (!scopes.includes("openid")) {
    throw new AppError(
      500,
      "invalid_config",
      "EPIC_SCOPES must include openid so the returned identity can be verified.",
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

  return {
    clientId: env.EPIC_CLIENT_ID,
    ...(clientSecret ? { clientSecret } : {}),
    tokenAuthMethod,
    fhirBaseUrl: normalizeFhirBaseUrl(env.EPIC_FHIR_BASE_URL),
    providerName: env.EPIC_PROVIDER_NAME,
    redirectUri: redirectUri.toString(),
    publicOrigin: redirectUri.origin,
    scopes,
    sessionSecret: env.SESSION_SECRET,
    host: env.HOST,
    port: env.PORT,
    cookieSecure: redirectUri.protocol === "https:",
    cookieName: redirectUri.protocol === "https:" ? "__Host-epic_session" : "epic_session",
    tokenStorage: env.TOKEN_STORAGE,
    tokenStoreFile: resolve(env.TOKEN_STORE_FILE),
    ...(tokenEncryptionKey ? { tokenEncryptionKey } : {}),
    allowedResourceTypes,
    ...(privateKeyPath ? { privateKeyPath: resolve(privateKeyPath) } : {}),
    ...(privateKeyAlgorithm ? { privateKeyAlgorithm } : {}),
    ...(privateKeyId ? { privateKeyId } : {}),
    requestTimeoutMs: 10_000,
    maxUpstreamBytes: 5 * 1024 * 1024,
  };
}
