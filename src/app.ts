import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import {
  boundedAuditResourceType,
  emitAudit,
  newRequestId,
  pseudonymousAuthorizationRef,
  productionAuditSink,
  pseudonymousSessionRef,
  type AuditSink,
} from "./audit.js";
import { EpicConnectorService } from "./connector.js";
import { contentSecurityPolicy } from "./csp.js";
import { AppError, ReconnectRequiredError, safeErrorDiagnostic } from "./errors.js";
import {
  fhirResponseTraceHeaders,
  type FhirResponseTraceInteraction,
} from "./fhir-response-trace.js";
import { EncryptedFileFhirHubRepository } from "./fhir-hub-file.js";
import {
  DisabledFhirHubRepository,
  type FhirHubIntelligenceOptions,
  type FhirHubListOptions,
  type FhirHubRepository,
} from "./fhir-hub.js";
import { authorizationClientRateLimitKey, FixedWindowRateLimiter } from "./rate-limit.js";
import { PendingAuthorizationStore, randomBase64Url } from "./security.js";
import {
  EncryptedFileConnectionStore,
  InMemoryConnectionStore,
} from "./store.js";
import type {
  AppConfig,
  ConnectionStore,
  FetchLike,
  PendingAuthorizationRepository,
} from "./types.js";

import {
  browserScript,
  renderError,
  renderHome,
  renderPrivacy,
  renderTerms,
  styles,
} from "./ui.js";

function acceptsJson(value: string | undefined): boolean {
  return value?.split(",").some((entry) =>
    entry.split(";", 1)[0]?.trim().toLowerCase() === "application/json") ?? false;
}

function applyFhirResponseTraceHeaders(
  reply: FastifyReply,
  resourceType: string,
  interaction: FhirResponseTraceInteraction,
): void {
  for (const [name, value] of Object.entries(
    fhirResponseTraceHeaders(resourceType, interaction),
  )) {
    reply.header(name, value);
  }
}

export interface AppDependencies {
  readonly fetch?: FetchLike;
  readonly store?: ConnectionStore;
  readonly fhirHub?: FhirHubRepository;
  readonly pending?: PendingAuthorizationRepository;
  readonly now?: () => number;
  readonly enablePruneTimer?: boolean;
  readonly audit?: AuditSink;
}

function makeStore(config: AppConfig): ConnectionStore {
  if (config.tokenStorage === "memory") return new InMemoryConnectionStore();
  if (!config.tokenEncryptionKey) {
    throw new AppError(500, "invalid_config", "The token encryption key is missing.");
  }
  return new EncryptedFileConnectionStore(config.tokenStoreFile, config.tokenEncryptionKey);
}

function makeFhirHub(config: AppConfig): FhirHubRepository {
  if (!config.fhirHubEnabled) return new DisabledFhirHubRepository();
  if (!config.fhirHubEncryptionKey) {
    throw new AppError(500, "invalid_config", "The private health hub encryption key is missing.");
  }
  return new EncryptedFileFhirHubRepository(
    config.fhirHubStoreFile,
    config.fhirHubEncryptionKey,
  );
}

function expectedConnectionContext(request: FastifyRequest): string | undefined {
  const value = request.headers["x-epic-expected-connection-context"];
  return typeof value === "string" ? value : undefined;
}

function requiredConnectionContext(request: FastifyRequest): string {
  const value = expectedConnectionContext(request);
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new AppError(
      409,
      "connection_context_required",
      "Refresh the current MyChart connection before managing the private health hub.",
    );
  }
  return value;
}

function requireJsonContentType(request: FastifyRequest, errorCode: string): void {
  const contentType = request.headers["content-type"]
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new AppError(400, errorCode, "The private health hub request was invalid.");
  }
}

function exactObjectBody(
  body: unknown,
  allowedKeys: readonly string[],
  errorCode: string,
): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(400, errorCode, "The private health hub request was invalid.");
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !allowedKeys.includes(key))) {
    throw new AppError(400, errorCode, "The private health hub request was invalid.");
  }
  return record;
}

function hubListOptions(request: FastifyRequest, publicOrigin: string): FhirHubListOptions {
  const parameters = new URL(request.raw.url ?? "/", publicOrigin).searchParams;
  const allowed = new Set(["resourceType", "includeHistory", "limit"]);
  for (const key of parameters.keys()) {
    if (!allowed.has(key) || parameters.getAll(key).length !== 1) {
      throw new AppError(400, "invalid_hub_query", "The private health hub query was invalid.");
    }
  }
  const resourceType = parameters.get("resourceType") ?? undefined;
  if (resourceType !== undefined && !/^[A-Z][A-Za-z0-9]{0,63}$/.test(resourceType)) {
    throw new AppError(400, "invalid_resource_type", "The FHIR resource type is invalid.");
  }
  const historyValue = parameters.get("includeHistory");
  if (historyValue !== null && historyValue !== "true" && historyValue !== "false") {
    throw new AppError(400, "invalid_hub_query", "The private health hub query was invalid.");
  }
  const limitValue = parameters.get("limit");
  const limit = limitValue === null ? undefined : Number(limitValue);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1_000)) {
    throw new AppError(400, "invalid_hub_limit", "The health hub result limit must be between 1 and 1000.");
  }
  return {
    ...(resourceType === undefined ? {} : { resourceType }),
    ...(historyValue === null ? {} : { includeHistory: historyValue === "true" }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function hubIntelligenceOptions(
  request: FastifyRequest,
  publicOrigin: string,
): FhirHubIntelligenceOptions {
  const parameters = new URL(request.raw.url ?? "/", publicOrigin).searchParams;
  const allowed = new Set(["resourceType", "includeHistory", "includeSuperseded", "limit"]);
  for (const key of parameters.keys()) {
    if (!allowed.has(key) || parameters.getAll(key).length !== 1) {
      throw new AppError(400, "invalid_hub_query", "The private health hub query was invalid.");
    }
  }
  const resourceType = parameters.get("resourceType") ?? undefined;
  if (resourceType !== undefined && !/^[A-Z][A-Za-z0-9]{0,63}$/.test(resourceType)) {
    throw new AppError(400, "invalid_resource_type", "The FHIR resource type is invalid.");
  }
  const booleanParameter = (name: string): boolean | undefined => {
    const value = parameters.get(name);
    if (value === null) return undefined;
    if (value !== "true" && value !== "false") {
      throw new AppError(400, "invalid_hub_query", "The private health hub query was invalid.");
    }
    return value === "true";
  };
  const includeHistory = booleanParameter("includeHistory");
  const includeSuperseded = booleanParameter("includeSuperseded");
  const limitValue = parameters.get("limit");
  const limit = limitValue === null ? undefined : Number(limitValue);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 250)) {
    throw new AppError(400, "invalid_hub_limit", "The intelligence result limit must be between 1 and 250.");
  }
  return {
    ...(resourceType === undefined ? {} : { resourceType }),
    ...(includeHistory === undefined ? {} : { includeHistory }),
    ...(includeSuperseded === undefined ? {} : { includeSuperseded }),
    ...(limit === undefined ? {} : { limit }),
  };
}

export async function buildApp(
  config: AppConfig,
  dependencies: AppDependencies = {},
): Promise<FastifyInstance> {
  const store = dependencies.store ?? makeStore(config);
  const fhirHub = dependencies.fhirHub ?? makeFhirHub(config);
  const service = new EpicConnectorService(config, store, {
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    pending: dependencies.pending ?? new PendingAuthorizationStore(10 * 60 * 1_000, dependencies.now),
    ...(dependencies.now ? { now: dependencies.now } : {}),
    fhirHub,
  });
  const app = Fastify({
    logger: false,
    genReqId: () => newRequestId(),
    trustProxy: false,
    routerOptions: {
      ignoreTrailingSlash: false,
      maxParamLength: 256,
    },
    bodyLimit: 32 * 1024,
  });

  try {
    await service.initialize();
    return await configureApp(
      app,
      service,
      dependencies.enablePruneTimer ?? true,
      dependencies.audit ?? productionAuditSink,
    );
  } catch (error) {
    await app.close().catch(() => undefined);
    await service.close().catch(() => undefined);
    throw error;
  }
}

async function configureApp(
  app: FastifyInstance,
  service: EpicConnectorService,
  enablePruneTimer: boolean,
  audit: AuditSink,
): Promise<FastifyInstance> {
  const config = service.config;
  const authLimiter = new FixedWindowRateLimiter(10, 60_000);
  const apiLimiter = new FixedWindowRateLimiter(120, 60_000);

  await app.register(formbody);
  await app.register(cookie, {
    secret: config.sessionSecret,
    hook: "onRequest",
  });

  const pruneTimer = enablePruneTimer
    ? setInterval(() => {
        void service.pruneExpiredConnections().catch(() => {
          void emitAudit(audit, {
            event: "background_cleanup_failed",
            outcome: "failure",
            requestId: newRequestId(),
            errorCode: "connection_prune_failed",
          });
        });
      }, 60 * 60 * 1_000)
    : undefined;
  pruneTimer?.unref();
  app.addHook("onClose", async () => {
    if (pruneTimer) clearInterval(pruneTimer);
    await service.close();
  });

  function readSessionId(request: FastifyRequest): string | undefined {
    const signed = request.cookies[config.cookieName];
    if (!signed) return undefined;
    const unsigned = request.unsignCookie(signed);
    if (!unsigned.valid || !unsigned.value || !/^[A-Za-z0-9_-]{40,100}$/.test(unsigned.value)) {
      return undefined;
    }
    return unsigned.value;
  }

  function setSessionCookie(reply: FastifyReply, sessionId: string): void {
    reply.setCookie(config.cookieName, sessionId, {
      signed: true,
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      path: "/",
      maxAge: config.sessionMaxLifetimeMs / 1_000,
    });
  }

  function getOrCreateSessionId(request: FastifyRequest, reply: FastifyReply): string {
    const existing = readSessionId(request);
    if (existing) return existing;
    const sessionId = randomBase64Url(32);
    setSessionCookie(reply, sessionId);
    return sessionId;
  }

  function requireSessionId(request: FastifyRequest): string {
    const sessionId = readSessionId(request);
    if (!sessionId) throw new ReconnectRequiredError("Connect your MyChart account first.");
    return sessionId;
  }

  function requireSameOrigin(request: FastifyRequest): void {
    if (request.headers.origin !== config.publicOrigin) {
      throw new AppError(403, "origin_rejected", "The request origin was rejected.");
    }
  }

  function enforceRateLimit(
    limiter: FixedWindowRateLimiter,
    key: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    const decision = limiter.check(key);
    if (decision.allowed) return;
    reply.header("Retry-After", String(decision.retryAfterSeconds));
    void emitAudit(audit, {
      event: "rate_limited",
      outcome: "denied",
      requestId: request.id,
      ...(readSessionId(request)
        ? {
            sessionRef: pseudonymousSessionRef(
              readSessionId(request)!,
              config.sessionSecret,
            ),
          }
        : {}),
    });
    throw new AppError(429, "rate_limited", "Too many requests. Please try again shortly.");
  }

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Pragma", "no-cache");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("X-Request-ID", request.id);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header(
      "Content-Security-Policy",
      contentSecurityPolicy(config),
    );
    if (config.cookieSecure) {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    return payload;
  });

  app.get("/", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(renderHome(config));
  });

  app.get("/terms", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(renderTerms(config));
  });

  app.get("/privacy", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(renderPrivacy(config));
  });

  app.get("/styles.css", async (_request, reply) => {
    return reply.type("text/css; charset=utf-8").send(styles);
  });

  app.get("/app.js", async (_request, reply) => {
    return reply.type("application/javascript; charset=utf-8").send(browserScript);
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    try {
      await service.checkReadiness();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  app.post("/auth/start", async (request, reply) => {
    requireSameOrigin(request);
    enforceRateLimit(
      authLimiter,
      authorizationClientRateLimitKey(request.ip),
      request,
      reply,
    );
    const body = request.body && typeof request.body === "object"
      ? request.body as Record<string, unknown>
      : {};
    if (
      body.consent !== "accepted" ||
      body.policyVersion !== config.consentPolicyVersion
    ) {
      throw new AppError(
        409,
        "consent_required",
        "Review and accept the current Terms and Privacy Notice before connecting.",
      );
    }
    const sessionId = getOrCreateSessionId(request, reply);
    const authorizationUrl = await service.startAuthorization(
      sessionId,
      config.consentPolicyVersion,
    );
    const sessionRef = pseudonymousSessionRef(sessionId, config.sessionSecret);
    const authorizationRef = pseudonymousAuthorizationRef(sessionId, config.sessionSecret);
    void emitAudit(audit, {
      event: "consent_recorded",
      outcome: "success",
      requestId: request.id,
      sessionRef,
      authorizationRef,
      policyVersion: config.consentPolicyVersion,
    });
    void emitAudit(audit, {
      event: "authorization_started",
      outcome: "success",
      requestId: request.id,
      sessionRef,
      authorizationRef,
    });
    if (acceptsJson(request.headers.accept)) {
      return reply
        .code(200)
        .header("Vary", "Accept")
        .send({ authorizationUrl });
    }
    return reply
      .code(303)
      .header("Location", authorizationUrl)
      .header("Vary", "Accept")
      .send();
  });

  app.get("/auth/callback", async (request, reply) => {
    const sessionId = requireSessionId(request);
    const authenticatedSessionId = await service.completeAuthorization(
      sessionId,
      request.raw.url ?? "/auth/callback",
    );
    setSessionCookie(reply, authenticatedSessionId);
    void emitAudit(audit, {
      event: "authorization_completed",
      outcome: "success",
      requestId: request.id,
      sessionRef: pseudonymousSessionRef(authenticatedSessionId, config.sessionSecret),
      authorizationRef: pseudonymousAuthorizationRef(sessionId, config.sessionSecret),
    });
    return reply.code(303).header("Location", "/").send();
  });

  app.get("/api/connection", async (request) => {
    return service.getConnectionSummary(readSessionId(request));
  });

  app.get("/api/hub/status", async (request, reply) => {
    const sessionId = requireSessionId(request);
    enforceRateLimit(apiLimiter, sessionId, request, reply);
    const result = await service.getFhirHubStatusBound(
      sessionId,
      requiredConnectionContext(request),
    );
    void emitAudit(audit, {
      event: "fhir_hub",
      hubAction: "status",
      outcome: "success",
      requestId: request.id,
      sessionRef: pseudonymousSessionRef(sessionId, config.sessionSecret),
    });
    reply.header("X-Epic-Connection-Context", result.connectionContext);
    return result.value;
  });

  app.post("/api/hub/enable", async (request, reply) => {
    requireSameOrigin(request);
    const sessionId = requireSessionId(request);
    enforceRateLimit(apiLimiter, sessionId, request, reply);
    requireJsonContentType(request, "invalid_hub_consent");
    const body = exactObjectBody(request.body, ["policyVersion"], "invalid_hub_consent");
    if (body.policyVersion !== config.fhirHubConsentVersion) {
      throw new AppError(
        409,
        "fhir_hub_consent_required",
        "Review and accept the current private health hub notice before enabling storage.",
      );
    }
    const result = await service.enableFhirHubBound(
      sessionId,
      body.policyVersion,
      requiredConnectionContext(request),
    );
    void emitAudit(audit, {
      event: "fhir_hub",
      hubAction: "enable",
      outcome: "success",
      requestId: request.id,
      sessionRef: pseudonymousSessionRef(sessionId, config.sessionSecret),
      policyVersion: body.policyVersion,
    });
    reply.header("X-Epic-Connection-Context", result.connectionContext);
    return result.value;
  });

  app.get("/api/hub/resources", async (request, reply) => {
    const sessionId = requireSessionId(request);
    enforceRateLimit(apiLimiter, sessionId, request, reply);
    const result = await service.listFhirHubResourcesBound(
      sessionId,
      hubListOptions(request, config.publicOrigin),
      requiredConnectionContext(request),
    );
    void emitAudit(audit, {
      event: "fhir_hub",
      hubAction: "list",
      outcome: "success",
      requestId: request.id,
      sessionRef: pseudonymousSessionRef(sessionId, config.sessionSecret),
    });
    reply.header("X-Epic-Connection-Context", result.connectionContext);
    return result.value;
  });

  app.get("/api/hub/intelligence", async (request, reply) => {
    const sessionId = requireSessionId(request);
    enforceRateLimit(apiLimiter, sessionId, request, reply);
    const result = await service.getFhirHubIntelligenceBound(
      sessionId,
      hubIntelligenceOptions(request, config.publicOrigin),
      requiredConnectionContext(request),
    );
    void emitAudit(audit, {
      event: "fhir_hub",
      hubAction: "intelligence",
      outcome: "success",
      requestId: request.id,
      sessionRef: pseudonymousSessionRef(sessionId, config.sessionSecret),
    });
    reply.header("X-Epic-Connection-Context", result.connectionContext);
    return result.value;
  });

  app.get("/api/hub/export", async (request, reply) => {
    const sessionId = requireSessionId(request);
    enforceRateLimit(apiLimiter, sessionId, request, reply);
    const result = await service.exportFhirHubBound(
      sessionId,
      requiredConnectionContext(request),
    );
    void emitAudit(audit, {
      event: "fhir_hub",
      hubAction: "export",
      outcome: "success",
      requestId: request.id,
      sessionRef: pseudonymousSessionRef(sessionId, config.sessionSecret),
    });
    reply.header("X-Epic-Connection-Context", result.connectionContext);
    reply.header("Content-Disposition", 'attachment; filename="moonba-health-hub.json"');
    return result.value;
  });

  app.post("/api/hub/delete", async (request, reply) => {
    requireSameOrigin(request);
    const sessionId = requireSessionId(request);
    enforceRateLimit(apiLimiter, sessionId, request, reply);
    requireJsonContentType(request, "invalid_hub_delete_request");
    const body = exactObjectBody(request.body, ["confirmation"], "invalid_hub_delete_request");
    if (body.confirmation !== "DELETE MY HEALTH HUB") {
      throw new AppError(
        400,
        "fhir_hub_delete_confirmation_required",
        "Type the exact deletion confirmation before permanently deleting the private health hub.",
      );
    }
    const result = await service.deleteFhirHubBound(
      sessionId,
      body.confirmation,
      requiredConnectionContext(request),
    );
    void emitAudit(audit, {
      event: "fhir_hub",
      hubAction: "delete",
      outcome: "success",
      requestId: request.id,
      sessionRef: pseudonymousSessionRef(sessionId, config.sessionSecret),
    });
    reply.header("X-Epic-Connection-Context", result.connectionContext);
    return result.value;
  });

  app.get("/api/patient", async (request, reply) => {
    const sessionId = requireSessionId(request);
    enforceRateLimit(apiLimiter, sessionId, request, reply);
    const result = await service.readPatientBound(
      sessionId,
      expectedConnectionContext(request),
      request.id,
    );
    reply.header("X-Epic-Connection-Context", result.connectionContext);
    applyFhirResponseTraceHeaders(reply, "Patient", "read");
    void emitAudit(audit, {
      event: "fhir_access",
      outcome: "success",
      requestId: request.id,
      sessionRef: pseudonymousSessionRef(sessionId, config.sessionSecret),
      resourceType: "Patient",
      interaction: "read",
    });
    return result.value;
  });

  app.get("/api/fhir-page", async (request, reply) => {
    const sessionId = requireSessionId(request);
    enforceRateLimit(apiLimiter, sessionId, request, reply);
    const parameters = new URL(request.raw.url ?? "/", config.publicOrigin).searchParams;
    const cursors = parameters.getAll("cursor");
    if (parameters.size !== 1 || cursors.length !== 1 || !cursors[0]) {
      throw new AppError(400, "invalid_page_cursor", "The FHIR page cursor is invalid or expired.");
    }
    const result = await service.pageBound(
      sessionId,
      cursors[0],
      expectedConnectionContext(request),
      request.id,
    );
    reply.header("X-Epic-Connection-Context", result.connectionContext);
    applyFhirResponseTraceHeaders(reply, result.resourceType, "search");
    void emitAudit(audit, {
      event: "fhir_access",
      outcome: "success",
      requestId: request.id,
      sessionRef: pseudonymousSessionRef(sessionId, config.sessionSecret),
      resourceType: result.resourceType,
      interaction: "search",
    });
    return result.value;
  });

  app.get<{ Params: { resourceType: string; id: string } }>(
    "/api/fhir/:resourceType/:id",
    async (request, reply) => {
      const sessionId = requireSessionId(request);
      enforceRateLimit(apiLimiter, sessionId, request, reply);
      const result = await service.readBound(
        sessionId,
        request.params.resourceType,
        request.params.id,
        expectedConnectionContext(request),
        request.id,
      );
      reply.header("X-Epic-Connection-Context", result.connectionContext);
      applyFhirResponseTraceHeaders(reply, request.params.resourceType, "read");
      void emitAudit(audit, {
        event: "fhir_access",
        outcome: "success",
        requestId: request.id,
        sessionRef: pseudonymousSessionRef(sessionId, config.sessionSecret),
        resourceType: request.params.resourceType,
        interaction: "read",
      });
      return result.value;
    },
  );

  app.get<{ Params: { resourceType: string } }>("/api/fhir/:resourceType", async (request, reply) => {
    const sessionId = requireSessionId(request);
    enforceRateLimit(apiLimiter, sessionId, request, reply);
    const search = new URL(request.raw.url ?? "/", config.publicOrigin).searchParams;
    const result = await service.searchBound(
      sessionId,
      request.params.resourceType,
      search,
      expectedConnectionContext(request),
      request.id,
    );
    reply.header("X-Epic-Connection-Context", result.connectionContext);
    applyFhirResponseTraceHeaders(reply, request.params.resourceType, "search");
    void emitAudit(audit, {
      event: "fhir_access",
      outcome: "success",
      requestId: request.id,
      sessionRef: pseudonymousSessionRef(sessionId, config.sessionSecret),
      resourceType: request.params.resourceType,
      interaction: "search",
    });
    return result.value;
  });

  app.post("/api/disconnect", async (request, reply) => {
    requireSameOrigin(request);
    const sessionId = readSessionId(request);
    if (sessionId) {
      await service.assertConnectionContext(
        sessionId,
        expectedConnectionContext(request),
      );
    }
    const outcome = await service.disconnect(sessionId);
    if (sessionId) {
      reply.clearCookie(config.cookieName, {
        httpOnly: true,
        sameSite: "lax",
        secure: config.cookieSecure,
        path: "/",
      });
    }
    void emitAudit(audit, {
      event: "disconnect",
      outcome: outcome.remoteRevocation === "failed" ? "failure" : "success",
      requestId: request.id,
      ...(sessionId
        ? { sessionRef: pseudonymousSessionRef(sessionId, config.sessionSecret) }
        : {}),
      remoteRevocation: outcome.remoteRevocation,
    });
    return outcome;
  });

  app.post("/api/disconnect-all", async (request, reply) => {
    requireSameOrigin(request);
    const sessionId = requireSessionId(request);
    await service.assertConnectionContext(
      sessionId,
      expectedConnectionContext(request),
    );
    const outcome = await service.disconnectAllForAccount(sessionId);
    reply.clearCookie(config.cookieName, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      path: "/",
    });
    void emitAudit(audit, {
      event: "disconnect",
      outcome: outcome.manualRevocationRecommended ? "failure" : "success",
      requestId: request.id,
      sessionRef: pseudonymousSessionRef(sessionId, config.sessionSecret),
      remoteRevocation: outcome.manualRevocationRecommended ? "incomplete" : "success",
    });
    return outcome;
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/") || request.url === "/auth/start") {
      if (request.url === "/auth/start") reply.header("Vary", "Accept");
      return reply.code(404).send({ error: { code: "not_found", message: "Route not found." } });
    }
    return reply.code(404).type("text/html; charset=utf-8").send(renderError("Page not found."));
  });

  app.setErrorHandler(async (error, request, reply) => {
    const appError = error instanceof AppError
      ? error
      : new AppError(500, "internal_error", "An unexpected error occurred.");
    const retryAfterSeconds = "retryAfterSeconds" in appError &&
      typeof appError.retryAfterSeconds === "number"
      ? appError.retryAfterSeconds
      : undefined;
    if (retryAfterSeconds !== undefined) {
      reply.header("Retry-After", String(retryAfterSeconds));
    }
    if (request.url === "/auth/start") reply.header("Vary", "Accept");
    const sessionId = readSessionId(request);
    if (request.url === "/auth/start" || request.url.startsWith("/auth/callback")) {
      const diagnostic = safeErrorDiagnostic(error);
      void emitAudit(audit, {
        event: "authorization_failed",
        outcome: appError.statusCode === 403 || appError.code === "consent_required"
          ? "denied"
          : "failure",
        requestId: request.id,
        ...(sessionId
          ? { sessionRef: pseudonymousSessionRef(sessionId, config.sessionSecret) }
          : {}),
        ...(sessionId
          ? { authorizationRef: pseudonymousAuthorizationRef(sessionId, config.sessionSecret) }
          : {}),
        errorCode: appError.code,
        ...diagnostic,
      });
    } else if (request.url.startsWith("/api/hub/")) {
      const hubPath = request.url.split("?", 1)[0];
      const hubAction = hubPath === "/api/hub/status"
        ? "status"
        : hubPath === "/api/hub/enable"
          ? "enable"
          : hubPath === "/api/hub/resources"
            ? "list"
            : hubPath === "/api/hub/intelligence"
              ? "intelligence"
              : hubPath === "/api/hub/export"
                ? "export"
                : hubPath === "/api/hub/delete"
                  ? "delete"
                  : undefined;
      if (hubAction) {
        void emitAudit(audit, {
          event: "fhir_hub",
          hubAction,
          outcome: appError.statusCode === 401 ||
              appError.statusCode === 403 ||
              appError.code === "fhir_hub_consent_required" ||
              appError.code === "connection_context_required" ||
              appError.code === "connection_context_changed"
            ? "denied"
            : "failure",
          requestId: request.id,
          ...(sessionId
            ? { sessionRef: pseudonymousSessionRef(sessionId, config.sessionSecret) }
            : {}),
          errorCode: appError.code,
        });
      }
    } else if (
      request.url.startsWith("/api/fhir/") ||
      request.url === "/api/patient" ||
      request.url.startsWith("/api/fhir-page")
    ) {
      const requestedResourceType = request.url === "/api/patient"
        ? "Patient"
        : request.url.startsWith("/api/fhir-page")
          ? undefined
        : request.url.slice("/api/fhir/".length).split(/[/?]/, 1)[0];
      const resourceType = boundedAuditResourceType(
        requestedResourceType,
        config.allowedResourceTypes,
      );
      void emitAudit(audit, {
        event: "fhir_access",
        outcome: appError.statusCode === 401 || appError.statusCode === 403 ? "denied" : "failure",
        requestId: request.id,
        ...(sessionId
          ? { sessionRef: pseudonymousSessionRef(sessionId, config.sessionSecret) }
          : {}),
        ...(resourceType ? { resourceType } : {}),
        interaction: request.url === "/api/patient" || /^\/api\/fhir\/[^/?]+\/[^/?]+/.test(request.url)
          ? "read"
          : "search",
        errorCode: appError.code,
      });
    } else if (
      request.url === "/api/disconnect" ||
      request.url === "/api/disconnect-all"
    ) {
      void emitAudit(audit, {
        event: "disconnect",
        outcome: "failure",
        requestId: request.id,
        ...(sessionId
          ? { sessionRef: pseudonymousSessionRef(sessionId, config.sessionSecret) }
          : {}),
        errorCode: appError.code,
      });
    }
    if (
      request.url.startsWith("/api/") ||
      (request.url === "/auth/start" && acceptsJson(request.headers.accept))
    ) {
      return reply.code(appError.statusCode).send({
        error: { code: appError.code, message: appError.publicMessage },
      });
    }
    return reply
      .code(appError.statusCode)
      .type("text/html; charset=utf-8")
      .send(renderError(appError.publicMessage, {
        requestId: request.id,
        errorCode: appError.code,
      }));
  });

  return app;
}
