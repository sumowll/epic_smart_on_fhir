# Incident response and recovery

This playbook applies to the production Cloudflare Worker. Complete the
organization's incident-response plan, contact roster, legal deadlines, and
decision authority before launch. This file does not replace those requirements.

## Roles and contacts

Fill this table in the controlled service record, not in a public repository when
it contains private contact details.

| Role | Primary | Backup | Authority |
|---|---|---|---|
| Incident commander | Required | Required | Declares severity, freezes changes, closes incident |
| Security lead | Required | Required | Containment, evidence, compromise analysis |
| Service owner | Required | Required | Worker, Durable Objects, deployment, recovery |
| Privacy/legal lead | Required | Required | PHI/privacy assessment and notices |
| Epic owner | Required | Required | Epic client, healthcare-organization escalation, revocation |
| Cloudflare owner | Required | Required | Account, BAA/contract, support escalation |
| Communications/support | Required | Required | Approved patient/customer communications |

Record 24-hour paging paths, Epic and Cloudflare support identifiers, cyber
insurance contacts, regulator/customer notice decision paths, and an out-of-band
channel in the service record. Do not put secrets, tokens, patient identifiers, or
OAuth callback URLs with query strings in the contact record.

## Severity guide

| Severity | Examples | Initial response objective |
|---|---|---|
| SEV-1 | Confirmed or plausible unauthorized PHI/token access; signing/encryption/Epic private key compromise; unsafe cross-patient access; destructive storage corruption affecting many users | Page all incident roles, freeze changes, contain immediately, preserve privacy-safe evidence |
| SEV-2 | Sustained production outage; authorization/FHIR failures for a material cohort; readiness/storage failures; sensitive callback query logging with bounded exposure | Page service/security owners, assess privacy impact, mitigate or roll back |
| SEV-3 | Degraded dependency, elevated latency/429/5xx, audit delivery delay, failed cleanup with no evidence of unauthorized access | Assign owner, monitor, repair within the service SLA |
| SEV-4 | Non-production defect, low-risk operational warning, documentation drift | Track through normal change management |

Legal/privacy can raise the severity. Do not lower it merely because a credential
is short-lived or ciphertext was encrypted.

## Rules for every incident

1. Use an incident ID and UTC timestamps. Record facts, decisions, owners, and
   sources; label assumptions.
2. Never paste request/response bodies, cookies, authorization headers, session
   IDs, OAuth codes/state/nonces, patient/FHIR IDs, names, screenshots containing
   PHI, encryption keys, private keys, or client secrets into logs, tickets, chat,
   or the postmortem.
3. Use Worker version IDs, request IDs, aggregate counts, error codes, key IDs,
   pseudonymous audit session references, and hashed/non-reversible object
   references where possible.
4. Freeze deploys and independent secret/config changes until the incident
   commander establishes one change path. A key rotation, code rollback, and
   storage restore are separate changes and can make each other unsafe.
5. Preserve source logs and platform evidence under legal/security direction.
   Do not delete potential evidence as an improvised cleanup action.
6. Prefer disabling the public route or Epic client over continuing unsafe
   patient-data access. The liveness endpoint returning `200` is not proof the
   service is safe.
7. If remote OAuth revocation is unavailable or unreliable, always delete local
   records when authorized and direct users to remove the app in MyChart. For a
   broad event, coordinate client-level revocation/disablement with Epic.
8. Privacy/legal owns the determination of breach, notification, preservation,
   and regulatory/customer deadlines. Engineering must provide bounded evidence,
   not make the legal conclusion.

## First 30 minutes

### Detect and declare

- Acknowledge the page and create the incident record.
- Assign incident commander, security lead, service owner, and scribe.
- State the observed symptom, first/last known times, affected hostname/provider,
  Worker version, and whether patient data or reusable credentials could be in
  scope.
- Freeze production releases and secret changes.

### Contain

Choose the narrowest control that stops unsafe behavior:

- roll traffic back for a code-only regression;
- disable the custom route or serve maintenance mode for an authorization/data
  boundary, credential, or PHI incident;
- disable/revoke the Epic production client with the Epic owner for broad OAuth
  compromise;
- stop a logging/export destination that is ingesting prohibited data while
  preserving access to already-collected evidence; or
- block abusive traffic with Cloudflare controls without adding raw identifiers
  to logs.

Record who approved the containment action and how it will be reversed.

### Establish scope

- Compare deploy, configuration, secret, DNS, WAF, and logging changes around the
  start time.
- Check `/healthz` and `/readyz` separately. A health success plus readiness
  failure points toward Durable Object routing/schema/key/storage; both healthy
  with Epic-flow failure points toward configuration or the external dependency.
- Inspect aggregate audit event/outcome/error-code counts and Cloudflare metrics.
  Query by request ID or pseudonymous session reference only.
- Identify current and previous token key IDs, session-secret change time, Epic
  credential/JWKS version, storage schema version, and active Worker versions
  without exposing key material.
- Determine the maximum possible record/session window from configured idle and
  absolute lifetimes, pending authorization TTL, deployment time, and key
  retention history.

## Playbooks

### OAuth callback code or state appeared in logs

OAuth callbacks carry a short-lived authorization code and state in the query
string. One-time use reduces but does not eliminate risk.

1. Stop the logging/analytics/WAF/export rule that captured callback queries.
2. Preserve the affected dataset under privacy/legal direction and restrict its
   readers immediately.
3. Bound hostname, destination, fields, readers/exporters, time window, count,
   retention, and whether the code could have been used before the connector.
4. Review authorization failures, duplicate-state attempts, new connections, and
   token activity from the window using privacy-safe aggregates.
5. Revoke/delete affected grants when exposure cannot be ruled out. If the set
   cannot be identified safely, coordinate broader Epic client revocation.
6. Remove or redact the prohibited fields at collection, expire unauthorized
   copies according to evidence/legal holds, test with a synthetic callback, and
   obtain security/privacy approval before re-enabling the source.

### Token-encryption key is missing, wrong, or compromised

Symptoms include `token_store_unreadable`, `oauth_state_unreadable`, and failed
existing sessions. Invalid keyring configuration can also fail `/readyz`, but the
normally empty readiness connector cannot prove that every existing session row
decrypts.

For a deployment/configuration mistake:

1. Do not overwrite the current key ID with different bytes.
2. Restore the exact prior key bytes under their original key ID from the approved
   secret manager and include them in `TOKEN_ENCRYPTION_PREVIOUS_KEYS`.
3. Deploy the corrected keyring as one reviewed version; verify readiness, an
   old session, a new authorization, and cleanup.
4. Keep every restored key until the normal retirement boundary has passed.

For suspected compromise:

1. Disable authorization and FHIR traffic if plaintext token access is plausible.
2. Determine whether ciphertext, runtime access, logs, backups, or only the key
   manager was exposed. Treat key plus ciphertext as token/PHI exposure.
3. Generate a new current key and ID; retain the compromised old key only in the
   runtime for the minimum approved transition needed to revoke/delete/re-encrypt
   records. That exception requires security/legal approval.
4. Coordinate Epic client-wide revocation/credential rotation when affected
   grants cannot be individually bounded. The application has no operator-facing
   fleet-wide token purge endpoint.
5. Do not rely on lazy re-encryption alone: it touches only records that are read.
   Expiry metadata permits eventual local deletion without a working key, but it
   does not revoke a still-valid Epic token.
6. Destroy the retired key only after containment, required evidence, revocation,
   and cleanup are complete.

Legacy pre-migration rows have a 30-day cleanup grace from migration 2. New rows
carry their exact absolute session expiry. Allow at least the hourly alarm window
after expiry before asserting cleanup.

### Session-signing secret is compromised

1. Disable traffic if forged or stolen session cookies may be in use.
2. Rotate `SESSION_SECRET` in a coordinated Worker version. This invalidates all
   browser cookies and changes pseudonymous account/audit references.
3. Keep token-encryption keys available so orphaned Durable Object records remain
   decryptable for expiry and deletion.
4. Ask patients to reconnect after risk approval; coordinate broader Epic
   revocation when copied cookies or session-route values may have exposed active
   tokens through the service.
5. Re-establish monitoring baselines because pre- and post-rotation pseudonymous
   references intentionally will not join.

### Epic client secret or private key is compromised

1. Disable the production client/route and notify the Epic owner.
2. Rotate or revoke the credential through the Epic-approved process. For
   private-key JWT, publish/register an overlapping JWKS key, then deploy matching
   algorithm, key ID, and private PEM.
3. Determine whether token exchange/refresh could have been impersonated and
   whether client-wide grant revocation is required.
4. Deploy a coordinated version; test discovery, token exchange, refresh,
   patient read, and disconnect.
5. Remove old credentials only after Epic propagation and the incident decision.

### Durable Object readiness, schema, or storage failure

1. Confirm whether `/healthz` succeeds while `/readyz` fails.
2. Compare the active Worker version, bindings/classes, migration ledger, key IDs,
   and secret/config versions. Check both connector and registry bindings.
3. If the failure followed a deployment and the previous code understands the
   current schema, use the rollback procedure in
   [production-operations.md](production-operations.md#rollback).
4. If the schema is newer than the code, do not force the ledger backward. Deploy
   a forward-compatible repair.
5. If only expired unreadable rows are blocking access, allow the implemented
   cleanup path to delete them; never alter encrypted rows or migration records
   manually without a reviewed recovery tool and backup decision.
6. Escalate a platform-wide failure to Cloudflare with account, Worker version,
   Durable Object class, timestamps, request IDs, and non-sensitive error codes.
7. Require reconnect rather than restoring tokens when safe reconciliation is
   unavailable.

### Epic/provider outage, throttling, or configuration drift

1. Verify public health/readiness, then run the non-PHI provider discovery
   synthetic. Do not use a patient request as a health probe.
2. Separate DNS/TLS/discovery/issuer/JWKS/token/FHIR failures and one provider
   from all providers.
3. Inspect aggregate upstream status/error codes and application 429s. Avoid
   aggressive retries that amplify Epic throttling.
4. Confirm the production client ID, redirect, FHIR base, trusted origins,
   authentication method, JWKS, standalone scopes, resource-scope policy, and Incoming APIs have not
   drifted.
5. Escalate to Epic/the healthcare organization with synthetic timestamps and
   request IDs only. Never send bearer tokens or patient payloads.
6. Communicate degraded functionality and preserve existing encrypted grants;
   do not rotate keys or credentials without evidence they are involved.

### Sensitive FHIR data or cross-patient access

Treat raw FHIR versions, normalized projections, deterministic insights, and hub
exports as potentially sensitive health data. The raw-free intelligence API
reduces response content but does not make its projections or insights non-PHI.

1. Disable the public route and Epic client immediately; declare SEV-1.
2. Preserve the implicated Worker version/configuration and stop further data
   access. Do not reproduce with real patients.
3. Bound resource types, operations, provider, code/config versions, access time,
   and potentially affected cohort using the minimum necessary evidence.
4. Coordinate Epic revocation, privacy/legal assessment, Cloudflare escalation,
   and patient/customer notices through authorized roles.
5. Repair and test with synthetic records, including patient constraints, direct
   reads, pagination links, allowlists, proxy/identity rules, and repeated/shared
   sessions.
6. Require independent security review and explicit reactivation approval.

### Bad release or migration

1. Stop promotion and freeze secret/config changes.
2. For code-only behavior, promote the recorded last-known-good Worker version.
3. Confirm schema compatibility before rollback. Worker versions do not roll
   Durable Object data back.
4. If data was written in a format the old code cannot read, keep traffic off and
   deploy a forward fix. Do not edit the migration ledger to make an old binary
   start.
5. Validate health, readiness, old/new sessions, authorization, FHIR access,
   disconnect, rate limiting, audit delivery, and cleanup before closing.

### Audit pipeline failure

The application intentionally does not fail patient requests when the audit sink
fails. Missing audit events can therefore coexist with a healthy service.

1. Determine first/last delivery times, affected event types, buffering/retry
   behavior, and whether events can be replayed without sensitive source data.
2. Restrict any dead-letter or debug destination and inspect it for prohibited
   fields.
3. Restore the pipeline, validate ordering/deduplication expectations, and run a
   synthetic authorization/FHIR/disconnect flow.
4. Escalate severity if contractual or legal audit evidence is missing. Do not
   fabricate or reconstruct patient-level events from raw request logs.

### Abuse or denial of service

1. Confirm whether application rate limiting, Cloudflare WAF/bot controls, Epic
   throttling, or Durable Object contention is the active bottleneck.
2. Apply time-bounded Cloudflare controls using aggregate traffic patterns. Avoid
   blocking a shared hospital/NAT population without impact review.
3. Do not raise application limits during an attack without service-owner and
   Epic impact approval.
4. Preserve aggregate rate-limit and error evidence, monitor false positives,
   and remove emergency rules after review.

## Backup and restore decision tree

```text
Is the incident code/config-only and storage known good?
  Yes -> Roll back code; do not restore storage.
  No
  |
  +-- Can existing encrypted grants be proven safe, current, and decryptable?
  |     No -> Reconnect-only recovery; revoke/delete affected grants.
  |     Yes
  |     |
  |     +-- Is loss/corruption limited to identified Durable Objects and within
  |           the supported PITR window?
  |             No -> Reconnect-only recovery.
  |             Yes -> Consider PITR with security/privacy approval.
  |
  +-- Would restore resurrect a disconnect, revocation, expiry, compromise, or
        obsolete key/schema state?
          Yes/unknown -> Do not restore; require reconnect.
          No -> Restore one approved object, validate, then decide whether to
                continue.
```

PITR is not a fleet-wide application feature in the current code. If used, the
operator must have a separately reviewed tool and Cloudflare procedure.

### PITR execution requirements

Before restore:

- name approvers and incident/change IDs;
- identify the exact object without exposing its raw session ID;
- capture current and target bookmarks, Worker/storage schema versions, and
  required key IDs;
- prove the target time predates corruption but does not resurrect a deletion,
  disconnect, compromise, or expired grant; and
- record a return bookmark/undo method and observation plan.

After restore:

- restart/activate the object according to the current Cloudflare PITR API;
- verify storage migration, keyring decryption, session expiry, provider/client
  binding, authorization state, and audit delivery;
- revoke/delete and require reconnect if any invariant is uncertain; and
- document outcome without patient data.

Never test a production restore by copying production contents to development.

## Recovery validation

Do not declare recovery from one successful health probe. Validate:

- stable `200` results from `/healthz` and `/readyz` in multiple regions;
- approved Terms/Privacy content and callback hostname;
- one synthetic existing session and one new authorization;
- patient-constrained read, search, direct read, and pagination;
- expected failures for disallowed resources/queries, missing sessions, stale
  consent, duplicate state, unsafe origins, and invalid cursors;
- local deletion and remote/manual revocation behavior;
- authorization/API rate limiting;
- audit event delivery with prohibited-data checks; and
- error, latency, authorization-completion, refresh, cleanup, and dependency
  metrics for the documented observation window.

Privacy/legal and the incident commander must approve restoring patient traffic
after any SEV-1 or data/credential incident.

## Closure and follow-up

Before closure:

1. state the confirmed root cause, affected window/scope, patient/customer impact,
   and remaining uncertainty;
2. record every code, Worker version, variable, binding, secret/key ID, Epic,
   DNS/WAF, logging, storage, and recovery change;
3. confirm evidence retention and all required legal/customer/provider notices;
4. verify temporary access and emergency controls are removed or assigned an
   expiry;
5. rotate/destroy credentials only when the containment plan permits it;
6. assign corrective actions with owners and due dates; and
7. run a blameless review and update this playbook, monitoring, tests, and the
   [go-live checklist](go-live-checklist.md).

At least quarterly, tabletop a callback-log exposure, token-key loss, Epic outage,
and bad schema release. At least annually, exercise the chosen reconnect/PITR
recovery path with synthetic data.
