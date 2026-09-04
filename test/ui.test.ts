import { describe, expect, it } from "vitest";

import { EPIC_CARE_PLAN_SEARCH_TYPES } from "../src/care-plan.js";
import {
  browserScript,
  renderError,
  renderHome,
  renderPrivacy,
  renderTerms,
} from "../src/ui.js";
import { makeConfig } from "./helpers.js";

const connectionContextA = "a".repeat(43);
const connectionContextB = "b".repeat(43);

class FakeElement {
  public readonly tagName: string;
  public textContent = "";
  public hidden = false;
  public disabled = false;
  public checked = false;
  public open = false;
  public required = false;
  public type = "";
  public className = "";
  public value = "";
  public focused = false;
  public options: FakeElement[] = [];
  public children: FakeElement[] = [];
  readonly #attributes = new Map<string, string>();
  readonly #listeners = new Map<string, Array<(...arguments_: unknown[]) => unknown>>();

  public constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
  }

  public addEventListener(
    type: string,
    listener: (...arguments_: unknown[]) => unknown,
  ): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  public setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value);
  }

  public removeAttribute(name: string): void {
    this.#attributes.delete(name);
  }

  public getAttribute(name: string): string | undefined {
    return this.#attributes.get(name);
  }

  public append(...children: FakeElement[]): void {
    this.children.push(...children);
    if (this.tagName === "SELECT") {
      const options = children.filter((child) => child.tagName === "OPTION");
      this.options.push(...options);
      if (!this.value && options[0]) this.value = options[0].value;
    }
  }

  public replaceChildren(...children: FakeElement[]): void {
    this.children = [];
    this.options = [];
    this.value = "";
    this.append(...children);
  }

  public async dispatch(type: string, event: unknown = {}): Promise<void> {
    for (const listener of this.#listeners.get(type) ?? []) {
      await listener(event);
    }
  }

  public focus(): void {
    this.focused = true;
  }

  public click(): void {}

  public remove(): void {}
}

interface BrowserControls {
  refreshStatus(): Promise<void>;
  refreshHubStatus(): Promise<void>;
  runDataRequest(path: string, label: string): Promise<void>;
  disconnectCurrentConnection(): Promise<void>;
}

interface BrowserHarness {
  readonly controls: BrowserControls;
  readonly elements: Readonly<Record<string, FakeElement>>;
  readonly clipboardWrites: () => readonly string[];
  readonly dispatchDocumentEvent: (type: string, event?: unknown) => Promise<void>;
  readonly dispatchWindowEvent: (type: string, event?: unknown) => Promise<void>;
  readonly navigationUrl: () => string | undefined;
  readonly setVisibilityState: (state: "hidden" | "visible") => void;
}

function jsonResponse(
  value: unknown,
  status = 200,
  connectionContext = connectionContextA,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json");
  headers.set("X-Epic-Connection-Context", connectionContext);
  return new Response(JSON.stringify(value), {
    status,
    headers,
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createBrowserHarness(
  fetchImplementation: (path: string, options?: RequestInit) => Promise<Response>,
  hubConfigured = false,
  clipboardWriteImplementation?: (value: string) => Promise<void>,
): BrowserHarness {
  const selectors = [
    "#status",
    "#connect-form",
    "#connect",
    "#legal-consent",
    "#legal-consent-checkbox",
    "#policy-version",
    "#disconnect",
    "#notice",
    "#explorer",
    "#result",
    "#result-status",
    "#result-error",
    "#temporal-graph",
    "#temporal-graph-summary",
    "#temporal-graph-list",
    "#temporal-graph-order",
    "#result-list",
    "#response-trace",
    "#response-trace-source",
    "#response-trace-connector",
    "#response-trace-display",
    "#response-trace-reference",
    "#field-check-form",
    "#field-check-path",
    "#field-check",
    "#field-check-result",
    "#advanced-result",
    "#copy-resources",
    "#copy-resources-status",
    "#pagination-controls",
    "#patient",
    "#search-form",
    "#search",
    "#resource-type",
    "#resource-id-control",
    "#resource-id",
    "#careplan-type-control",
    "#careplan-type",
    "#careplan-type-hint",
    "#search-constraints",
    "#search-constraint-fields",
    "#search-constraint-hint",
    "#capability-notice",
    "#count-label",
    "#count",
    "#granted-access",
    "#granted-scope-count",
    "#granted-scopes",
    "#scope-warning",
    "#health-hub",
    "#hub-configured",
    "#hub-policy-version",
    "#hub-status",
    "#hub-error",
    "#hub-enable-panel",
    "#hub-consent-checkbox",
    "#hub-enable",
    "#hub-controls",
    "#hub-counts",
    "#hub-refresh",
    "#hub-intelligence",
    "#hub-resources",
    "#hub-export",
    "#hub-delete-stage",
    "#hub-delete-panel",
    "#hub-delete-checkbox",
    "#hub-confirm-delete",
    "#hub-cancel-delete",
    "#hub-intelligence-view",
    "#hub-projections",
    "#hub-insights",
    "#hub-advanced-result",
    "#hub-result",
  ] as const;
  const elements = Object.fromEntries(
    selectors.map((selector) => [selector, new FakeElement()]),
  ) as Record<(typeof selectors)[number], FakeElement>;
  const conditionOption = new FakeElement("option");
  conditionOption.value = "Condition";
  conditionOption.textContent = "Conditions and health concerns";
  const carePlanOption = new FakeElement("option");
  carePlanOption.value = "CarePlan";
  carePlanOption.textContent = "Care plans";
  const observationOption = new FakeElement("option");
  observationOption.value = "Observation";
  observationOption.textContent = "Labs, vital signs, and observations";
  const provenanceOption = new FakeElement("option");
  provenanceOption.value = "Provenance";
  provenanceOption.textContent = "Record sources";
  provenanceOption.setAttribute("data-interaction", "read");
  const profileGroup = new FakeElement("optgroup");
  profileGroup.setAttribute("label", "Profile and care");
  profileGroup.append(carePlanOption, conditionOption);
  const resultsGroup = new FakeElement("optgroup");
  resultsGroup.setAttribute("label", "Results");
  resultsGroup.append(observationOption);
  const recordHistoryGroup = new FakeElement("optgroup");
  recordHistoryGroup.setAttribute("label", "Record history");
  recordHistoryGroup.append(provenanceOption);
  elements["#resource-type"].value = "Observation";
  elements["#resource-type"].children = [profileGroup, resultsGroup, recordHistoryGroup];
  elements["#resource-type"].options = [
    carePlanOption,
    conditionOption,
    observationOption,
    provenanceOption,
  ];
  const carePlanPlaceholder = new FakeElement("option");
  carePlanPlaceholder.value = "";
  carePlanPlaceholder.textContent = "Choose a care plan type";
  const carePlanTypeOptions = EPIC_CARE_PLAN_SEARCH_TYPES.map((type) => {
    const option = new FakeElement("option");
    option.value = type.category;
    option.textContent = `${type.label} — ${type.description}`;
    return option;
  });
  elements["#careplan-type"].children = [carePlanPlaceholder, ...carePlanTypeOptions];
  elements["#careplan-type"].options = [carePlanPlaceholder, ...carePlanTypeOptions];
  elements["#careplan-type"].value = "";
  elements["#count"].value = "20";
  elements["#legal-consent-checkbox"].value = "accepted";
  elements["#policy-version"].value = "2026-08-23";
  elements["#hub-configured"].value = hubConfigured ? "true" : "false";
  elements["#hub-policy-version"].value = "hub-policy-v1";

  type EventListener = (...arguments_: unknown[]) => unknown;
  const documentListeners = new Map<string, EventListener[]>();
  const windowListeners = new Map<string, EventListener[]>();
  const addListener = (
    listenersByType: Map<string, EventListener[]>,
    type: string,
    listener: EventListener,
  ): void => {
    const listeners = listenersByType.get(type) ?? [];
    listeners.push(listener);
    listenersByType.set(type, listeners);
  };
  const dispatchListeners = async (
    listenersByType: Map<string, EventListener[]>,
    type: string,
    event: unknown = {},
  ): Promise<void> => {
    for (const listener of listenersByType.get(type) ?? []) {
      await listener(event);
    }
  };

  const document = {
    body: new FakeElement("body"),
    querySelector(selector: string): FakeElement {
      const element = elements[selector as keyof typeof elements];
      if (!element) throw new Error(`Unexpected selector in browser test: ${selector}`);
      return element;
    },
    createElement(tagName: string): FakeElement {
      return new FakeElement(tagName);
    },
    addEventListener(type: string, listener: EventListener): void {
      addListener(documentListeners, type, listener);
    },
    visibilityState: "visible" as "hidden" | "visible",
  };
  let navigationUrl: string | undefined;
  const window = {
    location: {
      origin: "https://connector.example.test",
      assign(value: string): void {
        navigationUrl = value;
      },
    },
    addEventListener(type: string, listener: EventListener): void {
      addListener(windowListeners, type, listener);
    },
  };
  const clipboardWrites: string[] = [];
  const navigator = {
    clipboard: {
      async writeText(value: string): Promise<void> {
        if (clipboardWriteImplementation) await clipboardWriteImplementation(value);
        clipboardWrites.push(value);
      },
    },
  };
  const sourceWithoutStartup = browserScript.replace(/\nvoid refreshStatus\(\);\n$/, "\n");
  const controls = new Function(
    "document",
    "fetch",
    "window",
    "AbortController",
    "navigator",
    `${sourceWithoutStartup}; return { refreshStatus, refreshHubStatus, runDataRequest, disconnectCurrentConnection };`,
  )(
    document,
    fetchImplementation,
    window,
    AbortController,
    navigator,
  ) as BrowserControls;

  return {
    controls,
    elements,
    clipboardWrites: () => clipboardWrites,
    dispatchDocumentEvent: (type, event) => dispatchListeners(documentListeners, type, event),
    dispatchWindowEvent: (type, event) => dispatchListeners(windowListeners, type, event),
    navigationUrl: () => navigationUrl,
    setVisibilityState: (state) => {
      document.visibilityState = state;
    },
  };
}

function cardDetails(card: FakeElement | undefined): ReadonlyMap<string, string> {
  const details = new Map<string, string>();
  const list = card?.children.find((child) => child.tagName === "DL");
  if (!list) return details;
  for (let index = 0; index + 1 < list.children.length; index += 2) {
    const term = list.children[index];
    const description = list.children[index + 1];
    if (term?.tagName === "DT" && description?.tagName === "DD") {
      details.set(term.textContent, description.textContent);
    }
  }
  return details;
}

describe("legal pages", () => {
  it("renders a safe callback support reference", () => {
    const html = renderError("Authorization failed.", {
      requestId: "request-123",
      errorCode: "authorization_cleanup_required",
    });

    expect(html).toContain("request-123");
    expect(html).toContain("authorization_cleanup_required");
    expect(html).not.toContain("code=");
  });

  it("links the legal pages before the authorization action", () => {
    const html = renderHome(makeConfig());
    const authorizationAction = html.indexOf('action="/auth/start"');

    expect(html.indexOf('href="/terms"')).toBeGreaterThan(-1);
    expect(html.indexOf('href="/privacy"')).toBeGreaterThan(-1);
    expect(html.indexOf('href="/terms"')).toBeLessThan(authorizationAction);
    expect(html.indexOf('href="/privacy"')).toBeLessThan(authorizationAction);
    expect(html).toContain('id="legal-consent-checkbox"');
    expect(html).toContain('name="consent" value="accepted"');
    expect(html).toContain('name="policyVersion" type="hidden" value="2026-08-23"');
    expect(html).toContain("after 30 minutes of inactivity or 8 hours at the latest");
    expect(html).toContain('id="connect" type="submit" disabled');
    expect(html).toContain('id="granted-access"');
    expect(html.indexOf('id="granted-access"')).toBeLessThan(html.indexOf('id="search-form"'));
    expect(html).toContain('<optgroup label="Profile and care">');
    expect(html).toContain('<optgroup label="Results">');
    expect(html).toContain('Conditions and health concerns');
    expect(html).toContain('Labs, vital signs, and observations');
    expect(html).toContain('<label for="careplan-type">Care plan type</label>');
    expect(html).toContain('<option value="38717003">Longitudinal — ongoing care plan</option>');
    expect(html).toContain('<option value="734163000">Encounter-level — visit assessment and plan</option>');
    expect(html).toContain('<option value="736271009">Outpatient — ambulatory care plan</option>');
    expect(html).toContain('<option value="738906000">Dental — dental treatment plan</option>');
    expect(html).toContain('<option value="assess-plan">Outside record — imported assessment and plan</option>');
    expect(html).toContain('Response trace: where information can go missing');
    expect(html).toContain('id="field-check-form"');
    expect(html).toContain('Advanced: complete application FHIR JSON');
    expect(html).toContain('id="copy-resources"');
    expect(html).toContain('id="copy-resources-status"');
    expect(html).toContain('id="result-list"');
    expect(html).toContain(
      '<button id="patient" class="secondary" type="button" hidden disabled>View profile</button>',
    );
    expect(html).toContain('id="temporal-graph"');
    expect(html).toContain('id="temporal-graph-list"');
    expect(html).toContain('id="temporal-graph-order"');
    expect(html).toContain('aria-controls="temporal-graph-list"');
    expect(html).toContain('id="temporal-graph-summary" class="hint" aria-live="polite"');
    expect(html).toContain("Health event timeline");
    expect(html).toContain('id="pagination-controls"');
    expect(html).toContain('id="health-hub"');
    expect(html).toContain('id="hub-configured" type="hidden" value="false"');
    expect(html).toContain('id="hub-intelligence"');
    expect(html).toContain('id="hub-resources"');
    expect(html).toContain("does not delete health data you chose to retain");
    expect(html).toContain("Permanently delete my hub");
    expect(browserScript).toContain("connection.scope");
    expect(browserScript).toContain("error.status = response.status");
    expect(browserScript).not.toContain("connection.patientId");
    expect(browserScript).not.toContain("connection.fhirBaseUrl");
    expect(() => new Function(browserScript)).not.toThrow();
  });

  it("recognizes Epic SMART v1, v2, legacy, wildcard, and granular resource scopes", () => {
    const start = browserScript.indexOf("function isFhirResourceScope");
    const end = browserScript.indexOf("\n}\n", start) + 2;
    const source = browserScript.slice(start, end);
    const classify = new Function(`${source}; return isFhirResourceScope;`)() as (scope: string) => boolean;

    expect(classify("patient/Observation.read")).toBe(true);
    expect(classify("patient/DiagnosticReport.rs")).toBe(true);
    expect(classify("patient/*.read")).toBe(true);
    expect(classify("user/Observation.*")).toBe(true);
    expect(classify("patient/Observation.rs?category=laboratory")).toBe(true);
    expect(classify("Patient.search")).toBe(true);
    expect(classify("launch/patient")).toBe(false);
    expect(classify("openid")).toBe(false);
    expect(classify("patient/Observation.sr")).toBe(false);
    expect(classify("patient/Observation.rrrr")).toBe(false);
    expect(classify("patient/Observation!.read")).toBe(false);
    expect(classify("profile.read")).toBe(false);
  });

  it("keeps Binary attachments out of generic search", () => {
    const html = renderHome(makeConfig({
      EPIC_ALLOWED_RESOURCE_TYPES: "Binary,Observation",
    }));

    expect(html).not.toContain('<option value="Binary">');
    expect(html).toContain('<option value="Observation">Labs, vital signs, and observations</option>');
    expect(html).toContain(
      "Binary attachment access is disabled until a verified document-reference workflow is available.",
    );
  });

  it("marks Provenance as a read-by-ID resource choice", () => {
    const html = renderHome(makeConfig({
      EPIC_ALLOWED_RESOURCE_TYPES: "Provenance",
    }));

    expect(html).toContain('<optgroup label="Record history">');
    expect(html).toContain(
      '<option value="Provenance" data-interaction="read">Record sources</option>',
    );
    expect(html).toContain('<label for="resource-id">FHIR resource ID</label>');
    expect(html).toContain('id="resource-id" type="text" pattern="[A-Za-z0-9.-]{1,64}"');
  });

  it("exposes only read and search actions in the effective server capability list", async () => {
    const harness = createBrowserHarness(async (path) => {
      if (path !== "/api/connection") throw new Error(`Unexpected request: ${path}`);
      return jsonResponse({
        connected: true,
        provider: "Example Health",
        connectionContext: connectionContextA,
        connectedAt: "2026-08-24T20:00:00.000Z",
        scope: ["patient/Patient.s", "patient/Condition.r", "patient/Observation.s"],
        capabilities: [
          { resourceType: "Patient", read: false, search: true, searchConstraints: [] },
          { resourceType: "Condition", read: true, readConstraintAlternatives: [[]], search: false, searchConstraints: [] },
          { resourceType: "Observation", read: false, search: true, searchConstraints: [] },
        ],
      });
    });

    await harness.controls.refreshStatus();
    const condition = harness.elements["#resource-type"].options.find(
      (option) => option.value === "Condition",
    )!;
    const observation = harness.elements["#resource-type"].options.find(
      (option) => option.value === "Observation",
    )!;

    expect(harness.elements["#patient"].hidden).toBe(true);
    expect(harness.elements["#patient"].disabled).toBe(true);
    expect(condition.hidden).toBe(true);
    expect(condition.disabled).toBe(true);
    expect(observation.hidden).toBe(false);
    expect(observation.disabled).toBe(false);
    const recordHistoryGroup = harness.elements["#resource-type"].children.find(
      (group) => group.getAttribute("label") === "Record history",
    )!;
    expect(recordHistoryGroup.hidden).toBe(true);
    expect(recordHistoryGroup.disabled).toBe(true);
    expect(harness.elements["#resource-type"].value).toBe("Observation");
    expect(harness.elements["#search-form"].hidden).toBe(false);
    expect(harness.elements["#search"].disabled).toBe(false);
  });

  it("shows Patient read without offering searches that were not granted", async () => {
    const harness = createBrowserHarness(async (path) => {
      if (path !== "/api/connection") throw new Error(`Unexpected request: ${path}`);
      return jsonResponse({
        connected: true,
        provider: "Example Health",
        connectionContext: connectionContextA,
        connectedAt: "2026-08-24T20:00:00.000Z",
        scope: ["patient/Patient.r"],
        capabilities: [
          { resourceType: "Patient", read: true, readConstraintAlternatives: [[]], search: false, searchConstraints: [] },
        ],
      });
    });

    await harness.controls.refreshStatus();

    expect(harness.elements["#patient"].hidden).toBe(false);
    expect(harness.elements["#patient"].disabled).toBe(false);
    expect(harness.elements["#search-form"].hidden).toBe(true);
    expect(harness.elements["#search"].disabled).toBe(true);
    expect(harness.elements["#capability-notice"].hidden).toBe(true);
  });

  it("reads read-only Provenance by ID and exposes its raw FHIR JSON", async () => {
    const provenance = {
      resourceType: "Provenance",
      id: "provenance-1",
      target: [{ reference: "Observation/lab-1" }],
      recorded: "2026-08-29T14:30:00Z",
      activity: { text: "Transmitted" },
      agent: [{ who: { reference: "Organization/lab-organization" } }],
    };
    let requestedPath = "";
    let requestHeaders = new Headers();
    let readRequests = 0;
    const harness = createBrowserHarness(async (path, options) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/Provenance.r"],
          capabilities: [{
            resourceType: "Provenance",
            read: true,
            readConstraintAlternatives: [[]],
            search: false,
            searchConstraints: [],
          }],
        });
      }
      readRequests += 1;
      requestedPath = path;
      requestHeaders = new Headers(options?.headers);
      return jsonResponse(provenance);
    });

    await harness.controls.refreshStatus();

    const provenanceOption = harness.elements["#resource-type"].options.find(
      (option) => option.value === "Provenance",
    )!;
    const recordHistoryGroup = harness.elements["#resource-type"].children.find(
      (group) => group.getAttribute("label") === "Record history",
    )!;
    expect(provenanceOption.hidden).toBe(false);
    expect(provenanceOption.disabled).toBe(false);
    expect(recordHistoryGroup.hidden).toBe(false);
    expect(recordHistoryGroup.disabled).toBe(false);
    expect(harness.elements["#resource-type"].value).toBe("Provenance");
    expect(harness.elements["#search-form"].hidden).toBe(false);
    expect(harness.elements["#resource-id-control"].hidden).toBe(false);
    expect(harness.elements["#resource-id"].required).toBe(true);
    expect(harness.elements["#resource-id"].disabled).toBe(false);
    expect(harness.elements["#count-label"].hidden).toBe(true);
    expect(harness.elements["#count"].hidden).toBe(true);
    expect(harness.elements["#count"].disabled).toBe(true);
    expect(harness.elements["#search"].textContent).toBe("View record");

    harness.elements["#resource-id"].value = "bad/id";
    await harness.elements["#search-form"].dispatch("submit", {
      preventDefault(): void {},
    });
    expect(readRequests).toBe(0);
    expect(harness.elements["#result-error"].textContent).toContain("valid FHIR resource ID");

    harness.elements["#resource-id"].value = "provenance-1";
    await harness.elements["#search-form"].dispatch("submit", {
      preventDefault(): void {},
    });

    expect(readRequests).toBe(1);
    expect(requestedPath).toBe("/api/fhir/Provenance/provenance-1");
    expect(requestHeaders.get("X-Epic-Expected-Connection-Context")).toBe(connectionContextA);
    expect(harness.elements["#advanced-result"].hidden).toBe(false);
    expect(harness.elements["#result"].textContent).toBe(JSON.stringify(provenance, null, 2));
    expect(harness.elements["#result-status"].textContent).toContain("Record sources loaded");
  });

  it.each(EPIC_CARE_PLAN_SEARCH_TYPES)(
    "submits the Epic category for the $label CarePlan choice",
    async ({ category, label, description }) => {
      let requestedPath = "";
      let requestHeaders = new Headers();
      const harness = createBrowserHarness(async (path, options) => {
        if (path === "/api/connection") {
          return jsonResponse({
            connected: true,
            provider: "Example Health",
            connectionContext: connectionContextA,
            connectedAt: "2026-08-24T20:00:00.000Z",
            scope: ["patient/CarePlan.s"],
            capabilities: [{
              resourceType: "CarePlan",
              read: false,
              search: true,
              searchConstraints: [],
            }],
          });
        }
        requestedPath = path;
        requestHeaders = new Headers(options?.headers);
        return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [] });
      });

      await harness.controls.refreshStatus();

      expect(harness.elements["#resource-type"].value).toBe("CarePlan");
      expect(harness.elements["#careplan-type-control"].hidden).toBe(false);
      expect(harness.elements["#careplan-type"].required).toBe(true);
      expect(harness.elements["#careplan-type"].disabled).toBe(false);
      expect(harness.elements["#search-constraints"].hidden).toBe(true);
      expect(harness.elements["#careplan-type"].options.map((option) => option.textContent)).toContain(
        `${label} — ${description}`,
      );

      harness.elements["#careplan-type"].value = category;
      await harness.elements["#search-form"].dispatch("submit", {
        preventDefault(): void {},
      });

      const requested = new URL(requestedPath, "https://connector.example.test");
      expect(requested.pathname).toBe("/api/fhir/CarePlan");
      expect(requested.searchParams.get("_count")).toBe("20");
      expect(requested.searchParams.getAll("category")).toEqual([category]);
      expect(requestHeaders.get("X-Epic-Expected-Connection-Context")).toBe(connectionContextA);
    },
  );

  it("requires a CarePlan type before issuing a search", async () => {
    let carePlanRequests = 0;
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/CarePlan.s"],
          capabilities: [{
            resourceType: "CarePlan",
            read: false,
            search: true,
            searchConstraints: [],
          }],
        });
      }
      carePlanRequests += 1;
      return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [] });
    });

    await harness.controls.refreshStatus();
    await harness.elements["#search-form"].dispatch("submit", {
      preventDefault(): void {},
    });

    expect(carePlanRequests).toBe(0);
    expect(harness.elements["#result-error"].textContent).toContain("Choose a care plan type");
  });

  it("renders friendly constrained-search choices and submits the exact authorized value", async () => {
    const laboratory = "http://terminology.hl7.org/CodeSystem/observation-category|laboratory";
    const socialHistory = "http://terminology.hl7.org/CodeSystem/observation-category|social-history";
    const vitalSigns = "http://terminology.hl7.org/CodeSystem/observation-category|vital-signs";
    let requestedPath = "";
    let requestHeaders = new Headers();
    const harness = createBrowserHarness(async (path, options) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/Observation.s?category=authorized"],
          capabilities: [{
            resourceType: "Observation",
            read: false,
            search: true,
            searchConstraints: [{
              name: "category",
              values: [laboratory, socialHistory, vitalSigns],
            }],
          }],
        });
      }
      requestedPath = path;
      requestHeaders = new Headers(options?.headers);
      return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [] });
    });

    await harness.controls.refreshStatus();
    const field = harness.elements["#search-constraint-fields"].children[0]!;
    const label = field.children[0]!;
    const select = field.children[1]!;

    expect(harness.elements["#search-constraints"].hidden).toBe(false);
    expect(label.textContent).toBe("Category");
    expect(select.options.map((option) => option.textContent)).toEqual([
      "Laboratory results",
      "Social history",
      "Vital signs",
    ]);
    select.value = vitalSigns;
    await harness.elements["#search-form"].dispatch("submit", {
      preventDefault(): void {},
    });

    const requested = new URL(requestedPath, "https://connector.example.test");
    expect(requested.pathname).toBe("/api/fhir/Observation");
    expect(requested.searchParams.get("_count")).toBe("20");
    expect(requested.searchParams.get("category")).toBe(vitalSigns);
    expect(requestHeaders.get("X-Epic-Expected-Connection-Context")).toBe(connectionContextA);
    expect(harness.elements["#result"].textContent).toContain('"type": "searchset"');
  });

  it("preserves API choices and results when the same connection is revalidated", async () => {
    const laboratory = "http://terminology.hl7.org/CodeSystem/observation-category|laboratory";
    const vitalSigns = "http://terminology.hl7.org/CodeSystem/observation-category|vital-signs";
    let statusChecks = 0;
    let fhirRequests = 0;
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        statusChecks += 1;
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/Observation.s?category=authorized"],
          capabilities: [{
            resourceType: "Observation",
            read: false,
            search: true,
            searchConstraints: [{
              name: "category",
              values: [laboratory, vitalSigns],
            }],
          }],
        });
      }
      if (path.startsWith("/api/fhir/Observation?")) {
        fhirRequests += 1;
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          entry: [{
            resource: {
              resourceType: "Observation",
              id: "observation-preserved",
              valueString: "Preserved result",
            },
          }],
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    const initialConstraint = harness.elements["#search-constraint-fields"].children[0]!.children[1]!;
    initialConstraint.value = vitalSigns;
    harness.elements["#count"].value = "50";
    await harness.elements["#search-form"].dispatch("submit", {
      preventDefault(): void {},
    });

    expect(harness.elements["#result"].textContent).toContain("Preserved result");
    expect(harness.elements["#temporal-graph"].hidden).toBe(false);
    harness.elements["#advanced-result"].open = true;
    harness.setVisibilityState("hidden");
    await harness.dispatchDocumentEvent("visibilitychange");

    expect(harness.elements["#explorer"].hidden).toBe(true);
    expect(harness.elements["#result"].textContent).toContain("Preserved result");
    expect(harness.elements["#advanced-result"].open).toBe(false);

    harness.setVisibilityState("visible");
    await harness.dispatchDocumentEvent("visibilitychange");
    await harness.dispatchWindowEvent("focus");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const refreshedConstraint = harness.elements["#search-constraint-fields"].children[0]!.children[1]!;
    expect(statusChecks).toBe(2);
    expect(fhirRequests).toBe(1);
    expect(harness.elements["#explorer"].hidden).toBe(false);
    expect(harness.elements["#resource-type"].value).toBe("Observation");
    expect(harness.elements["#count"].value).toBe("50");
    expect(refreshedConstraint.value).toBe(vitalSigns);
    expect(harness.elements["#result"].textContent).toContain("Preserved result");
    expect(harness.elements["#advanced-result"].hidden).toBe(false);

    await harness.dispatchWindowEvent("pagehide");
    expect(harness.elements["#explorer"].hidden).toBe(true);
    expect(harness.elements["#resource-type"].value).toBe("");
    expect(harness.elements["#result"].textContent).toBe("");
    expect(harness.elements["#advanced-result"].hidden).toBe(true);
    expect(harness.elements["#temporal-graph"].hidden).toBe(true);
    expect(harness.elements["#temporal-graph-list"].children).toHaveLength(0);
  });

  it("copies the exact raw FHIR JSON displayed in Advanced", async () => {
    const response = {
      resourceType: "Bundle",
      type: "searchset",
      entry: [{
        resource: {
          resourceType: "Observation",
          id: "observation-1",
          valueString: "Sensitive result",
        },
      }],
    };
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/Observation.s"],
          capabilities: [
            { resourceType: "Observation", read: false, search: true, searchConstraints: [] },
          ],
        });
      }
      if (path === "/raw-fhir") return jsonResponse(response);
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    expect(harness.elements["#copy-resources"].disabled).toBe(true);
    await harness.controls.runDataRequest("/raw-fhir", "Observations");

    const displayedJson = JSON.stringify(response, null, 2);
    expect(harness.elements["#result"].textContent).toBe(displayedJson);
    expect(harness.elements["#copy-resources"].disabled).toBe(false);
    await harness.elements["#copy-resources"].dispatch("click");

    expect(harness.clipboardWrites()).toEqual([displayedJson]);
    expect(harness.elements["#copy-resources-status"].textContent).toBe(
      "Application FHIR JSON copied to your clipboard.",
    );
    expect(harness.elements["#copy-resources"].disabled).toBe(false);
  });

  it("traces a direct Epic response and classifies present, UI-only, and source-absent fields", async () => {
    const response = {
      resourceType: "Observation",
      id: "observation-1",
      status: "final",
      code: { text: "Example result" },
      valueQuantity: { value: 7, unit: "mg" },
      extension: [{ url: "https://example.test/fhir/StructureDefinition/example", valueString: "kept" }],
    };
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/Observation.r"],
          capabilities: [{
            resourceType: "Observation",
            read: true,
            readConstraintAlternatives: [[]],
            search: false,
            searchConstraints: [],
          }],
        });
      }
      if (path === "/trace-fhir") {
        return jsonResponse(response, 200, connectionContextA, {
          "X-Request-ID": "request-trace-1",
          "X-Moonba-FHIR-Source": "epic",
          "X-Moonba-FHIR-Interaction": "read",
          "X-Moonba-FHIR-Resource-Type": "Observation",
          "X-Moonba-FHIR-Resource-Fields": "preserved",
          "X-Moonba-FHIR-Transforms": "json-parsed,validated",
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    await harness.controls.runDataRequest("/trace-fhir", "Example observation");

    expect(harness.elements["#response-trace"].hidden).toBe(false);
    expect(harness.elements["#response-trace-source"].textContent).toContain(
      "Epic returned this Observation resource",
    );
    expect(harness.elements["#response-trace-connector"].textContent).toContain(
      "preserved every field",
    );
    expect(harness.elements["#response-trace-display"].textContent).toContain(
      "selective summary",
    );
    expect(harness.elements["#response-trace-reference"].textContent).toContain("HTTP 200");
    expect(harness.elements["#response-trace-reference"].textContent).toContain("request-trace-1");
    expect(harness.elements["#result"].textContent).toContain('"extension"');
    expect([...cardDetails(harness.elements["#result-list"].children[0]).values()].join(" ")).not.toContain(
      "https://example.test/fhir/StructureDefinition/example",
    );

    harness.elements["#field-check-path"].value = "extension";
    await harness.elements["#field-check-form"].dispatch("submit", {
      preventDefault(): void {},
    });
    expect(harness.elements["#field-check-result"].textContent).toContain("It reached this browser");
    expect(harness.elements["#field-check-result"].textContent).toContain("UI summary omitted it");
    expect(harness.elements["#field-check-result"].textContent).not.toContain("kept");

    harness.elements["#field-check-path"].value = "referenceRange.low.value";
    await harness.elements["#field-check-form"].dispatch("submit", {
      preventDefault(): void {},
    });
    expect(harness.elements["#field-check-result"].textContent).toContain(
      "Epic did not include this field or path in this read response",
    );

    await harness.dispatchWindowEvent("pagehide");
    expect(harness.elements["#response-trace"].hidden).toBe(true);
    expect(harness.elements["#response-trace-source"].textContent).toBe("");
    expect(harness.elements["#field-check-result"].textContent).toBe("");
  });

  it("explains search transformations and keeps search absence scoped to the current page", async () => {
    const response = {
      resourceType: "Bundle",
      type: "searchset",
      link: [{ relation: "next", url: "/api/fhir-page?cursor=safe" }],
      entry: [{
        resource: {
          resourceType: "Observation",
          id: "observation-1",
          component: [{ valueQuantity: { value: 120, unit: "mmHg" } }],
        },
      }],
    };
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/Observation.s"],
          capabilities: [{ resourceType: "Observation", read: false, search: true, searchConstraints: [] }],
        });
      }
      if (path === "/search-trace") {
        return jsonResponse(response, 200, connectionContextA, {
          "X-Request-ID": "request-search-1",
          "X-Moonba-FHIR-Source": "epic",
          "X-Moonba-FHIR-Interaction": "search",
          "X-Moonba-FHIR-Resource-Type": "Observation",
          "X-Moonba-FHIR-Resource-Fields": "preserved",
          "X-Moonba-FHIR-Transforms": "json-parsed,validated,bundle-links-rewritten",
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    await harness.controls.runDataRequest("/search-trace", "Observations");

    expect(harness.elements["#response-trace-source"].textContent).toContain(
      "Epic returned this Observation search page",
    );
    expect(harness.elements["#response-trace-connector"].textContent).toContain(
      "replaced Epic’s Bundle navigation links",
    );
    harness.elements["#field-check-path"].value = "component.valueQuantity.value";
    await harness.elements["#field-check-form"].dispatch("submit", {
      preventDefault(): void {},
    });
    expect(harness.elements["#field-check-result"].textContent).toContain("Found");

    harness.elements["#field-check-path"].value = "referenceRange.low.value";
    await harness.elements["#field-check-form"].dispatch("submit", {
      preventDefault(): void {},
    });
    expect(harness.elements["#field-check-result"].textContent).toContain(
      "not present in any resource on this Epic search page",
    );
    expect(harness.elements["#field-check-result"].textContent).toContain(
      "filters, the current grant, result limits, or another page",
    );
  });

  it("identifies connector-derived and incomplete Location responses", async () => {
    const response = {
      resourceType: "Bundle",
      type: "searchset",
      entry: [{
        resource: {
          resourceType: "Location",
          id: "location-1",
          name: "Example clinic",
          address: { city: "Example City" },
        },
      }, {
        resource: {
          resourceType: "OperationOutcome",
          issue: [{ severity: "warning", code: "incomplete" }],
        },
        search: { mode: "outcome" },
      }],
    };
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/Encounter.s", "patient/Location.r"],
          capabilities: [],
        });
      }
      if (path === "/location-trace") {
        return jsonResponse(response, 200, connectionContextA, {
          "X-Request-ID": "request-location-1",
          "X-Moonba-FHIR-Source": "connector-derived",
          "X-Moonba-FHIR-Interaction": "search",
          "X-Moonba-FHIR-Resource-Type": "Location",
          "X-Moonba-FHIR-Resource-Fields": "preserved",
          "X-Moonba-FHIR-Transforms": "json-parsed,validated,derived-from-encounter-references,bundle-generated",
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    await harness.controls.runDataRequest("/location-trace", "Care locations");

    expect(harness.elements["#response-trace-source"].textContent).toContain(
      "not a direct Epic Location search response",
    );
    expect(harness.elements["#response-trace-connector"].textContent).toContain(
      "generated the Bundle",
    );
    expect(harness.elements["#response-trace-connector"].textContent).toContain("incomplete");
    expect(harness.elements["#response-trace-display"].textContent).toContain(
      "expands every top-level field",
    );
    harness.elements["#field-check-path"].value = "hoursOfOperation";
    await harness.elements["#field-check-form"].dispatch("submit", {
      preventDefault(): void {},
    });
    expect(harness.elements["#field-check-result"].textContent).toContain(
      "not present in this connector-derived response",
    );
    expect(harness.elements["#field-check-result"].textContent).toContain(
      "does not prove that Epic lacks",
    );
  });

  it("keeps included Provenance in Advanced but out of primary counts and the timeline", async () => {
    const response = {
      resourceType: "Bundle",
      type: "searchset",
      entry: [{
        resource: {
          resourceType: "Observation",
          id: "observation-1",
          effectiveDateTime: "2026-08-29T14:00:00Z",
          valueString: "Primary clinical result",
        },
        search: { mode: "match" },
      }, {
        resource: {
          resourceType: "Provenance",
          id: "provenance-1",
          target: [{ reference: "Observation/observation-1" }],
          recorded: "2026-08-29T14:30:00Z",
          agent: [{ who: { display: "Example Health" } }],
        },
        search: { mode: "include" },
      }],
    };
    let requestedPath = "";
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/Observation.s", "patient/Provenance.r"],
          capabilities: [
            { resourceType: "Observation", read: false, search: true, searchConstraints: [] },
          ],
        });
      }
      requestedPath = path;
      return jsonResponse(response);
    });

    await harness.controls.refreshStatus();
    await harness.elements["#search-form"].dispatch("submit", {
      preventDefault(): void {},
    });

    const requested = new URL(requestedPath, "https://app.example.test");
    expect(requested.searchParams.has("_revinclude")).toBe(false);
    expect(harness.elements["#result"].textContent).toBe(JSON.stringify(response, null, 2));
    expect(harness.elements["#advanced-result"].hidden).toBe(false);
    expect(harness.elements["#result-status"].textContent).toContain("Page 1 contains 1 record");
    expect(harness.elements["#result-status"].textContent).toContain("Epic included 1 record source");
    expect(harness.elements["#temporal-graph-list"].children).toHaveLength(1);
    expect(harness.elements["#result-list"].children.some((child) =>
      child.textContent.includes("Open Advanced to review the full Provenance details"))).toBe(true);
  });

  it("announces clipboard failures and keeps the raw JSON available", async () => {
    const harness = createBrowserHarness(
      async (path) => {
        if (path === "/api/connection") {
          return jsonResponse({
            connected: true,
            provider: "Example Health",
            connectionContext: connectionContextA,
            connectedAt: "2026-08-24T20:00:00.000Z",
            scope: ["patient/Patient.r"],
            capabilities: [{
              resourceType: "Patient",
              read: true,
              readConstraintAlternatives: [[]],
              search: false,
              searchConstraints: [],
            }],
          });
        }
        if (path === "/api/patient") {
          return jsonResponse({ resourceType: "Patient", id: "patient-1" });
        }
        throw new Error(`Unexpected request: ${path}`);
      },
      false,
      async () => {
        throw new Error("Clipboard permission denied");
      },
    );

    await harness.controls.refreshStatus();
    await harness.controls.runDataRequest("/api/patient", "Patient profile");
    const displayedJson = harness.elements["#result"].textContent;
    await harness.elements["#copy-resources"].dispatch("click");

    expect(harness.clipboardWrites()).toEqual([]);
    expect(harness.elements["#copy-resources-status"].textContent).toBe(
      "Could not copy. Select the application JSON and copy it manually.",
    );
    expect(harness.elements["#result"].textContent).toBe(displayedJson);
    expect(harness.elements["#copy-resources"].disabled).toBe(false);
  });

  it("renders readable record cards and offers detail reads only when granted", async () => {
    const requestedPaths: string[] = [];
    let detailReads = 0;
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/Observation.r", "patient/Observation.s"],
          capabilities: [{
            resourceType: "Observation",
            read: true,
            readConstraintAlternatives: [[]],
            search: true,
            searchConstraints: [],
          }],
        });
      }
      requestedPaths.push(path);
      if (path.startsWith("/api/fhir/Observation?")) {
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          entry: [{
            resource: {
              resourceType: "Observation",
              id: "observation-1",
              status: "final",
              code: { text: "Blood pressure" },
              effectiveDateTime: "2026-08-24T20:00:00Z",
              issued: "2026-08-24T21:00:00Z",
              component: [{
                code: { text: "Systolic" },
                valueQuantity: { value: 120, unit: "mmHg" },
              }],
            },
          }],
        });
      }
      if (path === "/api/fhir/Observation/observation-1") {
        detailReads += 1;
        if (detailReads > 1) {
          return jsonResponse({
            error: { code: "fhir_scope_denied", message: "This detail is no longer available." },
          }, 403, connectionContextA, { "X-Request-ID": "request-detail-403" });
        }
        return jsonResponse({
          resourceType: "Observation",
          id: "observation-1",
          status: "final",
          code: { text: "Blood pressure" },
          valueString: "Detailed result",
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    await harness.elements["#search-form"].dispatch("submit", {
      preventDefault(): void {},
    });

    const list = harness.elements["#result-list"];
    expect(list.hidden).toBe(true);
    expect(list.children).toHaveLength(0);
    const timeline = harness.elements["#temporal-graph-list"];
    expect(timeline.children).toHaveLength(2);
    let timelineItem = timeline.children[0]!;
    let card = timelineItem.children[1]!;
    const heading = card.children.find((child) => child.tagName === "H4")!;
    let detailButton = card.children.find((child) => child.tagName === "BUTTON")!;
    expect(heading.textContent).toBe("Blood pressure");
    expect(card.children.some((child) => child.tagName === "DL")).toBe(true);
    expect(detailButton.textContent).toBe("View details");
    expect(detailButton.getAttribute("aria-label")).toBe("View details for Blood pressure");
    expect(harness.elements["#advanced-result"].open).toBe(false);
    expect(harness.elements["#temporal-graph"].hidden).toBe(false);
    await harness.elements["#temporal-graph-order"].dispatch("click");
    timelineItem = timeline.children[0]!;
    card = timelineItem.children[1]!;
    detailButton = card.children.find((child) => child.tagName === "BUTTON")!;

    await detailButton.dispatch("click");
    expect(requestedPaths).toContain("/api/fhir/Observation/observation-1");
    expect(harness.elements["#result-list"].children[0]?.children.find(
      (child) => child.tagName === "H3",
    )?.textContent).toBe("Blood pressure");
    expect(harness.elements["#temporal-graph"].hidden).toBe(true);
    expect(harness.elements["#pagination-controls"].hidden).toBe(false);
    const backButton = harness.elements["#pagination-controls"].children[0]!;
    expect(backButton.textContent).toBe("Back to search results");
    await backButton.dispatch("click");
    expect(harness.elements["#result"].textContent).toContain('"resourceType": "Bundle"');
    expect(harness.elements["#temporal-graph"].hidden).toBe(false);
    expect(harness.elements["#result-list"].hidden).toBe(true);
    const retriedDetailButton = harness.elements["#temporal-graph-list"].children[0]?.children[1]?.children.find(
      (child) => child.tagName === "BUTTON",
    )!;
    await retriedDetailButton.dispatch("click");
    expect(harness.elements["#result-error"].textContent).toContain("no longer available");
    expect(harness.elements["#result-error"].textContent).toContain(
      "HTTP 403 · error fhir_scope_denied · request request-detail-403",
    );
    expect(harness.elements["#result"].textContent).toContain('"resourceType": "Bundle"');
  });

  it("shows every field returned for encounter-derived Location resources", async () => {
    const location = {
      resourceType: "Location",
      id: "location-1",
      meta: {
        versionId: "4",
        lastUpdated: "2026-08-24T20:00:00Z",
      },
      implicitRules: "https://example.test/fhir/location-rules",
      language: "en",
      text: {
        status: "generated",
        div: '<div xmlns="http://www.w3.org/1999/xhtml"><img src=x onerror=alert(1)></div>',
      },
      contained: [{
        resourceType: "Organization",
        id: "contained-organization",
        name: "On-site services",
      }],
      extension: [{
        url: "https://example.test/fhir/location-campus-code",
        valueString: "CAMPUS-A",
      }],
      modifierExtension: [{
        url: "https://example.test/fhir/location-restricted",
        valueBoolean: false,
      }],
      identifier: [{
        use: "official",
        system: "https://example.test/location-ids",
        value: "FAC-100",
      }],
      status: "active",
      operationalStatus: {
        system: "http://terminology.hl7.org/CodeSystem/v2-0116",
        code: "H",
        display: "Housekeeping",
      },
      name: "Main Campus",
      alias: ["Downtown campus", "Central hospital"],
      description: "Main outpatient and inpatient campus",
      mode: "instance",
      type: [{
        coding: [{
          system: "http://terminology.hl7.org/CodeSystem/v3-RoleCode",
          code: "HOSP",
          display: "Hospital",
        }],
        text: "Hospital campus",
      }],
      telecom: [
        { system: "phone", value: "617-555-0100", use: "work" },
        { system: "email", value: "campus@example.test", use: "work" },
      ],
      address: {
        use: "work",
        type: "physical",
        text: "100 Main St, Suite 200, Boston, MA 02110",
        line: ["100 Main St", "Suite 200"],
        city: "Boston",
        district: "Suffolk",
        state: "MA",
        postalCode: "02110",
        country: "US",
      },
      physicalType: {
        coding: [{ code: "bu", display: "Building" }],
        text: "Building",
      },
      position: {
        longitude: -71.0589,
        latitude: 42.3601,
        altitude: 8,
      },
      managingOrganization: {
        reference: "Organization/organization-1",
        display: "Example Health",
      },
      partOf: {
        reference: "Location/campus-1",
        display: "Example Medical Center",
      },
      hoursOfOperation: [
        {
          daysOfWeek: ["mon", "tue"],
          allDay: false,
          openingTime: "08:00:00",
          closingTime: "17:00:00",
        },
        { daysOfWeek: ["sat"], allDay: true },
      ],
      availabilityExceptions: "Emergency department is always open",
      endpoint: [{
        reference: "Endpoint/endpoint-1",
        display: "Scheduling endpoint",
      }],
      epicCustomLocationField: {
        campusZone: "North",
        wheelchairAccessible: true,
      },
    };
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/Location.r", "patient/Location.s"],
          capabilities: [{
            resourceType: "Location",
            read: true,
            readConstraintAlternatives: [[]],
            search: true,
            searchConstraints: [],
          }],
        });
      }
      if (path === "/location-card-test") {
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          entry: [{ resource: location }],
        });
      }
      if (path === "/location-direct-test") return jsonResponse(location);
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    await harness.controls.runDataRequest("/location-card-test", "Visited locations");

    const card = harness.elements["#temporal-graph-list"].children[0]?.children[1];
    expect(card?.className).toBe("timeline-event-card");
    expect(card?.children.find((child) => child.tagName === "H4")?.textContent).toBe(
      "Main Campus",
    );
    expect(card?.children.find(
      (child) => child.className.includes("resource-semantics-warning"),
    )?.textContent).toContain("This Location resource");
    const details = cardDetails(card);
    expect(details.size).toBe(Object.keys(location).length);
    expect(details.get("FHIR resource ID")).toBe("location-1");
    expect(details.get("Record metadata")).toContain("Version Id: 4");
    expect(details.get("Operational status")).toContain("Display: Housekeeping");
    expect(details.get("Aliases")).toContain("Central hospital");
    expect(details.get("Types")).toContain("Hospital campus");
    expect(details.get("Contact details")).toContain("Value: 617-555-0100");
    expect(details.get("Contact details")).toContain("Value: campus@example.test");
    expect(details.get("Address")).toContain("Line:\n  1. 100 Main St\n  2. Suite 200");
    expect(details.get("Address")).toContain("City: Boston");
    expect(details.get("Address")).toContain("District: Suffolk");
    expect(details.get("Address")).toContain("Postal Code: 02110");
    expect(details.get("Coordinates")).toContain("Latitude: 42.3601");
    expect(details.get("Managing organization")).toContain("Reference: Organization/organization-1");
    expect(details.get("Parent location")).toContain("Reference: Location/campus-1");
    expect(details.get("Hours of operation")).toContain("Opening Time: 08:00:00");
    expect(details.get("Hours of operation")).toContain("All Day: true");
    expect(details.get("Endpoints")).toContain("Reference: Endpoint/endpoint-1");
    expect(details.get("Narrative")).toContain("<img src=x onerror=alert(1)>");
    expect(details.get("Epic Custom Location Field (epicCustomLocationField)")).toContain(
      "Wheelchair Accessible: true",
    );
    const detailValues = card?.children.find((child) => child.tagName === "DL")?.children
      .filter((child) => child.tagName === "DD") ?? [];
    expect(detailValues.every((detail) => detail.className === "location-field-value")).toBe(true);
    expect(harness.elements["#result-list"].hidden).toBe(true);
    expect(harness.elements["#result"].textContent).toBe(JSON.stringify({
      resourceType: "Bundle",
      type: "searchset",
      entry: [{ resource: location }],
    }, null, 2));

    await harness.controls.runDataRequest("/location-direct-test", "Location details");
    const directCard = harness.elements["#result-list"].children[0];
    expect(directCard?.className).toBe("result-card");
    expect(cardDetails(directCard).size).toBe(Object.keys(location).length);
    expect(cardDetails(directCard).get("Address")).toContain("City: Boston");
    expect(directCard?.children.find((child) => child.tagName === "DL")?.children
      .filter((child) => child.tagName === "DD")
      .every((detail) => detail.className === "location-field-value")).toBe(true);
    expect(harness.elements["#result-list"].hidden).toBe(false);
  });

  it("graphs every sortable event on the displayed Bundle page in temporal order", async () => {
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/Patient.r"],
          capabilities: [{
            resourceType: "Patient",
            read: true,
            readConstraintAlternatives: [[]],
            search: false,
            searchConstraints: [],
          }],
        });
      }
      if (path === "/timeline") {
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          entry: [
            {
              resource: {
                resourceType: "Observation",
                id: "observation-1",
                code: { text: "Home blood pressure" },
                effectiveTiming: {
                  event: ["2022-05", "2023-01-15T12:30:00Z"],
                },
              },
            },
            {
              resource: {
                resourceType: "Encounter",
                id: "encounter-1",
                type: [{ text: "Annual visit" }],
                period: { start: "2020-06-01", end: "2020-06-04" },
              },
            },
            {
              resource: {
                resourceType: "Condition",
                id: "condition-1",
                code: { text: "Example condition" },
                onsetDateTime: "2021",
              },
            },
            {
              resource: {
                resourceType: "Organization",
                id: "organization-1",
                name: "Example clinic",
              },
            },
            {
              resource: {
                resourceType: "OperationOutcome",
                effectiveDateTime: "2018-01-01",
                issue: [{ severity: "warning", code: "processing" }],
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    await harness.controls.runDataRequest("/timeline", "Timeline records");

    const timeline = harness.elements["#temporal-graph-list"];
    const times = timeline.children.map((item) => item.children[0]?.getAttribute("datetime"));
    const titles = timeline.children.map((item) =>
      item.children[1]?.children.find((child) => child.tagName === "H4")?.textContent
    );
    expect(harness.elements["#temporal-graph"].hidden).toBe(false);
    expect(timeline.hidden).toBe(false);
    expect(times).toEqual([
      "2020-06-01",
      "2021",
      "2022-05",
      "2023-01-15T12:30:00Z",
      undefined,
    ]);
    expect(titles).toEqual([
      "Annual visit",
      "Example condition",
      "Home blood pressure",
      "Home blood pressure",
      "Example clinic",
    ]);
    expect(timeline.children[0]?.children[0]?.textContent).toContain("2020");
    expect(timeline.children[0]?.children[0]?.textContent).toContain("–");
    expect(harness.elements["#temporal-graph-summary"].textContent).toContain(
      "4 dated events from 3 of 4 records on this result page, ordered oldest to newest",
    );
    expect(harness.elements["#temporal-graph-summary"].textContent).toContain(
      "1 undated record follows in source order with a blank timeline position",
    );
    const undatedItem = timeline.children[4]!;
    expect(undatedItem.className).toContain("timeline-event-undated");
    expect(undatedItem.children[0]?.tagName).toBe("SPAN");
    expect(undatedItem.children[0]?.textContent).toBe("");
    expect(undatedItem.children[0]?.getAttribute("aria-hidden")).toBe("true");
    expect(harness.elements["#result-list"].children).toHaveLength(1);
    expect(harness.elements["#result-list"].children[0]?.textContent).toContain("processing notice");
    expect(harness.elements["#temporal-graph-order"].hidden).toBe(false);

    await harness.elements["#temporal-graph-order"].dispatch("click");
    expect(timeline.children.map((item) => item.children[0]?.getAttribute("datetime"))).toEqual([
      "2023-01-15T12:30:00Z",
      "2022-05",
      "2021",
      "2020-06-01",
      undefined,
    ]);
    expect(harness.elements["#temporal-graph-summary"].textContent).toContain(
      "ordered newest to oldest",
    );
    expect(harness.elements["#temporal-graph-order"].textContent).toBe("Show oldest first");
  });

  it("shows undated and invalidly dated records with blank timeline positions", async () => {
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/Patient.r"],
          capabilities: [{
            resourceType: "Patient",
            read: true,
            readConstraintAlternatives: [[]],
            search: false,
            searchConstraints: [],
          }],
        });
      }
      if (path === "/undated") {
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          entry: [
            { resource: { resourceType: "Observation", id: "invalid", effectiveDateTime: "2024-02-30" } },
            { resource: { resourceType: "Procedure", id: "unknown", performedString: "Years ago" } },
            { resource: { resourceType: "Medication", id: "medication-1", code: { text: "Example medication" } } },
            { resource: { resourceType: "OperationOutcome", issue: [] } },
          ],
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    await harness.controls.runDataRequest("/undated", "Undated records");

    expect(harness.elements["#temporal-graph"].hidden).toBe(false);
    const timeline = harness.elements["#temporal-graph-list"];
    expect(timeline.hidden).toBe(false);
    expect(timeline.children).toHaveLength(3);
    expect(timeline.children.map((item) => item.children[0]?.tagName)).toEqual([
      "SPAN",
      "SPAN",
      "SPAN",
    ]);
    expect(timeline.children.every((item) => item.className.includes("timeline-event-undated"))).toBe(true);
    expect(timeline.children.every((item) => item.children[0]?.textContent === "")).toBe(true);
    expect(timeline.children.every((item) => item.children[0]?.getAttribute("datetime") === undefined)).toBe(true);
    expect(harness.elements["#temporal-graph-summary"].textContent).toContain(
      "All 3 records on this result page are shown in source order with blank timeline positions",
    );
    expect(harness.elements["#temporal-graph-order"].hidden).toBe(true);
    expect(harness.elements["#result-list"].children).toHaveLength(1);
    expect(harness.elements["#result-list"].children[0]?.textContent).toContain("processing notice");
  });

  it("graphs distinct clinical milestones and Timing bounds from each record", async () => {
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/Patient.r"],
          capabilities: [{
            resourceType: "Patient",
            read: true,
            readConstraintAlternatives: [[]],
            search: false,
            searchConstraints: [],
          }],
        });
      }
      if (path === "/milestones") {
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          entry: [
            {
              resource: {
                resourceType: "AllergyIntolerance",
                id: "allergy-1",
                code: { text: "Peanut allergy" },
                onsetDateTime: "2018",
                recordedDate: "2019-01-02",
                lastOccurrence: "2022-04-03",
                reaction: [{ onset: "2020-05-01" }],
              },
            },
            {
              resource: {
                resourceType: "Condition",
                id: "condition-1",
                code: { text: "Example condition" },
                onsetDateTime: "2017-02",
                abatementDateTime: "2021-06",
                recordedDate: "2019-03",
              },
            },
            {
              resource: {
                resourceType: "Observation",
                id: "observation-1",
                code: { text: "Weekly measurement" },
                effectiveTiming: {
                  repeat: {
                    boundsPeriod: { start: "2023-01", end: "2023-03" },
                  },
                },
                issued: "2023-04-01T00:00:00Z",
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    await harness.controls.runDataRequest("/milestones", "Clinical milestones");

    const timeline = harness.elements["#temporal-graph-list"];
    expect(timeline.children.map((item) => {
      const dateSlot = item.children[0];
      return dateSlot?.tagName === "TIME"
        ? dateSlot.getAttribute("datetime")
        : dateSlot?.children.find((child) => child.tagName === "TIME")?.getAttribute("datetime");
    })).toEqual([
      "2017-02",
      "2018",
      "2019-01-02",
      "2020-05-01",
      "2022-04-03",
      "2023-01",
      "2023-04-01T00:00:00Z",
    ]);
    expect(timeline.children.map((item) => item.children[1]?.children.find(
      (child) => child.className === "timeline-date-kind",
    )?.textContent)).toEqual([
      "Condition course",
      "Onset",
      "Recorded",
      "Reaction onset",
      "Last occurrence",
      "Clinically relevant occurrence bounds",
      "Issued",
    ]);
    expect(timeline.children[0]?.children[0]?.className).toBe("timeline-time-range");
    expect(timeline.children[0]?.children[0]?.children.map((child) => child.getAttribute("datetime"))).toEqual([
      "2017-02",
      undefined,
      "2021-06",
    ]);
    expect(timeline.children[5]?.children[0]?.textContent).toContain("–");
    expect(harness.elements["#temporal-graph-summary"].textContent).toContain(
      "7 dated events from 3 of 3 records",
    );
    expect(harness.elements["#temporal-graph-summary"].textContent).toContain(
      "overlapping date ranges retain source order where chronology is uncertain",
    );
    expect(harness.elements["#result-list"].hidden).toBe(true);
  });

  it("coalesces equivalent moments and keeps one timeline card per Condition", async () => {
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/Patient.r"],
          capabilities: [{
            resourceType: "Patient",
            read: true,
            readConstraintAlternatives: [[]],
            search: false,
            searchConstraints: [],
          }],
        });
      }
      if (path === "/matching-moments") {
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          entry: [
            {
              resource: {
                resourceType: "Condition",
                id: "same-date",
                code: { text: "Same-date condition" },
                onsetDateTime: "2019-04-23",
                recordedDate: "2019-04-23",
              },
            },
            {
              resource: {
                resourceType: "Condition",
                id: "distinct-dates",
                code: { text: "Distinct-date condition" },
                onsetDateTime: "2019-04-23",
                recordedDate: "2019-04-24",
              },
            },
            {
              resource: {
                resourceType: "Condition",
                id: "same-course-date",
                clinicalStatus: {
                  coding: [{
                    system: "http://terminology.hl7.org/CodeSystem/condition-clinical",
                    code: "resolved",
                  }],
                },
                code: { text: "Same-date resolved condition" },
                onsetDateTime: "2019-04-23",
                abatementDateTime: "2019-04-23",
                recordedDate: "2019-04-23",
              },
            },
            {
              resource: {
                resourceType: "Observation",
                id: "same-instant",
                code: { text: "Same-instant observation" },
                effectiveDateTime: "2020-01-01T00:00:00.1000Z",
                issued: "2019-12-31T19:00:00.1-05:00",
              },
            },
            {
              resource: {
                resourceType: "Condition",
                id: "recorded-only",
                code: { text: "Recorded-only condition" },
                recordedDate: "2021-02-03",
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    await harness.controls.runDataRequest("/matching-moments", "Matching moments");

    const timeline = harness.elements["#temporal-graph-list"];
    expect(timeline.children.map((item) => ({
      dateTime: item.children[0]?.getAttribute("datetime"),
      title: item.children[1]?.children.find((child) => child.tagName === "H4")?.textContent,
      dateKind: item.children[1]?.children.find(
        (child) => child.className === "timeline-date-kind",
      )?.textContent,
    }))).toEqual([
      {
        dateTime: "2019-04-23",
        title: "Same-date condition",
        dateKind: "Onset · Recorded",
      },
      {
        dateTime: "2019-04-23",
        title: "Distinct-date condition",
        dateKind: "Onset",
      },
      {
        dateTime: "2019-04-23",
        title: "Same-date resolved condition",
        dateKind: "Onset · Resolution · Recorded",
      },
      {
        dateTime: "2020-01-01T00:00:00.1000Z",
        title: "Same-instant observation",
        dateKind: "Clinically relevant time · Issued",
      },
      {
        dateTime: "2021-02-03",
        title: "Recorded-only condition",
        dateKind: "Recorded",
      },
    ]);
    expect(harness.elements["#temporal-graph-summary"].textContent).toContain(
      "5 dated events from 5 of 5 records",
    );
  });

  it("renders a resolved Condition once as a course with clearly dated current status", async () => {
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/Patient.r"],
          capabilities: [{
            resourceType: "Patient",
            read: true,
            readConstraintAlternatives: [[]],
            search: false,
            searchConstraints: [],
          }],
        });
      }
      if (path === "/resolved-condition") {
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          entry: [{
            resource: {
              resourceType: "Condition",
              id: "nevus",
              clinicalStatus: {
                coding: [{
                  system: "http://terminology.hl7.org/CodeSystem/condition-clinical",
                  code: "resolved",
                }],
              },
              code: { text: "Nevus" },
              onsetDateTime: "2020-07-07",
              recordedDate: "2020-07-07",
              abatementDateTime: "2023-02-01",
            },
          }],
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    await harness.controls.runDataRequest("/resolved-condition", "Resolved condition");

    const timeline = harness.elements["#temporal-graph-list"];
    expect(timeline.children).toHaveLength(1);
    const card = timeline.children[0]!.children[1]!;
    const dateSlot = timeline.children[0]!.children[0]!;
    expect(dateSlot.className).toBe("timeline-time-range");
    expect(dateSlot.children.map((child) => child.tagName)).toEqual(["TIME", "SPAN", "TIME"]);
    expect(dateSlot.children.map((child) => child.getAttribute("datetime"))).toEqual([
      "2020-07-07",
      undefined,
      "2023-02-01",
    ]);
    expect(dateSlot.children[0]?.getAttribute("aria-label")).toContain("Onset");
    expect(dateSlot.children[2]?.getAttribute("aria-label")).toContain("Resolution");
    expect(card.children.find((child) => child.className === "timeline-date-kind")?.textContent).toBe(
      "Condition course",
    );
    const details = card.children.find((child) => child.tagName === "DL")!;
    expect(details.children.map((child) => child.textContent)).toEqual([
      "Current status",
      "Resolved",
      "Onset",
      "Jul 7, 2020",
      "Resolution",
      "Feb 1, 2023",
      "Recorded",
      "Jul 7, 2020",
    ]);
    expect(harness.elements["#temporal-graph-summary"].textContent).toContain(
      "1 dated event from 1 of 1 record",
    );
  });

  it("validates FHIR date precision, leap seconds, and timezone limits by field type", async () => {
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/Patient.r"],
          capabilities: [{
            resourceType: "Patient",
            read: true,
            readConstraintAlternatives: [[]],
            search: false,
            searchConstraints: [],
          }],
        });
      }
      if (path === "/date-types") {
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          entry: [
            {
              resource: {
                resourceType: "DocumentReference",
                id: "invalid-instant",
                description: "Reduced precision instant",
                date: "2024",
              },
            },
            {
              resource: {
                resourceType: "Observation",
                id: "midnight-after-leap",
                code: { text: "Following-second result" },
                issued: "2017-01-01T00:00:00Z",
              },
            },
            {
              resource: {
                resourceType: "Observation",
                id: "leap-second",
                code: { text: "Leap-second result" },
                issued: "2016-12-31T23:59:60Z",
              },
            },
            {
              resource: {
                resourceType: "Observation",
                id: "invalid-offset",
                code: { text: "Invalid offset" },
                effectiveDateTime: "2020-01-01T00:00:00+14:30",
              },
            },
            {
              resource: {
                resourceType: "Observation",
                id: "valid-offset",
                code: { text: "Valid offset" },
                effectiveInstant: "2020-01-01T00:00:00+14:00",
              },
            },
            {
              resource: {
                resourceType: "Observation",
                id: "later-sub-millisecond",
                code: { text: "Later sub-millisecond result" },
                issued: "2020-01-02T00:00:00.0002Z",
              },
            },
            {
              resource: {
                resourceType: "Observation",
                id: "earlier-sub-millisecond",
                code: { text: "Earlier sub-millisecond result" },
                issued: "2020-01-02T00:00:00.0001Z",
              },
            },
            {
              resource: {
                resourceType: "Goal",
                id: "exact-date",
                description: { text: "Dated measurement" },
                startDate: "2021-04-15",
              },
            },
            {
              resource: {
                resourceType: "Goal",
                id: "partial-date",
                description: { text: "Monthly goal" },
                startDate: "2021-04",
                statusDate: "2021-04-31",
              },
            },
            {
              resource: {
                resourceType: "Goal",
                id: "late-precise-date",
                description: { text: "Late precise goal" },
                startDate: "2022-12-31",
              },
            },
            {
              resource: {
                resourceType: "Goal",
                id: "broad-date",
                description: { text: "Broad goal" },
                startDate: "2022",
              },
            },
            {
              resource: {
                resourceType: "Goal",
                id: "early-precise-date",
                description: { text: "Early precise goal" },
                startDate: "2022-01-01",
              },
            },
            {
              resource: {
                resourceType: "Observation",
                id: "offset-near-day-boundary",
                code: { text: "Offset boundary result" },
                issued: "2023-01-01T23:30:00-05:00",
              },
            },
            {
              resource: {
                resourceType: "Goal",
                id: "floating-calendar-date",
                description: { text: "Calendar-day goal" },
                startDate: "2023-01-01",
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    await harness.controls.runDataRequest("/date-types", "FHIR date types");

    const timeline = harness.elements["#temporal-graph-list"];
    expect(timeline.children.map((item) => item.children[0]?.getAttribute("datetime"))).toEqual([
      "2016-12-31T23:59:60Z",
      "2017-01-01T00:00:00Z",
      "2020-01-01T00:00:00+14:00",
      "2020-01-02T00:00:00.0001Z",
      "2020-01-02T00:00:00.0002Z",
      "2021-04-15",
      "2021-04",
      "2022",
      "2022-01-01",
      "2022-12-31",
      "2023-01-01T23:30:00-05:00",
      "2023-01-01",
      undefined,
      undefined,
    ]);
    expect(harness.elements["#temporal-graph-summary"].textContent).toContain(
      "12 dated events from 12 of 14 records",
    );
    expect(harness.elements["#temporal-graph-summary"].textContent).toContain(
      "2 undated records follow in source order with blank timeline positions",
    );
    expect(harness.elements["#result-list"].children).toHaveLength(0);
    expect(harness.elements["#result-list"].hidden).toBe(true);

    await harness.elements["#temporal-graph-order"].dispatch("click");
    expect(timeline.children.map((item) => item.children[0]?.getAttribute("datetime"))).toEqual([
      "2023-01-01T23:30:00-05:00",
      "2023-01-01",
      "2022-12-31",
      "2022",
      "2022-01-01",
      "2021-04-15",
      "2021-04",
      "2020-01-02T00:00:00.0002Z",
      "2020-01-02T00:00:00.0001Z",
      "2020-01-01T00:00:00+14:00",
      "2017-01-01T00:00:00Z",
      "2016-12-31T23:59:60Z",
      undefined,
      undefined,
    ]);
  });

  it("keeps missing Period boundaries unbounded instead of inventing endpoints", async () => {
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/Patient.r"],
          capabilities: [{
            resourceType: "Patient",
            read: true,
            readConstraintAlternatives: [[]],
            search: false,
            searchConstraints: [],
          }],
        });
      }
      if (path === "/open-periods") {
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          entry: [
            {
              resource: {
                resourceType: "Observation",
                id: "future",
                code: { text: "Future result" },
                issued: "2030-01-01T00:00:00Z",
              },
            },
            {
              resource: {
                resourceType: "CarePlan",
                id: "ongoing",
                title: "Ongoing plan",
                period: { start: "2020" },
              },
            },
            {
              resource: {
                resourceType: "Encounter",
                id: "unknown-start",
                type: [{ text: "Visit with unknown start" }],
                period: { end: "2010" },
              },
            },
            {
              resource: {
                resourceType: "Observation",
                id: "historical",
                code: { text: "Historical result" },
                issued: "2000-01-01T00:00:00Z",
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    await harness.controls.runDataRequest("/open-periods", "Open periods");

    const timeline = harness.elements["#temporal-graph-list"];
    expect(timeline.children.map((item) => item.children[0]?.getAttribute("datetime"))).toEqual([
      "2010",
      "2000-01-01T00:00:00Z",
      "2030-01-01T00:00:00Z",
      "2020",
    ]);
    expect(timeline.children[0]?.children[0]?.textContent).toContain("Through");
    expect(timeline.children[3]?.children[0]?.textContent).toContain("no end recorded");
    expect(harness.elements["#temporal-graph-summary"].textContent).toContain(
      "4 dated events from 4 of 4 records",
    );
  });

  it("does not offer a detail read when the record misses the read-grant constraint", async () => {
    const system = "http://terminology.hl7.org/CodeSystem/observation-category";
    const laboratory = `${system}|laboratory`;
    const vitalSigns = `${system}|vital-signs`;
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: [
            `patient/Observation.r?category=${laboratory}`,
            `patient/Observation.s?category=${vitalSigns}`,
          ],
          capabilities: [{
            resourceType: "Observation",
            read: true,
            readConstraintAlternatives: [[{ name: "category", value: laboratory }]],
            search: true,
            searchConstraints: [{ name: "category", values: [vitalSigns] }],
          }],
        });
      }
      if (path.startsWith("/api/fhir/Observation?")) {
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          entry: [{
            resource: {
              resourceType: "Observation",
              id: "vital-1",
              code: { text: "Heart rate" },
              category: [{ coding: [{ system, code: "vital-signs" }] }],
            },
          }],
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    await harness.elements["#search-form"].dispatch("submit", {
      preventDefault(): void {},
    });

    const card = harness.elements["#temporal-graph-list"].children[0]!.children[1]!;
    expect(card.children.some((child) => child.tagName === "BUTTON")).toBe(false);
  });

  it("counts clinical records separately from safe FHIR processing notices", async () => {
    const diagnostic = "patient-specific upstream diagnostic";
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/Observation.s"],
          capabilities: [
            { resourceType: "Observation", read: false, search: true, searchConstraints: [] },
          ],
        });
      }
      if (path.startsWith("/api/fhir/Observation?")) {
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          entry: [{
            resource: {
              resourceType: "OperationOutcome",
              issue: [{ severity: "warning", code: "processing", diagnostics: diagnostic }],
            },
          }],
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    await harness.elements["#search-form"].dispatch("submit", {
      preventDefault(): void {},
    });

    expect(harness.elements["#result-status"].textContent).toContain("Page 1 contains 0 records");
    expect(harness.elements["#result-status"].textContent).toContain("1 processing notice");
    expect(harness.elements["#result-list"].children).toHaveLength(2);
    const visibleText = harness.elements["#result-list"].children.map((child) => child.textContent).join(" ");
    expect(visibleText).toContain("No records were found");
    expect(visibleText).toContain("Review Advanced");
    expect(visibleText).not.toContain(diagnostic);
    expect(harness.elements["#result"].textContent).toContain(diagnostic);
  });

  it("shows every field Epic returned when View profile is selected", async () => {
    const patient = {
      resourceType: "Patient",
      id: "patient-1",
      meta: {
        versionId: "7",
        lastUpdated: "2026-08-24T20:00:00Z",
        profile: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient"],
      },
      implicitRules: "https://ehr.example.test/fhir/rules/patient-v1",
      language: "en-US",
      text: {
        status: "generated",
        div: '<div xmlns="http://www.w3.org/1999/xhtml"><script>not executable</script>Profile narrative</div>',
      },
      contained: [{ resourceType: "Organization", id: "contained-org", name: "Contained clinic" }],
      extension: [{ url: "https://example.test/fhir/extension", valueString: "Extension value" }],
      modifierExtension: [{ url: "https://example.test/fhir/modifier", valueBoolean: false }],
      identifier: [{
        use: "usual",
        type: { text: "Medical record number" },
        system: "urn:oid:1.2.3.4",
        value: "MRN-123",
      }],
      active: true,
      name: [
        { use: "official", given: ["Pat", "Q"], family: "Example" },
        { use: "nickname", text: "Patsy" },
      ],
      telecom: [{ system: "phone", value: "555-0100", use: "mobile", rank: 1 }],
      gender: "female",
      birthDate: "1980-01-02",
      deceasedBoolean: false,
      address: [{
        use: "home",
        line: ["1 Main Street"],
        city: "Boston",
        state: "MA",
        postalCode: "02108",
      }],
      maritalStatus: { text: "Married" },
      multipleBirthInteger: 2,
      photo: [{ contentType: "image/png", title: "Profile photo", data: "aW1hZ2U=" }],
      contact: [{
        relationship: [{ text: "Emergency contact" }],
        name: { text: "Alex Example" },
        telecom: [{ system: "email", value: "alex@example.test" }],
      }],
      communication: [{ language: { text: "English" }, preferred: true }],
      generalPractitioner: [{
        reference: "Practitioner/practitioner-1",
        display: "Dr Ada Example",
      }],
      managingOrganization: {
        reference: "Organization/organization-1",
        display: "Example Health",
      },
      link: [{ other: { reference: "Patient/patient-2" }, type: "replaces" }],
      epicCustomProfileField: {
        nestedValue: 0,
        enabled: false,
        emptyText: "",
        unavailable: null,
        emptyList: [],
        emptyObject: {},
      },
    };
    let patientRequest: RequestInit | undefined;
    const harness = createBrowserHarness(async (path, options) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/Patient.r"],
          capabilities: [{
            resourceType: "Patient",
            read: true,
            readConstraintAlternatives: [[]],
            search: false,
            searchConstraints: [],
          }],
        });
      }
      if (path === "/api/patient") {
        patientRequest = options;
        return jsonResponse(patient);
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    await harness.elements["#patient"].dispatch("click");

    expect(new Headers(patientRequest?.headers).get("X-Epic-Expected-Connection-Context")).toBe(
      connectionContextA,
    );
    const card = harness.elements["#result-list"].children[0];
    expect(card?.tagName).toBe("ARTICLE");
    expect(card?.className).toBe("result-card");
    expect(card?.getAttribute("role")).toBe("listitem");
    expect(card?.children.find((child) => child.className === "resource-kind")?.textContent).toBe(
      "Patient",
    );
    expect(card?.children.find((child) => child.tagName === "H3")?.textContent).toBe("Patient profile");
    const semanticsWarning = card?.children.find((child) =>
      child.className.includes("patient-profile-warning")
    );
    expect(semanticsWarning?.textContent).toContain("has not interpreted");
    expect(semanticsWarning?.getAttribute("role")).toBe("note");
    expect(card?.children.find((child) => child.className === "patient-profile-note")?.textContent).toContain(
      "Every field returned by Epic",
    );

    const details = cardDetails(card);
    expect(details.size).toBe(Object.keys(patient).length);
    expect(details.get("Resource type")).toBe("Patient");
    expect(details.get("FHIR resource ID")).toBe("patient-1");
    expect(details.get("Record metadata")).toContain("Version Id: 7");
    expect(details.get("Implicit rules")).toBe("https://ehr.example.test/fhir/rules/patient-v1");
    expect(details.get("Language")).toBe("en-US");
    expect(details.get("Contained resources")).toContain("Name: Contained clinic");
    expect(details.get("Extensions")).toContain("Value String: Extension value");
    expect(details.get("Modifier extensions")).toContain("Value Boolean: false");
    expect(details.get("Identifiers")).toContain("Value: MRN-123");
    expect(details.get("Active")).toBe("true");
    expect(details.get("Names")).toContain("Family: Example");
    expect(details.get("Names")).toContain("Text: Patsy");
    expect(details.get("Contact details")).toContain("Value: 555-0100");
    expect(details.get("Date of birth")).toContain("(1980-01-02)");
    expect(details.get("Administrative gender")).toBe("Female");
    expect(details.get("Deceased")).toBe("false");
    expect(details.get("Addresses")).toContain("Postal Code: 02108");
    expect(details.get("Marital status")).toContain("Text: Married");
    expect(details.get("Birth order")).toBe("2");
    expect(details.get("Photos")).toContain("Data: aW1hZ2U=");
    expect(details.get("Contacts")).toContain("Name:\n    Text: Alex Example");
    expect(details.get("Contacts")).toContain("Value: alex@example.test");
    expect(details.get("Communication preferences")).toContain("Preferred: true");
    expect(details.get("General practitioners")).toContain("Display: Dr Ada Example");
    expect(details.get("Managing organization")).toContain("Display: Example Health");
    expect(details.get("Linked patient records")).toContain("Reference: Patient/patient-2");
    expect(details.get("Narrative")).toContain("<script>not executable</script>");
    const customField = details.get("Epic Custom Profile Field (epicCustomProfileField)");
    expect(customField).toContain("Nested Value: 0");
    expect(customField).toContain("Enabled: false");
    expect(customField).toContain("Empty Text: (empty string)");
    expect(customField).toContain("Unavailable: (null)");
    expect(customField).toContain("Empty List:\n  (empty list)");
    expect(customField).toContain("Empty Object:\n  (empty object)");
    const patientValues = card?.children.find((child) => child.tagName === "DL")?.children
      .filter((child) => child.tagName === "DD") ?? [];
    expect(patientValues.every((detail) => detail.className === "patient-field-value")).toBe(true);
    expect(harness.elements["#result-list"].hidden).toBe(false);
    expect(harness.elements["#temporal-graph"].hidden).toBe(true);
    expect(harness.elements["#advanced-result"].hidden).toBe(false);
    expect(harness.elements["#advanced-result"].open).toBe(false);
    expect(harness.elements["#result"].textContent).toBe(JSON.stringify(patient, null, 2));
    expect(harness.elements["#result-status"].textContent).toContain(
      "Every field returned by Epic is shown below",
    );
  });

  it("preserves partial FHIR dates and renders false, zero, and range values", async () => {
    let patientRead = 0;
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/Patient.r", "patient/Observation.s"],
          capabilities: [
            {
              resourceType: "Patient",
              read: true,
              readConstraintAlternatives: [[]],
              search: false,
              searchConstraints: [],
            },
            { resourceType: "Observation", read: false, search: true, searchConstraints: [] },
          ],
        });
      }
      if (path === "/api/patient") {
        patientRead += 1;
        return jsonResponse({
          resourceType: "Patient",
          id: "patient-1",
          name: [{ text: "Example Patient" }],
          birthDate: patientRead === 1 ? "1980" : "1980-07",
        });
      }
      if (path.startsWith("/api/fhir/Observation?")) {
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          entry: [
            { resource: { resourceType: "Observation", id: "false", code: { text: "Boolean result" }, valueBoolean: false } },
            { resource: { resourceType: "Observation", id: "zero", code: { text: "Integer result" }, valueInteger: 0 } },
            {
              resource: {
                resourceType: "Observation",
                id: "range",
                code: { text: "Range result" },
                valueRange: {
                  low: { value: 0, unit: "mg" },
                  high: { value: 1, unit: "mg" },
                },
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    await harness.controls.runDataRequest("/api/patient", "Patient profile");
    let patientCard = harness.elements["#result-list"].children[0];
    expect(patientCard?.children.find((child) => child.tagName === "H3")?.textContent).toBe(
      "Example Patient",
    );
    expect(patientCard?.children.some((child) =>
      child.className.includes("patient-profile-warning")
    )).toBe(false);
    let patientDetails = cardDetails(patientCard);
    expect(patientDetails.get("Date of birth")).toBe("1980");

    await harness.controls.runDataRequest("/api/patient", "Patient profile");
    patientCard = harness.elements["#result-list"].children[0];
    patientDetails = cardDetails(patientCard);
    const monthOnly = patientDetails.get("Date of birth") ?? "";
    expect(monthOnly).toContain("1980");
    expect(monthOnly).not.toContain(",");

    await harness.elements["#search-form"].dispatch("submit", {
      preventDefault(): void {},
    });
    const values = harness.elements["#temporal-graph-list"].children.map((item) =>
      item.children[1]?.children.find((child) => child.tagName === "DL")?.children.find(
        (child) => child.tagName === "DD",
      )?.textContent
    );
    expect(values).toEqual(["false", "0", "0 mg – 1 mg"]);
    expect(harness.elements["#result-list"].hidden).toBe(true);
  });

  it("renders the R4 Device deviceName shape in a readable card title", async () => {
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/Patient.r"],
          capabilities: [{
            resourceType: "Patient",
            read: true,
            readConstraintAlternatives: [[]],
            search: false,
            searchConstraints: [],
          }],
        });
      }
      if (path === "/api/device-card-test") {
        return jsonResponse({
          resourceType: "Device",
          id: "device-1",
          deviceName: [{ name: "Home glucose meter", type: "user-friendly-name" }],
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    await harness.controls.runDataRequest("/api/device-card-test", "Device");
    const heading = harness.elements["#result-list"].children[0]?.children.find(
      (child) => child.tagName === "H3",
    );
    expect(heading?.textContent).toBe("Home glucose meter");
  });

  it("offers only the server-issued same-origin next-page cursor", async () => {
    const requestedPaths: string[] = [];
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/Observation.s"],
          capabilities: [
            { resourceType: "Observation", read: false, search: true, searchConstraints: [] },
          ],
        });
      }
      requestedPaths.push(path);
      if (path.startsWith("/api/fhir/Observation?")) {
        return jsonResponse({
          resourceType: "Bundle",
          type: "searchset",
          entry: [{ resource: { resourceType: "Observation", id: "one" } }],
          link: [{ relation: "next", url: "/api/fhir-page?cursor=opaque_cursor_123" }],
        });
      }
      if (path === "/api/fhir-page?cursor=opaque_cursor_123") {
        return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [] });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    await harness.elements["#search-form"].dispatch("submit", {
      preventDefault(): void {},
    });
    const pagination = harness.elements["#pagination-controls"];
    expect(pagination.hidden).toBe(false);
    expect(pagination.children[0]?.textContent).toBe("Page 1");
    expect(pagination.children[1]?.textContent).toBe("Load next page");

    await pagination.children[1]!.dispatch("click");
    expect(requestedPaths).toContain("/api/fhir-page?cursor=opaque_cursor_123");
    expect(pagination.hidden).toBe(true);
    expect(harness.elements["#result-status"].textContent).toContain("Page 2 contains 0 records");
  });

  it("scrubs Patient A data, scopes, and notices across disconnect and reconnect", async () => {
    const connectionResponses = [
      {
        connected: true,
        provider: "Health A",
        connectionContext: connectionContextA,
        connectedAt: "2026-08-24T20:00:00.000Z",
        scope: ["patient/Patient.r", "patient/Observation.s"],
        capabilities: [
          { resourceType: "Patient", read: true, readConstraintAlternatives: [[]], search: false, searchConstraints: [] },
          {
            resourceType: "Observation",
            read: false,
            search: true,
            searchConstraints: [{
              name: "category",
              values: [
                "http://terminology.hl7.org/CodeSystem/observation-category|laboratory",
              ],
            }],
          },
        ],
      },
      { connected: false, provider: "Health A" },
      {
        connected: true,
        provider: "Health B",
        connectionContext: connectionContextB,
        connectedAt: "2026-08-24T21:00:00.000Z",
        scope: ["patient/Condition.s"],
        capabilities: [
          { resourceType: "Condition", read: false, search: true, searchConstraints: [] },
        ],
      },
    ];
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        const response = connectionResponses.shift();
        if (!response) throw new Error("Unexpected connection refresh");
        return jsonResponse(response);
      }
      if (path === "/api/patient") {
        return jsonResponse({
          resourceType: "Patient",
          id: "patient-a",
          name: [{ text: "Patient A Sensitive Name" }],
        });
      }
      if (path === "/api/disconnect-all") {
        return jsonResponse({
          disconnected: true,
          connectionsRemoved: 1,
          manualRevocationRecommended: false,
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    await harness.controls.runDataRequest("/api/patient", "Patient profile");
    expect(harness.elements["#result"].textContent).toContain("Patient A Sensitive Name");
    expect(harness.elements["#advanced-result"].hidden).toBe(false);
    await harness.elements["#copy-resources"].dispatch("click");
    expect(harness.elements["#copy-resources-status"].textContent).toContain("copied");
    expect(harness.elements["#granted-scopes"].textContent).toContain("patient/Observation.s");
    expect(harness.elements["#search-constraints"].hidden).toBe(false);
    harness.elements["#resource-id"].value = "patient-a-provenance-id";
    harness.elements["#notice"].textContent = "Old account notice";
    harness.elements["#notice"].hidden = false;

    const disconnecting = harness.controls.disconnectCurrentConnection();
    expect(harness.elements["#result"].textContent).toBe("");
    expect(harness.elements["#advanced-result"].hidden).toBe(true);
    expect(harness.elements["#copy-resources"].disabled).toBe(true);
    expect(harness.elements["#copy-resources-status"].textContent).toBe("");
    expect(harness.elements["#granted-scopes"].textContent).toBe("");
    expect(harness.elements["#notice"].textContent).toBe("");
    expect(harness.elements["#explorer"].hidden).toBe(true);
    expect(harness.elements["#search-constraints"].hidden).toBe(true);
    expect(harness.elements["#search-constraint-fields"].children).toHaveLength(0);
    expect(harness.elements["#resource-id"].value).toBe("");
    await disconnecting;

    await harness.controls.refreshStatus();
    expect(harness.elements["#status"].textContent).toContain("Health B");
    expect(harness.elements["#result"].textContent).toBe("");
    expect(harness.elements["#result"].textContent).not.toContain("Patient A");
    expect(harness.elements["#advanced-result"].hidden).toBe(true);
    expect(harness.elements["#granted-scopes"].textContent).toBe("patient/Condition.s");
    expect(harness.elements["#granted-scopes"].textContent).not.toContain("Observation");
    expect(harness.elements["#notice"].textContent).toBe("");
  });

  it("ignores late health-data responses and keeps request controls synchronized", async () => {
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: ["patient/Observation.s"],
          capabilities: [
            { resourceType: "Patient", read: true, readConstraintAlternatives: [[]], search: false, searchConstraints: [] },
            { resourceType: "Observation", read: false, search: true, searchConstraints: [] },
          ],
        });
      }
      if (path === "/first") return firstResponse.promise;
      if (path === "/second") return secondResponse.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    await harness.controls.refreshStatus();

    const first = harness.controls.runDataRequest("/first", "First result");
    expect(harness.elements["#patient"].disabled).toBe(true);
    expect(harness.elements["#search"].disabled).toBe(true);
    expect(harness.elements["#explorer"].getAttribute("aria-busy")).toBe("true");
    const second = harness.controls.runDataRequest("/second", "Second result");
    secondResponse.resolve(jsonResponse({ resourceType: "Observation", id: "newest" }));
    await second;
    expect(harness.elements["#result"].textContent).toContain("newest");
    expect(harness.elements["#patient"].disabled).toBe(false);
    expect(harness.elements["#search"].disabled).toBe(false);
    expect(harness.elements["#explorer"].getAttribute("aria-busy")).toBeUndefined();

    firstResponse.resolve(jsonResponse({
      resourceType: "Patient",
      id: "patient-a",
      name: [{ text: "Late Patient A PHI" }],
    }));
    await first;
    expect(harness.elements["#result"].textContent).toContain("newest");
    expect(harness.elements["#result"].textContent).not.toContain("Late Patient A PHI");
  });

  it("rejects a FHIR response from a connection replaced in another tab", async () => {
    let statusChecks = 0;
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        statusChecks += 1;
        return jsonResponse(statusChecks === 1
          ? {
              connected: true,
              provider: "Health A",
              connectionContext: connectionContextA,
              connectedAt: "2026-08-24T20:00:00.000Z",
              scope: ["patient/Patient.r"],
              capabilities: [
                { resourceType: "Patient", read: true, readConstraintAlternatives: [[]], search: false, searchConstraints: [] },
              ],
            }
          : {
              connected: true,
              provider: "Health B",
              connectionContext: connectionContextB,
              connectedAt: "2026-08-24T21:00:00.000Z",
              scope: ["patient/Patient.r"],
              capabilities: [
                { resourceType: "Patient", read: true, readConstraintAlternatives: [[]], search: false, searchConstraints: [] },
              ],
            });
      }
      if (path === "/api/patient") {
        return jsonResponse({
          resourceType: "Patient",
          id: "patient-b",
          name: [{ text: "Patient B Sensitive Name" }],
        }, 200, connectionContextB);
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    await harness.controls.runDataRequest("/api/patient", "Patient profile");

    expect(harness.elements["#result"].textContent).toBe("");
    expect(harness.elements["#result"].textContent).not.toContain("Patient B Sensitive Name");
    expect(harness.elements["#status"].textContent).toContain("Health B");
    expect(harness.elements["#advanced-result"].hidden).toBe(true);
  });

  it("wires cross-tab and focus revalidation for origin-wide session changes", () => {
    expect(browserScript).toContain("BroadcastChannel('epic-connection-state-v1')");
    expect(browserScript).toContain("handleExternalConnectionChange");
    expect(browserScript).toContain("window.addEventListener('focus', revalidateVisibleConnection)");
    expect(browserScript).toContain("document.addEventListener('visibilitychange'");
    expect(browserScript).toContain("lifecycleStatusPromise = refreshStatus()");
  });

  it("scrubs displayed PHI when the connection-status check fails", async () => {
    let statusChecks = 0;
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        statusChecks += 1;
        return statusChecks === 1
          ? jsonResponse({
              connected: true,
              provider: "Example Health",
              connectionContext: connectionContextA,
              connectedAt: "2026-08-24T20:00:00.000Z",
              scope: ["patient/Patient.r"],
              capabilities: [
                { resourceType: "Patient", read: true, readConstraintAlternatives: [[]], search: false, searchConstraints: [] },
              ],
            })
          : jsonResponse({ error: { code: "unavailable", message: "Connection check failed." } }, 503);
      }
      if (path === "/api/patient") {
        return jsonResponse({ resourceType: "Patient", name: [{ text: "Sensitive Patient A" }] });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    await harness.controls.runDataRequest("/api/patient", "Patient profile");
    expect(harness.elements["#result"].textContent).toContain("Sensitive Patient A");
    await harness.controls.refreshStatus();
    expect(harness.elements["#result"].textContent).toBe("");
    expect(harness.elements["#advanced-result"].hidden).toBe(true);
    expect(harness.elements["#granted-scopes"].textContent).toBe("");
    expect(harness.elements["#explorer"].hidden).toBe(true);
    expect(harness.elements["#status"].textContent).toBe("Connection check failed.");
  });

  it("scrubs displayed PHI immediately when a data request reports auth loss", async () => {
    let statusChecks = 0;
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        statusChecks += 1;
        return jsonResponse(statusChecks === 1
          ? {
              connected: true,
              provider: "Example Health",
              connectionContext: connectionContextA,
              connectedAt: "2026-08-24T20:00:00.000Z",
              scope: ["patient/Patient.r"],
              capabilities: [
                { resourceType: "Patient", read: true, readConstraintAlternatives: [[]], search: false, searchConstraints: [] },
              ],
            }
          : { connected: false, provider: "Example Health" });
      }
      if (path === "/api/patient") {
        return jsonResponse({ resourceType: "Patient", name: [{ text: "Sensitive Patient A" }] });
      }
      if (path === "/expired") {
        return jsonResponse({
          error: { code: "reconnect_required", message: "Connect again." },
        }, 401);
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await harness.controls.refreshStatus();
    await harness.controls.runDataRequest("/api/patient", "Patient profile");
    expect(harness.elements["#result"].textContent).toContain("Sensitive Patient A");
    await harness.controls.runDataRequest("/expired", "Patient profile");
    expect(harness.elements["#result"].textContent).toBe("");
    expect(harness.elements["#advanced-result"].hidden).toBe(true);
    expect(harness.elements["#granted-scopes"].textContent).toBe("");
    expect(harness.elements["#explorer"].hidden).toBe(true);
    expect(harness.elements["#status"].textContent).toBe("Not connected");
  });

  it("renders configured operator details and escapes legal-page content", () => {
    const config = makeConfig({
      APP_LEGAL_NAME: "Example & <Unsafe> Connector",
      APP_LEGAL_CONTACT_EMAIL: "privacy@connector.example.test",
      APP_LEGAL_EFFECTIVE_DATE: "2026-08-23",
      CONSENT_POLICY_VERSION: "privacy-notice-v2",
      SESSION_IDLE_TIMEOUT_SECONDS: "900",
      SESSION_MAX_LIFETIME_SECONDS: "7200",
    });
    const home = renderHome(config);
    const terms = renderTerms(config);
    const privacy = renderPrivacy(config);

    expect(home).toContain('name="policyVersion" type="hidden" value="privacy-notice-v2"');
    expect(home).toContain("after 15 minutes of inactivity or 2 hours at the latest");
    expect(home).not.toContain("30 days");
    expect(terms).toContain("Example &amp; &lt;Unsafe&gt; Connector");
    expect(terms).not.toContain("Example & <Unsafe> Connector");
    expect(terms).toContain("after 15 minutes of inactivity");
    expect(terms).toContain("maximum lifetime of 2 hours");
    expect(terms).not.toContain("30 days");
    expect(privacy).toContain("privacy@connector.example.test");
    expect(privacy).toContain("Example Cloud Host");
    expect(privacy).toContain("Condition, Observation");
    expect(privacy).toContain('datetime="2026-08-23"');
    expect(privacy).toContain("browser-session cookie is set for up to 2 hours");
    expect(privacy).toContain("after 15 minutes of inactivity or after 2 hours total");
    expect(privacy).not.toContain("30 days");
    expect(terms).toContain("does not delete an optional private health hub");
    expect(privacy).toContain("private health hub is not enabled in this deployment");
  });

  it("describes the separately consented hub retention and deletion lifecycle", () => {
    const config = makeConfig({
      FHIR_HUB_ENABLED: "true",
      FHIR_HUB_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      FHIR_HUB_IDENTITY_KEY: Buffer.alloc(32, 2).toString("base64"),
      FHIR_HUB_CONSENT_VERSION: "health-hub-v4",
      FHIR_HUB_RETENTION_DAYS: "30",
    });
    const home = renderHome(config);
    const terms = renderTerms(config);
    const privacy = renderPrivacy(config);

    expect(home).toContain('id="hub-configured" type="hidden" value="true"');
    expect(home).toContain('id="hub-policy-version" type="hidden" value="health-hub-v4"');
    expect(home).toContain("I choose to create an encrypted private health hub");
    expect(home).toContain("22 supported FHIR resource types");
    expect(home).toContain("deterministic local source-linked summaries");
    expect(terms).toContain("raw FHIR resources you request");
    expect(terms).toContain("22 supported FHIR resource types");
    expect(terms).toContain("deterministic local source-linked summaries");
    expect(terms).toContain("for up to 30 days");
    expect(privacy).toContain("off until you separately opt in");
    expect(privacy).toContain("normalized fact projections");
    expect(privacy).toContain("22 supported FHIR resource types");
    expect(privacy).toContain("does not authorize new Epic data categories or call an external AI service");
    expect(privacy).toContain("Disconnecting MyChart does not delete");
    expect(privacy).toContain("Permanently delete my hub");
  });
});

describe("private health hub controls", () => {
  it("requires explicit hub consent and binds enablement to the visible connection", async () => {
    let enableOptions: RequestInit | undefined;
    const harness = createBrowserHarness(async (path, options) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: [],
          capabilities: [],
        });
      }
      if (path === "/api/hub/status") {
        return jsonResponse({
          available: true,
          enabled: false,
          consentCurrent: false,
          consentPolicyVersion: "hub-policy-v1",
          currentResourceCount: 0,
          resourceVersionCount: 0,
          careTeamCount: 0,
          normalizedResourceCount: 0,
          normalizationFailureCount: 0,
          insightCount: 0,
        });
      }
      if (path === "/api/hub/enable") {
        enableOptions = options;
        return jsonResponse({
          available: true,
          enabled: true,
          consentCurrent: true,
          currentResourceCount: 0,
          resourceVersionCount: 0,
          careTeamCount: 0,
          normalizedResourceCount: 0,
          normalizationFailureCount: 0,
          insightCount: 0,
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    }, true);

    await harness.controls.refreshStatus();
    expect(harness.elements["#health-hub"].hidden).toBe(false);
    expect(harness.elements["#hub-enable-panel"].hidden).toBe(false);
    expect(harness.elements["#hub-enable"].disabled).toBe(true);

    harness.elements["#hub-consent-checkbox"].checked = true;
    await harness.elements["#hub-consent-checkbox"].dispatch("change");
    expect(harness.elements["#hub-enable"].disabled).toBe(false);
    await harness.elements["#hub-enable"].dispatch("click");

    const headers = new Headers(enableOptions?.headers);
    expect(enableOptions?.method).toBe("POST");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Epic-Expected-Connection-Context")).toBe(connectionContextA);
    expect(JSON.parse(enableOptions?.body as string)).toEqual({ policyVersion: "hub-policy-v1" });
    expect(harness.elements["#hub-controls"].hidden).toBe(false);
    expect(harness.elements["#hub-status"].textContent).toContain("enabled");
  });

  it("shows raw-free normalized projections and insights separately from stored FHIR JSON", async () => {
    let intelligenceHeaders = new Headers();
    let resourceHeaders = new Headers();
    let connected = true;
    const unsafeText = '<img src=x onerror="expose-health-data()">';
    const rawObservation = {
      resourceType: "Observation",
      id: "obs-1",
      status: "final",
      valueString: "raw-only-sensitive-value",
    };
    const harness = createBrowserHarness(async (path, options) => {
      if (path === "/api/connection") {
        return jsonResponse(connected ? {
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: [],
          capabilities: [],
        } : { connected: false, provider: "Example Health" });
      }
      if (path === "/api/hub/status") {
        return jsonResponse({
          available: true,
          enabled: true,
          consentCurrent: true,
          currentResourceCount: 2,
          resourceVersionCount: 2,
          careTeamCount: 0,
          normalizedResourceCount: 2,
          normalizationFailureCount: 0,
          insightCount: 2,
        });
      }
      if (path === "/api/hub/intelligence?limit=250") {
        intelligenceHeaders = new Headers(options?.headers);
        return jsonResponse({
          schemaVersion: 1,
          projections: [{
            versionKey: "observation-version",
            current: true,
            provenance: { resourceType: "Observation", resourceId: "obs-1" },
            firstSeenAt: "2026-08-24T20:01:00.000Z",
            lastSeenAt: "2026-08-24T20:01:00.000Z",
            expiresAt: "2026-09-24T20:01:00.000Z",
            normalization: {
              schemaVersion: 1,
              status: "normalized",
              rulesVersion: "normalized-fhir-resource-v1",
              projection: {
                resourceType: "Observation",
                resourceLabel: "Observation",
                headline: `Glucose result ${unsafeText}`,
                facts: [],
                warnings: [],
                raw: { mustNotAppear: "projection-raw-marker" },
              },
            },
            normalizedCareTeam: {
              raw: { mustNotAppear: "legacy-care-team-raw-marker" },
            },
          }],
          insights: [{
            insightId: "observation-summary",
            insightType: "observation-summary",
            insight: `Deterministic observation summary ${unsafeText}`,
            sourceResourceVersions: [{ resourceType: "Observation", resourceId: "obs-1" }],
            generatedAt: "2026-08-24T20:01:00.000Z",
            generator: { kind: "rules", rulesVersion: "normalized-fhir-resource-summary-v1" },
            status: "generated",
            raw: { mustNotAppear: "insight-raw-marker" },
          }],
          hasMore: true,
        });
      }
      if (path === "/api/hub/resources?includeHistory=true&limit=250") {
        resourceHeaders = new Headers(options?.headers);
        return jsonResponse([{
          provenance: { resourceType: "Observation", resourceId: "obs-1" },
          raw: rawObservation,
        }]);
      }
      if (path === "/api/disconnect-all") {
        connected = false;
        return jsonResponse({
          disconnected: true,
          connectionsRemoved: 1,
          manualRevocationRecommended: false,
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    }, true);

    await harness.controls.refreshStatus();
    await harness.elements["#hub-intelligence"].dispatch("click");

    expect(intelligenceHeaders.get("X-Epic-Expected-Connection-Context")).toBe(connectionContextA);
    expect(harness.elements["#hub-projections"].textContent).toContain("Observation");
    expect(harness.elements["#hub-projections"].textContent).toContain("<img src=x onerror=");
    expect(harness.elements["#hub-projections"].textContent).toContain("expose-health-data()");
    expect(harness.elements["#hub-projections"].textContent).not.toContain("projection-raw-marker");
    expect(harness.elements["#hub-projections"].textContent).not.toContain("legacy-care-team-raw-marker");
    expect(harness.elements["#hub-insights"].textContent).toContain("Deterministic observation summary");
    expect(harness.elements["#hub-insights"].textContent).toContain("<img src=x onerror=");
    expect(harness.elements["#hub-insights"].textContent).toContain("expose-health-data()");
    expect(harness.elements["#hub-insights"].textContent).not.toContain("insight-raw-marker");
    expect(harness.elements["#hub-intelligence-view"].hidden).toBe(false);
    expect(harness.elements["#hub-status"].textContent).toContain("full export");
    expect(harness.elements["#hub-result"].textContent).toBe("");
    expect(harness.elements["#hub-advanced-result"].hidden).toBe(true);

    await harness.elements["#hub-resources"].dispatch("click");

    expect(resourceHeaders.get("X-Epic-Expected-Connection-Context")).toBe(connectionContextA);
    expect(harness.elements["#hub-result"].textContent).toContain("raw-only-sensitive-value");
    expect(harness.elements["#hub-advanced-result"].hidden).toBe(false);
    expect(harness.elements["#hub-intelligence-view"].hidden).toBe(true);
    expect(harness.elements["#hub-projections"].textContent).toBe("");
    expect(harness.elements["#hub-insights"].textContent).toBe("");

    await harness.elements["#hub-intelligence"].dispatch("click");
    const disconnecting = harness.controls.disconnectCurrentConnection();
    expect(harness.elements["#hub-intelligence-view"].hidden).toBe(true);
    expect(harness.elements["#hub-projections"].textContent).toBe("");
    expect(harness.elements["#hub-insights"].textContent).toBe("");
    expect(harness.elements["#hub-result"].textContent).toBe("");
    await disconnecting;

    expect(browserScript).not.toContain("localStorage");
    expect(browserScript).not.toContain("sessionStorage");
    expect(browserScript).not.toContain("console.");
    expect(browserScript).not.toContain("innerHTML");
    expect(browserScript).not.toContain("insertAdjacentHTML");
  });

  it("keeps existing hub export and deletion controls available when renewed consent is required", async () => {
    const harness = createBrowserHarness(async (path) => {
      if (path === "/api/connection") {
        return jsonResponse({
          connected: true,
          provider: "Example Health",
          connectionContext: connectionContextA,
          connectedAt: "2026-08-24T20:00:00.000Z",
          scope: [],
          capabilities: [],
        });
      }
      if (path === "/api/hub/status") {
        return jsonResponse({
          available: true,
          enabled: true,
          consentCurrent: false,
          consentPolicyVersion: "hub-policy-v2",
          currentResourceCount: 4,
          resourceVersionCount: 7,
          careTeamCount: 1,
          normalizedResourceCount: 3,
          normalizationFailureCount: 1,
          insightCount: 1,
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    }, true);

    await harness.controls.refreshStatus();

    expect(harness.elements["#hub-enable-panel"].hidden).toBe(false);
    expect(harness.elements["#hub-controls"].hidden).toBe(false);
    expect(harness.elements["#hub-export"].disabled).toBe(false);
    expect(harness.elements["#hub-delete-stage"].disabled).toBe(false);
    expect(harness.elements["#hub-status"].textContent).toContain("resume retaining");
    expect(harness.elements["#hub-counts"].textContent).toContain("7 stored versions");
    expect(harness.elements["#hub-counts"].textContent).toContain("3 normalized projections");
    expect(harness.elements["#hub-counts"].textContent).toContain("1 normalization notice");
  });
});

describe("authorization handoff", () => {
  it("starts authorization with a same-origin JSON POST before navigating to Epic", async () => {
    let requestOptions: RequestInit | undefined;
    const authorizationUrl =
      "https://ehr.example.test/authorize?response_type=code&state=state-value";
    const harness = createBrowserHarness(async (path, options) => {
      expect(path).toBe("/auth/start");
      requestOptions = options;
      return jsonResponse({ authorizationUrl });
    });
    harness.elements["#legal-consent-checkbox"].checked = true;
    await harness.elements["#legal-consent-checkbox"].dispatch("change");
    let prevented = false;

    await harness.elements["#connect-form"].dispatch("submit", {
      preventDefault(): void {
        prevented = true;
      },
    });

    expect(prevented).toBe(true);
    expect(requestOptions?.method).toBe("POST");
    expect(requestOptions?.redirect).toBe("error");
    const headers = new Headers(requestOptions?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(requestOptions?.body?.toString());
    expect(body.get("consent")).toBe("accepted");
    expect(body.get("policyVersion")).toBe("2026-08-23");
    expect(harness.navigationUrl()).toBe(authorizationUrl);
    expect(harness.elements["#status"].textContent).toBe("Redirecting to MyChart…");
  });

  it("shows a retryable error instead of remaining in the redirecting state", async () => {
    const harness = createBrowserHarness(async () => jsonResponse({
      error: { code: "authorization_start_failed", message: "MyChart is temporarily unavailable." },
    }, 502));
    harness.elements["#legal-consent-checkbox"].checked = true;
    await harness.elements["#legal-consent-checkbox"].dispatch("change");

    await harness.elements["#connect-form"].dispatch("submit", {
      preventDefault(): void {},
    });

    expect(harness.navigationUrl()).toBeUndefined();
    expect(harness.elements["#status"].textContent).toBe("MyChart authorization did not start.");
    expect(harness.elements["#notice"].textContent).toBe("MyChart is temporarily unavailable.");
    expect(harness.elements["#connect"].disabled).toBe(false);
  });

  it("refuses an unsafe authorization URL", async () => {
    const harness = createBrowserHarness(async () => jsonResponse({
      authorizationUrl: "http://ehr.example.test/authorize?response_type=code&state=state-value",
    }));
    harness.elements["#legal-consent-checkbox"].checked = true;
    await harness.elements["#legal-consent-checkbox"].dispatch("change");

    await harness.elements["#connect-form"].dispatch("submit", {
      preventDefault(): void {},
    });

    expect(harness.navigationUrl()).toBeUndefined();
    expect(harness.elements["#status"].textContent).toBe("MyChart authorization did not start.");
    expect(harness.elements["#notice"].textContent).toBe(
      "The authorization server returned an invalid redirect.",
    );
  });
});
