import { describe, expect, it } from "vitest";

import {
  PendingAuthorizationStore,
  createPkceChallenge,
  createPkcePair,
  parseOAuthCallback,
} from "../src/security.js";
import type { DiscoverySnapshot, PendingAuthorization } from "../src/types.js";

const discovery: DiscoverySnapshot = {
  fhirBaseUrl: "https://ehr.example.test/fhir",
  smart: {
    authorizationEndpoint: "https://ehr.example.test/authorize",
    tokenEndpoint: "https://ehr.example.test/token",
    capabilities: ["launch-standalone"],
    codeChallengeMethods: ["S256"],
    tokenAuthMethods: ["client_secret_basic"],
  },
  oidc: {
    issuer: "https://ehr.example.test/oauth2",
    jwksUri: "https://ehr.example.test/jwks",
    idTokenAlgorithms: ["ES384"],
  },
};

function authorization(createdAt: number, sessionId = "session-a"): PendingAuthorization {
  return {
    sessionId,
    createdAt,
    codeVerifier: "v".repeat(64),
    nonce: "n".repeat(43),
    discovery,
  };
}

describe("PKCE", () => {
  it("matches the RFC 7636 S256 example", () => {
    expect(createPkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("creates a valid high-entropy verifier and S256 challenge", () => {
    const pair = createPkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(pair.challenge).toBe(createPkceChallenge(pair.verifier));
  });
});

describe("pending OAuth state", () => {
  it("is bound to a session and can only be consumed once", () => {
    const store = new PendingAuthorizationStore(10_000, () => 1_000);
    const state = "a".repeat(43);
    store.create(state, authorization(500));
    expect(() => store.consume(state, "wrong-session")).toThrow(/another browser session/);
    expect(() => store.consume(state, "session-a")).toThrow(/invalid or expired/);
  });

  it("rejects expired state", () => {
    const store = new PendingAuthorizationStore(100, () => 1_000);
    const state = "b".repeat(43);
    store.create(state, authorization(899));
    expect(() => store.consume(state, "session-a")).toThrow(/invalid or expired/);
  });
});

describe("OAuth callback parsing", () => {
  it("accepts exactly one code and state", () => {
    expect(parseOAuthCallback("/auth/callback?code=abc&state=xyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxy")).toEqual({
      kind: "success",
      code: "abc",
      state: "xyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxy",
    });
  });

  it.each([
    "/auth/callback?code=a&code=b&state=x",
    "/auth/callback?code=a&error=denied&state=x",
    "/auth/callback?code=a&state=x&state=y",
    "/auth/callback?state=x",
  ])("rejects malformed or duplicated callback parameters: %s", (url) => {
    expect(() => parseOAuthCallback(url)).toThrow(/malformed|duplicate/);
  });
});
