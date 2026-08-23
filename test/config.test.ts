import { describe, expect, it } from "vitest";

import { loadConfig, normalizeFhirBaseUrl } from "../src/config.js";
import { AppError } from "../src/errors.js";
import { validEnvironment } from "./helpers.js";

describe("configuration", () => {
  it("normalizes the configured FHIR base URL and parses scopes", () => {
    const config = loadConfig(validEnvironment({ EPIC_REQUEST_OFFLINE_ACCESS: "true" }));
    expect(config.fhirBaseUrl).toBe("https://ehr.example.test/api/FHIR/R4");
    expect(config.scopes).toEqual(["openid", "fhirUser", "launch/patient", "offline_access"]);
    expect(config.allowedResourceTypes).toEqual(new Set(["Condition", "Observation"]));
  });

  it("rejects non-HTTPS FHIR endpoints", () => {
    expect(() => normalizeFhirBaseUrl("http://ehr.example.test/fhir")).toThrow(AppError);
  });

  it("rejects a non-loopback HTTP redirect", () => {
    expect(() =>
      loadConfig(validEnvironment({ EPIC_REDIRECT_URI: "http://app.example.test/callback" })),
    ).toThrow(/must use HTTPS/);
  });

  it("rejects a redirect path the server does not handle", () => {
    expect(() =>
      loadConfig(validEnvironment({ EPIC_REDIRECT_URI: "http://localhost:3000/wrong-callback" })),
    ).toThrow(/\/auth\/callback/);
  });

  it("requires a client secret for client_secret_basic", () => {
    expect(() =>
      loadConfig(validEnvironment({ EPIC_CLIENT_SECRET: undefined })),
    ).toThrow(/EPIC_CLIENT_SECRET/);
  });

  it("rejects the example placeholder credentials", () => {
    expect(() =>
      loadConfig(validEnvironment({
        EPIC_CLIENT_ID: "replace-with-your-non-production-client-id",
      })),
    ).toThrow(/Replace the example EPIC_CLIENT_ID/);
    expect(() =>
      loadConfig(validEnvironment({
        SESSION_SECRET: "replace-with-at-least-32-random-characters",
      })),
    ).toThrow(/random SESSION_SECRET/);
  });

  it("requires publishable legal-page operator details", () => {
    expect(() =>
      loadConfig(validEnvironment({ APP_LEGAL_NAME: undefined })),
    ).toThrow(/APP_LEGAL_NAME/);
    expect(() =>
      loadConfig(validEnvironment({ APP_LEGAL_CONTACT_EMAIL: "not-an-email" })),
    ).toThrow(/APP_LEGAL_CONTACT_EMAIL/);
    expect(() =>
      loadConfig(
        validEnvironment({
          APP_LEGAL_NAME: "replace-with-your-legal-entity-name",
        }),
      ),
    ).toThrow(/Replace the example APP_LEGAL_NAME/);
    expect(() =>
      loadConfig(
        validEnvironment({
          APP_LEGAL_CONTACT_EMAIL: "privacy-contact@example.invalid",
        }),
      ),
    ).toThrow(/Replace the example APP_LEGAL_CONTACT_EMAIL/);
    expect(() =>
      loadConfig(validEnvironment({ APP_LEGAL_EFFECTIVE_DATE: "2026-02-30" })),
    ).toThrow(/real calendar date/);
    expect(() =>
      loadConfig(validEnvironment({ APP_LEGAL_EFFECTIVE_DATE: undefined })),
    ).toThrow(/APP_LEGAL_EFFECTIVE_DATE/);
    expect(() =>
      loadConfig(validEnvironment({ APP_HOSTING_PROVIDER_NAME: undefined })),
    ).toThrow(/APP_HOSTING_PROVIDER_NAME/);
    expect(() =>
      loadConfig(
        validEnvironment({
          APP_HOSTING_PROVIDER_NAME: "replace-with-your-hosting-provider-name",
        }),
      ),
    ).toThrow(/Replace the example APP_HOSTING_PROVIDER_NAME/);
  });

  it("requires a 32-byte encryption key for persistent storage", () => {
    expect(() =>
      loadConfig(
        validEnvironment({
          TOKEN_STORAGE: "encrypted-file",
          TOKEN_ENCRYPTION_KEY: Buffer.alloc(31).toString("base64"),
        }),
      ),
    ).toThrow(/exactly 32 bytes/);
  });

  it("rejects ordinary public-client offline access", () => {
    expect(() =>
      loadConfig(
        validEnvironment({
          EPIC_TOKEN_AUTH_METHOD: "none",
          EPIC_CLIENT_SECRET: undefined,
          EPIC_REQUEST_OFFLINE_ACCESS: "true",
        }),
      ),
    ).toThrow(/offline_access requires a confidential/);
  });

  it("accepts an inline private key for Worker private_key_jwt authentication", () => {
    const config = loadConfig(validEnvironment({
      EPIC_TOKEN_AUTH_METHOD: "private_key_jwt",
      EPIC_CLIENT_SECRET: undefined,
      EPIC_PRIVATE_KEY_PEM: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
      EPIC_PRIVATE_KEY_ALG: "ES384",
      EPIC_PRIVATE_KEY_KID: "worker-key",
    }));

    expect(config.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(config.privateKeyPath).toBeUndefined();
  });

  it("rejects ambiguous private-key file and inline configuration", () => {
    expect(() => loadConfig(validEnvironment({
      EPIC_TOKEN_AUTH_METHOD: "private_key_jwt",
      EPIC_CLIENT_SECRET: undefined,
      EPIC_PRIVATE_KEY_PATH: ".secrets/private-key.pem",
      EPIC_PRIVATE_KEY_PEM: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
      EPIC_PRIVATE_KEY_ALG: "ES384",
      EPIC_PRIVATE_KEY_KID: "worker-key",
    }))).toThrow(/only one/);
  });
});
