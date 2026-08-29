# Production go-live checklist

Use this as a release-blocking record for the first production launch and every
material provider, legal, identity, scope, storage, key, logging, or deployment
change. Check a box only when linked evidence exists. `N/A` requires a named
approver and rationale; source code alone is not compliance evidence.

## Release record

| Field | Value |
|---|---|
| Service/environment | |
| Healthcare organization/provider | |
| Custom hostname and callback | |
| Epic production client ID reference | |
| Git commit SHA | |
| Candidate Worker version ID | |
| Previous stable Worker version ID | |
| Change/release ticket | |
| Planned promotion time (UTC) | |
| Observation window | |
| Incident channel | |
| Release owner | |
| Security approver | |
| Privacy/legal approver | |
| Epic/provider approver | |

## 1. Governance, legal, and external approvals

- [ ] **External gate:** Epic has distributed and activated this exact production
  client for the named healthcare organization and production FHIR endpoint.
- [ ] **External gate:** Epic has registered the exact HTTPS callback and approved
  the client authentication method, persistent-access choice, launch scopes, and
  Incoming APIs.
- [ ] **External gate:** privacy/legal has documented the HIPAA role and all
  applicable consumer-health, privacy, breach-notification, proxy/guardian, age,
  accessibility, and records requirements.
- [ ] **External gate:** the required Cloudflare contract and BAA are executed,
  and each used Cloudflare service, region, support path, log/export destination,
  and subprocessor is confirmed in scope.
- [ ] **External gate:** every analytics, model, support, monitoring, backup, and
  other intelligence-layer vendor that could create, receive, maintain, or transmit
  ePHI has an approved purpose, minimum dataset, retention/training restriction,
  subprocessor review, and required BAA. The checked-in rules-only insight path is
  verified to make no external model call.
- [ ] **Operator gate:** current architecture, threat model, data-flow diagram,
  data inventory, risk assessment, security review, and independent penetration
  test are approved with no unaccepted critical/high findings.
- [ ] **Operator gate:** the approved Terms and Privacy Notice exactly match the
  real operator, contact, hosting, data uses/disclosures, retention, deletion,
  support, and incident practices.
- [ ] **Operator gate:** `CONSENT_POLICY_VERSION` uniquely identifies that exact
  approved text, and policy updates have an evidence/migration procedure.
- [ ] **Operator gate:** if `FHIR_HUB_ENABLED=true`, the separate hub notice,
  `FHIR_HUB_CONSENT_VERSION`, retention, export, intelligence, disconnect-versus-
  deletion behavior, and exact-deletion evidence are approved and tested.
- [ ] **Operator gate:** all-resource intelligence and historical backfill are
  expressly covered by the exact hub notice. A newly approved purpose has a new
  immutable `FHIR_HUB_CONSENT_VERSION`; older receipts are not reinterpreted, and
  no retained raw version is backfilled before the user accepts the new version.
- [ ] **Operator gate:** product identity, authorization, account recovery,
  shared-device, proxy/guardian, support-access, disconnect-all, and account
  deletion behavior are approved end to end.

Evidence/approvals: ________________________________________________

## 2. Epic identity, endpoints, and scope matrix

- [ ] The production `EPIC_CLIENT_ID`, provider name, R4 FHIR base, redirect URI,
  authentication method, trusted endpoint origins, and JWKS/secret references
  match the approved Epic record.
- [ ] The Epic app explicitly selects **SMART Scope Version: SMART v2**, and the
  target organization runs Epic November 2024 or newer. Synthetic authorization
  confirms Epic does not translate the approved `.r`/`.s` catalog into broader
  SMART v1 `.read` grants.
- [ ] `pnpm run check:epic` succeeds against the target provider from an approved
  environment without patient data.
- [ ] The discovery issuer, authorization endpoint, token endpoint, JWKS,
  revocation behavior, PKCE support, and client authentication support have been
  reviewed for unexpected drift.
- [ ] `EPIC_SCOPES` contains only the reviewed standalone authorization values:
  `openid`, `fhirUser`, and `launch/patient`. It contains no `patient/...`
  resource values, keeping Epic's GET query bounded. Offline access is enabled
  only for an approved persistent-access use case.
- [ ] `EPIC_ALLOWED_RESOURCE_SCOPES` contains the exact reviewed 53-value FHIR
  resource policy with no accidental additions and matches the app's configured
  Incoming APIs.
- [ ] A version-controlled scope matrix maps every enabled UI/API operation to
  its Epic Incoming API and returned grant. Each dropdown search requires the
  resource's **Search** permission; the known-ID Provenance choice and each
  detail/direct read require **Read**. Automatic record-source inclusion also
  requires unqualified `patient/Provenance.r`, Provenance read capability, and an
  exact `Provenance:target` declaration for the searched resource.
- [ ] All 53 configured FHIR resource scopes have been reconciled individually,
  including category-qualified Condition, DocumentReference, and Observation
  scopes. The review does not treat a resource name or dropdown entry as proof
  that both interactions are granted.
- [ ] The [scope catalog and UI mapping](fhir-scope-catalog.md) is approved:
  22 resource types map to a separate Patient profile, up to 19 searchable
  choices, one known-ID Provenance read choice, and blocked Binary access. The
  actual grant and CapabilityStatement may reduce what appears. Eligible searches
  include available Provenance only in the Advanced response.
- [ ] Binary search and direct read are rejected. Any future attachment workflow
  uses an expiring, session-bound capability derived from an authorized
  `DocumentReference` and never exposes a free-form Binary ID control.
- [ ] `EPIC_ALLOWED_RESOURCE_TYPES` is the minimum set needed by the product and
  matches the UI. Unsupported or unapproved resources are absent, not merely
  hidden by CSS.
- [ ] Synthetic authorization confirms the literal scopes returned by Epic. Any
  difference from the requested/approved matrix fails the release or is approved
  as a documented least-privilege reduction.
- [ ] Patient, proxy/RelatedPerson, direct-read, search, pagination, and identity
  behavior have been tested using only Epic-approved synthetic/test identities
  until production testing is formally authorized.
- [ ] Epic propagation lead time and healthcare-organization activation have
  elapsed; the test does not rely on a newly edited but unsynchronized app record.

Scope-matrix/test evidence: _________________________________________

## 3. Cloudflare production environment

- [ ] Production is isolated from sandbox/staging by Worker, Durable Object
  namespaces, rate-limit namespaces, variables, secrets, Epic client, hostname,
  logs, and alert destinations.
- [ ] A final custom domain/route with approved TLS is attached. Direct
  `workers.dev` and preview URLs remain disabled and are not registered with Epic.
- [ ] Cloudflare administrators use SSO/MFA and least privilege; CI uses a
  narrowly scoped API token. Deploy, secret, log, and recovery access are reviewed
  and auditable.
- [ ] Branch protection and CI require reviewed commits and passing verification.
  Production cannot be deployed from an unreviewed workstation state.
- [ ] The configuration source of truth handles checked-in `keep_vars: false`.
  A dry-run/test deploy proves ordinary dashboard variables will not disappear.
- [ ] Deployed ordinary variables match the approved inventory without printing
  them to build logs. No placeholder, sandbox client, sandbox endpoint, local
  callback, or example legal value remains.
- [ ] The deployed version contains every required Durable Object binding/class,
  including the per-route connector, connection registry, and—when enabled—the
  separate account-scoped FHIR hub, with SQLite storage.
- [ ] When the hub is enabled, the deployed `FHIR_HUB_CONSENT_VERSION` exactly
  matches the approved notice and release evidence. The checked-in example value
  `2026-08-26` is not reused after a later purpose or notice change.
- [ ] Rate-limit bindings use production-unique namespace IDs and the approved
  10/min authorization and 120/min authenticated API settings.
- [ ] The CPU limit, compatibility date, observability settings, invocation-log
  setting, DNS/route, and Workers Builds pnpm version are verified in the deployed
  version, not assumed from the repository.
- [ ] Cloudflare billing, quotas, Durable Object limits, support plan, region/data
  locality, and account-level DDoS/WAF controls are adequate for expected load and
  contractual requirements.

Configuration/binding evidence: ____________________________________

## 4. Secrets, keys, and cryptography

- [ ] `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` were independently generated
  with approved cryptographic randomness and are not reused across environments.
- [ ] If the hub is enabled, `FHIR_HUB_ENCRYPTION_KEY` and
  `FHIR_HUB_IDENTITY_KEY` are independent 32-byte values, are distinct from the
  token/session keys, and have documented backup, loss, migration, rotation, and
  destruction procedures. No key is replaced under retained live data.
- [ ] `TOKEN_ENCRYPTION_KEY` decodes to exactly 32 bytes. Its unique
  `TOKEN_ENCRYPTION_KEY_ID` is recorded in the secret inventory without key bytes.
- [ ] `TOKEN_ENCRYPTION_PREVIOUS_KEYS` is stored as an encrypted secret, contains
  every still-required key ID/32-byte key pair, and does not redefine the current
  key ID.
- [ ] Epic client secret or private PEM is stored only as a runtime secret. The
  private-key algorithm/key ID match the registered JWKS; production does not use
  a local private-key path.
- [ ] Secrets never appear in source, Git history, environment examples, CI
  output, tickets, chat, screenshots, audit events, or monitoring labels.
- [ ] Two authorized custodians can recover required secrets from an external
  secret manager. Recovery access and break-glass use are audited and tested.
- [ ] Token-key, session-secret, Epic credential, and private-key JWT rotation
  runbooks have named cadence/owners and have been exercised in non-production.
- [ ] A Worker key-rotation test proves: old records read with retained keys, old
  records lazily rewrite under the current key, new writes use the current ID,
  expired unreadable records are deleted, and a missing required key fails closed.
- [ ] Key retirement waits for the maximum record lifetime plus pending TTL and
  alarm delay. Any pre-migration row keeps its legacy key for the 30-day migration
  grace unless evidence proves none exist.
- [ ] Secret/key compromise contacts, Epic revocation authority, and emergency
  traffic-disable procedure are available 24/7.

Secret/key evidence: _______________________________________________

## 5. Storage, retention, deletion, backup, and restore

- [ ] Security has reviewed the Durable Object plaintext metadata boundary:
  hashes, timestamps, status, key IDs, expiry, pseudonymous registry references, and
  access patterns remain visible even though token/patient payloads are encrypted.
- [ ] AES-256-GCM records, row-bound authenticated data, hashed indexes, key IDs,
  lazy rotation, `cleanup_after`, and the versioned migration ledger pass tests.
- [ ] `SESSION_IDLE_TIMEOUT_SECONDS` and `SESSION_MAX_LIFETIME_SECONDS` are
  approved, consistent with policy, and satisfy idle ≤ maximum. Defaults were not
  accepted accidentally.
- [ ] Pending authorization expiry (10 minutes), session expiry, hourly alarm
  cleanup, best-effort remote revocation, local deletion, and manual MyChart
  guidance have been tested.
- [ ] Account-wide disconnect/deletion across browser sessions is tested for
  success, partial remote-revocation failure, concurrent deletion, registry
  outage, and expired registry entries.
- [ ] A retention schedule covers encrypted records, plaintext metadata, audit
  events, Cloudflare logs, WAF/zone logs, support artifacts, backups/PITR, and
  legal holds. Automated configuration matches the approved schedule.
- [ ] Raw FHIR versions, normalized projections, and insights are inventoried as
  separate ePHI-bearing artifacts under the same approved account, retention,
  export, and deletion boundary. Projection failure retains the raw source and
  does not extend its expiry.
- [ ] The service has chosen and approved either reconnect-only recovery or PITR.
  RPO/RTO, owners, platform/contract limits, and patient impact are documented.
- [ ] Recovery material covers repository/version, configuration, bindings,
  routes, Epic registration, key IDs/keys, monitoring, and runbooks. Keys are
  stored separately from ciphertext and recoverable by approved custodians.
- [ ] A synthetic recovery drill proves that restore cannot silently resurrect a
  disconnected, revoked, compromised, incompatible, or expired grant. When
  reconciliation is uncertain, the documented outcome is local deletion and
  patient reconnect.
- [ ] No procedure copies production token/PHI storage into development, vendor
  support, screenshots, or unapproved exports.

Retention/recovery evidence and RPO/RTO: ____________________________

## 6. Privacy-safe logging, audit, and monitoring

- [ ] Automatic Worker invocation logs remain disabled, or an approved test proves
  callback query strings and all prohibited fields are redacted before ingestion.
- [ ] Every possible logging path has been reviewed separately: application
  console, Workers Logs/Logpush, zone/access/WAF/DNS logs, browser analytics, APM,
  SIEM, support tools, error reporting, CI, and vendor destinations.
- [ ] Synthetic tests prove no URL/query string, OAuth code/state/nonce, cookie,
  header/token, session ID, patient/FHIR ID, name, or FHIR body appears in logs,
  traces, metrics labels, errors, alerts, tickets, or screenshots.
- [ ] Structured audit events contain only the approved event schema, request ID,
  pseudonymous session reference, safe resource type/interaction, outcome/error
  code, policy version, and revocation status.
- [ ] The audit destination provides approved encryption, region, access controls,
  retention/deletion, integrity, availability, search, delivery monitoring, and
  administrative-access evidence. Best-effort `console.info` is not the sole
  compliance record.
- [ ] External monitors cover `/healthz`, `/readyz`, legal pages, DNS/TLS, and
  non-PHI Epic discovery. Operators understand that readiness checks both Durable
  Object classes and registry SQL but does not contact Epic or prove every existing
  encrypted session object is decryptable.
- [ ] Dashboards and alerts cover Worker exceptions/5xx/latency, readiness,
  authorization conversion/failure, token refresh, FHIR failures, rate limiting,
  cleanup failures, Durable Object storage, audit delivery, and provider outage.
- [ ] SLOs, burn-rate alerts, paging thresholds, synthetic identities, dashboards,
  24/7 owners, escalation paths, and maintenance/traffic-disable procedures have
  been exercised.
- [ ] Log reader/exporter access is least privilege and reviewed; retention and
  deletion are enforced in every downstream copy.

Monitoring/logging evidence: _______________________________________

## 7. Rate limiting, performance, and availability

- [ ] Controlled single-location tests confirm both rate-limit bindings
  eventually reject excess `/auth/start` and authenticated `/api/*` traffic with
  `429` and `Retry-After: 60`. Evidence does not assume an exact cutoff because
  Cloudflare's binding is permissive and eventually consistent.
- [ ] An authoritative WAF/account-level control is active if the approved threat
  model requires a hard global ceiling; application bindings alone are not
  represented as global accounting.
- [ ] Load tests cover normal page behavior, refresh locking, pagination,
  concurrent tabs, retries, shared NATs, provider latency, Durable Object cold
  start, alarm cleanup, and upstream 429/5xx. They use synthetic data only.
- [ ] Limits have been reviewed against expected traffic and Epic quotas. Changes
  require security, product, and provider-impact review.
- [ ] Cloudflare WAF/bot/DDoS controls and emergency rules are tested for abuse
  without exposing raw identifiers or blocking an unacceptable patient cohort.
- [ ] Timeout, response-size, redirect, trusted-origin, and Content Security Policy
  failure paths have been tested against malicious and slow upstream behavior.
- [ ] Availability dependencies and failure modes include Cloudflare runtime,
  Durable Objects, DNS/TLS, logging, Epic discovery/OIDC/JWKS/token/FHIR services,
  the healthcare organization, and the production identity/support systems.
- [ ] Capacity/quota alerts and a provider outage communication path are active.

Performance/availability evidence: _________________________________

## 8. Security and functional verification

- [ ] From a clean checkout with the pinned Node/pnpm versions,
  `pnpm install --frozen-lockfile` and `pnpm run verify` pass.
- [ ] CI runs type-check, tests, build, Wrangler dry-run, dependency/license policy,
  secret scanning, and the organization's security scan. Every exception has an
  owner, rationale, compensating control, and expiry.
- [ ] Tests cover PKCE/state/nonce, duplicate callback fields, atomic one-time
  state, OIDC issuer/audience/signature, client authentication, refresh locking,
  consent version, identity/account binding, encrypted storage/migration/rotation,
  and security headers.
- [ ] Hub tests cover separate and stale consent, pre-consent no-write behavior,
  exact-consent historical backfill, raw-resource version integrity, normalized
  adapters and deterministic summaries for all 22 supported resource types,
  projection failure without raw loss, exact source citations, account/patient
  isolation, the raw-free `/api/hub/intelligence` response, retention alarms,
  export, disconnect retention, exact-confirmation deletion, wrong keys,
  corruption, out-of-order source versions, multi-chunk atomic writes,
  interrupted writes, account-size limits, and Worker routing.
- [ ] Synthetic intelligence tests prove the checked-in summaries call no external
  AI/model service, do not decode Binary payloads or fetch references/attachments,
  and never render narrative HTML or infer absent clinical facts.
- [ ] FHIR tests prove patient constraints cannot be overridden; resource and
  parameter allowlists, direct reads, encrypted/authenticated session-bound
  pagination, trusted origins,
  redirects, response size, and timeouts fail closed.
- [ ] Browser tests cover stale/missing consent, cookie security, cross-origin
  mutations, callback history cleanup, reconnect, shared tabs/devices, disconnect,
  disconnect-all, manual MyChart revocation guidance, Terms, Privacy, accessibility,
  and supported browsers/mobile WebViews.
- [ ] Negative tests cover invalid/expired/replayed state and cursor, missing or
  mismatched OIDC claims, wrong/missing encryption keys, newer storage schema,
  registry failure, Epic 401/403/429/5xx, corrupted responses, and audit failure.
- [ ] No production secrets or real patient accounts/data were used in automated,
  load, penetration, or recovery testing without explicit authorization.
- [ ] Open security/privacy findings meet the launch acceptance policy; no release
  relies on the phrase “encrypted” or “read-only” as a substitute for risk review.

Verification evidence: _____________________________________________

## 9. Release, rollback, incident response, and support

- [ ] Candidate and last-known-good Worker versions are recorded. The rollback
  owner, triggers, observation window, and traffic-disable action are confirmed.
- [ ] The previous version has been proven compatible with the current Durable
  Object schema and active keyring. Operators understand code rollback does not
  roll storage back.
- [ ] The exact candidate passed in a separately named, fully isolated staging
  Worker/environment. The team understands that declarative Durable Object
  `exports` requires an atomic `wrangler deploy`, does not support version upload
  or gradual deployment, and cannot roll back across a lifecycle change.
- [ ] Post-deploy smoke tests cover health, readiness, legal pages, consent, one
  existing session, new authorization, returned scopes, read/search/direct
  read/pagination, safe negative cases, rate limiting, disconnect, and audit
  delivery.
- [ ] The incident plan names a 24/7 incident commander, security, service,
  privacy/legal, Epic, Cloudflare, and communications owner with backups.
- [ ] Tabletop exercises cover callback-code logging, token-key loss/compromise,
  session-secret compromise, Epic credential compromise, provider outage,
  cross-patient access, Durable Object failure, bad migration, audit failure, and
  abuse.
- [ ] Support can help a patient disconnect locally and remove the app in MyChart
  without requesting credentials, tokens, codes, screenshots with PHI, or FHIR
  payloads.
- [ ] Patient/customer status and incident communications have privacy/legal-
  approved templates and escalation rules.
- [ ] On-call has access to the current
  [production runbook](production-operations.md) and
  [incident playbook](incident-response-and-recovery.md), and has demonstrated
  the required Cloudflare/Epic actions.

Release/incident evidence: _________________________________________

## 10. Final production promotion

- [ ] All prior sections are complete, or every `N/A`/exception has a named
  approver, rationale, compensating control, expiry, and follow-up owner.
- [ ] Ordinary variables, secret/key IDs, bindings/classes, rate namespaces,
  hostname, Epic registration, legal version, monitoring, and runbook versions
  have a final two-person comparison against the release record.
- [ ] Security, privacy/legal, Epic/provider, service owner, and release owner have
  explicitly approved promotion.
- [ ] Incident channel, dashboards, Cloudflare/Epic contacts, and rollback owner
  are active for the full observation window.
- [ ] The candidate is atomically deployed with protected approval; its Wrangler
  deployment/version ID and Durable Object exports reconciliation are recorded.
- [ ] Post-deployment smoke tests pass with synthetic/approved production test
  data, and metrics remain within abort thresholds through the observation window.
- [ ] Release evidence is archived with its retention/access policy, without PHI
  or secret values.

## Sign-off

| Role | Name | Decision | Timestamp (UTC) | Evidence reference |
|---|---|---|---|---|
| Service owner | | Approve / Reject | | |
| Security | | Approve / Reject | | |
| Privacy/legal | | Approve / Reject | | |
| Epic/provider owner | | Approve / Reject | | |
| Release manager | | Approve / Reject | | |

Production is not approved until every required sign-off says **Approve** and no
release-blocking exception remains open.
