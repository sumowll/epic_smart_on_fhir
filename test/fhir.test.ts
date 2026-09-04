import { describe, expect, it, vi } from "vitest";

import { EPIC_CARE_PLAN_SEARCH_TYPES } from "../src/care-plan.js";
import { EpicFhirClient, EpicRateLimitError, sanitizeSearchParameters } from "../src/fhir.js";
import {
  assertGrantedSmartScopesWithinPolicy,
  assertGrantedSmartScopesWithinRequest,
  authorizeSmartSearch,
  EPIC_PATIENT_RESOURCE_SCOPES,
  EPIC_PRODUCTION_SCOPES,
  parseSmartScopes,
} from "../src/smart-scopes.js";
import type { ConnectionRecord, FetchLike } from "../src/types.js";
import { jsonResponse, makeConfig } from "./helpers.js";

const record: ConnectionRecord = {
  oauthClientId: "test-client-id",
  fhirBaseUrl: "https://ehr.example.test/api/FHIR/R4",
  tokenEndpoint: "https://ehr.example.test/token",
  accessToken: "access-token",
  tokenType: "Bearer",
  expiresAt: Date.now() + 60_000,
  scope: "patient/*.read",
  patientId: "patient-1",
  fhirCapabilities: [
    "AllergyIntolerance", "Binary", "CarePlan", "CareTeam", "Condition", "Device",
    "DiagnosticReport", "DocumentReference", "Encounter", "Goal", "Immunization",
    "Location", "Medication", "MedicationRequest", "Observation", "Organization",
    "Patient", "Practitioner", "PractitionerRole", "Procedure", "Provenance", "RelatedPerson",
  ].map((resourceType) => ({
    resourceType,
    interactions: ["read", "search"] as const,
    searchParameters: ["patient", "category", "_count"],
  })),
  connectedAt: Date.now(),
  sessionExpiresAt: Date.now() + 60_000,
};

const laboratoryCategory = "http://terminology.hl7.org/CodeSystem/observation-category|laboratory";
const socialHistoryCategory = "http://terminology.hl7.org/CodeSystem/observation-category|social-history";
const vitalSignsCategory = "http://terminology.hl7.org/CodeSystem/observation-category|vital-signs";
const healthConcernCategory = "http://hl7.org/fhir/us/core/CodeSystem/condition-category|health-concern";
const problemListCategory = "http://terminology.hl7.org/CodeSystem/condition-category|problem-list-item";
const clinicalNoteCategory = "http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category|clinical-note";
const provenanceReverseInclude = "Provenance:target";

const searchableResourceTypes = [
  "AllergyIntolerance",
  "CarePlan",
  "CareTeam",
  "Condition",
  "Device",
  "DiagnosticReport",
  "DocumentReference",
  "Encounter",
  "Goal",
  "Immunization",
  "Medication",
  "MedicationRequest",
  "Observation",
  "Organization",
  "Practitioner",
  "PractitionerRole",
  "Procedure",
  "RelatedPerson",
] as const;

function withProvenanceReverseInclude(
  resourceType: string,
  overrides: Partial<ConnectionRecord> = {},
): ConnectionRecord {
  return {
    ...record,
    scope: `patient/${resourceType}.s patient/Provenance.r`,
    fhirCapabilities: [{
      resourceType,
      interactions: ["search"],
      searchParameters: resourceType === "CarePlan"
        ? ["patient", "category"]
        : ["patient"],
      searchRevIncludes: [provenanceReverseInclude],
    }, {
      resourceType: "Provenance",
      interactions: ["read"],
      searchParameters: [],
      searchRevIncludes: [],
    }],
    ...overrides,
  };
}

const granted53Scopes = [
  "patient/AllergyIntolerance.r", "patient/AllergyIntolerance.s",
  "patient/Binary.r", "patient/Binary.s",
  "patient/CarePlan.r", "patient/CarePlan.s",
  "patient/CareTeam.r", "patient/CareTeam.s",
  "patient/Condition.r",
  `patient/Condition.r?category=${healthConcernCategory}`,
  `patient/Condition.r?category=${problemListCategory}`,
  "patient/Condition.s",
  `patient/Condition.s?category=${healthConcernCategory}`,
  `patient/Condition.s?category=${problemListCategory}`,
  "patient/Device.r", "patient/Device.s",
  "patient/DiagnosticReport.r", "patient/DiagnosticReport.s",
  "patient/DocumentReference.r",
  `patient/DocumentReference.r?category=${clinicalNoteCategory}`,
  "patient/DocumentReference.s",
  `patient/DocumentReference.s?category=${clinicalNoteCategory}`,
  "patient/Encounter.r", "patient/Encounter.s",
  "patient/Goal.r", "patient/Goal.s",
  "patient/Immunization.r", "patient/Immunization.s",
  "patient/Location.r", "patient/Location.s",
  "patient/Medication.r", "patient/Medication.s",
  "patient/MedicationRequest.r", "patient/MedicationRequest.s",
  `patient/Observation.r?category=${laboratoryCategory}`,
  `patient/Observation.r?category=${socialHistoryCategory}`,
  `patient/Observation.r?category=${vitalSignsCategory}`,
  `patient/Observation.s?category=${laboratoryCategory}`,
  `patient/Observation.s?category=${socialHistoryCategory}`,
  `patient/Observation.s?category=${vitalSignsCategory}`,
  "patient/Organization.r", "patient/Organization.s",
  "patient/Patient.r", "patient/Patient.s",
  "patient/Practitioner.r", "patient/Practitioner.s",
  "patient/PractitionerRole.r", "patient/PractitionerRole.s",
  "patient/Procedure.r", "patient/Procedure.s",
  "patient/Provenance.r",
  "patient/RelatedPerson.r", "patient/RelatedPerson.s",
].join(" ");

function withScope(scope: string): ConnectionRecord {
  return { ...record, scope };
}

function emptySearchBundle(): Record<string, unknown> {
  return { resourceType: "Bundle", type: "searchset", entry: [] };
}

describe("FHIR parameter controls", () => {
  it("allows bounded read-only filters and defaults _count", () => {
    expect(sanitizeSearchParameters(new URLSearchParams("category=laboratory"))).toEqual(
      new URLSearchParams("category=laboratory&_count=50"),
    );
  });

  it("rejects patient overrides, unknown filters, and oversized pages", () => {
    expect(() => sanitizeSearchParameters(new URLSearchParams("patient=someone-else"))).toThrow(/not allowed/);
    expect(() => sanitizeSearchParameters(new URLSearchParams("_include=Observation:subject"))).toThrow(/not allowed/);
    expect(() => sanitizeSearchParameters(new URLSearchParams("_revinclude=Provenance:target"))).toThrow(/not allowed/);
    expect(() => sanitizeSearchParameters(new URLSearchParams("_count=101"))).toThrow(/between 1 and 100/);
  });
});

describe("OAuth resource-scope downscoping", () => {
  it("accepts omitted-equivalent, narrowed, and combined read/search grants", () => {
    expect(() => assertGrantedSmartScopesWithinRequest(
      "patient/Patient.read",
      "patient/Patient.r patient/Patient.s openid launch/patient",
    )).not.toThrow();
    expect(() => assertGrantedSmartScopesWithinRequest(
      `patient/Observation.r?category=${laboratoryCategory}`,
      `patient/Observation.r?category=${laboratoryCategory} patient/Observation.s?category=${laboratoryCategory}`,
    )).not.toThrow();
    expect(() => assertGrantedSmartScopesWithinRequest(
      `patient/Observation.s?category=${laboratoryCategory}&status=final`,
      `patient/Observation.s?category=${laboratoryCategory}`,
    )).not.toThrow();
  });

  it.each([
    ["patient/*.rs", "patient/Patient.r patient/Patient.s"],
    ["user/Patient.r", "patient/Patient.r"],
    ["patient/Patient.c", "patient/Patient.r"],
    ["patient/Observation.s", `patient/Observation.s?category=${laboratoryCategory}`],
    [
      `patient/Observation.s?category=${socialHistoryCategory}`,
      `patient/Observation.s?category=${laboratoryCategory}`,
    ],
    ["patient/Patient.not-a-permission", "patient/Patient.r"],
    ["offline_access patient/Patient.r", "openid patient/Patient.r"],
  ])("rejects a broader or malformed issued grant: %s", (granted, requested) => {
    expect(() => assertGrantedSmartScopesWithinRequest(granted, requested)).toThrow(
      /outside this application's approved scope policy/,
    );
  });

  it("accepts Epic-added Incoming API scopes only within the separate resource policy", () => {
    expect(() => assertGrantedSmartScopesWithinPolicy(
      [
        "openid",
        "fhirUser",
        "launch/patient",
        "patient/Patient.read",
        `patient/Observation.s?category=${laboratoryCategory}&status=final`,
      ],
      ["openid", "fhirUser", "launch/patient"],
      [
        "patient/Patient.r",
        "patient/Patient.s",
        `patient/Observation.s?category=${laboratoryCategory}`,
      ],
    )).not.toThrow();
  });

  it.each([
    ["offline_access patient/Patient.r", ["patient/Patient.r"]],
    ["profile patient/Patient.r", ["patient/Patient.r"]],
    ["patient/Appointment.r", ["patient/Patient.r"]],
    ["patient/Patient.c", ["patient/Patient.r"]],
    ["user/Patient.r", ["patient/Patient.r"]],
    ["patient/*.r", ["patient/Patient.r"]],
    ["patient/Observation.s", [`patient/Observation.s?category=${laboratoryCategory}`]],
  ])("rejects an Epic grant outside the split scope policy: %s", (granted, allowed) => {
    expect(() => assertGrantedSmartScopesWithinPolicy(
      granted,
      ["openid", "fhirUser", "launch/patient"],
      allowed,
    )).toThrow(/oauth|approved scope policy/);
  });
});

describe("FHIR continuation pages", () => {
  it("follows only a same-base, same-resource continuation URL", async () => {
    const nextUrl = `${record.fhirBaseUrl}/Observation?_getpages=opaque&_count=20`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(input.toString()).toBe(nextUrl);
      return jsonResponse(emptySearchBundle());
    });
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);

    await expect(client.page(record, "Observation", nextUrl)).resolves.toEqual(emptySearchBundle());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects cross-origin and cross-resource continuation URLs before fetching", async () => {
    const fetchMock = vi.fn();
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);

    await expect(client.page(
      record,
      "Observation",
      "https://attacker.example/Observation?page=2",
    )).rejects.toMatchObject({ code: "invalid_page_cursor" });
    await expect(client.page(
      record,
      "Observation",
      `${record.fhirBaseUrl}/Condition?page=2`,
    )).rejects.toMatchObject({ code: "invalid_page_cursor" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a continuation URL that explicitly changes a constrained category", async () => {
    const fetchMock = vi.fn();
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);
    const nextUrl = new URL(`${record.fhirBaseUrl}/Observation`);
    nextUrl.searchParams.set("_getpages", "opaque");
    nextUrl.searchParams.set("category", vitalSignsCategory);

    await expect(client.page(
      withScope(`patient/Observation.s?category=${laboratoryCategory}`),
      "Observation",
      nextUrl.toString(),
    )).rejects.toMatchObject({ code: "fhir_scope_constraint_conflict" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves the selected CarePlan type across continuation pages", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(input.toString()).searchParams.get("category")).toBe("38717003");
      return jsonResponse(emptySearchBundle());
    });
    const client = new EpicFhirClient(makeConfig({
      EPIC_ALLOWED_RESOURCE_TYPES: "CarePlan",
    }), fetchMock as FetchLike);
    const nextUrl = new URL(`${record.fhirBaseUrl}/CarePlan`);
    nextUrl.searchParams.set("_getpages", "opaque");
    nextUrl.searchParams.set("category", "734163000");

    await expect(client.page(
      withScope("patient/CarePlan.s"),
      "CarePlan",
      nextUrl.toString(),
      [{ name: "category", value: "38717003" }],
    )).rejects.toMatchObject({ code: "invalid_page_cursor" });
    expect(fetchMock).not.toHaveBeenCalled();

    nextUrl.searchParams.set("category", "38717003");
    await expect(client.page(
      withScope("patient/CarePlan.s"),
      "CarePlan",
      nextUrl.toString(),
      [{ name: "category", value: "38717003" }],
    )).resolves.toEqual(emptySearchBundle());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a continuation URL that explicitly changes the patient compartment", async () => {
    const fetchMock = vi.fn();
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);
    const nextUrl = new URL(`${record.fhirBaseUrl}/Observation`);
    nextUrl.searchParams.set("_getpages", "opaque");
    nextUrl.searchParams.set("patient", "another-patient");

    await expect(client.page(
      withScope("patient/Observation.s"),
      "Observation",
      nextUrl.toString(),
    )).rejects.toMatchObject({ code: "invalid_page_cursor" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves a sealed Provenance reverse include across a safe continuation", async () => {
    const provenanceRecord = withProvenanceReverseInclude("Observation");
    const nextUrl = new URL(`${record.fhirBaseUrl}/Observation`);
    nextUrl.searchParams.set("_getpages", "opaque");
    nextUrl.searchParams.set("_revinclude", provenanceReverseInclude);
    const bundle = {
      resourceType: "Bundle",
      type: "searchset",
      entry: [{
        resource: { resourceType: "Provenance", id: "source-page-2", target: [{
          reference: "Observation/observation-page-2",
        }] },
        search: { mode: "include" },
      }, {
        resource: { resourceType: "Observation", id: "observation-page-2" },
        search: { mode: "match" },
      }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(input.toString()).toBe(nextUrl.toString());
      return jsonResponse(bundle);
    });
    const client = new EpicFhirClient(makeConfig({
      EPIC_ALLOWED_RESOURCE_TYPES: "Observation,Provenance",
    }), fetchMock as FetchLike);

    await expect(client.page(
      provenanceRecord,
      "Observation",
      nextUrl.toString(),
      [],
      true,
    )).resolves.toEqual(bundle);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects continuation reverse-include upgrades and a lost Provenance grant", async () => {
    const nextUrl = `${record.fhirBaseUrl}/Observation?_getpages=opaque&_revinclude=${encodeURIComponent(provenanceReverseInclude)}`;
    const fetchMock = vi.fn();
    const client = new EpicFhirClient(makeConfig({
      EPIC_ALLOWED_RESOURCE_TYPES: "Observation,Provenance",
    }), fetchMock as FetchLike);

    await expect(client.page(record, "Observation", nextUrl)).rejects.toMatchObject({
      code: "invalid_page_cursor",
    });
    await expect(client.page(
      withProvenanceReverseInclude("Observation", {
        scope: "patient/Observation.s",
      }),
      "Observation",
      nextUrl,
      [],
      true,
    )).rejects.toMatchObject({ code: "provenance_revinclude_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("SMART resource-scope policy", () => {
  it("normalizes all 53 granted values into the expected read/search matrix", () => {
    expect(EPIC_PATIENT_RESOURCE_SCOPES.join(" ")).toBe(granted53Scopes);
    expect(EPIC_PRODUCTION_SCOPES).toHaveLength(56);
    expect(granted53Scopes.split(/\s+/)).toHaveLength(53);
    const grants = parseSmartScopes(`${granted53Scopes} fhirUser launch/patient openid`);
    expect(grants).toHaveLength(27);
    expect(grants.filter((grant) => grant.permissions.has("read"))).toHaveLength(27);
    expect(grants.filter((grant) => grant.permissions.has("search"))).toHaveLength(26);

    const expectedResourceTypes = [
      "AllergyIntolerance", "Binary", "CarePlan", "CareTeam", "Condition", "Device",
      "DiagnosticReport", "DocumentReference", "Encounter", "Goal", "Immunization",
      "Location", "Medication", "MedicationRequest", "Observation", "Organization",
      "Patient", "Practitioner", "PractitionerRole", "Procedure", "Provenance", "RelatedPerson",
    ];
    for (const resourceType of expectedResourceTypes) {
      const resourceGrants = grants.filter((grant) => grant.resourceType === resourceType);
      expect(resourceGrants.some((grant) => grant.permissions.has("read")), resourceType).toBe(true);
      expect(
        resourceGrants.some((grant) => grant.permissions.has("search")),
        resourceType,
      ).toBe(resourceType !== "Provenance");
    }

    const observation = grants.filter((grant) => grant.resourceType === "Observation");
    expect(observation).toHaveLength(3);
    expect(observation.map((grant) => grant.constraints[0]?.value).sort()).toEqual([
      laboratoryCategory,
      socialHistoryCategory,
      vitalSignsCategory,
    ].sort());
    expect(observation.every((grant) =>
      grant.permissions.has("read") && grant.permissions.has("search"))).toBe(true);
  });

  it("unions equivalent v1/v2 grants while preserving distinct query restrictions", () => {
    const encodedCategory = encodeURIComponent(laboratoryCategory);
    const grants = parseSmartScopes([
      "patient/Observation.read",
      "patient/Observation.write",
      `patient/Observation.r?category=${encodedCategory}`,
      `patient/Observation.s?category=${encodedCategory}`,
      "openid malformed patient/Observation.s?category=%ZZ",
    ]);

    expect(grants).toHaveLength(2);
    const unrestricted = grants.find((grant) => grant.constraints.length === 0)!;
    expect([...unrestricted.permissions].sort()).toEqual([
      "create", "delete", "read", "search", "update",
    ]);
    const constrained = grants.find((grant) => grant.constraints.length > 0)!;
    expect([...constrained.permissions].sort()).toEqual(["read", "search"]);
    expect(constrained.constraints).toEqual([{ name: "category", value: laboratoryCategory }]);
  });

  it("parses the complete SMART v2 cruds permission alphabet", () => {
    const grants = parseSmartScopes(
      "patient/Observation.cruds patient/Condition.sr patient/Goal.dus",
    );
    expect(grants).toHaveLength(1);
    expect([...grants[0]!.permissions].sort()).toEqual([
      "create", "delete", "read", "search", "update",
    ]);
  });

  it("injects one required constraint and rejects ambiguous or conflicting alternatives", () => {
    const single = authorizeSmartSearch(
      `patient/Observation.s?category=${laboratoryCategory}`,
      "Observation",
      new URLSearchParams("_count=20&patient=patient-1"),
    );
    expect(single.get("category")).toBe(laboratoryCategory);

    expect(() => authorizeSmartSearch(
      granted53Scopes,
      "Observation",
      new URLSearchParams("_count=20&patient=patient-1"),
    )).toThrow(expect.objectContaining({ code: "fhir_scope_constraint_required" }));

    expect(() => authorizeSmartSearch(
      `patient/Observation.s?category=${laboratoryCategory}`,
      "Observation",
      new URLSearchParams(`category=${encodeURIComponent(vitalSignsCategory)}`),
    )).toThrow(expect.objectContaining({ code: "fhir_scope_constraint_conflict" }));
  });

  it("keeps SMART v2 read and search permissions distinct", () => {
    expect(() => authorizeSmartSearch(
      "patient/Observation.r",
      "Observation",
      new URLSearchParams(),
    )).toThrow(expect.objectContaining({ code: "fhir_scope_denied" }));
    expect(authorizeSmartSearch(
      "patient/Observation.s",
      "Observation",
      new URLSearchParams("_count=20"),
    ).get("_count")).toBe("20");
  });
});

describe("FHIR client", () => {
  it("injects the authorized patient and keeps the bearer token server-side", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      expect(url.origin + url.pathname).toBe("https://ehr.example.test/api/FHIR/R4/Observation");
      expect(url.searchParams.get("patient")).toBe("patient-1");
      expect(url.searchParams.get("_count")).toBe("20");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token");
      return jsonResponse(emptySearchBundle());
    });
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);
    await expect(client.search(record, "Observation", new URLSearchParams("_count=20"))).resolves.toEqual({
      resourceType: "Bundle",
      type: "searchset",
      entry: [],
    });
  });

  it.each(EPIC_CARE_PLAN_SEARCH_TYPES)(
    "searches $label CarePlans with Epic's required category",
    async ({ category }) => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(input.toString());
        expect(url.origin + url.pathname).toBe(
          "https://ehr.example.test/api/FHIR/R4/CarePlan",
        );
        expect(url.searchParams.get("patient")).toBe("patient-1");
        expect(url.searchParams.getAll("category")).toEqual([category]);
        expect(url.searchParams.get("_count")).toBe("20");
        return jsonResponse(emptySearchBundle());
      });
      const client = new EpicFhirClient(makeConfig({
        EPIC_ALLOWED_RESOURCE_TYPES: "CarePlan",
      }), fetchMock as FetchLike);

      const result = await client.searchWithContext(
        withScope("patient/CarePlan.s"),
        "CarePlan",
        new URLSearchParams({ category, _count: "20" }),
      );
      expect(result.bundle).toMatchObject({ resourceType: "Bundle", type: "searchset" });
      expect(result.constraints).toEqual([{ name: "category", value: category }]);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("rejects missing, unknown, or repeated CarePlan categories before contacting Epic", async () => {
    const fetchMock = vi.fn();
    const client = new EpicFhirClient(makeConfig({
      EPIC_ALLOWED_RESOURCE_TYPES: "CarePlan",
    }), fetchMock as FetchLike);
    const carePlanRecord = withScope("patient/CarePlan.s");

    await expect(client.search(
      carePlanRecord,
      "CarePlan",
      new URLSearchParams("_count=20"),
    )).rejects.toMatchObject({ code: "careplan_category_required" });
    await expect(client.search(
      withScope("patient/CarePlan.s?category=38717003"),
      "CarePlan",
      new URLSearchParams("_count=20"),
    )).rejects.toMatchObject({ code: "careplan_category_required" });
    await expect(client.search(
      carePlanRecord,
      "CarePlan",
      new URLSearchParams("_count=20&category=unknown"),
    )).rejects.toMatchObject({ code: "careplan_category_invalid" });
    await expect(client.search(
      carePlanRecord,
      "CarePlan",
      new URLSearchParams("_count=20&category=38717003&category=734163000"),
    )).rejects.toMatchObject({ code: "careplan_category_invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(searchableResourceTypes)(
    "automatically includes available Provenance for %s search",
    async (resourceType) => {
      const sourceId = `${resourceType.toLowerCase()}-1`;
      const bundle = {
        resourceType: "Bundle",
        type: "searchset",
        entry: [{
          resource: { resourceType: "Provenance", id: `source-${sourceId}`, target: [{
            reference: `${resourceType}/${sourceId}`,
          }] },
          search: { mode: "include" },
        }, {
          resource: { resourceType, id: sourceId },
          search: { mode: "match" },
        }],
      };
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(input.toString());
        expect(url.searchParams.getAll("_revinclude")).toEqual([provenanceReverseInclude]);
        return jsonResponse(bundle);
      });
      const client = new EpicFhirClient(makeConfig({
        EPIC_ALLOWED_RESOURCE_TYPES: `${resourceType},Provenance`,
      }), fetchMock as FetchLike);
      const search = new URLSearchParams("_count=20");
      if (resourceType === "CarePlan") {
        search.set("category", EPIC_CARE_PLAN_SEARCH_TYPES[0].category);
      }

      await expect(client.search(
        withProvenanceReverseInclude(resourceType),
        resourceType,
        search,
      )).resolves.toEqual(bundle);
    },
  );

  it("treats an eligible search with no returned Provenance as a valid result", async () => {
    const bundle = {
      resourceType: "Bundle",
      type: "searchset",
      entry: [{
        resource: { resourceType: "Observation", id: "observation-without-source" },
        search: { mode: "match" },
      }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(input.toString()).searchParams.get("_revinclude")).toBe(provenanceReverseInclude);
      return jsonResponse(bundle);
    });
    const client = new EpicFhirClient(makeConfig({
      EPIC_ALLOWED_RESOURCE_TYPES: "Observation,Provenance",
    }), fetchMock as FetchLike);

    await expect(client.search(
      withProvenanceReverseInclude("Observation"),
      "Observation",
      new URLSearchParams(),
    )).resolves.toEqual(bundle);
  });

  it("does not recursively reverse-include Provenance while searching Provenance", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(input.toString()).searchParams.has("_revinclude")).toBe(false);
      return jsonResponse(emptySearchBundle());
    });
    const client = new EpicFhirClient(makeConfig({
      EPIC_ALLOWED_RESOURCE_TYPES: "Provenance",
    }), fetchMock as FetchLike);
    const provenanceSearchRecord: ConnectionRecord = {
      ...record,
      scope: "patient/Provenance.s patient/Provenance.r",
      fhirCapabilities: [{
        resourceType: "Provenance",
        interactions: ["read", "search"],
        searchParameters: ["patient"],
        searchRevIncludes: [provenanceReverseInclude],
      }],
    };

    await expect(client.search(
      provenanceSearchRecord,
      "Provenance",
      new URLSearchParams(),
    )).resolves.toEqual(emptySearchBundle());
  });

  it.each([
    {
      name: "source does not advertise the exact include",
      configTypes: "Observation,Provenance",
      mutate: (candidate: ConnectionRecord): ConnectionRecord => ({
        ...candidate,
        fhirCapabilities: candidate.fhirCapabilities?.map((capability) =>
          capability.resourceType === "Observation"
            ? { ...capability, searchRevIncludes: ["*"] }
            : capability),
      }),
    },
    {
      name: "Provenance is not allowlisted",
      configTypes: "Observation",
      mutate: (candidate: ConnectionRecord): ConnectionRecord => candidate,
    },
    {
      name: "Provenance read is not advertised",
      configTypes: "Observation,Provenance",
      mutate: (candidate: ConnectionRecord): ConnectionRecord => ({
        ...candidate,
        fhirCapabilities: candidate.fhirCapabilities?.map((capability) =>
          capability.resourceType === "Provenance"
            ? { ...capability, interactions: [] }
            : capability),
      }),
    },
    {
      name: "Provenance read is not granted",
      configTypes: "Observation,Provenance",
      mutate: (candidate: ConnectionRecord): ConnectionRecord => ({
        ...candidate,
        scope: "patient/Observation.s",
      }),
    },
    {
      name: "Provenance read is constrained",
      configTypes: "Observation,Provenance",
      mutate: (candidate: ConnectionRecord): ConnectionRecord => ({
        ...candidate,
        scope: "patient/Observation.s patient/Provenance.r?target=Observation%2Fobservation-1",
      }),
    },
  ])("uses an ordinary search when $name", async ({ configTypes, mutate }) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(input.toString()).searchParams.has("_revinclude")).toBe(false);
      return jsonResponse(emptySearchBundle());
    });
    const client = new EpicFhirClient(makeConfig({
      EPIC_ALLOWED_RESOURCE_TYPES: configTypes,
    }), fetchMock as FetchLike);

    await expect(client.search(
      mutate(withProvenanceReverseInclude("Observation")),
      "Observation",
      new URLSearchParams(),
    )).resolves.toEqual(emptySearchBundle());
  });

  it("rejects resource types outside the configured allowlist before making a request", async () => {
    const fetchMock = vi.fn();
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);
    await expect(client.search(record, "Binary", new URLSearchParams())).rejects.toThrow(/not enabled/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("identifies Epic's insufficient-scope challenge and recommends a fresh grant", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", {
      status: 403,
      headers: {
        "content-type": "application/fhir+json",
        "www-authenticate": 'Bearer error="insufficient_scope", error_description="The access token provided is valid, but is not authorized for this service"',
      },
    }));
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);

    await expect(
      client.search(record, "Observation", new URLSearchParams()),
    ).rejects.toMatchObject({
      code: "fhir_scope_denied",
      publicMessage: expect.stringMatching(/Observation search permission.*disconnect and reconnect/),
    });
  });

  it.each([
    'Bearer error="insufficient_scope-other"',
    'Bearer error="insufficient_scope',
    'Bearer error="other", error_description="upstream said error=insufficient_scope, retry"',
  ])("does not classify a malformed or different OAuth challenge as insufficient_scope: %s", async (challenge) => {
    const fetchMock = vi.fn(async () => new Response("{}", {
      status: 403,
      headers: {
        "content-type": "application/fhir+json",
        "www-authenticate": challenge,
      },
    }));
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);

    await expect(
      client.search(record, "Observation", new URLSearchParams()),
    ).rejects.toMatchObject({ code: "fhir_access_denied" });
  });

  it("classifies an Epic OperationOutcome without exposing upstream diagnostics", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      resourceType: "OperationOutcome",
      issue: [{
        severity: "error",
        code: "forbidden",
        diagnostics: "The authenticated user is not authorized\n  to view the requested data.",
      }],
    }, 403));
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);

    try {
      await client.readPatient(record);
      expect.unreachable("Expected Epic to deny the request");
    } catch (error) {
      expect(error).toMatchObject({
        code: "fhir_access_denied",
        publicMessage: expect.stringMatching(/Patient read.*patient\/user security.*not proof/),
      });
      expect((error as Error).message).not.toContain("authenticated user is not authorized");
    }
  });

  it("does not mislabel an unexplained Epic 403 as proof of a missing scope", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 403));
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);

    await expect(
      client.search(record, "Condition", new URLSearchParams()),
    ).rejects.toMatchObject({
      code: "fhir_access_denied",
      publicMessage: expect.stringMatching(/matching R4 Incoming API.*sync.*disconnect and reconnect/),
    });
  });

  it("enforces v2 read/search permissions before contacting Epic", async () => {
    const fetchMock = vi.fn();
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);

    await expect(
      client.search(withScope("patient/Observation.r"), "Observation", new URLSearchParams()),
    ).rejects.toMatchObject({ code: "fhir_scope_denied" });
    await expect(
      client.read(withScope("patient/Condition.s"), "Condition", "condition-1"),
    ).rejects.toMatchObject({ code: "fhir_scope_denied" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      advertised: ["category", "_count"],
      scope: "patient/Observation.s",
      search: "",
    },
    {
      advertised: ["patient", "_count"],
      scope: `patient/Observation.s?category=${laboratoryCategory}`,
      search: "",
    },
  ])("fails closed when CapabilityStatement omits a required search parameter", async ({
    advertised,
    scope,
    search,
  }) => {
    const fetchMock = vi.fn();
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);
    const capabilities = record.fhirCapabilities!.map((capability) =>
      capability.resourceType === "Observation"
        ? { ...capability, searchParameters: advertised }
        : capability);

    await expect(client.search(
      { ...withScope(scope), fhirCapabilities: capabilities },
      "Observation",
      new URLSearchParams(search),
    )).rejects.toMatchObject({ code: "fhir_search_parameter_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forces a single authorized Observation category and rejects an ambiguous grant", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      expect(url.searchParams.get("patient")).toBe("patient-1");
      expect(url.searchParams.get("category")).toBe(laboratoryCategory);
      return jsonResponse(emptySearchBundle());
    });
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);

    await expect(client.search(
      withScope(`patient/Observation.s?category=${laboratoryCategory}`),
      "Observation",
      new URLSearchParams("_count=20"),
    )).resolves.toMatchObject({ resourceType: "Bundle" });

    const ambiguousFetch = vi.fn();
    const ambiguousClient = new EpicFhirClient(makeConfig(), ambiguousFetch as FetchLike);
    await expect(ambiguousClient.search(
      withScope(granted53Scopes),
      "Observation",
      new URLSearchParams("_count=20"),
    )).rejects.toMatchObject({ code: "fhir_scope_constraint_required" });
    expect(ambiguousFetch).not.toHaveBeenCalled();
  });

  it("does not add patient= to supporting-resource searches", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      expect(url.pathname).toBe("/api/FHIR/R4/Organization");
      expect(url.searchParams.has("patient")).toBe(false);
      return jsonResponse(emptySearchBundle());
    });
    const client = new EpicFhirClient(
      makeConfig({ EPIC_ALLOWED_RESOURCE_TYPES: "Organization" }),
      fetchMock as FetchLike,
    );
    await expect(client.search(
      withScope("patient/Organization.s"),
      "Organization",
      new URLSearchParams("_count=10"),
    )).resolves.toMatchObject({ resourceType: "Bundle" });
  });

  it("derives unique care locations from patient-bound Encounter references", async () => {
    const nextUrl = `${record.fhirBaseUrl}/Encounter?_getpages=encounter-page-2`;
    const derivedRecord: ConnectionRecord = {
      ...record,
      scope: "patient/Encounter.s patient/Location.r",
      fhirCapabilities: [{
        resourceType: "Encounter",
        interactions: ["search"],
        searchParameters: ["patient", "_count"],
      }, {
        resourceType: "Location",
        interactions: ["read"],
        searchParameters: [],
      }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token");
      if (url.pathname.endsWith("/Encounter") && !url.searchParams.has("_getpages")) {
        expect(url.searchParams.get("patient")).toBe("patient-1");
        expect(url.searchParams.get("_count")).toBe("100");
        expect(url.searchParams.has("_revinclude")).toBe(false);
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          link: [{ relation: "next", url: nextUrl }],
          entry: [{
            resource: {
              resourceType: "Encounter",
              id: "encounter-1",
              location: [
                { location: { reference: "Location/location-1" } },
                { location: { reference: `${record.fhirBaseUrl}/Location/location-1` } },
                { location: { reference: "Patient/not-a-location" } },
                { location: { reference: "https://attacker.example/Location/stolen" } },
                { location: { reference: "#contained-location" } },
                { location: { display: "Identifier-only location" } },
              ],
            },
            search: { mode: "match" },
          }],
        });
      }
      if (input.toString() === nextUrl) {
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          entry: [{
            resource: {
              resourceType: "Encounter",
              id: "encounter-2",
              location: [
                { location: { reference: "Location/location-2" } },
                { location: { reference: "Location/location-1" } },
              ],
            },
            search: { mode: "match" },
          }, {
            fullUrl: "urn:uuid:encounter-warning",
            resource: {
              resourceType: "OperationOutcome",
              issue: [{ severity: "warning", code: "processing" }],
            },
            search: { mode: "outcome" },
          }],
        });
      }
      if (url.pathname.endsWith("/Location/location-1")) {
        return jsonResponse({ resourceType: "Location", id: "location-1", name: "Clinic A" });
      }
      if (url.pathname.endsWith("/Location/location-2")) {
        return jsonResponse({ resourceType: "Location", id: "location-2", name: "Clinic B" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const client = new EpicFhirClient(
      makeConfig({ EPIC_ALLOWED_RESOURCE_TYPES: "Encounter,Location" }),
      fetchMock as FetchLike,
    );

    const result = await client.search(
      derivedRecord,
      "Location",
      new URLSearchParams("_count=2"),
    ) as Record<string, unknown>;
    const entries = result.entry as Array<{ resource: Record<string, unknown> }>;
    expect(entries.filter(({ resource }) => resource.resourceType === "Location"))
      .toEqual([
        expect.objectContaining({ resource: expect.objectContaining({ id: "location-1" }) }),
        expect.objectContaining({ resource: expect.objectContaining({ id: "location-2" }) }),
      ]);
    expect(entries.filter(({ resource }) => resource.resourceType === "OperationOutcome"))
      .toHaveLength(2);
    expect(result.total).toBeUndefined();
    expect(result.link).toEqual([]);
    const fetchedUrls = fetchMock.mock.calls.map(([input]) => input!.toString());
    expect(fetchedUrls).toEqual(expect.arrayContaining([
      nextUrl,
      `${record.fhirBaseUrl}/Location/location-1`,
      `${record.fhirBaseUrl}/Location/location-2`,
    ]));
    expect(fetchedUrls.every((url) => !url.startsWith("https://attacker.example"))).toBe(true);
    expect(fetchedUrls.filter((url) => url.endsWith("/Location/location-1"))).toHaveLength(1);
  });

  it("returns an exact Location searchset when Encounter references are complete", async () => {
    const derivedRecord: ConnectionRecord = {
      ...record,
      scope: "patient/Encounter.s patient/Location.r",
      fhirCapabilities: [{
        resourceType: "Encounter",
        interactions: ["search"],
        searchParameters: ["patient"],
      }, {
        resourceType: "Location",
        interactions: ["read"],
        searchParameters: [],
      }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/Encounter")) {
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          entry: [{
            resource: {
              resourceType: "Encounter",
              id: "encounter-1",
              location: [{ location: { reference: "Location/location-1" } }],
            },
          }],
        });
      }
      return jsonResponse({ resourceType: "Location", id: "location-1", name: "Clinic A" });
    });
    const client = new EpicFhirClient(
      makeConfig({ EPIC_ALLOWED_RESOURCE_TYPES: "Encounter,Location" }),
      fetchMock as FetchLike,
    );

    await expect(client.search(
      derivedRecord,
      "Location",
      new URLSearchParams("_count=1"),
    )).resolves.toEqual({
      resourceType: "Bundle",
      type: "searchset",
      total: 1,
      link: [],
      entry: [{
        fullUrl: `${record.fhirBaseUrl}/Location/location-1`,
        resource: { resourceType: "Location", id: "location-1", name: "Clinic A" },
        search: { mode: "match" },
      }],
    });
  });

  it("returns an exact empty Location searchset when Encounters have no locations", async () => {
    const derivedRecord: ConnectionRecord = {
      ...record,
      scope: "patient/Encounter.s patient/Location.r",
      fhirCapabilities: [{
        resourceType: "Encounter",
        interactions: ["search"],
        searchParameters: ["patient"],
      }, {
        resourceType: "Location",
        interactions: ["read"],
        searchParameters: [],
      }],
    };
    const fetchMock = vi.fn(async () => jsonResponse({
      resourceType: "Bundle",
      type: "searchset",
      total: 0,
      entry: [],
    }));
    const client = new EpicFhirClient(
      makeConfig({ EPIC_ALLOWED_RESOURCE_TYPES: "Encounter,Location" }),
      fetchMock as FetchLike,
    );

    await expect(client.search(
      derivedRecord,
      "Location",
      new URLSearchParams("_count=20"),
    )).resolves.toEqual({
      resourceType: "Bundle",
      type: "searchset",
      total: 0,
      link: [],
      entry: [],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("continues past a stale reference to fill the requested Location count", async () => {
    const derivedRecord: ConnectionRecord = {
      ...record,
      scope: "patient/Encounter.s patient/Location.r",
      fhirCapabilities: [{
        resourceType: "Encounter",
        interactions: ["search"],
        searchParameters: ["patient"],
      }, {
        resourceType: "Location",
        interactions: ["read"],
        searchParameters: [],
      }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/Encounter")) {
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          entry: [{
            resource: {
              resourceType: "Encounter",
              id: "encounter-1",
              location: [
                { location: { reference: "Location/deleted-location" } },
                { location: { reference: "Location/available-location" } },
              ],
            },
          }],
        });
      }
      if (url.pathname.endsWith("/Location/available-location")) {
        return jsonResponse({
          resourceType: "Location",
          id: "available-location",
          name: "Available clinic",
        });
      }
      return jsonResponse({}, 404);
    });
    const client = new EpicFhirClient(
      makeConfig({ EPIC_ALLOWED_RESOURCE_TYPES: "Encounter,Location" }),
      fetchMock as FetchLike,
    );

    const result = await client.search(
      derivedRecord,
      "Location",
      new URLSearchParams("_count=1"),
    ) as { entry: Array<{ resource: Record<string, unknown> }> };
    expect(result.entry).toHaveLength(2);
    expect(result.entry[0]?.resource).toMatchObject({
      resourceType: "Location",
      id: "available-location",
    });
    expect(result.entry[1]?.resource.resourceType).toBe("OperationOutcome");
  });

  it("caps Encounter pagination while deriving care locations", async () => {
    const derivedRecord: ConnectionRecord = {
      ...record,
      scope: "patient/Encounter.s patient/Location.r",
      fhirCapabilities: [{
        resourceType: "Encounter",
        interactions: ["search"],
        searchParameters: ["patient"],
      }, {
        resourceType: "Location",
        interactions: ["read"],
        searchParameters: [],
      }],
    };
    let encounterPages = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      expect(url.pathname.endsWith("/Encounter")).toBe(true);
      encounterPages += 1;
      return jsonResponse({
        resourceType: "Bundle",
        type: "searchset",
        entry: [],
        link: [{
          relation: "next",
          url: `${record.fhirBaseUrl}/Encounter?_getpages=page-${encounterPages + 1}`,
        }],
      });
    });
    const client = new EpicFhirClient(
      makeConfig({ EPIC_ALLOWED_RESOURCE_TYPES: "Encounter,Location" }),
      fetchMock as FetchLike,
    );

    const result = await client.search(
      derivedRecord,
      "Location",
      new URLSearchParams("_count=20"),
    ) as { total?: number; entry: Array<{ resource: Record<string, unknown> }> };
    expect(encounterPages).toBe(10);
    expect(result.total).toBeUndefined();
    expect(result.entry).toHaveLength(1);
    expect(result.entry[0]?.resource.resourceType).toBe("OperationOutcome");
  });

  it("caps Location reads at 100 and resolves no more than four concurrently", async () => {
    const derivedRecord: ConnectionRecord = {
      ...record,
      scope: "patient/Encounter.s patient/Location.r",
      fhirCapabilities: [{
        resourceType: "Encounter",
        interactions: ["search"],
        searchParameters: ["patient"],
      }, {
        resourceType: "Location",
        interactions: ["read"],
        searchParameters: [],
      }],
    };
    let activeLocationReads = 0;
    let maximumConcurrentReads = 0;
    let locationReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/Encounter")) {
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          entry: [{
            resource: {
              resourceType: "Encounter",
              id: "encounter-with-many-locations",
              location: Array.from({ length: 101 }, (_, index) => ({
                location: { reference: `Location/location-${index + 1}` },
              })),
            },
          }],
        });
      }
      const id = url.pathname.split("/").at(-1)!;
      locationReads += 1;
      activeLocationReads += 1;
      maximumConcurrentReads = Math.max(maximumConcurrentReads, activeLocationReads);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      activeLocationReads -= 1;
      return jsonResponse({ resourceType: "Location", id });
    });
    const client = new EpicFhirClient(
      makeConfig({ EPIC_ALLOWED_RESOURCE_TYPES: "Encounter,Location" }),
      fetchMock as FetchLike,
    );

    const result = await client.search(
      derivedRecord,
      "Location",
      new URLSearchParams("_count=100"),
    ) as { entry: Array<{ resource: Record<string, unknown> }> };
    expect(locationReads).toBe(100);
    expect(maximumConcurrentReads).toBe(4);
    expect(result.entry.filter(({ resource }) => resource.resourceType === "Location"))
      .toHaveLength(100);
    expect(fetchMock.mock.calls.some(([input]) => input!.toString().endsWith("/location-101")))
      .toBe(false);
    expect(result.entry.at(-1)?.resource.resourceType).toBe("OperationOutcome");
  });

  it("stops discarded Location reads when the aggregate upstream byte budget is exhausted", async () => {
    const derivedRecord: ConnectionRecord = {
      ...record,
      scope: "patient/Encounter.s patient/Location.r",
      fhirCapabilities: [{
        resourceType: "Encounter",
        interactions: ["search"],
        searchParameters: ["patient"],
      }, {
        resourceType: "Location",
        interactions: ["read"],
        searchParameters: [],
      }],
    };
    let locationReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/Encounter")) {
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          entry: [{
            resource: {
              resourceType: "Encounter",
              id: "encounter-with-stale-locations",
              location: [
                ...Array.from({ length: 10 }, (_, index) => ({
                  location: { reference: `Location/stale-${index + 1}` },
                })),
                { location: { reference: "Location/available-location" } },
              ],
            },
          }],
        });
      }
      locationReads += 1;
      if (url.pathname.endsWith("/Location/available-location")) {
        return jsonResponse({ resourceType: "Location", id: "available-location" });
      }
      return jsonResponse({
        resourceType: "OperationOutcome",
        issue: [{ severity: "error", code: "not-found", diagnostics: "x".repeat(1_500) }],
      }, 404);
    });
    const baseConfig = makeConfig({ EPIC_ALLOWED_RESOURCE_TYPES: "Encounter,Location" });
    const client = new EpicFhirClient(
      { ...baseConfig, maxUpstreamBytes: 4_096 },
      fetchMock as FetchLike,
    );

    const result = await client.search(
      derivedRecord,
      "Location",
      new URLSearchParams("_count=1"),
    ) as { total?: number; entry: Array<{ resource: Record<string, unknown> }> };
    expect(locationReads).toBeLessThan(11);
    expect(fetchMock.mock.calls.some(([input]) =>
      input!.toString().endsWith("/Location/available-location"))).toBe(false);
    expect(result.total).toBeUndefined();
    expect(result.entry).toHaveLength(1);
    expect(result.entry[0]?.resource.resourceType).toBe("OperationOutcome");
  });

  it("propagates Location read rate limits during Encounter derivation", async () => {
    const derivedRecord: ConnectionRecord = {
      ...record,
      scope: "patient/Encounter.s patient/Location.r",
      fhirCapabilities: [{
        resourceType: "Encounter",
        interactions: ["search"],
        searchParameters: ["patient"],
      }, {
        resourceType: "Location",
        interactions: ["read"],
        searchParameters: [],
      }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/Encounter")) {
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          entry: [{
            resource: {
              resourceType: "Encounter",
              id: "encounter-1",
              location: [{ location: { reference: "Location/location-1" } }],
            },
          }],
        });
      }
      return new Response(JSON.stringify({ resourceType: "OperationOutcome", issue: [{}] }), {
        status: 429,
        headers: { "content-type": "application/fhir+json", "retry-after": "9" },
      });
    });
    const client = new EpicFhirClient(
      makeConfig({ EPIC_ALLOWED_RESOURCE_TYPES: "Encounter,Location" }),
      fetchMock as FetchLike,
    );

    await expect(client.search(
      derivedRecord,
      "Location",
      new URLSearchParams("_count=1"),
    )).rejects.toEqual(expect.objectContaining({
      code: "epic_rate_limited",
      retryAfterSeconds: 9,
    }));
  });

  it.each([
    { status: 401, expected: { code: "reconnect_required" } },
    { status: 429, expected: { code: "epic_rate_limited", retryAfterSeconds: 7 } },
  ])("does not mask a $status response when its body exceeds the remaining byte budget", async ({
    status,
    expected,
  }) => {
    const derivedRecord: ConnectionRecord = {
      ...record,
      scope: "patient/Encounter.s patient/Location.r",
      fhirCapabilities: [{
        resourceType: "Encounter",
        interactions: ["search"],
        searchParameters: ["patient"],
      }, {
        resourceType: "Location",
        interactions: ["read"],
        searchParameters: [],
      }],
    };
    const encounterBody = {
      resourceType: "Bundle",
      type: "searchset",
      entry: [{
        resource: {
          resourceType: "Encounter",
          id: "encounter-before-fatal-response",
          location: [
            ...Array.from({ length: 4 }, (_, index) => ({
              location: { reference: `Location/stale-${index + 1}` },
            })),
            { location: { reference: "Location/fatal-response" } },
          ],
        },
      }],
    };
    const staleBody = {
      resourceType: "OperationOutcome",
      issue: [{ severity: "error", code: "not-found", diagnostics: "x".repeat(1_200) }],
    };
    const fatalBody = {
      resourceType: "OperationOutcome",
      issue: [{ severity: "error", code: "processing", diagnostics: "x".repeat(3_000) }],
    };
    const encodedLength = (value: unknown): number =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const operationByteBudget = 2 * 4_096;
    const bytesBeforeFatalResponse = encodedLength(encounterBody) + 4 * encodedLength(staleBody);
    expect(bytesBeforeFatalResponse).toBeLessThan(operationByteBudget);
    expect(bytesBeforeFatalResponse + encodedLength(fatalBody)).toBeGreaterThan(operationByteBudget);
    expect(encodedLength(fatalBody)).toBeLessThan(4_096);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/Encounter")) {
        return jsonResponse(encounterBody);
      }
      if (!url.pathname.endsWith("/Location/fatal-response")) {
        return jsonResponse(staleBody, 404);
      }
      return new Response(JSON.stringify(fatalBody), {
        status,
        headers: { "content-type": "application/fhir+json", "retry-after": "7" },
      });
    });
    const baseConfig = makeConfig({ EPIC_ALLOWED_RESOURCE_TYPES: "Encounter,Location" });
    const client = new EpicFhirClient(
      { ...baseConfig, maxUpstreamBytes: 4_096 },
      fetchMock as FetchLike,
    );

    await expect(client.search(
      derivedRecord,
      "Location",
      new URLSearchParams("_count=1"),
    )).rejects.toEqual(expect.objectContaining(expected));
  });

  it("preserves a rate limit when the 429 body exceeds the per-response cap", async () => {
    const derivedRecord: ConnectionRecord = {
      ...record,
      scope: "patient/Encounter.s patient/Location.r",
      fhirCapabilities: [{
        resourceType: "Encounter",
        interactions: ["search"],
        searchParameters: ["patient"],
      }, {
        resourceType: "Location",
        interactions: ["read"],
        searchParameters: [],
      }],
    };
    const oversizedBody = JSON.stringify({
      resourceType: "OperationOutcome",
      issue: [{ severity: "error", code: "processing", diagnostics: "x".repeat(5_000) }],
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/Encounter")) {
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          entry: [{
            resource: {
              resourceType: "Encounter",
              id: "encounter-1",
              location: [{ location: { reference: "Location/rate-limited" } }],
            },
          }],
        });
      }
      return new Response(oversizedBody, {
        status: 429,
        headers: {
          "content-length": String(new TextEncoder().encode(oversizedBody).byteLength),
          "content-type": "application/fhir+json",
          "retry-after": "3",
        },
      });
    });
    const baseConfig = makeConfig({ EPIC_ALLOWED_RESOURCE_TYPES: "Encounter,Location" });
    const client = new EpicFhirClient(
      { ...baseConfig, maxUpstreamBytes: 4_096 },
      fetchMock as FetchLike,
    );

    await expect(client.search(
      derivedRecord,
      "Location",
      new URLSearchParams("_count=1"),
    )).rejects.toEqual(expect.objectContaining({
      code: "epic_rate_limited",
      retryAfterSeconds: 3,
    }));
  });

  it("preserves the first fatal error from concurrent Location reads", async () => {
    const derivedRecord: ConnectionRecord = {
      ...record,
      scope: "patient/Encounter.s patient/Location.r",
      fhirCapabilities: [{
        resourceType: "Encounter",
        interactions: ["search"],
        searchParameters: ["patient"],
      }, {
        resourceType: "Location",
        interactions: ["read"],
        searchParameters: [],
      }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/Encounter")) {
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          entry: [{
            resource: {
              resourceType: "Encounter",
              id: "encounter-1",
              location: [
                { location: { reference: "Location/rate-limited" } },
                { location: { reference: "Location/later-failure" } },
              ],
            },
          }],
        });
      }
      if (url.pathname.endsWith("/Location/rate-limited")) {
        return new Response(JSON.stringify({ resourceType: "OperationOutcome", issue: [{}] }), {
          status: 429,
          headers: { "content-type": "application/fhir+json", "retry-after": "5" },
        });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return jsonResponse({ resourceType: "OperationOutcome", issue: [{}] }, 500);
    });
    const client = new EpicFhirClient(
      makeConfig({ EPIC_ALLOWED_RESOURCE_TYPES: "Encounter,Location" }),
      fetchMock as FetchLike,
    );

    await expect(client.search(
      derivedRecord,
      "Location",
      new URLSearchParams("_count=2"),
    )).rejects.toEqual(expect.objectContaining({
      code: "epic_rate_limited",
      retryAfterSeconds: 5,
    }));
  });

  it("rejects direct Location filters and requires Encounter search plus Location read", async () => {
    const capabilities: ConnectionRecord["fhirCapabilities"] = [{
      resourceType: "Encounter",
      interactions: ["search"],
      searchParameters: ["patient"],
    }, {
      resourceType: "Location",
      interactions: ["read", "search"],
      searchParameters: ["_id", "status"],
    }];
    const fetchMock = vi.fn();
    const client = new EpicFhirClient(
      makeConfig({ EPIC_ALLOWED_RESOURCE_TYPES: "Encounter,Location" }),
      fetchMock as FetchLike,
    );

    await expect(client.search(
      { ...record, scope: "patient/Encounter.s patient/Location.r", fhirCapabilities: capabilities },
      "Location",
      new URLSearchParams("status=active"),
    )).rejects.toMatchObject({ code: "location_search_filter_not_supported" });
    await expect(client.search(
      { ...record, scope: "patient/Location.s", fhirCapabilities: capabilities },
      "Location",
      new URLSearchParams("_count=20"),
    )).rejects.toMatchObject({ code: "fhir_scope_denied" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not derive locations when Encounter search lacks the patient parameter", async () => {
    const fetchMock = vi.fn();
    const client = new EpicFhirClient(
      makeConfig({ EPIC_ALLOWED_RESOURCE_TYPES: "Encounter,Location" }),
      fetchMock as FetchLike,
    );
    const derivedRecord: ConnectionRecord = {
      ...record,
      scope: "patient/Encounter.s patient/Location.r",
      fhirCapabilities: [{
        resourceType: "Encounter",
        interactions: ["search"],
        searchParameters: ["_count"],
      }, {
        resourceType: "Location",
        interactions: ["read"],
        searchParameters: [],
      }],
    };

    await expect(client.search(
      derivedRecord,
      "Location",
      new URLSearchParams("_count=20"),
    )).rejects.toMatchObject({ code: "fhir_search_parameter_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks Binary search and direct read until reference proof is implemented", async () => {
    const fetchMock = vi.fn();
    const client = new EpicFhirClient(
      makeConfig({ EPIC_ALLOWED_RESOURCE_TYPES: "Binary" }),
      fetchMock as FetchLike,
    );
    await expect(client.search(
      withScope("patient/Binary.s"),
      "Binary",
      new URLSearchParams(),
    )).rejects.toMatchObject({ code: "resource_search_not_supported" });
    await expect(client.read(
      withScope("patient/Binary.r"),
      "Binary",
      "attachment-1",
    )).rejects.toMatchObject({ code: "binary_reference_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads an allowlisted resource by safe FHIR ID and validates constrained results", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(input.toString()).toBe(
        "https://ehr.example.test/api/FHIR/R4/Observation/observation-1",
      );
      return jsonResponse({
        resourceType: "Observation",
        id: "observation-1",
        category: [{
          coding: [{
            system: "http://terminology.hl7.org/CodeSystem/observation-category",
            code: "laboratory",
          }],
        }],
      });
    });
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);
    await expect(client.read(
      withScope(`patient/Observation.r?category=${laboratoryCategory}`),
      "Observation",
      "observation-1",
    )).resolves.toMatchObject({ resourceType: "Observation", id: "observation-1" });
  });

  it("fails closed when a read result is outside its fine-grained scope", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      resourceType: "Observation",
      id: "observation-1",
      category: [{ coding: [{
        system: "http://terminology.hl7.org/CodeSystem/observation-category",
        code: "vital-signs",
      }] }],
    }));
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);
    await expect(client.read(
      withScope(`patient/Observation.r?category=${laboratoryCategory}`),
      "Observation",
      "observation-1",
    )).rejects.toMatchObject({ code: "fhir_scope_denied" });
  });

  it("rejects invalid IDs and mismatched read resources", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      resourceType: "Condition",
      id: "different-id",
    }));
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);

    await expect(client.read(
      withScope("patient/Condition.r"),
      "Condition",
      "../Patient/other",
    )).rejects.toMatchObject({ code: "invalid_fhir_id" });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(client.read(
      withScope("patient/Condition.r"),
      "Condition",
      "condition-1",
    )).rejects.toMatchObject({ code: "invalid_fhir_response" });
  });

  it("validates searchset Bundle entry resource types", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      resourceType: "Bundle",
      type: "searchset",
      entry: [{ resource: { resourceType: "Patient", id: "patient-1" } }],
    }));
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);
    await expect(client.search(
      withScope("patient/Observation.s"),
      "Observation",
      new URLSearchParams(),
    )).rejects.toMatchObject({ code: "invalid_fhir_response" });
  });

  it("accepts only correlated Provenance include entries in an eligible mixed Bundle", async () => {
    const bundle = {
      resourceType: "Bundle",
      type: "searchset",
      entry: [{
        resource: {
          resourceType: "Provenance",
          id: "source-1",
          target: [{ reference: "urn:uuid:observation-1" }],
        },
        search: { mode: "include" },
      }, {
        resource: {
          resourceType: "Provenance",
          id: "source-versioned",
          target: [{
            reference: `${record.fhirBaseUrl}/Observation/observation-1/_history/version-2`,
          }],
        },
        search: { mode: "include" },
      }, {
        fullUrl: "urn:uuid:observation-1",
        resource: { resourceType: "Observation", id: "observation-1" },
        search: { mode: "match" },
      }],
    };
    const fetchMock = vi.fn(async () => jsonResponse(bundle));
    const client = new EpicFhirClient(makeConfig({
      EPIC_ALLOWED_RESOURCE_TYPES: "Observation,Provenance",
    }), fetchMock as FetchLike);

    await expect(client.search(
      withProvenanceReverseInclude("Observation"),
      "Observation",
      new URLSearchParams(),
    )).resolves.toEqual(bundle);
  });

  it.each([
    {
      name: "missing include mode",
      included: {
        resource: { resourceType: "Provenance", id: "source-1", target: [{ reference: "Observation/observation-1" }] },
      },
    },
    {
      name: "incorrect search mode",
      included: {
        resource: { resourceType: "Provenance", id: "source-1", target: [{ reference: "Observation/observation-1" }] },
        search: { mode: "match" },
      },
    },
    {
      name: "invalid Provenance ID",
      included: {
        resource: { resourceType: "Provenance", id: "bad/id", target: [{ reference: "Observation/observation-1" }] },
        search: { mode: "include" },
      },
    },
    {
      name: "unrelated target",
      included: {
        resource: { resourceType: "Provenance", id: "source-1", target: [{ reference: "Observation/another-record" }] },
        search: { mode: "include" },
      },
    },
    {
      name: "same resource path on another FHIR server",
      included: {
        resource: {
          resourceType: "Provenance",
          id: "source-1",
          target: [{ reference: "https://attacker.example/Observation/observation-1" }],
        },
        search: { mode: "include" },
      },
    },
    {
      name: "another reverse-included resource type",
      included: {
        resource: { resourceType: "AuditEvent", id: "audit-1" },
        search: { mode: "include" },
      },
    },
  ])("rejects a mixed search Bundle with $name", async ({ included }) => {
    const fetchMock = vi.fn(async () => jsonResponse({
      resourceType: "Bundle",
      type: "searchset",
      entry: [included, {
        resource: { resourceType: "Observation", id: "observation-1" },
        search: { mode: "match" },
      }],
    }));
    const client = new EpicFhirClient(makeConfig({
      EPIC_ALLOWED_RESOURCE_TYPES: "Observation,Provenance",
    }), fetchMock as FetchLike);

    await expect(client.search(
      withProvenanceReverseInclude("Observation"),
      "Observation",
      new URLSearchParams(),
    )).rejects.toMatchObject({ code: "invalid_fhir_response" });
  });

  it.each([400, 422])("maps %i OperationOutcomes without exposing diagnostics", async (status) => {
    const fetchMock = vi.fn(async () => jsonResponse({
      resourceType: "OperationOutcome",
      issue: [{
        severity: "error",
        code: "invalid",
        diagnostics: "sensitive upstream diagnostics",
      }],
    }, status));
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);

    try {
      await client.search(
        withScope("patient/Condition.s"),
        "Condition",
        new URLSearchParams(),
      );
      expect.unreachable("Expected the FHIR search to be rejected");
    } catch (error) {
      expect(error).toMatchObject({ statusCode: status, code: "fhir_request_rejected" });
      expect((error as Error).message).not.toContain("sensitive upstream diagnostics");
    }
  });

  it("wire-logs the exact rejected Practitioner exchange with the browser request ID", async () => {
    const operationOutcomeBody = JSON.stringify({
      resourceType: "OperationOutcome",
      issue: [{
        severity: "error",
        code: "invalid",
        diagnostics: "At least one Practitioner search criterion is required.",
      }],
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input.toString()).toBe(
        "https://ehr.example.test/api/FHIR/R4/Practitioner?_count=20",
      );
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token");
      return new Response(operationOutcomeBody, {
        status: 400,
        headers: { "content-type": "application/fhir+json" },
      });
    });
    const lines: string[] = [];
    const client = new EpicFhirClient(
      makeConfig({
        EPIC_ALLOWED_RESOURCE_TYPES: "Practitioner",
        EPIC_FHIR_WIRE_LOGGING: "errors",
      }),
      fetchMock as FetchLike,
      (line) => lines.push(line),
    );

    try {
      await client.search(
        withScope("patient/Practitioner.s"),
        "Practitioner",
        new URLSearchParams({ _count: "20" }),
        "8ff8d2c7-ec18-4bd9-b2cd-b2b2037acba4",
      );
      expect.unreachable("Expected Epic to reject the Practitioner search");
    } catch (error) {
      expect(error).toMatchObject({
        statusCode: 400,
        code: "fhir_request_rejected",
      });
      expect((error as Error).message).not.toContain(
        "At least one Practitioner search criterion",
      );
    }

    expect(lines).toHaveLength(2);
    const request = JSON.parse(lines[0]!).fhirWire as Record<string, unknown>;
    const response = JSON.parse(lines[1]!).fhirWire as Record<string, unknown>;
    expect(request).toMatchObject({
      direction: "request",
      requestId: "8ff8d2c7-ec18-4bd9-b2cd-b2b2037acba4",
      resourceType: "Practitioner",
      interaction: "search",
      url: "https://ehr.example.test/api/FHIR/R4/Practitioner?_count=20",
      outcome: "error",
    });
    expect(response).toMatchObject({
      direction: "response",
      requestId: request.requestId,
      exchangeId: request.exchangeId,
      status: 400,
      contentType: "application/fhir+json",
      body: operationOutcomeBody,
      bodyTruncated: false,
      errorCode: "fhir_request_rejected",
    });
    expect(lines.join("\n")).not.toContain("access-token");
    expect(lines.join("\n")).not.toContain("Authorization");
  });

  it("retains safe Retry-After metadata for Epic rate limits", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", {
      status: 429,
      headers: {
        "content-type": "application/fhir+json",
        "retry-after": "120",
      },
    }));
    const client = new EpicFhirClient(makeConfig(), fetchMock as FetchLike);

    await expect(client.search(
      withScope("patient/Condition.s"),
      "Condition",
      new URLSearchParams(),
    )).rejects.toBeInstanceOf(EpicRateLimitError);
    await expect(client.search(
      withScope("patient/Condition.s"),
      "Condition",
      new URLSearchParams(),
    )).rejects.toMatchObject({
      statusCode: 429,
      code: "epic_rate_limited",
      retryAfterSeconds: 120,
    });
  });
});
