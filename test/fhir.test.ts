import { describe, expect, it, vi } from "vitest";

import { EpicFhirClient, sanitizeSearchParameters } from "../src/fhir.js";
import type { ConnectionRecord, FetchLike } from "../src/types.js";
import { jsonResponse, makeConfig } from "./helpers.js";

const record: ConnectionRecord = {
  oauthClientId: "test-client-id",
  fhirBaseUrl: "https://ehr.example.test/api/FHIR/R4",
  tokenEndpoint: "https://ehr.example.test/token",
  accessToken: "access-token",
  tokenType: "Bearer",
  expiresAt: Date.now() + 60_000,
  scope: "patient/Observation.read",
  patientId: "patient-1",
  connectedAt: Date.now(),
  sessionExpiresAt: Date.now() + 60_000,
};

describe("FHIR parameter controls", () => {
  it("allows bounded read-only filters and defaults _count", () => {
    expect(sanitizeSearchParameters(new URLSearchParams("category=laboratory"))).toEqual(
      new URLSearchParams("category=laboratory&_count=50"),
    );
  });

  it("rejects patient overrides, unknown filters, and oversized pages", () => {
    expect(() => sanitizeSearchParameters(new URLSearchParams("patient=someone-else"))).toThrow(/not allowed/);
    expect(() => sanitizeSearchParameters(new URLSearchParams("_include=Observation:subject"))).toThrow(/not allowed/);
    expect(() => sanitizeSearchParameters(new URLSearchParams("_count=101"))).toThrow(/between 1 and 100/);
  });
});

describe("FHIR client", () => {
  it("injects the authorized patient and keeps the bearer token server-side", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      expect(url.origin + url.pathname).toBe("https://ehr.example.test/api/FHIR/R4/Observation");
      expect(url.searchParams.get("patient")).toBe("patient-1");
      expect(url.searchParams.get("_count")).toBe("20");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token");
      return jsonResponse({ resourceType: "Bundle", entry: [] });
    });
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);
    await expect(client.search(record, "Observation", new URLSearchParams("_count=20"))).resolves.toEqual({
      resourceType: "Bundle",
      entry: [],
    });
  });

  it("rejects resource types outside the configured allowlist before making a request", async () => {
    const fetchMock = vi.fn();
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);
    await expect(client.search(record, "Binary", new URLSearchParams())).rejects.toThrow(/not enabled/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
