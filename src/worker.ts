import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";

import {
  emitAudit,
  newRequestId,
  productionAuditSink,
  pseudonymousSessionRef,
} from "./audit.js";
import { EpicConnectorService } from "./connector.js";
import { loadConfig } from "./config.js";
import { AppError, ReconnectRequiredError } from "./errors.js";
import { authorizationClientRateLimitKey } from "./rate-limit.js";
import { randomBase64Url } from "./security.js";
import {
  readWorkerSessionContext,
  WorkerHttpApplication,
  workerErrorResponse,
  workerJsonResponse,
  workerNotFoundResponse,
  workerResponse,
} from "./worker-app.js";
import {
  DurableObjectConnectionStore,
  DurableObjectPendingAuthorizationStore,
  type DurableObjectEncryptionKeyring,
} from "./worker-storage.js";
import {
  EpicFhirHub,
  WorkerFhirHubRepository,
  fhirHubReadinessIdentity,
} from "./worker-fhir-hub.js";
import {
  browserScript,
  renderHome,
  renderPrivacy,
  renderTerms,
  styles,
} from "./ui.js";

export { EpicFhirHub };

const pruneIntervalMs = 60 * 60 * 1_000;
const pendingPruneIntervalMs = 10 * 60 * 1_000;
const routedSessionHeader = "X-Epic-Worker-Session";
const routedRouteHeader = "X-Epic-Worker-Route";
const sessionIdPattern = /^[A-Za-z0-9_-]{40,100}$/;
const accountReferencePattern = /^[A-Za-z0-9_-]{43}$/;
const routeNamePattern = /^[a-f0-9]{64}$/;
const readinessRouteId = "r".repeat(43);
const registryObjectName = "epic-connection-registry-v1";
const registryDeleteLockMs = 5 * 60 * 1_000;
const registryMaximumLifetimeMs = 25 * 60 * 60 * 1_000;
const registryPurgeConcurrency = 10;

interface RegistryRouteRow extends Record<string, SqlStorageValue> {
  readonly route_name: string;
}

interface RegistryMinimumRow extends Record<string, SqlStorageValue> {
  readonly minimum: number | null;
}

export interface RegistryDisconnectBatch {
  readonly accountRef: string;
  readonly deletionId: string;
  readonly routeNames: readonly string[];
}

interface WorkerBindings {
  readonly EPIC_CONNECTOR: DurableObjectNamespace<EpicConnector>;
  readonly EPIC_CONNECTION_REGISTRY: DurableObjectNamespace<EpicConnectionRegistry>;
  readonly EPIC_FHIR_HUB: DurableObjectNamespace<EpicFhirHub>;
  readonly APP_LEGAL_NAME?: string;
  readonly APP_LEGAL_CONTACT_EMAIL?: string;
  readonly APP_LEGAL_EFFECTIVE_DATE?: string;
  readonly APP_HOSTING_PROVIDER_NAME?: string;
  readonly EPIC_CLIENT_ID?: string;
  readonly EPIC_CLIENT_SECRET?: string;
  readonly EPIC_TOKEN_AUTH_METHOD?: string;
  readonly EPIC_FHIR_BASE_URL?: string;
  readonly EPIC_PROVIDER_NAME?: string;
  readonly EPIC_REDIRECT_URI?: string;
  readonly EPIC_SCOPES?: string;
  readonly EPIC_ALLOWED_RESOURCE_SCOPES?: string;
  readonly EPIC_REQUEST_OFFLINE_ACCESS?: string;
  readonly EPIC_ALLOWED_RESOURCE_TYPES?: string;
  readonly EPIC_PRIVATE_KEY_PEM?: string;
  readonly EPIC_PRIVATE_KEY_ALG?: string;
  readonly EPIC_PRIVATE_KEY_KID?: string;
  readonly SESSION_SECRET?: string;
  readonly TOKEN_ENCRYPTION_KEY?: string;
  readonly TOKEN_ENCRYPTION_KEY_ID?: string;
  readonly TOKEN_ENCRYPTION_PREVIOUS_KEYS?: string;
  readonly FHIR_HUB_ENABLED?: string;
  readonly FHIR_HUB_ENCRYPTION_KEY?: string;
  readonly FHIR_HUB_IDENTITY_KEY?: string;
  readonly FHIR_HUB_CONSENT_VERSION?: string;
  readonly FHIR_HUB_RETENTION_DAYS?: string;
  readonly CONSENT_POLICY_VERSION?: string;
  readonly SESSION_IDLE_TIMEOUT_SECONDS?: string;
  readonly SESSION_MAX_LIFETIME_SECONDS?: string;
  readonly EPIC_TRUSTED_ENDPOINT_ORIGINS?: string;
  readonly AUTH_RATE_LIMITER: RateLimit;
  readonly API_RATE_LIMITER: RateLimit;
}

function encryptionKeyring(
  env: WorkerBindings,
  currentKey: Buffer,
  forbiddenKeys: readonly Buffer[] = [],
): DurableObjectEncryptionKeyring {
  const currentKeyId = env.TOKEN_ENCRYPTION_KEY_ID?.trim() || "current-v1";
  const keys = new Map<string, Buffer>([[currentKeyId, currentKey]]);
  const previous = env.TOKEN_ENCRYPTION_PREVIOUS_KEYS?.trim();
  if (previous) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(previous);
    } catch (error) {
      throw new AppError(
        500,
        "invalid_config",
        "TOKEN_ENCRYPTION_PREVIOUS_KEYS must be a JSON object of key IDs to base64 keys.",
        { cause: error },
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AppError(
        500,
        "invalid_config",
        "TOKEN_ENCRYPTION_PREVIOUS_KEYS must be a JSON object of key IDs to base64 keys.",
      );
    }
    for (const [keyId, encoded] of Object.entries(parsed)) {
      if (typeof encoded !== "string") {
        throw new AppError(500, "invalid_config", "Every previous encryption key must be base64 text.");
      }
      if (keyId === currentKeyId) {
        throw new AppError(
          500,
          "invalid_config",
          "TOKEN_ENCRYPTION_PREVIOUS_KEYS cannot replace the current encryption key ID.",
        );
      }
      const normalized = encoded.trim();
      if (!/^[A-Za-z0-9+/]{43}=$/.test(normalized)) {
        throw new AppError(
          500,
          "invalid_config",
          "Every previous encryption key must be canonical base64 for exactly 32 bytes.",
        );
      }
      const decoded = Buffer.from(normalized, "base64");
      if (
        decoded.length !== 32 ||
        decoded.toString("base64") !== normalized ||
        forbiddenKeys.some((forbidden) => decoded.equals(forbidden))
      ) {
        throw new AppError(
          500,
          "invalid_config",
          "Previous token keys must be valid 32-byte values distinct from FHIR hub keys.",
        );
      }
      keys.set(keyId, decoded);
    }
  }
  return { currentKeyId, keys };
}

function configurationEnvironment(
  env: WorkerBindings,
): Record<string, string | undefined> {
  return {
    APP_LEGAL_NAME: env.APP_LEGAL_NAME,
    APP_LEGAL_CONTACT_EMAIL: env.APP_LEGAL_CONTACT_EMAIL,
    APP_LEGAL_EFFECTIVE_DATE: env.APP_LEGAL_EFFECTIVE_DATE,
    APP_HOSTING_PROVIDER_NAME: env.APP_HOSTING_PROVIDER_NAME,
    EPIC_CLIENT_ID: env.EPIC_CLIENT_ID,
    EPIC_CLIENT_SECRET: env.EPIC_CLIENT_SECRET,
    EPIC_TOKEN_AUTH_METHOD: env.EPIC_TOKEN_AUTH_METHOD,
    EPIC_FHIR_BASE_URL: env.EPIC_FHIR_BASE_URL,
    EPIC_PROVIDER_NAME: env.EPIC_PROVIDER_NAME,
    EPIC_REDIRECT_URI: env.EPIC_REDIRECT_URI,
    EPIC_SCOPES: env.EPIC_SCOPES,
    EPIC_ALLOWED_RESOURCE_SCOPES: env.EPIC_ALLOWED_RESOURCE_SCOPES,
    EPIC_REQUEST_OFFLINE_ACCESS: env.EPIC_REQUEST_OFFLINE_ACCESS,
    EPIC_ALLOWED_RESOURCE_TYPES: env.EPIC_ALLOWED_RESOURCE_TYPES,
    EPIC_PRIVATE_KEY_PEM: env.EPIC_PRIVATE_KEY_PEM,
    EPIC_PRIVATE_KEY_ALG: env.EPIC_PRIVATE_KEY_ALG,
    EPIC_PRIVATE_KEY_KID: env.EPIC_PRIVATE_KEY_KID,
    SESSION_SECRET: env.SESSION_SECRET,
    TOKEN_ENCRYPTION_KEY: env.TOKEN_ENCRYPTION_KEY,
    FHIR_HUB_ENABLED: env.FHIR_HUB_ENABLED,
    FHIR_HUB_ENCRYPTION_KEY: env.FHIR_HUB_ENCRYPTION_KEY,
    FHIR_HUB_IDENTITY_KEY: env.FHIR_HUB_IDENTITY_KEY,
    FHIR_HUB_CONSENT_VERSION: env.FHIR_HUB_CONSENT_VERSION,
    FHIR_HUB_RETENTION_DAYS: env.FHIR_HUB_RETENTION_DAYS,
    CONSENT_POLICY_VERSION: env.CONSENT_POLICY_VERSION,
    SESSION_IDLE_TIMEOUT_SECONDS: env.SESSION_IDLE_TIMEOUT_SECONDS,
    SESSION_MAX_LIFETIME_SECONDS: env.SESSION_MAX_LIFETIME_SECONDS,
    EPIC_TRUSTED_ENDPOINT_ORIGINS: env.EPIC_TRUSTED_ENDPOINT_ORIGINS,
    TOKEN_STORAGE: "memory",
  };
}

function objectName(sessionId: string): string {
  return createHash("sha256").update(sessionId, "utf8").digest("hex");
}

function requestForSession(
  request: Request,
  routeId: string,
  sessionId: string,
): Request {
  const headers = new Headers(request.headers);
  headers.delete(routedSessionHeader);
  headers.delete(routedRouteHeader);
  headers.set(routedSessionHeader, sessionId);
  headers.set(routedRouteHeader, routeId);
  return new Request(request, { headers });
}

function requireSameOrigin(request: Request, publicOrigin: string): void {
  if (request.headers.get("Origin") !== publicOrigin) {
    throw new AppError(403, "origin_rejected", "The request origin was rejected.");
  }
}

/**
 * A non-PHI coordination index for account-wide deletion. It stores only an
 * HMAC account reference, a hash of a random browser route, and an expiry.
 * Tokens, patient identifiers, and FHIR payloads remain isolated in the
 * per-route EpicConnector Durable Objects.
 */
export class EpicConnectionRegistry extends DurableObject<WorkerBindings> {
  readonly #ready: Promise<void>;

  public constructor(ctx: DurableObjectState, env: WorkerBindings) {
    super(ctx, env);
    this.#ready = ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS account_routes (
          account_ref TEXT NOT NULL,
          route_name TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          PRIMARY KEY (account_ref, route_name)
        )
      `);
      ctx.storage.sql.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS account_routes_by_route ON account_routes(route_name)",
      );
      ctx.storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS account_routes_by_expiry ON account_routes(expires_at)",
      );
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS account_deletion_locks (
          account_ref TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);
      this.#pruneExpired();
      await this.#syncAlarm();
    });
  }

  public async register(
    accountRef: string,
    routeName: string,
    expiresAt: number,
  ): Promise<void> {
    await this.#ready;
    this.#validateAccountReference(accountRef);
    this.#validateRouteName(routeName);
    const now = Date.now();
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      expiresAt > now + registryMaximumLifetimeMs
    ) {
      throw new AppError(400, "invalid_registry_expiry", "The connection registry expiry is invalid.");
    }
    this.#pruneExpired(now);
    const deletion = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT 1 AS present FROM account_deletion_locks WHERE account_ref = ? LIMIT 1",
        accountRef,
      )
      .toArray()[0];
    if (deletion) {
      throw new AppError(
        409,
        "account_deletion_in_progress",
        "This Epic account is currently being disconnected. Please try again shortly.",
      );
    }
    this.ctx.storage.sql.exec(
      "DELETE FROM account_routes WHERE route_name = ?",
      routeName,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO account_routes (account_ref, route_name, expires_at)
       VALUES (?, ?, ?)`,
      accountRef,
      routeName,
      expiresAt,
    );
    await this.#syncAlarm();
  }

  public async checkReadiness(): Promise<true> {
    await this.#ready;
    this.ctx.storage.sql.exec<Record<string, SqlStorageValue>>(
      "SELECT 1 AS ready",
    ).one();
    return true;
  }

  public async unregisterRoute(routeName: string): Promise<void> {
    await this.#ready;
    this.#validateRouteName(routeName);
    this.#pruneExpired();
    this.ctx.storage.sql.exec(
      "DELETE FROM account_routes WHERE route_name = ?",
      routeName,
    );
    await this.#syncAlarm();
  }

  public async beginDisconnect(accountRef: string): Promise<RegistryDisconnectBatch> {
    await this.#ready;
    this.#validateAccountReference(accountRef);
    const now = Date.now();
    this.#pruneExpired(now);
    const active = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT 1 AS present FROM account_deletion_locks WHERE account_ref = ? LIMIT 1",
        accountRef,
      )
      .toArray()[0];
    if (active) {
      throw new AppError(
        409,
        "account_deletion_in_progress",
        "This Epic account is already being disconnected.",
      );
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO account_deletion_locks (account_ref, operation_id, expires_at) VALUES (?, ?, ?)",
      accountRef,
      randomBase64Url(24),
      now + registryDeleteLockMs,
    );
    const lock = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT operation_id FROM account_deletion_locks WHERE account_ref = ?",
        accountRef,
      )
      .one();
    const deletionId = lock.operation_id;
    if (typeof deletionId !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(deletionId)) {
      throw new AppError(500, "invalid_deletion_lease", "The account deletion lease is invalid.");
    }
    const routeNames = this.ctx.storage.sql
      .exec<RegistryRouteRow>(
        "SELECT route_name FROM account_routes WHERE account_ref = ? ORDER BY route_name",
        accountRef,
      )
      .toArray()
      .map((row) => row.route_name);
    await this.#syncAlarm();
    return { accountRef, deletionId, routeNames };
  }

  public async finishDisconnect(
    accountRef: string,
    deletionId: string,
    removedRouteNames: readonly string[],
  ): Promise<void> {
    await this.#ready;
    this.#validateAccountReference(accountRef);
    if (!/^[A-Za-z0-9_-]{32}$/.test(deletionId)) {
      throw new AppError(400, "invalid_deletion_lease", "The account deletion lease is invalid.");
    }
    for (const routeName of removedRouteNames) this.#validateRouteName(routeName);
    this.#pruneExpired();
    const activeLease = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT 1 AS present FROM account_deletion_locks
         WHERE account_ref = ? AND operation_id = ? LIMIT 1`,
        accountRef,
        deletionId,
      )
      .toArray()[0];
    if (!activeLease) {
      throw new AppError(
        409,
        "account_deletion_lease_lost",
        "The account deletion lease expired. Please retry the deletion.",
      );
    }
    for (const routeName of new Set(removedRouteNames)) {
      this.ctx.storage.sql.exec(
        "DELETE FROM account_routes WHERE account_ref = ? AND route_name = ?",
        accountRef,
        routeName,
      );
    }
    this.ctx.storage.sql.exec(
      "DELETE FROM account_deletion_locks WHERE account_ref = ? AND operation_id = ?",
      accountRef,
      deletionId,
    );
    this.#pruneExpired();
    await this.#syncAlarm();
  }

  public override async alarm(): Promise<void> {
    await this.#ready;
    this.#pruneExpired();
    await this.#syncAlarm();
  }

  #validateAccountReference(value: string): void {
    if (!accountReferencePattern.test(value)) {
      throw new AppError(400, "invalid_account_reference", "The account reference is invalid.");
    }
  }

  #validateRouteName(value: string): void {
    if (!routeNamePattern.test(value)) {
      throw new AppError(400, "invalid_route_reference", "The route reference is invalid.");
    }
  }

  #pruneExpired(now = Date.now()): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM account_routes WHERE expires_at <= ?",
      now,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM account_deletion_locks WHERE expires_at <= ?",
      now,
    );
  }

  async #syncAlarm(): Promise<void> {
    const routeExpiry = this.ctx.storage.sql
      .exec<RegistryMinimumRow>(
        "SELECT MIN(expires_at) AS minimum FROM account_routes",
      )
      .one().minimum;
    const lockExpiry = this.ctx.storage.sql
      .exec<RegistryMinimumRow>(
        "SELECT MIN(expires_at) AS minimum FROM account_deletion_locks",
      )
      .one().minimum;
    const candidates = [routeExpiry, lockExpiry].filter(
      (value): value is number => typeof value === "number",
    );
    const nextExpiry = candidates.length > 0 ? Math.min(...candidates) : undefined;
    const current = await this.ctx.storage.getAlarm();
    if (nextExpiry === undefined) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    if (current === null || current !== nextExpiry) {
      await this.ctx.storage.setAlarm(nextExpiry);
    }
  }
}

export class EpicConnector extends DurableObject<WorkerBindings> {
  readonly #service: EpicConnectorService;
  readonly #http: WorkerHttpApplication;
  readonly #store: DurableObjectConnectionStore;
  readonly #pending: DurableObjectPendingAuthorizationStore;
  readonly #ready: Promise<void>;

  public constructor(ctx: DurableObjectState, env: WorkerBindings) {
    super(ctx, env);
    const config = loadConfig(configurationEnvironment(env));
    if (!config.tokenEncryptionKey) {
      throw new AppError(
        500,
        "invalid_config",
        "TOKEN_ENCRYPTION_KEY is required in the Cloudflare Worker environment.",
      );
    }
    if (config.fhirHubEnabled && !env.EPIC_FHIR_HUB) {
      throw new AppError(
        500,
        "invalid_config",
        "EPIC_FHIR_HUB is required when the private health hub is enabled.",
      );
    }

    const keyring = encryptionKeyring(
      env,
      config.tokenEncryptionKey,
      [config.fhirHubEncryptionKey, config.fhirHubIdentityKey]
        .filter((key): key is Buffer => key !== undefined),
    );
    const store = new DurableObjectConnectionStore(ctx.storage.sql, keyring);
    const pending = new DurableObjectPendingAuthorizationStore(
      ctx.storage.sql,
      keyring,
    );
    this.#store = store;
    this.#pending = pending;
    this.#service = new EpicConnectorService(config, store, {
      pending,
      fetch: (input, init) => globalThis.fetch(input, init),
      ...(config.fhirHubEnabled
        ? { fhirHub: new WorkerFhirHubRepository(env.EPIC_FHIR_HUB) }
        : {}),
      rotateSessionOnConnect: true,
    });
    const registry = env.EPIC_CONNECTION_REGISTRY.getByName(registryObjectName);
    this.#http = new WorkerHttpApplication(this.#service, {
      onConnected: async (sessionId, routeId) => {
        const registration = await this.#service.getAccountRegistration(sessionId);
        await registry.register(
          registration.accountRef,
          objectName(routeId),
          registration.expiresAt,
        );
      },
      onDisconnected: async (routeId) => {
        await registry.unregisterRoute(objectName(routeId));
      },
      disconnectAll: (sessionId, routeId) =>
        this.#disconnectEverywhere(sessionId, routeId, registry),
    });
    this.#ready = ctx.blockConcurrencyWhile(async () => {
      pending.initialize();
      pending.pruneExpired();
      await this.#service.initialize(false);
    });
  }

  public override async fetch(request: Request): Promise<Response> {
    await this.#ready;
    const sessionId = request.headers.get(routedSessionHeader);
    const routeId = request.headers.get(routedRouteHeader);
    if (
      !sessionId ||
      !routeId ||
      !sessionIdPattern.test(sessionId) ||
      !sessionIdPattern.test(routeId) ||
      !this.ctx.id.equals(
        this.env.EPIC_CONNECTOR.idFromName(objectName(routeId)),
      )
    ) {
      return new Response("Invalid internal session route.", { status: 400 });
    }
    const headers = new Headers(request.headers);
    headers.delete(routedSessionHeader);
    headers.delete(routedRouteHeader);
    const response = await this.#http.fetch(
      new Request(request, { headers }),
      sessionId,
      routeId,
    );
    await this.#syncAlarm();
    return response;
  }

  public override async alarm(): Promise<void> {
    await this.#ready;
    try {
      this.#pending.pruneExpired();
      await this.#service.pruneExpiredConnections();
    } finally {
      await this.#syncAlarm();
    }
  }

  public async purgeAccount(accountRef: string): Promise<{
    readonly disconnected: true;
    readonly connectionsRemoved: number;
    readonly manualRevocationRecommended: boolean;
  }> {
    await this.#ready;
    const outcome = await this.#service.disconnectAccountReference(accountRef);
    await this.#syncAlarm();
    return outcome;
  }

  async #disconnectEverywhere(
    sessionId: string,
    routeId: string,
    registry: DurableObjectStub<EpicConnectionRegistry>,
  ): Promise<{
    readonly disconnected: true;
    readonly connectionsRemoved: number;
    readonly manualRevocationRecommended: boolean;
  }> {
    const registration = await this.#service.getAccountRegistration(sessionId);
    const batch = await registry.beginDisconnect(registration.accountRef);
    const currentRouteName = objectName(routeId);
    const routeNames = new Set([...batch.routeNames, currentRouteName]);
    const removedRouteNames: string[] = [];
    let connectionsRemoved = 0;
    let manualRevocationRecommended = false;
    let operationError: unknown;
    let remotePurgeFailed = false;

    try {
      const remoteRouteNames = [...routeNames].filter(
        (routeName) => routeName !== currentRouteName,
      );
      for (let index = 0; index < remoteRouteNames.length; index += registryPurgeConcurrency) {
        const outcomes = await Promise.all(remoteRouteNames
          .slice(index, index + registryPurgeConcurrency)
          .map(async (routeName) => {
            try {
              const outcome = await this.env.EPIC_CONNECTOR
                .getByName(routeName)
                .purgeAccount(batch.accountRef);
              return { routeName, outcome } as const;
            } catch {
              return { routeName } as const;
            }
          }));
        for (const remote of outcomes) {
          if (!("outcome" in remote)) {
            // Keep the opaque registry entry for retry if a route cannot be
            // reached. No session ID, token, or FHIR payload enters this index.
            remotePurgeFailed = true;
            continue;
          }
          connectionsRemoved += remote.outcome.connectionsRemoved;
          manualRevocationRecommended ||= remote.outcome.manualRevocationRecommended;
          removedRouteNames.push(remote.routeName);
        }
      }
      if (remotePurgeFailed) {
        operationError = new AppError(
          503,
          "disconnect_incomplete",
          "Some other browser connections could not be removed. This browser remains connected so you can retry; you can also remove the app in MyChart's linked apps/devices settings.",
        );
      } else {
        // Delete the initiating route last. If another route is unreachable,
        // retaining this verified connection preserves authority to retry.
        const local = await this.#service.disconnectAccountReference(batch.accountRef);
        connectionsRemoved += local.connectionsRemoved;
        manualRevocationRecommended ||= local.manualRevocationRecommended;
        removedRouteNames.push(currentRouteName);
      }
    } catch (error) {
      operationError = error;
    }

    try {
      await registry.finishDisconnect(
        batch.accountRef,
        batch.deletionId,
        removedRouteNames,
      );
    } catch (error) {
      throw new AppError(
        503,
        "connection_registry_unavailable",
        "The account deletion could not be confirmed safely. Please try again.",
        { cause: error },
      );
    }
    if (operationError) throw operationError;
    await this.#syncAlarm();
    return {
      disconnected: true,
      connectionsRemoved,
      manualRevocationRecommended,
    };
  }

  async #syncAlarm(): Promise<void> {
    const hasPending = this.#pending.hasAny();
    const hasConnection = (await this.#store.list()).length > 0;
    const delay = hasPending
      ? pendingPruneIntervalMs
      : hasConnection
        ? pruneIntervalMs
        : undefined;
    const existing = await this.ctx.storage.getAlarm();
    if (delay === undefined) {
      if (existing !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    const desired = Date.now() + delay;
    if (existing === null || existing > desired) {
      await this.ctx.storage.setAlarm(desired);
    }
  }
}

export default {
  async fetch(request: Request, env: WorkerBindings): Promise<Response> {
    const config = loadConfig(configurationEnvironment(env));
    const url = new URL(request.url);
    const { pathname } = url;
    const isHead = request.method === "HEAD";
    const safeMethod = isHead ? "GET" : request.method;

    try {
      if (!env.AUTH_RATE_LIMITER || !env.API_RATE_LIMITER) {
        throw new AppError(
          500,
          "invalid_config",
          "The required authorization and API rate-limit bindings are unavailable.",
        );
      }
      if (safeMethod === "GET" && pathname === "/") {
        return workerResponse(
          config,
          renderHome(config),
          200,
          { "Content-Type": "text/html; charset=utf-8" },
          isHead,
        );
      }
      if (safeMethod === "GET" && pathname === "/terms") {
        return workerResponse(
          config,
          renderTerms(config),
          200,
          { "Content-Type": "text/html; charset=utf-8" },
          isHead,
        );
      }
      if (safeMethod === "GET" && pathname === "/privacy") {
        return workerResponse(
          config,
          renderPrivacy(config),
          200,
          { "Content-Type": "text/html; charset=utf-8" },
          isHead,
        );
      }
      if (safeMethod === "GET" && pathname === "/styles.css") {
        return workerResponse(
          config,
          styles,
          200,
          { "Content-Type": "text/css; charset=utf-8" },
          isHead,
        );
      }
      if (safeMethod === "GET" && pathname === "/app.js") {
        return workerResponse(
          config,
          browserScript,
          200,
          { "Content-Type": "application/javascript; charset=utf-8" },
          isHead,
        );
      }
      if (safeMethod === "GET" && pathname === "/healthz") {
        return workerJsonResponse(config, { status: "ok" }, 200, isHead);
      }
      if (safeMethod === "GET" && pathname === "/readyz") {
        try {
          await env.EPIC_CONNECTION_REGISTRY
            .getByName(registryObjectName)
            .checkReadiness();
          if (config.fhirHubEnabled) {
            await env.EPIC_FHIR_HUB
              .getByName(fhirHubReadinessIdentity.accountRef)
              .checkReadiness(fhirHubReadinessIdentity, true);
          }
          return env.EPIC_CONNECTOR
            .getByName(objectName(readinessRouteId))
            .fetch(requestForSession(request, readinessRouteId, readinessRouteId));
        } catch {
          return workerJsonResponse(config, { status: "not_ready" }, 503, isHead);
        }
      }

      const existingSession = readWorkerSessionContext(request, config);
      const existingSessionId = existingSession?.sessionId;
      if (
        safeMethod === "GET" &&
        pathname === "/api/connection" &&
        !existingSessionId
      ) {
        return workerJsonResponse(
          config,
          { connected: false, provider: config.providerName },
          200,
          isHead,
        );
      }
      if (
        request.method === "POST" &&
        pathname === "/api/disconnect" &&
        !existingSessionId
      ) {
        requireSameOrigin(request, config.publicOrigin);
        return workerJsonResponse(config, {
          disconnected: true,
          remoteRevocation: "not_applicable",
          manualRevocationRecommended: false,
        });
      }

      let sessionId: string | undefined;
      let routeId: string | undefined;
      if (request.method === "POST" && pathname === "/auth/start") {
        requireSameOrigin(request, config.publicOrigin);
        const clientKey = authorizationClientRateLimitKey(
          request.headers.get("CF-Connecting-IP") ?? undefined,
        );
        const decision = await env.AUTH_RATE_LIMITER.limit({ key: clientKey });
        if (!decision.success) {
          const requestId = newRequestId();
          void emitAudit(productionAuditSink, {
            event: "rate_limited",
            outcome: "denied",
            requestId,
            ...(existingSessionId
              ? {
                  sessionRef: pseudonymousSessionRef(
                    existingSessionId,
                    config.sessionSecret,
                  ),
                }
              : {}),
          });
          return workerJsonResponse(
            config,
            { error: { code: "rate_limited", message: "Too many connection attempts. Please try again shortly." } },
            429,
            false,
            { "Retry-After": "60", "X-Request-ID": requestId },
          );
        }
        sessionId = existingSessionId ?? randomBase64Url(32);
        routeId = existingSession?.routeId ?? sessionId;
      } else if (
        (request.method === "GET" && pathname === "/auth/callback") ||
        (safeMethod === "GET" && pathname === "/api/connection") ||
        (request.method === "GET" && pathname === "/api/patient") ||
        (request.method === "GET" && pathname === "/api/fhir-page") ||
        (request.method === "GET" &&
          (
            pathname === "/api/hub/status" ||
            pathname === "/api/hub/resources" ||
            pathname === "/api/hub/intelligence" ||
            pathname === "/api/hub/export"
          )) ||
        (request.method === "POST" &&
          (
            pathname === "/api/disconnect" ||
            pathname === "/api/disconnect-all" ||
            pathname === "/api/hub/enable" ||
            pathname === "/api/hub/delete"
          ))
      ) {
        sessionId = existingSessionId;
        routeId = existingSession?.routeId;
      } else if (
        request.method === "GET" &&
        pathname.startsWith("/api/fhir/")
      ) {
        const segments = pathname.slice("/api/fhir/".length).split("/");
        if (
          segments.length < 1 ||
          segments.length > 2 ||
          segments.some((segment) => !segment)
        ) {
          return workerNotFoundResponse(config, pathname, false);
        }
        try {
          for (const segment of segments) decodeURIComponent(segment);
        } catch {
          return workerNotFoundResponse(config, pathname, false);
        }
        sessionId = existingSessionId;
        routeId = existingSession?.routeId;
      } else {
        return workerNotFoundResponse(config, pathname, isHead);
      }

      if (!sessionId || !routeId) {
        throw new ReconnectRequiredError("Connect your MyChart account first.");
      }
      if (pathname.startsWith("/api/")) {
        const decision = await env.API_RATE_LIMITER.limit({ key: sessionId });
        if (!decision.success) {
          const requestId = newRequestId();
          void emitAudit(productionAuditSink, {
            event: "rate_limited",
            outcome: "denied",
            requestId,
            sessionRef: pseudonymousSessionRef(sessionId, config.sessionSecret),
          });
          return workerJsonResponse(
            config,
            { error: { code: "rate_limited", message: "Too many requests. Please try again shortly." } },
            429,
            false,
            { "Retry-After": "60", "X-Request-ID": requestId },
          );
        }
      }
      return env.EPIC_CONNECTOR
        .getByName(objectName(routeId))
        .fetch(requestForSession(request, routeId, sessionId));
    } catch (error) {
      const requestId = newRequestId();
      if (pathname.startsWith("/api/hub/")) {
        const hubAction = pathname === "/api/hub/status"
          ? "status"
          : pathname === "/api/hub/enable"
            ? "enable"
            : pathname === "/api/hub/resources"
              ? "list"
              : pathname === "/api/hub/intelligence"
                ? "intelligence"
                : pathname === "/api/hub/export"
                  ? "export"
                  : pathname === "/api/hub/delete"
                    ? "delete"
                    : undefined;
        const appError = error instanceof AppError ? error : undefined;
        const sessionId = readWorkerSessionContext(request, config)?.sessionId;
        if (hubAction) {
          void emitAudit(productionAuditSink, {
            event: "fhir_hub",
            hubAction,
            outcome: appError?.statusCode === 401 ||
                appError?.statusCode === 403 ||
                appError?.code === "connection_context_required" ||
                appError?.code === "connection_context_changed" ||
                appError?.code === "fhir_hub_consent_required"
              ? "denied"
              : "failure",
            requestId,
            ...(sessionId
              ? { sessionRef: pseudonymousSessionRef(sessionId, config.sessionSecret) }
              : {}),
            ...(appError ? { errorCode: appError.code } : { errorCode: "internal_error" }),
          });
        }
      }
      return workerErrorResponse(
        config,
        pathname,
        request.method,
        error,
        requestId,
        request.headers.get("Accept"),
      );
    }
  },
} satisfies ExportedHandler<WorkerBindings>;
