import { describe, expect, it } from "vitest";

import {
  authorizationClientRateLimitKey,
  FixedWindowRateLimiter,
} from "../src/rate-limit.js";

describe("fixed-window rate limiter", () => {
  it("uses only the normalized connecting IP for authorization client buckets", () => {
    expect(authorizationClientRateLimitKey(" 2001:DB8::1 ")).toBe(
      authorizationClientRateLimitKey("2001:db8::1"),
    );
    expect(authorizationClientRateLimitKey("203.0.113.10")).not.toBe(
      authorizationClientRateLimitKey("203.0.113.11"),
    );
    expect(authorizationClientRateLimitKey(undefined)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("limits each key independently and resets after the window", () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter(2, 10_000, () => now, 10);

    expect(limiter.check("session-a").allowed).toBe(true);
    expect(limiter.check("session-a").allowed).toBe(true);
    expect(limiter.check("session-a")).toMatchObject({
      allowed: false,
      retryAfterSeconds: 10,
    });
    expect(limiter.check("session-b").allowed).toBe(true);

    now = 11_000;
    expect(limiter.check("session-a").allowed).toBe(true);
  });
});
