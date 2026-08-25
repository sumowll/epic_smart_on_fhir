import { createHmac, timingSafeEqual } from "node:crypto";

import { EpicConnectorService, sessionLifetimeMs } from "./connector.js";
import { AppError, ReconnectRequiredError } from "./errors.js";
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

function equalString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
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
  const signed = readCookie(request.headers.get("Cookie"), config.cookieName);
  if (!signed) return undefined;
  const sessionId = unsignCookieValue(signed, config.sessionSecret);
  return sessionId && sessionIdPattern.test(sessionId) ? sessionId : undefined;
}

function sessionCookie(config: AppConfig, sessionId: string): string {
  const attributes = [
    `${config.cookieName}=${signCookieValue(sessionId, config.sessionSecret)}`,
    "Path=/",
    `Max-Age=${sessionLifetimeMs / 1_000}`,
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
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self' https://fhir.epic.com; base-uri 'none'; frame-ancestors 'none'",
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
): Response {
  const appError = error instanceof AppError
    ? error
    : new AppError(500, "internal_error", "An unexpected error occurred.");
  const isHead = method === "HEAD";
  return pathname.startsWith("/api/")
    ? workerJsonResponse(
        config,
        { error: { code: appError.code, message: appError.publicMessage } },
        appError.statusCode,
        isHead,
      )
    : workerResponse(
        config,
        renderError(appError.publicMessage),
        appError.statusCode,
        { "Content-Type": "text/html; charset=utf-8" },
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
  public constructor(private readonly service: EpicConnectorService) {}

  public async fetch(
    request: Request,
    routedSessionId?: string,
  ): Promise<Response> {
    const url = new URL(request.url);
    try {
      return await this.route(request, url, routedSessionId);
    } catch (error) {
      return workerErrorResponse(
        this.service.config,
        url.pathname,
        request.method,
        error,
      );
    }
  }

  private async route(
    request: Request,
    url: URL,
    routedSessionId?: string,
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
    if (request.method === "POST" && pathname === "/auth/start") {
      this.requireSameOrigin(request);
      const cookieSessionId = this.readSessionId(request, routedSessionId);
      const sessionId = routedSessionId ?? cookieSessionId ?? randomBase64Url(32);
      const location = await this.service.startAuthorization(sessionId);
      return this.response(null, 303, {
        Location: location,
        "Set-Cookie": sessionCookie(this.service.config, sessionId),
      });
    }
    if (request.method === "GET" && pathname === "/auth/callback") {
      const authenticatedSessionId = await this.service.completeAuthorization(
        this.requireSessionId(request, routedSessionId),
        `${pathname}${url.search}`,
      );
      return this.response(null, 303, {
        Location: "/",
        "Set-Cookie": sessionCookie(this.service.config, authenticatedSessionId),
      });
    }
    if (safeMethod === "GET" && pathname === "/api/connection") {
      return this.json(
        await this.service.getConnectionSummary(
          this.readSessionId(request, routedSessionId),
        ),
        200,
        isHead,
      );
    }
    if (request.method === "GET" && pathname === "/api/patient") {
      return this.json(
        await this.service.readPatient(this.requireSessionId(request, routedSessionId)),
      );
    }
    if (request.method === "GET" && pathname.startsWith("/api/fhir/")) {
      const encodedResourceType = pathname.slice("/api/fhir/".length);
      if (!encodedResourceType || encodedResourceType.includes("/")) {
        return this.notFound(pathname, false);
      }
      let resourceType: string;
      try {
        resourceType = decodeURIComponent(encodedResourceType);
      } catch {
        return this.notFound(pathname, false);
      }
      return this.json(
        await this.service.search(
          this.requireSessionId(request, routedSessionId),
          resourceType,
          url.searchParams,
        ),
      );
    }
    if (request.method === "POST" && pathname === "/api/disconnect") {
      this.requireSameOrigin(request);
      const sessionId = this.readSessionId(request, routedSessionId);
      const headers = sessionId
        ? { "Set-Cookie": expiredSessionCookie(this.service.config) }
        : undefined;
      return this.json(await this.service.disconnect(sessionId), 200, false, headers);
    }
    return this.notFound(pathname, isHead);
  }

  private readSessionId(
    request: Request,
    routedSessionId?: string,
  ): string | undefined {
    const sessionId = readWorkerSessionId(request, this.service.config);
    if (
      routedSessionId &&
      sessionId &&
      !equalString(routedSessionId, sessionId)
    ) {
      throw new AppError(400, "invalid_session", "The browser session is invalid.");
    }
    return sessionId;
  }

  private requireSessionId(request: Request, routedSessionId?: string): string {
    const sessionId = this.readSessionId(request, routedSessionId);
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
