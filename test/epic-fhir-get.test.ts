import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_FHIR_PATH,
  buildFhirRequestUrl,
  formatResponseBody,
  requestEpicFhir,
} from "../scripts/epic-fhir-get.js";

describe("Epic direct FHIR GET script", () => {
  it("targets the CapabilityStatement by default", () => {
    expect(
      buildFhirRequestUrl("https://ehr.example.test/api/FHIR/R4", DEFAULT_FHIR_PATH)
        .toString(),
    ).toBe("https://ehr.example.test/api/FHIR/R4/metadata?_format=json");
  });

  it("preserves a resource search under the configured FHIR base", () => {
    expect(buildFhirRequestUrl(
      "https://ehr.example.test/api/FHIR/R4/",
      "Observation?patient=example&_count=5&category=laboratory",
    ).toString()).toBe(
      "https://ehr.example.test/api/FHIR/R4/Observation?patient=example&_count=5&category=laboratory",
    );
  });

  it.each([
    "../metadata",
    "%2e%2e/metadata",
    "Observation/%2e%2e/Patient",
    "https://attacker.example/metadata",
    "//attacker.example/metadata",
    "Observation\\example",
    "metadata#fragment",
    "Observation?access_token=secret",
    "Observation/id/_history/1",
    "$export",
  ])("rejects unsafe or non-read/search path %s", (requestPath) => {
    expect(() =>
      buildFhirRequestUrl(
        "https://ehr.example.test/api/FHIR/R4",
        requestPath,
      )
    ).toThrow();
  });

  it("does not send a bearer token to the metadata endpoint", async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response(JSON.stringify({ resourceType: "CapabilityStatement" }), {
        status: 200,
        headers: { "Content-Type": "application/fhir+json" },
      }));

    await requestEpicFhir({
      fhirBaseUrl: "https://ehr.example.test/api/FHIR/R4",
      clientId: "client-id",
      accessToken: "secret-access-token",
      fetchImplementation,
    });

    const init = fetchImplementation.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("Epic-Client-ID")).toBe("client-id");
    expect(headers.has("Authorization")).toBe(false);
  });

  it("requires a bearer token for protected resource calls", async () => {
    const fetchImplementation = vi.fn();
    await expect(requestEpicFhir({
      fhirBaseUrl: "https://ehr.example.test/api/FHIR/R4",
      clientId: "client-id",
      requestPath: "Patient/example",
      fetchImplementation,
    })).rejects.toThrow(/EPIC_FHIR_ACCESS_TOKEN/);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("sends the Epic client ID and bearer token without following redirects", async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response(JSON.stringify({ resourceType: "Patient", id: "example" }), {
        status: 200,
        headers: { "Content-Type": "application/fhir+json" },
      }));

    await expect(requestEpicFhir({
      fhirBaseUrl: "https://ehr.example.test/api/FHIR/R4",
      clientId: "client-id",
      accessToken: "secret-access-token",
      requestPath: "Patient/example",
      fetchImplementation,
    })).resolves.toMatchObject({
      ok: true,
      status: 200,
      contentType: "application/fhir+json",
    });

    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(url?.toString()).toBe(
      "https://ehr.example.test/api/FHIR/R4/Patient/example",
    );
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    const headers = new Headers(init?.headers);
    expect(headers.get("Epic-Client-ID")).toBe("client-id");
    expect(headers.get("Authorization")).toBe("Bearer secret-access-token");
  });

  it("rejects redirects instead of forwarding credentials", async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://attacker.example/" },
      }));

    await expect(requestEpicFhir({
      fhirBaseUrl: "https://ehr.example.test/api/FHIR/R4",
      clientId: "client-id",
      fetchImplementation,
    })).rejects.toThrow(/unexpected redirect/);
  });

  it("enforces the bounded response size", async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response("oversized", {
        status: 200,
        headers: { "Content-Length": "9" },
      }));

    await expect(requestEpicFhir({
      fhirBaseUrl: "https://ehr.example.test/api/FHIR/R4",
      clientId: "client-id",
      fetchImplementation,
      maxResponseBytes: 8,
    })).rejects.toThrow(/response limit/);
  });

  it("requires successful metadata responses to be CapabilityStatements", async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response(JSON.stringify({ resourceType: "OperationOutcome" }), {
        status: 200,
        headers: { "Content-Type": "application/fhir+json" },
      }));

    await expect(requestEpicFhir({
      fhirBaseUrl: "https://ehr.example.test/api/FHIR/R4",
      clientId: "client-id",
      fetchImplementation,
    })).rejects.toThrow(/valid JSON CapabilityStatement/);
  });

  it("pretty-prints JSON and preserves non-JSON response bodies", () => {
    expect(formatResponseBody('{"resourceType":"CapabilityStatement"}')).toBe(
      '{\n  "resourceType": "CapabilityStatement"\n}',
    );
    expect(formatResponseBody("plain text")).toBe("plain text");
  });
});
