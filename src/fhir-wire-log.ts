import { randomUUID } from "node:crypto";

import type { FhirWireLoggingMode } from "./types.js";

/**
 * FHIR wire logs can contain patient identifiers and health information. Keep
 * them disabled unless an operator has explicitly selected a diagnostic mode.
 */
export type FhirWireLogMode = FhirWireLoggingMode;

export type FhirWireLogSink = (line: string) => void | Promise<void>;

/**
 * Maximum UTF-8 bytes from a FHIR response body placed in one log entry.
 *
 * JSON escaping can expand a byte into a six-character escape sequence. The
 * conservative 32 KiB raw cap therefore also leaves room for structured
 * metadata under Workers' per-log-entry limit.
 */
export const FHIR_WIRE_LOG_BODY_MAX_BYTES = 32 * 1024;

/** Leave headroom below Workers' 256 KiB limit for console log arguments. */
export const FHIR_WIRE_LOG_ENTRY_MAX_BYTES = 240 * 1024;

const FHIR_WIRE_LOG_METADATA_MAX_CHARACTERS = 256;

export interface FhirWireLogExchange {
  readonly exchangeId?: string;
  readonly requestId?: string;
  readonly resourceType: string;
  readonly interaction: "read" | "search";
  readonly method: "GET";
  readonly url: string;
  readonly outcome: "success" | "error";
  readonly durationMs?: number;
  readonly response?: {
    readonly status: number;
    readonly statusText?: string;
    readonly contentType?: string;
    /** Exact decoded response text before JSON parsing. */
    readonly body: string;
  };
  readonly errorCode?: string;
}

interface TruncatedFhirBody {
  readonly text: string;
  readonly byteLength: number;
  readonly loggedByteLength: number;
  readonly truncated: boolean;
}

interface BoundedMetadata {
  readonly text: string;
  readonly truncated: boolean;
}

function boundMetadata(value: string): BoundedMetadata {
  if (value.length <= FHIR_WIRE_LOG_METADATA_MAX_CHARACTERS) {
    return { text: value, truncated: false };
  }
  return {
    text: value.slice(0, FHIR_WIRE_LOG_METADATA_MAX_CHARACTERS),
    truncated: true,
  };
}

function truncateFhirBody(body: string): TruncatedFhirBody {
  const bytes = new TextEncoder().encode(body);
  if (bytes.byteLength <= FHIR_WIRE_LOG_BODY_MAX_BYTES) {
    return {
      text: body,
      byteLength: bytes.byteLength,
      loggedByteLength: bytes.byteLength,
      truncated: false,
    };
  }

  // Streaming decode deliberately leaves an incomplete final UTF-8 sequence
  // buffered, so the log contains an exact text prefix without a replacement
  // character caused solely by truncation.
  const text = new TextDecoder().decode(
    bytes.subarray(0, FHIR_WIRE_LOG_BODY_MAX_BYTES),
    { stream: true },
  );
  return {
    text,
    byteLength: bytes.byteLength,
    loggedByteLength: new TextEncoder().encode(text).byteLength,
    truncated: true,
  };
}

async function emitLine(sink: FhirWireLogSink, value: unknown): Promise<void> {
  try {
    // JSON escaping keeps response newlines and other attacker-controlled text
    // inside one structured log entry.
    const line = JSON.stringify(value);
    if (new TextEncoder().encode(line).byteLength > FHIR_WIRE_LOG_ENTRY_MAX_BYTES) {
      // Supported connector URLs and the caps above fit below this guard. Drop a
      // pathological entry rather than let it be silently truncated by the log
      // platform into invalid or misleading JSON.
      return;
    }
    await sink(line);
  } catch {
    // Diagnostic logging must never alter the patient request outcome.
  }
}

export function productionFhirWireLogSink(line: string): void {
  console.info(line);
}

export async function emitFhirWireLogExchange(
  mode: FhirWireLogMode,
  sink: FhirWireLogSink,
  exchange: FhirWireLogExchange,
): Promise<void> {
  if (mode === "off" || (mode === "errors" && exchange.outcome !== "error")) return;

  const exchangeId = exchange.exchangeId ?? randomUUID();
  const durationMs = exchange.durationMs;
  const context = {
    event: "fhir_wire",
    sensitive: true,
    dataClassification: "fhir-patient-data",
    exchangeId,
    ...(exchange.requestId ? { requestId: exchange.requestId } : {}),
    resourceType: exchange.resourceType,
    interaction: exchange.interaction,
    outcome: exchange.outcome,
    ...(typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
      ? { durationMs }
      : {}),
    ...(exchange.errorCode ? { errorCode: exchange.errorCode } : {}),
  } as const;

  await emitLine(sink, {
    fhirWire: {
      ...context,
      direction: "request",
      method: exchange.method,
      url: exchange.url,
      // Request headers are intentionally not accepted by this API. In
      // particular, the bearer Authorization header can never enter the log.
    },
  });

  if (!exchange.response) return;
  const body = truncateFhirBody(exchange.response.body);
  const statusText = exchange.response.statusText
    ? boundMetadata(exchange.response.statusText)
    : undefined;
  const contentType = exchange.response.contentType
    ? boundMetadata(exchange.response.contentType)
    : undefined;
  await emitLine(sink, {
    fhirWire: {
      ...context,
      direction: "response",
      status: exchange.response.status,
      ...(statusText
        ? {
            statusText: statusText.text,
            ...(statusText.truncated ? { statusTextTruncated: true } : {}),
          }
        : {}),
      ...(contentType
        ? {
            contentType: contentType.text,
            ...(contentType.truncated ? { contentTypeTruncated: true } : {}),
          }
        : {}),
      body: body.text,
      bodyByteLength: body.byteLength,
      bodyLoggedByteLength: body.loggedByteLength,
      bodyTruncated: body.truncated,
    },
  });
}
