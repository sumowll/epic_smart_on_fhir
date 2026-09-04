# Production deployment and operations

This runbook covers the Cloudflare Worker deployment of the Epic MyChart
SMART-on-FHIR connector. It is an engineering control description, not a claim
of HIPAA, privacy-law, Epic, or organizational compliance.

## Status vocabulary

- **Implemented** means the checked-in application or Wrangler configuration
  currently enforces the control.
- **Operator gate** means a production owner must configure, verify, approve, or
  continuously operate the control outside this repository.
- **External gate** means Epic, Cloudflare, counsel, or another third party must
  complete or approve the activity.

An implemented control is not complete until its operator and external gates
have evidence and owners.

## Current production boundary

| Area | Current state | Production implication |
|---|---|---|
| Runtime | **Implemented:** native Cloudflare Worker with SQLite-backed Durable Objects | Deploy the Worker entry point in `src/worker.ts`; the local Node server is not the public production runtime. |
| Public endpoint | **Implemented:** `workers_dev` and preview URLs are disabled | **Operator gate:** attach an approved custom domain or route before testing the public callback. |
| OAuth | **Implemented:** SMART discovery, PKCE S256, one-time state, OIDC nonce and signed ID-token validation | **External gate:** Epic must distribute and activate the production client for the exact provider, callback, authentication method, and Incoming APIs. |
| FHIR access | **Implemented:** 53 FHIR resource scope values spanning 22 resource types, capability-driven read/search UI, patient-bound/scope-restricted strategies, encrypted session-bound pagination cursors, and trusted-origin validation | **Operator gate:** reconcile every exposed operation with the minimum Epic Incoming APIs and the product's authorized use case. See the [scope catalog](fhir-scope-catalog.md). |
| Browser session | **Implemented:** signed, HTTP-only, secure cookie with configurable idle and absolute expiry | **Operator gate:** choose and document the idle and maximum lifetime. Defaults are 30 minutes idle and 8 hours absolute. |
| Consent | **Implemented:** authorization start requires the current policy version and an acceptance receipt is stored with the pending authorization/connection | **External gate:** counsel must approve the policy content, versioning, age/proxy rules, and evidence requirements. |
| Token storage | **Implemented:** per-route encrypted Durable Object records with a versioned keyring and schema migration ledger | **Operator gate:** operate the secret inventory, key rotation, retention, restore, and deletion procedures below. |
| Optional FHIR hub | **Implemented:** separate consent, stable opaque identity, immutable raw versions, bounded normalized projections and deterministic source-cited summaries for all 22 supported resource types, a raw-free intelligence API, retention, export, confirmed deletion, a separate encrypted Node file, and bounded encrypted generations in an account-scoped Worker Durable Object | **External/operator gates:** approve the health-hub purpose and exact backfill notice, BAAs/subprocessors, Moonba identity/linking, minimum data, intelligence use, key lifecycle, backup/recovery, quotas, resource-granular scaling, and deletion evidence. See [the hub architecture](private-fhir-hub.md). |
| Rate limiting | **Implemented:** Cloudflare rate-limit bindings are configured for authorization and authenticated API traffic | **Operator gate:** verify namespace isolation, load-test the limits, alert on rejections, and add account/zone controls appropriate to the threat model. |
| Audit events | **Implemented:** structured, pseudonymous events omit URLs, query strings, FHIR IDs, bodies, and tokens | **Operator gate:** configure a durable, access-controlled audit destination and prove delivery, retention, review, and deletion. Console delivery alone is best effort. |
| Availability | **Implemented:** liveness and storage readiness endpoints | **Operator gate:** create external synthetics, service objectives, alerts, escalation, and an Epic-dependency check. |
| Recovery | **Implemented:** expiring local records and additive storage migrations | **Operator gate:** select reconnect-only or point-in-time recovery, retain matching keys, and drill the chosen procedure. |

The configuration models one Epic client/provider per Worker deployment. Use
separate deployments, credentials, bindings, hostnames, and operational evidence
when providers or regulatory environments must be isolated.

Generic Binary search and direct Binary instance read are **implemented as
blocked**. Enable attachment access only after implementing and reviewing a
session-bound, expiring capability derived from an authorized
`DocumentReference`; do not add a free-form Binary ID control.

## Required reviews before real patient data

These are release blockers, not optional documentation tasks.

1. **External gate — Epic:** obtain the production client ID, complete
   distribution/activation for the healthcare organization, register the exact
   HTTPS callback, confirm the production FHIR base, and approve every Incoming
   API. Sandbox authorization is not production approval.
2. **External gate — legal/privacy:** approve the operator identity, Terms,
   Privacy Notice, consent version, proxy/guardian and age rules, retention,
   deletion, breach notifications, applicable consumer-health laws, and HIPAA
   role determination.
3. **External gate — Cloudflare contract:** determine whether PHI will be
   handled and, if required, execute a BAA and confirm in writing that every
   enabled service and logging destination is covered. Cloudflare currently
   states that it enters BAAs only with Enterprise customers; do not infer
   coverage from a product feature or certification.
4. **Operator gate — security:** approve the threat model, data-flow diagram,
   access-control model, dependency review, penetration test, vulnerability
   handling SLA, secret custodians, and incident/continuity plans.
5. **Operator gate — product:** define the authenticated product account and
   authorization policy surrounding the Epic connection, including shared
   devices, account recovery, proxy access, support access, and account-wide
   deletion.

See [Cloudflare's privacy compliance FAQ](https://www.cloudflare.com/trust-hub/us-privacy-compliance/),
[HHS resources for health-app developers](https://www.hhs.gov/hipaa/for-professionals/special-topics/health-apps/index.html),
and the [FTC health information guidance](https://www.ftc.gov/business-guidance/resources/collecting-using-or-sharing-consumer-health-information-look-hipaa-ftc-act-health-breach).
Contract scope and law must be validated for the actual organization and date.

## Epic sandbox to production gates

Passing the sandbox flow proves protocol interoperability with synthetic data; it
does not approve the app, provider, data use, or production client.

1. **Operator gate — isolate environments:** use separate Epic app/client IDs,
   credentials/JWKS keys, callbacks, FHIR bases, trusted origins, Workers,
   bindings, secrets, logs, and test identities. Never connect a real MyChart
   account to Epic's developer sandbox.
2. **Operator gate — freeze the product contract:** approve the three-value
   standalone authorization request, exact 53-value returned-resource policy,
   21 non-Patient resource allowlist, Patient profile action,
   constrained choices, persistent-access setting, session lifetimes, and
   product disclosure. Reconcile them with the
   [scope catalog](fhir-scope-catalog.md).
3. **Epic gate — require SMART v2:** configure the Epic app's SMART Scope Version
   as SMART v2 and verify the target organization is on Epic November 2024 or
   newer. The approved `.r`/`.s` and query-qualified catalog is not a SMART v1
   request, and a v1-formatted returned grant can have broader semantics.
4. **External gate — submit the Epic production app:** configure Patients,
   Incoming API, OAuth 2.0, R4, the exact final custom-domain callback, the
   approved confidential-client method, production JWKS/secret, and every
   corresponding Incoming API.
5. **External gate — healthcare-organization distribution:** obtain the distinct
   production client ID, production R4 endpoint, provider branding, activation,
   and any organization-specific security/workflow approval. A sandbox client ID
   or Epic app-page edit is not usable against a customer production endpoint.
6. **Operator gate — wait for propagation:** record Epic and healthcare-
   organization synchronization windows. Disconnect and reauthorize after changes;
   an existing grant cannot gain new permissions merely by refresh.
7. **Operator gate — preflight discovery:** run `pnpm run check:epic` against the
   production base from an approved network and review issuer, authorization,
   token, JWKS, PKCE, authentication method, and trusted origins. This read-only
   check does not validate a patient grant or count as provider approval.
8. **External/operator gate — production test authorization:** use only an
   organization-approved test identity and minimum data. Confirm issuer/subject,
   returned patient context, literal granted scope values, CapabilityStatement,
   Read/Search behavior, constrained queries, refresh decision, and revocation/
   manual MyChart removal.
9. **Operator gate — launch evidence:** attach Epic/provider approvals, scope and
   Incoming API matrix, endpoint/discovery result, synthetic flow, security/legal
   approvals, support procedure, and rollback plan to the
   [go-live checklist](go-live-checklist.md).

Repeat these gates for every provider/client and after callback, authentication,
scope, Incoming API, endpoint, JWKS, persistent-access, or ownership changes.

## Cloudflare account and environment setup

### Isolation and access

- **Operator gate:** use separate non-production and production Workers,
  Durable Object namespaces, rate-limit namespaces, secrets, Epic clients, DNS
  hostnames, logs, and alert destinations. Never point a staging Worker at a
  production Durable Object namespace.
- **Operator gate:** require phishing-resistant MFA/SSO for Cloudflare
  administrators. Grant CI a narrowly scoped API token; do not use a global API
  key. Separate deploy, secret-management, log-reader, and incident-recovery
  privileges where practical.
- **Operator gate:** protect the production branch, require reviewed commits and
  passing verification, and record the commit SHA, Worker version, approver, and
  change ticket for each release.
- **Operator gate:** choose the final custom domain before Epic activation.
  Register exactly `https://<host>/auth/callback`; a different hostname, path,
  port, or scheme is a different OAuth redirect URI.
- **Implemented:** direct `workers.dev` access and preview URLs are disabled in
  `wrangler.jsonc`. Confirm the deployed settings have not drifted.

### Configuration source of truth

`wrangler.jsonc` currently has `keep_vars: true`. Wrangler therefore preserves
dashboard-managed ordinary variables that are omitted from the deployment
configuration. Those values survive releases, but they can drift independently
of the repository and must be reconciled against an approved inventory.

**Operator gate:** choose one audited production mechanism and test it before
go-live:

1. keep non-secret production variables in a protected environment-specific
   Wrangler configuration and set `keep_vars` according to that source of truth,
   or
2. inject a reviewed generated configuration in CI, or
3. retain dashboard-managed variables with `--keep-vars --strict` only after
   comparing the remote configuration with the approved inventory.

Do not commit real secrets or an environment file containing them. Secrets are
preserved separately by Wrangler, but changing a secret can create a new Worker
version. Coordinate code, variables, bindings, and secrets as one release.

The current Wrangler file does not declare the ordinary production values or a
required-secret inventory. Missing or invalid values fail application
configuration at request/object startup, not necessarily during deployment.
**Operator gate:** make CI compare the expected variable/secret names and bindings
before promotion without reading secret values.

### Runtime variable inventory

Store these as ordinary variables in the controlled production source of truth:

| Variable | Production requirement |
|---|---|
| `APP_LEGAL_NAME` | Exact approved operator name. |
| `APP_LEGAL_CONTACT_EMAIL` | Monitored privacy/support contact. |
| `APP_LEGAL_EFFECTIVE_DATE` | Approved notice effective date. |
| `APP_HOSTING_PROVIDER_NAME` | Must match the actual hosting disclosure. |
| `CONSENT_POLICY_VERSION` | Immutable identifier for the exact approved policy text. |
| `EPIC_CLIENT_ID` | Production client for this provider/environment. |
| `EPIC_TOKEN_AUTH_METHOD` | Prefer the Epic-approved production method, normally `private_key_jwt`. |
| `EPIC_FHIR_BASE_URL` | Exact production R4 resource server. |
| `EPIC_PROVIDER_NAME` | Patient-facing provider name. |
| `EPIC_REDIRECT_URI` | Exact final callback URL. |
| `EPIC_SCOPES` | Short standalone GET request: `openid fhirUser launch/patient`; never place the 53 resource scopes here. |
| `EPIC_ALLOWED_RESOURCE_SCOPES` | Exact 53-value upper-bound policy for resource grants Epic may add from configured Incoming APIs. |
| `EPIC_REQUEST_OFFLINE_ACCESS` | Enable only with an approved persistent-access use case. |
| `EPIC_ALLOWED_RESOURCE_TYPES` | Minimum product allowlist; it is not a substitute for Epic scope configuration. |
| `EPIC_TRUSTED_ENDPOINT_ORIGINS` | Explicit HTTPS origins for every approved Epic discovery/token/FHIR endpoint. |
| `EPIC_FHIR_WIRE_LOGGING` | Keep `off` in production. `errors` and `all` emit PHI-bearing diagnostic records and require a separately approved, temporary diagnostic procedure. |
| `SESSION_IDLE_TIMEOUT_SECONDS` | Approved idle timeout, 300–86,400 seconds. |
| `SESSION_MAX_LIFETIME_SECONDS` | Approved absolute lifetime, 900–86,400 seconds and not shorter than idle timeout. |
| `TOKEN_ENCRYPTION_KEY_ID` | Non-secret, unique identifier for the current data key, such as `prod-2026-09-01`. |
| `FHIR_HUB_ENABLED` | Leave `false` until every hub-specific production gate is approved. |
| `FHIR_HUB_CONSENT_VERSION` | Immutable identifier for the exact approved optional-hub and intelligence notice. A new approved intelligence purpose requires a new value and explicit acceptance before historical backfill. |
| `FHIR_HUB_RETENTION_DAYS` | Approved raw-resource and derived-artifact retention, 1–3,650 days. |
| `EPIC_PRIVATE_KEY_ALG` | Required when using private-key JWT; must match the registered key. |
| `EPIC_PRIVATE_KEY_KID` | Required when using private-key JWT; must match the hosted JWKS. |

Store these as encrypted runtime secrets with restricted write access:

| Secret | Notes |
|---|---|
| `SESSION_SECRET` | At least 32 high-entropy characters. Rotation invalidates existing browser cookies. |
| `FHIR_HUB_ENCRYPTION_KEY` | Exactly 32 random bytes in base64; distinct from token, session, and identity keys. Current hub storage requires an explicit migration before rotation. |
| `FHIR_HUB_IDENTITY_KEY` | Exactly 32 random bytes in base64; stable for the life of retained account/source/patient references and distinct from every encryption key. |
| `TOKEN_ENCRYPTION_KEY` | Base64 encoding of exactly 32 random bytes; current AES-256-GCM key. |
| `TOKEN_ENCRYPTION_PREVIOUS_KEYS` | JSON object from retained key IDs to canonical base64 32-byte keys. It contains key material and must be a secret even though it is JSON. Values must remain distinct from both FHIR hub keys. Use `{}` before the first rotation. |
| `EPIC_CLIENT_SECRET` | Required only for `client_secret_basic`. Use the production secret for this provider/environment. |
| `EPIC_PRIVATE_KEY_PEM` | Required for Worker `private_key_jwt`; never use `EPIC_PRIVATE_KEY_PATH` in the Worker. |

Generate independent values; do not reuse a cookie secret as a token key:

```bash
openssl rand -base64 48
openssl rand -base64 32
```

Secret values must be recoverable by the approved custodians from an external
secret manager. Cloudflare's hidden copy is not a key escrow or recovery plan.

### Bindings and platform settings

Before every promotion, verify the deployed version contains:

- the SQLite Durable Object bindings/classes used by the Worker, including the
  per-route connector and the privacy-reduced account connection registry;
- `AUTH_RATE_LIMITER`, configured for 10 requests per 60 seconds;
- `API_RATE_LIMITER`, configured for 120 requests per 60 seconds;
- production-unique rate-limit namespace IDs;
- the approved custom route/domain and TLS settings;
- the intended 1,000 ms CPU limit; and
- observability enabled with automatic invocation logs disabled.

Binding configuration is versioned with Worker code. Durable Object data is not
part of a Worker version, so a code rollback does not roll storage back.

## CI/CD and dependency posture

### Implemented repository checks

- `.github/workflows/ci.yml` runs on pull requests and pushes to `main` with
  read-only repository permissions, a 15-minute job timeout, frozen pnpm install,
  TypeScript check, Vitest, build, Wrangler dry-run, and high-severity production
  dependency audit.
- `.github/workflows/codeql.yml` analyzes JavaScript/TypeScript on pull requests,
  `main`, and a weekly schedule.
- `.github/dependabot.yml` opens weekly npm and monthly GitHub Actions updates,
  grouping production and development dependencies separately.
- `package.json` pins the package-manager version and the lockfile pins resolved
  dependency versions.

These workflows test a commit; they do not currently deploy or promote a
production Worker. That separation is intentional only when a documented release
owner performs the version inspection and promotion gates below.

### Operator gates

- Make CI and CodeQL required branch-protection checks and prevent administrators
  from bypassing them without an audited break-glass procedure.
- Review Dependabot and audit findings within defined SLAs. `pnpm audit --prod`
  does not cover every development/build tool, malicious package, license,
  provenance, or newly undisclosed vulnerability risk.
- Add the organization's license policy, secret/history scan, SBOM and artifact
  provenance/attestation, dependency allow/deny policy, and container/build-runner
  hardening where required.
- Decide whether GitHub Actions must be pinned to immutable commit SHAs; the
  current workflows reference major-version tags.
- Restrict workflow changes with CODEOWNERS/review, isolate production deployment
  credentials from pull requests, and use an approval-protected GitHub/Cloudflare
  production environment.
- Retain verification, Worker version, dependency, scanner, approver, and
  promotion evidence according to the release-record policy.
- Exercise a dependency emergency update and rollback. A passing scanner does not
  replace review of security-sensitive OAuth, FHIR, storage, and Worker-runtime
  changes.

## Release procedure

### Build and preflight

Run with the pinned Node and pnpm versions from a clean, reviewed commit:

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

`verify` runs TypeScript checks, tests, a build, and a Wrangler dry run. CI must
also run dependency/license and vulnerability policy checks selected by the
security team. A scanner finding is not automatically exploitable, but every
exception needs an owner, rationale, expiry, and compensating control.

Before upload:

1. run the read-only Epic discovery check against the target provider from an
   approved environment;
2. reconcile `EPIC_ALLOWED_RESOURCE_TYPES`, UI operations,
   `EPIC_ALLOWED_RESOURCE_SCOPES`, and Epic Incoming APIs using the
   [scope catalog](fhir-scope-catalog.md);
3. if the hub intelligence purpose changed, confirm the approved notice and
   deployed `FHIR_HUB_CONSENT_VERSION` identify the same immutable version and
   that backfill capacity/monitoring has been reviewed;
4. reconcile preserved dashboard variables with the approved inventory and
   explicitly confirm `EPIC_FHIR_WIRE_LOGGING=off`;
5. validate required bindings and secrets without printing their values;
6. capture the previous stable Worker version and the current storage schema
   version; and
7. identify rollback owner, observation window, abort thresholds, and incident
   channel.

### Validate and deploy atomically

This Worker uses Cloudflare's declarative Durable Object `exports` lifecycle.
Cloudflare does not permit `wrangler versions upload` or gradual deployments when
`exports` entries are present; lifecycle reconciliation happens only through
`wrangler deploy`, and a rollback cannot cross a lifecycle change. Do not follow a
generic Versions/Deployments canary procedure for this repository.

1. Deploy the reviewed commit and equivalent non-secret configuration to a
   separately named staging Worker/environment with isolated Durable Objects,
   rate-limit namespaces, credentials, hostname, and an Epic sandbox client.
2. Run the full smoke test below in staging and inspect the generated code,
   variables, bindings, compatibility date, routes, secrets inventory, and the
   Durable Object exports reconciliation output.
3. Confirm the production release record, two-person approval, previous compatible
   version, rollback/traffic-disable action, dashboards, and incident channel.
4. From the reviewed commit and approval-protected production environment, deploy
   atomically while preserving dashboard-managed ordinary variables:

   ```bash
   pnpm exec wrangler deploy --keep-vars --strict
   ```

   If all ordinary variables instead come from a reviewed, protected
   environment-specific Wrangler configuration, omit `--keep-vars` only after a
   two-person comparison proves the deployment contains every required value.
5. Capture Wrangler's deployment/version ID and exports reconciliation output,
   immediately run the production smoke test with approved test data, and monitor
   the abort indicators for the full observation window.
6. Roll back or disable traffic on an abort threshold. Never roll back across an
   `exports` lifecycle change; restore service with a forward-compatible release
   or the documented recovery procedure instead.

See Cloudflare's [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
and [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
documentation for these platform constraints.

### Post-deployment smoke test

Use a synthetic Epic sandbox identity for non-production and an organization-
approved production test identity for production. Never put patient data in
commands, screenshots, tickets, or chat.

1. `GET /healthz` returns `200` and `{"status":"ok"}`.
2. `GET /readyz` returns `200` and `{"status":"ready"}`.
3. `/terms` and `/privacy` show the approved operator, date, hosting provider,
   and contact.
4. The authorization request uses the exact production client, issuer, redirect,
   PKCE, and short `openid fhirUser launch/patient` scope string, with no
   `patient/...` resource scopes in the query.
5. Consent is rejected when missing or when the submitted policy version is
   stale.
6. The callback succeeds once, clears the authorization code from browser
   history by redirecting, and the returned grant is displayed without tokens.
7. Patient read, one approved search, direct read, and encrypted session-bound
   next-page access work only for allowed resources.
8. A disallowed resource, unsafe query parameter, cross-origin mutation, invalid
   cursor, repeated OAuth state, and missing session all fail safely.
9. When the hub is enabled, synthetic data proves that the exact current hub
   notice is required before ingestion or historical normalization, all 22
   supported resource adapters produce source-linked projections/summaries,
   normalization failure retains raw data, and `GET /api/hub/intelligence`
   returns projections and insights without raw FHIR JSON.
10. Under controlled, single-location load, both authorization and API limiters
   eventually return `429` with `Retry-After: 60`. Do not require denial at an
   exact request number: Cloudflare's binding is permissive and eventually
   consistent.
11. Disconnect deletes the local grant even when Epic does not advertise or
    successfully complete remote revocation; the UI tells the user when MyChart
    removal is still recommended.
12. Audit events arrive in the approved destination with request ID,
    pseudonymous session reference, event/outcome, and no prohibited data.

Record only pass/fail, timestamps, version IDs, and synthetic references in the
release evidence.

## Health, readiness, and dependency monitoring

### Endpoint semantics

| Endpoint | Implemented behavior | Use | Do not infer |
|---|---|---|---|
| `GET /healthz` | Loads validated configuration, requires both rate-limit bindings, and returns `{"status":"ok"}` | Worker liveness and basic binding/configuration sanity | It does not exercise the rate-limit counters, open Durable Object storage, or contact Epic. |
| `GET /readyz` | Executes a registry SQL probe, decrypts or first creates an encrypted sentinel in a fixed non-PHI hub shard when the hub is enabled, then routes to a dedicated connector Durable Object | All configured bindings/classes, registry and hub SQL initialization, connector configuration/startup, SQLite migrations/storage, and the configured hub key | The dedicated connector remains empty and the sentinel does not sample patient shards, so this does not prove that every existing session or hub shard decrypts. It also does not contact Epic discovery, token, or FHIR services. |

Both endpoints are public and must remain free of identifiers, configuration,
stack traces, and dependency details.

### Required monitors

**Operator gate:** implement and own, at minimum:

- external HTTPS probes for `/healthz`, `/readyz`, `/terms`, and `/privacy` from
  at least two regions;
- a separate non-PHI Epic discovery synthetic for each configured provider;
- an existing encrypted synthetic session check after every keyring or storage
  change, because the empty readiness object cannot certify other objects;
- alerting on Worker exceptions, 5xx rate, readiness failures, authorization
  completion failures, token refresh failures, Durable Object storage errors,
  rate-limit events, background cleanup failures, and latency saturation;
- business-flow monitoring for authorization start-to-completion and FHIR
  success, using only aggregates and pseudonymous references;
- certificate/DNS, Epic credential/JWKS expiry, secret age, and legal-policy
  review reminders; and
- a tested page path with primary/secondary responders and a defined maintenance
  mode or traffic-disable action.

Define measurable SLOs and burn-rate thresholds. Initial alert thresholds should
be conservative and tuned from sandbox/load-test baselines; do not encode an
untested universal number in this repository.

## Rate limiting and abuse controls

**Implemented:** the Worker requires both rate-limit bindings at runtime and uses
a privacy-reduced hash of the Cloudflare-provided connecting IP for
`/auth/start` and a signed session identifier for authenticated `/api/*`
requests. The rate-limit bindings currently enforce:

- 10 authorization starts per 60 seconds per client key; and
- 120 authenticated API requests per 60 seconds per session.

Rejected requests return `429` and `Retry-After: 60`. The application also has
per-instance fixed-window limiting for the Node adapter and defense in depth;
the Cloudflare binding is a per-location production control. It is permissive,
eventually consistent, and not a hard global ceiling or accurate accounting
system. Each namespace ID must be unique within the production Cloudflare account
unless sharing counters with another Worker is an explicit design decision.

**Operator gate:** validate normal browser behavior, retry storms, shared NATs,
automated scraping, and Epic upstream limits. Add WAF/bot/DDoS controls and an
authoritative account/global limiter if a hard ceiling is required. Do not key a
log or alert on raw IP, cookie, OAuth state, patient ID, or FHIR ID. Rate limiting
reduces abuse; it is not an authorization policy or an upstream quota guarantee.

## Encrypted Durable Object storage

### Implemented design

- Each browser route uses a strongly ordered SQLite-backed Durable Object.
- Session IDs and OAuth state are SHA-256 hashed for lookup.
- OAuth tokens, patient identifiers, session IDs, PKCE verifiers, nonces, and
  pending authorization data are inside AES-256-GCM authenticated ciphertext.
- Ciphertext is bound to its row identity with additional authenticated data.
- Each encrypted row records a non-secret `key_id`; new writes use the current
  key and reads of retained keys are lazily re-encrypted with the current key.
- Connection rows expose only `cleanup_after` in plaintext so expired ciphertext
  can be deleted even when its key is missing or the payload is unreadable.
- The optional FHIR hub likewise keeps only encrypted-state generation mechanics
  and the vault's earliest raw-version cleanup deadline in its plaintext manifest.
  Hub alarms physically erase an unreadable shard when that deadline is due. A
  live, verified account can request immediate physical deletion even when the
  shard cannot be decrypted; in that recovery case the API cannot report an
  exact deleted-resource count.
- Pending authorization rows expose creation time and status for one-time use and
  10-minute expiry. They do not expose patient or token data.
- Schema versions are recorded in `epic_storage_migrations`. The application
  refuses a schema newer than it understands.
- New connection records use their configured absolute session expiry. Legacy
  rows that predate expiry metadata receive a conservative 30-day cleanup bound
  when migration 2 is first applied.
- Alarms prune pending requests about every 10 minutes and active connection
  objects about hourly; expired grants are locally deleted after best-effort
  remote revocation.

Plaintext hashes, timestamps, statuses, cleanup deadlines, key IDs, registry
references, and access patterns are still sensitive operational metadata. Limit storage inspection and
do not claim encryption makes the platform or its operators unable to access
data: the Worker must possess keys to serve the patient.

### Intelligence-purpose consent and backfill rollout

Raw FHIR versions, normalized projections, and insights are separate retained
artifacts, but all can contain ePHI and share the approved hub retention/deletion
boundary. The checked-in intelligence path covers the exact 22 resource types
listed in [the hub architecture](private-fhir-hub.md), uses deterministic local
rules, and sends no data to an external AI/model service.

Treat expansion from CareTeam-only intelligence to all-resource intelligence as
an explicit consent-policy rollout:

1. obtain privacy/legal/security approval for the exact notice, resource set,
   rules version, retention, export, correction, and deletion behavior;
2. assign a new immutable `FHIR_HUB_CONSENT_VERSION`—the checked-in examples use
   `2026-08-26`—and deploy the notice, configuration, code, audit handling, and
   monitoring as one reviewed release;
3. do not reinterpret an older receipt as permission to derive new artifacts;
   deployment and startup alone must not backfill retained raw versions;
4. require the user to accept the exact new version. Until then, new ingestion
   and backfill remain stopped while existing data stays exportable and deletable;
5. after acceptance, monitor account-state size and write failures while the
   service normalizes still-retained versions and creates their exact source-cited
   summaries; expired data must not be restored; and
6. verify `GET /api/hub/resources`, the raw-free `GET /api/hub/intelligence`,
   export, retention, and confirmed deletion with synthetic data before approving
   the rollout.

A normalization failure stores only its bounded failure code beside the retained
raw source. It must not discard the source, invent a summary, extend retention, or
make the account vault unreadable. A later rules/model integration is a new data
flow and must not reuse this approval automatically.

### Split-scope rollout from an earlier connector version

The standalone-scope hardening adds an `allowedResourceScopes` snapshot to every
pending authorization and saved consent receipt. Records created by a version
that stored all resource scopes only in `requestedScopes` remain parseable, but
are intentionally treated as incompatible and removed fail-closed. Before
promoting this change over an installation with durable records:

1. announce a reconnect window and stop starting new authorizations on the old
   version;
2. let its 10-minute pending-authorization TTL elapse;
3. deploy the new `EPIC_SCOPES` and `EPIC_ALLOWED_RESOURCE_SCOPES` values with the
   code as one release;
4. monitor incompatible-record cleanup and revocation outcomes; and
5. tell affected patients to remove the prior app under MyChart linked
   apps/devices when Epic has no revocation endpoint, then authorize again.

Do not reinterpret a missing resource-policy snapshot as approval for all 53
values. That would turn an operational migration into a permission escalation.

### Token-encryption key rotation

Use a new key ID for every new key. Never reuse an ID with different bytes.

Example transition:

```text
Before:
  TOKEN_ENCRYPTION_KEY_ID=prod-2026-01
  TOKEN_ENCRYPTION_KEY=<key A>
  TOKEN_ENCRYPTION_PREVIOUS_KEYS={}

During rotation:
  TOKEN_ENCRYPTION_KEY_ID=prod-2026-09
  TOKEN_ENCRYPTION_KEY=<key B>
  TOKEN_ENCRYPTION_PREVIOUS_KEYS={"prod-2026-01":"<key A>"}
```

Rotation procedure:

1. **Operator gate:** open a change record, name two custodians, record the old
   and new key IDs (never key bytes), and confirm a rollback version.
2. Generate a fresh 32-byte key in the approved secret manager.
3. Build `TOKEN_ENCRYPTION_PREVIOUS_KEYS` from every still-needed prior key. Do
   not omit an older retained key merely because it was not current immediately
   before this rotation.
4. Create one Worker version containing the new current secret, new key ID, and
   retained previous-key JSON. Prefer a versioned secret update or secrets file;
   avoid `wrangler secret put` if its immediate deployment bypasses the release
   gate.
5. Verify `/readyz`, complete a synthetic authorization, refresh/access it, and
   verify an existing pre-rotation session still works.
6. Promote and monitor `token_store_unreadable`, `oauth_state_unreadable`,
   readiness, authorization completion, refresh, and cleanup errors.
7. Keep prior keys until all records written under them must have expired and an
   additional hourly alarm window has elapsed. Include the 10-minute pending
   authorization TTL. For records created before migration 2, keep the legacy
   key for the migration's 30-day grace unless storage evidence proves no such
   rows remain.
8. Remove a prior key only in a second reviewed release. Verify existing and new
   sessions, then destroy the retired key according to the cryptographic key
   policy and record evidence.

There is no fleet-wide key-usage inventory or automatic key retirement in the
current code. Lazy re-encryption occurs only when a record is read. Time-based
retention plus tested expiry is therefore the safe retirement criterion.

### Other secret rotations

- Rotating `SESSION_SECRET` invalidates existing cookies and changes
  pseudonymous audit/account references. Plan a reconnect window and retain the
  token encryption key so alarms can still delete encrypted grants.
- Rotating an Epic client secret requires a coordinated Epic and Worker version.
  Test token exchange and refresh before promotion.
- Rotating a private-key JWT key requires overlapping JWKS publication, Epic
  registration/propagation, the matching key ID/algorithm/private PEM, and a
  tested removal date for the old public key.
- Do not change the Epic client ID or FHIR base underneath live grants. Disconnect
  or expire them first; the connector intentionally rejects a grant bound to a
  different client/provider.

## Privacy-safe logging and audit

**Implemented:** Wrangler enables observability at full head sampling but
disables automatic invocation logs. The application emits structured audit
events through `console.info`; their schema intentionally excludes request URLs,
query strings, cookies, OAuth codes/state, FHIR IDs, response bodies, and tokens.
Session references are truncated HMAC values. Audit transport failures are
swallowed so logging cannot leak an error or break a patient request.

A separate FHIR wire diagnostic exists for short-lived troubleshooting and is
`off` by default. It is not part of the privacy-reduced audit stream. When set to
`errors` or `all`, its records are explicitly classified as sensitive and contain
the exact FHIR URL plus direct response text (bounded to 32 KiB per response log).
Request headers are structurally excluded; response metadata is limited to the
numeric status, bounded status text, and bounded `Content-Type` value.
Consequently, enabling it changes the logging data boundary and is not an ordinary
production configuration change. The response body is deliberately not redacted
and can contain PHI or credential-like values returned by the upstream server.

This is a safe event schema, not a complete audit service. Best-effort console
delivery can be missing, duplicated, delayed, or inaccessible during an outage.

**Operator gate:**

- keep automatic invocation logs disabled unless a security/privacy review proves
  callback query strings are excluded before ingestion;
- audit Cloudflare zone, WAF, DNS, browser analytics, support, APM, Logpush,
  SIEM, and downstream destinations separately—`invocation_logs: false` does not
  disable every possible log source;
- keep `EPIC_FHIR_WIRE_LOGGING=off`; any temporary exception requires documented
  privacy/security approval, an approved synthetic or minimum-necessary test
  identity, isolated destinations and readers, explicit retention/deletion, and
  immediate disablement after one bounded capture;
- otherwise prohibit raw request/response logging and generic serialization of
  exceptions, headers, URLs, cookies, tokens, FHIR resources, OAuth callback
  queries, patient names, or identifiers;
- restrict log readers and exporters, encrypt destinations, choose approved
  regions, document retention/deletion, monitor delivery lag/failure, and make
  administrative access auditable;
- alert on aggregate failure/error codes without placing sensitive values in
  labels; and
- test the pipeline with synthetic data and a prohibited-data canary before
  production.

Treat logs as sensitive even when pseudonymous. Combining a request time,
provider, resource type, and session reference can still create linkable health
metadata.

## Backup, restore, and continuity

The stored OAuth grant is replaceable by asking the patient to reconnect. That
often produces a safer recovery model than backing up reusable tokens.

### Choose one documented recovery mode

1. **Reconnect-only (recommended default):** do not restore token-bearing
   Durable Object contents. Restore code, configuration, bindings, secrets, DNS,
   and monitoring; revoke grants at Epic when required, allow approved expiry or
   deletion of abandoned local records, and require patients to authorize again.
   This mode accepts complete loss of saved grants; RTO is the time to redeploy
   and reconnect.
2. **Point-in-time recovery:** use Cloudflare's SQLite Durable Object PITR only
   after legal/security approval and a tested operator tool. The platform API can
   restore an individual SQLite-backed object's database to a point within the
   documented retention window. The current application does not expose a PITR
   endpoint or fleet-wide backup/restore orchestrator.

Cloudflare's [SQLite Durable Object storage documentation](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
currently describes a 30-day PITR window. Confirm current contract, limits, and
API behavior during every continuity review.

### Restore safety rules

- A restored database still needs every encryption key referenced by its rows.
  Back up key material separately in an approved secret manager; never store keys
  beside ciphertext exports.
- PITR can resurrect a grant that the patient disconnected or that was locally
  deleted after suspected compromise. Before serving restored contents, reconcile
  incident time, deletion/revocation records, expiry, and Epic status. When that
  cannot be proven, delete locally and require reconnect.
- Restoring one per-route object does not restore cookies in a patient's browser
  or guarantee that the route is discoverable. Define how an object is identified
  without logging or exporting raw session IDs.
- Never restore production PHI/token data into development or vendor support
  environments.
- Record approver, reason, object reference, source/target bookmarks, key IDs,
  time window, validation, and final disposition without recording patient data.
- Exercise the selected procedure at least annually and after any storage,
  keyring, Durable Object binding, or migration change.

Back up the repository commit, lockfile, reviewed production configuration,
binding/resource inventory, Worker version IDs, Epic registration metadata,
runbooks, and encrypted secret-manager recovery material. Define owners and
organization-approved RPO/RTO values in the service record.

## Rollback

Worker versions include code and bindings; they do not include Durable Object
data. A code rollback cannot undo a storage migration or delete newly written
records.

### Rollback decision

Roll back when a new version causes sustained readiness/5xx/authentication/FHIR
regression, sensitive logging, unsafe authorization behavior, or data corruption
and traffic disablement is not safer. Disable traffic and begin the incident plan
instead when a secret, patient data, callback code, or authorization boundary may
be compromised.

### Procedure

1. Freeze deploys and secret/config changes; name the incident/change owner.
2. Capture the active and last-known-good Worker version IDs, configuration
   inventory, storage schema version, error aggregates, and timestamps without
   patient data.
3. Confirm the older version understands the current Durable Object schema and
   every active binding/key ID. The schema ledger intentionally rejects a schema
   newer than the application understands.
4. Keep current and retained encryption keys available. Never roll code back
   while independently rolling the data key, session secret, Epic credentials,
   callback, or FHIR base.
5. Use Cloudflare's approved rollback operation only when the last-known-good
   version is compatible with the current `exports` lifecycle, bindings, schema,
   and keyring. Otherwise deploy a forward-compatible fix or disable traffic. Do
   not use PITR as an automatic companion to code rollback.
6. Verify `/healthz`, `/readyz`, legal pages, a synthetic existing session, new
   authorization, FHIR access, rate limiting, disconnect, and audit delivery.
7. Monitor through the defined observation window and communicate patient impact.
8. Document disposition of data written by the failed version before resuming
   releases.

For a migration that is not backward compatible, the release plan must provide a
forward fix or explicit compensating migration before promotion. The current
storage migrations are additive, but that does not make all future versions safe
to roll back.

## Operational ownership

The service owner must keep these artifacts current:

- architecture and data-flow diagrams;
- provider/Epic client and Incoming API inventory;
- production variable, secret, key-ID, binding, route, and namespace inventory;
- legal/BAA/security approvals and renewal dates;
- monitoring dashboard, SLOs, paging rotations, and incident contacts;
- dependency exceptions and penetration-test findings;
- retention/deletion and patient-support procedures;
- backup/recovery mode, RPO/RTO, and drill evidence; and
- release/rollback records and the completed
  [go-live checklist](go-live-checklist.md).

Use [incident-response-and-recovery.md](incident-response-and-recovery.md) for
security, availability, key, logging, and storage incidents.
