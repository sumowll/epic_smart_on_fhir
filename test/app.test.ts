import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AuditEvent } from "../src/audit.js";
import { InMemoryFhirHubRepository } from "../src/fhir-hub.js";
import { InMemoryConnectionStore } from "../src/store.js";
import type { ConnectionRecord, FetchLike } from "../src/types.js";
import { jsonResponse, makeConfig } from "./helpers.js";

const openApps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

const smartCapabilities = [
  "launch-standalone",
  "client-confidential-symmetric",
  "context-standalone-patient",
  "permission-patient",
  "permission-v2",
  "sso-openid-connect",
];

function fhirMetadataResponse(): Response {
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

function consentRequest(config: ReturnType<typeof makeConfig>): {
  readonly headers: Record<string, string>;
  readonly payload: string;
} {
  return {
    headers: {
      origin: config.publicOrigin,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: new URLSearchParams({
      consent: "accepted",
      policyVersion: config.consentPolicyVersion,
    }).toString(),
  };
}

function expectFhirTrace(
  headers: Record<string, string | string[] | undefined>,
  expected: {
    readonly source: "epic" | "connector-derived";
    readonly interaction: "read" | "search";
    readonly resourceType: string;
    readonly transforms: string;
  },
): void {
  expect(Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.startsWith("x-moonba-fhir-")),
  )).toEqual({
    "x-moonba-fhir-source": expected.source,
    "x-moonba-fhir-interaction": expected.interaction,
    "x-moonba-fhir-resource-type": expected.resourceType,
    "x-moonba-fhir-resource-fields": "preserved",
    "x-moonba-fhir-transforms": expected.transforms,
  });
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("HTTP application", () => {
  it("sets no-store and browser hardening headers", async () => {
    const app = await buildApp(makeConfig());
    openApps.push(app);
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("same-origin");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["content-security-policy"]).toContain("form-action 'self';");
    expect(response.headers["content-security-policy"]).not.toContain(
      "form-action 'self' https://ehr.example.test",
    );
  });

  it("serves public Terms and Privacy pages", async () => {
    const app = await buildApp(makeConfig());
    openApps.push(app);

    const terms = await app.inject({ method: "GET", url: "/terms" });
    expect(terms.statusCode).toBe(200);
    expect(terms.headers["content-type"]).toContain("text/html");
    expect(terms.headers["cache-control"]).toBe("no-store");
    expect(terms.body).toContain("Terms and Conditions");
    expect(terms.body).toContain("Example Connector, Inc.");

    const privacy = await app.inject({ method: "GET", url: "/privacy" });
    expect(privacy.statusCode).toBe(200);
    expect(privacy.body).toContain("Privacy Notice");
    expect(privacy.body).toContain("privacy@connector.example.test");

    const head = await app.inject({ method: "HEAD", url: "/privacy" });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");
  });

  it("rejects cross-origin authorization starts", async () => {
    const app = await buildApp(makeConfig());
    openApps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/auth/start",
      headers: { origin: "https://attacker.example" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain("attacker.example");
  });

  it("cannot evade authorization throttling by rotating User-Agent", async () => {
    const config = makeConfig();
    const app = await buildApp(config, { enablePruneTimer: false });
    openApps.push(app);

    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/auth/start",
        headers: {
          origin: config.publicOrigin,
          "user-agent": `rotating-client-${index}`,
        },
      });
      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(409));
    expect(statuses[10]).toBe(429);
  });

  it("omits unvalidated FHIR path text from failure audit events", async () => {
    const events: AuditEvent[] = [];
    const app = await buildApp(makeConfig(), {
      enablePruneTimer: false,
      audit: (event) => events.push(event),
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/fhir/private-health-note",
    });

    expect(response.statusCode).toBe(401);
    const event = events.find((candidate) => candidate.event === "fhir_access");
    expect(event).toBeDefined();
    expect(event?.resourceType).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("private-health-note");
  });

  it("describes successful FHIR response processing with bounded, non-sensitive headers", async () => {
    const resourceScopes =
      "patient/Patient.r patient/Condition.rs patient/Encounter.s patient/Location.r";
    const config = makeConfig({
      EPIC_ALLOWED_RESOURCE_TYPES: "Condition,Encounter,Location",
      EPIC_ALLOWED_RESOURCE_SCOPES: resourceScopes,
    });
    const now = Date.now();
    const sessionId = "t".repeat(43);
    const store = new InMemoryConnectionStore();
    await store.initialize();
    const record: ConnectionRecord = {
      oauthClientId: config.clientId,
      tokenAuthMethod: config.tokenAuthMethod,
      fhirBaseUrl: config.fhirBaseUrl,
      tokenEndpoint: "https://ehr.example.test/token",
      accessToken: "private-access-token",
      tokenType: "Bearer",
      expiresAt: now + 60 * 60 * 1_000,
      scope: resourceScopes,
      patientId: "patient-private",
      oidcIssuer: "https://ehr.example.test/oauth2",
      oidcSubject: "account-private",
      consent: {
        policyVersion: config.consentPolicyVersion,
        acceptedAt: now - 1_000,
        purpose: "patient-access",
        requestedScopes: [...config.scopes],
        allowedResourceScopes: [...config.allowedResourceScopes],
      },
      fhirCapabilities: [{
        resourceType: "Patient",
        interactions: ["read"],
        searchParameters: [],
      }, {
        resourceType: "Condition",
        interactions: ["read", "search"],
        searchParameters: ["patient", "status"],
      }, {
        resourceType: "Encounter",
        interactions: ["search"],
        searchParameters: ["patient"],
      }, {
        resourceType: "Location",
        interactions: ["read"],
        searchParameters: [],
      }],
      connectedAt: now - 1_000,
      lastAccessAt: now - 1_000,
      sessionExpiresAt: now + 60 * 60 * 1_000,
    };
    await store.set(sessionId, record);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-access-token");
      const upstream = new URL(input.toString());
      if (upstream.pathname.endsWith("/Patient/patient-private")) {
        return jsonResponse({ resourceType: "Patient", id: "patient-private" });
      }
      if (upstream.pathname.endsWith("/Condition/condition-private")) {
        return jsonResponse({ resourceType: "Condition", id: "condition-private" });
      }
      if (upstream.pathname.endsWith("/Condition")) {
        if (upstream.searchParams.get("page") === "2") {
          return jsonResponse({ resourceType: "Bundle", type: "searchset", link: [] });
        }
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          link: [{
            relation: "next",
            url: `${config.fhirBaseUrl}/Condition?status=active&patient=patient-private&page=2`,
          }],
        });
      }
      if (upstream.pathname.endsWith("/Encounter")) {
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          entry: [{
            resource: {
              resourceType: "Encounter",
              id: "encounter-private",
              location: [{ location: { reference: "Location/location-private" } }],
            },
          }],
        });
      }
      if (upstream.pathname.endsWith("/Location/location-private")) {
        return jsonResponse({ resourceType: "Location", id: "location-private" });
      }
      throw new Error(`Unexpected fetch: ${upstream.origin}${upstream.pathname}`);
    });
    const app = await buildApp(config, {
      store,
      fetch: fetchMock as FetchLike,
      enablePruneTimer: false,
    });
    openApps.push(app);

    const cookie = `${config.cookieName}=${app.signCookie(sessionId)}`;
    const connection = await app.inject({
      method: "GET",
      url: "/api/connection",
      headers: { cookie },
    });
    const connectionContext = connection.json().connectionContext as string;
    const headers = {
      cookie,
      "x-epic-expected-connection-context": connectionContext,
    };

    const patient = await app.inject({ method: "GET", url: "/api/patient", headers });
    expect(patient.statusCode).toBe(200);
    expectFhirTrace(patient.headers, {
      source: "epic",
      interaction: "read",
      resourceType: "Patient",
      transforms: "json-parsed,validated",
    });

    const read = await app.inject({
      method: "GET",
      url: "/api/fhir/Condition/condition-private",
      headers,
    });
    expect(read.statusCode).toBe(200);
    expectFhirTrace(read.headers, {
      source: "epic",
      interaction: "read",
      resourceType: "Condition",
      transforms: "json-parsed,validated",
    });

    const search = await app.inject({
      method: "GET",
      url: "/api/fhir/Condition?status=active&_count=1",
      headers,
    });
    expect(search.statusCode).toBe(200);
    expectFhirTrace(search.headers, {
      source: "epic",
      interaction: "search",
      resourceType: "Condition",
      transforms: "json-parsed,validated,bundle-links-rewritten",
    });

    const nextPath = search.json().link[0].url as string;
    const page = await app.inject({ method: "GET", url: nextPath, headers });
    expect(page.statusCode).toBe(200);
    expectFhirTrace(page.headers, {
      source: "epic",
      interaction: "search",
      resourceType: "Condition",
      transforms: "json-parsed,validated,bundle-links-rewritten",
    });

    const locations = await app.inject({
      method: "GET",
      url: "/api/fhir/Location?_count=1",
      headers,
    });
    expect(locations.statusCode).toBe(200);
    expectFhirTrace(locations.headers, {
      source: "connector-derived",
      interaction: "search",
      resourceType: "Location",
      transforms:
        "json-parsed,validated,derived-from-encounter-references,bundle-generated",
    });

    const traceValues = [patient, read, search, page, locations]
      .flatMap((response) => Object.entries(response.headers))
      .filter(([name]) => name.startsWith("x-moonba-fhir-"))
      .map(([, value]) => String(value))
      .join("|");
    expect(traceValues).not.toContain("private");
    expect(traceValues).not.toContain(config.fhirBaseUrl);
    expect(traceValues).not.toContain("status=active");

    const invalidPage = await app.inject({
      method: "GET",
      url: "/api/fhir-page?cursor=",
      headers,
    });
    expect(invalidPage.statusCode).toBe(400);
    expect(Object.keys(invalidPage.headers)).not.toContain("x-moonba-fhir-source");
  });

  it("correlates an opt-in Epic error wire log with the browser request ID", async () => {
    const resourceScopes = "patient/Practitioner.s";
    const config = makeConfig({
      EPIC_ALLOWED_RESOURCE_TYPES: "Practitioner",
      EPIC_ALLOWED_RESOURCE_SCOPES: resourceScopes,
      EPIC_FHIR_WIRE_LOGGING: "errors",
    });
    const now = Date.now();
    const sessionId = "w".repeat(43);
    const store = new InMemoryConnectionStore();
    await store.initialize();
    await store.set(sessionId, {
      oauthClientId: config.clientId,
      tokenAuthMethod: config.tokenAuthMethod,
      fhirBaseUrl: config.fhirBaseUrl,
      tokenEndpoint: "https://ehr.example.test/token",
      accessToken: "wire-log-access-token",
      tokenType: "Bearer",
      expiresAt: now + 60 * 60 * 1_000,
      scope: resourceScopes,
      patientId: "patient-wire-log",
      oidcIssuer: "https://ehr.example.test/oauth2",
      oidcSubject: "account-wire-log",
      consent: {
        policyVersion: config.consentPolicyVersion,
        acceptedAt: now - 1_000,
        purpose: "patient-access",
        requestedScopes: [...config.scopes],
        allowedResourceScopes: [...config.allowedResourceScopes],
      },
      fhirCapabilities: [{
        resourceType: "Practitioner",
        interactions: ["search"],
        searchParameters: ["_count"],
      }],
      connectedAt: now - 1_000,
      lastAccessAt: now - 1_000,
      sessionExpiresAt: now + 60 * 60 * 1_000,
    });
    const operationOutcomeBody = JSON.stringify({
      resourceType: "OperationOutcome",
      issue: [{
        severity: "error",
        code: "invalid",
        diagnostics: "Practitioner search requires a criterion.",
      }],
    });
    const fetchMock = vi.fn(async () => new Response(operationOutcomeBody, {
      status: 400,
      headers: { "content-type": "application/fhir+json" },
    }));
    const wireLines: string[] = [];
    const consoleSpy = vi.spyOn(console, "info").mockImplementation((line) => {
      if (typeof line === "string" && line.includes('"fhirWire"')) {
        wireLines.push(line);
      }
    });
    const app = await buildApp(config, {
      store,
      fetch: fetchMock as FetchLike,
      enablePruneTimer: false,
      audit: () => undefined,
    });
    openApps.push(app);

    try {
      const cookie = `${config.cookieName}=${app.signCookie(sessionId)}`;
      const connection = await app.inject({
        method: "GET",
        url: "/api/connection",
        headers: { cookie },
      });
      const response = await app.inject({
        method: "GET",
        url: "/api/fhir/Practitioner?_count=20",
        headers: {
          cookie,
          "x-epic-expected-connection-context": connection.json().connectionContext,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          code: "fhir_request_rejected",
          message: "Epic rejected the Practitioner search parameters.",
        },
      });
      expect(response.body).not.toContain("Practitioner search requires a criterion");
      expect(wireLines).toHaveLength(2);
      const request = JSON.parse(wireLines[0]!).fhirWire as Record<string, unknown>;
      const upstream = JSON.parse(wireLines[1]!).fhirWire as Record<string, unknown>;
      expect(request).toMatchObject({
        direction: "request",
        requestId: response.headers["x-request-id"],
        url: `${config.fhirBaseUrl}/Practitioner?_count=20`,
      });
      expect(upstream).toMatchObject({
        direction: "response",
        requestId: response.headers["x-request-id"],
        exchangeId: request.exchangeId,
        status: 400,
        body: operationOutcomeBody,
      });
      expect(wireLines.join("\n")).not.toContain("wire-log-access-token");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("rejects missing, forged, and stale consent before creating a session or contacting Epic", async () => {
    const config = makeConfig({ CONSENT_POLICY_VERSION: "terms-v2" });
    const fetchMock = vi.fn();
    const app = await buildApp(config, { fetch: fetchMock as FetchLike });
    openApps.push(app);
    const invalidPayloads = [
      "",
      new URLSearchParams({ consent: "accepted" }).toString(),
      new URLSearchParams({
        consent: "declined",
        policyVersion: config.consentPolicyVersion,
      }).toString(),
      new URLSearchParams({ consent: "accepted", policyVersion: "terms-v1" }).toString(),
    ];

    for (const payload of invalidPayloads) {
      const response = await app.inject({
        method: "POST",
        url: "/auth/start",
        headers: {
          accept: "application/json",
          origin: config.publicOrigin,
          "content-type": "application/x-www-form-urlencoded",
        },
        payload,
      });
      expect(response.statusCode).toBe(409);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.headers.vary).toBe("Accept");
      expect(response.json()).toMatchObject({
        error: {
          code: "consent_required",
          message: expect.stringContaining("Review and accept the current Terms"),
        },
      });
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("completes a standalone flow, rejects callback replay, and reads the connected patient", async () => {
    const config = makeConfig({
      EPIC_ALLOWED_RESOURCE_SCOPES: "patient/Patient.r",
      FHIR_HUB_ENABLED: "true",
      FHIR_HUB_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      FHIR_HUB_IDENTITY_KEY: Buffer.alloc(32, 2).toString("base64"),
      FHIR_HUB_CONSENT_VERSION: "hub-policy-v3",
    });
    const { privateKey, publicKey } = await generateKeyPair("ES384");
    const publicJwk = await exportJWK(publicKey);
    let expectedNonce = "";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
      if (url.endsWith("/metadata")) return fhirMetadataResponse();
      if (url === "https://ehr.example.test/token") {
        const body = new URLSearchParams(init?.body?.toString());
        expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
        const now = Math.floor(Date.now() / 1_000);
        const idToken = await new SignJWT({
          nonce: expectedNonce,
          fhirUser: `${config.fhirBaseUrl}/Patient/patient-1`,
          })
          .setProtectedHeader({ alg: "ES384", kid: "key-1" })
          .setIssuer("https://ehr.example.test/oauth2")
          .setSubject("patient-user-1")
          .setAudience(config.clientId)
          .setIssuedAt(now)
          .setExpirationTime(now + 300)
          .sign(privateKey);
        return jsonResponse({
          access_token: "access-token",
          token_type: "bearer",
          expires_in: 3600,
          scope: "openid fhirUser launch/patient patient/Patient.r",
          patient: "patient-1",
          id_token: idToken,
        });
      }
      if (url === "https://ehr.example.test/jwks") {
        return jsonResponse({ keys: [{ ...publicJwk, alg: "ES384", kid: "key-1", use: "sig" }] });
      }
      if (url === `${config.fhirBaseUrl}/Patient/patient-1`) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token");
        return jsonResponse({ resourceType: "Patient", id: "patient-1" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const app = await buildApp(config, {
      fetch: fetchMock as FetchLike,
      fhirHub: new InMemoryFhirHubRepository(),
    });
    openApps.push(app);

    const consent = consentRequest(config);
    const start = await app.inject({
      method: "POST",
      url: "/auth/start",
      headers: {
        ...consent.headers,
        accept: "application/json",
      },
      payload: consent.payload,
    });
    expect(start.statusCode).toBe(200);
    expect(start.headers.location).toBeUndefined();
    expect(start.headers["content-type"]).toContain("application/json");
    expect(start.headers.vary).toBe("Accept");
    const authorizationUrl = new URL(start.json().authorizationUrl as string);
    expect(authorizationUrl.searchParams.get("scope")).toBe("openid fhirUser launch/patient");
    expect(authorizationUrl.search).not.toContain("patient%2F");
    expect(authorizationUrl.search.length).toBeLessThan(1_800);
    const state = authorizationUrl.searchParams.get("state")!;
    expectedNonce = authorizationUrl.searchParams.get("nonce")!;
    const cookie = start.headers["set-cookie"]!.split(";", 1)[0]!;

    const callbackUrl = `/auth/callback?code=one-time-code&state=${encodeURIComponent(state)}`;
    const callback = await app.inject({ method: "GET", url: callbackUrl, headers: { cookie } });
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe("/");
    const authenticatedCookie = callback.headers["set-cookie"]!.split(";", 1)[0]!;
    expect(authenticatedCookie).not.toBe(cookie);

    const replay = await app.inject({ method: "GET", url: callbackUrl, headers: { cookie: authenticatedCookie } });
    expect(replay.statusCode).toBe(400);

    const oldSessionStatus = await app.inject({ method: "GET", url: "/api/connection", headers: { cookie } });
    expect(oldSessionStatus.json()).toMatchObject({ connected: false });

    const status = await app.inject({ method: "GET", url: "/api/connection", headers: { cookie: authenticatedCookie } });
    expect(status.json()).toMatchObject({
      connected: true,
      capabilities: [{ resourceType: "Patient", read: true, search: false }],
    });
    const connectionContext = status.json().connectionContext as string;
    expect(connectionContext).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const patientCalls = (): number => fetchMock.mock.calls.filter(
      ([input]) => input?.toString() === `${config.fhirBaseUrl}/Patient/patient-1`,
    ).length;
    const stalePatient = await app.inject({
      method: "GET",
      url: "/api/patient",
      headers: {
        cookie: authenticatedCookie,
        "x-epic-expected-connection-context": "x".repeat(43),
      },
    });
    expect(stalePatient.statusCode).toBe(409);
    expect(stalePatient.json()).toMatchObject({
      error: { code: "connection_context_changed" },
    });
    expect(patientCalls()).toBe(0);

    const patient = await app.inject({
      method: "GET",
      url: "/api/patient",
      headers: {
        cookie: authenticatedCookie,
        "x-epic-expected-connection-context": connectionContext,
      },
    });
    expect(patient.statusCode).toBe(200);
    expect(patientCalls()).toBe(1);
    expect(patient.headers["x-epic-connection-context"]).toBe(connectionContext);
    expect(patient.json()).toEqual({ resourceType: "Patient", id: "patient-1" });

    const hubWithoutContext = await app.inject({
      method: "GET",
      url: "/api/hub/status",
      headers: { cookie: authenticatedCookie },
    });
    expect(hubWithoutContext.statusCode).toBe(409);
    expect(hubWithoutContext.json()).toMatchObject({
      error: { code: "connection_context_required" },
    });

    const hubStatus = await app.inject({
      method: "GET",
      url: "/api/hub/status",
      headers: {
        cookie: authenticatedCookie,
        "x-epic-expected-connection-context": connectionContext,
      },
    });
    expect(hubStatus.statusCode).toBe(200);
    expect(hubStatus.headers["x-epic-connection-context"]).toBe(connectionContext);
    expect(hubStatus.json()).toMatchObject({ available: true, enabled: false });

    const crossOriginHubEnable = await app.inject({
      method: "POST",
      url: "/api/hub/enable",
      headers: {
        cookie: authenticatedCookie,
        origin: "https://attacker.example",
        "content-type": "application/json",
        "x-epic-expected-connection-context": connectionContext,
      },
      payload: { policyVersion: config.fhirHubConsentVersion },
    });
    expect(crossOriginHubEnable.statusCode).toBe(403);

    const staleHubConsent = await app.inject({
      method: "POST",
      url: "/api/hub/enable",
      headers: {
        cookie: authenticatedCookie,
        origin: config.publicOrigin,
        "content-type": "application/json",
        "x-epic-expected-connection-context": connectionContext,
      },
      payload: { policyVersion: "old-hub-policy" },
    });
    expect(staleHubConsent.statusCode).toBe(409);
    expect(staleHubConsent.json()).toMatchObject({
      error: { code: "fhir_hub_consent_required" },
    });

    const formEncodedHubConsent = await app.inject({
      method: "POST",
      url: "/api/hub/enable",
      headers: {
        cookie: authenticatedCookie,
        origin: config.publicOrigin,
        "content-type": "application/x-www-form-urlencoded",
        "x-epic-expected-connection-context": connectionContext,
      },
      payload: `policyVersion=${encodeURIComponent(config.fhirHubConsentVersion)}`,
    });
    expect(formEncodedHubConsent.statusCode).toBe(400);
    expect(formEncodedHubConsent.json()).toMatchObject({
      error: { code: "invalid_hub_consent" },
    });

    const hubEnable = await app.inject({
      method: "POST",
      url: "/api/hub/enable",
      headers: {
        cookie: authenticatedCookie,
        origin: config.publicOrigin,
        "content-type": "application/json",
        "x-epic-expected-connection-context": connectionContext,
      },
      payload: { policyVersion: config.fhirHubConsentVersion },
    });
    expect(hubEnable.statusCode).toBe(200);
    expect(hubEnable.json()).toMatchObject({ enabled: true, consentCurrent: true });

    const patientAfterHubConsent = await app.inject({
      method: "GET",
      url: "/api/patient",
      headers: {
        cookie: authenticatedCookie,
        "x-epic-expected-connection-context": connectionContext,
      },
    });
    expect(patientAfterHubConsent.statusCode).toBe(200);

    const hubResources = await app.inject({
      method: "GET",
      url: "/api/hub/resources?resourceType=Patient&includeHistory=true&limit=10",
      headers: {
        cookie: authenticatedCookie,
        "x-epic-expected-connection-context": connectionContext,
      },
    });
    expect(hubResources.statusCode).toBe(200);
    expect(hubResources.json()).toHaveLength(1);
    expect(hubResources.json()[0]).toMatchObject({
      provenance: { resourceType: "Patient" },
      raw: { resourceType: "Patient", id: "patient-1" },
    });

    const hubIntelligence = await app.inject({
      method: "GET",
      url: "/api/hub/intelligence?resourceType=Patient&includeHistory=true&includeSuperseded=true&limit=10",
      headers: {
        cookie: authenticatedCookie,
        "x-epic-expected-connection-context": connectionContext,
      },
    });
    expect(hubIntelligence.statusCode).toBe(200);
    expect(hubIntelligence.headers["x-epic-connection-context"]).toBe(connectionContext);
    expect(hubIntelligence.json()).toMatchObject({
      schemaVersion: 1,
      projections: [{
        current: true,
        provenance: { resourceType: "Patient", resourceId: "patient-1" },
        normalization: {
          status: "normalized",
          projection: { resourceType: "Patient", resourceId: "patient-1" },
        },
      }],
      insights: [{ insightType: "patient-summary", status: "generated" }],
      hasMore: false,
    });
    expect(JSON.stringify(hubIntelligence.json())).not.toContain('"raw"');

    const invalidHubIntelligence = await app.inject({
      method: "GET",
      url: "/api/hub/intelligence?includeHistory=yes",
      headers: {
        cookie: authenticatedCookie,
        "x-epic-expected-connection-context": connectionContext,
      },
    });
    expect(invalidHubIntelligence.statusCode).toBe(400);
    expect(invalidHubIntelligence.json()).toMatchObject({
      error: { code: "invalid_hub_query" },
    });
    for (const [query, code] of [
      ["limit=1&limit=2", "invalid_hub_query"],
      ["unexpected=true", "invalid_hub_query"],
      ["limit=0", "invalid_hub_limit"],
      ["limit=251", "invalid_hub_limit"],
    ] as const) {
      const invalid = await app.inject({
        method: "GET",
        url: `/api/hub/intelligence?${query}`,
        headers: {
          cookie: authenticatedCookie,
          "x-epic-expected-connection-context": connectionContext,
        },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: { code } });
    }

    const hubExport = await app.inject({
      method: "GET",
      url: "/api/hub/export",
      headers: {
        cookie: authenticatedCookie,
        "x-epic-expected-connection-context": connectionContext,
      },
    });
    expect(hubExport.statusCode).toBe(200);
    expect(hubExport.headers["content-disposition"]).toBe(
      'attachment; filename="moonba-health-hub.json"',
    );
    expect(hubExport.json()).toMatchObject({
      schemaVersion: 1,
      intelligenceSchemaVersion: 1,
    });

    const unconfirmedHubDelete = await app.inject({
      method: "POST",
      url: "/api/hub/delete",
      headers: {
        cookie: authenticatedCookie,
        origin: config.publicOrigin,
        "content-type": "application/json",
        "x-epic-expected-connection-context": connectionContext,
      },
      payload: { confirmation: "DELETE" },
    });
    expect(unconfirmedHubDelete.statusCode).toBe(400);

    const hubDelete = await app.inject({
      method: "POST",
      url: "/api/hub/delete",
      headers: {
        cookie: authenticatedCookie,
        origin: config.publicOrigin,
        "content-type": "application/json",
        "x-epic-expected-connection-context": connectionContext,
      },
      payload: { confirmation: "DELETE MY HEALTH HUB" },
    });
    expect(hubDelete.statusCode).toBe(200);
    expect(hubDelete.json()).toMatchObject({ deleted: true, resourcesDeleted: 1 });

    const staleDisconnect = await app.inject({
      method: "POST",
      url: "/api/disconnect-all",
      headers: {
        cookie: authenticatedCookie,
        origin: config.publicOrigin,
        "x-epic-expected-connection-context": "x".repeat(43),
      },
    });
    expect(staleDisconnect.statusCode).toBe(409);
    expect(staleDisconnect.json()).toMatchObject({
      error: { code: "connection_context_changed" },
    });
    const stillConnected = await app.inject({
      method: "GET",
      url: "/api/connection",
      headers: { cookie: authenticatedCookie },
    });
    expect(stillConnected.json()).toMatchObject({ connected: true, connectionContext });

    const disconnect = await app.inject({
      method: "POST",
      url: "/api/disconnect-all",
      headers: {
        cookie: authenticatedCookie,
        origin: config.publicOrigin,
        "x-epic-expected-connection-context": connectionContext,
      },
    });
    expect(disconnect.statusCode).toBe(200);
    expect(disconnect.json()).toMatchObject({ disconnected: true, connectionsRemoved: 1 });
  });

  it("revokes an issued token when Epic returns an out-of-policy resource scope", async () => {
    const config = makeConfig();
    const { privateKey, publicKey } = await generateKeyPair("ES384");
    const publicJwk = await exportJWK(publicKey);
    let expectedNonce = "";
    const revoked: Array<{ token: string | null; hint: string | null }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/.well-known/smart-configuration")) {
        return jsonResponse({
          authorization_endpoint: "https://ehr.example.test/authorize",
          token_endpoint: "https://ehr.example.test/token",
          revocation_endpoint: "https://ehr.example.test/revoke",
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
      if (url.endsWith("/metadata")) return fhirMetadataResponse();
      if (url === "https://ehr.example.test/token") {
        const now = Math.floor(Date.now() / 1_000);
        const idToken = await new SignJWT({
          nonce: expectedNonce,
          fhirUser: `${config.fhirBaseUrl}/Patient/patient-1`,
        })
          .setProtectedHeader({ alg: "ES384", kid: "key-1" })
          .setIssuer("https://ehr.example.test/oauth2")
          .setSubject("patient-user-1")
          .setAudience(config.clientId)
          .setIssuedAt(now)
          .setExpirationTime(now + 300)
          .sign(privateKey);
        return jsonResponse({
          access_token: "orphan-access-token",
          token_type: "bearer",
          expires_in: 3600,
          scope: "openid fhirUser launch/patient patient/Appointment.r",
          patient: "patient-1",
          id_token: idToken,
        });
      }
      if (url === "https://ehr.example.test/jwks") {
        return jsonResponse({ keys: [{ ...publicJwk, alg: "ES384", kid: "key-1", use: "sig" }] });
      }
      if (url === "https://ehr.example.test/revoke") {
        const body = new URLSearchParams(init?.body?.toString());
        revoked.push({
          token: body.get("token"),
          hint: body.get("token_type_hint"),
        });
        return jsonResponse({});
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const app = await buildApp(config, { fetch: fetchMock as FetchLike });
    openApps.push(app);

    const start = await app.inject({
      method: "POST",
      url: "/auth/start",
      ...consentRequest(config),
    });
    const authorizationUrl = new URL(start.headers.location!);
    const state = authorizationUrl.searchParams.get("state")!;
    expectedNonce = authorizationUrl.searchParams.get("nonce")!;
    const cookie = start.headers["set-cookie"]!.split(";", 1)[0]!;
    const callback = await app.inject({
      method: "GET",
      url: `/auth/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });

    expect(callback.statusCode).toBe(502);
    expect(callback.body).toContain("oauth_scope_escalation");
    expect(callback.body).not.toContain("orphan-access-token");
    expect(revoked).toEqual([
      { token: "orphan-access-token", hint: "access_token" },
    ]);
    const status = await app.inject({
      method: "GET",
      url: "/api/connection",
      headers: { cookie },
    });
    expect(status.json()).toMatchObject({ connected: false });
  });

  it("requires manual cleanup after an ambiguous code-exchange transport failure", async () => {
    const config = makeConfig();
    const events: AuditEvent[] = [];
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
      if (url.endsWith("/metadata")) return fhirMetadataResponse();
      if (url === "https://ehr.example.test/token") {
        throw new Error("connection reset after authorization code was posted");
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const app = await buildApp(config, {
      fetch: fetchMock as FetchLike,
      audit: (event) => events.push(event),
    });
    openApps.push(app);

    const start = await app.inject({
      method: "POST",
      url: "/auth/start",
      ...consentRequest(config),
    });
    const authorizationUrl = new URL(start.headers.location!);
    const state = authorizationUrl.searchParams.get("state")!;
    const cookie = start.headers["set-cookie"]!.split(";", 1)[0]!;
    const callback = await app.inject({
      method: "GET",
      url: `/auth/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });

    expect(callback.statusCode).toBe(502);
    expect(callback.body).toContain("linked apps/devices");
    expect(callback.body).toContain("authorization_cleanup_required");
    expect(callback.body).toContain(callback.headers["x-request-id"]!);
    expect(callback.body).not.toContain("one-time-code");
    expect(events.find((event) => event.event === "authorization_failed")).toMatchObject({
      errorCode: "authorization_cleanup_required",
      causeCode: "upstream_unavailable",
    });
  });
});
