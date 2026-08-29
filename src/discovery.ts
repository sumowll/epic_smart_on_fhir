import { z } from "zod";

import { AppError } from "./errors.js";
import { requestJson, requireSecureEndpoint } from "./http.js";
import type {
  AppConfig,
  DiscoverySnapshot,
  FetchLike,
  FhirResourceCapability,
  OidcConfiguration,
  SmartConfiguration,
} from "./types.js";

const smartSchema = z.object({
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  revocation_endpoint: z.string().url().optional(),
  capabilities: z.array(z.string().max(256)).max(256).default([]),
  code_challenge_methods_supported: z.array(z.string().max(64)).max(32).default([]),
  token_endpoint_auth_methods_supported: z.array(z.string().max(128)).max(32).default([]),
});

const oidcSchema = z.object({
  issuer: z.string().url(),
  jwks_uri: z.string().url(),
  id_token_signing_alg_values_supported: z.array(z.string().max(64)).max(32).default([]),
});

const capabilityStatementSchema = z.object({
  resourceType: z.literal("CapabilityStatement"),
  fhirVersion: z.string().min(1),
  format: z.array(z.string().max(128)).max(64).default([]),
  rest: z.array(z.object({
    mode: z.string(),
    resource: z.array(z.object({
      type: z.string(),
      interaction: z.array(z.object({ code: z.string().max(64) })).max(64).default([]),
      searchParam: z.array(z.object({ name: z.string().max(256) })).max(512).default([]),
      searchRevInclude: z.array(z.string().max(256)).max(512).default([]),
    })).max(512).default([]),
  })).max(16).default([]),
});

function smartPermissionVersions(scopes: readonly string[]): ReadonlySet<"v1" | "v2"> {
  const versions = new Set<"v1" | "v2">();
  for (const scope of scopes) {
    const match = /^(?:patient|user|system)\/(?:\*|[A-Z][A-Za-z0-9]{0,63})\.([^?]+)(?:\?|$)/.exec(scope);
    if (!match) continue;
    if (match[1] === "read" || match[1] === "write" || match[1] === "*") {
      versions.add("v1");
    } else if (/^(?!$)c?r?u?d?s?$/.test(match[1]!)) {
      versions.add("v2");
    }
  }
  return versions;
}

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

    const [smart, oidc, capability] = await Promise.all([
      this.discoverSmart(),
      this.discoverOidc(),
      this.discoverFhirCapabilities(),
    ]);
    const value: DiscoverySnapshot = {
      fhirBaseUrl: this.config.fhirBaseUrl,
      smart,
      oidc,
      fhirVersion: capability.fhirVersion,
      fhirCapabilities: capability.resources,
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
    const permissionVersions = smartPermissionVersions(this.config.allowedResourceScopes);
    const requiredCapabilities = new Set([
      "launch-standalone",
      "context-standalone-patient",
      "permission-patient",
      ...(this.config.scopes.includes("openid") ? ["sso-openid-connect"] : []),
      ...(permissionVersions.has("v1") ? ["permission-v1"] : []),
      ...(permissionVersions.has("v2") ? ["permission-v2"] : []),
      ...(this.config.scopes.includes("offline_access") ? ["permission-offline"] : []),
    ]);
    const missingCapabilities = [...requiredCapabilities].filter(
      (capability) => !parsed.data.capabilities.includes(capability),
    );
    if (missingCapabilities.length > 0) {
      throw new AppError(
        502,
        "smart_capability_missing",
        `This Epic endpoint is missing required SMART capabilities: ${missingCapabilities.join(", ")}.`,
      );
    }
    const requiredClientCapability = this.config.tokenAuthMethod === "none"
      ? "client-public"
      : this.config.tokenAuthMethod === "client_secret_basic"
        ? "client-confidential-symmetric"
        : "client-confidential-asymmetric";
    const supportsConfiguredClient = parsed.data.capabilities.includes(requiredClientCapability) &&
      (this.config.tokenAuthMethod === "none" ||
        parsed.data.token_endpoint_auth_methods_supported.includes(this.config.tokenAuthMethod) ||
        (this.config.tokenAuthMethod === "client_secret_basic" &&
          parsed.data.token_endpoint_auth_methods_supported.length === 0));
    if (!supportsConfiguredClient) {
      throw new AppError(
        502,
        "client_auth_not_supported",
        `This Epic endpoint does not advertise the required ${requiredClientCapability} profile for ${this.config.tokenAuthMethod}.`,
      );
    }

    return {
      authorizationEndpoint: requireSecureEndpoint(
        this.requireTrustedEndpoint(
          parsed.data.authorization_endpoint,
          "authorization endpoint",
        ),
        "authorization endpoint",
      ),
      tokenEndpoint: this.requireTrustedEndpoint(parsed.data.token_endpoint, "token endpoint"),
      ...(parsed.data.revocation_endpoint
        ? {
            revocationEndpoint: this.requireTrustedEndpoint(
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
      issuer: this.requireTrustedEndpoint(parsed.data.issuer, "OpenID issuer"),
      jwksUri: this.requireTrustedEndpoint(parsed.data.jwks_uri, "JWKS endpoint"),
      idTokenAlgorithms: algorithms,
    };
  }

  private async discoverFhirCapabilities(): Promise<{
    readonly fhirVersion: string;
    readonly resources: readonly FhirResourceCapability[];
  }> {
    const { json } = await requestJson(`${this.config.fhirBaseUrl}/metadata`, {
      fetch: this.fetch,
      timeoutMs: this.config.requestTimeoutMs,
      maxBytes: 2 * 1024 * 1024,
      init: {
        headers: {
          Accept: "application/fhir+json",
          "Epic-Client-ID": this.config.clientId,
        },
      },
    });
    const parsed = capabilityStatementSchema.safeParse(json);
    if (!parsed.success || !/^4\.0(?:\.\d+)?$/.test(parsed.data.fhirVersion)) {
      throw new AppError(
        502,
        "unsupported_fhir_version",
        "The Epic endpoint did not return an R4 CapabilityStatement.",
      );
    }
    const supportsJson = parsed.data.format.some((format) =>
      /^(?:json|application\/(?:fhir\+json|json\+fhir|json))$/i.test(format));
    if (!supportsJson) {
      throw new AppError(
        502,
        "fhir_json_not_supported",
        "The Epic endpoint does not advertise FHIR JSON support.",
      );
    }

    const resources = new Map<string, {
      interactions: Set<"read" | "search">;
      searchParameters: Set<string>;
      searchRevIncludes: Set<string>;
    }>();
    for (const rest of parsed.data.rest) {
      if (rest.mode !== "server") continue;
      for (const resource of rest.resource) {
        if (!/^[A-Z][A-Za-z0-9]{0,63}$/.test(resource.type)) continue;
        const capability = resources.get(resource.type) ?? {
          interactions: new Set<"read" | "search">(),
          searchParameters: new Set<string>(),
          searchRevIncludes: new Set<string>(),
        };
        for (const interaction of resource.interaction) {
          if (interaction.code === "read") capability.interactions.add("read");
          if (interaction.code === "search-type") capability.interactions.add("search");
        }
        for (const parameter of resource.searchParam) {
          if (/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(parameter.name)) {
            capability.searchParameters.add(parameter.name);
          }
        }
        for (const value of resource.searchRevInclude) {
          if (/^(?:\*|[A-Z][A-Za-z0-9]{0,63}:[A-Za-z][A-Za-z0-9_.-]{0,127})$/.test(value)) {
            capability.searchRevIncludes.add(value);
          }
        }
        resources.set(resource.type, capability);
      }
    }
    if (!resources.get("Patient")?.interactions.has("read")) {
      throw new AppError(
        502,
        "patient_read_not_supported",
        "The Epic endpoint does not advertise the required Patient read interaction.",
      );
    }
    return {
      fhirVersion: parsed.data.fhirVersion,
      resources: [...resources.entries()].map(([resourceType, capability]) => ({
        resourceType,
        interactions: [...capability.interactions],
        searchParameters: [...capability.searchParameters].sort(),
        searchRevIncludes: [...capability.searchRevIncludes].sort(),
      })),
    };
  }

  private requireTrustedEndpoint(value: string, label: string): string {
    const endpoint = requireSecureEndpoint(value, label);
    if (!this.config.trustedEndpointOrigins.has(new URL(endpoint).origin)) {
      throw new AppError(
        502,
        "untrusted_discovery_endpoint",
        `Epic discovery returned a ${label} outside the configured trusted origins.`,
      );
    }
    return endpoint;
  }
}
