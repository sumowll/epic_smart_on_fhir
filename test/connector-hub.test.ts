import { describe, expect, it, vi } from "vitest";

import { EpicConnectorService } from "../src/connector.js";
import {
  InMemoryFhirHubRepository,
  createFhirHubIdentity,
} from "../src/fhir-hub.js";
import { InMemoryConnectionStore } from "../src/store.js";
import type { AppConfig, ConnectionRecord, FetchLike } from "../src/types.js";
import { jsonResponse, makeConfig } from "./helpers.js";

const now = Date.parse("2026-08-25T15:00:00.000Z");
const sessionId = "q".repeat(43);

function hubConfig(): AppConfig {
  return makeConfig({
    FHIR_HUB_ENABLED: "true",
    FHIR_HUB_ENCRYPTION_KEY: Buffer.alloc(32, 10).toString("base64"),
    FHIR_HUB_IDENTITY_KEY: Buffer.alloc(32, 11).toString("base64"),
    FHIR_HUB_CONSENT_VERSION: "hub-v1",
    FHIR_HUB_RETENTION_DAYS: "90",
    EPIC_ALLOWED_RESOURCE_TYPES: "CareTeam",
    EPIC_ALLOWED_RESOURCE_SCOPES: "patient/CareTeam.r patient/CareTeam.s",
  });
}

function connection(config: AppConfig): ConnectionRecord {
  return {
    oauthClientId: config.clientId,
    tokenAuthMethod: config.tokenAuthMethod,
    fhirBaseUrl: config.fhirBaseUrl,
    tokenEndpoint: "https://ehr.example.test/token",
    accessToken: "access-token",
    tokenType: "Bearer",
    expiresAt: now + 60 * 60 * 1_000,
    scope: "patient/CareTeam.r patient/CareTeam.s",
    patientId: "patient-1",
    oidcIssuer: "https://ehr.example.test/oauth2",
    oidcSubject: "account-1",
    consent: {
      policyVersion: config.consentPolicyVersion,
      acceptedAt: now - 1_000,
      purpose: "patient-access",
      requestedScopes: [...config.scopes],
      allowedResourceScopes: [...config.allowedResourceScopes],
    },
    fhirCapabilities: [{
      resourceType: "CareTeam",
      interactions: ["read", "search"],
      searchParameters: ["patient", "status"],
    }],
    connectedAt: now - 1_000,
    lastAccessAt: now - 1_000,
    sessionExpiresAt: now + 60 * 60 * 1_000,
  };
}

function rawCareTeam(name = "My Care Team"): Record<string, unknown> {
  return {
    resourceType: "CareTeam",
    id: "team-1",
    status: "active",
    name,
    participant: [{
      role: [{ text: "Primary care" }],
      member: { reference: "Practitioner/1", display: "Dr. Example" },
    }],
  };
}

describe("EpicConnectorService private FHIR hub integration", () => {
  it("requires explicit hub consent and ingests validated reads after enabling", async () => {
    const config = hubConfig();
    const store = new InMemoryConnectionStore();
    const hub = new InMemoryFhirHubRepository();
    const fetchMock = vi.fn(async () => jsonResponse(rawCareTeam()));
    const service = new EpicConnectorService(config, store, {
      fhirHub: hub,
      fetch: fetchMock as FetchLike,
      now: () => now,
    });
    await service.initialize(false);
    const saved = connection(config);
    await store.set(sessionId, saved);
    try {
      const context = (await service.getConnectionSummary(sessionId)).connectionContext;
      expect(context).toMatch(/^[A-Za-z0-9_-]{43}$/);
      await service.readBound(sessionId, "CareTeam", "team-1", context);
      expect(await hub.list(createFhirHubIdentity(config, saved))).toEqual([]);

      await expect(service.enableFhirHubBound(sessionId, "hub-v0", context))
        .rejects.toMatchObject({ code: "fhir_hub_consent_required" });
      const enabled = await service.enableFhirHubBound(sessionId, "hub-v1", context);
      expect(enabled.value).toMatchObject({
        available: true,
        enabled: true,
        retentionDays: 90,
      });

      await service.readBound(sessionId, "CareTeam", "team-1", context);
      const resources = await service.listFhirHubResourcesBound(
        sessionId,
        { resourceType: "CareTeam" },
        context,
      );
      expect(resources.value).toHaveLength(1);
      expect(resources.value[0]).toMatchObject({
        raw: { name: "My Care Team" },
        normalizedCareTeam: { participants: [{ member: { display: "Dr. Example" } }] },
      });
      const intelligence = await service.getFhirHubIntelligenceBound(
        sessionId,
        { resourceType: "CareTeam", limit: 10 },
        context,
      );
      expect(intelligence.value).toMatchObject({
        schemaVersion: 1,
        projections: [{
          current: true,
          normalization: {
            status: "normalized",
            projection: { resourceType: "CareTeam", headline: "My Care Team" },
          },
        }],
        insights: [{ insightType: "care-team-summary", status: "generated" }],
        hasMore: false,
      });
      expect(JSON.stringify(intelligence.value)).not.toContain('"raw"');
      await expect(service.getFhirHubIntelligenceBound(
        sessionId,
        { limit: 251 },
        context,
      )).rejects.toMatchObject({ code: "invalid_hub_limit" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await service.close();
    }
  });

  it("ingests raw search entries before replacing upstream paging links", async () => {
    const config = hubConfig();
    const store = new InMemoryConnectionStore();
    const hub = new InMemoryFhirHubRepository();
    const fetchMock = vi.fn(async () => jsonResponse({
      resourceType: "Bundle",
      type: "searchset",
      entry: [{ resource: rawCareTeam() }],
      link: [{ relation: "next", url: `${config.fhirBaseUrl}/CareTeam?page=2` }],
    }));
    const service = new EpicConnectorService(config, store, {
      fhirHub: hub,
      fetch: fetchMock as FetchLike,
      now: () => now,
    });
    await service.initialize(false);
    await store.set(sessionId, connection(config));
    try {
      const context = (await service.getConnectionSummary(sessionId)).connectionContext;
      await service.enableFhirHubBound(sessionId, "hub-v1", context);
      const response = await service.searchBound(
        sessionId,
        "CareTeam",
        new URLSearchParams("status=active"),
        context,
      );
      expect(response.value).toMatchObject({
        link: [{ relation: "next" }],
      });
      expect((response.value as { link: Array<{ url: string }> }).link[0]?.url)
        .toMatch(/^\/api\/fhir-page\?cursor=/);
      const exported = await service.exportFhirHubBound(sessionId, context);
      expect(exported.value.resourceVersions).toHaveLength(1);
      expect(exported.value.resourceVersions[0]?.raw).toEqual(rawCareTeam());
    } finally {
      await service.close();
    }
  });

  it("retains hub data on disconnect but permanently removes it only after exact confirmation", async () => {
    const config = hubConfig();
    const store = new InMemoryConnectionStore();
    const hub = new InMemoryFhirHubRepository();
    const service = new EpicConnectorService(config, store, {
      fhirHub: hub,
      fetch: vi.fn(async () => jsonResponse(rawCareTeam())) as FetchLike,
      now: () => now,
    });
    await service.initialize(false);
    const saved = connection(config);
    await store.set(sessionId, saved);
    try {
      const context = (await service.getConnectionSummary(sessionId)).connectionContext;
      await service.enableFhirHubBound(sessionId, "hub-v1", context);
      await service.readBound(sessionId, "CareTeam", "team-1", context);
      const identity = createFhirHubIdentity(config, saved);
      await service.disconnect(sessionId);
      expect(await hub.list(identity)).toHaveLength(1);

      await store.set(sessionId, { ...saved, connectedAt: now + 1 });
      const newContext = (await service.getConnectionSummary(sessionId)).connectionContext;
      await expect(service.deleteFhirHubBound(sessionId, "delete", newContext))
        .rejects.toMatchObject({ code: "fhir_hub_delete_confirmation_required" });
      expect(await hub.list(identity)).toHaveLength(1);
      await expect(service.deleteFhirHubBound(
        sessionId,
        "DELETE MY HEALTH HUB",
        newContext,
      )).resolves.toMatchObject({ value: { deleted: true, resourcesDeleted: 1 } });
      expect(await hub.list(identity)).toEqual([]);
      expect(await store.get(sessionId)).toBeDefined();
    } finally {
      await service.close();
    }
  });
});
