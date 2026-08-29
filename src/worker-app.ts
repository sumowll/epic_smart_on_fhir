import { createHmac, timingSafeEqual } from "node:crypto";

import {
  boundedAuditResourceType,
  emitAudit,
  newRequestId,
  pseudonymousAuthorizationRef,
  productionAuditSink,
  pseudonymousSessionRef,
} from "./audit.js";
import { EpicConnectorService } from "./connector.js";
import { contentSecurityPolicy } from "./csp.js";
import { AppError, ReconnectRequiredError, safeErrorDiagnostic } from "./errors.js";
import type { FhirHubIntelligenceOptions, FhirHubListOptions } from "./fhir-hub.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import { randomBase64Url } from "./security.js";
import type { AppConfig } from "./types.js";
import {
  browserScript,
  renderError,
  renderHome,
  renderPrivacy,
  renderTerms,
  styles,
} from "./ui.js";

const sessionIdPattern = /^[A-Za-z0-9_-]{40,100}$/;
const routedCookieSeparator = "~";

export interface WorkerSessionContext {
  readonly routeId: string;
  readonly sessionId: string;
}

export interface WorkerLifecycleHooks {
  readonly onConnected?: (sessionId: string, routeId: string) => Promise<void>;
  readonly onDisconnected?: (routeId: string) => Promise<void>;
  readonly disconnectAll?: (
    sessionId: string,
    routeId: string,
  ) => Promise<{
    readonly disconnected: true;
    readonly connectionsRemoved: number;
    readonly manualRevocationRecommended: boolean;
  }>;
}

function equalString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function acceptsJsonHeader(value: string | null | undefined): boolean {
  return value?.split(",").some((entry) =>
    entry.split(";", 1)[0]?.trim().toLowerCase() === "application/json") ?? false;
}

function acceptsJson(request: Request): boolean {
  return acceptsJsonHeader(request.headers.get("Accept"));
}

function requiredWorkerConnectionContext(request: Request): string {
  const value = request.headers.get("X-Epic-Expected-Connection-Context");
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new AppError(
      409,
      "connection_context_required",
      "Refresh the current MyChart connection before managing the private health hub.",
    );
  }
  return value;
}

function workerHubListOptions(parameters: URLSearchParams): FhirHubListOptions {
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

function workerHubIntelligenceOptions(
  parameters: URLSearchParams,
): FhirHubIntelligenceOptions {
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

function signCookieValue(value: string, secret: string): string {
  const signature = createHmac("sha256", secret)
    .update(value)
    .digest("base64")
    .replace(/=/g, "");
  return `${value}.${signature}`;
}

function unsignCookieValue(value: string, secret: string): string | undefined {
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return undefined;
  const unsigned = value.slice(0, separator);
  const actual = Buffer.from(value.slice(separator + 1), "utf8");
  const expected = Buffer.from(
    createHmac("sha256", secret)
      .update(unsigned)
      .digest("base64")
      .replace(/=/g, ""),
    "utf8",
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? unsigned
    : undefined;
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    return item.slice(separator + 1).trim();
  }
  return undefined;
}

export function readWorkerSessionId(
  request: Request,
  config: AppConfig,
): string | undefined {
  return readWorkerSessionContext(request, config)?.sessionId;
}

export function readWorkerSessionContext(
  request: Request,
  config: AppConfig,
): WorkerSessionContext | undefined {
  const signed = readCookie(request.headers.get("Cookie"), config.cookieName);
  if (!signed) return undefined;
  const payload = unsignCookieValue(signed, config.sessionSecret);
  if (!payload) return undefined;
  const separator = payload.indexOf(routedCookieSeparator);
  if (separator === -1) {
    return sessionIdPattern.test(payload)
      ? { routeId: payload, sessionId: payload }
      : undefined;
  }
  if (payload.indexOf(routedCookieSeparator, separator + 1) !== -1) return undefined;
  const routeId = payload.slice(0, separator);
  const sessionId = payload.slice(separator + 1);
  return sessionIdPattern.test(routeId) && sessionIdPattern.test(sessionId)
    ? { routeId, sessionId }
    : undefined;
}

function sessionCookie(
  config: AppConfig,
  sessionId: string,
  routeId = sessionId,
): string {
  const attributes = [
    `${config.cookieName}=${signCookieValue(`${routeId}${routedCookieSeparator}${sessionId}`, config.sessionSecret)}`,
    "Path=/",
    `Max-Age=${config.sessionMaxLifetimeMs / 1_000}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (config.cookieSecure) attributes.push("Secure");
  return attributes.join("; ");
}

function expiredSessionCookie(config: AppConfig): string {
  const attributes = [
    `${config.cookieName}=`,
    "Path=/",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (config.cookieSecure) attributes.push("Secure");
  return attributes.join("; ");
}

export function applySecurityHeaders(headers: Headers, config: AppConfig): void {
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("Referrer-Policy", "same-origin");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set(
    "Content-Security-Policy",
    contentSecurityPolicy(config),
  );
  if (config.cookieSecure) {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

export function workerResponse(
  config: AppConfig,
  body: BodyInit | null,
  status: number,
  headers?: HeadersInit,
  isHead = false,
): Response {
  const responseHeaders = new Headers(headers);
  applySecurityHeaders(responseHeaders, config);
  if (!responseHeaders.has("X-Request-ID")) {
    responseHeaders.set("X-Request-ID", newRequestId());
  }
  return new Response(isHead ? null : body, { status, headers: responseHeaders });
}

export function workerJsonResponse(
  config: AppConfig,
  value: unknown,
  status = 200,
  isHead = false,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  return workerResponse(
    config,
    JSON.stringify(value),
    status,
    responseHeaders,
    isHead,
  );
}

export function workerErrorResponse(
  config: AppConfig,
  pathname: string,
  method: string,
  error: unknown,
  requestId?: string,
  accept?: string | null,
): Response {
  const appError = error instanceof AppError
    ? error
    : new AppError(500, "internal_error", "An unexpected error occurred.");
  const retryAfterSeconds = "retryAfterSeconds" in appError &&
    typeof appError.retryAfterSeconds === "number"
    ? appError.retryAfterSeconds
    : undefined;
  const retryHeaders = retryAfterSeconds === undefined
    ? undefined
    : { "Retry-After": String(retryAfterSeconds) };
  const responseHeaders = {
    ...(retryHeaders ?? {}),
    ...(requestId ? { "X-Request-ID": requestId } : {}),
    ...(pathname === "/auth/start" ? { Vary: "Accept" } : {}),
  };
  const isHead = method === "HEAD";
  return pathname.startsWith("/api/") ||
      (pathname === "/auth/start" && acceptsJsonHeader(accept))
    ? workerJsonResponse(
        config,
        { error: { code: appError.code, message: appError.publicMessage } },
        appError.statusCode,
        isHead,
        responseHeaders,
      )
    : workerResponse(
        config,
        renderError(appError.publicMessage, {
          ...(requestId ? { requestId } : {}),
          errorCode: appError.code,
        }),
        appError.statusCode,
        {
          "Content-Type": "text/html; charset=utf-8",
          ...responseHeaders,
        },
        isHead,
      );
}

export function workerNotFoundResponse(
  config: AppConfig,
  pathname: string,
  isHead: boolean,
): Response {
  return pathname.startsWith("/api/")
    ? workerJsonResponse(
        config,
        { error: { code: "not_found", message: "Route not found." } },
        404,
        isHead,
      )
    : workerResponse(
        config,
        renderError("Page not found."),
        404,
        { "Content-Type": "text/html; charset=utf-8" },
        isHead,
      );
}

export class WorkerHttpApplication {
  readonly #apiLimiter = new FixedWindowRateLimiter(120, 60_000, Date.now, 1_000);

  public constructor(
    private readonly service: EpicConnectorService,
    private readonly lifecycle: WorkerLifecycleHooks = {},
  ) {}

  public async fetch(
    request: Request,
    routedSessionId?: string,
    routedRouteId?: string,
  ): Promise<Response> {
    const url = new URL(request.url);
    const requestId = newRequestId();
    try {
      const response = await this.route(
        request,
        url,
        routedSessionId,
        routedRouteId,
        requestId,
      );
      const headers = new Headers(response.headers);
      headers.set("X-Request-ID", requestId);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      const appError = error instanceof AppError ? error : undefined;
      const sessionId = routedSessionId ?? readWorkerSessionId(request, this.service.config);
      const event = url.pathname === "/auth/start" || url.pathname.startsWith("/auth/callback")
        ? "authorization_failed"
        : url.pathname === "/api/disconnect" || url.pathname === "/api/disconnect-all"
          ? "disconnect"
        : url.pathname.startsWith("/api/hub/")
          ? "fhir_hub"
        : url.pathname.startsWith("/api/fhir/") ||
            url.pathname === "/api/patient" ||
            url.pathname === "/api/fhir-page"
          ? "fhir_access"
          : appError?.code === "rate_limited"
            ? "rate_limited"
            : undefined;
      if (event) {
        const diagnostic = event === "authorization_failed"
          ? safeErrorDiagnostic(error)
          : {};
        const segments = url.pathname.split("/");
        const requestedResourceType = url.pathname === "/api/patient"
          ? "Patient"
          : url.pathname === "/api/fhir-page"
            ? undefined
            : segments[3];
        const resourceType = boundedAuditResourceType(
          requestedResourceType,
          this.service.config.allowedResourceTypes,
        );
        const hubAction = url.pathname === "/api/hub/status"
          ? "status"
          : url.pathname === "/api/hub/enable"
            ? "enable"
            : url.pathname === "/api/hub/resources"
              ? "list"
              : url.pathname === "/api/hub/intelligence"
                ? "intelligence"
                : url.pathname === "/api/hub/export"
                  ? "export"
                  : url.pathname === "/api/hub/delete"
                    ? "delete"
                    : undefined;
        void emitAudit(productionAuditSink, {
          event,
          outcome: appError?.statusCode === 401 ||
              appError?.statusCode === 403 ||
              appError?.code === "consent_required" ||
              appError?.code === "fhir_hub_consent_required" ||
              appError?.code === "connection_context_required" ||
              appError?.code === "connection_context_changed"
            ? "denied"
            : "failure",
          requestId,
          ...(sessionId
            ? { sessionRef: pseudonymousSessionRef(sessionId, this.service.config.sessionSecret) }
            : {}),
          ...(event === "authorization_failed" && sessionId
            ? {
                authorizationRef: pseudonymousAuthorizationRef(
                  sessionId,
                  this.service.config.sessionSecret,
                ),
              }
            : {}),
          ...(event === "fhir_access"
            ? {
                ...(resourceType ? { resourceType } : {}),
                interaction: url.pathname === "/api/patient" ||
                    (url.pathname.startsWith("/api/fhir/") && segments.length > 4)
                  ? "read"
                  : "search",
              }
            : {}),
          ...(event === "fhir_hub" && hubAction ? { hubAction } : {}),
          ...(appError ? { errorCode: appError.code } : {}),
          ...diagnostic,
        });
      }
      return workerErrorResponse(
        this.service.config,
        url.pathname,
        request.method,
        error,
        requestId,
        request.headers.get("Accept"),
      );
    }
  }

  private async route(
    request: Request,
    url: URL,
    routedSessionId?: string,
    routedRouteId?: string,
    requestId = newRequestId(),
  ): Promise<Response> {
    const { pathname } = url;
    const isHead = request.method === "HEAD";
    const safeMethod = isHead ? "GET" : request.method;

    if (safeMethod === "GET" && pathname === "/") {
      return this.response(
        renderHome(this.service.config),
        200,
        { "Content-Type": "text/html; charset=utf-8" },
        isHead,
      );
    }
    if (safeMethod === "GET" && pathname === "/terms") {
      return this.response(
        renderTerms(this.service.config),
        200,
        { "Content-Type": "text/html; charset=utf-8" },
        isHead,
      );
    }
    if (safeMethod === "GET" && pathname === "/privacy") {
      return this.response(
        renderPrivacy(this.service.config),
        200,
        { "Content-Type": "text/html; charset=utf-8" },
        isHead,
      );
    }
    if (safeMethod === "GET" && pathname === "/styles.css") {
      return this.response(
        styles,
        200,
        { "Content-Type": "text/css; charset=utf-8" },
        isHead,
      );
    }
    if (safeMethod === "GET" && pathname === "/app.js") {
      return this.response(
        browserScript,
        200,
        { "Content-Type": "application/javascript; charset=utf-8" },
        isHead,
      );
    }
    if (safeMethod === "GET" && pathname === "/healthz") {
      return this.json({ status: "ok" }, 200, isHead);
    }
    if (safeMethod === "GET" && pathname === "/readyz") {
      try {
        await this.service.checkReadiness();
        return this.json({ status: "ready" }, 200, isHead);
      } catch {
        return this.json({ status: "not_ready" }, 503, isHead);
      }
    }
    if (request.method === "POST" && pathname === "/auth/start") {
      this.requireSameOrigin(request);
      const consent = await this.readConsent(request);
      const cookieSessionId = this.readSessionId(request, routedSessionId, routedRouteId);
      const sessionId = routedSessionId ?? cookieSessionId ?? randomBase64Url(32);
      const routeId = routedRouteId ?? sessionId;
      const location = await this.service.startAuthorization(sessionId, consent);
      const sessionRef = pseudonymousSessionRef(sessionId, this.service.config.sessionSecret);
      const authorizationRef = pseudonymousAuthorizationRef(
        sessionId,
        this.service.config.sessionSecret,
      );
      void emitAudit(productionAuditSink, {
        event: "consent_recorded",
        outcome: "success",
        requestId,
        sessionRef,
        authorizationRef,
        policyVersion: consent,
      });
      void emitAudit(productionAuditSink, {
        event: "authorization_started",
        outcome: "success",
        requestId,
        sessionRef,
        authorizationRef,
      });
      const responseHeaders = {
        "Set-Cookie": sessionCookie(this.service.config, sessionId, routeId),
        Vary: "Accept",
      };
      if (acceptsJson(request)) {
        return this.json({ authorizationUrl: location }, 200, false, responseHeaders);
      }
      return this.response(null, 303, {
        ...responseHeaders,
        Location: location,
      });
    }
    if (request.method === "GET" && pathname === "/auth/callback") {
      const pendingSessionId = this.requireSessionId(request, routedSessionId, routedRouteId);
      const authenticatedSessionId = await this.service.completeAuthorization(
        pendingSessionId,
        `${pathname}${url.search}`,
      );
      const authenticatedRouteId = routedRouteId ?? routedSessionId ?? authenticatedSessionId;
      try {
        await this.lifecycle.onConnected?.(authenticatedSessionId, authenticatedRouteId);
      } catch (error) {
        const cleanup = await this.service.disconnect(authenticatedSessionId).catch(() => undefined);
        if (cleanup?.remoteRevocation !== "success") {
          throw new AppError(
            502,
            "authorization_cleanup_required",
            "The connection was not saved and automatic Epic grant cleanup could not be confirmed. Remove this app in MyChart's linked apps/devices settings before trying again.",
            { cause: error },
          );
        }
        throw new AppError(
          503,
          "connection_registry_unavailable",
          "The connection could not be registered safely. Please try again.",
          { cause: error },
        );
      }
      void emitAudit(productionAuditSink, {
        event: "authorization_completed",
        outcome: "success",
        requestId,
        sessionRef: pseudonymousSessionRef(
          authenticatedSessionId,
          this.service.config.sessionSecret,
        ),
        authorizationRef: pseudonymousAuthorizationRef(
          pendingSessionId,
          this.service.config.sessionSecret,
        ),
      });
      return this.response(null, 303, {
        Location: "/",
        "Set-Cookie": sessionCookie(
          this.service.config,
          authenticatedSessionId,
          authenticatedRouteId,
        ),
      });
    }
    if (safeMethod === "GET" && pathname === "/api/connection") {
      return this.json(
        await this.service.getConnectionSummary(
          this.readSessionId(request, routedSessionId, routedRouteId),
        ),
        200,
        isHead,
      );
    }
    if (request.method === "GET" && pathname === "/api/hub/status") {
      const sessionId = this.requireSessionId(request, routedSessionId, routedRouteId);
      this.enforceApiRateLimit(sessionId);
      const result = await this.service.getFhirHubStatusBound(
        sessionId,
        requiredWorkerConnectionContext(request),
      );
      void emitAudit(productionAuditSink, {
        event: "fhir_hub",
        hubAction: "status",
        outcome: "success",
        requestId,
        sessionRef: pseudonymousSessionRef(sessionId, this.service.config.sessionSecret),
      });
      return this.json(result.value, 200, false, {
        "X-Epic-Connection-Context": result.connectionContext,
      });
    }
    if (request.method === "POST" && pathname === "/api/hub/enable") {
      this.requireSameOrigin(request);
      const sessionId = this.requireSessionId(request, routedSessionId, routedRouteId);
      this.enforceApiRateLimit(sessionId);
      const body = await this.readExactJsonObject(
        request,
        ["policyVersion"],
        "invalid_hub_consent",
      );
      if (body.policyVersion !== this.service.config.fhirHubConsentVersion) {
        throw new AppError(
          409,
          "fhir_hub_consent_required",
          "Review and accept the current private health hub notice before enabling storage.",
        );
      }
      const result = await this.service.enableFhirHubBound(
        sessionId,
        body.policyVersion,
        requiredWorkerConnectionContext(request),
      );
      void emitAudit(productionAuditSink, {
        event: "fhir_hub",
        hubAction: "enable",
        outcome: "success",
        requestId,
        sessionRef: pseudonymousSessionRef(sessionId, this.service.config.sessionSecret),
        policyVersion: body.policyVersion,
      });
      return this.json(result.value, 200, false, {
        "X-Epic-Connection-Context": result.connectionContext,
      });
    }
    if (request.method === "GET" && pathname === "/api/hub/resources") {
      const sessionId = this.requireSessionId(request, routedSessionId, routedRouteId);
      this.enforceApiRateLimit(sessionId);
      const result = await this.service.listFhirHubResourcesBound(
        sessionId,
        workerHubListOptions(url.searchParams),
        requiredWorkerConnectionContext(request),
      );
      void emitAudit(productionAuditSink, {
        event: "fhir_hub",
        hubAction: "list",
        outcome: "success",
        requestId,
        sessionRef: pseudonymousSessionRef(sessionId, this.service.config.sessionSecret),
      });
      return this.json(result.value, 200, false, {
        "X-Epic-Connection-Context": result.connectionContext,
      });
    }
    if (request.method === "GET" && pathname === "/api/hub/intelligence") {
      const sessionId = this.requireSessionId(request, routedSessionId, routedRouteId);
      this.enforceApiRateLimit(sessionId);
      const result = await this.service.getFhirHubIntelligenceBound(
        sessionId,
        workerHubIntelligenceOptions(url.searchParams),
        requiredWorkerConnectionContext(request),
      );
      void emitAudit(productionAuditSink, {
        event: "fhir_hub",
        hubAction: "intelligence",
        outcome: "success",
        requestId,
        sessionRef: pseudonymousSessionRef(sessionId, this.service.config.sessionSecret),
      });
      return this.json(result.value, 200, false, {
        "X-Epic-Connection-Context": result.connectionContext,
      });
    }
    if (request.method === "GET" && pathname === "/api/hub/export") {
      const sessionId = this.requireSessionId(request, routedSessionId, routedRouteId);
      this.enforceApiRateLimit(sessionId);
      const result = await this.service.exportFhirHubBound(
        sessionId,
        requiredWorkerConnectionContext(request),
      );
      void emitAudit(productionAuditSink, {
        event: "fhir_hub",
        hubAction: "export",
        outcome: "success",
        requestId,
        sessionRef: pseudonymousSessionRef(sessionId, this.service.config.sessionSecret),
      });
      return this.json(result.value, 200, false, {
        "X-Epic-Connection-Context": result.connectionContext,
        "Content-Disposition": 'attachment; filename="moonba-health-hub.json"',
      });
    }
    if (request.method === "POST" && pathname === "/api/hub/delete") {
      this.requireSameOrigin(request);
      const sessionId = this.requireSessionId(request, routedSessionId, routedRouteId);
      this.enforceApiRateLimit(sessionId);
      const body = await this.readExactJsonObject(
        request,
        ["confirmation"],
        "invalid_hub_delete_request",
      );
      if (body.confirmation !== "DELETE MY HEALTH HUB") {
        throw new AppError(
          400,
          "fhir_hub_delete_confirmation_required",
          "Type the exact deletion confirmation before permanently deleting the private health hub.",
        );
      }
      const result = await this.service.deleteFhirHubBound(
        sessionId,
        body.confirmation,
        requiredWorkerConnectionContext(request),
      );
      void emitAudit(productionAuditSink, {
        event: "fhir_hub",
        hubAction: "delete",
        outcome: "success",
        requestId,
        sessionRef: pseudonymousSessionRef(sessionId, this.service.config.sessionSecret),
      });
      return this.json(result.value, 200, false, {
        "X-Epic-Connection-Context": result.connectionContext,
      });
    }
    if (request.method === "GET" && pathname === "/api/patient") {
      this.enforceApiRateLimit(routedSessionId);
      const sessionId = this.requireSessionId(request, routedSessionId, routedRouteId);
      const result = await this.service.readPatientBound(
        sessionId,
        request.headers.get("X-Epic-Expected-Connection-Context") ?? undefined,
      );
      void emitAudit(productionAuditSink, {
        event: "fhir_access",
        outcome: "success",
        requestId,
        sessionRef: pseudonymousSessionRef(sessionId, this.service.config.sessionSecret),
        resourceType: "Patient",
        interaction: "read",
      });
      return this.json(result.value, 200, false, {
        "X-Epic-Connection-Context": result.connectionContext,
      });
    }
    if (request.method === "GET" && pathname === "/api/fhir-page") {
      this.enforceApiRateLimit(routedSessionId);
      const sessionId = this.requireSessionId(request, routedSessionId, routedRouteId);
      const cursors = url.searchParams.getAll("cursor");
      if (url.searchParams.size !== 1 || cursors.length !== 1 || !cursors[0]) {
        throw new AppError(400, "invalid_page_cursor", "The FHIR page cursor is invalid or expired.");
      }
      const result = await this.service.pageBound(
        sessionId,
        cursors[0],
        request.headers.get("X-Epic-Expected-Connection-Context") ?? undefined,
      );
      void emitAudit(productionAuditSink, {
        event: "fhir_access",
        outcome: "success",
        requestId,
        sessionRef: pseudonymousSessionRef(sessionId, this.service.config.sessionSecret),
        resourceType: result.resourceType,
        interaction: "search",
      });
      return this.json(result.value, 200, false, {
        "X-Epic-Connection-Context": result.connectionContext,
      });
    }
    if (request.method === "GET" && pathname.startsWith("/api/fhir/")) {
      this.enforceApiRateLimit(routedSessionId);
      const segments = pathname.slice("/api/fhir/".length).split("/");
      if (
        segments.length < 1 ||
        segments.length > 2 ||
        segments.some((segment) => !segment)
      ) {
        return this.notFound(pathname, false);
      }
      let resourceType: string;
      let id: string | undefined;
      try {
        resourceType = decodeURIComponent(segments[0]!);
        id = segments[1] ? decodeURIComponent(segments[1]) : undefined;
      } catch {
        return this.notFound(pathname, false);
      }
      const sessionId = this.requireSessionId(request, routedSessionId, routedRouteId);
      if (id) {
        const result = await this.service.readBound(
          sessionId,
          resourceType,
          id,
          request.headers.get("X-Epic-Expected-Connection-Context") ?? undefined,
        );
        void emitAudit(productionAuditSink, {
          event: "fhir_access",
          outcome: "success",
          requestId,
          sessionRef: pseudonymousSessionRef(sessionId, this.service.config.sessionSecret),
          resourceType,
          interaction: "read",
        });
        return this.json(result.value, 200, false, {
          "X-Epic-Connection-Context": result.connectionContext,
        });
      }
      const result = await this.service.searchBound(
        sessionId,
        resourceType,
        url.searchParams,
        request.headers.get("X-Epic-Expected-Connection-Context") ?? undefined,
      );
      void emitAudit(productionAuditSink, {
        event: "fhir_access",
        outcome: "success",
        requestId,
        sessionRef: pseudonymousSessionRef(sessionId, this.service.config.sessionSecret),
        resourceType,
        interaction: "search",
      });
      return this.json(result.value, 200, false, {
        "X-Epic-Connection-Context": result.connectionContext,
      });
    }
    if (request.method === "POST" && pathname === "/api/disconnect") {
      this.requireSameOrigin(request);
      const sessionId = this.readSessionId(request, routedSessionId, routedRouteId);
      if (sessionId) {
        await this.service.assertConnectionContext(
          sessionId,
          request.headers.get("X-Epic-Expected-Connection-Context") ?? undefined,
        );
      }
      const headers = sessionId
        ? { "Set-Cookie": expiredSessionCookie(this.service.config) }
        : undefined;
      const outcome = await this.service.disconnect(sessionId);
      if (routedRouteId) {
        await this.lifecycle.onDisconnected?.(routedRouteId).catch(() => undefined);
      }
      void emitAudit(productionAuditSink, {
        event: "disconnect",
        outcome: outcome.remoteRevocation === "failed" ? "failure" : "success",
        requestId,
        ...(sessionId
          ? { sessionRef: pseudonymousSessionRef(sessionId, this.service.config.sessionSecret) }
          : {}),
        remoteRevocation: outcome.remoteRevocation,
      });
      return this.json(outcome, 200, false, headers);
    }
    if (request.method === "POST" && pathname === "/api/disconnect-all") {
      this.requireSameOrigin(request);
      const sessionId = this.requireSessionId(request, routedSessionId, routedRouteId);
      await this.service.assertConnectionContext(
        sessionId,
        request.headers.get("X-Epic-Expected-Connection-Context") ?? undefined,
      );
      const routeId = routedRouteId ?? routedSessionId;
      if (!routeId) throw new AppError(400, "invalid_session", "The browser session is invalid.");
      const outcome = this.lifecycle.disconnectAll
        ? await this.lifecycle.disconnectAll(sessionId, routeId)
        : await this.service.disconnectAllForAccount(sessionId);
      void emitAudit(productionAuditSink, {
        event: "disconnect",
        outcome: outcome.manualRevocationRecommended ? "failure" : "success",
        requestId,
        sessionRef: pseudonymousSessionRef(sessionId, this.service.config.sessionSecret),
        remoteRevocation: outcome.manualRevocationRecommended ? "incomplete" : "success",
      });
      return this.json(outcome, 200, false, {
        "Set-Cookie": expiredSessionCookie(this.service.config),
      });
    }
    return this.notFound(pathname, isHead);
  }

  private readSessionId(
    request: Request,
    routedSessionId?: string,
    routedRouteId?: string,
  ): string | undefined {
    const context = readWorkerSessionContext(request, this.service.config);
    const sessionId = context?.sessionId;
    if (
      routedSessionId &&
      sessionId &&
      !equalString(routedSessionId, sessionId)
    ) {
      throw new AppError(400, "invalid_session", "The browser session is invalid.");
    }
    if (
      routedRouteId &&
      context?.routeId &&
      !equalString(routedRouteId, context.routeId)
    ) {
      throw new AppError(400, "invalid_session", "The browser session is invalid.");
    }
    return sessionId;
  }

  private requireSessionId(
    request: Request,
    routedSessionId?: string,
    routedRouteId?: string,
  ): string {
    const sessionId = this.readSessionId(request, routedSessionId, routedRouteId);
    if (!sessionId) {
      throw new ReconnectRequiredError("Connect your MyChart account first.");
    }
    return sessionId;
  }

  private requireSameOrigin(request: Request): void {
    if (request.headers.get("Origin") !== this.service.config.publicOrigin) {
      throw new AppError(403, "origin_rejected", "The request origin was rejected.");
    }
  }

  private async readExactJsonObject(
    request: Request,
    allowedKeys: readonly string[],
    errorCode: string,
  ): Promise<Record<string, unknown>> {
    const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    const contentLength = Number(request.headers.get("Content-Length"));
    if (
      contentType !== "application/json" ||
      (Number.isFinite(contentLength) && contentLength > 4_096)
    ) {
      throw new AppError(400, errorCode, "The private health hub request was invalid.");
    }
    const text = await request.text();
    if (!text || text.length > 4_096) {
      throw new AppError(400, errorCode, "The private health hub request was invalid.");
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new AppError(400, errorCode, "The private health hub request was invalid.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new AppError(400, errorCode, "The private health hub request was invalid.");
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => !allowedKeys.includes(key))) {
      throw new AppError(400, errorCode, "The private health hub request was invalid.");
    }
    return record;
  }

  private async readConsent(request: Request): Promise<string> {
    const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim();
    const contentLength = Number(request.headers.get("Content-Length"));
    if (
      contentType !== "application/x-www-form-urlencoded" ||
      (Number.isFinite(contentLength) && contentLength > 4_096)
    ) {
      throw new AppError(400, "invalid_consent_request", "The consent request was invalid.");
    }
    const text = await request.text();
    if (text.length > 4_096) {
      throw new AppError(400, "invalid_consent_request", "The consent request was invalid.");
    }
    const body = new URLSearchParams(text);
    if (
      body.getAll("consent").length !== 1 ||
      body.get("consent") !== "accepted" ||
      body.getAll("policyVersion").length !== 1 ||
      body.get("policyVersion") !== this.service.config.consentPolicyVersion
    ) {
      throw new AppError(
        409,
        "consent_required",
        "Review and accept the current Terms and Privacy Notice before connecting.",
      );
    }
    return this.service.config.consentPolicyVersion;
  }

  private enforceApiRateLimit(sessionId: string | undefined): void {
    if (!sessionId) return;
    const decision = this.#apiLimiter.check(sessionId);
    if (!decision.allowed) {
      throw new AppError(429, "rate_limited", "Too many requests. Please try again shortly.");
    }
  }

  private notFound(pathname: string, isHead: boolean): Response {
    return workerNotFoundResponse(this.service.config, pathname, isHead);
  }

  private json(
    value: unknown,
    status = 200,
    isHead = false,
    headers?: HeadersInit,
  ): Response {
    return workerJsonResponse(
      this.service.config,
      value,
      status,
      isHead,
      headers,
    );
  }

  private response(
    body: BodyInit | null,
    status: number,
    headers?: HeadersInit,
    isHead = false,
  ): Response {
    return workerResponse(
      this.service.config,
      body,
      status,
      headers,
      isHead,
    );
  }
}
