import { createHmac } from "node:crypto";

import { AppError, ReconnectRequiredError } from "./errors.js";
import { EpicDiscoveryService } from "./discovery.js";
import {
  EpicFhirClient,
  isUserControllableSearchParameter,
  serverSupportsSmartSearch,
} from "./fhir.js";
import {
  DisabledFhirHubRepository,
  createFhirHubIdentity,
  type FhirHubExport,
  type FhirHubIntelligenceOptions,
  type FhirHubIntelligenceView,
  type FhirHubListOptions,
  type FhirHubRepository,
  type FhirHubResourceVersion,
  type FhirHubStatus,
} from "./fhir-hub.js";
import {
  assertGrantedSmartScopesWithinPolicy,
  parseSmartScopes,
  type SmartScopeConstraint,
} from "./smart-scopes.js";
import {
  EpicIdTokenVerifier,
  EpicOAuthClient,
  EpicTokenManager,
} from "./oauth.js";
import { decodePageCursor, encodePageCursor } from "./pagination.js";
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
  PendingAuthorization,
  PendingAuthorizationRepository,
} from "./types.js";

export interface ConnectorDependencies {
  readonly fetch?: FetchLike;
  readonly pending?: PendingAuthorizationRepository;
  readonly fhirHub?: FhirHubRepository;
  readonly now?: () => number;
  readonly rotateSessionOnConnect?: boolean;
}

export interface ConnectionSummary {
  readonly connected: boolean;
  readonly provider: string;
  readonly connectionContext?: string;
  readonly scope?: readonly string[];
  readonly capabilities?: readonly ResourceCapabilitySummary[];
  readonly expiresAt?: string;
  readonly refreshable?: boolean;
  readonly durable?: boolean;
  readonly connectedAt?: string;
  readonly localSessionExpiresAt?: string;
}

export interface ResourceCapabilitySummary {
  readonly resourceType: string;
  readonly read: boolean;
  readonly readConstraintAlternatives: readonly (readonly {
    readonly name: string;
    readonly value: string;
  }[])[];
  readonly search: boolean;
  readonly searchConstraints: readonly {
    readonly name: string;
    readonly values: readonly string[];
  }[];
}

export interface DisconnectSummary {
  readonly disconnected: true;
  readonly remoteRevocation: "success" | "not_supported" | "failed" | "not_applicable";
  readonly manualRevocationRecommended: boolean;
}

export interface DisconnectAllSummary {
  readonly disconnected: true;
  readonly connectionsRemoved: number;
  readonly manualRevocationRecommended: boolean;
}

export interface ConnectionBoundResult<T> {
  readonly value: T;
  readonly connectionContext: string;
}

export interface PageBoundResult<T> extends ConnectionBoundResult<T> {
  readonly resourceType: string;
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
  readonly #fhirHub: FhirHubRepository;
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
    this.#tokenManager = new EpicTokenManager(
      store,
      this.#oauth,
      this.#now,
      config.sessionIdleTimeoutMs,
      config.consentPolicyVersion,
    );
    this.#fhir = new EpicFhirClient(config, this.#fetch);
    this.#fhirHub = dependencies.fhirHub ?? new DisabledFhirHubRepository();
  }

  public async initialize(pruneExpired = true): Promise<void> {
    await this.store.initialize();
    try {
      await this.#fhirHub.initialize();
      if (pruneExpired) await this.pruneExpiredConnections();
    } catch (error) {
      await this.#fhirHub.close().catch(() => undefined);
      await this.store.close().catch(() => undefined);
      throw error;
    }
  }

  public async close(): Promise<void> {
    await Promise.all([
      this.store.close(),
      this.#fhirHub.close(),
    ]);
  }

  public async checkReadiness(): Promise<void> {
    await this.store.list();
    if (this.config.fhirHubEnabled) await this.#fhirHub.checkReadiness();
  }

  public async pruneExpiredConnections(): Promise<void> {
    if (this.#pruning) return;
    this.#pruning = true;
    try {
      for (const [sessionId, record] of await this.store.list()) {
        const lastAccessAt = record.lastAccessAt ?? record.connectedAt;
        if (
          record.sessionExpiresAt > this.#now() &&
          lastAccessAt + this.config.sessionIdleTimeoutMs > this.#now() &&
          record.consent?.policyVersion === this.config.consentPolicyVersion &&
          record.oidcIssuer &&
          record.oidcSubject &&
          record.fhirCapabilities &&
          this.#oauth.isConnectionCompatible(record)
        ) continue;
        await this.#tokenManager.disconnect(sessionId);
      }
      if (this.config.fhirHubEnabled) await this.#fhirHub.pruneExpired(this.#now());
    } finally {
      this.#pruning = false;
    }
  }

  public async startAuthorization(
    sessionId: string,
    acceptedPolicyVersion: string,
  ): Promise<string> {
    if (acceptedPolicyVersion !== this.config.consentPolicyVersion) {
      throw new AppError(
        409,
        "consent_required",
        "Review and accept the current Terms and Privacy Notice before connecting.",
      );
    }
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
    const authorizationUrl = this.#oauth.buildAuthorizationUrl(discovered, {
      state,
      nonce,
      codeChallenge: pkce.challenge,
    });
    await this.#pending.create(state, {
      sessionId,
      createdAt: this.#now(),
      oauthClientId: this.config.clientId,
      redirectUri: this.config.redirectUri,
      tokenAuthMethod: this.config.tokenAuthMethod,
      codeVerifier: pkce.verifier,
      nonce,
      consent: {
        policyVersion: this.config.consentPolicyVersion,
        acceptedAt: this.#now(),
        purpose: "patient-access",
        requestedScopes: [...this.config.scopes],
        allowedResourceScopes: [...this.config.allowedResourceScopes],
      },
      discovery: discovered,
    });
    return authorizationUrl;
  }

  public async completeAuthorization(sessionId: string, rawUrl: string): Promise<string> {
    const callback = parseOAuthCallback(rawUrl);
    const authorization = await this.#pending.consume(callback.state, sessionId);
    try {
      this.assertPendingAuthorizationCurrent(authorization);
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
        if (
          token.refresh_token &&
          (
            !authorization.consent.requestedScopes.includes("offline_access") ||
            (token.scope !== undefined &&
              !token.scope.split(/\s+/).includes("offline_access"))
          )
        ) {
          throw new AppError(
            502,
            "unexpected_refresh_token",
            "Epic returned persistent access that this application did not request. The grant was not saved.",
          );
        }
        if (!token.patient) {
          throw new AppError(
            502,
            "missing_patient_context",
            "Epic did not return a patient context. Confirm that the Epic app's primary user type is Patients.",
          );
        }
        if (!token.scope?.trim()) {
          throw new AppError(
            502,
            "missing_token_scope",
            "Epic did not describe the access granted to this connection. The grant was not saved.",
          );
        }

        let fhirUser: string | undefined;
        let oidcIssuer: string | undefined;
        let oidcSubject: string | undefined;
        if (this.config.scopes.includes("openid")) {
          const identity = await this.#idTokenVerifier.verify(
            token.id_token,
            authorization.discovery,
            authorization.nonce,
          );
          fhirUser = identity.fhirUser;
          oidcIssuer = identity.issuer;
          oidcSubject = identity.subject;
        }
        if (!oidcIssuer || !oidcSubject) {
          throw new AppError(
            401,
            "missing_verified_identity",
            "Epic did not return a verifiable user identity.",
          );
        }

        const effectiveScope = token.scope;
        assertGrantedSmartScopesWithinPolicy(
          effectiveScope,
          authorization.consent.requestedScopes,
          authorization.consent.allowedResourceScopes ?? [],
        );
        const connection: ConnectionRecord = {
          oauthClientId: this.config.clientId,
          tokenAuthMethod: this.config.tokenAuthMethod,
          fhirBaseUrl: authorization.discovery.fhirBaseUrl,
          tokenEndpoint: authorization.discovery.smart.tokenEndpoint,
          ...(authorization.discovery.smart.revocationEndpoint
            ? { revocationEndpoint: authorization.discovery.smart.revocationEndpoint }
            : {}),
          accessToken: token.access_token,
          ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
          tokenType: "Bearer",
          expiresAt: this.#now() + token.expires_in * 1_000,
          // Epic's standalone response must report the combined authorization
          // and Incoming API grant; omission is rejected above rather than
          // inferring resource access from local configuration.
          scope: effectiveScope,
          patientId: token.patient,
          ...(fhirUser ? { fhirUser } : {}),
          oidcIssuer,
          oidcSubject,
          consent: authorization.consent,
          fhirCapabilities: authorization.discovery.fhirCapabilities,
          connectedAt: this.#now(),
          lastAccessAt: this.#now(),
          sessionExpiresAt: this.#now() + this.config.sessionMaxLifetimeMs,
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
    const granted = parseSmartScopes(record.scope).filter((grant) => grant.context === "patient");
    const serverCapabilities = new Map(
      (record.fhirCapabilities ?? []).map((capability) => [capability.resourceType, capability]),
    );
    const hasUnrestrictedGrant = (
      resourceType: string,
      permission: "read" | "search",
    ): boolean => granted.some((grant) =>
      (grant.resourceType === resourceType || grant.resourceType === "*") &&
      grant.permissions.has(permission) &&
      grant.constraints.length === 0);
    const encounterServer = serverCapabilities.get("Encounter");
    const locationServer = serverCapabilities.get("Location");
    const canDeriveEncounterLocations =
      this.config.allowedResourceTypes.has("Encounter") &&
      this.config.allowedResourceTypes.has("Location") &&
      locationServer?.interactions.includes("read") === true &&
      encounterServer?.interactions.includes("search") === true &&
      serverSupportsSmartSearch("Encounter", encounterServer.searchParameters) &&
      hasUnrestrictedGrant("Encounter", "search") &&
      hasUnrestrictedGrant("Location", "read");
    const resourceTypes = ["Patient", ...this.config.allowedResourceTypes];
    const capabilities: ResourceCapabilitySummary[] = [];
    for (const resourceType of resourceTypes) {
      const resourceGrants = granted.filter((grant) =>
        grant.resourceType === resourceType || grant.resourceType === "*");
      const server = serverCapabilities.get(resourceType);
      const readableGrants = resourceGrants.filter((grant) =>
        grant.permissions.has("read") &&
        grant.constraints.every(({ name }) => isUserControllableSearchParameter(name))
      );
      const readConstraintAlternatives = resourceType !== "Binary" &&
          server?.interactions.includes("read")
        ? [...new Map(readableGrants.map((grant) => {
            const constraints = grant.constraints.map(({ name, value }) => ({ name, value }));
            return [JSON.stringify(constraints), constraints] as const;
          })).values()]
        : [];
      const read = readConstraintAlternatives.length > 0;
      const searchableGrants = resourceGrants.filter((grant) =>
        grant.permissions.has("search") &&
        serverSupportsSmartSearch(
          resourceType,
          server?.searchParameters ?? [],
          grant.constraints.map(({ name }) => name),
        ));
      const grantsByVisibleConstraints = new Map<
        string,
        typeof searchableGrants
      >();
      for (const grant of searchableGrants) {
        const visibleConstraints = grant.constraints.filter(({ name }) =>
          isUserControllableSearchParameter(name));
        const key = JSON.stringify(
          visibleConstraints.map(({ name, value }) => [name, value]),
        );
        const group = grantsByVisibleConstraints.get(key) ?? [];
        grantsByVisibleConstraints.set(key, [...group, grant]);
      }
      const representableSearchableGrants = searchableGrants.some(
        (grant) => grant.constraints.length === 0,
      )
        ? searchableGrants
        : [...grantsByVisibleConstraints.values()].flatMap((group) => {
            const fullyUserControllable = group.find((grant) =>
              grant.constraints.every(({ name }) =>
                isUserControllableSearchParameter(name)));
            if (fullyUserControllable) return [fullyUserControllable];
            // A single server-added narrowing constraint can be injected by the
            // FHIR client. Multiple grants with the same visible choice would
            // be ambiguous, so do not advertise that unusable UI action.
            return group.length === 1 ? group : [];
          });
      const search = resourceType === "Location"
        ? canDeriveEncounterLocations
        : Boolean(
            server?.interactions.includes("search") &&
            representableSearchableGrants.length > 0,
          );
      if (!read && !search) continue;
      const constraintValues = new Map<string, Set<string>>();
      if (
        resourceType !== "Location" &&
        !representableSearchableGrants.some((grant) => grant.constraints.length === 0)
      ) {
        for (const grant of representableSearchableGrants) {
          for (const constraint of grant.constraints) {
            if (!isUserControllableSearchParameter(constraint.name)) continue;
            const values = constraintValues.get(constraint.name) ?? new Set<string>();
            values.add(constraint.value);
            constraintValues.set(constraint.name, values);
          }
        }
      }
      capabilities.push({
        resourceType,
        read,
        readConstraintAlternatives,
        search,
        searchConstraints: [...constraintValues].map(([name, values]) => ({
          name,
          values: [...values].sort(),
        })),
      });
    }
    return {
      connected: true,
      provider: this.config.providerName,
      connectionContext: this.connectionContext(sessionId!, record),
      scope: record.scope.split(/\s+/).filter(Boolean),
      capabilities,
      expiresAt: new Date(record.expiresAt).toISOString(),
      refreshable: Boolean(record.refreshToken),
      durable: Boolean(record.refreshToken) && this.store.durable === true,
      connectedAt: new Date(record.connectedAt).toISOString(),
      localSessionExpiresAt: new Date(record.sessionExpiresAt).toISOString(),
    };
  }

  public async readPatient(sessionId: string): Promise<unknown> {
    return (await this.withBoundFhirConnection(
      sessionId,
      async (record) => {
        const value = await this.#fhir.readPatient(record);
        await this.ingestFhirResponse(record, value);
        return value;
      },
    )).value;
  }

  public async readPatientBound(
    sessionId: string,
    expectedConnectionContext: string | undefined,
  ): Promise<ConnectionBoundResult<unknown>> {
    return this.withBoundFhirConnection(
      sessionId,
      async (record) => {
        const value = await this.#fhir.readPatient(record);
        await this.ingestFhirResponse(record, value);
        return value;
      },
      expectedConnectionContext,
      true,
    );
  }

  public async read(
    sessionId: string,
    resourceType: string,
    id: string,
  ): Promise<unknown> {
    return (await this.withBoundFhirConnection(sessionId, async (record) => {
      const value = await this.#fhir.read(record, resourceType, id);
      await this.ingestFhirResponse(record, value);
      return value;
    })).value;
  }

  public async readBound(
    sessionId: string,
    resourceType: string,
    id: string,
    expectedConnectionContext: string | undefined,
  ): Promise<ConnectionBoundResult<unknown>> {
    return this.withBoundFhirConnection(
      sessionId,
      async (record) => {
        const value = await this.#fhir.read(record, resourceType, id);
        await this.ingestFhirResponse(record, value);
        return value;
      },
      expectedConnectionContext,
      true,
    );
  }

  public async search(
    sessionId: string,
    resourceType: string,
    search: URLSearchParams,
  ): Promise<unknown> {
    return (await this.searchWithBoundContext(
      sessionId,
      resourceType,
      search,
    )).value;
  }

  public async searchBound(
    sessionId: string,
    resourceType: string,
    search: URLSearchParams,
    expectedConnectionContext: string | undefined,
  ): Promise<ConnectionBoundResult<unknown>> {
    return this.searchWithBoundContext(
      sessionId,
      resourceType,
      search,
      expectedConnectionContext,
      true,
    );
  }

  private async searchWithBoundContext(
    sessionId: string,
    resourceType: string,
    search: URLSearchParams,
    expectedConnectionContext?: string,
    requireExpectedConnectionContext = false,
  ): Promise<ConnectionBoundResult<unknown>> {
    return this.withBoundFhirConnection(sessionId, async (record) => {
      const result = await this.#fhir.searchWithContext(record, resourceType, search);
      await this.ingestFhirResponse(record, result.bundle);
      return this.decorateSearchBundle(
        sessionId,
        resourceType,
        result.bundle,
        1,
        result.constraints,
        result.includeProvenance,
      );
    }, expectedConnectionContext, requireExpectedConnectionContext);
  }

  public async page(sessionId: string, cursorToken: string): Promise<unknown> {
    return (await this.pageWithBoundContext(sessionId, cursorToken)).value;
  }

  public async pageBound(
    sessionId: string,
    cursorToken: string,
    expectedConnectionContext: string | undefined,
  ): Promise<PageBoundResult<unknown>> {
    return this.pageWithBoundContext(
      sessionId,
      cursorToken,
      expectedConnectionContext,
      true,
    );
  }

  private async pageWithBoundContext(
    sessionId: string,
    cursorToken: string,
    expectedConnectionContext?: string,
    requireExpectedConnectionContext = false,
  ): Promise<PageBoundResult<unknown>> {
    const cursor = decodePageCursor(
      cursorToken,
      sessionId,
      this.config.sessionSecret,
      this.#now(),
    );
    const constraints = cursor.constraints ?? [];
    const result = await this.withBoundFhirConnection(sessionId, async (record) => {
      const result = await this.#fhir.page(
        record,
        cursor.resourceType,
        cursor.nextUrl,
        constraints,
        cursor.includeProvenance === true,
      );
      await this.ingestFhirResponse(record, result);
      return this.decorateSearchBundle(
        sessionId,
        cursor.resourceType,
        result,
        cursor.page,
        constraints,
        cursor.includeProvenance === true,
      );
    }, expectedConnectionContext, requireExpectedConnectionContext);
    return { ...result, resourceType: cursor.resourceType };
  }

  public async getFhirHubStatusBound(
    sessionId: string,
    expectedConnectionContext: string | undefined,
  ): Promise<ConnectionBoundResult<FhirHubStatus>> {
    return this.withBoundFhirConnection(
      sessionId,
      async (record) => {
        if (!this.config.fhirHubEnabled) {
          return {
            available: false,
            enabled: false,
            consentCurrent: false,
            consentPolicyVersion: this.config.fhirHubConsentVersion,
            currentResourceCount: 0,
            resourceVersionCount: 0,
            careTeamCount: 0,
            normalizedResourceCount: 0,
            normalizationFailureCount: 0,
            insightCount: 0,
          };
        }
        return this.#fhirHub.status(
          createFhirHubIdentity(this.config, record),
          this.config.fhirHubConsentVersion,
          this.#now(),
        );
      },
      expectedConnectionContext,
      true,
    );
  }

  public async enableFhirHubBound(
    sessionId: string,
    acceptedPolicyVersion: string,
    expectedConnectionContext: string | undefined,
  ): Promise<ConnectionBoundResult<FhirHubStatus>> {
    this.requireFhirHubAvailable();
    if (acceptedPolicyVersion !== this.config.fhirHubConsentVersion) {
      throw new AppError(
        409,
        "fhir_hub_consent_required",
        "Review and accept the current private health hub notice before enabling storage.",
      );
    }
    return this.withBoundFhirConnection(
      sessionId,
      (record) => this.#fhirHub.enable(
        createFhirHubIdentity(this.config, record),
        {
          schemaVersion: 1,
          purpose: "longitudinal-health-hub",
          policyVersion: this.config.fhirHubConsentVersion,
          acceptedAt: new Date(this.#now()).toISOString(),
          retentionMs: this.config.fhirHubRetentionMs,
        },
      ),
      expectedConnectionContext,
      true,
    );
  }

  public async listFhirHubResourcesBound(
    sessionId: string,
    options: FhirHubListOptions,
    expectedConnectionContext: string | undefined,
  ): Promise<ConnectionBoundResult<readonly FhirHubResourceVersion[]>> {
    this.requireFhirHubAvailable();
    if (options.resourceType !== undefined &&
      !/^[A-Z][A-Za-z0-9]{0,63}$/.test(options.resourceType)) {
      throw new AppError(400, "invalid_resource_type", "The FHIR resource type is invalid.");
    }
    if (options.limit !== undefined &&
      (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1_000)) {
      throw new AppError(400, "invalid_hub_limit", "The health hub result limit must be between 1 and 1000.");
    }
    return this.withBoundFhirConnection(
      sessionId,
      async (record) => {
        await this.#fhirHub.pruneExpired(this.#now());
        return this.#fhirHub.list(createFhirHubIdentity(this.config, record), options);
      },
      expectedConnectionContext,
      true,
    );
  }

  public async getFhirHubIntelligenceBound(
    sessionId: string,
    options: FhirHubIntelligenceOptions,
    expectedConnectionContext: string | undefined,
  ): Promise<ConnectionBoundResult<FhirHubIntelligenceView>> {
    this.requireFhirHubAvailable();
    if (options.resourceType !== undefined &&
      !/^[A-Z][A-Za-z0-9]{0,63}$/.test(options.resourceType)) {
      throw new AppError(400, "invalid_resource_type", "The FHIR resource type is invalid.");
    }
    if (options.limit !== undefined &&
      (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 250)) {
      throw new AppError(
        400,
        "invalid_hub_limit",
        "The intelligence result limit must be between 1 and 250.",
      );
    }
    return this.withBoundFhirConnection(
      sessionId,
      async (record) => {
        await this.#fhirHub.pruneExpired(this.#now());
        return this.#fhirHub.intelligence(createFhirHubIdentity(this.config, record), options);
      },
      expectedConnectionContext,
      true,
    );
  }

  public async exportFhirHubBound(
    sessionId: string,
    expectedConnectionContext: string | undefined,
  ): Promise<ConnectionBoundResult<FhirHubExport>> {
    this.requireFhirHubAvailable();
    return this.withBoundFhirConnection(
      sessionId,
      (record) => this.#fhirHub.exportAccount(
        createFhirHubIdentity(this.config, record),
        this.#now(),
      ),
      expectedConnectionContext,
      true,
    );
  }

  public async deleteFhirHubBound(
    sessionId: string,
    confirmation: string,
    expectedConnectionContext: string | undefined,
  ): Promise<ConnectionBoundResult<{
    readonly deleted: true;
    readonly resourcesDeleted: number | null;
  }>> {
    this.requireFhirHubAvailable();
    if (confirmation !== "DELETE MY HEALTH HUB") {
      throw new AppError(
        400,
        "fhir_hub_delete_confirmation_required",
        "Type the exact deletion confirmation before permanently deleting the private health hub.",
      );
    }
    return this.withBoundFhirConnection(
      sessionId,
      (record) => this.#fhirHub.deleteAccount(createFhirHubIdentity(this.config, record)),
      expectedConnectionContext,
      true,
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

  public async getAccountRegistration(sessionId: string): Promise<{
    readonly accountRef: string;
    readonly expiresAt: number;
  }> {
    const record = await this.#tokenManager.getValidConnection(sessionId);
    return {
      accountRef: this.accountReference(record),
      expiresAt: record.sessionExpiresAt,
    };
  }

  public async assertConnectionContext(
    sessionId: string,
    expectedConnectionContext: string | undefined,
  ): Promise<void> {
    const record = await this.#tokenManager.getValidConnection(sessionId);
    this.requireExpectedConnectionContext(sessionId, record, expectedConnectionContext);
  }

  public async disconnectAllForAccount(sessionId: string): Promise<DisconnectAllSummary> {
    const current = await this.#tokenManager.getValidConnection(sessionId);
    return this.disconnectAccountReference(this.accountReference(current));
  }

  /**
   * Removes every local connection for an opaque, server-generated account
   * reference. This is intentionally exposed only to the Worker Durable Object
   * coordination layer; callers never receive the underlying OIDC identity.
   */
  public async disconnectAccountReference(accountRef: string): Promise<DisconnectAllSummary> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(accountRef)) {
      throw new AppError(400, "invalid_account_reference", "The account reference is invalid.");
    }
    let connectionsRemoved = 0;
    let manualRevocationRecommended = false;
    for (const [candidateSessionId, record] of await this.store.list()) {
      if (!record.oidcIssuer || !record.oidcSubject) continue;
      if (this.accountReference(record) !== accountRef) continue;
      await this.#pending.deleteForSession(candidateSessionId);
      const outcome = await this.#tokenManager.disconnect(candidateSessionId);
      if (outcome.hadConnection) connectionsRemoved += 1;
      if (outcome.hadConnection && outcome.remoteRevocation !== "success") {
        manualRevocationRecommended = true;
      }
    }
    return {
      disconnected: true,
      connectionsRemoved,
      manualRevocationRecommended,
    };
  }

  private requireFhirHubAvailable(): void {
    if (!this.config.fhirHubEnabled) {
      throw new AppError(503, "fhir_hub_unavailable", "The private health hub is not configured.");
    }
  }

  private async ingestFhirResponse(record: ConnectionRecord, value: unknown): Promise<void> {
    if (!this.config.fhirHubEnabled) return;
    await this.#fhirHub.ingest(
      createFhirHubIdentity(this.config, record),
      value,
      this.config.fhirHubConsentVersion,
      this.#now(),
    );
  }

  private async withBoundFhirConnection<T>(
    sessionId: string,
    action: (record: ConnectionRecord) => Promise<T>,
    expectedConnectionContext?: string,
    requireExpectedConnectionContext = false,
  ): Promise<ConnectionBoundResult<T>> {
    try {
      const record = await this.#tokenManager.getValidConnection(sessionId);
      const connectionContext = requireExpectedConnectionContext
        ? this.requireExpectedConnectionContext(
            sessionId,
            record,
            expectedConnectionContext,
          )
        : this.connectionContext(sessionId, record);
      const value = await action(record);
      const current = await this.#tokenManager.getConnection(sessionId);
      if (
        !current ||
        this.connectionContext(sessionId, current) !== connectionContext
      ) {
        throw new ReconnectRequiredError(
          "The MyChart connection ended before the health data response could be returned.",
        );
      }
      return {
        value,
        connectionContext,
      };
    } catch (error) {
      if (error instanceof ReconnectRequiredError) {
        await this.#tokenManager.disconnect(sessionId);
      }
      throw error;
    }
  }

  private requireExpectedConnectionContext(
    sessionId: string,
    record: ConnectionRecord,
    expectedConnectionContext: string | undefined,
  ): string {
    const connectionContext = this.connectionContext(sessionId, record);
    if (
      !expectedConnectionContext ||
      !/^[A-Za-z0-9_-]{43}$/.test(expectedConnectionContext) ||
      expectedConnectionContext !== connectionContext
    ) {
      throw new AppError(
        409,
        "connection_context_changed",
        "The MyChart account context changed. Review the current connection before continuing.",
      );
    }
    return connectionContext;
  }

  private connectionContext(sessionId: string, record: ConnectionRecord): string {
    if (!record.oidcIssuer || !record.oidcSubject) {
      throw new ReconnectRequiredError("The saved connection has no verified account identity.");
    }
    return createHmac("sha256", this.config.sessionSecret)
      .update("epic-connection-context\0", "utf8")
      .update(sessionId, "utf8")
      .update("\0", "utf8")
      .update(record.oidcIssuer, "utf8")
      .update("\0", "utf8")
      .update(record.oidcSubject, "utf8")
      .update("\0", "utf8")
      .update(String(record.connectedAt), "utf8")
      .digest("base64url");
  }

  private accountReference(record: ConnectionRecord): string {
    if (!record.oidcIssuer || !record.oidcSubject) {
      throw new ReconnectRequiredError("The saved connection has no verified account identity.");
    }
    if (this.config.fhirHubIdentityKey) {
      return createFhirHubIdentity(this.config, record).accountRef;
    }
    return createHmac("sha256", this.config.sessionSecret)
      .update("epic-account\0", "utf8")
      .update(record.oidcIssuer, "utf8")
      .update("\0", "utf8")
      .update(record.oidcSubject, "utf8")
      .digest("base64url");
  }

  private assertPendingAuthorizationCurrent(
    authorization: PendingAuthorization,
  ): void {
    const sameScopes = this.sameScopeSet(
      authorization.consent.requestedScopes,
      this.config.scopes,
    );
    const sameResourceScopePolicy =
      authorization.consent.allowedResourceScopes !== undefined &&
      this.sameScopeSet(
        authorization.consent.allowedResourceScopes,
        this.config.allowedResourceScopes,
      );
    const endpoints = [
      authorization.discovery.smart.authorizationEndpoint,
      authorization.discovery.smart.tokenEndpoint,
      authorization.discovery.smart.revocationEndpoint,
      authorization.discovery.oidc.issuer,
      authorization.discovery.oidc.jwksUri,
    ].filter((value): value is string => Boolean(value));
    if (
      authorization.oauthClientId !== this.config.clientId ||
      authorization.redirectUri !== this.config.redirectUri ||
      authorization.tokenAuthMethod !== this.config.tokenAuthMethod ||
      authorization.consent.policyVersion !== this.config.consentPolicyVersion ||
      authorization.discovery.fhirBaseUrl !== this.config.fhirBaseUrl ||
      !sameScopes ||
      !sameResourceScopePolicy ||
      endpoints.some((endpoint) => !this.isCurrentlyTrustedEndpoint(endpoint))
    ) {
      throw new AppError(
        409,
        "authorization_context_changed",
        "The connection settings or consent notice changed while MyChart authorization was in progress. Start again and review the current request.",
      );
    }
  }

  private sameScopeSet(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    const leftScopes = new Set(left);
    const rightScopes = new Set(right);
    return leftScopes.size === left.length &&
      rightScopes.size === right.length &&
      [...leftScopes].every((scope) => rightScopes.has(scope));
  }

  private isCurrentlyTrustedEndpoint(value: string): boolean {
    try {
      const endpoint = new URL(value);
      return endpoint.protocol === "https:" &&
        !endpoint.username &&
        !endpoint.password &&
        !endpoint.search &&
        !endpoint.hash &&
        this.config.trustedEndpointOrigins.has(endpoint.origin);
    } catch {
      return false;
    }
  }

  private decorateSearchBundle(
    sessionId: string,
    resourceType: string,
    value: unknown,
    page: number,
    constraints: readonly SmartScopeConstraint[],
    includeProvenance: boolean,
  ): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const bundle = value as Record<string, unknown>;
    const links = Array.isArray(bundle.link) ? bundle.link : [];
    let nextUrl: string | undefined;
    for (const candidate of links) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const link = candidate as Record<string, unknown>;
      if (link.relation === "next" && typeof link.url === "string") {
        nextUrl = link.url;
        break;
      }
    }
    const safeLinks = nextUrl && page < 10
      ? [{
          relation: "next",
          url: `/api/fhir-page?cursor=${encodeURIComponent(encodePageCursor({
            resourceType,
            nextUrl,
            page: page + 1,
            expiresAt: this.#now() + 10 * 60 * 1_000,
            constraints: constraints.map(({ name, value }) => ({ name, value })),
            ...(includeProvenance ? { includeProvenance: true as const } : {}),
          }, sessionId, this.config.sessionSecret))}`,
        }]
      : [];
    return { ...bundle, link: safeLinks };
  }
}
