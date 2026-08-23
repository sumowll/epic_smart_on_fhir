import { afterEach, describe, expect, it, vi } from "vitest";

import { EpicConnectorService } from "../src/connector.js";
import { InMemoryConnectionStore } from "../src/store.js";
import type { FetchLike } from "../src/types.js";
import { WorkerHttpApplication } from "../src/worker-app.js";
import { jsonResponse, makeConfig } from "./helpers.js";

const openServices: EpicConnectorService[] = [];

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
  it("serves health and connection routes with browser hardening headers", async () => {
    const app = await makeWorkerApplication();

    const health = await app.fetch(new Request("https://connector.example.test/healthz"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(health.headers.get("content-security-policy")).toContain("default-src 'none'");
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
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const app = await makeWorkerApplication(fetchMock as FetchLike);
    const routedSessionId = "r".repeat(43);

    const start = await app.fetch(new Request(
      "https://connector.example.test/auth/start",
      { method: "POST", headers: { Origin: "https://connector.example.test" } },
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
