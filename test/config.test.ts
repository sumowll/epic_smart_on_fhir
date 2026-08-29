import { describe, expect, it } from "vitest";

import { loadConfig, normalizeFhirBaseUrl } from "../src/config.js";
import { AppError } from "../src/errors.js";
import {
  EPIC_PATIENT_RESOURCE_SCOPES,
  EPIC_STANDALONE_AUTHORIZATION_SCOPES,
} from "../src/smart-scopes.js";
import { validEnvironment } from "./helpers.js";

describe("configuration", () => {
  it("keeps the standalone request separate from the 53-scope resource policy", () => {
    const environment = validEnvironment();
    delete environment.EPIC_SCOPES;
    delete environment.EPIC_ALLOWED_RESOURCE_SCOPES;
    const config = loadConfig(environment);
    expect(config.scopes).toEqual(EPIC_STANDALONE_AUTHORIZATION_SCOPES);
    expect(config.allowedResourceScopes).toEqual(EPIC_PATIENT_RESOURCE_SCOPES);
    expect(config.scopes).toHaveLength(3);
    expect(config.allowedResourceScopes).toHaveLength(53);
  });

  it("normalizes the configured FHIR base URL and parses scopes", () => {
    const config = loadConfig(validEnvironment({ EPIC_REQUEST_OFFLINE_ACCESS: "true" }));
    expect(config.fhirBaseUrl).toBe("https://ehr.example.test/api/FHIR/R4");
    expect(config.scopes).toEqual(["openid", "fhirUser", "launch/patient", "offline_access"]);
    expect(config.allowedResourceScopes).toEqual(EPIC_PATIENT_RESOURCE_SCOPES);
    expect(config.allowedResourceTypes).toEqual(new Set(["Condition", "Observation"]));
  });

  it("derives consent and bounded local-session defaults from production configuration", () => {
    const defaults = loadConfig(validEnvironment());
    expect(defaults.consentPolicyVersion).toBe("2026-08-23");
    expect(defaults.sessionIdleTimeoutMs).toBe(30 * 60 * 1_000);
    expect(defaults.sessionMaxLifetimeMs).toBe(8 * 60 * 60 * 1_000);

    const configured = loadConfig(validEnvironment({
      CONSENT_POLICY_VERSION: "terms-2026-09",
      SESSION_IDLE_TIMEOUT_SECONDS: "600",
      SESSION_MAX_LIFETIME_SECONDS: "3600",
    }));
    expect(configured.consentPolicyVersion).toBe("terms-2026-09");
    expect(configured.sessionIdleTimeoutMs).toBe(600_000);
    expect(configured.sessionMaxLifetimeMs).toBe(3_600_000);
  });

  it("rejects invalid local-session limits and idle timeouts above the maximum lifetime", () => {
    expect(() => loadConfig(validEnvironment({
      SESSION_IDLE_TIMEOUT_SECONDS: "299",
    }))).toThrow(/SESSION_IDLE_TIMEOUT_SECONDS/);
    expect(() => loadConfig(validEnvironment({
      SESSION_MAX_LIFETIME_SECONDS: "86401",
    }))).toThrow(/SESSION_MAX_LIFETIME_SECONDS/);
    expect(() => loadConfig(validEnvironment({
      SESSION_IDLE_TIMEOUT_SECONDS: "3600",
      SESSION_MAX_LIFETIME_SECONDS: "1800",
    }))).toThrow(/cannot exceed/);
  });

  it("trusts only the FHIR origin by default and normalizes explicit HTTPS origins", () => {
    const defaults = loadConfig(validEnvironment());
    expect(defaults.trustedEndpointOrigins).toEqual(new Set([
      "https://ehr.example.test",
    ]));

    const configured = loadConfig(validEnvironment({
      EPIC_TRUSTED_ENDPOINT_ORIGINS:
        " https://auth.example.test:443/, https://ehr.example.test ",
    }));
    expect(configured.trustedEndpointOrigins).toEqual(new Set([
      "https://ehr.example.test",
      "https://auth.example.test",
    ]));
  });

  it.each([
    "http://auth.example.test",
    "https://user@auth.example.test",
    "https://auth.example.test/oauth2",
    "https://auth.example.test?tenant=one",
    "https://auth.example.test#fragment",
    "not-an-origin",
  ])("rejects an unsafe trusted endpoint origin: %s", (origin) => {
    expect(() => loadConfig(validEnvironment({
      EPIC_TRUSTED_ENDPOINT_ORIGINS: origin,
    }))).toThrow(/trusted Epic endpoint origin|must be HTTPS origins/);
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

  it("requires the standalone patient launch context", () => {
    expect(() => loadConfig(validEnvironment({
      EPIC_SCOPES: "openid fhirUser",
    }))).toThrow(/launch\/patient/);
  });

  it("keeps resource scopes out of the bounded standalone authorize request", () => {
    expect(() => loadConfig(validEnvironment({
      EPIC_SCOPES: "openid fhirUser launch/patient patient/Patient.r",
    }))).toThrow(/must not contain FHIR resource scopes/);
  });

  it.each([
    "openid launch/patient patient/*.read",
    "openid launch/patient user/Patient.r",
    "openid launch/patient system/Patient.r",
    "openid launch/patient patient/Patient.c",
    "openid launch/patient patient/Patient.write",
    "openid launch/patient patient/not-a-resource.r",
    "openid launch/patient patient/Patient.r patient/Patient.r",
  ])("rejects an unsafe or drifting resource-scope policy: %s", (scopes) => {
    const resourcePolicy = scopes.split(/\s+/).filter((scope) =>
      /^(?:patient|user|system)\//.test(scope));
    expect(() => loadConfig(validEnvironment({
      EPIC_ALLOWED_RESOURCE_SCOPES: resourcePolicy.join(" "),
    }))).toThrow(
      /patient-level read\/search|unique/,
    );
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

  it("keeps the longitudinal FHIR hub disabled unless separate keys are configured", () => {
    const defaults = loadConfig(validEnvironment());
    expect(defaults.fhirHubEnabled).toBe(false);
    expect(defaults.fhirHubConsentVersion).toBe("2026-08-23");
    expect(defaults.fhirHubRetentionMs).toBe(365 * 24 * 60 * 60 * 1_000);

    expect(() => loadConfig(validEnvironment({
      FHIR_HUB_ENABLED: "true",
    }))).toThrow(/FHIR_HUB_ENCRYPTION_KEY and FHIR_HUB_IDENTITY_KEY/);

    const enabled = loadConfig(validEnvironment({
      FHIR_HUB_ENABLED: "true",
      FHIR_HUB_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      FHIR_HUB_IDENTITY_KEY: Buffer.alloc(32, 2).toString("base64"),
      FHIR_HUB_CONSENT_VERSION: "hub-v2",
      FHIR_HUB_RETENTION_DAYS: "90",
    }));
    expect(enabled.fhirHubEnabled).toBe(true);
    expect(enabled.fhirHubConsentVersion).toBe("hub-v2");
    expect(enabled.fhirHubRetentionMs).toBe(90 * 24 * 60 * 60 * 1_000);
    expect(enabled.fhirHubEncryptionKey).toEqual(Buffer.alloc(32, 1));
    expect(enabled.fhirHubIdentityKey).toEqual(Buffer.alloc(32, 2));
  });

  it("rejects malformed hub keys and retention outside the approved range", () => {
    expect(() => loadConfig(validEnvironment({
      FHIR_HUB_ENABLED: "true",
      FHIR_HUB_ENCRYPTION_KEY: Buffer.alloc(31).toString("base64"),
      FHIR_HUB_IDENTITY_KEY: Buffer.alloc(32).toString("base64"),
    }))).toThrow(/FHIR_HUB_ENCRYPTION_KEY.*exactly 32 bytes/);
    expect(() => loadConfig(validEnvironment({
      FHIR_HUB_ENABLED: "true",
      FHIR_HUB_ENCRYPTION_KEY: `${Buffer.alloc(32, 1).toString("base64")}!`,
      FHIR_HUB_IDENTITY_KEY: Buffer.alloc(32, 2).toString("base64"),
    }))).toThrow(/FHIR_HUB_ENCRYPTION_KEY.*exactly 32 bytes/);
    expect(() => loadConfig(validEnvironment({
      FHIR_HUB_RETENTION_DAYS: "0",
    }))).toThrow(/FHIR_HUB_RETENTION_DAYS/);

    const shared = Buffer.alloc(32, 3).toString("base64");
    expect(() => loadConfig(validEnvironment({
      FHIR_HUB_ENABLED: "true",
      FHIR_HUB_ENCRYPTION_KEY: shared,
      FHIR_HUB_IDENTITY_KEY: shared,
    }))).toThrow(/keys must be distinct/);

    expect(() => loadConfig(validEnvironment({
      TOKEN_STORAGE: "encrypted-file",
      TOKEN_ENCRYPTION_KEY: shared,
      FHIR_HUB_ENABLED: "true",
      FHIR_HUB_ENCRYPTION_KEY: shared,
      FHIR_HUB_IDENTITY_KEY: Buffer.alloc(32, 4).toString("base64"),
    }))).toThrow(/keys must be distinct/);

    expect(() => loadConfig(validEnvironment({
      SESSION_SECRET: shared,
      FHIR_HUB_ENABLED: "true",
      FHIR_HUB_ENCRYPTION_KEY: shared,
      FHIR_HUB_IDENTITY_KEY: Buffer.alloc(32, 4).toString("base64"),
    }))).toThrow(/keys must be distinct/);

    expect(() => loadConfig(validEnvironment({
      FHIR_HUB_ENABLED: "true",
      FHIR_HUB_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
      FHIR_HUB_IDENTITY_KEY: Buffer.alloc(32, 6).toString("base64"),
      TOKEN_STORE_FILE: ".data/shared.enc",
      FHIR_HUB_STORE_FILE: ".data/shared.enc",
    }))).toThrow(/FHIR_HUB_STORE_FILE must be separate/);
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
