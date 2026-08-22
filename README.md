# Epic MyChart SMART-on-FHIR connector

This folder contains a standalone, read-only TypeScript service for connecting a patient-authorized MyChart account to Epic's R4 FHIR API.

The connector implements:

- SMART-on-FHIR standalone authorization-code launch
- SMART and OpenID endpoint discovery
- PKCE S256, high-entropy one-time `state`, and OIDC `nonce`
- Server-side code exchange and signed ID-token validation
- Epic `client_secret_basic`, `private_key_jwt`, and public-client token authentication
- Automatic refresh-token use with concurrent-refresh locking
- Memory-only tokens by default, with optional AES-256-GCM encrypted persistence
- Read-only Patient access and an allowlisted, patient-constrained FHIR proxy
- Best-effort remote token revocation and immediate local disconnect
- A small browser UI and JSON API

MyChart is not one central API. Each healthcare organization has its own FHIR base URL and authorization server. The code is complete, but a real connection still requires an Epic-issued client ID, activation/distribution at the healthcare organization, and interactive patient consent. This application never receives or stores a MyChart username or password.

## 1. Register an Epic patient app

Create an app in [Epic on FHIR](https://fhir.epic.com/Developer/Apps) and configure it as follows:

1. Set the primary user type to **Patients**.
2. Select **Incoming API**, **Use OAuth 2.0**, and **R4**.
3. Register this exact non-production callback:

   ```text
   http://localhost:3000/auth/callback
   ```

4. Select only the FHIR APIs the application needs. Start with `Patient.Read (R4)` and `RelatedPerson.Read (R4)` for patient/proxy identity, then add the specific read/search APIs you intend to call. The local explorer's default resource allowlist is in `.env.example`.
5. For the easiest local confidential-client setup, generate a sandbox client secret and choose `client_secret_basic`. Epic recommends `private_key_jwt` for production deployments.
6. Enable **Requires Persistent Access** only if the application genuinely needs access beyond the initial token lifetime.
7. Save the non-production client ID. Epic notes that sandbox app changes can take roughly 30 minutes to synchronize.

Use only Epic's synthetic [sandbox test patients](https://fhir.epic.com/Documentation?docId=testpatients) against the sandbox. A real MyChart account cannot be connected to the sandbox.

## 2. Configure the connector

Node.js 20.19 or newer is required.

```bash
cd epic
npm install
cp .env.example .env
```

Edit `.env` and set at least:

```dotenv
EPIC_CLIENT_ID=your-non-production-client-id
EPIC_CLIENT_SECRET=your-sandbox-client-secret
EPIC_TOKEN_AUTH_METHOD=client_secret_basic
SESSION_SECRET=a-long-random-value
```

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
npm run check:epic
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), choose **Connect MyChart**, and complete sign-in and authorization only on the Epic/MyChart page.

The discovery check is read-only. It confirms the configured SMART authorization/token endpoints, PKCE support, supported client authentication methods, and OpenID issuer/JWKS location without accessing a patient account.

The connector intentionally targets current R4 SMART/OIDC discovery. A healthcare organization that exposes only legacy Epic metadata endpoints will need an organization-specific compatibility adapter rather than a silent fallback.

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
npm run keys:generate
```

Host `.secrets/public.jwks.json` at a stable public HTTPS URL and register that JWK Set URL on the Epic app/installation. Then set the `EPIC_PRIVATE_KEY_*` values printed by the command and use:

```dotenv
EPIC_TOKEN_AUTH_METHOD=private_key_jwt
```

The private key stays in `.secrets/`, which is ignored. `keys:generate` refuses to overwrite existing keys unless `--force` is explicitly passed to the script; key rotation must also be coordinated with Epic.

### Public client

`EPIC_TOKEN_AUTH_METHOD=none` is supported for an app registered as non-confidential. It still uses PKCE, but it cannot provide ordinary persistent refresh-token access. Do not hide a shared "secret" in a distributed desktop/browser client and treat it as confidential.

## Token storage

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
npm run tokens:purge
```

Stop the connector before running this command. An exclusive lock prevents the server and purge command from opening the same encrypted store concurrently. The command attempts remote revocation when Epic advertises it, deletes every local encrypted record regardless, and reports when manual revocation in MyChart is still recommended.

If the process is killed without a graceful shutdown, the adjacent `.lock` file is deliberately not removed automatically. First verify that no connector or purge process is running, then remove only that exact `.lock` file and restart. This fail-closed recovery avoids two concurrent processes both deciding that a lock is stale.

Local sessions and their encrypted records expire after 30 days. The service checks at startup and hourly, attempts remote revocation for expired records, and deletes them locally. Reauthorize to continue after that boundary.

Each durable grant is bound to the Epic client ID and FHIR base URL that created it. Disconnect or run `tokens:purge` with the old configuration before changing providers or client registrations. If configuration is changed first, the connector refuses to send the new client credentials to the old provider, deletes the incompatible grant locally, and requires manual removal of the old app in MyChart.

## Local JSON API

All routes require the signed, HTTP-only browser session cookie. Tokens are never returned to the browser.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/healthz` | Process health |
| `POST` | `/auth/start` | Begin standalone SMART authorization |
| `GET` | `/auth/callback` | Exact registered OAuth callback |
| `GET` | `/api/connection` | Safe connection metadata, never tokens |
| `GET` | `/api/patient` | Read the authorized Patient resource |
| `GET` | `/api/fhir/:resourceType` | Search an allowlisted resource, forcing the authorized patient ID |
| `POST` | `/api/disconnect` | Revoke when supported, then delete local tokens |

Search forwarding is intentionally narrow. Supported parameters are `_count`, `_sort`, `authoredon`, `category`, `class`, `clinical-status`, `code`, `date`, `docstatus`, `status`, and `type`. The caller cannot override the patient constraint, request `_include`, perform generic direct reads, or access resource types outside `EPIC_ALLOWED_RESOURCE_TYPES`.

The generic proxy exposes the first FHIR Bundle page only. Add carefully validated same-FHIR-base pagination in an application-specific layer if needed; never send the bearer token to arbitrary Bundle links or FHIR references.

## Disconnect and MyChart revocation

The connector uses a discovered OAuth revocation endpoint when one exists and always deletes local tokens. Epic's sandbox currently does not advertise a revocation endpoint. If remote revocation is unavailable or fails, remove the app manually in MyChart under the linked apps/devices management screen.

Disconnecting this application does not sign the patient out of MyChart.

## Security and deployment boundary

This service is safe by default for a single-user local loopback setup:

- It binds to `127.0.0.1`.
- It accepts only the configured FHIR issuer; users cannot submit arbitrary network destinations.
- Discovery and API fetches reject redirects, use timeouts and response-size limits, and require HTTPS endpoints.
- OAuth callback parameters are checked for duplicates, state is consumed atomically, and the authorization code is removed from browser history with an immediate redirect.
- ID tokens are verified for signature, issuer, audience, expiry, age, and nonce.
- Logs are disabled so authorization codes, tokens, and PHI do not enter access logs.
- Responses use `no-store`, no-referrer, restrictive CSP, frame denial, and MIME hardening headers.

Do not expose this local service on a LAN or public interface. Before a hosted or multi-user deployment, add the product's own authenticated user sessions, authorization policy, HTTPS termination, durable multi-user token storage, KMS-backed encryption/key rotation, audit controls that exclude PHI/tokens, provider-directory caching, and environment-specific Epic credential mapping.

## Development checks

```bash
npm run check
npm run build
npm test
```

The tests cover configuration boundaries, RFC 7636 PKCE, one-time/session-bound OAuth state, duplicate callback rejection, client-secret and private-key token authentication, OIDC verification, concurrent refresh, encrypted storage, patient-constrained FHIR calls, security headers, and a complete mocked authorization flow.

## Official references

- [Epic OAuth 2.0 tutorial and developer guidance](https://fhir.epic.com/Documentation?docId=fhir)
- [Epic patient-facing FHIR apps](https://fhir.epic.com/Documentation?docId=patientfacingfhirapps)
- [Epic production endpoint directory](https://open.epic.com/MyApps/Endpoints)
- [SMART App Launch 2.2](https://hl7.org/fhir/smart-app-launch/STU2.2/app-launch.html)
- [SMART scopes and launch context](https://hl7.org/fhir/smart-app-launch/STU2.2/scopes-and-launch-context.html)
