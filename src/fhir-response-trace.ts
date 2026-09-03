export type FhirResponseTraceInteraction = "read" | "search";

const fhirResourceTypePattern = /^[A-Z][A-Za-z0-9]{0,63}$/;

const directReadTransforms = "json-parsed,validated";
const searchTransforms = "json-parsed,validated,bundle-links-rewritten";
const derivedLocationSearchTransforms =
  "json-parsed,validated,derived-from-encounter-references,bundle-generated";

/**
 * Returns bounded, non-sensitive metadata describing connector processing.
 * Values never contain request URLs, query strings, resource IDs, bodies, or tokens.
 */
export function fhirResponseTraceHeaders(
  resourceType: string,
  interaction: FhirResponseTraceInteraction,
): Readonly<Record<string, string>> {
  const safeResourceType = fhirResourceTypePattern.test(resourceType)
    ? resourceType
    : "Unknown";
  const derivedLocationSearch = interaction === "search" && safeResourceType === "Location";

  return {
    "X-Moonba-FHIR-Source": derivedLocationSearch ? "connector-derived" : "epic",
    "X-Moonba-FHIR-Interaction": interaction,
    "X-Moonba-FHIR-Resource-Type": safeResourceType,
    "X-Moonba-FHIR-Resource-Fields": "preserved",
    "X-Moonba-FHIR-Transforms": interaction === "read"
      ? directReadTransforms
      : derivedLocationSearch
        ? derivedLocationSearchTransforms
        : searchTransforms,
  };
}
