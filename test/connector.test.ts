import { describe, expect, it, vi } from "vitest";

import { EpicConnectorService } from "../src/connector.js";
import { decodePageCursor } from "../src/pagination.js";
import { InMemoryConnectionStore } from "../src/store.js";
import type {
  AppConfig,
  ConnectionRecord,
  FetchLike,
  PendingAuthorization,
  PendingAuthorizationRepository,
} from "../src/types.js";
import { jsonResponse, makeConfig } from "./helpers.js";

const now = 1_800_000_000_000;
const sessionA = "a".repeat(43);

function connection(
  config: AppConfig,
  subject: string,
  overrides: Partial<ConnectionRecord> = {},
): ConnectionRecord {
  return {
    oauthClientId: config.clientId,
    tokenAuthMethod: config.tokenAuthMethod,
    fhirBaseUrl: config.fhirBaseUrl,
    tokenEndpoint: "https://ehr.example.test/token",
    accessToken: `access-${subject}`,
    tokenType: "Bearer",
    expiresAt: now + 60 * 60 * 1_000,
    scope: "patient/Patient.r",
    patientId: "patient-1",
    oidcIssuer: "https://ehr.example.test/oauth2",
    oidcSubject: subject,
    consent: {
      policyVersion: config.consentPolicyVersion,
      acceptedAt: now - 1_000,
      purpose: "patient-access",
      requestedScopes: [...config.scopes],
      allowedResourceScopes: [...config.allowedResourceScopes],
    },
    fhirCapabilities: [{
      resourceType: "Patient",
      interactions: ["read", "search"],
      searchParameters: ["_id"],
    }],
    connectedAt: now - 1_000,
    lastAccessAt: now - 1_000,
    sessionExpiresAt: now + 60 * 60 * 1_000,
    ...overrides,
  };
}

function pendingAuthorization(
  config: AppConfig,
  overrides: Partial<PendingAuthorization> = {},
): PendingAuthorization {
  return {
    sessionId: sessionA,
    createdAt: now,
    oauthClientId: config.clientId,
    redirectUri: config.redirectUri,
    tokenAuthMethod: config.tokenAuthMethod,
    codeVerifier: "v".repeat(86),
    nonce: "n".repeat(43),
    consent: {
      policyVersion: config.consentPolicyVersion,
      acceptedAt: now,
      purpose: "patient-access",
      requestedScopes: [...config.scopes],
      allowedResourceScopes: [...config.allowedResourceScopes],
    },
    discovery: {
      fhirBaseUrl: config.fhirBaseUrl,
      smart: {
        authorizationEndpoint: "https://ehr.example.test/authorize",
        tokenEndpoint: "https://ehr.example.test/token",
        revocationEndpoint: "https://ehr.example.test/revoke",
        capabilities: ["launch-standalone"],
        codeChallengeMethods: ["S256"],
        tokenAuthMethods: [config.tokenAuthMethod],
      },
      oidc: {
        issuer: "https://ehr.example.test/oauth2",
        jwksUri: "https://ehr.example.test/jwks",
        idTokenAlgorithms: ["ES384"],
      },
      fhirVersion: "4.0.1",
      fhirCapabilities: [{
        resourceType: "Patient",
        interactions: ["read"],
        searchParameters: ["_id"],
      }],
    },
    ...overrides,
  };
}

describe("Epic connector production controls", () => {
  it("rejects stale consent at the service boundary before discovery", async () => {
    const config = makeConfig({ CONSENT_POLICY_VERSION: "terms-v2" });
    const store = new InMemoryConnectionStore();
    const fetchMock = vi.fn();
    const service = new EpicConnectorService(config, store, {
      fetch: fetchMock as FetchLike,
      now: () => now,
    });
    await service.initialize(false);
    try {
      await expect(service.startAuthorization(sessionA, "terms-v1")).rejects.toMatchObject({
        statusCode: 409,
        code: "consent_required",
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await store.list()).toEqual([]);
    } finally {
      await service.close();
    }
  });

  it.each([
    {
      name: "stale consent",
      mutate: (authorization: PendingAuthorization) => ({
        ...authorization,
        consent: { ...authorization.consent, policyVersion: "terms-v1" },
      }),
    },
    {
      name: "newly untrusted token origin",
      mutate: (authorization: PendingAuthorization) => ({
        ...authorization,
        discovery: {
          ...authorization.discovery,
          smart: {
            ...authorization.discovery.smart,
            tokenEndpoint: "https://retired-auth.example.test/token",
          },
        },
      }),
    },
    {
      name: "resource-scope policy",
      mutate: (authorization: PendingAuthorization) => ({
        ...authorization,
        consent: {
          ...authorization.consent,
          allowedResourceScopes: [
            ...(authorization.consent.allowedResourceScopes ?? []),
            "patient/Appointment.r",
          ],
        },
      }),
    },
  ])("rejects an in-flight callback after $name changes, before token exchange", async ({ mutate }) => {
    const config = makeConfig({ CONSENT_POLICY_VERSION: "terms-v2" });
    const base = pendingAuthorization(config);
    const deleteForSession = vi.fn();
    const pending: PendingAuthorizationRepository = {
      create: vi.fn(),
      consume: vi.fn(() => mutate(base)),
      deleteForSession,
    };
    const fetchMock = vi.fn();
    const service = new EpicConnectorService(config, new InMemoryConnectionStore(), {
      fetch: fetchMock as FetchLike,
      pending,
      now: () => now,
    });
    await service.initialize(false);
    try {
      await expect(service.completeAuthorization(
        sessionA,
        `/auth/callback?code=code-1&state=${"s".repeat(43)}`,
      )).rejects.toMatchObject({
        statusCode: 409,
        code: "authorization_context_changed",
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(deleteForSession).toHaveBeenCalledWith(sessionA);
    } finally {
      await service.close();
    }
  });

  it("fails closed before FHIR access when the saved server capability is absent", async () => {
    const config = makeConfig();
    const store = new InMemoryConnectionStore();
    const fetchMock = vi.fn();
    const service = new EpicConnectorService(config, store, {
      fetch: fetchMock as FetchLike,
      now: () => now,
    });
    await service.initialize(false);
    await store.set(sessionA, connection(config, "account-1", {
      fhirCapabilities: [],
    }));
    try {
      await expect(service.readPatient(sessionA)).rejects.toMatchObject({
        statusCode: 409,
        code: "fhir_capability_unavailable",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });

  it("does not release an in-flight FHIR response after the connection is removed", async () => {
    const config = makeConfig();
    const store = new InMemoryConnectionStore();
    let releaseResponse!: (response: Response) => void;
    const upstreamResponse = new Promise<Response>((resolve) => {
      releaseResponse = resolve;
    });
    const fetchMock = vi.fn(async () => upstreamResponse);
    const service = new EpicConnectorService(config, store, {
      fetch: fetchMock as FetchLike,
      now: () => now,
    });
    await service.initialize(false);
    await store.set(sessionA, connection(config, "account-1"));

    try {
      const context = (await service.getConnectionSummary(sessionA)).connectionContext!;
      const reading = service.readPatientBound(sessionA, context);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      await service.disconnect(sessionA);
      releaseResponse(jsonResponse({ resourceType: "Patient", id: "patient-1" }));

      await expect(reading).rejects.toThrow(/ended before the health data response/);
      expect(await store.get(sessionA)).toBeUndefined();
    } finally {
      await service.close();
    }
  });

  it("does not advertise the intentionally blocked Binary read/search actions", async () => {
    const config = makeConfig({
      EPIC_ALLOWED_RESOURCE_SCOPES: "patient/Binary.r patient/Binary.s",
      EPIC_ALLOWED_RESOURCE_TYPES: "Binary,Observation",
    });
    const store = new InMemoryConnectionStore();
    const service = new EpicConnectorService(config, store, { now: () => now });
    await service.initialize(false);
    await store.set(sessionA, connection(config, "account-1", {
      scope: "patient/Binary.r patient/Binary.s",
      fhirCapabilities: [{
        resourceType: "Binary",
        interactions: ["read", "search"],
        searchParameters: [],
      }],
    }));

    try {
      await expect(service.getConnectionSummary(sessionA)).resolves.toMatchObject({
        connected: true,
        capabilities: [],
      });
    } finally {
      await service.close();
    }
  });

  it("advertises CarePlan search only when Epic exposes its required category parameter", async () => {
    const config = makeConfig({
      EPIC_ALLOWED_RESOURCE_SCOPES: "patient/CarePlan.s",
      EPIC_ALLOWED_RESOURCE_TYPES: "CarePlan",
    });

    for (const [searchParameters, expected] of [
      [["patient"], false],
      [["patient", "category"], true],
    ] as const) {
      const store = new InMemoryConnectionStore();
      const service = new EpicConnectorService(config, store, { now: () => now });
      await service.initialize(false);
      await store.set(sessionA, connection(config, `careplan-${expected}`, {
        scope: "patient/CarePlan.s",
        fhirCapabilities: [{
          resourceType: "CarePlan",
          interactions: ["search"],
          searchParameters,
        }],
      }));

      try {
        const summary = await service.getConnectionSummary(sessionA);
        const carePlan = summary.capabilities?.find(({ resourceType }) =>
          resourceType === "CarePlan");
        expect(carePlan?.search ?? false).toBe(expected);
        if (expected) {
          expect(carePlan).toMatchObject({
            resourceType: "CarePlan",
            read: false,
            search: true,
            searchConstraints: [],
          });
        }
      } finally {
        await service.close();
      }
    }
  });

  it("does not advertise a CarePlan grant whose category has no supported UI choice", async () => {
    const config = makeConfig({
      EPIC_ALLOWED_RESOURCE_SCOPES: "patient/CarePlan.s",
      EPIC_ALLOWED_RESOURCE_TYPES: "CarePlan",
    });
    const store = new InMemoryConnectionStore();
    const service = new EpicConnectorService(config, store, { now: () => now });
    await service.initialize(false);
    await store.set(sessionA, connection(config, "unknown-careplan-category", {
      scope: "patient/CarePlan.s?category=not-supported",
      fhirCapabilities: [{
        resourceType: "CarePlan",
        interactions: ["search"],
        searchParameters: ["patient", "category"],
      }],
    }));

    try {
      await expect(service.getConnectionSummary(sessionA)).resolves.toMatchObject({
        connected: true,
        capabilities: [],
      });
    } finally {
      await service.close();
    }
  });

  it("seals the selected CarePlan type into its paging cursor", async () => {
    const category = "38717003";
    const config = makeConfig({
      EPIC_ALLOWED_RESOURCE_SCOPES: "patient/CarePlan.s",
      EPIC_ALLOWED_RESOURCE_TYPES: "CarePlan",
    });
    const store = new InMemoryConnectionStore();
    const nextUrl = `${config.fhirBaseUrl}/CarePlan?_getpages=opaque&category=${category}`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      expect(url.searchParams.get("patient")).toBe("patient-1");
      expect(url.searchParams.get("category")).toBe(category);
      return jsonResponse({
        resourceType: "Bundle",
        type: "searchset",
        entry: [],
        link: [{ relation: "next", url: nextUrl }],
      });
    });
    const service = new EpicConnectorService(config, store, {
      fetch: fetchMock as FetchLike,
      now: () => now,
    });
    await service.initialize(false);
    await store.set(sessionA, connection(config, "careplan-pagination", {
      scope: "patient/CarePlan.s",
      fhirCapabilities: [{
        resourceType: "CarePlan",
        interactions: ["search"],
        searchParameters: ["patient", "category"],
      }],
    }));

    try {
      const context = (await service.getConnectionSummary(sessionA)).connectionContext;
      const first = await service.searchBound(
        sessionA,
        "CarePlan",
        new URLSearchParams({ category }),
        context,
      );
      const localNext = (first.value as { link: Array<{ url: string }> }).link[0]!.url;
      const cursorToken = new URL(localNext, "https://app.example.test").searchParams.get("cursor")!;

      expect(decodePageCursor(cursorToken, sessionA, config.sessionSecret, now)).toMatchObject({
        resourceType: "CarePlan",
        constraints: [{ name: "category", value: category }],
      });
    } finally {
      await service.close();
    }
  });

  it("seals and preserves automatic Provenance inclusion in paging cursors", async () => {
    const config = makeConfig({
      EPIC_ALLOWED_RESOURCE_TYPES: "CareTeam,Provenance",
      EPIC_ALLOWED_RESOURCE_SCOPES: "patient/CareTeam.s patient/Provenance.r",
    });
    const store = new InMemoryConnectionStore();
    let page = 1;
    const nextUrl = `${config.fhirBaseUrl}/CareTeam?page=2&_revinclude=${encodeURIComponent("Provenance:target")}`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(input.toString()).searchParams.get("_revinclude")).toBe("Provenance:target");
      const currentPage = page++;
      return jsonResponse({
        resourceType: "Bundle",
        type: "searchset",
        entry: [{
          resource: {
            resourceType: "CareTeam",
            id: `team-${currentPage}`,
          },
          search: { mode: "match" },
        }, {
          resource: {
            resourceType: "Provenance",
            id: `source-${currentPage}`,
            target: [{ reference: `CareTeam/team-${currentPage}` }],
          },
          search: { mode: "include" },
        }],
        ...(currentPage === 1 ? { link: [{ relation: "next", url: nextUrl }] } : {}),
      });
    });
    const service = new EpicConnectorService(config, store, {
      fetch: fetchMock as FetchLike,
      now: () => now,
    });
    await service.initialize(false);
    await store.set(sessionA, connection(config, "account-1", {
      scope: "patient/CareTeam.s patient/Provenance.r",
      fhirCapabilities: [{
        resourceType: "CareTeam",
        interactions: ["search"],
        searchParameters: ["patient"],
        searchRevIncludes: ["Provenance:target"],
      }, {
        resourceType: "Provenance",
        interactions: ["read"],
        searchParameters: [],
      }],
    }));

    try {
      const context = (await service.getConnectionSummary(sessionA)).connectionContext;
      const first = await service.searchBound(
        sessionA,
        "CareTeam",
        new URLSearchParams(),
        context,
      );
      const localNext = (first.value as { link: Array<{ url: string }> }).link[0]!.url;
      const cursorToken = new URL(localNext, "https://app.example.test").searchParams.get("cursor")!;
      expect(decodePageCursor(cursorToken, sessionA, config.sessionSecret, now)).toMatchObject({
        resourceType: "CareTeam",
        includeProvenance: true,
      });

      const second = await service.pageBound(sessionA, cursorToken, context);
      expect(second.value).toMatchObject({
        entry: expect.arrayContaining([
          expect.objectContaining({ resource: expect.objectContaining({ resourceType: "Provenance" }) }),
        ]),
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await service.close();
    }
  });

  it("keeps server-added narrowing constraints enforced but out of the user dropdown", async () => {
    const laboratory = "http://terminology.hl7.org/CodeSystem/observation-category|laboratory";
    const config = makeConfig({
      EPIC_ALLOWED_RESOURCE_SCOPES: `patient/Observation.s?category=${laboratory}`,
      EPIC_ALLOWED_RESOURCE_TYPES: "Observation",
    });
    const store = new InMemoryConnectionStore();
    const service = new EpicConnectorService(config, store, { now: () => now });
    await service.initialize(false);
    await store.set(sessionA, connection(config, "account-1", {
      scope: `patient/Observation.s?category=${laboratory}&subject=Patient/patient-1`,
      fhirCapabilities: [{
        resourceType: "Observation",
        interactions: ["search"],
        searchParameters: ["patient", "category", "subject"],
      }],
    }));

    try {
      await expect(service.getConnectionSummary(sessionA)).resolves.toMatchObject({
        connected: true,
        capabilities: [{
          resourceType: "Observation",
          read: false,
          search: true,
          searchConstraints: [{ name: "category", values: [laboratory] }],
        }],
      });
    } finally {
      await service.close();
    }
  });

  it("reports exact read-constraint alternatives for safe record-detail actions", async () => {
    const laboratory = "http://terminology.hl7.org/CodeSystem/observation-category|laboratory";
    const vitalSigns = "http://terminology.hl7.org/CodeSystem/observation-category|vital-signs";
    const config = makeConfig({
      EPIC_ALLOWED_RESOURCE_SCOPES: [
        `patient/Observation.r?category=${laboratory}`,
        `patient/Observation.s?category=${vitalSigns}`,
      ].join(" "),
      EPIC_ALLOWED_RESOURCE_TYPES: "Observation",
    });
    const store = new InMemoryConnectionStore();
    const service = new EpicConnectorService(config, store, { now: () => now });
    await service.initialize(false);
    await store.set(sessionA, connection(config, "account-1", {
      scope: config.allowedResourceScopes.join(" "),
      fhirCapabilities: [{
        resourceType: "Observation",
        interactions: ["read", "search"],
        searchParameters: ["patient", "category"],
      }],
    }));

    try {
      await expect(service.getConnectionSummary(sessionA)).resolves.toMatchObject({
        connected: true,
        capabilities: [{
          resourceType: "Observation",
          read: true,
          readConstraintAlternatives: [[{ name: "category", value: laboratory }]],
          search: true,
          searchConstraints: [{ name: "category", values: [vitalSigns] }],
        }],
      });
    } finally {
      await service.close();
    }
  });

  it("does not advertise ambiguous server-added constraint alternatives", async () => {
    const config = makeConfig({
      EPIC_ALLOWED_RESOURCE_SCOPES: "patient/Observation.s",
      EPIC_ALLOWED_RESOURCE_TYPES: "Observation",
    });
    const store = new InMemoryConnectionStore();
    const service = new EpicConnectorService(config, store, { now: () => now });
    await service.initialize(false);
    await store.set(sessionA, connection(config, "account-1", {
      scope: [
        "patient/Observation.s?subject=Patient/patient-1",
        "patient/Observation.s?subject=Patient/patient-2",
      ].join(" "),
      fhirCapabilities: [{
        resourceType: "Observation",
        interactions: ["search"],
        searchParameters: ["patient", "subject"],
      }],
    }));

    try {
      await expect(service.getConnectionSummary(sessionA)).resolves.toMatchObject({
        connected: true,
        capabilities: [],
      });
    } finally {
      await service.close();
    }
  });

  it("advertises Care locations only when Encounter search and Location read can derive them", async () => {
    const config = makeConfig({
      EPIC_ALLOWED_RESOURCE_SCOPES: "patient/Encounter.s patient/Location.r patient/Location.s",
      EPIC_ALLOWED_RESOURCE_TYPES: "Encounter,Location",
    });
    const serverCapabilities: ConnectionRecord["fhirCapabilities"] = [{
      resourceType: "Encounter",
      interactions: ["search"],
      searchParameters: ["patient", "_count"],
    }, {
      resourceType: "Location",
      interactions: ["read"],
      searchParameters: [],
    }];

    for (const [scope, expected] of [
      ["patient/Encounter.s patient/Location.r", true],
      ["patient/Location.r patient/Location.s", false],
      ["patient/Encounter.s patient/Location.s", false],
    ] as const) {
      const store = new InMemoryConnectionStore();
      const service = new EpicConnectorService(config, store, { now: () => now });
      await service.initialize(false);
      await store.set(sessionA, connection(config, `account-${expected}-${scope.length}`, {
        scope,
        fhirCapabilities: serverCapabilities,
      }));
      try {
        const summary = await service.getConnectionSummary(sessionA);
        const location = summary.capabilities?.find(({ resourceType }) =>
          resourceType === "Location");
        expect(location?.search ?? false).toBe(expected);
        if (expected) {
          expect(location).toMatchObject({
            resourceType: "Location",
            read: true,
            search: true,
            searchConstraints: [],
          });
        }
      } finally {
        await service.close();
      }
    }
  });

  it("prunes an idle-expired connection before its absolute session lifetime", async () => {
    const config = makeConfig();
    const store = new InMemoryConnectionStore();
    const service = new EpicConnectorService(config, store, { now: () => now });
    await service.initialize(false);
    await store.set(sessionA, connection(config, "idle-account", {
      lastAccessAt: now - config.sessionIdleTimeoutMs,
      sessionExpiresAt: now + 60 * 60 * 1_000,
    }));

    try {
      await service.pruneExpiredConnections();
      expect(await store.get(sessionA)).toBeUndefined();
    } finally {
      await service.close();
    }
  });

  it("revokes and prunes an inactive grant after the configured scope policy changes", async () => {
    const config = makeConfig();
    const store = new InMemoryConnectionStore();
    const revoked: string[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      revoked.push(new URLSearchParams(init?.body?.toString()).get("token") ?? "");
      return jsonResponse({});
    });
    const service = new EpicConnectorService(config, store, {
      fetch: fetchMock as FetchLike,
      now: () => now,
    });
    await service.initialize(false);
    const priorResourceScopes = [
      ...config.allowedResourceScopes,
      "patient/Appointment.r",
    ];
    await store.set(sessionA, connection(config, "policy-changed-account", {
      revocationEndpoint: "https://ehr.example.test/revoke",
      consent: {
        policyVersion: config.consentPolicyVersion,
        acceptedAt: now - 1_000,
        purpose: "patient-access",
        requestedScopes: [...config.scopes],
        allowedResourceScopes: priorResourceScopes,
      },
    }));

    try {
      await service.pruneExpiredConnections();
      expect(await store.get(sessionA)).toBeUndefined();
      expect(revoked).toEqual(["access-policy-changed-account"]);
    } finally {
      await service.close();
    }
  });

  it("disconnects every in-memory session for the same verified account only", async () => {
    const config = makeConfig();
    const store = new InMemoryConnectionStore();
    const service = new EpicConnectorService(config, store, { now: () => now });
    await service.initialize(false);
    const sameAccountSession = "b".repeat(43);
    const otherSubjectSession = "c".repeat(43);
    const otherIssuerSession = "d".repeat(43);
    await store.set(sessionA, connection(config, "account-1"));
    await store.set(sameAccountSession, connection(config, "account-1", {
      accessToken: "access-same-account-second-session",
    }));
    await store.set(otherSubjectSession, connection(config, "account-2"));
    await store.set(otherIssuerSession, connection(config, "account-1", {
      oidcIssuer: "https://another-ehr.example.test/oauth2",
    }));

    try {
      await expect(service.disconnectAllForAccount(sessionA)).resolves.toEqual({
        disconnected: true,
        connectionsRemoved: 2,
        manualRevocationRecommended: true,
      });
      expect(await store.get(sessionA)).toBeUndefined();
      expect(await store.get(sameAccountSession)).toBeUndefined();
      expect(await store.get(otherSubjectSession)).toBeDefined();
      expect(await store.get(otherIssuerSession)).toBeDefined();
    } finally {
      await service.close();
    }
  });

  it("refuses a destructive action after another tab replaced the account context", async () => {
    const config = makeConfig();
    const store = new InMemoryConnectionStore();
    const service = new EpicConnectorService(config, store, { now: () => now });
    await service.initialize(false);
    const sessionB = "b".repeat(43);
    await store.set(sessionA, connection(config, "account-a"));
    await store.set(sessionB, connection(config, "account-b", {
      connectedAt: now,
      lastAccessAt: now,
    }));

    try {
      const accountAContext = (await service.getConnectionSummary(sessionA)).connectionContext;
      await expect(
        service.assertConnectionContext(sessionB, accountAContext),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "connection_context_changed",
      });
      expect(await store.get(sessionB)).toBeDefined();
    } finally {
      await service.close();
    }
  });
});
