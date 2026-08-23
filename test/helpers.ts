import { loadConfig } from "../src/config.js";
import type { AppConfig } from "../src/types.js";

export function validEnvironment(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    APP_LEGAL_NAME: "Example Connector, Inc.",
    APP_LEGAL_CONTACT_EMAIL: "privacy@connector.example.test",
    APP_LEGAL_EFFECTIVE_DATE: "2026-08-23",
    APP_HOSTING_PROVIDER_NAME: "Example Cloud Host",
    EPIC_CLIENT_ID: "test-client-id",
    EPIC_CLIENT_SECRET: "secret/value",
    EPIC_TOKEN_AUTH_METHOD: "client_secret_basic",
    EPIC_FHIR_BASE_URL: "https://ehr.example.test/api/FHIR/R4/",
    EPIC_PROVIDER_NAME: "Example Health",
    EPIC_REDIRECT_URI: "http://localhost:3000/auth/callback",
    EPIC_SCOPES: "openid fhirUser launch/patient",
    SESSION_SECRET: "s".repeat(48),
    TOKEN_STORAGE: "memory",
    EPIC_ALLOWED_RESOURCE_TYPES: "Condition,Observation",
    ...overrides,
  };
}

export function makeConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig(validEnvironment(overrides));
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
