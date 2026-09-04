# Epic MyChart SMART-on-FHIR connector

This folder contains a standalone, read-only TypeScript service for connecting a patient-authorized MyChart account to Epic's R4 FHIR API.

The connector implements:

- SMART-on-FHIR standalone authorization-code launch
- SMART and OpenID endpoint discovery
- PKCE S256, high-entropy one-time `state`, and OIDC `nonce`
- Server-side code exchange and signed ID-token validation
- Epic `client_secret_basic`, `private_key_jwt`, and public-client token authentication
- Automatic refresh-token use with concurrent-refresh locking
- Memory-only tokens by default, with AES-256-GCM encrypted file or Cloudflare Durable Object persistence
- Read-only Patient access and an allowlisted, patient-constrained FHIR proxy
- An optional encrypted FHIR hub with source-linked normalized intelligence for
  all 22 supported resource types
- Best-effort remote token revocation and immediate local disconnect
- A patient-friendly temporal record view with grant-aware detail actions, chronological clinical events, and blank timeline positions for undated records on each displayed FHIR Bundle page, plus an advanced raw-FHIR view and JSON API

MyChart is not one central API. Each healthcare organization has its own FHIR base URL and authorization server. The connector implements the flow described here, but a real connection still requires an Epic-issued client ID, activation/distribution at the healthcare organization, and interactive patient consent. This application never receives or stores a MyChart username or password.

Production use requires more than a successful deployment. Start with the
[production operations runbook](docs/production-operations.md), execute the
[go-live checklist](docs/go-live-checklist.md), and give the on-call team the
[incident and recovery playbook](docs/incident-response-and-recovery.md). Those
documents label controls implemented by this repository separately from
Cloudflare/Epic configuration and legal, security, monitoring, recovery, and
organizational gates that remain the operator's responsibility.

## 1. Register an Epic patient app

Create an app in [Epic on FHIR](https://fhir.epic.com/Developer/Apps) and configure it as follows:

1. Set the primary user type to **Patients**.
2. Select **Incoming API**, **Use OAuth 2.0**, and **R4**.
3. Select **SMART Scope Version: SMART v2**. The exact catalog requires an Epic
   November 2024 or newer target for native v2 scope formatting.
4. Register the exact callback for the environment you will run:

   ```text
   http://localhost:3000/auth/callback
   ```

   For Cloudflare, use the final custom-domain URL instead, for example
   `https://health.example.com/auth/callback`. The checked-in production
   configuration disables direct `workers.dev` access.

5. Select only the FHIR APIs the application needs. The checked-in production
   catalog currently approves 53 read/search scope values across 22 resource
   types; reconcile each one with its exact Epic Incoming API using the
   [scope catalog](docs/fhir-scope-catalog.md). Search and Read are separate, and
   category-qualified grants are separate from unrestricted grants. The 21
   non-Patient resource types enabled for the explorer are in `.env.example`;
   Patient profile access is handled separately.
6. For the easiest local confidential-client setup, generate a sandbox client secret and choose `client_secret_basic`. Epic recommends `private_key_jwt` for production deployments.
7. Enable **Requires Persistent Access** only if the application genuinely needs access beyond the initial token lifetime.
8. Save the non-production client ID. Epic notes that sandbox app changes can take up to one hour to synchronize.

Use only Epic's synthetic [sandbox test patients](https://fhir.epic.com/Documentation?docId=testpatients) against the sandbox. A real MyChart account cannot be connected to the sandbox.

## 2. Configure the connector

Node.js 22.13 or newer is required. The checked-in `.node-version` selects Node 22,
which is available in Cloudflare Workers Builds.

```bash
pnpm install
cp .env.example .env
```

Edit `.env` and set at least:

```dotenv
APP_LEGAL_NAME=replace-with-your-legal-entity-name
APP_LEGAL_CONTACT_EMAIL=privacy-contact@example.invalid
APP_LEGAL_EFFECTIVE_DATE=2026-08-23
APP_HOSTING_PROVIDER_NAME=replace-with-your-hosting-provider-name
EPIC_CLIENT_ID=your-environment-client-id
EPIC_CLIENT_SECRET=your-sandbox-client-secret
EPIC_TOKEN_AUTH_METHOD=client_secret_basic
SESSION_SECRET=a-long-random-value
```

If you already have `.env`, do not replace it; add these four `APP_*` values to the
existing file and replace every placeholder with the real operator and deployment
details. The application refuses to publish the legal pages with the checked-in
placeholder name, email, or hosting provider, and it requires an explicit effective
date.

Generate the cookie-signing secret with:

```bash
openssl rand -base64 48
```

The default FHIR base URL is Epic's R4 sandbox:

```text
https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4
```

For a real healthcare organization, choose its R4 base from Epic's [production endpoint directory](https://open.epic.com/MyApps/Endpoints), then set `EPIC_FHIR_BASE_URL` and `EPIC_PROVIDER_NAME`. The production client ID must already be distributed and active in that environment. For a multi-provider product, periodically download and re-host Epic's User-access Brands bundle; Epic advises against depending on its directory as a runtime service.

The 53-value resource catalog uses SMART v2 `.r`/`.s` scopes, including
query-qualified permissions. Configure the Epic app's **SMART Scope Version** as
**SMART v2** and target an Epic November 2024 or newer environment. Older Epic
versions can return SMART v1 scope formatting even when v2 was selected; this
connector deliberately rejects a returned grant that broadens the approved v2
matrix.

## 3. Verify discovery and run

```bash
pnpm run check:epic
pnpm run dev
```

Open [http://localhost:3000](http://localhost:3000), choose **Connect MyChart**, and complete sign-in and authorization only on the Epic/MyChart page.

The discovery check is read-only. It confirms the configured SMART authorization/token endpoints, PKCE support, supported client authentication methods, and OpenID issuer/JWKS location without accessing a patient account.

The connector intentionally targets current R4 SMART/OIDC discovery. A healthcare organization that exposes only legacy Epic metadata endpoints will need an organization-specific compatibility adapter rather than a silent fallback.

### Make a direct read-only FHIR request

The operator utility in `scripts/epic-fhir-get.ts` sends a direct `GET` to the
configured Epic FHIR base. It uses `EPIC_FHIR_BASE_URL` and `EPIC_CLIENT_ID` from
the environment or local `.env` file and defaults to the server's
CapabilityStatement:

```bash
pnpm run fhir:get
```

To save that validated raw CapabilityStatement as a formatted, provider-specific
snapshot under `src/`, run:

```bash
pnpm run fhir:save-capability
```

This atomically creates or replaces `src/capability-statement.json`. Rerun the
command after changing providers or after an Epic upgrade; the saved document is
a point-in-time reference and is not a substitute for runtime discovery.

Pass a relative FHIR path to read a resource or perform a search. Quote search
paths so the shell does not interpret `&`:

```bash
pnpm run fhir:get -- 'Patient/example-id'
pnpm run fhir:get -- 'Observation?patient=example-id&_count=5'
```

Protected resource calls also require a current patient-authorized token in the
`EPIC_FHIR_ACCESS_TOKEN` environment variable. Supply that value only in the
operator's current environment; do not add access tokens to `.env`, command-line
arguments, source control, logs, or support evidence. The script never prints the
token or request URL, rejects redirects, operations, history routes, credential
query parameters, and paths outside the configured FHIR base. CapabilityStatement
responses are limited to 2 MiB and resource responses to 5 MiB. It is a diagnostic
utility and does not bypass the scopes, patient context, or other restrictions
enforced by Epic.

## 4. Deploy to Cloudflare Workers

The repository includes a native Worker entry point, versioned Wrangler
configuration, rate-limit bindings, and SQLite-backed Durable Objects. Static
pages are served at the edge; each random browser route uses a strongly ordered
Durable Object for OAuth state, refresh locking, encrypted grants, and deletion.
A separate privacy-reduced registry coordinates account-wide disconnect without
placing tokens, direct patient identifiers, or FHIR payloads in a global object.

The checked-in production posture disables `workers.dev`, preview URLs, and
automatic invocation logs. Attach the final custom domain/route before registering
the callback with Epic. Use one isolated Worker deployment per Epic
client/provider unless an externally reviewed multi-tenant configuration layer is
added.

Before upload, run:

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

For Cloudflare Workers Builds, leave the repository root blank and set
`PNPM_VERSION=11.22.0` so the build uses the pnpm version pinned in
`package.json`. This Worker uses Cloudflare's declarative Durable Object `exports`
lifecycle, which does not support version upload or gradual deployments. Validate
the exact candidate first in a separately named staging Worker/environment, then
perform an approval-protected atomic production deploy. The package-level `deploy`
command intentionally refuses direct deployment. The exact procedure, smoke tests,
and rollback gates are in the
[production operations runbook](docs/production-operations.md).

Runtime values are not Workers Builds variables. The current Wrangler file has
`keep_vars: true`, so a deployment preserves dashboard-managed ordinary variables
that are omitted from the file. A production pipeline must keep an approved
inventory, compare it with the target Worker before each release, and deploy with
`--keep-vars --strict`; the repository alone cannot reconstruct or detect drift in
those preserved values.

Configure these non-secret runtime variables for the target environment:

```dotenv
APP_LEGAL_NAME=replace-with-your-legal-entity-name
APP_LEGAL_CONTACT_EMAIL=privacy-contact@example.invalid
APP_LEGAL_EFFECTIVE_DATE=2026-08-23
APP_HOSTING_PROVIDER_NAME=Cloudflare
CONSENT_POLICY_VERSION=2026-08-23
EPIC_CLIENT_ID=your-environment-client-id
EPIC_TOKEN_AUTH_METHOD=client_secret_basic
EPIC_FHIR_BASE_URL=https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4
EPIC_PROVIDER_NAME=Epic R4 Sandbox
EPIC_REDIRECT_URI=https://your-final-worker-host/auth/callback
EPIC_SCOPES=openid fhirUser launch/patient
EPIC_ALLOWED_RESOURCE_SCOPES=copy-the-exact-53-value-line-from-.dev.vars.example
EPIC_REQUEST_OFFLINE_ACCESS=false
EPIC_ALLOWED_RESOURCE_TYPES=AllergyIntolerance,Binary,CarePlan,CareTeam,Condition,Device,DiagnosticReport,DocumentReference,Encounter,Goal,Immunization,Location,Medication,MedicationRequest,Observation,Organization,Practitioner,PractitionerRole,Procedure,Provenance,RelatedPerson
EPIC_TRUSTED_ENDPOINT_ORIGINS=https://fhir.epic.com
EPIC_FHIR_WIRE_LOGGING=off
SESSION_IDLE_TIMEOUT_SECONDS=1800
SESSION_MAX_LIFETIME_SECONDS=28800
TOKEN_ENCRYPTION_KEY_ID=2026-rotation-1
```

`EPIC_SCOPES` is the short standalone authorization request: `openid fhirUser
launch/patient` (plus `offline_access` only when explicitly approved). Epic does
not currently support authorization POST for standalone launches, so FHIR
resource scopes must not be placed in this GET query.

`EPIC_ALLOWED_RESOURCE_SCOPES` is the separate 53-value upper-bound policy for
resource grants Epic may add from the Incoming APIs configured on the app record.
For production, make the canonical single-line value in `.dev.vars.example`
explicit in controlled configuration and reconcile it with those Incoming APIs. The
[scope catalog and UI mapping](docs/fhir-scope-catalog.md) lists every value and
explains why 22 resource types become a separate Patient profile and at most 19
searchable dropdown types plus one known-ID Provenance read choice—not 53 dropdown
rows.

Use production values only after Epic and organizational approval. For Epic
patient-facing apps, resource grants derive from the Incoming APIs on the app
record in addition to the authorize request. The connector saves and displays the
literal scopes returned with the access token; those returned scopes, rather than
the app page or either local configuration value alone, describe the current grant.

Configure these encrypted runtime secrets:

```text
EPIC_CLIENT_SECRET
SESSION_SECRET
TOKEN_ENCRYPTION_KEY
TOKEN_ENCRYPTION_PREVIOUS_KEYS
```

Set `TOKEN_ENCRYPTION_PREVIOUS_KEYS={}` for the first key. During rotation it is a
JSON object from retained key IDs to their base64 keys and must remain a secret.
For `private_key_jwt`, use `EPIC_PRIVATE_KEY_PEM` as a secret and configure the
matching non-secret algorithm and key ID instead of using `EPIC_CLIENT_SECRET`.

Generate the cookie and token secrets independently:

```bash
openssl rand -base64 48  # SESSION_SECRET
openssl rand -base64 32  # TOKEN_ENCRYPTION_KEY
```

Keep recoverable copies in an approved external secret manager. The Worker
supports retained-key rotation and lazy re-encryption; follow the
[key-rotation procedure](docs/production-operations.md#token-encryption-key-rotation)
rather than replacing the key in place.

Verify the deployed version has the connector/registry Durable Object bindings and
the production-unique authorization/API rate-limit namespaces. Then confirm:

```text
https://your-final-worker-host/terms
https://your-final-worker-host/privacy
https://your-final-worker-host/healthz
https://your-final-worker-host/readyz
```

`/healthz` checks Worker configuration, required rate-limit binding presence, and
liveness. `/readyz` checks the registry
binding/SQL and a dedicated connector Durable Object's configuration, migrations,
storage access, and keyring configuration. Because that connector object is
normally empty, readiness cannot prove that every existing session record is
decryptable; it also does not contact Epic. Use an existing-session synthetic,
key-rotation tests, and a separate non-PHI Epic discovery synthetic for those
checks.

For local Worker development:

```bash
cp .dev.vars.example .dev.vars
pnpm run dev:worker
```

The example uses `http://localhost:8787/auth/callback`; register that callback in a
separate non-production Epic configuration before exercising the local Worker flow.
Run `pnpm run cf-typegen` after changing Worker bindings.

## Terms and Privacy pages

The Terms and Privacy Notice are rendered once from shared code and served by both
the Node and Cloudflare adapters at `/terms` and `/privacy`. The home page links both
notices before the authorization action and requires an affirmative checkbox before
enabling **Connect MyChart**. Authorization start also enforces the current
`CONSENT_POLICY_VERSION` on the server, and the accepted policy version and time are
retained with the pending authorization and encrypted connection record. Counsel
must still decide whether that receipt, identity binding, policy presentation, and
retention satisfy the production product's consent and evidence requirements.

The checked-in language describes this connector's current technical behavior, but
it is a launch template rather than legal approval. Before using real patient data,
have qualified counsel review the operator identity and contact method, age/proxy
rules, applicable consumer-health and breach-notification laws, HIPAA role (if any),
hosting agreements and log retention, deletion procedures, governing law, and any
warranty or liability language. Keep the notice synchronized with actual data flows;
policy text cannot substitute for product authentication, access controls, incident
response, monitoring, or rate limiting.

Set `APP_HOSTING_PROVIDER_NAME=Cloudflare` for the current Worker deployment. If the
service later moves to AWS or another platform, change that value and review every
storage, logging, subprocessors, and retention statement before publishing the new
notice. The operator must also confirm that the commitments about sale, advertising,
and data-broker disclosure match its actual business practices—not only this source
code.

## Authentication choices

### Client secret

This is the simplest confidential-client setup for one local environment:

```dotenv
EPIC_TOKEN_AUTH_METHOD=client_secret_basic
EPIC_CLIENT_SECRET=the-secret-generated-for-this-environment
```

Epic credentials must be unique per healthcare organization and environment. Do not commit `.env`.

### Private-key JWT

The service also supports Epic's recommended `private_key_jwt` profile with ES384 or RS384. Generate a P-384 pair:

```bash
pnpm run keys:generate
```

Host `.secrets/public.jwks.json` at a stable public HTTPS URL and register that JWK Set URL on the Epic app/installation. Then set the `EPIC_PRIVATE_KEY_*` values printed by the command and use:

```dotenv
EPIC_TOKEN_AUTH_METHOD=private_key_jwt
```

The private key stays in `.secrets/`, which is ignored. `keys:generate` refuses to overwrite existing keys unless `--force` is explicitly passed to the script; key rotation must also be coordinated with Epic.

On Cloudflare, store the private PEM as the encrypted `EPIC_PRIVATE_KEY_PEM` runtime
secret instead of setting `EPIC_PRIVATE_KEY_PATH`. Set `EPIC_PRIVATE_KEY_ALG` and
`EPIC_PRIVATE_KEY_KID` as ordinary runtime variables.

### Public client

`EPIC_TOKEN_AUTH_METHOD=none` is supported for an app registered as non-confidential. It still uses PKCE, but it cannot provide ordinary persistent refresh-token access. Do not hide a shared "secret" in a distributed desktop/browser client and treat it as confidential.

## Token storage

### Local Node server

The default is deliberately ephemeral:

```dotenv
TOKEN_STORAGE=memory
```

Tokens disappear when the process stops. To persist a confidential connection, enable encrypted storage and generate a separate 32-byte key:

```bash
openssl rand -base64 32
```

```dotenv
TOKEN_STORAGE=encrypted-file
TOKEN_ENCRYPTION_KEY=the-generated-base64-value
TOKEN_STORE_FILE=.data/connections.enc
EPIC_REQUEST_OFFLINE_ACCESS=true
```

The entire token record, including the patient identifier, is encrypted with AES-256-GCM and written with mode `0600`. Keep the encryption key outside backups and source control. A hosted production system should use a KMS or secret manager and a multi-user database instead of this single-process file store.

The encrypted file is keyed by the signed browser session. If that cookie is lost, rotate the signing secret, or retire the connector, purge all durable tokens with:

```bash
pnpm run tokens:purge
```

Stop the connector before running this command. An exclusive lock prevents the server and purge command from opening the same encrypted store concurrently. The command attempts remote revocation when Epic advertises it, deletes every local encrypted record regardless, and reports when manual revocation in MyChart is still recommended.

If the process is killed without a graceful shutdown, the adjacent `.lock` file is deliberately not removed automatically. First verify that no connector or purge process is running, then remove only that exact `.lock` file and restart. This fail-closed recovery avoids two concurrent processes both deciding that a lock is stale.

Local sessions and their encrypted records become unusable after the configured
idle timeout or absolute lifetime—30 minutes idle and 8 hours maximum by default.
The service checks at startup and hourly, attempts remote revocation for expired or
policy-stale records, and deletes them locally. Reauthorize to continue after that
boundary.

Each durable grant is bound to the Epic client ID and FHIR base URL that created it. Disconnect or run `tokens:purge` with the old configuration before changing providers or client registrations. If configuration is changed first, the connector refuses to send the new client credentials to the old provider, deletes the incompatible grant locally, and requires manual removal of the old app in MyChart.

### Cloudflare Worker

The Worker does not use `TOKEN_STORAGE` or `TOKEN_STORE_FILE`. It always uses a
per-session SQLite-backed Durable Object, and it requires `TOKEN_ENCRYPTION_KEY` as a
runtime secret. Session identifiers and OAuth states are hashed before indexing;
OAuth state, PKCE verifiers, nonces, patient identifiers, session IDs, and OAuth
tokens are stored only in AES-256-GCM payloads. Sensitive operational key-ID and expiry
metadata remain outside ciphertext so rotation and eventual cleanup do not depend
on decrypting an expired record. A versioned SQLite migration ledger prevents
fragile untracked schema changes.

New writes use `TOKEN_ENCRYPTION_KEY_ID`; reads try the current and retained keys
from `TOKEN_ENCRYPTION_PREVIOUS_KEYS` and lazily re-encrypt an old record with the
current key. Pending OAuth state expires after 10 minutes. Durable Object alarms
prune connections about hourly, attempt best-effort remote revocation, and delete
locally. Pre-migration records without exact expiry metadata receive a conservative
30-day cleanup bound when the metadata migration runs.

`pnpm run tokens:purge` operates only on the local encrypted file. The Worker has
no operator-facing fleet-wide token purge command. Follow the documented
[rotation](docs/production-operations.md#token-encryption-key-rotation) and
[incident](docs/incident-response-and-recovery.md) procedures; never replace a key
under an existing key ID or remove retained keys before every dependent record has
expired and cleanup has run.

## Optional private FHIR hub

The hub is disabled by default and is separate from OAuth-token persistence.
Connecting MyChart alone never enables it. After the user accepts the current
hub-specific notice, newly requested validated FHIR resources are stored as
content-addressed raw versions. Each supported resource also receives a bounded,
query-friendly projection and deterministic source-cited summary containing only
explicit source facts. A normalization failure records a bounded reason and never
drops the raw resource. Disconnect retains the hub, while permanent deletion is a
separate confirmed operation.

The intelligence registry covers `Patient` plus the 21 configured resource types:
`AllergyIntolerance`, `Binary`, `CarePlan`, `CareTeam`, `Condition`, `Device`,
`DiagnosticReport`, `DocumentReference`, `Encounter`, `Goal`, `Immunization`,
`Location`, `Medication`, `MedicationRequest`, `Observation`, `Organization`,
`Practitioner`, `PractitionerRole`, `Procedure`, `Provenance`, and
`RelatedPerson`. Raw FHIR JSON remains the source of truth; projections and
insights are separately versioned, rebuildable artifacts tied to the exact source
content hash. The checked-in summaries use deterministic local rules and make no
external AI/model request.

```dotenv
FHIR_HUB_ENABLED=true
FHIR_HUB_STORE_FILE=.data/fhir-hub.enc
FHIR_HUB_ENCRYPTION_KEY=base64-encoding-of-32-random-bytes
FHIR_HUB_IDENTITY_KEY=a-different-base64-encoding-of-32-random-bytes
FHIR_HUB_CONSENT_VERSION=2026-08-26
FHIR_HUB_RETENTION_DAYS=365
```

`FHIR_HUB_CONSENT_VERSION` must identify the exact approved intelligence notice.
Deploying a new normalizer does not silently process retained historical data.
When the approved purpose expands, publish a new version and require the user to
accept it; that explicit receipt is what authorizes backfilling still-retained raw
versions. Until then, the old receipt is stale, new ingestion stops, and existing
data remains available for export and deletion.

Node uses a separately locked AES-256-GCM file. The Worker routes only by an
opaque server-derived account reference to a separate, application-encrypted,
account-scoped `EpicFhirHub` Durable Object. Worker saves use bounded encrypted
chunk generations with an atomic manifest switch; the current account-state cap
is 16 MiB. The manifest keeps only non-content generation metadata and the earliest
cleanup deadline in plaintext, allowing scheduled or verified-account deletion
even if ciphertext becomes unreadable. Never reuse the token, hub-data, or
identity keys. This is currently a
provider-scoped MyChart account vault; a real multi-provider product still needs
Moonba authentication, an approved linking workflow, and resource-granular
storage. See [the architecture and production gates](docs/private-fhir-hub.md).

## JSON API

Stateful FHIR routes require the signed, HTTP-only browser session cookie. Public UI,
health, and disconnected-status routes do not. Tokens are never returned to the
browser.

`GET /api/connection` returns an opaque `connectionContext`. Every FHIR data and
authenticated disconnect request must send that value as
`X-Epic-Expected-Connection-Context`; the server rejects a stale tab before
contacting Epic. Every successful FHIR data response repeats the value in
`X-Epic-Connection-Context`, and the server rechecks the connection after the
upstream request before releasing the body. The bundled UI performs both checks.
It revalidates the connection when focus or page visibility returns while retaining
the current in-memory search choices and results for an unchanged account. It
scrubs them when another tab changes the connection, the connection context changes,
authentication is lost, the user disconnects, or the page is left.

Successful FHIR data responses also carry bounded `X-Moonba-FHIR-*` trace
headers for source mode, interaction, resource type, resource-field preservation,
and connector transforms. The values come from fixed enums and never contain a
FHIR ID, URL, query value, response body, patient detail, or token. Error responses
do not attest successful processing with these headers.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/terms` | Public Terms and Conditions shown before authorization |
| `GET` | `/privacy` | Public Privacy Notice describing health-data handling |
| `GET` | `/healthz` | Process health |
| `GET` | `/readyz` | Configuration and persistent-storage readiness |
| `POST` | `/auth/start` | Begin standalone SMART authorization |
| `GET` | `/auth/callback` | Exact registered OAuth callback |
| `GET` | `/api/connection` | Safe connection metadata, never tokens |
| `GET` | `/api/patient` | Read the authorized Patient resource |
| `GET` | `/api/fhir/:resourceType` | Search an allowlisted resource with its approved patient-bound or scope-restricted strategy; `Location` is derived from patient Encounter references |
| `GET` | `/api/fhir/:resourceType/:id` | Read an allowlisted resource instance after grant and fine-grained constraint validation |
| `GET` | `/api/fhir-page?cursor=...` | Follow a server-issued, encrypted/authenticated session-bound cursor to the next safe Bundle page |
| `GET` | `/api/hub/status` | Return consent state and privacy-safe hub counts for the live account context |
| `POST` | `/api/hub/enable` | Record the current hub-specific consent receipt |
| `GET` | `/api/hub/resources` | Browse current or historical retained versions for the connected patient context |
| `GET` | `/api/hub/intelligence` | Return raw-free normalized projections and source-cited insights; supports `resourceType`, `includeHistory`, `includeSuperseded`, and `limit` filters |
| `GET` | `/api/hub/export` | Export the account vault with raw versions, projections, provenance, and insights |
| `POST` | `/api/hub/delete` | Permanently delete the account vault after exact confirmation |
| `POST` | `/api/disconnect` | Revoke when supported, then delete local tokens |
| `POST` | `/api/disconnect-all` | Disconnect every active browser route for the same verified Epic account |

Search forwarding is intentionally narrow. Supported caller parameters are `_count`, `_sort`, `authoredon`, `category`, `class`, `clinical-status`, `code`, `date`, `docstatus`, `status`, and `type`. The caller cannot override the patient constraint, request `_include`/`_revinclude`, follow an arbitrary URL, or access resource types outside `EPIC_ALLOWED_RESOURCE_TYPES`. Independently of caller input, the server adds the single fixed `_revinclude=Provenance:target` value when the searched resource advertises it, Provenance is allowlisted and read-capable, and the current patient grant includes unqualified Provenance read access. Included Provenance must identify itself as an included search entry and target a primary result on the same Bundle page; all other included resource types are rejected.

The derived `Location` action accepts only `_count`; it rejects direct Location
filters because it resolves resources strictly through authorized Encounter
references.

Direct reads are limited to allowlisted resource types, require an effective Read
grant, validate the returned resource type/ID, and enforce any category-qualified
scope locally. Clinical searches force the authorized patient ID; approved
supporting-resource searches rely on the patient-level SMART grant without adding
an invalid generic `patient=` parameter. Care locations are a special case: the
connector searches the authorized patient's Encounters, deduplicates strict
`Encounter.location[].location` references, and reads only same-server `Location`
IDs. It never performs an unfiltered Location search or follows a reference to a
different server. The traversal is bounded by page, read, concurrency, time, and
cumulative upstream-byte limits; a safe `OperationOutcome` warning marks any
partial result. Pagination never accepts an arbitrary
upstream URL from the browser: the server validates the same-FHIR-base Bundle link
and issues a short-lived AES-256-GCM encrypted/authenticated cursor tied to the
session and original search.

## Tracing a missing FHIR field

Every successful health-data view includes an ephemeral **Response trace**. It
separates the provider response, connector processing, and the friendly display,
and it includes a field/path checker that reports presence without repeating the
field value. The Advanced panel contains the complete parsed FHIR JSON delivered
by this application; it is not the original HTTP byte stream.

Use the trace as a decision tree:

1. If a field is found in the complete application JSON but not on the friendly
   card, the UI summary omitted it. Most resource cards intentionally select a
   small set of readable fields. Patient profiles group demographics, contact
   information, contacts, languages, care providers, known demographic extensions,
   and provider-scoped identifiers into readable sections. Missing main fields
   say **Not provided**; repeated display values are consolidated. Unknown
   extensions and technical metadata remain in Advanced. Profiles with
   uninterpreted modifiers or implicit rules show a notice instead of a summary.
   Location views expand every returned top-level field.
2. If a field is absent from an ordinary direct-read response, the response trace
   attests that resource fields were preserved, so Epic did not include that field
   in that read response.
3. If a field is absent from a search response, it was not present on that page
   under the current grant, filters, and result count. Check safe subsequent pages;
   absence on one page does not prove the provider has no such data.
4. Location results are connector-derived from authorized Encounter references and
   bounded individual Location reads. An `OperationOutcome` with code `incomplete`
   means unresolved, unavailable, or safety-limited references can make the result
   partial.
5. Search resource fields are preserved, but upstream `Bundle.link` values are
   replaced with a safe session-bound next-page cursor. Included Provenance and
   processing notices remain in the complete application JSON even when the
   friendly timeline summarizes them.

The trace also shows the safe `X-Request-ID`. Share that request reference and a
safe error code with support—not real FHIR JSON, screenshots, patient identifiers,
URLs, cookies, or tokens. For operator-only source comparison, the `fhir:get`
utility above must use the same provider, grant, resource, and effective filters.
Keep its access token only in the current process environment and never in `.env`,
arguments, logs, or support evidence.

### Temporary backend FHIR wire diagnostics

The backend can emit the exact outbound FHIR `GET` URL and the direct decoded
Epic response body before JSON parsing, validation, or public error sanitization.
This is deliberately disabled by default. For the smallest useful diagnostic,
start an isolated local or non-production instance with:

```bash
EPIC_FHIR_WIRE_LOGGING=errors pnpm run dev
```

Then reproduce the failure once and find the single-line JSON records whose
`fhirWire.requestId` matches the request reference displayed by the browser. An
Epic HTTP response produces a request/response pair with a shared `exchangeId`,
which distinguishes multiple Epic calls made during one browser request. A
transport, redirect, or response-size failure may produce only the request record
because no complete response body was available.

`errors` logs non-200 Epic responses plus transport and JSON-parsing failures. A
200 response that the connector later rejects during resource, Bundle, or SMART
authorization validation is an upstream HTTP success; diagnosing that uncommon
case temporarily requires `all`. `all` also logs every successful FHIR body and
should almost never be needed. `off` is the default and production setting.

The wire logger cannot accept request headers, so it never records the bearer
`Authorization` value. It records response text up to 32 KiB and reports the full
byte count, logged byte count, and `bodyTruncated` flag. An Epic
`OperationOutcome` is normally much smaller and is therefore preserved verbatim.
Response metadata is limited to the numeric status, bounded status text, and
bounded `Content-Type` value.
The public API response remains sanitized even while the backend diagnostic is
enabled. The direct response body is intentionally not redacted and must be
treated as potentially containing both PHI and credential-like values supplied by
the upstream server.

**The exact URL, search values, and response body can contain PHI.** Custom Worker
console logs can be retained and exported even though automatic invocation logs
are disabled. Use an approved synthetic identity and isolated log destination,
restrict readers and retention, never paste these records into a support ticket,
and restore `EPIC_FHIR_WIRE_LOGGING=off` immediately after capture. Enabling this
against production patient data requires explicit privacy/security approval for
the logging destination, access, region, retention, and deletion controls.

## Troubleshooting Epic 403 responses

Most resource-dropdown choices perform FHIR **search** interactions and therefore
need their matching `*.Search ... (R4)` Incoming API; adding only `Read` is not
sufficient for those choices. Eligible searches automatically include available
Provenance in their Advanced JSON when Epic advertises `Provenance:target` reverse
inclusion and the grant includes `patient/Provenance.r`. A result without an included
Provenance record is valid and means Epic did not expose one for that page. **Record
sources** remains an explicit direct-read option for a separately known Provenance
FHIR ID. The separate **View profile** action needs `Patient.Read (R4)`, and opening
a specific search result also needs that resource's **Read** permission. The UI enables actions from the
intersection of Epic's returned SMART scopes and the server CapabilityStatement:
resources without their choice's required interaction are hidden, while qualified
Observation/Condition/DocumentReference grants become explicit constrained choices
when no effective unrestricted search grant subsumes them.

After adding or changing Incoming APIs:

1. Save the Epic app and mark it ready for the Sandbox when applicable.
2. Allow up to one hour for the Developer Sandbox to synchronize. Customer-hosted
   environments can take up to 12 hours and may require the customer to download or
   update the client record.
3. Expand **Access granted by Epic** in the explorer, or request
   `GET /api/connection`, and inspect the current grant's returned scope values.
4. Disconnect the existing connection after the sync window, remove the app under
   MyChart's linked apps/devices if it remains there, and authorize it again. Refreshing
   an old grant cannot add permissions.
5. Confirm the deployed `EPIC_CLIENT_ID` is the environment-specific ID for the
   exact app record edited, the primary user type is **Patients**, and the
   configured FHIR base is the same R4 resource server used for authorization.

The explorer reports `fhir_scope_denied` only when Epic returns an OAuth
`insufficient_scope` challenge. Other Epic 403 responses use `fhir_access_denied` and
can reflect patient/user security, context, client distribution, or an unsynchronized
app record rather than a missing Incoming API.

## Disconnect and MyChart revocation

The connector uses a discovered OAuth revocation endpoint when one exists and always deletes local tokens. Epic's sandbox currently does not advertise a revocation endpoint. If remote revocation is unavailable or fails, remove the app manually in MyChart under the linked apps/devices management screen.

`/api/disconnect-all` uses the verified OIDC issuer and subject to coordinate
deletion across active browser routes for the same Epic account. The registry
stores only HMAC account references, hashed random route names, and expiry—not
tokens, patient identifiers, or FHIR payloads. Account-wide local deletion still
cannot guarantee remote revocation when Epic omits or fails the revocation
endpoint, so the response and UI preserve the manual-MyChart recommendation.

Disconnecting this application does not sign the patient out of MyChart.

## Security and deployment boundary

The Node service is safe by default for a single-user local loopback setup:

- It binds to `127.0.0.1`.
- It accepts only the configured FHIR issuer; users cannot submit arbitrary network destinations.
- Discovery and API fetches reject redirects, use timeouts and response-size limits, and require HTTPS endpoints.
- OAuth callback parameters are checked for duplicates, state is consumed atomically, and the authorization code is removed from browser history with an immediate redirect.
- ID tokens are verified for signature, issuer, audience, expiry, age, and nonce.
- Generic request logging is disabled. Structured audit events deliberately omit URLs, query strings, OAuth values, cookies, FHIR IDs, response bodies, and tokens.
- Responses use `no-store`, no-referrer, restrictive CSP, frame denial, and MIME hardening headers.

Do not expose the local Node service on a LAN or public interface. The Cloudflare
adapter adds HTTPS hosting, strongly ordered per-route storage, AES-256-GCM
encryption with retained-key rotation, versioned storage migrations, bounded
session expiry, server-enforced policy receipts, account-wide local deletion,
per-Cloudflare-location authorization/API rate limiting, and privacy-reduced audit events.
These are implemented engineering controls, not a regulated production program.

Before real patient data, the operator must complete the product identity and
authorization design, Epic production distribution, BAA/legal/privacy/security
review, protected configuration and secret management, audit delivery and access
controls, monitoring/SLOs/on-call, penetration and load testing, retention and
deletion, incident response, backup/recovery, and rollback gates in the
[go-live checklist](docs/go-live-checklist.md). Worker observability is enabled for
explicit structured events while automatic invocation logs are disabled. Review
zone, WAF, Logpush, analytics, support, and every downstream log source separately;
OAuth callbacks contain short-lived authorization codes and state in the query
string.

## Development checks

```bash
pnpm run check
pnpm run build
pnpm test
pnpm run deploy:dry-run
```

The tests cover configuration boundaries, RFC 7636 PKCE, one-time/session-bound OAuth state, duplicate callback rejection, client-secret and private-key token authentication, OIDC verification, concurrent refresh, encrypted token and raw-FHIR storage, hub consent/backfill/retention/deletion, normalized projections and deterministic source-cited summaries for all 22 supported resource types, patient-constrained FHIR calls, security headers, and a complete mocked authorization flow.

GitHub Actions runs frozen dependency installation, type-check, tests, build,
Wrangler dry-run, production dependency audit, and CodeQL; Dependabot tracks npm
and Actions updates. It does not deploy production. Branch protection, release
approval, license/secret/provenance policy, and atomic Cloudflare production deployment remain
operator gates described in the production runbook.

## Official references

- [Epic OAuth 2.0 tutorial and developer guidance](https://fhir.epic.com/Documentation?docId=fhir)
- [Epic patient-facing FHIR apps](https://fhir.epic.com/Documentation?docId=patientfacingfhirapps)
- [Epic patient authentication guidance](https://open.epic.com/Tutorial/PatientAuthentication)
- [FTC guidance for consumer health information](https://www.ftc.gov/business-guidance/resources/collecting-using-or-sharing-consumer-health-information-look-hipaa-ftc-act-health-breach)
- [HHS resources for health-app developers](https://www.hhs.gov/hipaa/for-professionals/special-topics/health-apps/index.html)
- [Epic production endpoint directory](https://open.epic.com/MyApps/Endpoints)
- [SMART App Launch 2.2](https://hl7.org/fhir/smart-app-launch/STU2.2/app-launch.html)
- [SMART scopes and launch context](https://hl7.org/fhir/smart-app-launch/STU2.2/scopes-and-launch-context.html)
- [Cloudflare Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
