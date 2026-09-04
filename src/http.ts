import { AppError, UpstreamError } from "./errors.js";
import type { FetchLike } from "./types.js";

export interface JsonRequestOptions {
  readonly fetch: FetchLike;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly consumeBytes?: (byteLength: number) => boolean;
  readonly onResponse?: (response: Response) => void;
  readonly onBody?: (response: Response, body: string) => void | Promise<void>;
  readonly init?: RequestInit;
  readonly expectedStatus?: readonly number[];
}

async function readLimited(
  response: Response,
  maxBytes: number,
  consumeBytes?: (byteLength: number) => boolean,
): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    if (response.body) await response.body.cancel().catch(() => undefined);
    throw new UpstreamError(
      "upstream_too_large",
      "The Epic server returned an oversized response.",
      response.status,
    );
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UpstreamError(
          "upstream_too_large",
          "The Epic server returned an oversized response.",
          response.status,
        );
      }
      if (consumeBytes && !consumeBytes(chunk.value.byteLength)) {
        await reader.cancel().catch(() => undefined);
        throw new UpstreamError(
          "upstream_byte_budget_exceeded",
          "The Epic server returned more data than this operation permits.",
          response.status,
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    await reader.cancel().catch(() => undefined);
    throw new UpstreamError(
      "upstream_unavailable",
      "The Epic response was interrupted. Please try again.",
      response.status,
      { cause: error },
    );
  }
}

export async function requestJson(
  url: string,
  options: JsonRequestOptions,
): Promise<{ readonly response: Response; readonly json: unknown }> {
  let response: Response;
  try {
    response = await options.fetch(url, {
      ...options.init,
      // workerd intentionally supports only "follow" and "manual". Preserve
      // the connector's no-redirect policy by inspecting manual responses.
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: {
        Accept: "application/json, application/fhir+json",
        ...options.init?.headers,
      },
    });
  } catch (error) {
    throw new UpstreamError(
      "upstream_unavailable",
      "The Epic server could not be reached. Please try again.",
      undefined,
      { cause: error },
    );
  }

  if (response.status >= 300 && response.status < 400) {
    if (response.body) {
      await response.body.cancel().catch(() => undefined);
    }
    throw new UpstreamError(
      "upstream_redirected",
      "The Epic server returned an unexpected redirect.",
      response.status,
    );
  }

  options.onResponse?.(response);

  const text = await readLimited(response, options.maxBytes, options.consumeBytes);
  if (options.onBody) {
    try {
      await options.onBody(response, text);
    } catch {
      // Diagnostics must not change the upstream request outcome.
    }
  }
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new UpstreamError(
      "invalid_upstream_response",
      "The Epic server returned an invalid response.",
      response.status,
      { cause: error },
    );
  }

  const expected = options.expectedStatus ?? [200];
  if (!expected.includes(response.status)) {
    throw new UpstreamError(
      "upstream_rejected_request",
      "The Epic server rejected the request.",
      response.status,
    );
  }
  return { response, json };
}

export function requireSecureEndpoint(value: string, label: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (error) {
    throw new AppError(502, "invalid_discovery", `Epic discovery returned an invalid ${label}.`, { cause: error });
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new AppError(502, "invalid_discovery", `Epic discovery returned an unsafe ${label}.`);
  }
  return endpoint.toString();
}
