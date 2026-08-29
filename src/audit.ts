import { createHmac, randomUUID } from "node:crypto";

export type AuditOutcome = "success" | "denied" | "failure";

export interface AuditEvent {
  readonly event:
    | "authorization_started"
    | "authorization_completed"
    | "authorization_failed"
    | "consent_recorded"
    | "fhir_access"
    | "fhir_hub"
    | "disconnect"
    | "rate_limited"
    | "background_cleanup_failed";
  readonly outcome: AuditOutcome;
  readonly requestId: string;
  readonly at: string;
  readonly sessionRef?: string;
  readonly authorizationRef?: string;
  readonly resourceType?: string;
  readonly interaction?: "read" | "search";
  readonly hubAction?: "status" | "enable" | "list" | "intelligence" | "export" | "delete";
  readonly errorCode?: string;
  readonly causeCode?: string;
  readonly upstreamStatus?: number;
  readonly policyVersion?: string;
  readonly remoteRevocation?: string;
}

export type AuditSink = (event: AuditEvent) => void | Promise<void>;

export function newRequestId(): string {
  return randomUUID();
}

export function pseudonymousSessionRef(sessionId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update("audit-session\0", "utf8")
    .update(sessionId, "utf8")
    .digest("base64url")
    .slice(0, 24);
}

export function pseudonymousAuthorizationRef(sessionId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update("audit-authorization\0", "utf8")
    .update(sessionId, "utf8")
    .digest("base64url")
    .slice(0, 24);
}

export function boundedAuditResourceType(
  candidate: string | undefined,
  allowedResourceTypes: ReadonlySet<string>,
): string | undefined {
  if (!candidate) return undefined;
  return candidate === "Patient" || allowedResourceTypes.has(candidate)
    ? candidate
    : undefined;
}

export function productionAuditSink(event: AuditEvent): void {
  // Deliberately excludes URLs, query strings, FHIR identifiers, and response bodies.
  console.info(JSON.stringify({ audit: event }));
}

export async function emitAudit(
  sink: AuditSink,
  event: Omit<AuditEvent, "at">,
): Promise<void> {
  try {
    await sink({ ...event, at: new Date().toISOString() });
  } catch {
    // Audit transport must never leak data into an error or break the patient flow.
  }
}
