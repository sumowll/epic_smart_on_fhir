import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { FetchLike } from "../src/types.js";
import { jsonResponse, makeConfig } from "./helpers.js";

const openApps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

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
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
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

  it("completes a standalone flow, rejects callback replay, and reads the connected patient", async () => {
    const config = makeConfig();
    const { privateKey, publicKey } = await generateKeyPair("ES384");
    const publicJwk = await exportJWK(publicKey);
    let expectedNonce = "";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/.well-known/smart-configuration")) {
        return jsonResponse({
          authorization_endpoint: "https://ehr.example.test/authorize",
          token_endpoint: "https://ehr.example.test/token",
          capabilities: ["launch-standalone"],
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
          scope: "patient/Patient.read",
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
    const app = await buildApp(config, { fetch: fetchMock as FetchLike });
    openApps.push(app);

    const start = await app.inject({
      method: "POST",
      url: "/auth/start",
      headers: { origin: config.publicOrigin },
    });
    expect(start.statusCode).toBe(303);
    const authorizationUrl = new URL(start.headers.location!);
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
    expect(status.json()).toMatchObject({ connected: true, patientId: "patient-1" });

    const patient = await app.inject({ method: "GET", url: "/api/patient", headers: { cookie: authenticatedCookie } });
    expect(patient.statusCode).toBe(200);
    expect(patient.json()).toEqual({ resourceType: "Patient", id: "patient-1" });
  });

  it("revokes issued tokens when post-exchange validation fails", async () => {
    const config = makeConfig();
    const revoked: Array<{ token: string | null; hint: string | null }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/.well-known/smart-configuration")) {
        return jsonResponse({
          authorization_endpoint: "https://ehr.example.test/authorize",
          token_endpoint: "https://ehr.example.test/token",
          revocation_endpoint: "https://ehr.example.test/revoke",
          capabilities: ["launch-standalone"],
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
      if (url === "https://ehr.example.test/token") {
        return jsonResponse({
          access_token: "orphan-access-token",
          refresh_token: "orphan-refresh-token",
          token_type: "bearer",
          expires_in: 3600,
        });
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
      headers: { origin: config.publicOrigin },
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
    expect(callback.body).not.toContain("orphan-access-token");
    expect(callback.body).not.toContain("orphan-refresh-token");
    expect(revoked).toEqual([
      { token: "orphan-refresh-token", hint: "refresh_token" },
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/.well-known/smart-configuration")) {
        return jsonResponse({
          authorization_endpoint: "https://ehr.example.test/authorize",
          token_endpoint: "https://ehr.example.test/token",
          capabilities: ["launch-standalone"],
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
      if (url === "https://ehr.example.test/token") {
        throw new Error("connection reset after authorization code was posted");
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const app = await buildApp(config, { fetch: fetchMock as FetchLike });
    openApps.push(app);

    const start = await app.inject({
      method: "POST",
      url: "/auth/start",
      headers: { origin: config.publicOrigin },
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
    expect(callback.body).not.toContain("one-time-code");
  });
});
