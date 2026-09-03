import { describe, expect, it, vi } from "vitest";

import { requestJson } from "../src/http.js";
import type { FetchLike } from "../src/types.js";
import { jsonResponse } from "./helpers.js";

describe("requestJson", () => {
  it("uses manual redirect handling supported by Cloudflare Workers", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return jsonResponse({ ok: true });
    }) as FetchLike;

    await expect(requestJson("https://ehr.example.test/discovery", {
      fetch: fetchMock,
      timeoutMs: 10_000,
      maxBytes: 1_024,
    })).resolves.toMatchObject({ json: { ok: true } });
  });

  it("rejects an upstream redirect without following it", async () => {
    const fetchMock = vi.fn(async () => new Response("redirected", {
      status: 302,
      headers: { Location: "https://attacker.example/" },
    })) as FetchLike;

    await expect(requestJson("https://ehr.example.test/discovery", {
      fetch: fetchMock,
      timeoutMs: 10_000,
      maxBytes: 1_024,
    })).rejects.toMatchObject({
      code: "upstream_redirected",
      upstreamStatus: 302,
    });
  });

  it("stops reading when a shared operation byte budget is exhausted", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ value: "too large" })) as FetchLike;
    let remainingBytes = 4;

    await expect(requestJson("https://ehr.example.test/discovery", {
      fetch: fetchMock,
      timeoutMs: 10_000,
      maxBytes: 1_024,
      consumeBytes: (byteLength) => {
        if (byteLength > remainingBytes) return false;
        remainingBytes -= byteLength;
        return true;
      },
    })).rejects.toMatchObject({ code: "upstream_byte_budget_exceeded" });
  });

  it("normalizes an interrupted response body", async () => {
    const fetchMock = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new DOMException("timed out", "AbortError"));
      },
    }))) as FetchLike;

    await expect(requestJson("https://ehr.example.test/discovery", {
      fetch: fetchMock,
      timeoutMs: 10_000,
      maxBytes: 1_024,
    })).rejects.toMatchObject({
      code: "upstream_unavailable",
      upstreamStatus: 200,
    });
  });
});
