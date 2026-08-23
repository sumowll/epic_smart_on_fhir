import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { EpicConnectorService, sessionLifetimeMs } from "./connector.js";
import { AppError, ReconnectRequiredError } from "./errors.js";
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

export interface AppDependencies {
  readonly fetch?: FetchLike;
  readonly store?: ConnectionStore;
  readonly pending?: PendingAuthorizationRepository;
  readonly now?: () => number;
  readonly enablePruneTimer?: boolean;
}

function makeStore(config: AppConfig): ConnectionStore {
  if (config.tokenStorage === "memory") return new InMemoryConnectionStore();
  if (!config.tokenEncryptionKey) {
    throw new AppError(500, "invalid_config", "The token encryption key is missing.");
  }
  return new EncryptedFileConnectionStore(config.tokenStoreFile, config.tokenEncryptionKey);
}

export async function buildApp(
  config: AppConfig,
  dependencies: AppDependencies = {},
): Promise<FastifyInstance> {
  const store = dependencies.store ?? makeStore(config);
  const service = new EpicConnectorService(config, store, {
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    pending: dependencies.pending ?? new PendingAuthorizationStore(10 * 60 * 1_000, dependencies.now),
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  const app = Fastify({
    logger: false,
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
): Promise<FastifyInstance> {
  const config = service.config;
  await app.register(cookie, { secret: config.sessionSecret, hook: "onRequest" });

  const pruneTimer = enablePruneTimer
    ? setInterval(() => {
        void service.pruneExpiredConnections().catch(() => undefined);
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
      maxAge: sessionLifetimeMs / 1_000,
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

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Pragma", "no-cache");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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

  app.post("/auth/start", async (request, reply) => {
    requireSameOrigin(request);
    const sessionId = getOrCreateSessionId(request, reply);
    const authorizationUrl = await service.startAuthorization(sessionId);
    return reply.code(303).header("Location", authorizationUrl).send();
  });

  app.get("/auth/callback", async (request, reply) => {
    const sessionId = requireSessionId(request);
    const authenticatedSessionId = await service.completeAuthorization(
      sessionId,
      request.raw.url ?? "/auth/callback",
    );
    setSessionCookie(reply, authenticatedSessionId);
    return reply.code(303).header("Location", "/").send();
  });

  app.get("/api/connection", async (request) => {
    return service.getConnectionSummary(readSessionId(request));
  });

  app.get("/api/patient", async (request) => {
    return service.readPatient(requireSessionId(request));
  });

  app.get<{ Params: { resourceType: string } }>("/api/fhir/:resourceType", async (request) => {
    const search = new URL(request.raw.url ?? "/", config.publicOrigin).searchParams;
    return service.search(
      requireSessionId(request),
      request.params.resourceType,
      search,
    );
  });

  app.post("/api/disconnect", async (request, reply) => {
    requireSameOrigin(request);
    const sessionId = readSessionId(request);
    const outcome = await service.disconnect(sessionId);
    if (sessionId) reply.clearCookie(config.cookieName, { path: "/" });
    return outcome;
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: { code: "not_found", message: "Route not found." } });
    }
    return reply.code(404).type("text/html; charset=utf-8").send(renderError("Page not found."));
  });

  app.setErrorHandler(async (error, request, reply) => {
    const appError = error instanceof AppError
      ? error
      : new AppError(500, "internal_error", "An unexpected error occurred.");
    if (request.url.startsWith("/api/")) {
      return reply.code(appError.statusCode).send({
        error: { code: appError.code, message: appError.publicMessage },
      });
    }
    return reply
      .code(appError.statusCode)
      .type("text/html; charset=utf-8")
      .send(renderError(appError.publicMessage));
  });

  return app;
}
