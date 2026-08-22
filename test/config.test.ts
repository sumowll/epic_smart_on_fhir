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
});
