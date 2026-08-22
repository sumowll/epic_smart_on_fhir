import { describe, expect, it, vi } from "vitest";

import { EpicDiscoveryService } from "../src/discovery.js";
import type { FetchLike } from "../src/types.js";
import { jsonResponse, makeConfig } from "./helpers.js";

function discoveryFetch(capabilities: string[]): FetchLike {
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
      });
    }
    return jsonResponse({
      issuer: "https://ehr.example.test/oauth2",
      jwks_uri: "https://ehr.example.test/oauth2/jwks",
      id_token_signing_alg_values_supported: ["RS256"],
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
      discoveryFetch(["launch-standalone", "client-public"]),
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
      discoveryFetch(["launch-standalone"]),
    );
    await expect(service.discover()).rejects.toThrow(/does not support none/);
  });
});
