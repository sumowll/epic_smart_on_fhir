export type FetchLike = typeof globalThis.fetch;

export type TokenAuthMethod =
  | "client_secret_basic"
  | "private_key_jwt"
  | "none";

export interface AppConfig {
  readonly legalName: string;
  readonly legalContactEmail: string;
  readonly legalEffectiveDate: string;
  readonly hostingProviderName: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly tokenAuthMethod: TokenAuthMethod;
  readonly fhirBaseUrl: string;
  readonly providerName: string;
  readonly redirectUri: string;
  readonly publicOrigin: string;
  readonly scopes: readonly string[];
  readonly sessionSecret: string;
  readonly host: string;
  readonly port: number;
  readonly cookieSecure: boolean;
  readonly cookieName: string;
  readonly tokenStorage: "memory" | "encrypted-file";
  readonly tokenStoreFile: string;
  readonly tokenEncryptionKey?: Buffer;
  readonly allowedResourceTypes: ReadonlySet<string>;
  readonly privateKeyPath?: string;
  readonly privateKeyPem?: string;
  readonly privateKeyAlgorithm?: "ES384" | "RS384";
  readonly privateKeyId?: string;
  readonly requestTimeoutMs: number;
  readonly maxUpstreamBytes: number;
}

export interface SmartConfiguration {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly capabilities: readonly string[];
  readonly codeChallengeMethods: readonly string[];
  readonly tokenAuthMethods: readonly string[];
}

export interface OidcConfiguration {
  readonly issuer: string;
  readonly jwksUri: string;
  readonly idTokenAlgorithms: readonly string[];
}

export interface DiscoverySnapshot {
  readonly fhirBaseUrl: string;
  readonly smart: SmartConfiguration;
  readonly oidc: OidcConfiguration;
}

export interface PendingAuthorization {
  readonly sessionId: string;
  readonly createdAt: number;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly discovery: DiscoverySnapshot;
}

export interface EpicTokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in: number;
  readonly scope?: string;
  readonly refresh_token?: string;
  readonly id_token?: string;
  readonly patient?: string;
}

export interface ConnectionRecord {
  readonly oauthClientId: string;
  readonly fhirBaseUrl: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType: "Bearer";
  readonly expiresAt: number;
  readonly scope: string;
  readonly patientId: string;
  readonly fhirUser?: string;
  readonly connectedAt: number;
  readonly sessionExpiresAt: number;
}

export interface ConnectionStore {
  readonly durable?: boolean;
  initialize(): Promise<void>;
  close(): Promise<void>;
  get(sessionId: string): Promise<ConnectionRecord | undefined>;
  list(): Promise<ReadonlyArray<readonly [string, ConnectionRecord]>>;
  set(sessionId: string, record: ConnectionRecord): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export interface PendingAuthorizationRepository {
  create(state: string, authorization: PendingAuthorization): void | Promise<void>;
  consume(
    state: string,
    sessionId: string,
  ): PendingAuthorization | Promise<PendingAuthorization>;
  deleteForSession(sessionId: string): void | Promise<void>;
}
