import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SignJWT,
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
} from "jose";
import { describe, expect, it, vi } from "vitest";

import { EpicIdTokenVerifier, EpicOAuthClient, EpicTokenManager } from "../src/oauth.js";
import { InMemoryConnectionStore } from "../src/store.js";
import type { ConnectionRecord, DiscoverySnapshot, FetchLike } from "../src/types.js";
import { jsonResponse, makeConfig } from "./helpers.js";

const discovery: DiscoverySnapshot = {
  fhirBaseUrl: "https://ehr.example.test/api/FHIR/R4",
  smart: {
    authorizationEndpoint: "https://ehr.example.test/authorize",
    tokenEndpoint: "https://ehr.example.test/token",
    capabilities: ["launch-standalone"],
    codeChallengeMethods: ["S256"],
    tokenAuthMethods: ["client_secret_basic", "private_key_jwt"],
  },
  oidc: {
    issuer: "https://ehr.example.test/oauth2",
    jwksUri: "https://ehr.example.test/jwks",
    idTokenAlgorithms: ["ES384"],
  },
};

describe("Epic OAuth client", () => {
  it("builds a standalone authorization request with aud, nonce, state, and PKCE", () => {
    const oauth = new EpicOAuthClient(makeConfig());
    const url = new URL(
      oauth.buildAuthorizationUrl(discovery, {
        state: "state-value",
        nonce: "nonce-value",
        codeChallenge: "challenge-value",
      }),
    );
    expect(url.origin + url.pathname).toBe(discovery.smart.authorizationEndpoint);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "test-client-id",
      redirect_uri: "http://localhost:3000/auth/callback",
      scope: "openid fhirUser launch/patient",
      aud: discovery.fhirBaseUrl,
      state: "state-value",
      nonce: "nonce-value",
      code_challenge: "challenge-value",
      code_challenge_method: "S256",
    });
  });

  it("uses Epic's documented URL-encoded client_secret_basic credentials", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const expected = Buffer.from("test-client-id:secret%2Fvalue").toString("base64");
      expect(headers.get("authorization")).toBe(`Basic ${expected}`);
      const body = new URLSearchParams(init?.body?.toString());
      expect(body.get("client_id")).toBeNull();
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code_verifier")).toBe("verifier");
      return jsonResponse({
        access_token: "access",
        token_type: "bearer",
        expires_in: 3600,
        patient: "patient-1",
      });
    });
    const oauth = new EpicOAuthClient(makeConfig(), fetchMock as FetchLike);
    await expect(oauth.exchangeCode(discovery.smart.tokenEndpoint, "code", "verifier")).resolves.toMatchObject({
      access_token: "access",
      patient: "patient-1",
    });
  });

  it("revokes token fragments from a malformed successful exchange response", async () => {
    const revoked: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input.toString() === discovery.smart.tokenEndpoint) {
        return jsonResponse({
          access_token: "malformed-access",
          refresh_token: "malformed-refresh",
          token_type: "bearer",
          expires_in: 0,
        });
      }
      if (input.toString() === "https://ehr.example.test/revoke") {
        revoked.push(new URLSearchParams(init?.body?.toString()).get("token")!);
        return jsonResponse({});
      }
      throw new Error(`Unexpected fetch: ${input.toString()}`);
    });
    const oauth = new EpicOAuthClient(makeConfig(), fetchMock as FetchLike);

    await expect(oauth.exchangeCode(
      discovery.smart.tokenEndpoint,
      "code",
      "verifier",
      "https://ehr.example.test/revoke",
    )).rejects.toMatchObject({ code: "invalid_token_response_cleaned" });
    expect(new Set(revoked)).toEqual(new Set(["malformed-access", "malformed-refresh"]));
  });

  it("requires manual cleanup when a malformed token response cannot be revoked", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      access_token: "possibly-active-access",
      token_type: "bearer",
      expires_in: 0,
    }));
    const oauth = new EpicOAuthClient(makeConfig(), fetchMock as FetchLike);

    await expect(oauth.exchangeCode(
      discovery.smart.tokenEndpoint,
      "code",
      "verifier",
    )).rejects.toMatchObject({ code: "authorization_cleanup_required" });
  });

  it("creates an ES384 private_key_jwt assertion for the exact token audience", async () => {
    const directory = await mkdtemp(join(tmpdir(), "epic-oauth-key-"));
    const keyPath = join(directory, "private.pem");
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-384" });
    await writeFile(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(init?.body?.toString());
      const assertion = body.get("client_assertion");
      expect(assertion).toBeTruthy();
      expect(body.get("client_assertion_type")).toBe(
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      );
      expect(decodeProtectedHeader(assertion!).alg).toBe("ES384");
      expect(decodeProtectedHeader(assertion!).kid).toBe("test-key");
      expect(decodeJwt(assertion!)).toMatchObject({
        iss: "test-client-id",
        sub: "test-client-id",
        aud: discovery.smart.tokenEndpoint,
      });
      return jsonResponse({
        access_token: "access",
        token_type: "Bearer",
        expires_in: 3600,
        patient: "patient-1",
      });
    });
    const config = makeConfig({
      EPIC_TOKEN_AUTH_METHOD: "private_key_jwt",
      EPIC_CLIENT_SECRET: undefined,
      EPIC_PRIVATE_KEY_PATH: keyPath,
      EPIC_PRIVATE_KEY_ALG: "ES384",
      EPIC_PRIVATE_KEY_KID: "test-key",
    });
    const oauth = new EpicOAuthClient(config, fetchMock as FetchLike);
    await oauth.exchangeCode(discovery.smart.tokenEndpoint, "code", "verifier");
  });
});

describe("ID token verification", () => {
  it("verifies signature, issuer, audience, nonce, and returns fhirUser", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES384");
    const publicJwk = await exportJWK(publicKey);
    const now = Math.floor(Date.now() / 1_000);
    const idToken = await new SignJWT({
      nonce: "expected-nonce",
      fhirUser: "https://ehr.example.test/api/FHIR/R4/Patient/user-1",
      })
      .setProtectedHeader({ alg: "ES384", kid: "key-1" })
      .setIssuer(discovery.oidc.issuer)
      .setSubject("patient-user-1")
      .setAudience("test-client-id")
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);
    const fetchMock = vi.fn(async () =>
      jsonResponse({ keys: [{ ...publicJwk, alg: "ES384", kid: "key-1", use: "sig" }] }),
    );
    const verifier = new EpicIdTokenVerifier(makeConfig(), fetchMock as FetchLike);
    await expect(verifier.verify(idToken, discovery, "expected-nonce")).resolves.toEqual({
      fhirUser: "https://ehr.example.test/api/FHIR/R4/Patient/user-1",
    });
    await expect(verifier.verify(idToken, discovery, "wrong-nonce")).rejects.toThrow(/invalid identity token/);
  });
});

describe("token refresh", () => {
  it("collapses concurrent refreshes and preserves an unrotated refresh token", async () => {
    const store = new InMemoryConnectionStore();
    await store.initialize();
    const record: ConnectionRecord = {
      oauthClientId: "test-client-id",
      fhirBaseUrl: discovery.fhirBaseUrl,
      tokenEndpoint: discovery.smart.tokenEndpoint,
      accessToken: "expired",
      refreshToken: "refresh-1",
      tokenType: "Bearer",
      expiresAt: 500,
      scope: "old-scope",
      patientId: "patient-1",
      connectedAt: 100,
      sessionExpiresAt: 10_000,
    };
    await store.set("session", record);
    let requests = 0;
    const fetchMock = vi.fn(async () => {
      requests += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return jsonResponse({
        access_token: "new-access",
        token_type: "bearer",
        expires_in: 3600,
        scope: "new-scope",
      });
    });
    const oauth = new EpicOAuthClient(makeConfig(), fetchMock as FetchLike, () => 1_000);
    const manager = new EpicTokenManager(store, oauth, () => 1_000);
    const [first, second] = await Promise.all([
      manager.getValidConnection("session"),
      manager.getValidConnection("session"),
    ]);
    expect(requests).toBe(1);
    expect(first.accessToken).toBe("new-access");
    expect(second.refreshToken).toBe("refresh-1");
  });

  it("does not restore tokens when disconnect races an in-flight refresh", async () => {
    const store = new InMemoryConnectionStore();
    await store.initialize();
    const record: ConnectionRecord = {
      oauthClientId: "test-client-id",
      fhirBaseUrl: discovery.fhirBaseUrl,
      tokenEndpoint: discovery.smart.tokenEndpoint,
      accessToken: "expired",
      refreshToken: "refresh-1",
      tokenType: "Bearer",
      expiresAt: 500,
      scope: "old-scope",
      patientId: "patient-1",
      connectedAt: 100,
      sessionExpiresAt: 10_000,
    };
    await store.set("session", record);
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async () => response);
    const oauth = new EpicOAuthClient(makeConfig(), fetchMock as FetchLike, () => 1_000);
    const manager = new EpicTokenManager(store, oauth, () => 1_000);

    const refreshing = manager.getValidConnection("session");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await manager.invalidate("session");
    release(jsonResponse({ access_token: "new-access", token_type: "bearer", expires_in: 3600 }));

    await expect(refreshing).rejects.toThrow(/disconnected/);
    expect(await store.get("session")).toBeUndefined();
  });

  it("revokes both old and rotated tokens when disconnect races refresh", async () => {
    const store = new InMemoryConnectionStore();
    await store.initialize();
    const record: ConnectionRecord = {
      oauthClientId: "test-client-id",
      fhirBaseUrl: discovery.fhirBaseUrl,
      tokenEndpoint: discovery.smart.tokenEndpoint,
      revocationEndpoint: "https://ehr.example.test/revoke",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      tokenType: "Bearer",
      expiresAt: 500,
      scope: "old-scope",
      patientId: "patient-1",
      connectedAt: 100,
      sessionExpiresAt: 10_000,
    };
    await store.set("session", record);
    let releaseRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      releaseRefresh = resolve;
    });
    const revoked = new Set<string>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input.toString() === discovery.smart.tokenEndpoint) return refreshResponse;
      if (input.toString() === record.revocationEndpoint) {
        revoked.add(new URLSearchParams(init?.body?.toString()).get("token")!);
        return jsonResponse({});
      }
      throw new Error(`Unexpected fetch: ${input.toString()}`);
    });
    const oauth = new EpicOAuthClient(makeConfig(), fetchMock as FetchLike, () => 1_000);
    const manager = new EpicTokenManager(store, oauth, () => 1_000);

    const refreshing = manager.getValidConnection("session");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const disconnecting = manager.disconnect("session");
    releaseRefresh(jsonResponse({
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      token_type: "bearer",
      expires_in: 3600,
    }));

    await expect(refreshing).rejects.toThrow(/disconnected/);
    await expect(disconnecting).resolves.toEqual({
      hadConnection: true,
      remoteRevocation: "success",
    });
    expect(revoked).toEqual(new Set([
      "old-access",
      "old-refresh",
      "rotated-access",
      "rotated-refresh",
    ]));
    expect(await store.get("session")).toBeUndefined();
  });

  it("deletes the saved refresh token after an ambiguous refresh failure", async () => {
    const store = new InMemoryConnectionStore();
    await store.initialize();
    const record: ConnectionRecord = {
      oauthClientId: "test-client-id",
      fhirBaseUrl: discovery.fhirBaseUrl,
      tokenEndpoint: discovery.smart.tokenEndpoint,
      accessToken: "expired",
      refreshToken: "refresh-1",
      tokenType: "Bearer",
      expiresAt: 500,
      scope: "scope",
      patientId: "patient-1",
      connectedAt: 100,
      sessionExpiresAt: 10_000,
    };
    await store.set("session", record);
    const fetchMock = vi.fn(async () => {
      throw new Error("connection reset after POST");
    });
    const oauth = new EpicOAuthClient(makeConfig(), fetchMock as FetchLike, () => 1_000);
    const manager = new EpicTokenManager(store, oauth, () => 1_000);

    await expect(manager.getValidConnection("session")).rejects.toThrow(/did not complete safely/);
    expect(await store.get("session")).toBeUndefined();
  });

  it("never sends current client credentials to a saved grant from another configuration", async () => {
    const store = new InMemoryConnectionStore();
    await store.initialize();
    const mismatched: ConnectionRecord = {
      oauthClientId: "old-client-id",
      fhirBaseUrl: "https://old-ehr.example.test/api/FHIR/R4",
      tokenEndpoint: "https://old-ehr.example.test/token",
      revocationEndpoint: "https://old-ehr.example.test/revoke",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      tokenType: "Bearer",
      expiresAt: 500,
      scope: "scope",
      patientId: "patient-1",
      connectedAt: 100,
      sessionExpiresAt: 10_000,
    };
    await store.set("session", mismatched);
    const fetchMock = vi.fn();
    const oauth = new EpicOAuthClient(makeConfig(), fetchMock as FetchLike, () => 1_000);
    const manager = new EpicTokenManager(store, oauth, () => 1_000);

    await expect(manager.getValidConnection("session")).rejects.toThrow(/different Epic provider/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await store.get("session")).toBeUndefined();
  });

  it("revokes a refreshed grant when local persistence fails", async () => {
    const store = new InMemoryConnectionStore();
    await store.initialize();
    const record: ConnectionRecord = {
      oauthClientId: "test-client-id",
      fhirBaseUrl: discovery.fhirBaseUrl,
      tokenEndpoint: discovery.smart.tokenEndpoint,
      revocationEndpoint: "https://ehr.example.test/revoke",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      tokenType: "Bearer",
      expiresAt: 500,
      scope: "scope",
      patientId: "patient-1",
      connectedAt: 100,
      sessionExpiresAt: 10_000,
    };
    await store.set("session", record);
    vi.spyOn(store, "set").mockRejectedValueOnce(new Error("disk write failed"));
    const revoked = new Set<string>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input.toString() === discovery.smart.tokenEndpoint) {
        return jsonResponse({
          access_token: "new-access",
          refresh_token: "new-refresh",
          token_type: "bearer",
          expires_in: 3600,
        });
      }
      if (input.toString() === record.revocationEndpoint) {
        revoked.add(new URLSearchParams(init?.body?.toString()).get("token")!);
        return jsonResponse({});
      }
      throw new Error(`Unexpected fetch: ${input.toString()}`);
    });
    const oauth = new EpicOAuthClient(makeConfig(), fetchMock as FetchLike, () => 1_000);
    const manager = new EpicTokenManager(store, oauth, () => 1_000);

    await expect(manager.getValidConnection("session")).rejects.toThrow(/connect again/);
    expect(revoked).toEqual(new Set(["new-access", "new-refresh"]));
    expect(await store.get("session")).toBeUndefined();
  });
});

describe("token revocation", () => {
  it("attempts both refresh-token and access-token revocation", async () => {
    const hints: string[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(init?.body?.toString());
      hints.push(body.get("token_type_hint")!);
      return jsonResponse({});
    });
    const oauth = new EpicOAuthClient(makeConfig(), fetchMock as FetchLike);
    const record: ConnectionRecord = {
      oauthClientId: "test-client-id",
      fhirBaseUrl: discovery.fhirBaseUrl,
      tokenEndpoint: discovery.smart.tokenEndpoint,
      revocationEndpoint: "https://ehr.example.test/revoke",
      accessToken: "access",
      refreshToken: "refresh",
      tokenType: "Bearer",
      expiresAt: 5_000,
      scope: "scope",
      patientId: "patient-1",
      connectedAt: 100,
      sessionExpiresAt: 10_000,
    };
    await oauth.revoke(record.revocationEndpoint!, record);
    expect(hints).toEqual(["refresh_token", "access_token"]);
  });
});
