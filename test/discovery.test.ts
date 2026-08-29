import { describe, expect, it, vi } from "vitest";

import { EpicDiscoveryService } from "../src/discovery.js";
import type { FetchLike } from "../src/types.js";
import { jsonResponse, makeConfig } from "./helpers.js";

interface DiscoveryOverrides {
  readonly smart?: Record<string, unknown>;
  readonly oidc?: Record<string, unknown>;
  readonly capability?: Record<string, unknown>;
}

const baseSmartCapabilities = [
  "launch-standalone",
  "context-standalone-patient",
  "permission-patient",
  "permission-v2",
  "sso-openid-connect",
] as const;

const confidentialSmartCapabilities = [
  ...baseSmartCapabilities,
  "client-confidential-symmetric",
] as const;

function discoveryFetch(
  capabilities: string[],
  overrides: DiscoveryOverrides = {},
): FetchLike {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.endsWith("/.well-known/smart-configuration")) {
      return jsonResponse({
        authorization_endpoint: "https://ehr.example.test/oauth2/authorize",
        token_endpoint: "https://ehr.example.test/oauth2/token",
        capabilities,
        code_challenge_methods_supported: ["S256"],
        // Epic intentionally does not list "none" here for public clients.
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "private_key_jwt",
        ],
        ...overrides.smart,
      });
    }
    if (url.endsWith("/metadata")) {
      return jsonResponse({
        resourceType: "CapabilityStatement",
        fhirVersion: "4.0.1",
        format: ["application/fhir+json"],
        rest: [{
          mode: "server",
          resource: [{
            type: "Patient",
            interaction: [{ code: "read" }, { code: "search-type" }],
            searchParam: [{ name: "_id" }],
          }],
        }],
        ...overrides.capability,
      });
    }
    return jsonResponse({
      issuer: "https://ehr.example.test/oauth2",
      jwks_uri: "https://ehr.example.test/oauth2/jwks",
      id_token_signing_alg_values_supported: ["RS256"],
      ...overrides.oidc,
    });
  }) as FetchLike;
}

describe("Epic discovery", () => {
  it("recognizes Epic's client-public capability for auth method none", async () => {
    const config = makeConfig({
      EPIC_TOKEN_AUTH_METHOD: "none",
      EPIC_CLIENT_SECRET: undefined,
    });
    const service = new EpicDiscoveryService(
      config,
      discoveryFetch([...baseSmartCapabilities, "client-public"]),
    );
    await expect(service.discover()).resolves.toMatchObject({
      smart: { tokenEndpoint: "https://ehr.example.test/oauth2/token" },
    });
  });

  it("rejects a public client when the endpoint does not advertise it", async () => {
    const config = makeConfig({
      EPIC_TOKEN_AUTH_METHOD: "none",
      EPIC_CLIENT_SECRET: undefined,
    });
    const service = new EpicDiscoveryService(
      config,
      discoveryFetch([...baseSmartCapabilities]),
    );
    await expect(service.discover()).rejects.toThrow(/client-public/);
  });

  it.each([
    "launch-standalone",
    "context-standalone-patient",
    "permission-patient",
    "sso-openid-connect",
  ])("rejects an endpoint missing required SMART capability %s", async (missing) => {
    const service = new EpicDiscoveryService(
      makeConfig(),
      discoveryFetch(confidentialSmartCapabilities.filter((value) => value !== missing)),
    );

    await expect(service.discover()).rejects.toMatchObject({
      code: "smart_capability_missing",
    });
  });

  it("requires SMART v2 support when a v2 resource scope is requested", async () => {
    const service = new EpicDiscoveryService(
      makeConfig({ EPIC_ALLOWED_RESOURCE_SCOPES: "patient/Patient.r" }),
      discoveryFetch(confidentialSmartCapabilities.filter((value) => value !== "permission-v2")),
    );

    await expect(service.discover()).rejects.toMatchObject({
      code: "smart_capability_missing",
      message: expect.stringContaining("permission-v2"),
    });
  });

  it("requires SMART v1 support when a v1 resource scope is requested", async () => {
    const service = new EpicDiscoveryService(
      makeConfig({ EPIC_ALLOWED_RESOURCE_SCOPES: "patient/Patient.read" }),
      discoveryFetch([...confidentialSmartCapabilities]),
    );

    await expect(service.discover()).rejects.toMatchObject({
      code: "smart_capability_missing",
      message: expect.stringContaining("permission-v1"),
    });
  });

  it("requires offline permission support when offline access is requested", async () => {
    const service = new EpicDiscoveryService(
      makeConfig({ EPIC_SCOPES: "openid fhirUser launch/patient offline_access" }),
      discoveryFetch([...confidentialSmartCapabilities]),
    );

    await expect(service.discover()).rejects.toMatchObject({
      code: "smart_capability_missing",
      message: expect.stringContaining("permission-offline"),
    });
  });

  it("requires the configured confidential client profile as well as its token method", async () => {
    const service = new EpicDiscoveryService(
      makeConfig(),
      discoveryFetch([...baseSmartCapabilities]),
    );

    await expect(service.discover()).rejects.toMatchObject({
      code: "client_auth_not_supported",
    });
  });

  it("uses the OpenID default client_secret_basic method when token methods are omitted", async () => {
    const service = new EpicDiscoveryService(
      makeConfig(),
      discoveryFetch([...confidentialSmartCapabilities], {
        smart: { token_endpoint_auth_methods_supported: undefined },
      }),
    );

    await expect(service.discover()).resolves.toMatchObject({
      smart: { tokenAuthMethods: [] },
    });
  });

  it("rejects SMART endpoints outside the configured trusted origins", async () => {
    const service = new EpicDiscoveryService(
      makeConfig(),
      discoveryFetch([...confidentialSmartCapabilities], {
        smart: { token_endpoint: "https://attacker.example/token" },
      }),
    );

    await expect(service.discover()).rejects.toMatchObject({
      code: "untrusted_discovery_endpoint",
    });
  });

  it("rejects OpenID endpoints outside the configured trusted origins", async () => {
    const service = new EpicDiscoveryService(
      makeConfig(),
      discoveryFetch([...confidentialSmartCapabilities], {
        oidc: { jwks_uri: "https://attacker.example/jwks" },
      }),
    );

    await expect(service.discover()).rejects.toMatchObject({
      code: "untrusted_discovery_endpoint",
    });
  });

  it("accepts a separate authorization host only when its origin is explicitly trusted", async () => {
    const config = makeConfig({
      EPIC_TRUSTED_ENDPOINT_ORIGINS: "https://auth.example.test",
    });
    const service = new EpicDiscoveryService(
      config,
      discoveryFetch([...confidentialSmartCapabilities], {
        smart: {
          authorization_endpoint: "https://auth.example.test/oauth2/authorize",
          token_endpoint: "https://auth.example.test/oauth2/token",
        },
      }),
    );

    await expect(service.discover()).resolves.toMatchObject({
      smart: {
        authorizationEndpoint: "https://auth.example.test/oauth2/authorize",
        tokenEndpoint: "https://auth.example.test/oauth2/token",
      },
    });
  });

  it("discovers and merges each resource's advertised reverse includes", async () => {
    const service = new EpicDiscoveryService(
      makeConfig(),
      discoveryFetch([...confidentialSmartCapabilities], {
        capability: {
          rest: [{
            mode: "server",
            resource: [{
              type: "Patient",
              interaction: [{ code: "read" }],
            }, {
              type: "Observation",
              interaction: [{ code: "search-type" }],
              searchParam: [{ name: "patient" }],
              searchRevInclude: ["Provenance:target", "not a valid include"],
            }, {
              type: "Observation",
              interaction: [{ code: "read" }],
              searchRevInclude: ["AuditEvent:entity", "Provenance:target"],
            }],
          }],
        },
      }),
    );

    const discovery = await service.discover();
    expect(discovery.fhirCapabilities.find(({ resourceType }) =>
      resourceType === "Patient")?.searchRevIncludes).toEqual([]);
    expect(discovery.fhirCapabilities.find(({ resourceType }) =>
      resourceType === "Observation")).toMatchObject({
      interactions: ["search", "read"],
      searchParameters: ["patient"],
      searchRevIncludes: ["AuditEvent:entity", "Provenance:target"],
    });
  });

  it("fails closed for incompatible or insufficient FHIR CapabilityStatements", async () => {
    const cases: Array<readonly [Record<string, unknown>, string]> = [
      [{ fhirVersion: "5.0.0" }, "unsupported_fhir_version"],
      [{ fhirVersion: "4.0.invalid" }, "unsupported_fhir_version"],
      [{ format: ["application/fhir+xml"] }, "fhir_json_not_supported"],
      [{ rest: [{ mode: "server", resource: [] }] }, "patient_read_not_supported"],
      [{
        rest: [{
          mode: "server",
          resource: [{
            type: "Patient",
            interaction: [{ code: "search-type" }],
            searchParam: [{ name: "_id" }],
          }],
        }],
      }, "patient_read_not_supported"],
    ];

    for (const [capability, expectedCode] of cases) {
      const service = new EpicDiscoveryService(
        makeConfig(),
        discoveryFetch([...confidentialSmartCapabilities], { capability }),
      );
      await expect(service.discover()).rejects.toMatchObject({ code: expectedCode });
    }
  });
});
