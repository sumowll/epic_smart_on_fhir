import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { AppError } from "./errors.js";
import { parsePendingAuthorization } from "./records.js";
import type { PendingAuthorization } from "./types.js";

export function randomBase64Url(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function createPkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBase64Url(64);
  const challenge = createPkceChallenge(verifier);
  return { verifier, challenge };
}

function hashState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class PendingAuthorizationStore {
  readonly #items = new Map<
    string,
    { readonly authorization: PendingAuthorization; readonly status: "pending" | "processing" }
  >();

  public constructor(
    private readonly ttlMs = 10 * 60 * 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  public create(state: string, authorization: PendingAuthorization): void {
    const validated = parsePendingAuthorization(authorization);
    this.prune();
    for (const [key, value] of this.#items) {
      if (!constantTimeEqual(value.authorization.sessionId, validated.sessionId)) {
        continue;
      }
      if (value.status === "processing") {
        throw new AppError(
          409,
          "authorization_in_progress",
          "A MyChart authorization is already being completed. Wait a moment before trying again.",
        );
      }
      this.#items.delete(key);
    }
    this.#items.set(hashState(state), { authorization: validated, status: "pending" });
  }

  public consume(state: string, sessionId: string): PendingAuthorization {
    if (state.length < 32 || state.length > 512) {
      throw new AppError(400, "invalid_oauth_state", "The OAuth state is invalid or expired.");
    }

    const key = hashState(state);
    const item = this.#items.get(key);
    if (
      !item ||
      item.status !== "pending" ||
      this.now() - item.authorization.createdAt > this.ttlMs
    ) {
      throw new AppError(400, "invalid_oauth_state", "The OAuth state is invalid or expired.");
    }
    if (!constantTimeEqual(item.authorization.sessionId, sessionId)) {
      throw new AppError(400, "oauth_session_mismatch", "This authorization belongs to another browser session.");
    }
    this.#items.set(key, { authorization: item.authorization, status: "processing" });
    return item.authorization;
  }

  public deleteForSession(sessionId: string): void {
    for (const [key, value] of this.#items) {
      if (constantTimeEqual(value.authorization.sessionId, sessionId)) {
        this.#items.delete(key);
      }
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, value] of this.#items) {
      if (value.authorization.createdAt < cutoff) this.#items.delete(key);
    }
  }
}

export type OAuthCallback =
  | { readonly kind: "success"; readonly state: string; readonly code: string }
  | { readonly kind: "error"; readonly state: string; readonly error: string };

export function parseOAuthCallback(rawUrl: string): OAuthCallback {
  const url = new URL(rawUrl, "http://callback.invalid");
  const states = url.searchParams.getAll("state");
  const codes = url.searchParams.getAll("code");
  const errors = url.searchParams.getAll("error");

  if (states.length !== 1 || (codes.length === 1) === (errors.length === 1)) {
    throw new AppError(
      400,
      "invalid_oauth_callback",
      "The MyChart authorization response was malformed.",
    );
  }
  if (codes.length > 1 || errors.length > 1) {
    throw new AppError(
      400,
      "invalid_oauth_callback",
      "The MyChart authorization response contained duplicate parameters.",
    );
  }

  const state = states[0];
  if (!state) {
    throw new AppError(400, "invalid_oauth_callback", "The MyChart authorization response omitted state.");
  }
  const code = codes[0];
  if (code) {
    if (code.length > 4_096) {
      throw new AppError(400, "invalid_oauth_callback", "The MyChart authorization response was malformed.");
    }
    return { kind: "success", state, code };
  }

  const oauthError = errors[0];
  if (!oauthError || oauthError.length > 200) {
    throw new AppError(400, "invalid_oauth_callback", "The MyChart authorization response was malformed.");
  }
  return { kind: "error", state, error: oauthError };
}
