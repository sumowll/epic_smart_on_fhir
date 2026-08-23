import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  SignJWT,
  createLocalJWKSet,
  importPKCS8,
  jwtVerify,
  type JSONWebKeySet,
} from "jose";
import { z } from "zod";

import { AppError, ReconnectRequiredError, UpstreamError } from "./errors.js";
import { requestJson } from "./http.js";
import type {
  AppConfig,
  ConnectionRecord,
  ConnectionStore,
  DiscoverySnapshot,
  EpicTokenResponse,
  FetchLike,
} from "./types.js";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.coerce.number().int().positive().max(7 * 24 * 60 * 60),
  scope: z.string().optional(),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  patient: z.string().min(1).max(512).optional(),
});

const issuedTokenFragmentSchema = z.object({
  access_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
}).refine((value) => value.access_token !== undefined || value.refresh_token !== undefined);

const oauthErrorSchema = z.object({
  error: z.string().min(1).max(200),
}).passthrough();

const jwksSchema = z.object({
  keys: z.array(z.record(z.string(), z.unknown())).min(1),
});

const supportedIdTokenAlgorithms = ["RS256", "ES256", "RS384", "ES384"] as const;

function createBasicAuthorization(clientId: string, clientSecret: string): string {
  // Epic's documented profile URL-encodes both values before constructing Basic auth.
  const credentials = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  return `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
}

export class EpicOAuthClient {
  #privateKey?: ReturnType<typeof importPKCS8>;

  public constructor(
    private readonly config: AppConfig,
    private readonly fetch: FetchLike = globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {}

  public buildAuthorizationUrl(
    discovery: DiscoverySnapshot,
    parameters: {
      readonly state: string;
      readonly nonce: string;
      readonly codeChallenge: string;
    },
  ): string {
    const url = new URL(discovery.smart.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("scope", this.config.scopes.join(" "));
    url.searchParams.set("aud", discovery.fhirBaseUrl);
    url.searchParams.set("state", parameters.state);
    url.searchParams.set("nonce", parameters.nonce);
    url.searchParams.set("code_challenge", parameters.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  public async exchangeCode(
    tokenEndpoint: string,
    code: string,
    codeVerifier: string,
    revocationEndpoint?: string,
  ): Promise<EpicTokenResponse> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
      code_verifier: codeVerifier,
    });
    const headers = await this.applyClientAuthentication(body, tokenEndpoint);
    try {
      return await this.tokenRequest(
        tokenEndpoint,
        body,
        headers,
        false,
        revocationEndpoint,
      );
    } catch (error) {
      if (
        error instanceof AppError &&
        (
          error.code === "code_exchange_failed" ||
          error.code === "invalid_token_response_cleaned" ||
          error.code === "authorization_cleanup_required"
        )
      ) {
        throw error;
      }
      throw new AppError(
        502,
        "authorization_cleanup_required",
        "The authorization-code exchange did not complete unambiguously. Remove this app in MyChart's linked apps/devices settings before trying again.",
        { cause: error },
      );
    }
  }

  public async refresh(record: ConnectionRecord): Promise<EpicTokenResponse> {
    this.requireConnectionCompatible(record);
    if (!record.refreshToken) throw new ReconnectRequiredError();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: record.refreshToken,
    });
    const headers = await this.applyClientAuthentication(body, record.tokenEndpoint);
    return this.tokenRequest(
      record.tokenEndpoint,
      body,
      headers,
      true,
      record.revocationEndpoint,
    );
  }

  public isConnectionCompatible(record: ConnectionRecord): boolean {
    return record.oauthClientId === this.config.clientId &&
      record.fhirBaseUrl === this.config.fhirBaseUrl;
  }

  public async revoke(
    revocationEndpoint: string,
    record: ConnectionRecord,
  ): Promise<void> {
    this.requireConnectionCompatible(record);
    return this.revokeTokens(
      revocationEndpoint,
      record.accessToken,
      record.refreshToken,
    );
  }

  public async revokeTokens(
    revocationEndpoint: string,
    accessToken: string | undefined,
    refreshToken?: string,
  ): Promise<void> {
    const tokens: ReadonlyArray<readonly [string, "refresh_token" | "access_token"]> = [
      ...(refreshToken
        ? ([[refreshToken, "refresh_token"]] as const)
        : []),
      ...(accessToken
        ? ([[accessToken, "access_token"]] as const)
        : []),
    ];
    let firstFailure: unknown;
    for (const [token, hint] of tokens) {
      try {
        await this.revokeToken(revocationEndpoint, token, hint);
      } catch (error) {
        firstFailure ??= error;
      }
    }
    if (firstFailure) throw firstFailure;
  }

  private async revokeToken(
    revocationEndpoint: string,
    token: string,
    tokenTypeHint: "refresh_token" | "access_token",
  ): Promise<void> {
    const body = new URLSearchParams({
      token,
      token_type_hint: tokenTypeHint,
    });
    const headers = await this.applyClientAuthentication(body, revocationEndpoint);
    const { response } = await requestJson(revocationEndpoint, {
      fetch: this.fetch,
      timeoutMs: this.config.requestTimeoutMs,
      maxBytes: 64 * 1024,
      expectedStatus: [200],
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...headers,
        },
        body,
      },
    });
    if (!response.ok) {
      throw new UpstreamError("revocation_failed", "Epic did not accept token revocation.", response.status);
    }
  }

  private async tokenRequest(
    tokenEndpoint: string,
    body: URLSearchParams,
    authenticationHeaders: Record<string, string>,
    isRefresh: boolean,
    revocationEndpoint?: string,
  ): Promise<EpicTokenResponse> {
    const { response, json } = await requestJson(tokenEndpoint, {
      fetch: this.fetch,
      timeoutMs: this.config.requestTimeoutMs,
      maxBytes: 512 * 1024,
      expectedStatus: [200, 400, 401, 403],
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...authenticationHeaders,
        },
        body,
      },
    });

    if (!response.ok) {
      await this.cleanupIssuedTokenFragments(json, revocationEndpoint);
      const oauthError = oauthErrorSchema.safeParse(json);
      if (isRefresh && oauthError.success && oauthError.data.error === "invalid_grant") {
        throw new ReconnectRequiredError();
      }
      throw new UpstreamError(
        isRefresh
          ? "token_refresh_failed"
          : oauthError.success
            ? "code_exchange_failed"
            : "ambiguous_code_exchange_failure",
        isRefresh
          ? "Epic could not refresh the authorization. Please connect again."
          : "Epic could not complete the authorization.",
        response.status,
      );
    }

    const token = tokenSchema.safeParse(json);
    if (!token.success || token.data.token_type.toLowerCase() !== "bearer") {
      const cleaned = await this.cleanupIssuedTokenFragments(json, revocationEndpoint);
      throw new UpstreamError(
        cleaned ? "invalid_token_response_cleaned" : "invalid_token_response",
        "Epic returned an invalid OAuth token response.",
        response.status,
      );
    }
    return {
      access_token: token.data.access_token,
      token_type: token.data.token_type,
      expires_in: token.data.expires_in,
      ...(token.data.scope !== undefined ? { scope: token.data.scope } : {}),
      ...(token.data.refresh_token !== undefined
        ? { refresh_token: token.data.refresh_token }
        : {}),
      ...(token.data.id_token !== undefined ? { id_token: token.data.id_token } : {}),
      ...(token.data.patient !== undefined ? { patient: token.data.patient } : {}),
    };
  }

  private async cleanupIssuedTokenFragments(
    json: unknown,
    revocationEndpoint: string | undefined,
  ): Promise<boolean> {
    const fragment = issuedTokenFragmentSchema.safeParse(json);
    if (!fragment.success) return false;
    if (!revocationEndpoint) {
      throw new AppError(
        502,
        "authorization_cleanup_required",
        "Epic returned an invalid token response that may contain an active grant. Remove this app in MyChart's linked apps/devices settings before trying again.",
      );
    }
    try {
      await this.revokeTokens(
        revocationEndpoint,
        fragment.data.access_token,
        fragment.data.refresh_token,
      );
      return true;
    } catch (error) {
      throw new AppError(
        502,
        "authorization_cleanup_required",
        "Epic returned an invalid token response and automatic cleanup could not be confirmed. Remove this app in MyChart's linked apps/devices settings before trying again.",
        { cause: error },
      );
    }
  }

  private requireConnectionCompatible(record: ConnectionRecord): void {
    if (!this.isConnectionCompatible(record)) {
      throw new AppError(
        409,
        "connection_config_mismatch",
        "This saved MyChart grant belongs to a different Epic provider or client registration. It was not sent to the currently configured OAuth server.",
      );
    }
  }

  private async applyClientAuthentication(
    body: URLSearchParams,
    audience: string,
  ): Promise<Record<string, string>> {
    switch (this.config.tokenAuthMethod) {
      case "none":
        body.set("client_id", this.config.clientId);
        return {};
      case "client_secret_basic": {
        if (!this.config.clientSecret) {
          throw new AppError(500, "invalid_config", "The Epic client secret is missing.");
        }
        return {
          Authorization: createBasicAuthorization(this.config.clientId, this.config.clientSecret),
        };
      }
      case "private_key_jwt": {
        body.set(
          "client_assertion_type",
          "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        );
        body.set("client_assertion", await this.createClientAssertion(audience));
        return {};
      }
    }
  }

  private async createClientAssertion(audience: string): Promise<string> {
    const algorithm = this.config.privateKeyAlgorithm;
    const keyId = this.config.privateKeyId;
    const privateKeyPath = this.config.privateKeyPath;
    const privateKeyPem = this.config.privateKeyPem;
    if (!algorithm || !keyId || (!privateKeyPath && !privateKeyPem)) {
      throw new AppError(500, "invalid_config", "The private_key_jwt configuration is incomplete.");
    }

    this.#privateKey ??= privateKeyPem
      ? importPKCS8(privateKeyPem, algorithm)
      : readFile(privateKeyPath!, "utf8").then((pem) => importPKCS8(pem, algorithm));
    const now = Math.floor(this.now() / 1_000);
    const issuedAt = now - 5;
    return new SignJWT({})
      .setProtectedHeader({ alg: algorithm, kid: keyId, typ: "JWT" })
      .setIssuer(this.config.clientId)
      .setSubject(this.config.clientId)
      .setAudience(audience)
      .setJti(randomUUID())
      .setIssuedAt(issuedAt)
      .setNotBefore(issuedAt)
      .setExpirationTime(now + 240)
      .sign(await this.#privateKey);
  }
}

export class EpicIdTokenVerifier {
  public constructor(
    private readonly config: AppConfig,
    private readonly fetch: FetchLike = globalThis.fetch,
  ) {}

  public async verify(
    idToken: string | undefined,
    discovery: DiscoverySnapshot,
    expectedNonce: string,
  ): Promise<{ readonly fhirUser?: string }> {
    if (!idToken) {
      throw new UpstreamError(
        "missing_id_token",
        "Epic did not return the expected OpenID identity token.",
      );
    }

    const { json } = await requestJson(discovery.oidc.jwksUri, {
      fetch: this.fetch,
      timeoutMs: this.config.requestTimeoutMs,
      maxBytes: 512 * 1024,
    });
    const parsedJwks = jwksSchema.safeParse(json);
    if (!parsedJwks.success) {
      throw new UpstreamError("invalid_jwks", "Epic returned an invalid signing-key set.");
    }

    const advertised = discovery.oidc.idTokenAlgorithms;
    const algorithms = supportedIdTokenAlgorithms.filter(
      (algorithm) => advertised.length === 0 || advertised.includes(algorithm),
    );
    try {
      const { payload } = await jwtVerify(
        idToken,
        createLocalJWKSet(parsedJwks.data as JSONWebKeySet),
        {
          issuer: discovery.oidc.issuer,
          audience: this.config.clientId,
          algorithms,
          clockTolerance: 5,
          maxTokenAge: "10m",
          requiredClaims: ["sub", "iat", "exp", "nonce"],
        },
      );
      if (payload.nonce !== expectedNonce) {
        throw new Error("ID token nonce mismatch");
      }
      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new Error("ID token subject missing");
      }
      const multipleAudiences = Array.isArray(payload.aud) && payload.aud.length > 1;
      if (
        (payload.azp !== undefined && payload.azp !== this.config.clientId) ||
        (multipleAudiences && payload.azp !== this.config.clientId)
      ) {
        throw new Error("ID token authorized party mismatch");
      }
      const fhirUser = typeof payload.fhirUser === "string" ? payload.fhirUser : undefined;
      return fhirUser ? { fhirUser } : {};
    } catch (error) {
      throw new AppError(
        401,
        "invalid_id_token",
        "Epic returned an invalid identity token.",
        { cause: error },
      );
    }
  }
}

export class EpicTokenManager {
  readonly #refreshes = new Map<string, Promise<ConnectionRecord>>();
  readonly #disconnects = new Map<string, Promise<TokenDisconnectOutcome>>();
  readonly #invalidating = new Set<string>();
  readonly #cleanupFailures = new Set<string>();
  readonly #cleanupUnsupported = new Set<string>();
  readonly #versions = new Map<string, number>();

  public constructor(
    private readonly store: ConnectionStore,
    private readonly oauth: EpicOAuthClient,
    private readonly now: () => number = Date.now,
  ) {}

  public async getConnection(sessionId: string): Promise<ConnectionRecord | undefined> {
    if (this.#invalidating.has(sessionId)) return undefined;
    const record = await this.store.get(sessionId);
    if (this.#invalidating.has(sessionId)) return undefined;
    if (record && record.sessionExpiresAt <= this.now()) {
      await this.expireConnection(sessionId);
      return undefined;
    }
    return record;
  }

  public async invalidate(sessionId: string): Promise<void> {
    this.#versions.set(sessionId, (this.#versions.get(sessionId) ?? 0) + 1);
    await this.store.delete(sessionId);
  }

  public async getValidConnection(sessionId: string): Promise<ConnectionRecord> {
    if (this.#invalidating.has(sessionId)) {
      throw new ReconnectRequiredError("The MyChart connection is being disconnected.");
    }
    const record = await this.store.get(sessionId);
    if (this.#invalidating.has(sessionId)) {
      throw new ReconnectRequiredError("The MyChart connection is being disconnected.");
    }
    if (!record) throw new ReconnectRequiredError("Connect your MyChart account first.");
    if (!this.oauth.isConnectionCompatible(record)) {
      await this.disconnect(sessionId);
      throw new ReconnectRequiredError(
        "This saved MyChart grant belongs to a different Epic provider or client registration. It was removed locally; remove the old app in MyChart's linked apps/devices settings.",
      );
    }
    if (record.sessionExpiresAt <= this.now()) {
      await this.expireConnection(sessionId);
      throw new ReconnectRequiredError("The local MyChart session expired. Please connect again.");
    }
    if (record.expiresAt > this.now() + 60_000) return record;
    if (!record.refreshToken) {
      await this.disconnect(sessionId);
      throw new ReconnectRequiredError();
    }

    const existing = this.#refreshes.get(sessionId);
    if (existing) return existing;
    const version = this.#versions.get(sessionId) ?? 0;
    const refresh = this.refreshConnection(sessionId, record, version).finally(() => {
      this.#refreshes.delete(sessionId);
    });
    this.#refreshes.set(sessionId, refresh);
    return refresh;
  }

  public async disconnect(sessionId: string): Promise<TokenDisconnectOutcome> {
    const existing = this.#disconnects.get(sessionId);
    if (existing) return existing;
    const disconnect = this.performDisconnect(sessionId).finally(() => {
      this.#disconnects.delete(sessionId);
    });
    this.#disconnects.set(sessionId, disconnect);
    return disconnect;
  }

  private async refreshConnection(
    sessionId: string,
    current: ConnectionRecord,
    version: number,
  ): Promise<ConnectionRecord> {
    let refreshed: ConnectionRecord | undefined;
    let cleanupAttempted = false;
    try {
      const token = await this.oauth.refresh(current);
      refreshed = {
        ...current,
        accessToken: token.access_token,
        ...(token.refresh_token
          ? { refreshToken: token.refresh_token }
          : current.refreshToken
            ? { refreshToken: current.refreshToken }
            : {}),
        expiresAt: this.now() + token.expires_in * 1_000,
        scope: token.scope ?? current.scope,
      };
      if (
        this.#invalidating.has(sessionId) ||
        (this.#versions.get(sessionId) ?? 0) !== version
      ) {
        await this.revokeAfterInvalidation(sessionId, refreshed);
        cleanupAttempted = true;
        throw new ReconnectRequiredError("The MyChart connection was disconnected.");
      }
      await this.store.set(sessionId, refreshed);
      if (
        this.#invalidating.has(sessionId) ||
        (this.#versions.get(sessionId) ?? 0) !== version
      ) {
        await this.store.delete(sessionId);
        await this.revokeAfterInvalidation(sessionId, refreshed);
        cleanupAttempted = true;
        throw new ReconnectRequiredError("The MyChart connection was disconnected.");
      }
      return refreshed;
    } catch (error) {
      try {
        await this.store.delete(sessionId);
      } catch {
        this.#invalidating.add(sessionId);
        this.#versions.set(sessionId, (this.#versions.get(sessionId) ?? 0) + 1);
      }
      if (error instanceof ReconnectRequiredError) throw error;
      let cleanupRequired = refreshed === undefined;
      if (refreshed && !cleanupAttempted) {
        if (!refreshed.revocationEndpoint) {
          cleanupRequired = true;
        } else {
          try {
            await this.oauth.revoke(refreshed.revocationEndpoint, refreshed);
          } catch {
            cleanupRequired = true;
          }
        }
      }
      throw new ReconnectRequiredError(
        cleanupRequired
          ? "Epic token refresh did not complete safely. Reconnect, and remove the app in MyChart's linked apps/devices settings if it remains listed."
          : "Epic token refresh did not complete safely. Please connect again.",
      );
    }
  }

  private async expireConnection(sessionId: string): Promise<void> {
    await this.disconnect(sessionId);
  }

  private async performDisconnect(sessionId: string): Promise<TokenDisconnectOutcome> {
    this.#invalidating.add(sessionId);
    this.#versions.set(sessionId, (this.#versions.get(sessionId) ?? 0) + 1);
    const records = new Map<string, ConnectionRecord>();
    try {
      const before = await this.store.get(sessionId);
      if (before) records.set(before.accessToken, before);
      await this.store.delete(sessionId);

      const refresh = this.#refreshes.get(sessionId);
      if (refresh) {
        try {
          const refreshed = await refresh;
          records.set(refreshed.accessToken, refreshed);
        } catch {
          // The refresh path performs its own mismatch cleanup.
        }
      }

      const after = await this.store.get(sessionId);
      if (after) records.set(after.accessToken, after);
      await this.store.delete(sessionId);

      let supported = false;
      const cleanupFailed = this.#cleanupFailures.delete(sessionId);
      const cleanupUnsupported = this.#cleanupUnsupported.delete(sessionId);
      let unsupported = cleanupUnsupported;
      let failed = cleanupFailed;
      for (const record of records.values()) {
        if (!record.revocationEndpoint || !this.oauth.isConnectionCompatible(record)) {
          unsupported = true;
          continue;
        }
        supported = true;
        try {
          await this.oauth.revoke(record.revocationEndpoint, record);
        } catch {
          failed = true;
        }
      }

      const remoteRevocation = failed
        ? "failed"
        : unsupported
          ? "not_supported"
          : supported
            ? "success"
            : "not_applicable";
      return {
        hadConnection: records.size > 0 || cleanupFailed || cleanupUnsupported,
        remoteRevocation,
      };
    } finally {
      await this.store.delete(sessionId);
      this.#invalidating.delete(sessionId);
    }
  }

  private async revokeAfterInvalidation(
    sessionId: string,
    record: ConnectionRecord,
  ): Promise<void> {
    if (!record.revocationEndpoint) {
      this.#cleanupUnsupported.add(sessionId);
      return;
    }
    try {
      await this.oauth.revoke(record.revocationEndpoint, record);
    } catch {
      this.#cleanupFailures.add(sessionId);
    }
  }
}

export interface TokenDisconnectOutcome {
  readonly hadConnection: boolean;
  readonly remoteRevocation: "success" | "not_supported" | "failed" | "not_applicable";
}
