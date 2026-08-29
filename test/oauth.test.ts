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
import { EPIC_PATIENT_RESOURCE_SCOPES } from "../src/smart-scopes.js";
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
  fhirVersion: "4.0.1",
  fhirCapabilities: [{
    resourceType: "Patient",
    interactions: ["read", "search"],
    searchParameters: ["_id"],
  }],
};

const productionConnectionFields = {
  tokenAuthMethod: "client_secret_basic" as const,
  oidcIssuer: discovery.oidc.issuer,
  oidcSubject: "patient-user-1",
  consent: {
    policyVersion: "2026-08-23",
    acceptedAt: 100,
    purpose: "patient-access" as const,
    requestedScopes: ["openid", "fhirUser", "launch/patient"],
    allowedResourceScopes: [...EPIC_PATIENT_RESOURCE_SCOPES],
  },
  fhirCapabilities: discovery.fhirCapabilities,
  lastAccessAt: 100,
};

function productionConnection(
  overrides: Partial<ConnectionRecord> = {},
): ConnectionRecord {
  return {
    ...productionConnectionFields,
    oauthClientId: "test-client-id",
    fhirBaseUrl: discovery.fhirBaseUrl,
    tokenEndpoint: discovery.smart.tokenEndpoint,
    accessToken: "access-token",
    tokenType: "Bearer",
    expiresAt: 100_000,
    scope: "patient/Patient.r",
    patientId: "patient-1",
    connectedAt: 100,
    sessionExpiresAt: 100_000,
    ...overrides,
  };
}

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
    expect(url.searchParams.get("scope")?.split(/\s+/)).toHaveLength(3);
    expect(url.search).not.toContain("patient%2F");
    expect(url.search.length).toBeLessThan(1_800);
  });

  it("fails before redirect when a custom standalone query would exceed Epic's safe bound", () => {
    const customScopes = Array.from(
      { length: 3 },
      (_, index) => `custom-${index}:${"|".repeat(220)}`,
    );
    const oauth = new EpicOAuthClient(makeConfig({
      EPIC_SCOPES: ["openid", "fhirUser", "launch/patient", ...customScopes].join(" "),
    }));

    expect(() => oauth.buildAuthorizationUrl(discovery, {
      state: "state-value",
      nonce: "nonce-value",
      codeChallenge: "challenge-value",
    })).toThrow(/too large for Epic/);
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
      issuer: discovery.oidc.issuer,
      subject: "patient-user-1",
      fhirUser: "https://ehr.example.test/api/FHIR/R4/Patient/user-1",
    });
    await expect(verifier.verify(idToken, discovery, "wrong-nonce")).rejects.toThrow(/invalid identity token/);
  });
});

describe("local OAuth session enforcement", () => {
  it("treats reordered authorization and resource scope sets as the same policy", async () => {
    const store = new InMemoryConnectionStore();
    await store.initialize();
    await store.set("session", productionConnection({
      consent: {
        ...productionConnectionFields.consent,
        requestedScopes: [...productionConnectionFields.consent.requestedScopes].reverse(),
        allowedResourceScopes: [
          ...productionConnectionFields.consent.allowedResourceScopes,
        ].reverse(),
      },
    }));
    const fetchMock = vi.fn();
    const oauth = new EpicOAuthClient(makeConfig(), fetchMock as FetchLike, () => 1_000);
    const manager = new EpicTokenManager(store, oauth, () => 1_000);

    await expect(manager.getValidConnection("session")).resolves.toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("expires an otherwise-valid connection exactly at the idle boundary", async () => {
    let now = 1_499;
    const store = new InMemoryConnectionStore();
    await store.initialize();
    await store.set("session", productionConnection({
      lastAccessAt: 1_000,
      sessionExpiresAt: 20_000,
    }));
    const fetchMock = vi.fn();
    const oauth = new EpicOAuthClient(makeConfig(), fetchMock as FetchLike, () => now);
    const manager = new EpicTokenManager(store, oauth, () => now, 500);

    await expect(manager.getConnection("session")).resolves.toBeDefined();
    now = 1_500;
    await expect(manager.getValidConnection("session")).rejects.toThrow(/session expired/);
    expect(await store.get("session")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces the absolute session lifetime even after recent activity", async () => {
    const now = 10_000;
    const store = new InMemoryConnectionStore();
    await store.initialize();
    await store.set("session", productionConnection({
      lastAccessAt: now - 1,
      sessionExpiresAt: now,
    }));
    const fetchMock = vi.fn();
    const oauth = new EpicOAuthClient(makeConfig(), fetchMock as FetchLike, () => now);
    const manager = new EpicTokenManager(store, oauth, () => now, 5_000);

    await expect(manager.getValidConnection("session")).rejects.toThrow(/maximum lifetime/);
    expect(await store.get("session")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "oidcIssuer",
    "oidcSubject",
    "tokenAuthMethod",
    "consent",
    "fhirCapabilities",
  ] as const)("fails closed when saved production metadata omits %s", async (field) => {
    const store = new InMemoryConnectionStore();
    await store.initialize();
    const record = productionConnection();
    delete (record as unknown as Record<string, unknown>)[field];
    await store.set("session", record);
    const fetchMock = vi.fn();
    const oauth = new EpicOAuthClient(makeConfig(), fetchMock as FetchLike, () => 1_000);
    const manager = new EpicTokenManager(store, oauth, () => 1_000);

    await expect(manager.getValidConnection("session")).rejects.toThrow(/identity and consent controls/);
    expect(await store.get("session")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when a saved consent receipt is for an older policy", async () => {
    const store = new InMemoryConnectionStore();
    await store.initialize();
    await store.set("session", productionConnection({
      consent: {
        ...productionConnectionFields.consent,
        policyVersion: "terms-v1",
      },
    }));
    const fetchMock = vi.fn();
    const oauth = new EpicOAuthClient(makeConfig(), fetchMock as FetchLike, () => 1_000);
    const manager = new EpicTokenManager(store, oauth, () => 1_000, 10_000, "terms-v2");

    await expect(manager.getValidConnection("session")).rejects.toThrow(/identity and consent controls/);
    expect(await store.get("session")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for a pre-split consent receipt with no resource policy snapshot", async () => {
    const store = new InMemoryConnectionStore();
    await store.initialize();
    const legacyConsent = { ...productionConnectionFields.consent };
    delete (legacyConsent as Partial<typeof legacyConsent>).allowedResourceScopes;
    await store.set("session", productionConnection({ consent: legacyConsent }));
    const fetchMock = vi.fn();
    const oauth = new EpicOAuthClient(makeConfig(), fetchMock as FetchLike, () => 1_000);
    const manager = new EpicTokenManager(store, oauth, () => 1_000);

    await expect(manager.getValidConnection("session")).rejects.toThrow(/different Epic provider/);
    expect(await store.get("session")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "authorization scopes changed",
      overrides: {
        consent: {
          ...productionConnectionFields.consent,
          requestedScopes: [
            ...productionConnectionFields.consent.requestedScopes,
            "profile",
          ],
        },
      },
    },
    {
      name: "persisted authorization scopes contain a duplicate",
      overrides: {
        consent: {
          ...productionConnectionFields.consent,
          requestedScopes: ["openid", "openid", "launch/patient"],
        },
      },
    },
    {
      name: "OIDC issuer origin is no longer trusted",
      overrides: { oidcIssuer: "https://retired-auth.example.test/oauth2" },
    },
    {
      name: "client authentication method changed",
      overrides: { tokenAuthMethod: "private_key_jwt" as const },
    },
  ])("invalidates a saved connection when $name", async ({ overrides }) => {
    const store = new InMemoryConnectionStore();
    await store.initialize();
    await store.set("session", productionConnection(overrides));
    const fetchMock = vi.fn();
    const oauth = new EpicOAuthClient(makeConfig(), fetchMock as FetchLike, () => 1_000);
    const manager = new EpicTokenManager(store, oauth, () => 1_000);

    await expect(manager.getValidConnection("session")).rejects.toThrow(/different Epic provider/);
    expect(await store.get("session")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not restore a connection when disconnect races an idle-session touch", async () => {
    const now = 1_000;
    const store = new InMemoryConnectionStore();
    await store.initialize();
    await store.set("session", productionConnection({
      lastAccessAt: 100,
      sessionExpiresAt: 100_000,
    }));
    const originalSet = store.set.bind(store);
    let markTouchStarted!: () => void;
    const touchStarted = new Promise<void>((resolve) => {
      markTouchStarted = resolve;
    });
    let releaseTouch!: () => void;
    const touchCanFinish = new Promise<void>((resolve) => {
      releaseTouch = resolve;
    });
    vi.spyOn(store, "set").mockImplementationOnce(async (sessionId, record) => {
      markTouchStarted();
      await touchCanFinish;
      await originalSet(sessionId, record);
    });
    const fetchMock = vi.fn();
    const oauth = new EpicOAuthClient(makeConfig(), fetchMock as FetchLike, () => now);
    const manager = new EpicTokenManager(store, oauth, () => now, 1_200);

    const reading = manager.getValidConnection("session");
    await touchStarted;
    await manager.disconnect("session");
    releaseTouch();

    await expect(reading).rejects.toThrow(/disconnected/);
    expect(await store.get("session")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("token refresh", () => {
  it("accepts an approved resource grant when refresh preserves the actual prior scope", async () => {
    const store = new InMemoryConnectionStore();
    await store.initialize();
    await store.set("session", productionConnection({
      accessToken: "expired",
      refreshToken: "refresh-1",
      expiresAt: 500,
      scope: "openid fhirUser launch/patient patient/Patient.r",
    }));
    const fetchMock = vi.fn(async () => jsonResponse({
      access_token: "new-access",
      token_type: "bearer",
      expires_in: 3600,
      scope: "openid fhirUser launch/patient patient/Patient.r",
    }));
    const oauth = new EpicOAuthClient(makeConfig(), fetchMock as FetchLike, () => 1_000);
    const manager = new EpicTokenManager(store, oauth, () => 1_000);

    await expect(manager.getValidConnection("session")).resolves.toMatchObject({
      accessToken: "new-access",
      scope: "openid fhirUser launch/patient patient/Patient.r",
    });
  });

  it("revokes and removes a refresh that broadens the actual prior resource grant", async () => {
    const store = new InMemoryConnectionStore();
    await store.initialize();
    const record = productionConnection({
      revocationEndpoint: "https://ehr.example.test/revoke",
      accessToken: "expired",
      refreshToken: "refresh-1",
      expiresAt: 500,
      scope: "openid fhirUser launch/patient patient/Patient.r",
    });
    await store.set("session", record);
    const revoked = new Set<string>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input.toString() === discovery.smart.tokenEndpoint) {
        return jsonResponse({
          access_token: "broadened-access",
          token_type: "bearer",
          expires_in: 3600,
          scope: "openid fhirUser launch/patient patient/Patient.r patient/Condition.r",
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
    expect(revoked).toEqual(new Set(["broadened-access", "refresh-1"]));
    expect(await store.get("session")).toBeUndefined();
  });

  it("collapses concurrent refreshes and preserves an unrotated refresh token", async () => {
    const store = new InMemoryConnectionStore();
    await store.initialize();
    const record: ConnectionRecord = {
      ...productionConnectionFields,
      oauthClientId: "test-client-id",
      fhirBaseUrl: discovery.fhirBaseUrl,
      tokenEndpoint: discovery.smart.tokenEndpoint,
      accessToken: "expired",
      refreshToken: "refresh-1",
      tokenType: "Bearer",
      expiresAt: 500,
      scope: "openid",
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
        scope: "openid",
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
      ...productionConnectionFields,
      oauthClientId: "test-client-id",
      fhirBaseUrl: discovery.fhirBaseUrl,
      tokenEndpoint: discovery.smart.tokenEndpoint,
      accessToken: "expired",
      refreshToken: "refresh-1",
      tokenType: "Bearer",
      expiresAt: 500,
      scope: "openid",
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
      ...productionConnectionFields,
      oauthClientId: "test-client-id",
      fhirBaseUrl: discovery.fhirBaseUrl,
      tokenEndpoint: discovery.smart.tokenEndpoint,
      revocationEndpoint: "https://ehr.example.test/revoke",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      tokenType: "Bearer",
      expiresAt: 500,
      scope: "openid",
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
      ...productionConnectionFields,
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
      ...productionConnectionFields,
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

  it("revokes a binding-compatible saved grant when the current scope policy is narrower", async () => {
    const config = makeConfig();
    const store = new InMemoryConnectionStore();
    await store.initialize();
    const record = productionConnection({
      revocationEndpoint: "https://ehr.example.test/revoke",
      consent: {
        ...productionConnectionFields.consent,
        allowedResourceScopes: [
          ...productionConnectionFields.consent.allowedResourceScopes,
          "patient/Appointment.r",
        ],
      },
    });
    await store.set("session", record);
    const revoked = new Set<string>();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      revoked.add(new URLSearchParams(init?.body?.toString()).get("token")!);
      return jsonResponse({});
    });
    const oauth = new EpicOAuthClient(config, fetchMock as FetchLike, () => 1_000);
    const manager = new EpicTokenManager(store, oauth, () => 1_000);

    await expect(manager.getValidConnection("session")).rejects.toThrow(/different Epic provider/);
    expect(revoked).toEqual(new Set(["access-token"]));
    expect(await store.get("session")).toBeUndefined();
  });

  it("revokes a refreshed grant when local persistence fails", async () => {
    const store = new InMemoryConnectionStore();
    await store.initialize();
    const record: ConnectionRecord = {
      ...productionConnectionFields,
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
      ...productionConnectionFields,
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
