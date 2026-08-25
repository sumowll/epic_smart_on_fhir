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

  it("identifies Epic's insufficient-scope challenge and recommends a fresh grant", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", {
      status: 403,
      headers: {
        "content-type": "application/fhir+json",
        "www-authenticate": 'Bearer error="insufficient_scope", error_description="The access token provided is valid, but is not authorized for this service"',
      },
    }));
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);

    await expect(
      client.search(record, "Observation", new URLSearchParams()),
    ).rejects.toMatchObject({
      code: "fhir_scope_denied",
      publicMessage: expect.stringMatching(/Observation search permission.*disconnect and reconnect/),
    });
  });

  it.each([
    'Bearer error="insufficient_scope-other"',
    'Bearer error="insufficient_scope',
    'Bearer error="other", error_description="upstream said error=insufficient_scope, retry"',
  ])("does not classify a malformed or different OAuth challenge as insufficient_scope: %s", async (challenge) => {
    const fetchMock = vi.fn(async () => new Response("{}", {
      status: 403,
      headers: {
        "content-type": "application/fhir+json",
        "www-authenticate": challenge,
      },
    }));
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);

    await expect(
      client.search(record, "Observation", new URLSearchParams()),
    ).rejects.toMatchObject({ code: "fhir_access_denied" });
  });

  it("classifies an Epic OperationOutcome without exposing upstream diagnostics", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      resourceType: "OperationOutcome",
      issue: [{
        severity: "error",
        code: "forbidden",
        diagnostics: "The authenticated user is not authorized\n  to view the requested data.",
      }],
    }, 403));
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);

    try {
      await client.readPatient(record);
      expect.unreachable("Expected Epic to deny the request");
    } catch (error) {
      expect(error).toMatchObject({
        code: "fhir_access_denied",
        publicMessage: expect.stringMatching(/Patient read.*patient\/user security.*not proof/),
      });
      expect((error as Error).message).not.toContain("authenticated user is not authorized");
    }
  });

  it("does not mislabel an unexplained Epic 403 as proof of a missing scope", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 403));
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);

    await expect(
      client.search(record, "Condition", new URLSearchParams()),
    ).rejects.toMatchObject({
      code: "fhir_access_denied",
      publicMessage: expect.stringMatching(/matching R4 Incoming API.*sync.*disconnect and reconnect/),
    });
  });
});
