# Private FHIR hub architecture and operating boundary

This document describes the optional persistent health-data hub implemented by
this connector. It is an engineering control description, not a representation
that a deployment is HIPAA compliant. HIPAA applicability and compliance depend
on the operator's role, agreements, risk analysis, policies, workforce,
configuration, vendors, and ongoing operations.

The current implementation is a provider-scoped MyChart account vault. A true
multi-provider Moonba health hub still needs a separately authenticated Moonba
account and an approved patient/linking workflow. It must not merge people using
name, date of birth, address, phone number, or an MRN.

## Data flow

```text
Epic/MyChart authorization server
          |
          | SMART authorization code + PKCE; TLS
          v
Connector token boundary ----> separate encrypted token store
          |
          | allowlisted, patient-authorized FHIR request; TLS
          v
Validated parsed FHIR JSON
          |
          +---- hub is off/current consent absent ----> browser only; no hub write
          |
          +---- current hub consent present
                    |
                    v
          immutable raw-resource version vault
          (source + patient + type + id + content hash)
                    |
                    +----> normalized projection for each supported resource
                    |
                    +----> source-cited deterministic insight
                    |
                    +----> authenticated raw/intelligence/export/delete APIs
```

The saved `raw` value is the validated JSON representation returned by the FHIR
client. It preserves unknown properties and extensions, but it is not the exact
HTTP response byte stream. Bundles are split and each `entry.resource` is stored
individually; `OperationOutcome` entries are not treated as clinical records.

The normalized intelligence registry covers these 22 R4 resource types:
`AllergyIntolerance`, `Binary`, `CarePlan`, `CareTeam`, `Condition`, `Device`,
`DiagnosticReport`, `DocumentReference`, `Encounter`, `Goal`, `Immunization`,
`Location`, `Medication`, `MedicationRequest`, `Observation`, `Organization`,
`Patient`, `Practitioner`, `PractitionerRole`, `Procedure`, `Provenance`, and
`RelatedPerson`.

## Implemented controls

| Boundary | Implemented behavior |
| --- | --- |
| Request | SMART standalone authorization code flow, S256 PKCE, exact callback, state/nonce checks, trusted Epic origins, allowlisted resource types, granted-scope and server-capability enforcement, and patient-constrained searches. |
| Transfer | HTTPS is required outside loopback development. Bearer credentials stay server-side. Responses use `no-store`; logs and audit records exclude URLs, FHIR bodies, direct FHIR identifiers, cookies, and tokens. |
| Consent | Connecting MyChart does not enable storage. The user must separately accept the exact `FHIR_HUB_CONSENT_VERSION`. A changed policy stops new ingestion until the new notice is accepted. Deploying code alone does not backfill historical raw resources; accepting the exact current notice authorizes normalization of still-retained versions. |
| Identity | HMAC-SHA-256 derives opaque account, source, and patient references with domain separation and a dedicated `FHIR_HUB_IDENTITY_KEY`. The key is separate from session, token, and data-encryption keys. |
| Raw versions | Canonical JSON is SHA-256 hashed. A new content hash creates an immutable source version; repeated identical data updates only the last-seen/retention metadata. Current-resource pointers are separate from history and prefer FHIR `meta.lastUpdated`, so a late older response is retained without rolling back the current view. |
| Normalized projections | Each supported R4 resource is mapped to bounded typed facts with source paths, an explicit headline, warnings where needed, and exact provenance. The projection does not replace or mutate raw JSON. Unsupported types, invalid shapes, a non-empty unknown `modifierExtension`, or any `implicitRules` value produce a bounded failure result; failure never drops the raw resource. The earlier detailed CareTeam projection remains on raw-resource and export views for compatibility. |
| Insights | Every successfully normalized resource receives a bounded deterministic rules summary with an explicit omission marker when necessary. Binary payload data is not decoded or interpreted. Every insight cites the exact account, patient, source, resource ID, version metadata, retrieval time, and content hash used. Prior summaries are marked superseded when the source changes. No external AI/model service is called. |
| At-rest protection | Node uses a separate AES-256-GCM encrypted file, authenticated with hub-specific AAD, an exclusive process lock, `0700` directories, `0600` files, and atomic replacement. Worker uses a separate account-scoped Durable Object and application-layer encryption key. Worker ciphertext is written as authenticated generations of at most 512 KiB chunks; a small manifest switches generations only after every new chunk exists. The manifest exposes only generation mechanics and the vault's earliest cleanup deadline, not FHIR identifiers or content. |
| Access | Hub APIs require a valid live MyChart connection, the signed HTTP-only session cookie, and the current opaque connection context. Mutations additionally require the configured same origin. The browser cannot choose account or patient identifiers. |
| Retention/deletion | Each version has an enforced expiry based on the consent receipt. The Worker stores the earliest version-expiry deadline outside ciphertext so its alarm can physically erase an unreadable whole-account shard without retaining any version past its approved boundary; a verified account can also delete that shard immediately, although an exact resource count is then unavailable. Disconnect revokes/removes the connection but retains the hub. Permanent hub deletion is a separate operation requiring `DELETE MY HEALTH HUB`; it removes raw versions, projections, and insights but does not change the source EHR. |

## Configuration

The hub is off by default. Node deployments use:

```dotenv
FHIR_HUB_ENABLED=true
FHIR_HUB_STORE_FILE=.data/fhir-hub.enc
FHIR_HUB_ENCRYPTION_KEY=<base64 of 32 random bytes>
FHIR_HUB_IDENTITY_KEY=<different base64 value of 32 random bytes>
FHIR_HUB_CONSENT_VERSION=2026-08-26
FHIR_HUB_RETENTION_DAYS=365
```

The example consent version represents the exact notice that covers normalized
intelligence across all 22 resource types. Do not reuse an earlier version for an
expanded purpose. After an approved version change, existing receipts become
stale: ingestion and historical backfill remain stopped until the user explicitly
accepts that exact version. Acceptance normalizes still-retained raw versions and
creates their source-cited summaries; it does not recover expired data or authorize
new FHIR scopes.

The configuration loader rejects missing keys, reused hub encryption/identity
keys, reuse of a configured token-store key, and reuse of the token-store path.
Back up data only together with the matching key under the approved recovery
policy. Never put keys in the repository, logs, build output, browser, or FHIR
payload store.

The encrypted Node file is a single-process storage adapter with an enforced
64 MiB serialized-plaintext limit, suitable for local or deliberately bounded
deployments. It is not a substitute for a production
database with tested backup, restore, key rotation, availability, access review,
and audit evidence. A lost encryption or identity key can make stored data
unrecoverable or unlinkable. Key rotation requires an explicit migration; do not
replace a key under live data.

The Worker adapter deliberately caps one account's serialized plaintext vault at
16 MiB and rejects a larger write without replacing the last readable generation.
Its plaintext manifest metadata remains operationally sensitive even though it
contains no FHIR identifiers or content; restrict storage inspection and include
that metadata in the approved retention and deletion procedures. The cleanup
deadline is intentionally the earliest raw-version expiry. If a shard is
unreadable, the implementation deletes the entire shard at that point rather
than retain an earlier-expiring resource beyond its approved boundary.
That bound and the current whole-account rewrite model fit this provider-scoped
vault, not a large multi-provider longitudinal record. Before expanding the hub,
move immutable resource versions to a resource-granular encrypted store with
indexed current pointers, documented quotas, migration, backup/restore, and
deletion verification. The chunk size remains below Cloudflare's current
[2 MB SQLite row/value limit](https://developers.cloudflare.com/durable-objects/platform/limits/).

## Intelligence-layer rule

The raw vault is the source of truth. Normalized projections and insights are
rebuildable, versioned artifacts, never replacements for the source resource.
The three layers have different API surfaces:

- `GET /api/hub/resources` returns retained resource versions, including raw FHIR
  JSON and their normalization result.
- `GET /api/hub/intelligence` returns raw-free normalized projections and
  source-cited insights. It accepts optional `resourceType`, `includeHistory`,
  `includeSuperseded`, and `limit` parameters; `limit` is capped at 250.
- `GET /api/hub/export` returns the account-controlled archive containing raw
  versions, projections, provenance, and insights.

Normalization records only explicit source facts and retains their source paths.
It does not resolve references, infer missing diagnoses or identities, fetch
attachments, render narrative HTML, or decode Binary payloads. A projection or
summary can always be rebuilt from the exact cited raw version and rules version.
Every future rules engine or model integration must:

1. receive only the minimum approved fields and source versions;
2. run in an environment covered by the operator's security review and required
   contracts, including a BAA when the service creates, receives, maintains, or
   transmits ePHI on behalf of a regulated entity;
3. prohibit provider training, human review, and secondary use unless those uses
   are expressly authorized and legally approved;
4. return structured provenance, generator/model and prompt versions, timestamps,
   confidence where meaningful, and review state;
5. keep generated content visibly distinct from the medical record and support
   correction, dismissal, supersession, and deletion; and
6. never silently infer identity, diagnosis, care-team membership, or clinical
   advice from absent data.

No external AI/model API is called by the checked-in implementation. Introducing
one is a separate data flow and purpose change requiring security, privacy/legal,
contract, minimum-necessary, consent-version, retention, and incident-response
approval before any patient data is sent.

## Production gates that code cannot satisfy

Before any real PHI is retained, the operator must complete and document at
least the following:

- determine whether the operator is a covered entity, business associate, or a
  consumer health application outside HIPAA for each data flow;
- execute required BAAs with every cloud, monitoring, support, backup, model,
  and other subprocessor that creates, receives, maintains, or transmits ePHI;
- perform and maintain a HIPAA Security Rule risk analysis and risk-management
  plan covering confidentiality, integrity, availability, access control,
  authentication, audit controls, transmission security, backup, recovery,
  incident response, breach analysis, sanctions, training, and physical controls;
- approve minimum-necessary FHIR scopes, the retention schedule, proxy/guardian
  behavior, age/competency rules, secondary uses, export, correction, and deletion;
- provide a real Moonba authentication and recovery boundary before presenting
  this as a multi-provider user-owned hub;
- configure production HTTPS, secret management, least-privilege deployment and
  support access, durable privacy-safe audit delivery, alerts, tested recovery,
  vulnerability management, dependency patching, and periodic access reviews;
- verify the chosen Cloudflare products and plan are covered by the executed BAA
  and configure required jurisdiction/data-location and logging controls; and
- obtain legal/privacy/security approval of the Terms, Privacy Notice, incident
  notices, state consumer-health requirements, and operational procedures.

HHS states that the Security Rule requires administrative, physical, and
technical safeguards and calls out access control, audit controls, integrity,
authentication, and transmission security. HHS also states that using a cloud
provider for ePHI on behalf of a regulated entity requires an appropriate BAA;
encryption alone does not remove that requirement. See the official
[HHS Security Rule summary](https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html)
and [HHS cloud-computing guidance](https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html).

The request design follows the official [SMART App Launch 2.2 authorization
profile](https://hl7.org/fhir/smart-app-launch/STU2.2/app-launch.html), including
PKCE and minimum scopes. For hosted storage, review Cloudflare's current
[Durable Object data-security documentation](https://developers.cloudflare.com/durable-objects/reference/data-security/)
and [Durable Object data-location controls](https://developers.cloudflare.com/data-localization/how-to/durable-objects/)
against the actual contract and deployment rather than treating product
documentation as compliance evidence.
