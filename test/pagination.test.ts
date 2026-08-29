import { describe, expect, it } from "vitest";

import { decodePageCursor, encodePageCursor } from "../src/pagination.js";

const sessionId = "s".repeat(43);
const secret = "production-test-secret".repeat(3);

describe("FHIR pagination cursor", () => {
  it("encrypts, authenticates, and restores a bounded cursor", () => {
    const token = encodePageCursor({
      resourceType: "Observation",
      nextUrl: "https://ehr.example.test/api/FHIR/R4/Observation?_getpages=opaque",
      page: 2,
      expiresAt: 20_000,
    }, sessionId, secret);

    expect(token).not.toContain("Observation");
    expect(token).not.toContain("_getpages");
    expect(decodePageCursor(token, sessionId, secret, 10_000)).toEqual({
      resourceType: "Observation",
      nextUrl: "https://ehr.example.test/api/FHIR/R4/Observation?_getpages=opaque",
      page: 2,
      expiresAt: 20_000,
    });
  });

  it("seals Provenance inclusion state while keeping older cursors compatible", () => {
    const token = encodePageCursor({
      resourceType: "Observation",
      nextUrl: "https://ehr.example.test/api/FHIR/R4/Observation?_getpages=opaque",
      page: 2,
      expiresAt: 20_000,
      includeProvenance: true,
    }, sessionId, secret);

    expect(decodePageCursor(token, sessionId, secret, 10_000)).toMatchObject({
      resourceType: "Observation",
      page: 2,
      includeProvenance: true,
    });
  });

  it("rejects use from another browser session", () => {
    const token = encodePageCursor({
      resourceType: "Condition",
      nextUrl: "https://ehr.example.test/api/FHIR/R4/Condition?page=2",
      page: 2,
      expiresAt: 20_000,
    }, sessionId, secret);

    expect(() => decodePageCursor(token, "x".repeat(43), secret, 10_000)).toThrow(/invalid or expired/);
  });

  it("rejects use with another deployment secret", () => {
    const token = encodePageCursor({
      resourceType: "Condition",
      nextUrl: "https://ehr.example.test/api/FHIR/R4/Condition?page=2",
      page: 2,
      expiresAt: 20_000,
    }, sessionId, secret);

    expect(() => decodePageCursor(
      token,
      sessionId,
      "another-production-secret".repeat(3),
      10_000,
    )).toThrow(/invalid or expired/);
  });

  it("rejects tampering and expiration", () => {
    const token = encodePageCursor({
      resourceType: "Condition",
      nextUrl: "https://ehr.example.test/api/FHIR/R4/Condition?page=2",
      page: 2,
      expiresAt: 20_000,
    }, sessionId, secret);

    const replacement = token.endsWith("A") ? "B" : "A";
    expect(() => decodePageCursor(`${token.slice(0, -1)}${replacement}`, sessionId, secret, 10_000)).toThrow(/invalid or expired/);
    expect(() => decodePageCursor(token, sessionId, secret, 20_000)).toThrow(/invalid or expired/);
  });

  it.each([
    {
      resourceType: "observation",
      nextUrl: "https://ehr.example.test/api/FHIR/R4/Observation?page=2",
      page: 2,
      expiresAt: 20_000,
    },
    {
      resourceType: "Observation",
      nextUrl: "not-a-url",
      page: 2,
      expiresAt: 20_000,
    },
    {
      resourceType: "Observation",
      nextUrl: "https://ehr.example.test/api/FHIR/R4/Observation?page=2",
      page: 1,
      expiresAt: 20_000,
    },
    {
      resourceType: "Observation",
      nextUrl: "https://ehr.example.test/api/FHIR/R4/Observation?page=11",
      page: 11,
      expiresAt: 20_000,
    },
    {
      resourceType: "Observation",
      nextUrl: "https://ehr.example.test/api/FHIR/R4/Observation?page=2",
      page: 2,
      expiresAt: 0,
    },
  ])("rejects an invalid cursor payload before encrypting it", (cursor) => {
    expect(() => encodePageCursor(cursor, sessionId, secret)).toThrow();
  });

  it("rejects malformed and oversized cursor envelopes before decryption", () => {
    expect(() => decodePageCursor("not+base64url", sessionId, secret, 10_000)).toThrow(/invalid or expired/);
    expect(() => decodePageCursor("A".repeat(16_385), sessionId, secret, 10_000)).toThrow(/invalid or expired/);
  });
});
