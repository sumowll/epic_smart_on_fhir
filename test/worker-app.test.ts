import { afterEach, describe, expect, it, vi } from "vitest";

import { EpicConnectorService } from "../src/connector.js";
import { InMemoryConnectionStore } from "../src/store.js";
import type { FetchLike } from "../src/types.js";
import { WorkerHttpApplication } from "../src/worker-app.js";
import { jsonResponse, makeConfig } from "./helpers.js";

const openServices: EpicConnectorService[] = [];

const smartCapabilities = [
  "launch-standalone",
  "client-confidential-symmetric",
  "context-standalone-patient",
  "permission-patient",
  "permission-v2",
  "sso-openid-connect",
];

afterEach(async () => {
  await Promise.all(openServices.splice(0).map((service) => service.close()));
});

async function makeWorkerApplication(fetch?: FetchLike): Promise<WorkerHttpApplication> {
  const config = makeConfig({
    EPIC_REDIRECT_URI: "https://connector.example.test/auth/callback",
  });
  const service = new EpicConnectorService(
    config,
    new InMemoryConnectionStore(),
    fetch ? { fetch } : {},
  );
  await service.initialize();
  openServices.push(service);
  return new WorkerHttpApplication(service);
}

describe("Cloudflare Worker HTTP application", () => {
  it("returns an authorization URL as JSON for the browser handoff", async () => {
    const config = makeConfig({
      EPIC_REDIRECT_URI: "https://connector.example.test/auth/callback",
    });
    const authorizationUrl =
      "https://ehr.example.test/authorize?response_type=code&state=state-value";
    const service = {
      config,
      startAuthorization: vi.fn(async () => authorizationUrl),
    } as unknown as EpicConnectorService;
    const app = new WorkerHttpApplication(service);
    const sessionId = "s".repeat(43);

    const response = await app.fetch(
      new Request("https://connector.example.test/auth/start", {
        method: "POST",
        headers: {
          Accept: "application/json",
          Origin: config.publicOrigin,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          consent: "accepted",
          policyVersion: config.consentPolicyVersion,
        }),
      }),
      sessionId,
      sessionId,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ authorizationUrl });
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("vary")).toBe("Accept");
    expect(response.headers.get("set-cookie")).toContain(sessionId);

    const invalid = await app.fetch(
      new Request("https://connector.example.test/auth/start", {
        method: "POST",
        headers: {
          Accept: "application/json",
          Origin: config.publicOrigin,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ consent: "accepted", policyVersion: "stale-policy" }),
      }),
      sessionId,
      sessionId,
    );
    expect(invalid.status).toBe(409);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: "consent_required" },
    });
    expect(invalid.headers.get("vary")).toBe("Accept");
  });

  it("requires explicit MyChart cleanup when registry failure revocation is unconfirmed", async () => {
    const config = makeConfig({
      EPIC_REDIRECT_URI: "https://connector.example.test/auth/callback",
    });
    const pendingSessionId = "p".repeat(43);
    const authenticatedSessionId = "a".repeat(43);
    const disconnect = vi.fn(async () => ({
      disconnected: true as const,
      remoteRevocation: "not_supported" as const,
      manualRevocationRecommended: true,
    }));
    const service = {
      config,
      startAuthorization: vi.fn(async () => "https://ehr.example.test/authorize"),
      completeAuthorization: vi.fn(async () => authenticatedSessionId),
      disconnect,
    } as unknown as EpicConnectorService;
    const app = new WorkerHttpApplication(service, {
      onConnected: async () => {
        throw new Error("registry unavailable");
      },
    });

    const start = await app.fetch(
      new Request("https://connector.example.test/auth/start", {
        method: "POST",
        headers: {
          Origin: config.publicOrigin,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          consent: "accepted",
          policyVersion: config.consentPolicyVersion,
        }),
      }),
      pendingSessionId,
      pendingSessionId,
    );
    const cookie = start.headers.get("set-cookie")!.split(";", 1)[0]!;
    const response = await app.fetch(
      new Request("https://connector.example.test/auth/callback?code=code&state=state", {
        headers: { Cookie: cookie },
      }),
      pendingSessionId,
      pendingSessionId,
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("linked apps/devices");
    expect(disconnect).toHaveBeenCalledWith(authenticatedSessionId);
  });

  it("serves health and connection routes with browser hardening headers", async () => {
    const app = await makeWorkerApplication();

    const health = await app.fetch(new Request("https://connector.example.test/healthz"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(health.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(health.headers.get("content-security-policy")).toContain("form-action 'self';");
    expect(health.headers.get("content-security-policy")).not.toContain(
      "form-action 'self' https://ehr.example.test",
    );
    expect(health.headers.get("strict-transport-security")).toContain("max-age=");

    const connection = await app.fetch(
      new Request("https://connector.example.test/api/connection"),
    );
    expect(await connection.json()).toMatchObject({
      connected: false,
      provider: "Example Health",
    });
  });

  it("serves public Terms and Privacy pages, including HEAD", async () => {
    const app = await makeWorkerApplication();

    const terms = await app.fetch(
      new Request("https://connector.example.test/terms"),
    );
    expect(terms.status).toBe(200);
    expect(terms.headers.get("content-type")).toContain("text/html");
    expect(terms.headers.get("cache-control")).toBe("no-store");
    expect(await terms.text()).toContain("Example Connector, Inc.");

    const privacy = await app.fetch(
      new Request("https://connector.example.test/privacy", { method: "HEAD" }),
    );
    expect(privacy.status).toBe(200);
    expect(privacy.headers.get("content-type")).toContain("text/html");
    expect(await privacy.text()).toBe("");
  });

  it("binds every private health hub operation to live context and explicit consent", async () => {
    const config = makeConfig({
      EPIC_REDIRECT_URI: "https://connector.example.test/auth/callback",
      FHIR_HUB_ENABLED: "true",
      FHIR_HUB_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      FHIR_HUB_IDENTITY_KEY: Buffer.alloc(32, 2).toString("base64"),
      FHIR_HUB_CONSENT_VERSION: "hub-policy-v3",
    });
    const sessionId = "h".repeat(43);
    const connectionContext = "c".repeat(43);
    const getFhirHubStatusBound = vi.fn(async () => ({
      value: {
        available: true,
        enabled: false,
        consentCurrent: false,
        consentPolicyVersion: config.fhirHubConsentVersion,
        currentResourceCount: 0,
        resourceVersionCount: 0,
        careTeamCount: 0,
        normalizedResourceCount: 0,
        normalizationFailureCount: 0,
        insightCount: 0,
      },
      connectionContext,
    }));
    const enableFhirHubBound = vi.fn(async () => ({
      value: { available: true, enabled: true, consentCurrent: true },
      connectionContext,
    }));
    const listFhirHubResourcesBound = vi.fn(async () => ({
      value: [{ resourceType: "CareTeam", raw: { resourceType: "CareTeam", id: "ct-1" } }],
      connectionContext,
    }));
    const getFhirHubIntelligenceBound = vi.fn(async () => ({
      value: {
        schemaVersion: 1,
        projections: [{
          versionKey: "v".repeat(64),
          current: true,
          provenance: { resourceType: "CareTeam", resourceId: "ct-1" },
          normalization: { status: "normalized", projection: { headline: "My team" } },
        }],
        insights: [{ insightType: "care-team-summary", status: "generated" }],
        hasMore: false,
      },
      connectionContext,
    }));
    const exportFhirHubBound = vi.fn(async () => ({
      value: { schemaVersion: 1, resourceVersions: [] },
      connectionContext,
    }));
    const deleteFhirHubBound = vi.fn(async () => ({
      value: { deleted: true, resourcesDeleted: 1 },
      connectionContext,
    }));
    const service = {
      config,
      startAuthorization: vi.fn(async () => "https://ehr.example.test/authorize"),
      getFhirHubStatusBound,
      enableFhirHubBound,
      listFhirHubResourcesBound,
      getFhirHubIntelligenceBound,
      exportFhirHubBound,
      deleteFhirHubBound,
    } as unknown as EpicConnectorService;
    const app = new WorkerHttpApplication(service);

    const start = await app.fetch(new Request("https://connector.example.test/auth/start", {
      method: "POST",
      headers: {
        Origin: config.publicOrigin,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        consent: "accepted",
        policyVersion: config.consentPolicyVersion,
      }),
    }), sessionId, sessionId);
    const cookie = start.headers.get("set-cookie")!.split(";", 1)[0]!;
    const boundHeaders = {
      Cookie: cookie,
      "X-Epic-Expected-Connection-Context": connectionContext,
    };

    const missingContext = await app.fetch(
      new Request("https://connector.example.test/api/hub/status", {
        headers: { Cookie: cookie },
      }),
      sessionId,
      sessionId,
    );
    expect(missingContext.status).toBe(409);
    expect(getFhirHubStatusBound).not.toHaveBeenCalled();

    const status = await app.fetch(
      new Request("https://connector.example.test/api/hub/status", { headers: boundHeaders }),
      sessionId,
      sessionId,
    );
    expect(status.status).toBe(200);
    expect(status.headers.get("X-Epic-Connection-Context")).toBe(connectionContext);
    expect(getFhirHubStatusBound).toHaveBeenCalledWith(sessionId, connectionContext);

    const rejectedOrigin = await app.fetch(
      new Request("https://connector.example.test/api/hub/enable", {
        method: "POST",
        headers: {
          ...boundHeaders,
          Origin: "https://attacker.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ policyVersion: config.fhirHubConsentVersion }),
      }),
      sessionId,
      sessionId,
    );
    expect(rejectedOrigin.status).toBe(403);
    expect(enableFhirHubBound).not.toHaveBeenCalled();

    const staleConsent = await app.fetch(
      new Request("https://connector.example.test/api/hub/enable", {
        method: "POST",
        headers: {
          ...boundHeaders,
          Origin: config.publicOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ policyVersion: "old-policy" }),
      }),
      sessionId,
      sessionId,
    );
    expect(staleConsent.status).toBe(409);
    expect(enableFhirHubBound).not.toHaveBeenCalled();

    const enabled = await app.fetch(
      new Request("https://connector.example.test/api/hub/enable", {
        method: "POST",
        headers: {
          ...boundHeaders,
          Origin: config.publicOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ policyVersion: config.fhirHubConsentVersion }),
      }),
      sessionId,
      sessionId,
    );
    expect(enabled.status).toBe(200);
    expect(enableFhirHubBound).toHaveBeenCalledWith(
      sessionId,
      config.fhirHubConsentVersion,
      connectionContext,
    );

    const resources = await app.fetch(
      new Request(
        "https://connector.example.test/api/hub/resources?resourceType=CareTeam&includeHistory=true&limit=250",
        { headers: boundHeaders },
      ),
      sessionId,
      sessionId,
    );
    expect(resources.status).toBe(200);
    expect(listFhirHubResourcesBound).toHaveBeenCalledWith(
      sessionId,
      { resourceType: "CareTeam", includeHistory: true, limit: 250 },
      connectionContext,
    );

    const intelligence = await app.fetch(
      new Request(
        "https://connector.example.test/api/hub/intelligence?resourceType=CareTeam&includeHistory=true&includeSuperseded=true&limit=25",
        { headers: boundHeaders },
      ),
      sessionId,
      sessionId,
    );
    expect(intelligence.status).toBe(200);
    expect(intelligence.headers.get("X-Epic-Connection-Context")).toBe(connectionContext);
    expect(await intelligence.json()).toMatchObject({
      schemaVersion: 1,
      projections: [{ normalization: { status: "normalized" } }],
      insights: [{ insightType: "care-team-summary" }],
      hasMore: false,
    });
    expect(getFhirHubIntelligenceBound).toHaveBeenCalledWith(
      sessionId,
      {
        resourceType: "CareTeam",
        includeHistory: true,
        includeSuperseded: true,
        limit: 25,
      },
      connectionContext,
    );

    const invalidIntelligence = await app.fetch(
      new Request(
        "https://connector.example.test/api/hub/intelligence?includeSuperseded=1",
        { headers: boundHeaders },
      ),
      sessionId,
      sessionId,
    );
    expect(invalidIntelligence.status).toBe(400);
    expect(getFhirHubIntelligenceBound).toHaveBeenCalledTimes(1);
    for (const query of [
      "limit=1&limit=2",
      "unexpected=true",
      "limit=0",
      "limit=251",
    ]) {
      const invalid = await app.fetch(
        new Request(
          `https://connector.example.test/api/hub/intelligence?${query}`,
          { headers: boundHeaders },
        ),
        sessionId,
        sessionId,
      );
      expect(invalid.status).toBe(400);
    }
    expect(getFhirHubIntelligenceBound).toHaveBeenCalledTimes(1);

    const exported = await app.fetch(
      new Request("https://connector.example.test/api/hub/export", { headers: boundHeaders }),
      sessionId,
      sessionId,
    );
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toBe(
      'attachment; filename="moonba-health-hub.json"',
    );

    const unconfirmedDelete = await app.fetch(
      new Request("https://connector.example.test/api/hub/delete", {
        method: "POST",
        headers: {
          ...boundHeaders,
          Origin: config.publicOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ confirmation: "DELETE" }),
      }),
      sessionId,
      sessionId,
    );
    expect(unconfirmedDelete.status).toBe(400);
    expect(deleteFhirHubBound).not.toHaveBeenCalled();

    const deleted = await app.fetch(
      new Request("https://connector.example.test/api/hub/delete", {
        method: "POST",
        headers: {
          ...boundHeaders,
          Origin: config.publicOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ confirmation: "DELETE MY HEALTH HUB" }),
      }),
      sessionId,
      sessionId,
    );
    expect(deleted.status).toBe(200);
    expect(deleteFhirHubBound).toHaveBeenCalledWith(
      sessionId,
      "DELETE MY HEALTH HUB",
      connectionContext,
    );
  });

  it("rejects cross-origin authorization starts", async () => {
    const app = await makeWorkerApplication();
    const response = await app.fetch(new Request(
      "https://connector.example.test/auth/start",
      { method: "POST", headers: { Origin: "https://attacker.example" } },
    ));

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("attacker.example");
  });

  it("signs the session cookie and consumes OAuth state only once", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/.well-known/smart-configuration")) {
        return jsonResponse({
          authorization_endpoint: "https://ehr.example.test/authorize",
          token_endpoint: "https://ehr.example.test/token",
          capabilities: smartCapabilities,
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        });
      }
      if (url.endsWith("/.well-known/openid-configuration")) {
        return jsonResponse({
          issuer: "https://ehr.example.test/oauth2",
          jwks_uri: "https://ehr.example.test/jwks",
          id_token_signing_alg_values_supported: ["ES384"],
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
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const app = await makeWorkerApplication(fetchMock as FetchLike);
    const routedSessionId = "r".repeat(43);

    const start = await app.fetch(new Request(
      "https://connector.example.test/auth/start",
      {
        method: "POST",
        headers: {
          Origin: "https://connector.example.test",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          consent: "accepted",
          policyVersion: "2026-08-23",
        }),
      },
    ), routedSessionId);
    expect(start.status).toBe(303);
    const location = new URL(start.headers.get("location")!);
    const state = location.searchParams.get("state")!;
    const cookie = start.headers.get("set-cookie")!.split(";", 1)[0]!;
    expect(cookie).toContain(routedSessionId);
    expect(start.headers.get("set-cookie")).toContain("Secure");
    expect(start.headers.get("set-cookie")).toContain("HttpOnly");

    const callbackUrl = new URL("https://connector.example.test/auth/callback");
    callbackUrl.searchParams.set("error", "access_denied");
    callbackUrl.searchParams.set("state", state);
    const callback = await app.fetch(
      new Request(callbackUrl, { headers: { Cookie: cookie } }),
      routedSessionId,
    );
    expect(callback.status).toBe(400);
    expect(await callback.text()).toContain("not authorized");

    const replay = await app.fetch(
      new Request(callbackUrl, { headers: { Cookie: cookie } }),
      routedSessionId,
    );
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("invalid or expired");

    const mismatchedRoute = await app.fetch(
      new Request("https://connector.example.test/api/connection", {
        headers: { Cookie: cookie },
      }),
      "x".repeat(43),
    );
    expect(mismatchedRoute.status).toBe(400);
    await expect(mismatchedRoute.json()).resolves.toMatchObject({
      error: { code: "invalid_session" },
    });
  });
});
