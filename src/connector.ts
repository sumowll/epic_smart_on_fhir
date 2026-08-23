import { AppError, ReconnectRequiredError } from "./errors.js";
import { EpicDiscoveryService } from "./discovery.js";
import { EpicFhirClient } from "./fhir.js";
import {
  EpicIdTokenVerifier,
  EpicOAuthClient,
  EpicTokenManager,
} from "./oauth.js";
import {
  PendingAuthorizationStore,
  createPkcePair,
  parseOAuthCallback,
  randomBase64Url,
} from "./security.js";
import type {
  AppConfig,
  ConnectionRecord,
  ConnectionStore,
  FetchLike,
  PendingAuthorizationRepository,
} from "./types.js";

export const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1_000;

export interface ConnectorDependencies {
  readonly fetch?: FetchLike;
  readonly pending?: PendingAuthorizationRepository;
  readonly now?: () => number;
  readonly rotateSessionOnConnect?: boolean;
}

export interface ConnectionSummary {
  readonly connected: boolean;
  readonly provider: string;
  readonly fhirBaseUrl?: string;
  readonly patientId?: string;
  readonly scope?: readonly string[];
  readonly expiresAt?: string;
  readonly refreshable?: boolean;
  readonly durable?: boolean;
  readonly connectedAt?: string;
  readonly localSessionExpiresAt?: string;
}

export interface DisconnectSummary {
  readonly disconnected: true;
  readonly remoteRevocation: "success" | "not_supported" | "failed" | "not_applicable";
  readonly manualRevocationRecommended: boolean;
}

export class EpicConnectorService {
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #pending: PendingAuthorizationRepository;
  readonly #discovery: EpicDiscoveryService;
  readonly #oauth: EpicOAuthClient;
  readonly #idTokenVerifier: EpicIdTokenVerifier;
  readonly #tokenManager: EpicTokenManager;
  readonly #fhir: EpicFhirClient;
  readonly #rotateSessionOnConnect: boolean;
  #pruning = false;

  public constructor(
    public readonly config: AppConfig,
    private readonly store: ConnectionStore,
    dependencies: ConnectorDependencies = {},
  ) {
    this.#fetch = dependencies.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = dependencies.now ?? Date.now;
    this.#rotateSessionOnConnect = dependencies.rotateSessionOnConnect ?? true;
    this.#pending = dependencies.pending ?? new PendingAuthorizationStore(10 * 60 * 1_000, this.#now);
    this.#discovery = new EpicDiscoveryService(config, this.#fetch, this.#now);
    this.#oauth = new EpicOAuthClient(config, this.#fetch, this.#now);
    this.#idTokenVerifier = new EpicIdTokenVerifier(config, this.#fetch);
    this.#tokenManager = new EpicTokenManager(store, this.#oauth, this.#now);
    this.#fhir = new EpicFhirClient(config, this.#fetch);
  }

  public async initialize(pruneExpired = true): Promise<void> {
    await this.store.initialize();
    if (pruneExpired) await this.pruneExpiredConnections();
  }

  public async close(): Promise<void> {
    await this.store.close();
  }

  public async pruneExpiredConnections(): Promise<void> {
    if (this.#pruning) return;
    this.#pruning = true;
    try {
      for (const [sessionId, record] of await this.store.list()) {
        if (record.sessionExpiresAt > this.#now()) continue;
        await this.#tokenManager.disconnect(sessionId);
      }
    } finally {
      this.#pruning = false;
    }
  }

  public async startAuthorization(sessionId: string): Promise<string> {
    if (await this.#tokenManager.getConnection(sessionId)) {
      throw new AppError(
        409,
        "already_connected",
        "Disconnect the current MyChart account before connecting again.",
      );
    }
    const discovered = await this.#discovery.discover();
    if (await this.#tokenManager.getConnection(sessionId)) {
      throw new AppError(
        409,
        "already_connected",
        "Disconnect the current MyChart account before connecting again.",
      );
    }
    const state = randomBase64Url(32);
    const nonce = randomBase64Url(32);
    const pkce = createPkcePair();
    await this.#pending.create(state, {
      sessionId,
      createdAt: this.#now(),
      codeVerifier: pkce.verifier,
      nonce,
      discovery: discovered,
    });
    return this.#oauth.buildAuthorizationUrl(discovered, {
      state,
      nonce,
      codeChallenge: pkce.challenge,
    });
  }

  public async completeAuthorization(sessionId: string, rawUrl: string): Promise<string> {
    const callback = parseOAuthCallback(rawUrl);
    const authorization = await this.#pending.consume(callback.state, sessionId);
    try {
      if (callback.kind === "error") {
        throw new AppError(
          400,
          "authorization_denied",
          callback.error === "access_denied"
            ? "MyChart access was not authorized."
            : "MyChart returned an authorization error.",
        );
      }

      const token = await this.#oauth.exchangeCode(
        authorization.discovery.smart.tokenEndpoint,
        callback.code,
        authorization.codeVerifier,
        authorization.discovery.smart.revocationEndpoint,
      );
      let authenticatedSessionId: string | undefined;
      try {
        if (!token.patient) {
          throw new AppError(
            502,
            "missing_patient_context",
            "Epic did not return a patient context. Confirm that the Epic app's primary user type is Patients.",
          );
        }

        let fhirUser: string | undefined;
        if (this.config.scopes.includes("openid")) {
          const identity = await this.#idTokenVerifier.verify(
            token.id_token,
            authorization.discovery,
            authorization.nonce,
          );
          fhirUser = identity.fhirUser;
        }

        const connection: ConnectionRecord = {
          oauthClientId: this.config.clientId,
          fhirBaseUrl: authorization.discovery.fhirBaseUrl,
          tokenEndpoint: authorization.discovery.smart.tokenEndpoint,
          ...(authorization.discovery.smart.revocationEndpoint
            ? { revocationEndpoint: authorization.discovery.smart.revocationEndpoint }
            : {}),
          accessToken: token.access_token,
          ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
          tokenType: "Bearer",
          expiresAt: this.#now() + token.expires_in * 1_000,
          scope: token.scope ?? "",
          patientId: token.patient,
          ...(fhirUser ? { fhirUser } : {}),
          connectedAt: this.#now(),
          sessionExpiresAt: this.#now() + sessionLifetimeMs,
        };
        authenticatedSessionId = this.#rotateSessionOnConnect
          ? randomBase64Url(32)
          : sessionId;
        await this.#tokenManager.invalidate(sessionId);
        await this.store.set(authenticatedSessionId, connection);
        return authenticatedSessionId;
      } catch (error) {
        if (authenticatedSessionId) {
          await this.#tokenManager.invalidate(authenticatedSessionId).catch(() => undefined);
        }
        let revoked = false;
        const revocationEndpoint = authorization.discovery.smart.revocationEndpoint;
        if (revocationEndpoint) {
          try {
            await this.#oauth.revokeTokens(
              revocationEndpoint,
              token.access_token,
              token.refresh_token,
            );
            revoked = true;
          } catch {
            // The error below tells the patient how to remove the unsaved grant.
          }
        }
        if (!revoked) {
          throw new AppError(
            502,
            "authorization_cleanup_required",
            "The connection was not saved. Remove this app in MyChart's linked apps/devices settings before trying again.",
            { cause: error },
          );
        }
        throw error;
      }
    } finally {
      await this.#pending.deleteForSession(sessionId);
    }
  }

  public async getConnectionSummary(sessionId: string | undefined): Promise<ConnectionSummary> {
    const record = sessionId
      ? await this.#tokenManager.getConnection(sessionId)
      : undefined;
    if (!record) return { connected: false, provider: this.config.providerName };
    return {
      connected: true,
      provider: this.config.providerName,
      fhirBaseUrl: record.fhirBaseUrl,
      patientId: record.patientId,
      scope: record.scope.split(/\s+/).filter(Boolean),
      expiresAt: new Date(record.expiresAt).toISOString(),
      refreshable: Boolean(record.refreshToken),
      durable: Boolean(record.refreshToken) && this.store.durable === true,
      connectedAt: new Date(record.connectedAt).toISOString(),
      localSessionExpiresAt: new Date(record.sessionExpiresAt).toISOString(),
    };
  }

  public async readPatient(sessionId: string): Promise<unknown> {
    return this.withFhirConnection(sessionId, (record) => this.#fhir.readPatient(record));
  }

  public async search(
    sessionId: string,
    resourceType: string,
    search: URLSearchParams,
  ): Promise<unknown> {
    return this.withFhirConnection(sessionId, (record) =>
      this.#fhir.search(record, resourceType, search),
    );
  }

  public async disconnect(sessionId: string | undefined): Promise<DisconnectSummary> {
    if (!sessionId) {
      return {
        disconnected: true,
        remoteRevocation: "not_applicable",
        manualRevocationRecommended: false,
      };
    }

    await this.#pending.deleteForSession(sessionId);
    const outcome = await this.#tokenManager.disconnect(sessionId);
    return {
      disconnected: true,
      remoteRevocation: outcome.remoteRevocation,
      manualRevocationRecommended:
        outcome.hadConnection && outcome.remoteRevocation !== "success",
    };
  }

  private async withFhirConnection<T>(
    sessionId: string,
    action: (record: ConnectionRecord) => Promise<T>,
  ): Promise<T> {
    try {
      return await action(await this.#tokenManager.getValidConnection(sessionId));
    } catch (error) {
      if (error instanceof ReconnectRequiredError) {
        await this.#tokenManager.disconnect(sessionId);
      }
      throw error;
    }
  }
}
