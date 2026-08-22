import { z } from "zod";

import { AppError } from "./errors.js";
import { requestJson, requireSecureEndpoint } from "./http.js";
import type {
  AppConfig,
  DiscoverySnapshot,
  FetchLike,
  OidcConfiguration,
  SmartConfiguration,
} from "./types.js";

const smartSchema = z.object({
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  revocation_endpoint: z.string().url().optional(),
  capabilities: z.array(z.string()).default([]),
  code_challenge_methods_supported: z.array(z.string()).default([]),
  token_endpoint_auth_methods_supported: z.array(z.string()).default([]),
});

const oidcSchema = z.object({
  issuer: z.string().url(),
  jwks_uri: z.string().url(),
  id_token_signing_alg_values_supported: z.array(z.string()).default([]),
});

interface CachedDiscovery {
  readonly expiresAt: number;
  readonly value: DiscoverySnapshot;
}

export class EpicDiscoveryService {
  readonly #cache = new Map<string, CachedDiscovery>();

  public constructor(
    private readonly config: AppConfig,
    private readonly fetch: FetchLike = globalThis.fetch,
    private readonly now: () => number = Date.now,
    private readonly cacheTtlMs = 60 * 60 * 1_000,
  ) {}

  public async discover(): Promise<DiscoverySnapshot> {
    const cached = this.#cache.get(this.config.fhirBaseUrl);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const [smart, oidc] = await Promise.all([
      this.discoverSmart(),
      this.discoverOidc(),
    ]);
    const value: DiscoverySnapshot = {
      fhirBaseUrl: this.config.fhirBaseUrl,
      smart,
      oidc,
    };
    this.#cache.set(this.config.fhirBaseUrl, {
      value,
      expiresAt: this.now() + this.cacheTtlMs,
    });
    return value;
  }

  private async discoverSmart(): Promise<SmartConfiguration> {
    const url = `${this.config.fhirBaseUrl}/.well-known/smart-configuration`;
    const { json } = await requestJson(url, {
      fetch: this.fetch,
      timeoutMs: this.config.requestTimeoutMs,
      maxBytes: 512 * 1024,
      init: { headers: { "Epic-Client-ID": this.config.clientId } },
    });
    const parsed = smartSchema.safeParse(json);
    if (!parsed.success) {
      throw new AppError(502, "invalid_discovery", "Epic returned invalid SMART configuration.");
    }
    if (!parsed.data.code_challenge_methods_supported.includes("S256")) {
      throw new AppError(502, "pkce_not_supported", "This Epic endpoint does not advertise PKCE S256 support.");
    }
    if (!parsed.data.capabilities.includes("launch-standalone")) {
      throw new AppError(502, "standalone_launch_not_supported", "This Epic endpoint does not advertise standalone launch support.");
    }
    const supportsConfiguredClient = this.config.tokenAuthMethod === "none"
      ? parsed.data.capabilities.includes("client-public")
      : parsed.data.token_endpoint_auth_methods_supported.includes(this.config.tokenAuthMethod);
    if (!supportsConfiguredClient) {
      throw new AppError(
        502,
        "client_auth_not_supported",
        `This Epic endpoint does not support ${this.config.tokenAuthMethod}.`,
      );
    }

    return {
      authorizationEndpoint: requireSecureEndpoint(
        parsed.data.authorization_endpoint,
        "authorization endpoint",
      ),
      tokenEndpoint: requireSecureEndpoint(parsed.data.token_endpoint, "token endpoint"),
      ...(parsed.data.revocation_endpoint
        ? {
            revocationEndpoint: requireSecureEndpoint(
              parsed.data.revocation_endpoint,
              "revocation endpoint",
            ),
          }
        : {}),
      capabilities: parsed.data.capabilities,
      codeChallengeMethods: parsed.data.code_challenge_methods_supported,
      tokenAuthMethods: parsed.data.token_endpoint_auth_methods_supported,
    };
  }

  private async discoverOidc(): Promise<OidcConfiguration> {
    const url = `${this.config.fhirBaseUrl}/.well-known/openid-configuration`;
    const { json } = await requestJson(url, {
      fetch: this.fetch,
      timeoutMs: this.config.requestTimeoutMs,
      maxBytes: 512 * 1024,
      init: { headers: { "Epic-Client-ID": this.config.clientId } },
    });
    const parsed = oidcSchema.safeParse(json);
    if (!parsed.success) {
      throw new AppError(502, "invalid_oidc_discovery", "Epic returned invalid OpenID configuration.");
    }
    const algorithms = parsed.data.id_token_signing_alg_values_supported;
    if (algorithms.length > 0 && !algorithms.some((algorithm) => algorithm === "RS256" || algorithm === "ES256" || algorithm === "RS384" || algorithm === "ES384")) {
      throw new AppError(502, "unsupported_id_token_algorithm", "Epic did not advertise a supported ID token signing algorithm.");
    }
    return {
      issuer: requireSecureEndpoint(parsed.data.issuer, "OpenID issuer"),
      jwksUri: requireSecureEndpoint(parsed.data.jwks_uri, "JWKS endpoint"),
      idTokenAlgorithms: algorithms,
    };
  }
}
