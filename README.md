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
- Best-effort remote token revocation and immediate local disconnect
- A small browser UI and JSON API

MyChart is not one central API. Each healthcare organization has its own FHIR base URL and authorization server. The code is complete, but a real connection still requires an Epic-issued client ID, activation/distribution at the healthcare organization, and interactive patient consent. This application never receives or stores a MyChart username or password.

## 1. Register an Epic patient app

Create an app in [Epic on FHIR](https://fhir.epic.com/Developer/Apps) and configure it as follows:

1. Set the primary user type to **Patients**.
2. Select **Incoming API**, **Use OAuth 2.0**, and **R4**.
3. Register the exact callback for the environment you will run:

   ```text
   http://localhost:3000/auth/callback
   ```

   For Cloudflare, use the final Worker or custom-domain URL instead, for example
   `https://epic-smart-on-fhir.<your-subdomain>.workers.dev/auth/callback`.

4. Select only the FHIR APIs the application needs. Start with `Patient.Read (R4)` and `RelatedPerson.Read (R4)` for patient/proxy identity, then add the specific read/search APIs you intend to call. The local explorer's default resource allowlist is in `.env.example`.
5. For the easiest local confidential-client setup, generate a sandbox client secret and choose `client_secret_basic`. Epic recommends `private_key_jwt` for production deployments.
6. Enable **Requires Persistent Access** only if the application genuinely needs access beyond the initial token lifetime.
7. Save the non-production client ID. Epic notes that sandbox app changes can take up to one hour to synchronize.

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
EPIC_CLIENT_ID=your-non-production-client-id
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

## 3. Verify discovery and run

```bash
pnpm run check:epic
pnpm run dev
```

Open [http://localhost:3000](http://localhost:3000), choose **Connect MyChart**, and complete sign-in and authorization only on the Epic/MyChart page.

The discovery check is read-only. It confirms the configured SMART authorization/token endpoints, PKCE support, supported client authentication methods, and OpenID issuer/JWKS location without accessing a patient account.

The connector intentionally targets current R4 SMART/OIDC discovery. A healthcare organization that exposes only legacy Epic metadata endpoints will need an organization-specific compatibility adapter rather than a silent fallback.

## 4. Deploy to Cloudflare Workers

The repository includes a native Worker entry point, Wrangler configuration, and a
SQLite-backed Durable Object. Static pages and health checks are served at the Worker
edge; each signed browser session is routed to its own Durable Object so OAuth state,
token refresh locking, and disconnects remain strongly ordered without making one
global object a traffic bottleneck. Pending authorization records and connection
records are encrypted with AES-256-GCM before they are written to Durable Object
storage.

In the Cloudflare Git setup screen use:

```text
Root directory:  leave blank
Build command:   pnpm run build
Deploy command:  pnpm run deploy
Non-production branch deploy command:  pnpm exec wrangler versions upload
```

Under **Settings → Build → Build Variables and Secrets**, set
`PNPM_VERSION=11.22.0` so Workers Builds uses the pnpm version pinned in
`package.json` rather than the build image's default version.

The GitHub repository itself is the project root; do not set the root directory to
`epic`. Wrangler bundles `src/worker.ts` and provisions the SQLite Durable Object on
the first deploy.

After the initial deploy, open **Workers & Pages → epic-smart-on-fhir → Settings →
Variables & Secrets**. These must be runtime values, not Workers Builds variables.
The first deployment only provisions the Worker and Durable Object; application
requests will fail configuration validation until these values are added and the
settings version is deployed.

Add these as ordinary variables:

```dotenv
APP_LEGAL_NAME=replace-with-your-legal-entity-name
APP_LEGAL_CONTACT_EMAIL=privacy-contact@example.invalid
APP_LEGAL_EFFECTIVE_DATE=2026-08-23
APP_HOSTING_PROVIDER_NAME=Cloudflare
EPIC_CLIENT_ID=your-non-production-client-id
EPIC_TOKEN_AUTH_METHOD=client_secret_basic
EPIC_FHIR_BASE_URL=https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4
EPIC_PROVIDER_NAME=Epic R4 Sandbox
EPIC_REDIRECT_URI=https://your-final-worker-host/auth/callback
EPIC_SCOPES=openid fhirUser launch/patient
EPIC_REQUEST_OFFLINE_ACCESS=false
EPIC_ALLOWED_RESOURCE_TYPES=AllergyIntolerance,Condition,DiagnosticReport,DocumentReference,Encounter,Immunization,MedicationRequest,Observation,Procedure
```

For Epic patient-facing apps, Epic derives the granted FHIR resource scopes from the
Incoming APIs on the app record in addition to the scopes in the authorize request.
The connector saves and displays the literal scopes returned with the access token;
those returned scopes, rather than the app page or `EPIC_SCOPES` alone, describe the
current grant.

Add these as encrypted secrets:

```text
EPIC_CLIENT_SECRET
SESSION_SECRET
TOKEN_ENCRYPTION_KEY
```

Generate the two application secrets separately:

```bash
openssl rand -base64 48  # SESSION_SECRET
openssl rand -base64 32  # TOKEN_ENCRYPTION_KEY
```

Register the exact `EPIC_REDIRECT_URI` with Epic. A `workers.dev` hostname and a
custom domain are different OAuth callbacks, so choose the final hostname before
requesting production activation. The same deployment exposes the public legal URLs:

```text
https://your-final-worker-host/terms
https://your-final-worker-host/privacy
```

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
enabling **Connect MyChart**. This browser-side acknowledgment is not retained as a
consent record and must not be represented as evidence of consent; add authenticated,
server-enforced consent/version records if the production product requires them.

The checked-in language describes this connector's current technical behavior, but
it is a launch template rather than legal approval. Before using real patient data,
have qualified counsel review the operator identity and contact method, age/proxy
rules, applicable consumer-health and breach-notification laws, HIPAA role (if any),
hosting agreements and log retention, deletion procedures, governing law, and any
warranty or liability language. Keep the notice synchronized with actual data flows;
policy text cannot substitute for product authentication, access controls, incident
response, or rate limiting.

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

Local sessions and their encrypted records expire after 30 days. The service checks at startup and hourly, attempts remote revocation for expired records, and deletes them locally. Reauthorize to continue after that boundary.

Each durable grant is bound to the Epic client ID and FHIR base URL that created it. Disconnect or run `tokens:purge` with the old configuration before changing providers or client registrations. If configuration is changed first, the connector refuses to send the new client credentials to the old provider, deletes the incompatible grant locally, and requires manual removal of the old app in MyChart.

### Cloudflare Worker

The Worker does not use `TOKEN_STORAGE` or `TOKEN_STORE_FILE`. It always uses a
per-session SQLite-backed Durable Object, and it requires `TOKEN_ENCRYPTION_KEY` as a
runtime secret. Session identifiers are hashed before indexing; OAuth state, PKCE
verifiers, nonces, patient identifiers, and OAuth tokens are stored only in encrypted
payloads. An hourly Durable Object alarm expires old sessions and attempts the same
best-effort remote revocation as the Node server. Pending OAuth state is checked after
10 minutes, and idle objects remove their alarms instead of waking indefinitely.

`pnpm run tokens:purge` only operates on the local encrypted file. Before rotating a
Worker encryption key, rotating `SESSION_SECRET`, or deleting Durable Object data,
disconnect active grants or revoke the application in MyChart. Losing the old
encryption/signing key makes existing records or their browser sessions intentionally
unreadable; the expiry alarm remains the fallback cleanup path.

## Local JSON API

Stateful FHIR routes require the signed, HTTP-only browser session cookie. Public UI,
health, and disconnected-status routes do not. Tokens are never returned to the
browser.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/terms` | Public Terms and Conditions shown before authorization |
| `GET` | `/privacy` | Public Privacy Notice describing health-data handling |
| `GET` | `/healthz` | Process health |
| `POST` | `/auth/start` | Begin standalone SMART authorization |
| `GET` | `/auth/callback` | Exact registered OAuth callback |
| `GET` | `/api/connection` | Safe connection metadata, never tokens |
| `GET` | `/api/patient` | Read the authorized Patient resource |
| `GET` | `/api/fhir/:resourceType` | Search an allowlisted resource, forcing the authorized patient ID |
| `POST` | `/api/disconnect` | Revoke when supported, then delete local tokens |

Search forwarding is intentionally narrow. Supported parameters are `_count`, `_sort`, `authoredon`, `category`, `class`, `clinical-status`, `code`, `date`, `docstatus`, `status`, and `type`. The caller cannot override the patient constraint, request `_include`, perform generic direct reads, or access resource types outside `EPIC_ALLOWED_RESOURCE_TYPES`.

The generic proxy exposes the first FHIR Bundle page only. Add carefully validated same-FHIR-base pagination in an application-specific layer if needed; never send the bearer token to arbitrary Bundle links or FHIR references.

## Troubleshooting Epic 403 responses

The resource dropdown performs FHIR **search** interactions. Each listed resource
therefore needs its matching `*.Search ... (R4)` Incoming API; adding only its `Read`
API is not sufficient. The separate **Load patient** action needs `Patient.Read (R4)`.

After adding or changing Incoming APIs:

1. Save the Epic app and mark it ready for the Sandbox when applicable.
2. Allow up to one hour for the Developer Sandbox to synchronize. Customer-hosted
   environments can take up to 12 hours and may require the customer to download or
   update the client record.
3. Expand **Access granted by Epic** in the explorer, or request
   `GET /api/connection`, and inspect the current token's returned scopes.
4. Disconnect the existing connection after the sync window, remove the app under
   MyChart's linked apps/devices if it remains there, and authorize it again. Refreshing
   an old grant cannot add permissions.
5. Confirm the deployed `EPIC_CLIENT_ID` is the non-production ID for the exact app
   record edited, the primary user type is **Patients**, and the configured FHIR base
   is the same R4 resource server used for authorization.

The explorer reports `fhir_scope_denied` only when Epic returns an OAuth
`insufficient_scope` challenge. Other Epic 403 responses use `fhir_access_denied` and
can reflect patient/user security, context, client distribution, or an unsynchronized
app record rather than a missing Incoming API.

## Disconnect and MyChart revocation

The connector uses a discovered OAuth revocation endpoint when one exists and always deletes local tokens. Epic's sandbox currently does not advertise a revocation endpoint. If remote revocation is unavailable or fails, remove the app manually in MyChart under the linked apps/devices management screen.

Disconnecting this application does not sign the patient out of MyChart.

## Security and deployment boundary

The Node service is safe by default for a single-user local loopback setup:

- It binds to `127.0.0.1`.
- It accepts only the configured FHIR issuer; users cannot submit arbitrary network destinations.
- Discovery and API fetches reject redirects, use timeouts and response-size limits, and require HTTPS endpoints.
- OAuth callback parameters are checked for duplicates, state is consumed atomically, and the authorization code is removed from browser history with an immediate redirect.
- ID tokens are verified for signature, issuer, audience, expiry, age, and nonce.
- Application logs are disabled so authorization codes, tokens, and PHI do not enter application logs.
- Responses use `no-store`, no-referrer, restrictive CSP, frame denial, and MIME hardening headers.

Do not expose the local Node service on a LAN or public interface. The Cloudflare
adapter adds HTTPS hosting, strongly ordered durable storage, encryption, and expiry,
but it does not by itself complete a regulated production security program. Before
using it with real patient data, add the product's authenticated user identity and
authorization policy, managed key rotation, PHI-safe audit controls, rate limiting,
provider-directory caching, environment-specific Epic credential mapping, and verify
that your Cloudflare plan and contract cover the required healthcare compliance
obligations. Keep Worker observability disabled unless URL/query redaction and log
retention have been deliberately configured; OAuth callbacks contain short-lived
authorization codes and state in the query string.

## Development checks

```bash
pnpm run check
pnpm run build
pnpm test
pnpm run deploy:dry-run
```

The tests cover configuration boundaries, RFC 7636 PKCE, one-time/session-bound OAuth state, duplicate callback rejection, client-secret and private-key token authentication, OIDC verification, concurrent refresh, encrypted storage, patient-constrained FHIR calls, security headers, and a complete mocked authorization flow.

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
