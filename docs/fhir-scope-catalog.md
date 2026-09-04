# FHIR scope catalog and UI mapping

This connector's production scope policy contains **56 scope values** split
across two controls:

- 53 patient-level FHIR resource scopes covering 22 resource types in
  `EPIC_ALLOWED_RESOURCE_SCOPES`; and
- `openid`, `fhirUser`, and `launch/patient` in the standalone GET request
  configured by `EPIC_SCOPES`.

Epic adds resource grants from the app's configured Incoming APIs and reports the
actual result in the token response. The 53 resource values are therefore a
validation allowlist, not values serialized into the standalone authorize URL.

The optional FHIR hub has deterministic normalized adapters for the same 22
resource types. That does not widen Epic access: normalization occurs only after
an authorized resource is retrieved and the user separately accepts the exact
current `FHIR_HUB_CONSENT_VERSION`. An older hub receipt must not authorize a new
all-resource backfill.

“Scope value” is the precise term. The access token is the credential Epic
returns; its `scope` field reports the scope values Epic actually granted.

## Why 53 scopes do not become 53 dropdown rows

A scope describes a resource, an interaction, and sometimes an exact search
constraint. The UI describes patient actions. It therefore groups related scopes
instead of showing a security identifier as a separate row.

| Product/API surface | Resource coverage | Effective permission required |
|---|---|---|
| Patient profile | `Patient` | `patient/Patient.r`; Patient is deliberately separate from the generic resource dropdown. |
| Direct search-mode resource choices | Up to 18 types: `AllergyIntolerance`, `CarePlan`, `CareTeam`, `Condition`, `Device`, `DiagnosticReport`, `DocumentReference`, `Encounter`, `Goal`, `Immunization`, `Medication`, `MedicationRequest`, `Observation`, `Organization`, `Practitioner`, `PractitionerRole`, `Procedure`, and `RelatedPerson` | A matching effective `.s` grant plus server-advertised search support. |
| Care locations | `Location` resources referenced by `Encounter.location[].location` | Unrestricted `patient/Encounter.s` and `patient/Location.r` grants, server-advertised Encounter search with `patient`, and server-advertised Location read. `Location.s` is not used for this action. |
| Result/detail read API | An allowlisted resource instance addressed by FHIR ID | A matching effective `.r` grant, server-advertised read support, matching response type/ID, and local enforcement of any fine-grained scope constraint. |
| Binary attachment API | `Binary` | Generic search and direct instance read are blocked even though the catalog contains Binary grants. A future attachment workflow must issue a session-bound, expiring capability from an authorized `DocumentReference`; it must not expose a free-form Binary ID control. |
| Record source/history access | `Provenance` | `patient/Provenance.r` plus server-advertised read support. The explicit dropdown choice directly reads a known Provenance FHIR ID; no `.s` scope is requested. Separately, every eligible direct resource search automatically adds the fixed `_revinclude=Provenance:target` value when that source resource advertises it. Included Provenance is correlated to a primary result and shown in Advanced. |

The current UI intersects all of these inputs before enabling an action:

1. resource type is in `EPIC_ALLOWED_RESOURCE_TYPES`;
2. Epic returned a compatible granted scope;
3. the provider CapabilityStatement advertises the interaction and required
   search parameters; and
4. the connector has a patient-safe search/read strategy.

The result can only reduce the UI from its configured maximum. A resource name in
the allowlist or an Incoming API on the Epic app record is not, by itself, proof
that the current patient grant permits the action.

## Read, search, and constrained choices

- `.r` means instance **read**.
- `.s` means **search**.
- A `?category=...` suffix narrows that read/search grant to the exact category.
  It is not equivalent to an unrestricted grant.

The UI presents qualified grants as patient-friendly choices while submitting the
exact authorized constraint:

| Resource | Friendly search choices | Exact catalog coverage |
|---|---|---|
| `CarePlan` | Longitudinal (`38717003`), Encounter-level (`734163000`), Outpatient (`736271009`), Dental (`738906000`), or Assessment and plan (`assess-plan`, not source-specific) | The unrestricted `patient/CarePlan.s` grant authorizes search, but Epic still requires exactly one of these `category` values on every request. The UI makes that native API requirement explicit and the connector rejects missing, repeated, or unknown values before contacting Epic. `assess-plan` describes content, not provenance, so the UI identifies an individual result as an outside record only when Epic supplies the documented external-data source tag. |
| `Condition` | All permitted conditions when unrestricted search is granted; otherwise an authorized category selector for Health concerns and/or Problem list | Unrestricted `.s`, health-concern `.s?category=...`, and problem-list-item `.s?category=...` are distinct grants. Read has the same three variants. |
| `DocumentReference` | All permitted documents when unrestricted search is granted; otherwise the Clinical notes constraint | Unrestricted `.s` and clinical-note `.s?category=...` are distinct grants. Read has the same two variants. |
| `Observation` | An authorized selector containing Laboratory results, Social history, and/or Vital signs | Only the three category-qualified search/read grants are approved; there is no unrestricted Observation scope in this catalog. |

If an effective unrestricted search grant exists, it safely subsumes the
resource's qualified search grants, so no *scope-derived* category is required.
CarePlan remains the exception because `category` is a native Epic API requirement
independent of SMART scope qualification. If Epic returns only qualified grants,
the UI must not offer an unrestricted choice. Pagination preserves the selected
constraint in an AES-256-GCM
encrypted/authenticated, session-bound cursor so later pages cannot widen the
search.

The CarePlan tokens above follow Epic's published R4 search specifications for
[Longitudinal](https://fhir.epic.com/Specifications?api=1065),
[Encounter](https://fhir.epic.com/Specifications?api=1067),
[Outpatient](https://fhir.epic.com/Specifications?api=10046),
[Dental](https://fhir.epic.com/Specifications?api=10017), and
[Outside Record](https://fhir.epic.com/Specifications?api=11457). A connected
organization must also enable the matching Incoming API; the merged
CapabilityStatement does not identify which category-specific implementation is
configured. Epic uses `assess-plan` as the ordinary US Core Assessment and Plan
content category on longitudinal and encounter-level records as well as in its
Outside Record request example. The category therefore cannot establish source.
An actual Epic Outside Record is identified by a `CarePlan.meta.tag` Coding with
system `https://open.epic.com/FHIR/bulk-data-source` and code
`external-bulk-data`; without that exact system/code pair, the connector does not
describe the result as an outside record.

## Exact 53 FHIR resource scopes

The checked-in canonical source is `EPIC_PATIENT_RESOURCE_SCOPES` in
`src/smart-scopes.ts`. Each line below is one scope value; brackets and Markdown
links are not part of the value.

```text
patient/AllergyIntolerance.r
patient/AllergyIntolerance.s
patient/Binary.r
patient/Binary.s
patient/CarePlan.r
patient/CarePlan.s
patient/CareTeam.r
patient/CareTeam.s
patient/Condition.r
patient/Condition.r?category=http://hl7.org/fhir/us/core/CodeSystem/condition-category|health-concern
patient/Condition.r?category=http://terminology.hl7.org/CodeSystem/condition-category|problem-list-item
patient/Condition.s
patient/Condition.s?category=http://hl7.org/fhir/us/core/CodeSystem/condition-category|health-concern
patient/Condition.s?category=http://terminology.hl7.org/CodeSystem/condition-category|problem-list-item
patient/Device.r
patient/Device.s
patient/DiagnosticReport.r
patient/DiagnosticReport.s
patient/DocumentReference.r
patient/DocumentReference.r?category=http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category|clinical-note
patient/DocumentReference.s
patient/DocumentReference.s?category=http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category|clinical-note
patient/Encounter.r
patient/Encounter.s
patient/Goal.r
patient/Goal.s
patient/Immunization.r
patient/Immunization.s
patient/Location.r
patient/Location.s
patient/Medication.r
patient/Medication.s
patient/MedicationRequest.r
patient/MedicationRequest.s
patient/Observation.r?category=http://terminology.hl7.org/CodeSystem/observation-category|laboratory
patient/Observation.r?category=http://terminology.hl7.org/CodeSystem/observation-category|social-history
patient/Observation.r?category=http://terminology.hl7.org/CodeSystem/observation-category|vital-signs
patient/Observation.s?category=http://terminology.hl7.org/CodeSystem/observation-category|laboratory
patient/Observation.s?category=http://terminology.hl7.org/CodeSystem/observation-category|social-history
patient/Observation.s?category=http://terminology.hl7.org/CodeSystem/observation-category|vital-signs
patient/Organization.r
patient/Organization.s
patient/Patient.r
patient/Patient.s
patient/Practitioner.r
patient/Practitioner.s
patient/PractitionerRole.r
patient/PractitionerRole.s
patient/Procedure.r
patient/Procedure.s
patient/Provenance.r
patient/RelatedPerson.r
patient/RelatedPerson.s
```

Configure the short standalone authorization request as:

```text
openid
fhirUser
launch/patient
```

Order is not significant, but each value must be separated by whitespace. Keep
the exact 53 resource values above in `EPIC_ALLOWED_RESOURCE_SCOPES`; qualified
values must remain intact. Both checked-in defaults need release review when
overridden. Epic can still return a narrower resource grant.

## Epic app and release reconciliation

For every production Epic app/provider:

1. Map each of the 53 resource scope values to the exact Epic Incoming API and
   intended product action.
2. Confirm the 21 non-Patient resource types in the scope catalog match
   `EPIC_ALLOWED_RESOURCE_TYPES`, with Patient handled by its separate profile
   action. Document why `Patient.s` and `Binary.s` are approved even though the
   current UI does not expose them as generic searches.
3. Confirm every search-mode choice has its Search Incoming API, the known-ID
   Provenance choice and automatic Provenance reverse inclusion have the Provenance
   Read Incoming API, and every result/detail action has its Read Incoming API.
   Confirm each expected source search advertises `Provenance:target` in
   `searchRevInclude`. One interaction does not imply the other.
4. Complete authorization with an approved synthetic/test identity and inspect
   the literal scope string Epic returned.
5. Compare returned grants with the CapabilityStatement-derived interactions and
   the rendered UI. Missing capability or grant must hide/disable the action.
6. Repeat after an Epic app edit and propagation window; an existing grant does not
   automatically gain newly configured access.

Attach this reconciliation to the
[production go-live checklist](go-live-checklist.md). Do not paste an access token,
patient identifier, or real FHIR response into the evidence.
