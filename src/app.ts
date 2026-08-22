import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { AppError, ReconnectRequiredError } from "./errors.js";
import { EpicFhirClient } from "./fhir.js";
import { EpicDiscoveryService } from "./discovery.js";
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
import {
  EncryptedFileConnectionStore,
  InMemoryConnectionStore,
} from "./store.js";
import type { AppConfig, ConnectionRecord, ConnectionStore, FetchLike } from "./types.js";
import { browserScript, renderError, renderHome, styles } from "./ui.js";

export interface AppDependencies {
  readonly fetch?: FetchLike;
  readonly store?: ConnectionStore;
  readonly now?: () => number;
}

const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1_000;

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
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const store = dependencies.store ?? makeStore(config);
  await store.initialize();

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
    return await configureApp(app, config, store, fetch, now);
  } catch (error) {
    await app.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    throw error;
  }
}

async function configureApp(
  app: FastifyInstance,
  config: AppConfig,
  store: ConnectionStore,
  fetch: FetchLike,
  now: () => number,
): Promise<FastifyInstance> {
  await app.register(cookie, { secret: config.sessionSecret, hook: "onRequest" });

  const discovery = new EpicDiscoveryService(config, fetch, now);
  const oauth = new EpicOAuthClient(config, fetch, now);
  const idTokenVerifier = new EpicIdTokenVerifier(config, fetch);
  const tokenManager = new EpicTokenManager(store, oauth, now);
  const fhir = new EpicFhirClient(config, fetch);
  const pending = new PendingAuthorizationStore(10 * 60 * 1_000, now);

  let pruning = false;
  const pruneExpiredConnections = async (): Promise<void> => {
    if (pruning) return;
    pruning = true;
    try {
      for (const [sessionId, record] of await store.list()) {
        if (record.sessionExpiresAt > now()) continue;
        await tokenManager.disconnect(sessionId);
      }
    } finally {
      pruning = false;
    }
  };
  await pruneExpiredConnections();
  const pruneTimer = setInterval(() => {
    void pruneExpiredConnections().catch(() => undefined);
  }, 60 * 60 * 1_000);
  pruneTimer.unref();
  app.addHook("onClose", async () => {
    clearInterval(pruneTimer);
    await store.close();
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

  async function withFhirConnection<T>(
    sessionId: string,
    action: (record: ConnectionRecord) => Promise<T>,
  ): Promise<T> {
    try {
      return await action(await tokenManager.getValidConnection(sessionId));
    } catch (error) {
      if (error instanceof ReconnectRequiredError) await tokenManager.disconnect(sessionId);
      throw error;
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
    if (await tokenManager.getConnection(sessionId)) {
      throw new AppError(409, "already_connected", "Disconnect the current MyChart account before connecting again.");
    }
    pending.deleteForSession(sessionId);
    const discovered = await discovery.discover();
    const state = randomBase64Url(32);
    const nonce = randomBase64Url(32);
    const pkce = createPkcePair();
    pending.create(state, {
      sessionId,
      createdAt: now(),
      codeVerifier: pkce.verifier,
      nonce,
      discovery: discovered,
    });
    const authorizationUrl = oauth.buildAuthorizationUrl(discovered, {
      state,
      nonce,
      codeChallenge: pkce.challenge,
    });
    return reply.code(303).header("Location", authorizationUrl).send();
  });

  app.get("/auth/callback", async (request, reply) => {
    const sessionId = requireSessionId(request);
    const callback = parseOAuthCallback(request.raw.url ?? "/auth/callback");
    const authorization = pending.consume(callback.state, sessionId);
    if (callback.kind === "error") {
      throw new AppError(
        400,
        "authorization_denied",
        callback.error === "access_denied"
          ? "MyChart access was not authorized."
          : "MyChart returned an authorization error.",
      );
    }

    const token = await oauth.exchangeCode(
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
      if (config.scopes.includes("openid")) {
        const identity = await idTokenVerifier.verify(
          token.id_token,
          authorization.discovery,
          authorization.nonce,
        );
        fhirUser = identity.fhirUser;
      }

      const connection: ConnectionRecord = {
        oauthClientId: config.clientId,
        fhirBaseUrl: authorization.discovery.fhirBaseUrl,
        tokenEndpoint: authorization.discovery.smart.tokenEndpoint,
        ...(authorization.discovery.smart.revocationEndpoint
          ? { revocationEndpoint: authorization.discovery.smart.revocationEndpoint }
          : {}),
        accessToken: token.access_token,
        ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
        tokenType: "Bearer",
        expiresAt: now() + token.expires_in * 1_000,
        scope: token.scope ?? "",
        patientId: token.patient,
        ...(fhirUser ? { fhirUser } : {}),
        connectedAt: now(),
        sessionExpiresAt: now() + sessionLifetimeMs,
      };
      authenticatedSessionId = randomBase64Url(32);
      pending.deleteForSession(sessionId);
      await tokenManager.invalidate(sessionId);
      await store.set(authenticatedSessionId, connection);
      setSessionCookie(reply, authenticatedSessionId);
      return reply.code(303).header("Location", "/").send();
    } catch (error) {
      if (authenticatedSessionId) {
        await tokenManager.invalidate(authenticatedSessionId).catch(() => undefined);
      }
      let revoked = false;
      const revocationEndpoint = authorization.discovery.smart.revocationEndpoint;
      if (revocationEndpoint) {
        try {
          await oauth.revokeTokens(
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
  });

  app.get("/api/connection", async (request) => {
    const sessionId = readSessionId(request);
    const record = sessionId ? await tokenManager.getConnection(sessionId) : undefined;
    if (!record) return { connected: false, provider: config.providerName };
    return {
      connected: true,
      provider: config.providerName,
      fhirBaseUrl: record.fhirBaseUrl,
      patientId: record.patientId,
      scope: record.scope.split(/\s+/).filter(Boolean),
      expiresAt: new Date(record.expiresAt).toISOString(),
      refreshable: Boolean(record.refreshToken),
      durable: Boolean(record.refreshToken) && config.tokenStorage === "encrypted-file",
      connectedAt: new Date(record.connectedAt).toISOString(),
      localSessionExpiresAt: new Date(record.sessionExpiresAt).toISOString(),
    };
  });

  app.get("/api/patient", async (request) => {
    const sessionId = requireSessionId(request);
    return withFhirConnection(sessionId, (record) => fhir.readPatient(record));
  });

  app.get<{ Params: { resourceType: string } }>("/api/fhir/:resourceType", async (request) => {
    const sessionId = requireSessionId(request);
    const search = new URL(request.raw.url ?? "/", config.publicOrigin).searchParams;
    return withFhirConnection(sessionId, (record) =>
      fhir.search(record, request.params.resourceType, search),
    );
  });

  app.post("/api/disconnect", async (request, reply) => {
    requireSameOrigin(request);
    const sessionId = readSessionId(request);
    if (!sessionId) {
      return { disconnected: true, remoteRevocation: "not_applicable", manualRevocationRecommended: false };
    }

    pending.deleteForSession(sessionId);
    const outcome = await tokenManager.disconnect(sessionId);
    reply.clearCookie(config.cookieName, { path: "/" });

    return {
      disconnected: true,
      remoteRevocation: outcome.remoteRevocation,
      manualRevocationRecommended:
        outcome.hadConnection && outcome.remoteRevocation !== "success",
    };
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
