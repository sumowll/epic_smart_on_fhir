import { createHash } from "node:crypto";

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export function authorizationClientRateLimitKey(ipAddress: string | undefined): string {
  const normalized = ipAddress?.trim().toLowerCase() || "unknown";
  return createHash("sha256")
    .update("authorization-client\0", "utf8")
    .update(normalized.slice(0, 128), "utf8")
    .digest("base64url");
}

interface WindowCounter {
  count: number;
  resetAt: number;
}

/**
 * A bounded in-process limiter used for Node deployments and as defense in depth
 * inside a per-session Durable Object. Cloudflare's edge binding remains the
 * primary distributed limiter for Worker deployments.
 */
export class FixedWindowRateLimiter {
  readonly #counters = new Map<string, WindowCounter>();

  public constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  public check(key: string): RateLimitDecision {
    const currentTime = this.now();
    let counter = this.#counters.get(key);
    if (!counter || counter.resetAt <= currentTime) {
      counter = { count: 0, resetAt: currentTime + this.windowMs };
      this.#counters.set(key, counter);
    }
    counter.count += 1;
    if (this.#counters.size > this.maxKeys) this.prune(currentTime);
    return {
      allowed: counter.count <= this.limit,
      retryAfterSeconds: Math.max(1, Math.ceil((counter.resetAt - currentTime) / 1_000)),
    };
  }

  private prune(currentTime: number): void {
    for (const [key, counter] of this.#counters) {
      if (counter.resetAt <= currentTime || this.#counters.size > this.maxKeys) {
        this.#counters.delete(key);
      }
      if (this.#counters.size <= this.maxKeys) break;
    }
  }
}
