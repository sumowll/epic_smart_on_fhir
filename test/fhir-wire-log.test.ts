import { describe, expect, it, vi } from "vitest";

import {
  FHIR_WIRE_LOG_BODY_MAX_BYTES,
  FHIR_WIRE_LOG_ENTRY_MAX_BYTES,
  emitFhirWireLogExchange,
  productionFhirWireLogSink,
  type FhirWireLogExchange,
} from "../src/fhir-wire-log.js";

const successfulExchange: FhirWireLogExchange = {
  requestId: "request-1",
  resourceType: "Practitioner",
  interaction: "search",
  method: "GET",
  url: "https://ehr.example.test/api/FHIR/R4/Practitioner?_count=20",
  outcome: "success",
  durationMs: 12.5,
  response: {
    status: 200,
    statusText: "OK",
    contentType: "application/fhir+json",
    body: '{"resourceType":"Bundle","type":"searchset"}',
  },
};

function parsedLines(lines: readonly string[]): Array<Record<string, unknown>> {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("FHIR wire logging", () => {
  it("keeps logging off unless the configured mode permits the exchange", async () => {
    const lines: string[] = [];
    const sink = (line: string): void => {
      lines.push(line);
    };

    await emitFhirWireLogExchange("off", sink, successfulExchange);
    await emitFhirWireLogExchange("errors", sink, successfulExchange);
    expect(lines).toEqual([]);

    await emitFhirWireLogExchange("all", sink, successfulExchange);
    expect(lines).toHaveLength(2);
  });

  it("emits paired sensitive single-line JSON entries with one exchange ID", async () => {
    const lines: string[] = [];
    await emitFhirWireLogExchange("all", (line) => lines.push(line), successfulExchange);

    expect(lines).toHaveLength(2);
    expect(lines.every((line) => !line.includes("\n") && !line.includes("\r"))).toBe(true);
    const [request, response] = parsedLines(lines).map((entry) =>
      entry.fhirWire as Record<string, unknown>);
    expect(request).toMatchObject({
      event: "fhir_wire",
      sensitive: true,
      dataClassification: "fhir-patient-data",
      direction: "request",
      method: "GET",
      url: successfulExchange.url,
      requestId: "request-1",
      resourceType: "Practitioner",
      interaction: "search",
      outcome: "success",
      durationMs: 12.5,
    });
    expect(response).toMatchObject({
      event: "fhir_wire",
      sensitive: true,
      direction: "response",
      status: 200,
      statusText: "OK",
      contentType: "application/fhir+json",
      body: successfulExchange.response?.body,
      bodyTruncated: false,
    });
    expect(request?.exchangeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response?.exchangeId).toBe(request?.exchangeId);
  });

  it("logs error exchanges in errors mode without accepting bearer headers", async () => {
    const lines: string[] = [];
    const input = {
      ...successfulExchange,
      outcome: "error" as const,
      errorCode: "fhir_request_rejected",
      response: {
        status: 400,
        body: '{"resourceType":"OperationOutcome","issue":[{"diagnostics":"bad query"}]}',
      },
      requestHeaders: {
        Authorization: "Bearer token-that-must-never-be-logged",
      },
    };

    await emitFhirWireLogExchange("errors", (line) => lines.push(line), input);

    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("token-that-must-never-be-logged");
    expect(lines.join("\n")).not.toContain("Authorization");
    expect(lines.join("\n")).toContain("fhir_request_rejected");
    expect(lines.join("\n")).toContain("OperationOutcome");
  });

  it("caps response bodies by UTF-8 bytes and reports truncation", async () => {
    const body = `${"x".repeat(FHIR_WIRE_LOG_BODY_MAX_BYTES - 1)}💊tail`;
    const lines: string[] = [];

    await emitFhirWireLogExchange("all", (line) => lines.push(line), {
      ...successfulExchange,
      response: { status: 200, body },
    });

    const response = parsedLines(lines)[1]?.fhirWire as Record<string, unknown>;
    expect(response.bodyTruncated).toBe(true);
    expect(response.bodyByteLength).toBe(new TextEncoder().encode(body).byteLength);
    expect(response.bodyLoggedByteLength).toBeLessThanOrEqual(FHIR_WIRE_LOG_BODY_MAX_BYTES);
    expect(typeof response.body).toBe("string");
    expect(body.startsWith(response.body as string)).toBe(true);
    expect(response.body).not.toContain("�");
  });

  it("keeps worst-case escaped bodies and upstream metadata within one log entry", async () => {
    const lines: string[] = [];
    await emitFhirWireLogExchange("all", (line) => lines.push(line), {
      ...successfulExchange,
      response: {
        status: 400,
        statusText: "s".repeat(1_000),
        contentType: "c".repeat(1_000),
        body: "\0".repeat(FHIR_WIRE_LOG_BODY_MAX_BYTES),
      },
    });

    expect(lines).toHaveLength(2);
    expect(new TextEncoder().encode(lines[1]!).byteLength)
      .toBeLessThanOrEqual(FHIR_WIRE_LOG_ENTRY_MAX_BYTES);
    const response = parsedLines(lines)[1]?.fhirWire as Record<string, unknown>;
    expect(response.statusText).toBe("s".repeat(256));
    expect(response.statusTextTruncated).toBe(true);
    expect(response.contentType).toBe("c".repeat(256));
    expect(response.contentTypeTruncated).toBe(true);
    expect(response.bodyTruncated).toBe(false);
  });

  it("swallows each sink failure and honors an explicit exchange ID", async () => {
    const sink = vi.fn(() => {
      throw new Error("log transport unavailable");
    });

    await expect(emitFhirWireLogExchange("all", sink, {
      ...successfulExchange,
      exchangeId: "exchange-1",
    })).resolves.toBeUndefined();
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[0]?.[0]).toContain('"exchangeId":"exchange-1"');
    expect(sink.mock.calls[1]?.[0]).toContain('"exchangeId":"exchange-1"');
  });

  it("writes production entries without reformatting them", () => {
    const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    productionFhirWireLogSink('{"fhirWire":{"sensitive":true}}');
    expect(consoleSpy).toHaveBeenCalledWith('{"fhirWire":{"sensitive":true}}');
    consoleSpy.mockRestore();
  });
});
