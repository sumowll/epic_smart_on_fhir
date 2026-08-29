import type { AppConfig } from "./types.js";

export function contentSecurityPolicy(_config: AppConfig): string {
  // The browser posts consent to this origin, receives the authorization URL
  // as JSON, and then performs a top-level navigation. No form needs permission
  // to submit credentials or other fields to a cross-origin destination.
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}
