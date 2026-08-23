import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";

import { EpicConnectorService } from "./connector.js";
import { loadConfig } from "./config.js";
import { AppError, ReconnectRequiredError } from "./errors.js";
import { randomBase64Url } from "./security.js";
import {
  readWorkerSessionId,
  WorkerHttpApplication,
  workerErrorResponse,
  workerJsonResponse,
  workerNotFoundResponse,
  workerResponse,
} from "./worker-app.js";
import {
  DurableObjectConnectionStore,
  DurableObjectPendingAuthorizationStore,
} from "./worker-storage.js";
import {
  browserScript,
  renderHome,
  renderPrivacy,
  renderTerms,
  styles,
} from "./ui.js";

const pruneIntervalMs = 60 * 60 * 1_000;
const pendingPruneIntervalMs = 10 * 60 * 1_000;
const routedSessionHeader = "X-Epic-Worker-Session";
const sessionIdPattern = /^[A-Za-z0-9_-]{40,100}$/;

interface WorkerBindings {
  readonly EPIC_CONNECTOR: DurableObjectNamespace<EpicConnector>;
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
  readonly EPIC_REQUEST_OFFLINE_ACCESS?: string;
  readonly EPIC_ALLOWED_RESOURCE_TYPES?: string;
  readonly EPIC_PRIVATE_KEY_PEM?: string;
  readonly EPIC_PRIVATE_KEY_ALG?: string;
  readonly EPIC_PRIVATE_KEY_KID?: string;
  readonly SESSION_SECRET?: string;
  readonly TOKEN_ENCRYPTION_KEY?: string;
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
    EPIC_REQUEST_OFFLINE_ACCESS: env.EPIC_REQUEST_OFFLINE_ACCESS,
    EPIC_ALLOWED_RESOURCE_TYPES: env.EPIC_ALLOWED_RESOURCE_TYPES,
    EPIC_PRIVATE_KEY_PEM: env.EPIC_PRIVATE_KEY_PEM,
    EPIC_PRIVATE_KEY_ALG: env.EPIC_PRIVATE_KEY_ALG,
    EPIC_PRIVATE_KEY_KID: env.EPIC_PRIVATE_KEY_KID,
    SESSION_SECRET: env.SESSION_SECRET,
    TOKEN_ENCRYPTION_KEY: env.TOKEN_ENCRYPTION_KEY,
    TOKEN_STORAGE: "memory",
  };
}

function objectName(sessionId: string): string {
  return createHash("sha256").update(sessionId, "utf8").digest("hex");
}

function requestForSession(request: Request, sessionId: string): Request {
  const headers = new Headers(request.headers);
  headers.delete(routedSessionHeader);
  headers.set(routedSessionHeader, sessionId);
  return new Request(request, { headers });
}

function requireSameOrigin(request: Request, publicOrigin: string): void {
  if (request.headers.get("Origin") !== publicOrigin) {
    throw new AppError(403, "origin_rejected", "The request origin was rejected.");
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

    const store = new DurableObjectConnectionStore(
      ctx.storage.sql,
      config.tokenEncryptionKey,
    );
    const pending = new DurableObjectPendingAuthorizationStore(
      ctx.storage.sql,
      config.tokenEncryptionKey,
    );
    this.#store = store;
    this.#pending = pending;
    this.#service = new EpicConnectorService(config, store, {
      pending,
      fetch: (input, init) => globalThis.fetch(input, init),
      rotateSessionOnConnect: false,
    });
    this.#http = new WorkerHttpApplication(this.#service);
    this.#ready = ctx.blockConcurrencyWhile(async () => {
      pending.initialize();
      pending.pruneExpired();
      await this.#service.initialize(false);
    });
  }

  public override async fetch(request: Request): Promise<Response> {
    await this.#ready;
    const sessionId = request.headers.get(routedSessionHeader);
    if (
      !sessionId ||
      !sessionIdPattern.test(sessionId) ||
      !this.ctx.id.equals(
        this.env.EPIC_CONNECTOR.idFromName(objectName(sessionId)),
      )
    ) {
      return new Response("Invalid internal session route.", { status: 400 });
    }
    const headers = new Headers(request.headers);
    headers.delete(routedSessionHeader);
    const response = await this.#http.fetch(
      new Request(request, { headers }),
      sessionId,
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

      const existingSessionId = readWorkerSessionId(request, config);
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
      if (request.method === "POST" && pathname === "/auth/start") {
        requireSameOrigin(request, config.publicOrigin);
        sessionId = existingSessionId ?? randomBase64Url(32);
      } else if (
        (request.method === "GET" && pathname === "/auth/callback") ||
        (safeMethod === "GET" && pathname === "/api/connection") ||
        (request.method === "GET" && pathname === "/api/patient") ||
        (request.method === "POST" && pathname === "/api/disconnect")
      ) {
        sessionId = existingSessionId;
      } else if (
        request.method === "GET" &&
        pathname.startsWith("/api/fhir/")
      ) {
        const encodedResourceType = pathname.slice("/api/fhir/".length);
        if (!encodedResourceType || encodedResourceType.includes("/")) {
          return workerNotFoundResponse(config, pathname, false);
        }
        try {
          decodeURIComponent(encodedResourceType);
        } catch {
          return workerNotFoundResponse(config, pathname, false);
        }
        sessionId = existingSessionId;
      } else {
        return workerNotFoundResponse(config, pathname, isHead);
      }

      if (!sessionId) {
        throw new ReconnectRequiredError("Connect your MyChart account first.");
      }
      return env.EPIC_CONNECTOR
        .getByName(objectName(sessionId))
        .fetch(requestForSession(request, sessionId));
    } catch (error) {
      return workerErrorResponse(config, pathname, request.method, error);
    }
  },
} satisfies ExportedHandler<WorkerBindings>;
