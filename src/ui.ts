import type { AppConfig } from "./types.js";
import { EPIC_CARE_PLAN_SEARCH_TYPES } from "./care-plan.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const units = [
    { label: "day", seconds: 24 * 60 * 60 },
    { label: "hour", seconds: 60 * 60 },
    { label: "minute", seconds: 60 },
  ] as const;
  for (const unit of units) {
    if (seconds >= unit.seconds && seconds % unit.seconds === 0) {
      const amount = seconds / unit.seconds;
      return `${amount} ${unit.label}${amount === 1 ? "" : "s"}`;
    }
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

interface ResourceCapability {
  readonly type: string;
  readonly label: string;
  readonly interaction?: "read";
}

interface ResourceCapabilityGroup {
  readonly label: string;
  readonly resources: readonly ResourceCapability[];
}

const resourceCapabilityGroups: readonly ResourceCapabilityGroup[] = [
  {
    label: "Profile and care",
    resources: [
      { type: "AllergyIntolerance", label: "Allergies and intolerances" },
      { type: "CarePlan", label: "Care plans" },
      { type: "CareTeam", label: "Care team" },
      { type: "Condition", label: "Conditions and health concerns" },
      { type: "Goal", label: "Care goals" },
    ],
  },
  {
    label: "Medications and treatment",
    resources: [
      { type: "Device", label: "Medical devices" },
      { type: "Immunization", label: "Immunization" },
      { type: "Medication", label: "Medications" },
      { type: "MedicationRequest", label: "Medication orders" },
      { type: "Procedure", label: "Procedures" },
    ],
  },
  {
    label: "Results",
    resources: [
      { type: "DiagnosticReport", label: "Diagnostic reports" },
      { type: "Observation", label: "Labs, vital signs, and observations" },
    ],
  },
  {
    label: "Visits and documents",
    resources: [
      { type: "DocumentReference", label: "Documents and clinical notes" },
      { type: "Encounter", label: "Visits and encounters" },
    ],
  },
  {
    label: "Care network",
    resources: [
      { type: "Location", label: "Care locations" },
      { type: "Organization", label: "Care organizations" },
      { type: "Practitioner", label: "Clinicians" },
      { type: "PractitionerRole", label: "Clinician roles" },
      { type: "RelatedPerson", label: "Related people" },
    ],
  },
  {
    label: "Record history",
    resources: [{ type: "Provenance", label: "Record sources", interaction: "read" }],
  },
];

function friendlyResourceName(resourceType: string): string {
  return resourceType.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

function renderResourceOptions(allowedResourceTypes: ReadonlySet<string>): {
  readonly html: string;
  readonly binaryConfigured: boolean;
} {
  const remaining = new Set(allowedResourceTypes);
  const groups: string[] = [];

  // Binary search/read are excluded until a session-bound DocumentReference
  // capability proves which attachment the patient-authorized workflow selected.
  const binaryConfigured = remaining.delete("Binary");
  for (const group of resourceCapabilityGroups) {
    const options = group.resources
      .filter(({ type }) => remaining.delete(type))
      .map(({ type, label, interaction }) =>
        `<option value="${escapeHtml(type)}"${interaction === "read" ? ' data-interaction="read"' : ""}>${escapeHtml(label)}</option>`
      );
    if (options.length > 0) {
      groups.push(`<optgroup label="${escapeHtml(group.label)}">${options.join("")}</optgroup>`);
    }
  }

  const otherOptions = [...remaining]
    .sort()
    .map((resourceType) =>
      `<option value="${escapeHtml(resourceType)}">${escapeHtml(friendlyResourceName(resourceType))}</option>`
    );
  if (otherOptions.length > 0) {
    groups.push(`<optgroup label="Other records">${otherOptions.join("")}</optgroup>`);
  }

  return {
    html: groups.length > 0
      ? groups.join("")
      : '<option value="">No health information enabled</option>',
    binaryConfigured,
  };
}

function renderCarePlanSearchTypeOptions(): string {
  return [
    '<option value="">Choose a care plan type</option>',
    ...EPIC_CARE_PLAN_SEARCH_TYPES.map(({ category, label, description }) =>
      `<option value="${escapeHtml(category)}">${escapeHtml(label)} — ${escapeHtml(description)}</option>`
    ),
  ].join("");
}

export function renderHome(config: AppConfig): string {
  const resourceSelector = renderResourceOptions(config.allowedResourceTypes);
  const idleTimeout = escapeHtml(formatDuration(config.sessionIdleTimeoutMs));
  const maximumLifetime = escapeHtml(formatDuration(config.sessionMaxLifetimeMs));

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>MyChart API Connection</title>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    <main>
      <section class="hero card">
        <p class="eyebrow">Epic SMART on FHIR</p>
        <h1>MyChart API Connection</h1>
        <p class="lede">Connect to <strong>${escapeHtml(config.providerName)}</strong> without sharing your MyChart password with this application.</p>
        <p class="legal-notice">Before connecting, review the <a href="/terms">Terms and Conditions</a> and <a href="/privacy">Privacy Notice</a>. Selecting “Connect MyChart” means you agree to the Terms and ask ${escapeHtml(config.legalName)} to begin the authorization process described in the Privacy Notice.</p>
        <div id="status" class="status" aria-live="polite">Checking connection…</div>
        <div id="notice" class="status warning" role="status" hidden></div>
        <form id="connect-form" method="post" action="/auth/start" hidden>
          <div id="legal-consent" class="consent-control">
            <label for="legal-consent-checkbox">
              <input id="legal-consent-checkbox" name="consent" value="accepted" type="checkbox" required autocomplete="off">
              <span>I have reviewed the Terms and Privacy Notice, understand that the local connection ends after ${idleTimeout} of inactivity or ${maximumLifetime} at the latest, and want this application to access the MyChart data I authorize.</span>
            </label>
          </div>
          <input id="policy-version" name="policyVersion" type="hidden" value="${escapeHtml(config.consentPolicyVersion)}">
          <button id="connect" type="submit" disabled>Connect MyChart</button>
        </form>
        <button id="disconnect" class="secondary danger" type="button" hidden>Disconnect</button>
      </section>

      <section id="explorer" class="card" hidden>
        <div class="section-heading">
          <div>
            <p class="eyebrow">Read-only FHIR explorer</p>
            <h2>Authorized health data</h2>
          </div>
          <button id="patient" class="secondary" type="button" hidden disabled>View profile</button>
        </div>
        <details id="granted-access" class="granted-access" hidden>
          <summary>Access granted by Epic <span id="granted-scope-count"></span></summary>
          <p id="scope-warning" class="scope-warning" hidden></p>
          <code id="granted-scopes"></code>
        </details>
        <form id="search-form" class="search-row" hidden>
          <label for="resource-type">Health information</label>
          <select id="resource-type" disabled>${resourceSelector.html}</select>
          <div id="search-constraints" class="search-constraints" hidden>
            <div id="search-constraint-fields" class="search-constraint-fields"></div>
            <p id="search-constraint-hint" class="hint"></p>
          </div>
          <div id="careplan-type-control" class="careplan-type-control" hidden>
            <label for="careplan-type">Care plan type</label>
            <select id="careplan-type" aria-describedby="careplan-type-hint" disabled>${renderCarePlanSearchTypeOptions()}</select>
            <p id="careplan-type-hint" class="hint">Epic requires exactly one category for every CarePlan search. Availability also depends on the matching CarePlan Incoming API at the connected organization.</p>
          </div>
          <div id="resource-id-control" class="resource-id-control" hidden>
            <label for="resource-id">FHIR resource ID</label>
            <input id="resource-id" type="text" pattern="[A-Za-z0-9.-]{1,64}" maxlength="64" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="resource-id-hint">
            <p id="resource-id-hint" class="hint">Enter an ID obtained from an authorized FHIR reference or previous response.</p>
          </div>
          <label id="count-label" for="count">Count</label>
          <input id="count" type="number" min="1" max="100" value="20">
          <button id="search" type="submit" disabled>Find records</button>
        </form>
        <p id="capability-notice" class="hint" hidden>No supported health-data actions were granted for this connection.</p>
        <p class="hint">Results depend on the read/search APIs selected on your Epic app record and authorized by the patient.</p>
        <p class="hint">Care locations are resolved from Location references in the patient’s authorized visit and encounter records.</p>
        <p class="hint">When Epic advertises record-source support and the patient grants access, direct resource searches automatically include available Provenance details in Advanced.</p>
        ${resourceSelector.binaryConfigured ? '<p class="hint">Binary attachment access is disabled until a verified document-reference workflow is available.</p>' : ""}
        <div id="result-status" class="result-message" role="status" aria-live="polite" aria-atomic="true" tabindex="-1">No health data loaded.</div>
        <div id="result-error" class="status error result-error" role="alert" tabindex="-1" hidden></div>
        <section id="temporal-graph" class="temporal-graph" aria-labelledby="temporal-graph-heading" hidden>
          <div class="temporal-graph-heading">
            <div>
              <p class="eyebrow">Temporal view</p>
              <h3 id="temporal-graph-heading">Health event timeline</h3>
            </div>
            <button id="temporal-graph-order" class="secondary" type="button" aria-controls="temporal-graph-list" hidden disabled>Show newest first</button>
          </div>
          <p id="temporal-graph-summary" class="hint" aria-live="polite"></p>
          <ol id="temporal-graph-list" class="temporal-graph-list" aria-label="Health events in chronological order"></ol>
        </section>
        <section id="result-list" class="result-list" aria-label="Health records" hidden></section>
        <details id="response-trace" class="response-trace" hidden>
          <summary>Response trace: where information can go missing</summary>
          <p class="hint">This trace describes the current in-memory response without copying health values into logs or support data.</p>
          <ol class="response-trace-stages">
            <li><strong>FHIR source</strong><span id="response-trace-source"></span></li>
            <li><strong>Connector processing</strong><span id="response-trace-connector"></span></li>
            <li><strong>Friendly display</strong><span id="response-trace-display"></span></li>
          </ol>
          <form id="field-check-form" class="field-check-form">
            <label for="field-check-path">Check a FHIR field or dot path in this response</label>
            <div class="field-check-row">
              <input id="field-check-path" type="text" maxlength="160" placeholder="Example: valueQuantity.value" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="field-check-hint field-check-result">
              <button id="field-check" class="secondary" type="submit">Check field</button>
            </div>
            <p id="field-check-hint" class="hint">Use a field name such as <code>telecom</code> or a dot path such as <code>valueQuantity.value</code>. The check reports presence only; it does not repeat the value.</p>
            <p id="field-check-result" class="field-check-result" role="status" aria-live="polite"></p>
          </form>
          <p id="response-trace-reference" class="hint"></p>
        </details>
        <details id="advanced-result" class="advanced-result" hidden>
          <summary>Advanced: complete application FHIR JSON</summary>
          <p class="hint">This is the complete parsed FHIR response delivered by this application, not the original HTTP bytes. It can contain sensitive health information. Close it when you are finished.</p>
          <div class="advanced-actions">
            <button id="copy-resources" class="secondary" type="button" disabled>Copy application JSON</button>
            <span id="copy-resources-status" class="copy-status" role="status" aria-live="polite"></span>
          </div>
          <pre id="result" tabindex="0" aria-label="Complete application FHIR JSON"></pre>
        </details>
        <nav id="pagination-controls" class="pagination-controls" aria-label="FHIR result pages" hidden></nav>
      </section>

      <section id="health-hub" class="card" hidden>
        <input id="hub-configured" type="hidden" value="${config.fhirHubEnabled ? "true" : "false"}">
        <input id="hub-policy-version" type="hidden" value="${escapeHtml(config.fhirHubConsentVersion)}">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Optional encrypted storage</p>
            <h2>Private health hub</h2>
          </div>
          <button id="hub-refresh" class="secondary" type="button" hidden disabled>Refresh status</button>
        </div>
        <p class="hint">Your MyChart connection and your private health hub are separate. Disconnecting MyChart stops this browser connection but does not delete health data you chose to retain.</p>
        <div id="hub-status" class="result-message" role="status" aria-live="polite">Checking private health hub…</div>
        <div id="hub-error" class="status error result-error" role="alert" hidden></div>
        <div id="hub-enable-panel" class="hub-panel" hidden>
          <div class="consent-control">
            <label for="hub-consent-checkbox">
              <input id="hub-consent-checkbox" type="checkbox" autocomplete="off">
              <span>I choose to create an encrypted private health hub. I authorize this app to retain the raw FHIR resources I request, create normalized fact projections and deterministic local source-linked summaries for each of the 22 supported FHIR resource types when retrieved under my grant, and keep version history under the retention period described in the <a href="/privacy">Privacy Notice</a>. I understand that disconnecting MyChart does not delete this hub.</span>
            </label>
          </div>
          <button id="hub-enable" type="button" disabled>Enable private health hub</button>
        </div>
        <div id="hub-controls" class="hub-panel" hidden>
          <p id="hub-counts" class="hub-counts"></p>
          <div class="hub-actions">
            <button id="hub-intelligence" class="secondary" type="button">View normalized health data</button>
            <button id="hub-resources" class="secondary" type="button">View stored FHIR JSON</button>
            <button id="hub-export" class="secondary" type="button">Export my hub</button>
            <button id="hub-delete-stage" class="secondary danger" type="button">Delete private health hub</button>
          </div>
          <section id="hub-intelligence-view" class="hub-intelligence-view" tabindex="-1" aria-label="Normalized private health hub data" hidden>
            <h3>Normalized source facts</h3>
            <p class="hint">These fact projections are derived locally from the cited FHIR versions. Review the source record before using them to make a health decision.</p>
            <pre id="hub-projections" tabindex="0" aria-label="Normalized FHIR projections"></pre>
            <h3>Deterministic source-linked summaries</h3>
            <p class="hint">These locally generated summaries may be incomplete and are not medical advice.</p>
            <pre id="hub-insights" tabindex="0" aria-label="Source-linked FHIR summaries"></pre>
          </section>
          <div id="hub-delete-panel" class="hub-delete-panel" hidden>
            <p><strong>Permanent deletion cannot be undone.</strong> It removes the hub’s retained raw FHIR resources, version history, summaries, and insights. It does not alter your source medical record.</p>
            <div class="consent-control">
              <label for="hub-delete-checkbox">
                <input id="hub-delete-checkbox" type="checkbox" autocomplete="off">
                <span>I understand that this permanently deletes my private health hub.</span>
              </label>
            </div>
            <button id="hub-confirm-delete" class="danger" type="button" disabled>Permanently delete my hub</button>
            <button id="hub-cancel-delete" class="secondary" type="button">Cancel</button>
          </div>
          <details id="hub-advanced-result" class="advanced-result" hidden>
            <summary>Stored FHIR versions and raw JSON</summary>
            <p class="hint">This view can contain sensitive health information. It is cleared when you disconnect, hide, leave, or refocus this page.</p>
            <pre id="hub-result" tabindex="0" aria-label="Stored private health hub JSON"></pre>
          </details>
        </div>
      </section>

      <section class="card note">
        <h2>How this works</h2>
        <p>Your browser is redirected to the healthcare provider’s MyChart sign-in page. Epic returns short-lived authorization tokens to this server; MyChart credentials never pass through this application.</p>
      </section>
      <footer class="site-footer">
        <span>Operated by ${escapeHtml(config.legalName)}</span>
        <a href="/terms">Terms and Conditions</a>
        <a href="/privacy">Privacy Notice</a>
      </footer>
    </main>
    <script src="/app.js" defer></script>
  </body>
</html>`;
}

function legalPage(
  config: AppConfig,
  title: string,
  eyebrow: string,
  content: string,
): string {
  const effectiveDate = new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(`${config.legalEffectiveDate}T00:00:00.000Z`));
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    <main class="legal-main">
      <article class="card legal-document">
        <a class="back-link" href="/">← Back to MyChart connection</a>
        <p class="eyebrow">${escapeHtml(eyebrow)}</p>
        <h1>${escapeHtml(title)}</h1>
        <p class="legal-meta">Effective <time datetime="${escapeHtml(config.legalEffectiveDate)}">${escapeHtml(effectiveDate)}</time> · Operator: ${escapeHtml(config.legalName)}</p>
        ${content}
      </article>
      <footer class="site-footer">
        <span>Operated by ${escapeHtml(config.legalName)}</span>
        <a href="/terms">Terms and Conditions</a>
        <a href="/privacy">Privacy Notice</a>
      </footer>
    </main>
  </body>
</html>`;
}

export function renderTerms(config: AppConfig): string {
  const operator = escapeHtml(config.legalName);
  const contact = escapeHtml(config.legalContactEmail);
  const idleTimeout = escapeHtml(formatDuration(config.sessionIdleTimeoutMs));
  const maximumLifetime = escapeHtml(formatDuration(config.sessionMaxLifetimeMs));
  const hubTerms = config.fhirHubEnabled
    ? `<p>The separately optional private health hub can retain the raw FHIR resources you request, resource version history, normalized fact projections, and deterministic local source-linked summaries for each of the 22 supported FHIR resource types when that type is retrieved under your grant, for up to ${escapeHtml(formatDuration(config.fhirHubRetentionMs))}. It is not enabled merely by connecting MyChart; you must review its notice and opt in. Summaries or insights may be incomplete or incorrect and are not medical advice.</p>`
    : "";
  return legalPage(
    config,
    "Terms and Conditions",
    "Please review before connecting",
    `<p class="lede">These Terms and Conditions (“Terms”) govern your use of the MyChart connection service operated by ${operator} (“we,” “us,” or “our”). By selecting “Connect MyChart” or otherwise using the service, you agree to these Terms and acknowledge the <a href="/privacy">Privacy Notice</a>.</p>

        <h2>1. What the service does</h2>
        <p>The service lets you authorize read-only access to selected health information available through an Epic/MyChart-compatible FHIR API. It redirects you to your healthcare organization for sign-in and consent, then displays information that the organization makes available under the permissions you approve.</p>
        ${hubTerms}
        <p>The service is not a healthcare provider, health plan, medical-record system, or emergency service. It does not diagnose, treat, prescribe, or replace advice from a qualified healthcare professional. Do not use it for emergencies; contact local emergency services instead.</p>

        <h2>2. Your authorization and responsibilities</h2>
        <ul>
          <li>You must be authorized to use the MyChart account and health information you connect, including when acting for another person.</li>
          <li>You are responsible for reviewing the healthcare organization’s authorization screen, requested data categories, and access duration before allowing access.</li>
          <li>You must protect your device and browser session and promptly disconnect access if you believe either is compromised.</li>
          <li>You may not probe, disrupt, reverse engineer, overload, or use the service to access another person’s information without lawful authority.</li>
        </ul>

        <h2>3. Health information and accuracy</h2>
        <p>Health information comes from your healthcare organization. We do not create or independently verify it and cannot guarantee that it is complete, current, or error-free. Contact the healthcare organization to correct its records and consult an appropriate professional before making health decisions.</p>

        <h2>4. Access duration and disconnection</h2>
        <p>Depending on the permissions you approve and how the service is configured, access may be short-lived or may use a refresh token for persistent access. The connector’s local session becomes unusable after ${idleTimeout} of inactivity or after its maximum lifetime of ${maximumLifetime}, unless you disconnect sooner; scheduled cleanup of a saved connection record may follow shortly afterward. You can disconnect in the application and can also remove the application in MyChart’s linked apps or devices settings. Remote revocation may require that additional MyChart step.</p>
        <p>Disconnecting or revoking MyChart access does not delete an optional private health hub. Hub deletion is a separate, permanent action available only while you have a verified live connection to that MyChart account.</p>

        <h2>5. Third-party services</h2>
        <p>Epic, MyChart, your healthcare organization, internet providers, and hosting providers are third parties with their own terms and privacy practices. Their availability and actions are outside our control. Unless expressly stated otherwise, ${operator} is not Epic or your healthcare organization, and those organizations do not sponsor or warrant this service.</p>

        <h2>6. Availability and changes</h2>
        <p>We may change, suspend, or discontinue the service to maintain security, comply with law, or address operational needs. We may also update these Terms. The effective date above identifies the current version; material changes should be reviewed before you reconnect or continue using the service.</p>

        <h2>7. Your legal rights</h2>
        <p>Applicable law may give you rights and remedies that these Terms cannot limit or waive. Nothing in these Terms excludes responsibilities, warranties, rights, or liabilities that cannot lawfully be excluded. Any other limitation applies only to the extent permitted by applicable law.</p>

        <h2>8. Privacy and contact</h2>
        <p>The <a href="/privacy">Privacy Notice</a> explains the information handled by the service and your choices. Questions about these Terms can be sent to <a href="mailto:${contact}">${contact}</a>.</p>`,
  );
}

export function renderPrivacy(config: AppConfig): string {
  const operator = escapeHtml(config.legalName);
  const contact = escapeHtml(config.legalContactEmail);
  const hostingProvider = escapeHtml(config.hostingProviderName);
  const idleTimeout = escapeHtml(formatDuration(config.sessionIdleTimeoutMs));
  const maximumLifetime = escapeHtml(formatDuration(config.sessionMaxLifetimeMs));
  const hubRetention = escapeHtml(formatDuration(config.fhirHubRetentionMs));
  const hubInformation = config.fhirHubEnabled
    ? `<h3>Optional private health hub</h3>
        <p>The private health hub is off until you separately opt in. After you enable it, the service can retain the raw FHIR resources you request, immutable content versions, normalized fact projections, source provenance, and deterministic local summaries tied to the exact source versions used. This intelligence layer supports each of the 22 supported FHIR resource types when that type is retrieved under your existing MyChart grant; it does not authorize new Epic data categories or call an external AI service. The configured retention period is up to ${hubRetention}.</p>`
    : `<h3>Optional private health hub</h3><p>The private health hub is not enabled in this deployment, so health resources are not added to a persistent hub.</p>`;
  const hubStorage = config.fhirHubEnabled
    ? `<li>FHIR resources are not retained in the private health hub unless you separately opt in. Once enabled, newly requested resources and their derived source-linked records are encrypted in the hub and retained for up to ${hubRetention}, subject to earlier permanent deletion or legal and infrastructure recovery requirements described below.</li>`
    : `<li>FHIR resources returned by your healthcare organization are transmitted to your browser and are not added to a persistent private health hub in this deployment.</li>`;
  const allowedResources = [...config.allowedResourceTypes]
    .sort()
    .map(escapeHtml)
    .join(", ");
  return legalPage(
    config,
    "Privacy Notice",
    "Your health information and choices",
    `<p class="lede">This Privacy Notice explains how ${operator} handles information when you use this MyChart connection service. It applies to this connector, not to Epic, MyChart, or your healthcare organization, which have their own privacy practices. This is not your healthcare organization’s HIPAA Notice of Privacy Practices.</p>

        <h2>1. Information the service handles</h2>
        <h3>Connection and authorization information</h3>
        <p>When you connect, the service handles a random browser-session identifier, OAuth authorization state, PKCE verifier, OpenID nonce, provider and FHIR endpoint details, granted scopes, token and session expiration times, your Epic patient identifier, an optional FHIR user identifier, and OAuth access or refresh tokens.</p>
        <h3>Health information you request</h3>
        <p>The service can retrieve your Patient resource and the resource types enabled by the operator: ${allowedResources || "none currently configured"}. The exact information available depends on your healthcare organization, the application registration, and the permissions you approve.</p>
        ${hubInformation}
        <h3>Information the service does not request</h3>
        <p>Your MyChart username and password go directly to your healthcare organization and do not pass through this application. The application does not request your device address book, device geolocation, advertising identifiers, or payment-card information, and its code does not include advertising or behavioral-analytics trackers. Provider-supplied health records—especially the Patient resource—may themselves include postal address, telephone, email, or other contact details.</p>
        <h3>Technical information</h3>
        <p>The configured infrastructure provider, ${hostingProvider}, and network providers may process information such as IP address, request timing, security events, and basic device or browser metadata to deliver and protect the service. Application responses direct browsers not to cache health information. The application records sanitized authorization, consent, access-category, disconnection, rate-limit, and failure events for security and compliance; those events exclude callback query strings, FHIR identifiers, access credentials, and health-record contents. Infrastructure processing remains subject to the provider’s configuration and contract.</p>

        <h2>2. How information is used</h2>
        <p>Information is used only to initiate and validate authorization, maintain your connection, request the health information you select, return it to your browser, operate an optional hub you enable, create deterministic local source-linked fact projections and summaries, refresh or revoke authorization when supported, protect the service, troubleshoot failures, and comply with applicable law. Hub summaries and insights support organization and review; they are not a substitute for the source record or professional medical advice.</p>

        <h2>3. When information is disclosed</h2>
        <p>The service sends authorization and FHIR requests to Epic systems operated for your healthcare organization. ${hostingProvider} processes requests and, when persistent hosting is enabled, stores the connector’s encrypted connection records as the configured infrastructure provider. Other network providers may transmit information, subject to the operator’s arrangements with those providers. We may disclose information when required by law or when reasonably necessary to protect users, the service, or others.</p>
        <p>The application does not sell health information, use it for targeted advertising, or disclose it to data brokers.</p>

        <h2>4. Storage and retention</h2>
        <ul>
          <li>Pending OAuth state, including the PKCE verifier and nonce, is held in process memory or encrypted hosted storage depending on the deployment and normally expires after 10 minutes.</li>
          <li>The signed browser-session cookie is set for up to ${maximumLifetime}. Connection records, patient identifiers, and OAuth tokens remain in memory by default. Cloudflare Durable Object and local encrypted-file modes encrypt records before persistent storage. Records become unusable after ${idleTimeout} of inactivity or after ${maximumLifetime} total, unless disconnected sooner, and are removed on use or scheduled cleanup shortly afterward.</li>
          ${hubStorage}
          <li>A local-development deployment may instead use memory-only storage or an operator-managed encrypted file, as described by that deployment’s configuration.</li>
        </ul>
        <p>Deletion from active application storage may not immediately remove copies retained temporarily for infrastructure recovery, security, or legal obligations.</p>

        <h2>5. Security</h2>
        <p>Production hosting must use HTTPS. The connector uses signed HTTP-only cookies, OAuth state and nonce validation, PKCE, restricted FHIR resource types, no-store browser headers, and encryption whenever the included persistent-storage modes are enabled. Possession of the valid browser session is what lets the application retrieve its connected record, so protect the device and use Disconnect before sharing or disposing of it. No internet service can guarantee absolute security. Security incidents may trigger notification duties under applicable law.</p>

        <h2>6. Your choices</h2>
        <ul>
          <li>Do not select “Connect MyChart” if you do not want the service to request access.</li>
          <li>Review and adjust the information and duration offered on your healthcare organization’s authorization screen when those controls are available.</li>
          <li>Use “Disconnect” in the application to remove the local connection and attempt remote revocation.</li>
          <li>Disconnecting MyChart does not delete an optional private health hub. Use “Permanently delete my hub” while connected to remove its active retained resources, versions, summaries, insights, and consent profile.</li>
          <li>Use Disconnect before clearing browser cookies. Clearing cookies alone does not revoke MyChart access or immediately remove the stored connection; an inaccessible record can remain until scheduled expiry cleanup.</li>
          <li>Use MyChart’s linked apps or devices settings to review or remove the grant directly.</li>
          <li>Contact your healthcare organization to access or correct information in its medical record.</li>
        </ul>

        <h2>7. Children and authorized representatives</h2>
        <p>The service is intended for people legally able to authorize access to the connected record, including a parent, guardian, or other authorized representative when permitted by the healthcare organization and applicable law. It is not directed to children who cannot provide that authorization on their own.</p>

        <h2>8. Changes and contact</h2>
        <p>We may update this notice as the service or legal requirements change. The effective date above identifies the current version. Privacy questions or requests can be sent to <a href="mailto:${contact}">${contact}</a>. We may need to verify a request before acting on it.</p>`,
  );
}

export function renderError(
  message: string,
  details: { readonly requestId?: string; readonly errorCode?: string } = {},
): string {
  const reference = details.requestId
    ? `<p class="hint">Support reference: <code>${escapeHtml(details.requestId)}</code>${
        details.errorCode ? ` · ${escapeHtml(details.errorCode)}` : ""
      }</p>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>MyChart connection error</title>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    <main>
      <section class="card">
        <p class="eyebrow">Connection not completed</p>
        <h1>MyChart authorization failed</h1>
        <p class="lede">${escapeHtml(message)}</p>
        ${reference}
        <a class="button" href="/">Return to the connector</a>
      </section>
    </main>
  </body>
</html>`;
}

export const styles = `
:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #eef4f7;
  color: #15313a;
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top left, #d5f0eb 0, transparent 38%), #eef4f7; }
main { width: min(920px, calc(100% - 32px)); margin: 48px auto; display: grid; gap: 20px; }
.card { background: rgba(255,255,255,.96); border: 1px solid #d8e3e7; border-radius: 18px; padding: 28px; box-shadow: 0 18px 50px rgba(26,61,72,.08); }
.hero { padding: 38px; }
.eyebrow { margin: 0 0 8px; color: #08786e; font-size: .76rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
h1, h2 { margin: 0; line-height: 1.12; color: #102d35; }
h1 { font-size: clamp(2rem, 6vw, 3.8rem); max-width: 720px; }
h2 { font-size: 1.35rem; }
.lede { max-width: 720px; font-size: 1.1rem; line-height: 1.65; color: #45616a; }
.status { margin: 24px 0 16px; padding: 14px 16px; border-radius: 12px; background: #edf4f5; font-weight: 650; }
.status.connected { color: #08655d; background: #def4ee; }
.status.error { color: #8a2d2d; background: #fbe8e8; }
.status.warning { color: #704d08; background: #fff1c9; }
button, .button { display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 10px; background: #08786e; color: white; padding: 11px 16px; font: inherit; font-weight: 750; cursor: pointer; text-decoration: none; }
button:hover, .button:hover { background: #065e57; }
.secondary { background: #e6eff1; color: #21444e; }
.secondary:hover { background: #d6e5e8; }
.danger { color: #8b2828; }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
.search-row { display: grid; grid-template-columns: auto minmax(180px,1fr) auto 90px auto; align-items: center; gap: 10px; }
.resource-id-control { display: grid; grid-column: 3 / 5; grid-template-columns: auto minmax(140px, 1fr); align-items: center; gap: 8px 10px; }
.resource-id-control .hint { grid-column: 1 / -1; margin: 0; }
.careplan-type-control { grid-column: 1 / -1; padding: 12px 14px; border-radius: 10px; background: #edf4f5; }
.careplan-type-control label { display: block; margin-bottom: 6px; }
.careplan-type-control .hint { margin: 8px 0 0; }
.search-constraints { grid-column: 1 / -1; padding: 12px 14px; border-radius: 10px; background: #edf4f5; }
.search-constraint-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
.constraint-field label { display: block; margin-bottom: 6px; }
.search-constraints .hint { margin: 8px 0 0; }
label { font-size: .86rem; font-weight: 750; color: #49636b; }
select, input { width: 100%; border: 1px solid #c8d7db; border-radius: 9px; background: white; padding: 10px; font: inherit; color: #15313a; }
.hint { color: #5d747b; font-size: .9rem; line-height: 1.5; }
.granted-access { margin: 12px 0 16px; color: #49636b; font-size: .86rem; }
.granted-access summary { cursor: pointer; font-weight: 750; }
.granted-access code { display: block; margin-top: 10px; color: #36545d; line-height: 1.55; overflow-wrap: anywhere; }
.scope-warning { margin: 10px 0 0; padding: 10px 12px; border-radius: 9px; background: #fff1c9; color: #704d08; line-height: 1.5; }
.result-message { margin: 16px 0 0; padding: 12px 14px; border-radius: 10px; background: #edf4f5; color: #36545d; line-height: 1.5; }
.result-error { margin: 12px 0 0; }
.temporal-graph { margin-top: 16px; padding: 18px; border: 1px solid #cfe0e3; border-radius: 14px; background: linear-gradient(145deg, #f8fcfb, #f2f8f9); }
.temporal-graph-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.temporal-graph-heading h3 { margin: 0; color: #15313a; font-size: 1.08rem; }
.temporal-graph-heading button { flex: 0 0 auto; padding: 8px 12px; }
.temporal-graph > .hint { margin: 8px 0 2px; }
.temporal-graph-list { display: grid; gap: 0; margin: 18px 0 0; padding: 0; list-style: none; }
.timeline-event { position: relative; display: grid; grid-template-columns: minmax(110px, 150px) minmax(0, 1fr); gap: 16px; padding: 0 0 20px 34px; }
.timeline-event:last-child { padding-bottom: 0; }
.timeline-event::after { content: ""; position: absolute; z-index: 0; top: 0; bottom: 0; left: 10px; width: 2px; border-radius: 2px; background: #9bc9c3; }
.timeline-event::before { content: ""; position: absolute; z-index: 1; top: 5px; left: 4px; width: 10px; height: 10px; border: 3px solid white; border-radius: 50%; background: #08786e; box-shadow: 0 0 0 2px #69aaa2; }
.timeline-event-undated::before, .timeline-event-undated::after { display: none; }
.timeline-time-empty { min-height: 1px; }
.timeline-time-range { color: #08655d; font-size: .84rem; font-weight: 800; line-height: 1.45; }
.timeline-time-range time { color: inherit; font: inherit; white-space: nowrap; }
.timeline-event time { color: #08655d; font-size: .84rem; font-weight: 800; line-height: 1.45; }
.timeline-event article { min-width: 0; padding: 12px 14px; border: 1px solid #d8e3e7; border-radius: 10px; background: white; box-shadow: 0 5px 18px rgba(26,61,72,.05); }
.timeline-event .resource-kind { margin: 0 0 4px; color: #08786e; font-size: .7rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.timeline-event h4 { margin: 0; color: #15313a; font-size: .98rem; line-height: 1.35; overflow-wrap: anywhere; }
.timeline-event .timeline-date-kind { margin: 7px 0 0; color: #5d747b; font-size: .82rem; line-height: 1.4; }
.timeline-event-card dl { display: grid; grid-template-columns: minmax(100px, auto) 1fr; gap: 5px 14px; margin: 12px 0 0; }
.timeline-event-card dt { color: #5d747b; font-size: .84rem; font-weight: 750; }
.timeline-event-card dd { min-width: 0; margin: 0; color: #36545d; overflow-wrap: anywhere; }
.timeline-event-card button { margin-top: 14px; }
.result-list { display: grid; gap: 12px; margin-top: 16px; }
.result-card { padding: 16px; border: 1px solid #d8e3e7; border-radius: 12px; background: #fbfdfd; }
.result-card .resource-kind { margin: 0 0 5px; color: #08786e; font-size: .72rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.result-card h3 { margin: 0; color: #15313a; font-size: 1.05rem; }
.resource-semantics-warning { margin: 10px 0 0; }
.patient-profile-note { margin: 10px 0 0; color: #526c74; font-size: .9rem; line-height: 1.5; }
.result-card dl { display: grid; grid-template-columns: minmax(100px, auto) 1fr; gap: 5px 14px; margin: 12px 0 0; }
.result-card dt { color: #5d747b; font-size: .84rem; font-weight: 750; }
.result-card dd { min-width: 0; margin: 0; color: #36545d; overflow-wrap: anywhere; }
.result-card dd.patient-field-value,
.result-card dd.location-field-value,
.timeline-event-card dd.location-field-value { white-space: pre-wrap; }
.result-card button { margin-top: 14px; }
.empty-result { margin: 0; padding: 16px; border: 1px dashed #c8d7db; border-radius: 12px; color: #526c74; }
.result-warning { margin: 0; padding: 13px 15px; border-radius: 10px; background: #fff1c9; color: #704d08; line-height: 1.5; }
.response-trace { margin-top: 16px; padding: 14px 16px; border: 1px solid #cfe0e3; border-radius: 12px; background: #f7fbfb; }
.response-trace summary { cursor: pointer; color: #21444e; font-weight: 800; }
.response-trace > .hint { margin: 10px 0; }
.response-trace-stages { display: grid; gap: 10px; margin: 14px 0; padding-left: 22px; }
.response-trace-stages li { color: #36545d; line-height: 1.5; }
.response-trace-stages strong { display: block; color: #15313a; }
.response-trace-stages span { display: block; }
.field-check-form { margin-top: 16px; padding-top: 14px; border-top: 1px solid #d8e3e7; }
.field-check-row { display: grid; grid-template-columns: minmax(180px, 1fr) auto; gap: 10px; margin-top: 7px; }
.field-check-form .hint { margin: 8px 0 0; }
.field-check-result { min-height: 1.5em; margin: 10px 0 0; color: #21444e; font-weight: 700; line-height: 1.5; }
.advanced-result { margin-top: 16px; }
.advanced-result summary { cursor: pointer; color: #36545d; font-weight: 750; }
.advanced-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 10px 0; }
.advanced-actions button { padding: 8px 12px; }
.copy-status { color: #49636b; font-size: .86rem; line-height: 1.4; }
.pagination-controls { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
.pagination-controls .page-label { color: #5d747b; font-size: .9rem; font-weight: 700; }
.hub-panel { margin-top: 16px; padding: 16px; border: 1px solid #d8e3e7; border-radius: 12px; background: #fbfdfd; }
.hub-actions { display: flex; flex-wrap: wrap; gap: 10px; }
.hub-counts { margin: 0 0 14px; color: #36545d; line-height: 1.5; }
.hub-intelligence-view { margin-top: 16px; padding-top: 4px; }
.hub-intelligence-view h3 { margin: 18px 0 4px; color: #15313a; font-size: 1.05rem; }
.hub-intelligence-view pre { min-height: 160px; }
.hub-delete-panel { margin-top: 16px; padding: 16px; border: 1px solid #e7b9b9; border-radius: 12px; background: #fff5f5; color: #623434; }
.hub-delete-panel p { margin-top: 0; line-height: 1.55; }
.hub-delete-panel button { margin-right: 8px; }
.hub-delete-panel .danger { background: #8b2828; color: white; }
.hub-delete-panel .danger:hover { background: #6f2020; }
pre { min-height: 240px; max-height: 620px; overflow: auto; border-radius: 12px; background: #0f2931; color: #d9f1ec; padding: 18px; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.note p { margin-bottom: 0; color: #526c74; line-height: 1.65; }
.legal-notice { max-width: 760px; margin: 18px 0; padding: 14px 16px; border-left: 4px solid #08786e; border-radius: 8px; background: #f0f8f6; color: #36545d; line-height: 1.55; }
.consent-control { max-width: 760px; margin: 0 0 16px; }
.consent-control label { display: flex; align-items: flex-start; gap: 10px; color: #36545d; font-size: .94rem; line-height: 1.5; cursor: pointer; }
.consent-control input { width: 18px; height: 18px; margin: 2px 0 0; flex: 0 0 auto; accent-color: #08786e; }
button:disabled { cursor: not-allowed; opacity: .55; }
a { color: #076c64; text-underline-offset: 2px; }
a:hover { color: #064f4a; }
.legal-main { width: min(840px, calc(100% - 32px)); }
.legal-document { padding: clamp(24px, 5vw, 52px); }
.legal-document h1 { margin-top: 6px; font-size: clamp(2rem, 6vw, 3.25rem); }
.legal-document h2 { margin-top: 34px; font-size: 1.35rem; }
.legal-document h3 { margin: 24px 0 6px; color: #21444e; font-size: 1rem; }
.legal-document p, .legal-document li { color: #405e67; line-height: 1.72; }
.legal-document ul { padding-left: 22px; }
.legal-meta { margin: 12px 0 30px; color: #61777e; font-size: .9rem; }
.back-link { display: inline-block; margin-bottom: 28px; font-weight: 700; text-decoration: none; }
.site-footer { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px 20px; padding: 8px 16px 24px; color: #60767d; font-size: .88rem; }
.site-footer a { font-weight: 700; }
[hidden] { display: none !important; }
@media (max-width: 700px) {
  main { margin: 20px auto; }
  .card, .hero { padding: 22px; }
  .section-heading { align-items: flex-start; flex-direction: column; }
  .search-row { grid-template-columns: 1fr; }
  .resource-id-control { grid-column: 1 / -1; grid-template-columns: 1fr; }
  .temporal-graph-heading { flex-direction: column; }
  .timeline-event { grid-template-columns: 1fr; gap: 5px; }
  .timeline-event-undated .timeline-time-empty { display: none; }
  .field-check-row { grid-template-columns: 1fr; }
  .result-card dl, .timeline-event-card dl { grid-template-columns: 1fr; gap: 3px; }
  .result-card dd + dt, .timeline-event-card dd + dt { margin-top: 7px; }
}
`;

export const browserScript = `
const statusElement = document.querySelector('#status');
const connectForm = document.querySelector('#connect-form');
const connectButton = document.querySelector('#connect');
const legalConsent = document.querySelector('#legal-consent');
const legalConsentCheckbox = document.querySelector('#legal-consent-checkbox');
const policyVersionInput = document.querySelector('#policy-version');
const disconnectButton = document.querySelector('#disconnect');
const notice = document.querySelector('#notice');
const explorer = document.querySelector('#explorer');
const result = document.querySelector('#result');
const resultStatus = document.querySelector('#result-status');
const resultError = document.querySelector('#result-error');
const temporalGraph = document.querySelector('#temporal-graph');
const temporalGraphSummary = document.querySelector('#temporal-graph-summary');
const temporalGraphList = document.querySelector('#temporal-graph-list');
const temporalGraphOrder = document.querySelector('#temporal-graph-order');
const resultList = document.querySelector('#result-list');
const responseTrace = document.querySelector('#response-trace');
const responseTraceSource = document.querySelector('#response-trace-source');
const responseTraceConnector = document.querySelector('#response-trace-connector');
const responseTraceDisplay = document.querySelector('#response-trace-display');
const responseTraceReference = document.querySelector('#response-trace-reference');
const fieldCheckForm = document.querySelector('#field-check-form');
const fieldCheckPath = document.querySelector('#field-check-path');
const fieldCheckButton = document.querySelector('#field-check');
const fieldCheckResult = document.querySelector('#field-check-result');
const advancedResult = document.querySelector('#advanced-result');
const copyResourcesButton = document.querySelector('#copy-resources');
const copyResourcesStatus = document.querySelector('#copy-resources-status');
const paginationControls = document.querySelector('#pagination-controls');
const patientButton = document.querySelector('#patient');
const searchForm = document.querySelector('#search-form');
const searchButton = document.querySelector('#search');
const resourceType = document.querySelector('#resource-type');
const resourceIdControl = document.querySelector('#resource-id-control');
const resourceIdInput = document.querySelector('#resource-id');
const carePlanTypeControl = document.querySelector('#careplan-type-control');
const carePlanTypeSelect = document.querySelector('#careplan-type');
const searchConstraints = document.querySelector('#search-constraints');
const searchConstraintFields = document.querySelector('#search-constraint-fields');
const searchConstraintHint = document.querySelector('#search-constraint-hint');
const capabilityNotice = document.querySelector('#capability-notice');
const countLabel = document.querySelector('#count-label');
const countInput = document.querySelector('#count');
const grantedAccess = document.querySelector('#granted-access');
const grantedScopeCount = document.querySelector('#granted-scope-count');
const grantedScopes = document.querySelector('#granted-scopes');
const scopeWarning = document.querySelector('#scope-warning');
const healthHub = document.querySelector('#health-hub');
const hubConfiguredInput = document.querySelector('#hub-configured');
const hubPolicyVersionInput = document.querySelector('#hub-policy-version');
const hubStatus = document.querySelector('#hub-status');
const hubError = document.querySelector('#hub-error');
const hubEnablePanel = document.querySelector('#hub-enable-panel');
const hubConsentCheckbox = document.querySelector('#hub-consent-checkbox');
const hubEnableButton = document.querySelector('#hub-enable');
const hubControls = document.querySelector('#hub-controls');
const hubCounts = document.querySelector('#hub-counts');
const hubRefreshButton = document.querySelector('#hub-refresh');
const hubIntelligenceButton = document.querySelector('#hub-intelligence');
const hubResourcesButton = document.querySelector('#hub-resources');
const hubExportButton = document.querySelector('#hub-export');
const hubDeleteStageButton = document.querySelector('#hub-delete-stage');
const hubDeletePanel = document.querySelector('#hub-delete-panel');
const hubDeleteCheckbox = document.querySelector('#hub-delete-checkbox');
const hubConfirmDeleteButton = document.querySelector('#hub-confirm-delete');
const hubCancelDeleteButton = document.querySelector('#hub-cancel-delete');
const hubIntelligenceView = document.querySelector('#hub-intelligence-view');
const hubProjections = document.querySelector('#hub-projections');
const hubInsights = document.querySelector('#hub-insights');
const hubAdvancedResult = document.querySelector('#hub-advanced-result');
const hubResult = document.querySelector('#hub-result');

let currentConnectionKey = null;
let dataRequestSequence = 0;
let dataRequestController = null;
let copyRequestSequence = 0;
let statusRequestSequence = 0;
let statusRequestController = null;
let hubRequestSequence = 0;
let hubRequestController = null;
let hubBusy = false;
let disconnecting = false;
let patientReadAllowed = false;
let effectiveCapabilities = new Map();
let searchableCapabilities = new Map();
let directReadableCapabilities = new Map();
let activeConstraintControls = [];
let activeResultButtons = [];
let activeTimelineButtons = [];
let currentDataView = null;
let currentResponseTrace = null;
let temporalEvents = [];
let temporalRecordCount = 0;
let temporalDatedRecordCount = 0;
let temporalUndatedCount = 0;
let temporalNewestFirst = false;
let lifecycleStatusPromise = null;
const hubConfigured = hubConfiguredInput.value === 'true';
const connectionChannel = typeof window.BroadcastChannel === 'function'
  ? new window.BroadcastChannel('epic-connection-state-v1')
  : null;

const knownFhirTraceTransforms = new Set([
  'json-parsed',
  'validated',
  'bundle-links-rewritten',
  'derived-from-encounter-references',
  'bundle-generated',
]);

function safeResponseHeader(response, name, pattern, maximumLength) {
  const value = response.headers.get(name);
  if (!value || value.length > maximumLength || !pattern.test(value)) return null;
  return value;
}

function responseRequestId(response) {
  return safeResponseHeader(response, 'X-Request-ID', /^[A-Za-z0-9._:-]+$/, 128);
}

function readFhirResponseTrace(response) {
  const source = safeResponseHeader(
    response,
    'X-Moonba-FHIR-Source',
    /^(?:epic|connector-derived)$/,
    32,
  );
  const interaction = safeResponseHeader(
    response,
    'X-Moonba-FHIR-Interaction',
    /^(?:read|search)$/,
    16,
  );
  const resourceType = safeResponseHeader(
    response,
    'X-Moonba-FHIR-Resource-Type',
    /^[A-Z][A-Za-z0-9]{0,63}$/,
    64,
  );
  const transformHeader = response.headers.get('X-Moonba-FHIR-Transforms');
  const transforms = typeof transformHeader === 'string' && transformHeader.length <= 256
    ? transformHeader.split(',').map((value) => value.trim()).filter((value) =>
        knownFhirTraceTransforms.has(value)
      )
    : [];
  const fieldsPreserved = response.headers.get('X-Moonba-FHIR-Resource-Fields') === 'preserved';
  return {
    source,
    interaction,
    resourceType,
    transforms,
    fieldsPreserved,
    requestId: responseRequestId(response),
    status: response.status,
  };
}

async function api(path, options) {
  const requestOptions = options || {};
  const requestHeaders = requestOptions.headers || {};
  const expectedConnectionContext = requestOptions.expectedConnectionContext;
  const captureFhirTrace = requestOptions.captureFhirTrace === true;
  const fetchOptions = { ...requestOptions };
  delete fetchOptions.expectedConnectionContext;
  delete fetchOptions.captureFhirTrace;
  const headers = new Headers(requestHeaders);
  headers.set('Accept', 'application/json');
  if (typeof expectedConnectionContext === 'string') {
    headers.set('X-Epic-Expected-Connection-Context', expectedConnectionContext);
  }
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...fetchOptions,
    headers,
  });
  const responseConnectionContext = response.headers.get('X-Epic-Connection-Context');
  if (
    typeof expectedConnectionContext === 'string' &&
    ((response.ok && responseConnectionContext !== expectedConnectionContext) ||
      (responseConnectionContext !== null && responseConnectionContext !== expectedConnectionContext))
  ) {
    if (response.body) await response.body.cancel().catch(() => undefined);
    const error = new Error('The MyChart account context changed. Review the current connection before loading data.');
    error.code = 'connection_context_changed';
    error.status = 409;
    error.requestId = responseRequestId(response);
    throw error;
  }
  const body = await response.json().catch(() => ({ error: { message: 'Invalid server response.' } }));
  if (!response.ok) {
    const apiError = body && body.error && typeof body.error === 'object' ? body.error : {};
    const error = new Error(typeof apiError.message === 'string' ? apiError.message : 'Request failed.');
    error.code = typeof apiError.code === 'string' ? apiError.code : 'request_failed';
    error.status = response.status;
    error.requestId = responseRequestId(response);
    throw error;
  }
  return captureFhirTrace
    ? { value: body, trace: readFhirResponseTrace(response) }
    : body;
}

function isAbortError(error) {
  return error && typeof error === 'object' && error.name === 'AbortError';
}

function isAuthenticationLoss(error) {
  return error && typeof error === 'object' && (
    error.status === 401 ||
    error.code === 'reconnect_required' ||
    error.code === 'invalid_session' ||
    error.code === 'connection_context_changed'
  );
}

function normalizeCapabilities(connection) {
  const normalized = new Map();
  if (!Array.isArray(connection.capabilities)) return normalized;
  for (const candidate of connection.capabilities) {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      typeof candidate.resourceType !== 'string' ||
      !/^[A-Z][A-Za-z0-9]{0,63}$/.test(candidate.resourceType)
    ) continue;

    let readConstraintsValid = candidate.read !== true ||
      Array.isArray(candidate.readConstraintAlternatives);
    const readConstraintAlternatives = [];
    if (candidate.read === true && readConstraintsValid) {
      for (const alternative of candidate.readConstraintAlternatives) {
        if (!Array.isArray(alternative)) {
          readConstraintsValid = false;
          break;
        }
        const normalizedAlternative = [];
        for (const constraint of alternative) {
          if (
            !constraint ||
            typeof constraint !== 'object' ||
            typeof constraint.name !== 'string' ||
            !/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(constraint.name) ||
            typeof constraint.value !== 'string' ||
            constraint.value.length === 0 ||
            constraint.value.length > 2048 ||
            /[\\r\\n\\0]/.test(constraint.value)
          ) {
            readConstraintsValid = false;
            break;
          }
          normalizedAlternative.push({ name: constraint.name, value: constraint.value });
        }
        if (!readConstraintsValid) break;
        readConstraintAlternatives.push(normalizedAlternative);
      }
      if (readConstraintAlternatives.length === 0) readConstraintsValid = false;
    }

    let constraintsValid = Array.isArray(candidate.searchConstraints);
    const searchConstraints = [];
    if (constraintsValid) {
      for (const constraint of candidate.searchConstraints) {
        if (
          !constraint ||
          typeof constraint !== 'object' ||
          typeof constraint.name !== 'string' ||
          !/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(constraint.name) ||
          !Array.isArray(constraint.values)
        ) {
          constraintsValid = false;
          break;
        }
        const values = [...new Set(constraint.values.filter((value) =>
          typeof value === 'string' &&
          value.length > 0 &&
          value.length <= 2048 &&
          !/[\\r\\n\\0]/.test(value)
        ))];
        if (values.length === 0) {
          constraintsValid = false;
          break;
        }
        searchConstraints.push({ name: constraint.name, values });
      }
    }
    normalized.set(candidate.resourceType, {
      read: candidate.read === true && readConstraintsValid,
      readConstraintAlternatives,
      search: candidate.search === true && constraintsValid,
      searchConstraints,
    });
  }
  return normalized;
}

function collectResourceCodings(value) {
  if (Array.isArray(value)) return value.flatMap(collectResourceCodings);
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value.coding)) return value.coding.flatMap(collectResourceCodings);
  return typeof value.code === 'string' ? [value] : [];
}

function codingMatchesConstraintToken(coding, token) {
  const system = typeof coding.system === 'string' ? coding.system : '';
  const code = typeof coding.code === 'string' ? coding.code : '';
  const separator = token.indexOf('|');
  if (separator === -1) return code === token;
  const requiredSystem = token.slice(0, separator);
  const requiredCode = token.slice(separator + 1);
  return (requiredSystem.length === 0 ? system.length === 0 : system === requiredSystem) &&
    (requiredCode.length === 0 || code === requiredCode);
}

function resourceMatchesReadConstraint(resource, constraint) {
  if (constraint.name.includes(':')) return false;
  const value = resource[constraint.name];
  if (typeof value === 'string') {
    return constraint.value.split(',').some((candidate) => candidate === value);
  }
  const codings = collectResourceCodings(value);
  return codings.length > 0 && constraint.value.split(',').some((token) =>
    codings.some((coding) => codingMatchesConstraintToken(coding, token))
  );
}

function canReadResource(resource, capability) {
  return capability.read === true &&
    capability.readConstraintAlternatives.some((alternative) =>
      alternative.every((constraint) => resourceMatchesReadConstraint(resource, constraint))
    );
}

function humanizeCode(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function friendlyConstraintName(name) {
  const names = {
    authoredon: 'Authored date',
    category: 'Category',
    class: 'Visit class',
    'clinical-status': 'Clinical status',
    code: 'Clinical code',
    date: 'Date',
    docstatus: 'Document status',
    status: 'Status',
    type: 'Type',
  };
  return names[name] || humanizeCode(name);
}

function friendlyConstraintValue(value) {
  const separator = value.lastIndexOf('|');
  const code = separator === -1 ? value : value.slice(separator + 1);
  const knownValues = {
    laboratory: 'Laboratory results',
    'social-history': 'Social history',
    'vital-signs': 'Vital signs',
    'health-concern': 'Health concerns',
    'problem-list-item': 'Problem list',
    'clinical-note': 'Clinical notes',
  };
  return knownValues[code] || humanizeCode(code);
}

function clearConstraintControls() {
  activeConstraintControls = [];
  searchConstraintFields.replaceChildren();
  searchConstraintHint.textContent = '';
  searchConstraints.hidden = true;
}

function updateSearchConstraints(preserveSelections = false) {
  const previousSelections = preserveSelections
    ? new Map(activeConstraintControls.map((control) => [control.name, control.select.value]))
    : new Map();
  clearConstraintControls();
  const capability = searchableCapabilities.get(resourceType.value);
  if (!capability || capability.searchConstraints.length === 0) return;

  capability.searchConstraints
    .filter((constraint) => resourceType.value !== 'CarePlan' || constraint.name !== 'category')
    .forEach((constraint, index) => {
    const field = document.createElement('div');
    field.className = 'constraint-field';
    const label = document.createElement('label');
    const select = document.createElement('select');
    const selectId = 'search-constraint-' + index;
    label.setAttribute('for', selectId);
    label.textContent = friendlyConstraintName(constraint.name);
    select.setAttribute('id', selectId);
    select.setAttribute('aria-describedby', 'search-constraint-hint');
    select.required = true;
    for (const value of constraint.values) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = friendlyConstraintValue(value);
      select.append(option);
    }
    const previousValue = previousSelections.get(constraint.name);
    select.value = previousValue && constraint.values.includes(previousValue)
      ? previousValue
      : constraint.values[0];
    field.append(label, select);
    searchConstraintFields.append(field);
    activeConstraintControls.push({ name: constraint.name, select });
  });
  if (activeConstraintControls.length === 0) return;
  searchConstraintHint.textContent = 'Your MyChart authorization requires the selected filter' +
    (activeConstraintControls.length === 1 ? '' : 's') + ' for this search.';
  searchConstraints.hidden = false;
}

function updateCarePlanTypeControl(preserveSelection = false) {
  const capability = searchableCapabilities.get(resourceType.value);
  const selected = resourceType.value === 'CarePlan' && Boolean(capability);
  carePlanTypeControl.hidden = !selected;
  carePlanTypeSelect.required = selected;

  if (!selected) {
    carePlanTypeSelect.disabled = true;
    if (!preserveSelection) carePlanTypeSelect.value = '';
    return;
  }

  const categoryConstraint = capability.searchConstraints.find(
    (constraint) => constraint.name === 'category',
  );
  const authorizedCategories = categoryConstraint
    ? new Set(categoryConstraint.values)
    : null;
  for (const option of Array.from(carePlanTypeSelect.options || [])) {
    const available = !option.value || !authorizedCategories || authorizedCategories.has(option.value);
    option.hidden = !available;
    option.disabled = !available;
  }
  const currentOption = Array.from(carePlanTypeSelect.options || []).find(
    (option) => option.value === carePlanTypeSelect.value,
  );
  if (!preserveSelection || !currentOption || currentOption.disabled) {
    carePlanTypeSelect.value = '';
  }
}

function isDirectReadOption(option) {
  return option.getAttribute('data-interaction') === 'read';
}

function syncResourceOptionGroups() {
  for (const group of Array.from(resourceType.children || [])) {
    if (group.tagName !== 'OPTGROUP') continue;
    const options = Array.from(group.children || []).filter((child) => child.tagName === 'OPTION');
    const available = options.some((option) => !option.hidden && !option.disabled);
    group.hidden = !available;
    group.disabled = !available;
  }
}

function updateResourceActionControls(preserveSelections = false) {
  const directRead = directReadableCapabilities.has(resourceType.value);
  resourceIdControl.hidden = !directRead;
  resourceIdInput.required = directRead;
  countLabel.hidden = directRead;
  countInput.hidden = directRead;
  searchButton.textContent = directRead ? 'View record' : 'Find records';
  if (directRead) {
    clearConstraintControls();
  } else {
    updateSearchConstraints(preserveSelections);
  }
  updateCarePlanTypeControl(preserveSelections);
}

function clearEffectiveCapabilities() {
  patientReadAllowed = false;
  effectiveCapabilities = new Map();
  searchableCapabilities = new Map();
  directReadableCapabilities = new Map();
  clearConstraintControls();
  carePlanTypeControl.hidden = true;
  carePlanTypeSelect.value = '';
  carePlanTypeSelect.required = false;
  carePlanTypeSelect.disabled = true;
  resourceIdControl.hidden = true;
  resourceIdInput.value = '';
  resourceIdInput.required = false;
  countLabel.hidden = false;
  countInput.hidden = false;
  searchButton.textContent = 'Find records';
  patientButton.hidden = true;
  patientButton.disabled = true;
  searchForm.hidden = true;
  capabilityNotice.textContent = '';
  capabilityNotice.hidden = true;
  for (const option of Array.from(resourceType.options || [])) {
    option.hidden = true;
    option.disabled = true;
  }
  syncResourceOptionGroups();
  resourceType.value = '';
}

function applyEffectiveCapabilities(connection) {
  const capabilities = normalizeCapabilities(connection);
  effectiveCapabilities = capabilities;
  patientReadAllowed = capabilities.get('Patient')?.read === true;
  patientButton.hidden = !patientReadAllowed;

  searchableCapabilities = new Map();
  directReadableCapabilities = new Map();
  let firstAvailableOption = null;
  for (const option of Array.from(resourceType.options || [])) {
    const capability = capabilities.get(option.value);
    const directRead = isDirectReadOption(option);
    const available = option.value !== 'Binary' && (directRead
      ? capability?.read === true
      : capability?.search === true);
    option.hidden = !available;
    option.disabled = !available;
    if (available) {
      if (directRead) {
        directReadableCapabilities.set(option.value, capability);
      } else {
        searchableCapabilities.set(option.value, capability);
      }
      if (!firstAvailableOption) firstAvailableOption = option;
    }
  }
  syncResourceOptionGroups();

  if (
    !searchableCapabilities.has(resourceType.value) &&
    !directReadableCapabilities.has(resourceType.value)
  ) {
    resourceType.value = firstAvailableOption ? firstAvailableOption.value : '';
  }
  searchForm.hidden = firstAvailableOption === null;
  capabilityNotice.hidden = patientReadAllowed || firstAvailableOption !== null;
  capabilityNotice.textContent = capabilityNotice.hidden
    ? ''
    : 'No supported read or search actions were granted for this connection.';
  updateResourceActionControls(true);
}

function setDataControlsDisabled(disabled) {
  const noResourceOptions = searchableCapabilities.size + directReadableCapabilities.size === 0;
  const searchSelected = searchableCapabilities.has(resourceType.value);
  const directReadSelected = directReadableCapabilities.has(resourceType.value);
  patientButton.disabled = disabled || !patientReadAllowed;
  resourceType.disabled = disabled || noResourceOptions;
  resourceIdInput.disabled = disabled || !directReadSelected;
  countInput.disabled = disabled || !searchSelected;
  carePlanTypeSelect.disabled = disabled || resourceType.value !== 'CarePlan' || !searchSelected;
  searchButton.disabled = disabled || (!searchSelected && !directReadSelected);
  for (const control of activeConstraintControls) {
    control.select.disabled = disabled;
  }
  for (const button of activeResultButtons) {
    button.disabled = disabled;
  }
  for (const button of activeTimelineButtons) {
    button.disabled = disabled;
  }
  const datedEventCount = temporalEvents.filter((event) => !event.undated).length;
  temporalGraphOrder.disabled = disabled || datedEventCount < 2;
}

function clearNotice() {
  notice.textContent = '';
  notice.hidden = true;
}

function clearGrantedAccess() {
  grantedAccess.hidden = true;
  grantedAccess.open = false;
  grantedScopeCount.textContent = '';
  grantedScopes.textContent = '';
  scopeWarning.textContent = '';
  scopeWarning.hidden = true;
}

function clearTemporalGraph() {
  temporalEvents = [];
  activeTimelineButtons = [];
  temporalRecordCount = 0;
  temporalDatedRecordCount = 0;
  temporalUndatedCount = 0;
  temporalGraphList.replaceChildren();
  temporalGraphList.hidden = true;
  temporalGraphSummary.textContent = '';
  temporalGraphOrder.textContent = temporalNewestFirst ? 'Show oldest first' : 'Show newest first';
  temporalGraphOrder.hidden = true;
  temporalGraphOrder.disabled = true;
  temporalGraph.hidden = true;
}

function resourcesInFhirResponse(value) {
  if (!value || typeof value !== 'object') return [];
  if (value.resourceType !== 'Bundle') {
    return typeof value.resourceType === 'string' ? [value] : [];
  }
  if (!Array.isArray(value.entry)) return [];
  return value.entry.map((entry) =>
    entry && typeof entry === 'object' && entry.resource && typeof entry.resource === 'object'
      ? entry.resource
      : null
  ).filter(Boolean);
}

function primaryResourcesInFhirResponse(value) {
  if (!value || typeof value !== 'object' || value.resourceType !== 'Bundle') {
    return resourcesInFhirResponse(value);
  }
  if (!Array.isArray(value.entry)) return [];
  return value.entry.map((entry) => {
    const resource = entry && typeof entry === 'object' ? entry.resource : null;
    if (!resource || typeof resource !== 'object' || resource.resourceType === 'OperationOutcome') {
      return null;
    }
    if (
      resource.resourceType === 'Provenance' && entry.search &&
      typeof entry.search === 'object' && entry.search.mode === 'include'
    ) return null;
    return resource;
  }).filter(Boolean);
}

function responseHasIncompleteOutcome(value) {
  return resourcesInFhirResponse(value).some((resource) =>
    resource.resourceType === 'OperationOutcome' && Array.isArray(resource.issue) &&
    resource.issue.some((issue) =>
      issue && typeof issue === 'object' && issue.code === 'incomplete'
    )
  );
}

function renderResponseTrace(value, trace) {
  currentResponseTrace = { value, trace };
  fieldCheckPath.value = '';
  fieldCheckResult.textContent = '';
  fieldCheckButton.disabled = false;

  const resourceType = trace && typeof trace.resourceType === 'string'
    ? trace.resourceType
    : value && typeof value === 'object' && typeof value.resourceType === 'string'
      ? value.resourceType
      : 'FHIR';
  const primaryResources = primaryResourcesInFhirResponse(value);
  const includedProvenanceCount = value && typeof value === 'object' &&
      value.resourceType === 'Bundle' && Array.isArray(value.entry)
    ? value.entry.filter((entry) => {
        const resource = entry && typeof entry === 'object' ? entry.resource : null;
        return resource && typeof resource === 'object' && resource.resourceType === 'Provenance' &&
          entry.search && typeof entry.search === 'object' && entry.search.mode === 'include';
      }).length
    : 0;
  const outcomeCount = resourcesInFhirResponse(value).filter((resource) =>
    resource.resourceType === 'OperationOutcome'
  ).length;

  if (trace && trace.source === 'connector-derived') {
    responseTraceSource.textContent = 'This is not a direct Epic Location search response. The connector searched the authorized patient’s Encounters and then read same-server Location resources referenced by them.';
  } else if (trace && trace.source === 'epic' && trace.interaction === 'search') {
    responseTraceSource.textContent = 'Epic returned this ' + resourceType + ' search page under the current patient grant, requested filters, and result count.';
  } else if (trace && trace.source === 'epic' && trace.interaction === 'read') {
    responseTraceSource.textContent = 'Epic returned this ' + resourceType + ' resource for the current patient-authorized read.';
  } else {
    responseTraceSource.textContent = 'The application did not receive enough safe trace metadata to attest whether this payload is direct or connector-derived.';
  }

  if (trace && trace.fieldsPreserved) {
    responseTraceConnector.textContent = 'The connector parsed and validated the FHIR JSON and preserved every field on each returned resource.';
  } else {
    responseTraceConnector.textContent = 'Resource-field preservation was not attested for this response, so use the complete application JSON without assuming it is identical to the source payload.';
  }
  if (trace && trace.transforms.includes('bundle-links-rewritten')) {
    responseTraceConnector.textContent += ' It replaced Epic’s Bundle navigation links with a safe, session-bound next-page link; other upstream Bundle links are not exposed.';
  }
  if (trace && trace.transforms.includes('derived-from-encounter-references')) {
    responseTraceConnector.textContent += ' It selected bounded Encounter location references and generated the Bundle shown here.';
  }
  if (responseHasIncompleteOutcome(value)) {
    responseTraceConnector.textContent += ' A processing notice marks this derived result as incomplete; some referenced locations may be unresolved, unavailable, or beyond a safety limit.';
  }

  const allFieldsExpanded = primaryResources.length > 0 && primaryResources.every((resource) =>
    resource.resourceType === 'Patient' || resource.resourceType === 'Location'
  );
  if (primaryResources.length === 0) {
    responseTraceDisplay.textContent = 'No primary resource was available to summarize on this response page.';
  } else if (allFieldsExpanded) {
    responseTraceDisplay.textContent = 'The readable view expands every top-level field returned for ' +
      primaryResources.length + ' resource' + (primaryResources.length === 1 ? '' : 's') +
      '; nested content is rendered as structured text.';
  } else {
    responseTraceDisplay.textContent = 'The readable view is a selective summary of ' +
      primaryResources.length + ' resource' + (primaryResources.length === 1 ? '' : 's') +
      '. A field can reach the browser but appear only in the complete application JSON below.';
  }
  if (includedProvenanceCount > 0 || outcomeCount > 0) {
    responseTraceDisplay.textContent += ' ' + [
      includedProvenanceCount > 0
        ? includedProvenanceCount + ' included Provenance record' + (includedProvenanceCount === 1 ? ' is' : 's are') + ' Advanced-only'
        : '',
      outcomeCount > 0
        ? outcomeCount + ' processing notice' + (outcomeCount === 1 ? ' is' : 's are') + ' summarized rather than shown as a health record'
        : '',
    ].filter(Boolean).join('; ') + '.';
  }

  const statusText = trace && Number.isInteger(trace.status) ? 'HTTP ' + trace.status : '';
  const requestText = trace && typeof trace.requestId === 'string'
    ? 'Request reference: ' + trace.requestId + '. Share this reference with support instead of sharing health JSON or a screenshot.'
    : 'No safe request reference was available for this response.';
  responseTraceReference.textContent = [statusText, requestText].filter(Boolean).join(' · ');
  responseTrace.hidden = false;
  responseTrace.open = false;
}

function valueContainsFieldName(value, fieldName, state) {
  if (!value || typeof value !== 'object') return false;
  if (state.inspected >= 20000) {
    state.limitReached = true;
    return false;
  }
  state.inspected += 1;
  if (Array.isArray(value)) {
    return value.some((item) => valueContainsFieldName(item, fieldName, state));
  }
  if (Object.prototype.hasOwnProperty.call(value, fieldName)) return true;
  return Object.values(value).some((item) => valueContainsFieldName(item, fieldName, state));
}

function valueContainsFieldPath(value, segments, index, state) {
  if (value === null || value === undefined) return false;
  if (state.inspected >= 20000) {
    state.limitReached = true;
    return false;
  }
  state.inspected += 1;
  if (Array.isArray(value)) {
    return value.some((item) => valueContainsFieldPath(item, segments, index, state));
  }
  if (typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, segments[index])) {
    return false;
  }
  if (index === segments.length - 1) return true;
  return valueContainsFieldPath(value[segments[index]], segments, index + 1, state);
}

function resourcesMatchingField(resources, segments) {
  const matches = [];
  const state = { inspected: 0, limitReached: false };
  for (const resource of resources) {
    const path = segments[0] === resource.resourceType ? segments.slice(1) : segments;
    if (path.length === 0) {
      matches.push(resource);
      continue;
    }
    const matched = path.length === 1
      ? valueContainsFieldName(resource, path[0], state)
      : valueContainsFieldPath(resource, path, 0, state);
    if (matched) matches.push(resource);
  }
  return { matches, complete: !state.limitReached };
}

fieldCheckForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!currentResponseTrace || fieldCheckButton.disabled) return;
  const pathText = fieldCheckPath.value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*){0,15}$/.test(pathText)) {
    fieldCheckResult.textContent = 'Enter a FHIR field name or dot path using letters, numbers, and underscores, with at most 16 path parts.';
    return;
  }
  const segments = pathText.split('.');
  const resources = resourcesInFhirResponse(currentResponseTrace.value);
  const fieldSearch = resourcesMatchingField(resources, segments);
  const matches = fieldSearch.matches;
  const trace = currentResponseTrace.trace;
  if (matches.length > 0) {
    const types = [...new Set(matches.map((resource) => resource.resourceType).filter((value) =>
      typeof value === 'string'
    ))].sort();
    fieldCheckResult.textContent = 'Found “' + pathText + '” in ' +
      (fieldSearch.complete ? '' : 'at least ') + matches.length + ' returned resource' +
      (matches.length === 1 ? '' : 's') + (types.length > 0 ? ' (' + types.join(', ') + ')' : '') +
      '. It reached this browser in the complete application JSON. If it is absent from the friendly view, the UI summary omitted it.';
    return;
  }
  if (!fieldSearch.complete) {
    fieldCheckResult.textContent = '“' + pathText + '” was not found before the safe in-browser inspection limit was reached. Search the complete application JSON below; this bounded check cannot classify the field as absent.';
    return;
  }
  if (!trace || trace.fieldsPreserved !== true) {
    fieldCheckResult.textContent = '“' + pathText + '” is not present in the application response. Because field-preservation trace metadata is unavailable, this view cannot determine where it was lost.';
  } else if (trace.source === 'epic' && trace.interaction === 'read') {
    fieldCheckResult.textContent = '“' + pathText + '” is not present. The connector preserved returned resource fields, so Epic did not include this field or path in this read response.';
  } else if (trace.source === 'epic' && trace.interaction === 'search') {
    fieldCheckResult.textContent = '“' + pathText + '” is not present in any resource on this Epic search page. The connector preserved returned resource fields, but filters, the current grant, result limits, or another page may still affect what Epic returned.';
  } else if (trace.source === 'connector-derived') {
    fieldCheckResult.textContent = '“' + pathText + '” is not present in this connector-derived response. Because only bounded, Encounter-referenced Locations were fetched, this does not prove that Epic lacks the field or another Location.';
  } else {
    fieldCheckResult.textContent = '“' + pathText + '” is not present in the application response. The source mode was not safely attested, so this view cannot determine whether the field was absent upstream or transformed before display.';
  }
});

function clearDataDisplay(message = 'No health data loaded.') {
  currentDataView = null;
  currentResponseTrace = null;
  copyRequestSequence += 1;
  copyResourcesButton.disabled = true;
  copyResourcesStatus.textContent = '';
  result.textContent = '';
  clearTemporalGraph();
  resultList.replaceChildren();
  resultList.hidden = true;
  activeResultButtons = [];
  responseTraceSource.textContent = '';
  responseTraceConnector.textContent = '';
  responseTraceDisplay.textContent = '';
  responseTraceReference.textContent = '';
  fieldCheckPath.value = '';
  fieldCheckResult.textContent = '';
  fieldCheckButton.disabled = true;
  responseTrace.hidden = true;
  responseTrace.open = false;
  advancedResult.hidden = true;
  advancedResult.open = false;
  resultError.textContent = '';
  resultError.hidden = true;
  resultStatus.textContent = message;
  paginationControls.replaceChildren();
  paginationControls.hidden = true;
}

function clearHubSensitiveView() {
  hubProjections.textContent = '';
  hubInsights.textContent = '';
  hubIntelligenceView.hidden = true;
  hubResult.textContent = '';
  hubAdvancedResult.hidden = true;
  hubAdvancedResult.open = false;
}

function setHubControlsDisabled(disabled) {
  hubBusy = disabled;
  hubRefreshButton.disabled = disabled;
  hubIntelligenceButton.disabled = disabled;
  hubResourcesButton.disabled = disabled;
  hubExportButton.disabled = disabled;
  hubDeleteStageButton.disabled = disabled;
  hubEnableButton.disabled = disabled || !hubConsentCheckbox.checked;
  hubDeleteCheckbox.disabled = disabled;
  hubConfirmDeleteButton.disabled = disabled || !hubDeleteCheckbox.checked;
  hubCancelDeleteButton.disabled = disabled;
}

function clearHubError() {
  hubError.textContent = '';
  hubError.hidden = true;
}

function showHubError(error) {
  hubError.textContent = error instanceof Error
    ? error.message
    : 'The private health hub request failed.';
  hubError.hidden = false;
  hubError.focus();
}

function invalidateHubRequests() {
  hubRequestSequence += 1;
  if (hubRequestController) hubRequestController.abort();
  hubRequestController = null;
  healthHub.removeAttribute('aria-busy');
  hubBusy = false;
}

function resetHubUi() {
  invalidateHubRequests();
  clearHubSensitiveView();
  clearHubError();
  hubStatus.textContent = 'Checking private health hub…';
  hubCounts.textContent = '';
  hubConsentCheckbox.checked = false;
  hubDeleteCheckbox.checked = false;
  hubEnablePanel.hidden = true;
  hubControls.hidden = true;
  hubDeletePanel.hidden = true;
  hubRefreshButton.hidden = true;
  setHubControlsDisabled(true);
}

function invalidateDataRequests() {
  dataRequestSequence += 1;
  if (dataRequestController) dataRequestController.abort();
  dataRequestController = null;
  explorer.removeAttribute('aria-busy');
}

function invalidateStatusRequests() {
  statusRequestSequence += 1;
  if (statusRequestController) statusRequestController.abort();
  statusRequestController = null;
  statusElement.removeAttribute('aria-busy');
}

function scrubSensitiveUi(message = 'No health data loaded.') {
  invalidateDataRequests();
  clearDataDisplay(message);
  clearHubSensitiveView();
  clearGrantedAccess();
  clearEffectiveCapabilities();
  clearNotice();
}

function safeNextPageUrl(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.link)) return null;
  const link = value.link.find((candidate) =>
    candidate && typeof candidate === 'object' &&
    candidate.relation === 'next' && typeof candidate.url === 'string'
  );
  if (!link) return null;
  try {
    const parsed = new URL(link.url, window.location.origin);
    if (
      parsed.origin !== window.location.origin ||
      parsed.pathname !== '/api/fhir-page' ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      parsed.searchParams.size !== 1 ||
      parsed.searchParams.getAll('cursor').length !== 1 ||
      !/^[A-Za-z0-9_-]+$/.test(parsed.searchParams.get('cursor') || '')
    ) return null;
    return parsed.pathname + parsed.search;
  } catch {
    return null;
  }
}

function readableText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(readableText).filter(Boolean).join(', ');
  }
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string' && value.text.trim()) return value.text.trim();
  if (typeof value.display === 'string' && value.display.trim()) return value.display.trim();
  if (typeof value.name === 'string' && value.name.trim()) return value.name.trim();
  if (Array.isArray(value.coding)) {
    const coding = value.coding.map(readableText).find(Boolean);
    if (coding) return coding;
  }
  if (typeof value.code === 'string' && value.code.trim()) return humanizeCode(value.code.trim());
  if (typeof value.reference === 'string' && value.reference.trim()) {
    return typeof value.display === 'string' && value.display.trim()
      ? value.display.trim()
      : humanizeCode(value.reference.split('/')[0] || 'Related record');
  }
  if (typeof value.value === 'number' || typeof value.value === 'string') {
    const unit = typeof value.unit === 'string' ? value.unit.trim() : '';
    return String(value.value) + (unit ? ' ' + unit : '');
  }
  if (value.low !== undefined || value.high !== undefined) {
    const low = readableText(value.low);
    const high = readableText(value.high);
    if (low && high) return low + ' – ' + high;
    return low || high;
  }
  if (value.numerator !== undefined || value.denominator !== undefined) {
    const numerator = readableText(value.numerator);
    const denominator = readableText(value.denominator);
    if (numerator && denominator) return numerator + ' / ' + denominator;
    return numerator || denominator;
  }
  return '';
}

function humanName(value) {
  const candidate = Array.isArray(value) ? value.find((name) => name && typeof name === 'object') : value;
  if (!candidate || typeof candidate !== 'object') return readableText(value);
  if (typeof candidate.text === 'string' && candidate.text.trim()) return candidate.text.trim();
  const parts = [];
  if (Array.isArray(candidate.prefix)) parts.push(...candidate.prefix.filter((part) => typeof part === 'string'));
  if (Array.isArray(candidate.given)) parts.push(...candidate.given.filter((part) => typeof part === 'string'));
  if (typeof candidate.family === 'string') parts.push(candidate.family);
  if (Array.isArray(candidate.suffix)) parts.push(...candidate.suffix.filter((part) => typeof part === 'string'));
  return parts.map((part) => part.trim()).filter(Boolean).join(' ');
}

function readableDate(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const normalized = value.trim();
  if (/^\\d{4}$/.test(normalized)) return normalized;
  const monthOnly = /^(\\d{4})-(\\d{2})$/.exec(normalized);
  if (monthOnly) {
    const month = Number(monthOnly[2]);
    if (month < 1 || month > 12) return normalized;
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(Number(monthOnly[1]), month - 1, 1)));
  }
  const dateOnly = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(normalized);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const parsedDate = new Date(Date.UTC(year, month - 1, day));
    if (
      parsedDate.getUTCFullYear() !== year ||
      parsedDate.getUTCMonth() !== month - 1 ||
      parsedDate.getUTCDate() !== day
    ) return normalized;
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeZone: 'UTC',
    }).format(parsedDate);
  }
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return normalized;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

function readableConditionBoundaryPeriod(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const start = readableDate(value.start);
  const end = readableDate(value.end);
  if (start && end) return start + ' – ' + end;
  if (start) return 'On or after ' + start;
  return end ? 'On or before ' + end : '';
}

function conditionClinicalStatusCode(resource) {
  const status = resource.clinicalStatus || resource.status;
  if (typeof status === 'string') return status.trim().toLowerCase();
  if (!status || typeof status !== 'object' || Array.isArray(status)) return '';
  if (typeof status.code === 'string') return status.code.trim().toLowerCase();
  if (!Array.isArray(status.coding)) return '';
  const preferred = status.coding.find((coding) =>
    coding && coding.system === 'http://terminology.hl7.org/CodeSystem/condition-clinical' &&
    typeof coding.code === 'string'
  );
  const fallback = status.coding.find((coding) => coding && typeof coding.code === 'string');
  return ((preferred || fallback)?.code || '').trim().toLowerCase();
}

function conditionEndLabel(resource) {
  switch (conditionClinicalStatusCode(resource)) {
    case 'resolved':
      return 'Resolution';
    case 'remission':
      return 'Entered remission';
    case 'inactive':
      return 'Became inactive';
    default:
      return 'Ended';
  }
}

function firstPresentChoice(resource, names) {
  for (const name of names) {
    if (resource[name] !== undefined && resource[name] !== null) return resource[name];
  }
  return undefined;
}

function observationValue(resource) {
  const choiceNames = [
    'valueQuantity',
    'valueCodeableConcept',
    'valueString',
    'valueInteger',
    'valueDecimal',
    'valueBoolean',
    'valueRange',
    'valueRatio',
  ];
  const direct = readableText(firstPresentChoice(resource, choiceNames));
  if (direct) return direct;
  if (!Array.isArray(resource.component)) return '';
  return resource.component.slice(0, 4).map((component) => {
    if (!component || typeof component !== 'object') return '';
    const name = readableText(component.code);
    const value = readableText(firstPresentChoice(component, choiceNames));
    return name && value ? name + ': ' + value : value;
  }).filter(Boolean).join(' · ');
}

function resourceTitle(resource) {
  switch (resource.resourceType) {
    case 'Patient':
      return resourceHasUninterpretedSemantics(resource)
        ? 'Patient profile'
        : humanName(resource.name) || friendlyResourceName(resource.resourceType);
    case 'Practitioner':
    case 'RelatedPerson':
      return humanName(resource.name) || friendlyResourceName(resource.resourceType);
    case 'Organization':
    case 'Location':
      return readableText(resource.name) || friendlyResourceName(resource.resourceType);
    case 'CareTeam':
      return readableText(resource.name || resource.category) || 'Care team';
    case 'Goal':
      return readableText(resource.description) || 'Health goal';
    case 'DocumentReference':
      return readableText(resource.description || resource.type) || 'Clinical document';
    case 'Device':
      return readableText(resource.deviceName || resource.type || resource.modelNumber) || 'Medical device';
    case 'MedicationRequest':
      return readableText(resource.medicationCodeableConcept || resource.medicationReference) || 'Medication request';
    case 'Medication':
      return readableText(resource.code) || 'Medication';
    case 'Immunization':
      return readableText(resource.vaccineCode) || 'Immunization';
    case 'Observation':
    case 'Condition':
    case 'Procedure':
    case 'DiagnosticReport':
    case 'AllergyIntolerance':
      return readableText(resource.code) || friendlyResourceName(resource.resourceType);
    case 'Encounter':
      return readableText(resource.type || resource.class) || 'Visit or encounter';
    case 'CarePlan':
      return readableText(resource.title || resource.category) || 'Care plan';
    case 'PractitionerRole':
      return readableText(resource.specialty || resource.code) || 'Practitioner role';
    case 'Provenance':
      return 'Record provenance';
    default:
      return friendlyResourceName(resource.resourceType || 'FHIR record');
  }
}

function friendlyResourceName(resourceType) {
  const names = {
    AllergyIntolerance: 'Allergy or intolerance',
    CarePlan: 'Care plan',
    CareTeam: 'Care team',
    DiagnosticReport: 'Diagnostic report',
    DocumentReference: 'Clinical document',
    MedicationRequest: 'Medication request',
    PractitionerRole: 'Practitioner role',
    RelatedPerson: 'Related person',
  };
  return names[resourceType] || humanizeCode(resourceType);
}

const patientFieldOrder = [
  'resourceType',
  'id',
  'meta',
  'implicitRules',
  'language',
  'text',
  'contained',
  'extension',
  'modifierExtension',
  'identifier',
  'active',
  'name',
  'telecom',
  'gender',
  'birthDate',
  'deceasedBoolean',
  'deceasedDateTime',
  'address',
  'maritalStatus',
  'multipleBirthBoolean',
  'multipleBirthInteger',
  'photo',
  'contact',
  'communication',
  'generalPractitioner',
  'managingOrganization',
  'link',
];

const patientFieldLabels = {
  resourceType: 'Resource type',
  id: 'FHIR resource ID',
  meta: 'Record metadata',
  implicitRules: 'Implicit rules',
  language: 'Language',
  text: 'Narrative',
  contained: 'Contained resources',
  extension: 'Extensions',
  modifierExtension: 'Modifier extensions',
  identifier: 'Identifiers',
  active: 'Active',
  name: 'Names',
  telecom: 'Contact details',
  gender: 'Administrative gender',
  birthDate: 'Date of birth',
  deceasedBoolean: 'Deceased',
  deceasedDateTime: 'Date of death',
  address: 'Addresses',
  maritalStatus: 'Marital status',
  multipleBirthBoolean: 'Multiple birth',
  multipleBirthInteger: 'Birth order',
  photo: 'Photos',
  contact: 'Contacts',
  communication: 'Communication preferences',
  generalPractitioner: 'General practitioners',
  managingOrganization: 'Managing organization',
  link: 'Linked patient records',
};

function resourceHasUninterpretedSemantics(resource) {
  const pending = [resource];
  const seen = new Set();
  let inspected = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    inspected += 1;
    if (inspected > 10000) return true;
    if (!Array.isArray(value)) {
      if (
        Object.prototype.hasOwnProperty.call(value, 'implicitRules') &&
        value.implicitRules !== undefined && value.implicitRules !== null
      ) return true;
      if (Object.prototype.hasOwnProperty.call(value, 'modifierExtension')) {
        const modifiers = value.modifierExtension;
        if (!Array.isArray(modifiers) || modifiers.length > 0) return true;
      }
    }
    for (const item of Object.values(value)) {
      if (item && typeof item === 'object') pending.push(item);
    }
  }
  return false;
}

function indentStructuredText(value) {
  return value.split('\\n').map((line) => '  ' + line).join('\\n');
}

function structuredResourceText(value, depth = 0) {
  if (value === null) return '(null)';
  if (value === undefined) return '(undefined)';
  if (typeof value === 'string') {
    if (value.length === 0) return '(empty string)';
    return /^\\s+$/.test(value) ? JSON.stringify(value) : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (depth >= 12) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return '(value could not be displayed)';
    }
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '(empty list)';
    return value.map((item, index) => {
      const itemText = structuredResourceText(item, depth + 1);
      if (item && typeof item === 'object') {
        return String(index + 1) + '.\\n' + indentStructuredText(itemText);
      }
      return String(index + 1) + '. ' + itemText;
    }).join('\\n');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '(empty object)';
    return entries.map(([name, item]) => {
      const itemText = structuredResourceText(item, depth + 1);
      const label = humanizeCode(name) || name;
      if ((item && typeof item === 'object') || itemText.includes('\\n')) {
        return label + ':\\n' + indentStructuredText(itemText);
      }
      return label + ': ' + itemText;
    }).join('\\n');
  }
  return String(value);
}

function patientFieldValue(name, value) {
  if ((name === 'birthDate' || name === 'deceasedDateTime') && typeof value === 'string') {
    const formatted = readableDate(value);
    if (formatted && formatted !== value) return formatted + ' (' + value + ')';
  }
  if (name === 'gender' && typeof value === 'string') {
    return humanizeCode(value) || value;
  }
  return structuredResourceText(value);
}

function patientResourceDetails(resource) {
  const orderedNames = [];
  const seen = new Set();
  for (const name of patientFieldOrder) {
    if (Object.prototype.hasOwnProperty.call(resource, name)) {
      orderedNames.push(name);
      seen.add(name);
    }
  }
  for (const name of Object.keys(resource)) {
    if (!seen.has(name)) orderedNames.push(name);
  }
  return orderedNames.map((name) => ({
    label: Object.prototype.hasOwnProperty.call(patientFieldLabels, name)
      ? patientFieldLabels[name]
      : (humanizeCode(name) || name) + ' (' + name + ')',
    value: patientFieldValue(name, resource[name]),
    patientField: true,
  }));
}

const locationFieldOrder = [
  'resourceType',
  'id',
  'meta',
  'implicitRules',
  'language',
  'text',
  'contained',
  'extension',
  'modifierExtension',
  'identifier',
  'status',
  'operationalStatus',
  'name',
  'alias',
  'description',
  'mode',
  'type',
  'telecom',
  'address',
  'physicalType',
  'position',
  'managingOrganization',
  'partOf',
  'hoursOfOperation',
  'availabilityExceptions',
  'endpoint',
];

const locationFieldLabels = {
  resourceType: 'Resource type',
  id: 'FHIR resource ID',
  meta: 'Record metadata',
  implicitRules: 'Implicit rules',
  language: 'Language',
  text: 'Narrative',
  contained: 'Contained resources',
  extension: 'Extensions',
  modifierExtension: 'Modifier extensions',
  identifier: 'Identifiers',
  status: 'Status',
  operationalStatus: 'Operational status',
  name: 'Name',
  alias: 'Aliases',
  description: 'Description',
  mode: 'Mode',
  type: 'Types',
  telecom: 'Contact details',
  address: 'Address',
  physicalType: 'Physical type',
  position: 'Coordinates',
  managingOrganization: 'Managing organization',
  partOf: 'Parent location',
  hoursOfOperation: 'Hours of operation',
  availabilityExceptions: 'Availability exceptions',
  endpoint: 'Endpoints',
};

function locationResourceDetails(resource) {
  const orderedNames = [];
  const seen = new Set();
  for (const name of locationFieldOrder) {
    if (Object.prototype.hasOwnProperty.call(resource, name)) {
      orderedNames.push(name);
      seen.add(name);
    }
  }
  for (const name of Object.keys(resource)) {
    if (!seen.has(name)) orderedNames.push(name);
  }
  return orderedNames.map((name) => ({
    label: Object.prototype.hasOwnProperty.call(locationFieldLabels, name)
      ? locationFieldLabels[name]
      : (humanizeCode(name) || name) + ' (' + name + ')',
    value: structuredResourceText(resource[name]),
    locationField: true,
  }));
}

function resourceDetails(resource, options = {}) {
  if (resource.resourceType === 'Location') {
    return locationResourceDetails(resource);
  }
  if (resource.resourceType === 'Patient' && options.timeline !== true) {
    return patientResourceDetails(resource);
  }
  const details = [];
  const add = (label, value) => {
    const text = readableText(value);
    if (text && !details.some((detail) => detail.label === label && detail.value === text)) {
      details.push({ label, value: text });
    }
  };
  const addDate = (label, value) => {
    const text = readableDate(value);
    if (text) details.push({ label, value: text });
  };

  if (resource.resourceType === 'Patient') {
    addDate('Date of birth', resource.birthDate);
    add('Administrative sex', resource.gender && humanizeCode(resource.gender));
  } else if (resource.resourceType === 'Condition') {
    add(options.timeline === true ? 'Current status' : 'Status', resource.clinicalStatus || resource.status);
    add('Verification', resource.verificationStatus);
  } else {
    add('Status', resource.clinicalStatus || resource.status || resource.verificationStatus);
  }

  switch (resource.resourceType) {
    case 'Observation':
      add('Value', observationValue(resource));
      addDate('Date', resource.effectiveDateTime || resource.issued);
      break;
    case 'Condition':
      add(
        'Onset',
        readableDate(resource.onsetDateTime) || readableConditionBoundaryPeriod(resource.onsetPeriod),
      );
      add(
        conditionEndLabel(resource),
        readableDate(resource.abatementDateTime) ||
          readableConditionBoundaryPeriod(resource.abatementPeriod),
      );
      addDate('Recorded', resource.recordedDate);
      break;
    case 'Encounter':
      addDate('Started', resource.period && resource.period.start);
      addDate('Ended', resource.period && resource.period.end);
      break;
    case 'MedicationRequest':
      addDate('Authored', resource.authoredOn);
      add('Intent', resource.intent && humanizeCode(resource.intent));
      break;
    case 'Immunization':
      addDate('Date', resource.occurrenceDateTime);
      break;
    case 'Procedure':
      addDate('Date', resource.performedDateTime || (resource.performedPeriod && resource.performedPeriod.start));
      break;
    case 'DiagnosticReport':
      addDate('Date', resource.effectiveDateTime || resource.issued);
      add('Conclusion', resource.conclusion);
      break;
    case 'DocumentReference':
      addDate('Date', resource.date || (resource.context && resource.context.period && resource.context.period.start));
      add('Type', resource.type);
      break;
    case 'AllergyIntolerance':
      addDate('Recorded', resource.recordedDate);
      add('Reaction', resource.reaction && resource.reaction.map((reaction) => reaction && reaction.manifestation));
      break;
    case 'Goal':
      addDate('Start', resource.startDate);
      add('Achievement', resource.achievementStatus);
      break;
    case 'CareTeam': {
      add('Category', resource.category);
      const period = resource.period && typeof resource.period === 'object'
        ? [readableDate(resource.period.start), readableDate(resource.period.end)].filter(Boolean).join(' – ')
        : '';
      add('Active period', period);
      const participants = Array.isArray(resource.participant)
        ? resource.participant.map((participant) => {
            if (!participant || typeof participant !== 'object') return '';
            const member = readableText(participant.member);
            const roles = readableText(participant.role);
            if (member && roles) return member + ' — ' + roles;
            return member || roles;
          }).filter(Boolean).join(' · ')
        : '';
      add('Members', participants);
      add('Managed by', resource.managingOrganization);
      const contacts = Array.isArray(resource.telecom)
        ? resource.telecom.map((contact) => {
            if (!contact || typeof contact !== 'object') return '';
            const value = readableText(contact.value);
            const system = readableText(contact.system);
            return value && system ? humanizeCode(system) + ': ' + value : value;
          }).filter(Boolean).join(' · ')
        : '';
      add('Contact', contacts);
      break;
    }
    case 'Provenance':
      addDate('Recorded', resource.recorded);
      add('Activity', resource.activity);
      break;
  }
  return details.slice(0, 5);
}

function timelineCalendarTime(year, month, day) {
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return date.getTime();
}

function timelineSortKey(milliseconds, phase = 1, fraction = '') {
  return {
    second: Math.floor(milliseconds / 1000),
    phase,
    fraction,
  };
}

function compareTimelineSortKeys(left, right) {
  if (left.second !== right.second) return left.second - right.second;
  if (left.phase !== right.phase) return left.phase - right.phase;
  const length = Math.max(left.fraction.length, right.fraction.length);
  for (let index = 0; index < length; index += 1) {
    const leftDigit = index < left.fraction.length ? left.fraction.charCodeAt(index) : 48;
    const rightDigit = index < right.fraction.length ? right.fraction.charCodeAt(index) : 48;
    if (leftDigit !== rightDigit) return leftDigit - rightDigit;
  }
  return 0;
}

function shiftedTimelineSortKey(value, seconds) {
  if (!Number.isFinite(value.second)) return value;
  return { ...value, second: value.second + seconds };
}

function timelineDefinitelyBefore(left, right) {
  let leftEnd = left.sortEnd;
  let rightStart = right.sortStart;
  if (left.sortEndFloating !== right.sortStartFloating) {
    if (left.sortEndFloating) leftEnd = shiftedTimelineSortKey(leftEnd, 14 * 60 * 60);
    if (right.sortStartFloating) rightStart = shiftedTimelineSortKey(rightStart, -14 * 60 * 60);
  }
  const comparison = compareTimelineSortKeys(leftEnd, rightStart);
  return comparison < 0 || (comparison === 0 && left.sortEndExclusive);
}

function sortableTimelineDate(value, valueKind = 'dateTime') {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim();
  const partial = /^(\\d{4})(?:-(\\d{2})(?:-(\\d{2}))?)?$/.exec(normalized);
  if (partial && valueKind !== 'instant') {
    const year = Number(partial[1]);
    const month = partial[2] ? Number(partial[2]) : 1;
    const day = partial[3] ? Number(partial[3]) : 1;
    const sortStart = timelineCalendarTime(year, month, day);
    if (sortStart === null) return null;
    let nextPrecisionStart;
    if (!partial[2]) {
      nextPrecisionStart = timelineCalendarTime(year + 1, 1, 1);
    } else if (!partial[3]) {
      nextPrecisionStart = timelineCalendarTime(
        month === 12 ? year + 1 : year,
        month === 12 ? 1 : month + 1,
        1,
      );
    } else {
      nextPrecisionStart = sortStart + 24 * 60 * 60 * 1000;
    }
    return nextPrecisionStart === null
      ? null
      : {
          raw: normalized,
          sortStart: timelineSortKey(sortStart),
          sortEnd: timelineSortKey(nextPrecisionStart),
          sortEndExclusive: true,
          floating: true,
          display: readableDate(normalized),
          identity: 'calendar:' + normalized,
        };
  }
  if (valueKind === 'date') return null;

  const dateTime = /^(\\d{4})-(\\d{2})-(\\d{2})T(?:[01]\\d|2[0-3]):[0-5]\\d:([0-5]\\d|60)(?:\\.(\\d+))?(?:Z|[+-](?:(?:0\\d|1[0-3]):[0-5]\\d|14:00))$/.exec(normalized);
  if (!dateTime) return null;
  if (
    timelineCalendarTime(
      Number(dateTime[1]),
      Number(dateTime[2]),
      Number(dateTime[3]),
    ) === null
  ) return null;
  const leapSecond = dateTime[4] === '60';
  const withoutFraction = normalized.replace(/\\.\\d+(?=Z|[+-])/, '');
  const parseable = leapSecond
    ? withoutFraction.replace(/:60(?=Z|[+-])/, ':59')
    : withoutFraction;
  const parsedTime = Date.parse(parseable);
  if (Number.isNaN(parsedTime)) return null;
  const sortTime = parsedTime + (leapSecond ? 1000 : 0);
  const sortKey = timelineSortKey(sortTime, leapSecond ? 0 : 1, dateTime[5] || '');
  return {
    raw: normalized,
    sortStart: sortKey,
    sortEnd: sortKey,
    sortEndExclusive: false,
    floating: false,
    display: readableDate(normalized),
    identity: 'instant:' + sortKey.second + ':' + sortKey.phase + ':' +
      sortKey.fraction.replace(/0+$/, ''),
  };
}

function timelineInstant(value, dateKind, valueKind = 'dateTime') {
  const parsed = sortableTimelineDate(value, valueKind);
  if (!parsed) return null;
  return {
    sortStart: parsed.sortStart,
    sortEnd: parsed.sortEnd,
    sortEndExclusive: parsed.sortEndExclusive,
    sortStartFloating: parsed.floating,
    sortEndFloating: parsed.floating,
    dateTime: parsed.raw,
    dateLabel: parsed.display,
    dateKind,
    momentKey: 'point|' + parsed.identity,
  };
}

function timelinePeriod(value, dateKind) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const start = sortableTimelineDate(value.start, 'dateTime');
  const end = sortableTimelineDate(value.end, 'dateTime');
  if (!start && !end) return null;
  if (start && end) {
    let earliestStart = start.sortStart;
    let latestEnd = end.sortEnd;
    if (start.floating !== end.floating) {
      if (start.floating) earliestStart = shiftedTimelineSortKey(earliestStart, -14 * 60 * 60);
      if (end.floating) latestEnd = shiftedTimelineSortKey(latestEnd, 14 * 60 * 60);
    }
    const comparison = compareTimelineSortKeys(earliestStart, latestEnd);
    if (comparison > 0 || (comparison === 0 && end.sortEndExclusive)) return null;
  }
  const anchor = start || end;
  const dateLabel = start && end
    ? start.display + ' – ' + end.display
    : start
      ? start.display + ' – no end recorded'
      : 'Through ' + end.display;
  return {
    sortStart: start ? start.sortStart : timelineSortKey(Number.NEGATIVE_INFINITY),
    sortEnd: end ? end.sortEnd : timelineSortKey(Number.POSITIVE_INFINITY),
    sortEndExclusive: end ? end.sortEndExclusive : false,
    sortStartFloating: start ? start.floating : false,
    sortEndFloating: end ? end.floating : false,
    dateTime: anchor.raw,
    dateLabel,
    dateKind,
    momentKey: 'period|' + (start ? start.identity : 'open') + '|' +
      (end ? end.identity : 'open'),
  };
}

function compactTimelineMoments(candidates) {
  return candidates.flat().filter((candidate) => candidate !== null);
}

function coalesceTimelineMoments(moments) {
  const coalesced = [];
  const byPosition = new Map();
  for (const moment of moments) {
    const existing = byPosition.get(moment.momentKey);
    if (!existing) {
      const firstAtPosition = { ...moment };
      byPosition.set(moment.momentKey, {
        moment: firstAtPosition,
        dateKinds: new Set([moment.dateKind]),
      });
      coalesced.push(firstAtPosition);
      continue;
    }
    if (!existing.dateKinds.has(moment.dateKind)) {
      existing.dateKinds.add(moment.dateKind);
      existing.moment.dateKind = Array.from(existing.dateKinds).join(' · ');
    }
  }
  return coalesced;
}

function firstTimelineChoice(candidateGroups) {
  for (const candidates of candidateGroups) {
    const present = candidates.filter((candidate) => candidate !== null);
    if (present.length > 0) return present;
  }
  return [];
}

function timingTimelineMoments(value, dateKind) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const occurrences = Array.isArray(value.event)
    ? value.event
        .map((event) => timelineInstant(event, dateKind, 'dateTime'))
        .filter((event) => event !== null)
    : [];
  if (occurrences.length > 0) return occurrences;
  const bounds = timelinePeriod(value.repeat && value.repeat.boundsPeriod, dateKind + ' bounds');
  return bounds ? [bounds] : [];
}

function observationTimelineMoments(resource) {
  const effective = firstTimelineChoice([
    [timelineInstant(resource.effectiveDateTime, 'Clinically relevant time', 'dateTime')],
    [timelinePeriod(resource.effectivePeriod, 'Clinically relevant period')],
    timingTimelineMoments(resource.effectiveTiming, 'Clinically relevant occurrence'),
    [timelineInstant(resource.effectiveInstant, 'Clinically relevant time', 'instant')],
  ]);
  return compactTimelineMoments([
    effective,
    timelineInstant(resource.issued, 'Issued', 'instant'),
  ]);
}

function conditionBoundaryTimelineMoment(dateTime, period, dateKind) {
  const instant = timelineInstant(dateTime, dateKind, 'dateTime');
  if (instant) return instant;
  const range = timelinePeriod(period, dateKind + ' period');
  if (!range) return null;
  return {
    ...range,
    dateLabel: readableConditionBoundaryPeriod(period) || range.dateLabel,
  };
}

function conditionTimelineMoment(resource) {
  const onset = conditionBoundaryTimelineMoment(
    resource.onsetDateTime,
    resource.onsetPeriod,
    'Onset',
  );
  const abatement = conditionBoundaryTimelineMoment(
    resource.abatementDateTime,
    resource.abatementPeriod,
    'Ended',
  );
  const recorded = timelineInstant(resource.recordedDate, 'Recorded', 'dateTime');
  const withMatchingRecorded = (moment) => {
    if (!moment || !recorded || moment.momentKey !== recorded.momentKey) return moment;
    return { ...moment, dateKind: moment.dateKind + ' · Recorded' };
  };
  if (!onset && !abatement) return recorded;
  if (!onset) {
    return withMatchingRecorded({ ...abatement, dateKind: conditionEndLabel(resource) });
  }
  if (!abatement || timelineDefinitelyBefore(abatement, onset)) {
    return withMatchingRecorded(onset);
  }
  const endLabel = conditionEndLabel(resource);
  if (onset.momentKey === abatement.momentKey) {
    const combinedMoment = withMatchingRecorded({
      ...onset,
      dateKind: 'Onset · ' + endLabel,
    });
    return {
      ...combinedMoment,
      momentKey: 'condition-course|' + onset.momentKey + '|' + abatement.momentKey,
    };
  }
  return {
    sortStart: onset.sortStart,
    sortEnd: onset.sortEnd,
    sortEndExclusive: onset.sortEndExclusive,
    sortStartFloating: onset.sortStartFloating,
    sortEndFloating: onset.sortEndFloating,
    dateTime: onset.dateTime,
    dateLabel: onset.dateLabel + ' – ' + abatement.dateLabel,
    dateKind: 'Condition course',
    momentKey: 'condition-course|' + onset.momentKey + '|' + abatement.momentKey,
    dateRange: {
      start: {
        dateTime: onset.dateTime,
        dateLabel: onset.dateLabel,
        dateKind: onset.dateKind,
        exact: onset.momentKey.startsWith('point|'),
      },
      end: {
        dateTime: abatement.dateTime,
        dateLabel: abatement.dateLabel,
        dateKind: endLabel,
        exact: abatement.momentKey.startsWith('point|'),
      },
    },
  };
}

function timelineMomentsForResource(resource) {
  switch (resource.resourceType) {
    case 'AllergyIntolerance':
      return compactTimelineMoments([
        firstTimelineChoice([
          [timelineInstant(resource.onsetDateTime, 'Onset', 'dateTime')],
          [timelinePeriod(resource.onsetPeriod, 'Onset period')],
        ]),
        timelineInstant(resource.recordedDate, 'Recorded', 'dateTime'),
        timelineInstant(resource.lastOccurrence, 'Last occurrence', 'dateTime'),
        Array.isArray(resource.reaction)
          ? resource.reaction.map((reaction) => timelineInstant(
              reaction && reaction.onset,
              'Reaction onset',
              'dateTime',
            ))
          : [],
      ]);
    case 'CarePlan':
      return compactTimelineMoments([
        timelinePeriod(resource.period, 'Care plan period'),
        timelineInstant(resource.created, 'Created', 'dateTime'),
        Array.isArray(resource.activity)
          ? resource.activity.flatMap((activity) => {
              const detail = activity && activity.detail;
              if (!detail || typeof detail !== 'object') return [];
              return firstTimelineChoice([
                [timelinePeriod(detail.scheduledPeriod, 'Scheduled activity')],
                timingTimelineMoments(detail.scheduledTiming, 'Scheduled activity'),
              ]);
            })
          : [],
      ]);
    case 'CareTeam':
      return compactTimelineMoments([
        timelinePeriod(resource.period, 'Active period'),
        Array.isArray(resource.participant)
          ? resource.participant.map((participant) => timelinePeriod(
              participant && participant.period,
              'Member participation period',
            ))
          : [],
      ]);
    case 'Condition':
      return compactTimelineMoments([conditionTimelineMoment(resource)]);
    case 'DiagnosticReport':
      return compactTimelineMoments([
        firstTimelineChoice([
          [timelineInstant(resource.effectiveDateTime, 'Clinically relevant time', 'dateTime')],
          [timelinePeriod(resource.effectivePeriod, 'Clinically relevant period')],
        ]),
        timelineInstant(resource.issued, 'Issued', 'instant'),
      ]);
    case 'DocumentReference':
      return compactTimelineMoments([
        timelinePeriod(resource.context && resource.context.period, 'Document context period'),
        timelineInstant(resource.date, 'Indexed', 'instant'),
      ]);
    case 'Encounter':
      return compactTimelineMoments([
        timelinePeriod(resource.period, 'Encounter period'),
        Array.isArray(resource.statusHistory)
          ? resource.statusHistory.map((history) => timelinePeriod(
              history && history.period,
              'Status period',
            ))
          : [],
        Array.isArray(resource.classHistory)
          ? resource.classHistory.map((history) => timelinePeriod(
              history && history.period,
              'Class period',
            ))
          : [],
        Array.isArray(resource.participant)
          ? resource.participant.map((participant) => timelinePeriod(
              participant && participant.period,
              'Participant period',
            ))
          : [],
        Array.isArray(resource.location)
          ? resource.location.map((location) => timelinePeriod(
              location && location.period,
              'Location period',
            ))
          : [],
      ]);
    case 'Goal':
      return compactTimelineMoments([
        timelineInstant(resource.startDate, 'Started', 'date'),
        Array.isArray(resource.target)
          ? resource.target.map((target) => timelineInstant(
              target && target.dueDate,
              'Target due',
              'date',
            ))
          : [],
        timelineInstant(resource.statusDate, 'Status updated', 'date'),
      ]);
    case 'Immunization':
      return compactTimelineMoments([
        timelineInstant(resource.occurrenceDateTime, 'Administered', 'dateTime'),
        timelineInstant(resource.recorded, 'Recorded', 'dateTime'),
        Array.isArray(resource.reaction)
          ? resource.reaction.map((reaction) => timelineInstant(
              reaction && reaction.date,
              'Reaction',
              'dateTime',
            ))
          : [],
      ]);
    case 'MedicationRequest':
      return compactTimelineMoments([
        timelineInstant(resource.authoredOn, 'Authored', 'dateTime'),
        timelinePeriod(
          resource.dispenseRequest && resource.dispenseRequest.validityPeriod,
          'Dispense validity period',
        ),
        Array.isArray(resource.dosageInstruction)
          ? resource.dosageInstruction.flatMap((dosage) => timingTimelineMoments(
              dosage && dosage.timing,
              'Dosage occurrence',
            ))
          : [],
      ]);
    case 'Observation':
      return observationTimelineMoments(resource);
    case 'Procedure':
      return firstTimelineChoice([
        [timelineInstant(resource.performedDateTime, 'Performed', 'dateTime')],
        [timelinePeriod(resource.performedPeriod, 'Performed period')],
      ]);
    case 'Provenance':
      return compactTimelineMoments([
        firstTimelineChoice([
          [timelineInstant(resource.occurredDateTime, 'Occurred', 'dateTime')],
          [timelinePeriod(resource.occurredPeriod, 'Occurred period')],
        ]),
        timelineInstant(resource.recorded, 'Recorded', 'instant'),
        Array.isArray(resource.signature)
          ? resource.signature.map((signature) => timelineInstant(
              signature && signature.when,
              'Signed',
              'instant',
            ))
          : [],
      ]);
  }
  // Product, provider, and organization lifecycle dates are not patient health events.
  return [];
}

function temporalEventsForResource(resource, sourceIndex) {
  const title = resourceTitle(resource);
  const resourceKind = friendlyResourceName(resource.resourceType);
  return coalesceTimelineMoments(timelineMomentsForResource(resource)).map((moment, occurrenceIndex) => ({
    ...moment,
    resource,
    title,
    resourceKind,
    sourceIndex,
    occurrenceIndex,
    undated: false,
  }));
}

function undatedTemporalEventForResource(resource, sourceIndex) {
  return {
    resource,
    title: resourceTitle(resource),
    resourceKind: friendlyResourceName(resource.resourceType),
    sourceIndex,
    occurrenceIndex: 0,
    undated: true,
  };
}

function temporalSourceOrder(left, right) {
  return left.sourceIndex - right.sourceIndex ||
    left.occurrenceIndex - right.occurrenceIndex;
}

function orderTemporalEvents(events, newestFirst) {
  const nodes = events.map((event, index) => ({
    event,
    index,
    incoming: 0,
    removed: false,
  }));
  const comesBefore = newestFirst
    ? (left, right) => timelineDefinitelyBefore(right, left)
    : (left, right) => timelineDefinitelyBefore(left, right);
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const left = nodes[leftIndex];
      const right = nodes[rightIndex];
      if (comesBefore(left.event, right.event)) {
        right.incoming += 1;
      } else if (comesBefore(right.event, left.event)) {
        left.incoming += 1;
      }
    }
  }
  const ordered = [];
  // Stable Kahn sorting preserves every definite interval relationship and uses
  // source order only for uncertain pairs, in O(n²) time and O(n) space.
  while (ordered.length < nodes.length) {
    let next = null;
    for (const candidate of nodes) {
      if (candidate.removed || candidate.incoming !== 0) continue;
      if (
        !next ||
        temporalSourceOrder(candidate.event, next.event) < 0 ||
        (temporalSourceOrder(candidate.event, next.event) === 0 && candidate.index < next.index)
      ) next = candidate;
    }
    if (!next) {
      return [
        ...ordered,
        ...nodes.filter((node) => !node.removed)
          .sort((left, right) => temporalSourceOrder(left.event, right.event) || left.index - right.index)
          .map((node) => node.event),
      ];
    }
    next.removed = true;
    ordered.push(next.event);
    for (const candidate of nodes) {
      if (!candidate.removed && comesBefore(next.event, candidate.event)) {
        candidate.incoming -= 1;
      }
    }
  }
  return ordered;
}

function renderTemporalEventList() {
  activeTimelineButtons = [];
  temporalGraphList.replaceChildren();
  const datedEvents = temporalEvents.filter((event) => !event.undated);
  const undatedEvents = temporalEvents.filter((event) => event.undated)
    .sort(temporalSourceOrder);
  temporalGraphOrder.textContent = temporalNewestFirst ? 'Show oldest first' : 'Show newest first';
  temporalGraphOrder.hidden = datedEvents.length < 2;
  temporalGraphOrder.disabled = datedEvents.length < 2 || explorer.getAttribute('aria-busy') === 'true';
  const orderDescription = temporalNewestFirst ? 'newest to oldest' : 'oldest to newest';
  temporalGraphList.setAttribute(
    'aria-label',
    datedEvents.length === 0
      ? 'Health records in source order with blank timeline positions'
      : 'Health events, ' + orderDescription +
        ' where chronology is known; uncertain overlaps use source order' +
        (undatedEvents.length > 0
          ? '. Undated records follow in source order with blank timeline positions'
          : ''),
  );

  if (temporalEvents.length === 0) {
    temporalGraphList.hidden = true;
    temporalGraphSummary.textContent = 'No health records are available for the temporal view.';
    return;
  }

  const ordered = [
    ...orderTemporalEvents(datedEvents, temporalNewestFirst),
    ...undatedEvents,
  ];
  for (const event of ordered) {
    const item = document.createElement('li');
    item.className = event.undated
      ? 'timeline-event timeline-event-undated'
      : 'timeline-event';
    let dateSlot;
    if (event.undated) {
      dateSlot = document.createElement('span');
      dateSlot.className = 'timeline-time-empty';
      dateSlot.setAttribute('aria-hidden', 'true');
    } else if (event.dateRange) {
      dateSlot = document.createElement('span');
      dateSlot.className = 'timeline-time-range';
      const rangeStart = document.createElement(event.dateRange.start.exact ? 'time' : 'span');
      rangeStart.className = 'timeline-time-boundary';
      if (event.dateRange.start.exact) {
        rangeStart.setAttribute('datetime', event.dateRange.start.dateTime);
      }
      rangeStart.setAttribute(
        'aria-label',
        event.dateRange.start.dateKind + ' ' + event.dateRange.start.dateLabel,
      );
      rangeStart.textContent = event.dateRange.start.dateLabel;
      const rangeSeparator = document.createElement('span');
      rangeSeparator.textContent = ' to ';
      const rangeEnd = document.createElement(event.dateRange.end.exact ? 'time' : 'span');
      rangeEnd.className = 'timeline-time-boundary';
      if (event.dateRange.end.exact) {
        rangeEnd.setAttribute('datetime', event.dateRange.end.dateTime);
      }
      rangeEnd.setAttribute(
        'aria-label',
        event.dateRange.end.dateKind + ' ' + event.dateRange.end.dateLabel,
      );
      rangeEnd.textContent = event.dateRange.end.dateLabel;
      dateSlot.append(rangeStart, rangeSeparator, rangeEnd);
    } else {
      dateSlot = document.createElement('time');
      dateSlot.setAttribute('datetime', event.dateTime);
      dateSlot.textContent = event.dateLabel;
    }
    const card = renderResourceCard(event.resource, true, {
      timeline: true,
      dateKind: event.undated ? '' : event.dateKind,
    });
    item.append(dateSlot, card);
    temporalGraphList.append(item);
  }
  temporalGraphList.hidden = false;
  if (datedEvents.length === 0) {
    temporalGraphSummary.textContent = 'All ' + temporalRecordCount + ' record' +
      (temporalRecordCount === 1 ? '' : 's') +
      ' on this result page are shown in source order with blank timeline positions because no supported sortable clinical dates were supplied.';
    return;
  }
  const undatedDescription = temporalUndatedCount === 0
    ? ''
    : ' ' + temporalUndatedCount + ' undated record' +
      (temporalUndatedCount === 1 ? '' : 's') +
      (temporalUndatedCount === 1 ? ' follows' : ' follow') +
      ' in source order with ' + (temporalUndatedCount === 1 ? 'a blank timeline position.' : 'blank timeline positions.');
  temporalGraphSummary.textContent = datedEvents.length + ' dated event' +
    (datedEvents.length === 1 ? '' : 's') + ' from ' + temporalDatedRecordCount + ' of ' +
    temporalRecordCount + ' record' + (temporalRecordCount === 1 ? '' : 's') +
    ' on this result page, ordered ' + orderDescription +
    '. Dates retain source precision; overlapping date ranges retain source order where chronology is uncertain.' +
    undatedDescription;
}

function renderTemporalGraph(resources, isSearchBundle) {
  clearTemporalGraph();
  if (!isSearchBundle || resources.length === 0) return;
  temporalRecordCount = resources.length;
  for (const [sourceIndex, resource] of resources.entries()) {
    const events = temporalEventsForResource(resource, sourceIndex);
    if (events.length === 0) {
      temporalUndatedCount += 1;
      temporalEvents.push(undatedTemporalEventForResource(resource, sourceIndex));
    } else {
      temporalDatedRecordCount += 1;
      temporalEvents.push(...events);
    }
  }
  temporalGraph.hidden = false;
  renderTemporalEventList();
}

temporalGraphOrder.addEventListener('click', () => {
  const datedEventCount = temporalEvents.filter((event) => !event.undated).length;
  if (temporalGraphOrder.disabled || datedEventCount < 2) return;
  temporalNewestFirst = !temporalNewestFirst;
  renderTemporalEventList();
});

function renderResourceCard(resource, allowDetailAction, options = {}) {
  const isTimelineCard = options.timeline === true;
  const card = document.createElement('article');
  card.className = isTimelineCard ? 'timeline-event-card' : 'result-card';
  if (!isTimelineCard) card.setAttribute('role', 'listitem');
  const kind = document.createElement('p');
  kind.className = 'resource-kind';
  kind.textContent = friendlyResourceName(resource.resourceType);
  const heading = document.createElement(isTimelineCard ? 'h4' : 'h3');
  const title = resourceTitle(resource);
  heading.textContent = title;
  card.append(kind, heading);
  const showSemanticsWarning = resourceHasUninterpretedSemantics(resource) && (
    resource.resourceType === 'Location' ||
    (resource.resourceType === 'Patient' && !isTimelineCard)
  );
  if (showSemanticsWarning) {
    const semanticsWarning = document.createElement('p');
    semanticsWarning.className = 'result-warning resource-semantics-warning' +
      (resource.resourceType === 'Patient' ? ' patient-profile-warning' : '');
    semanticsWarning.setAttribute('role', 'note');
    semanticsWarning.textContent = 'This ' + friendlyResourceName(resource.resourceType) +
      ' resource has semantics this app has not interpreted, such as modifier extensions or implicit rules, ' +
      'or was too complex to fully assess. All source fields are displayed, but consult the applicable ' +
      'definitions and the complete application FHIR JSON before relying on their meaning.';
    card.append(semanticsWarning);
  }
  if (resource.resourceType === 'Patient' && !isTimelineCard) {
    const profileNote = document.createElement('p');
    profileNote.className = 'patient-profile-note';
    profileNote.textContent = 'Every field returned by Epic is shown below. Fields that the healthcare organization did not supply are not listed. This Patient resource contains demographic and administrative profile data, not the complete medical record.';
    card.append(profileNote);
  }
  if (isTimelineCard && typeof options.dateKind === 'string' && options.dateKind) {
    const dateKind = document.createElement('p');
    dateKind.className = 'timeline-date-kind';
    dateKind.textContent = options.dateKind;
    card.append(dateKind);
  }

  const details = resourceDetails(resource, options);
  if (details.length > 0) {
    const list = document.createElement('dl');
    for (const detail of details) {
      const term = document.createElement('dt');
      term.textContent = detail.label;
      const description = document.createElement('dd');
      if (detail.patientField === true) description.className = 'patient-field-value';
      if (detail.locationField === true) description.className = 'location-field-value';
      description.textContent = detail.value;
      list.append(term, description);
    }
    card.append(list);
  }

  const capability = effectiveCapabilities.get(resource.resourceType);
  if (
    allowDetailAction &&
    capability && canReadResource(resource, capability) &&
    typeof resource.id === 'string' && /^[A-Za-z0-9.-]{1,64}$/.test(resource.id) &&
    resource.resourceType !== 'Binary'
  ) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = 'View details';
    button.setAttribute('aria-label', 'View details for ' + title.slice(0, 160));
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      await runDataRequest(
        '/api/fhir/' + encodeURIComponent(resource.resourceType) + '/' + encodeURIComponent(resource.id),
        title,
        undefined,
        { preservePrevious: true },
      );
    });
    if (isTimelineCard) {
      activeTimelineButtons.push(button);
    } else {
      activeResultButtons.push(button);
    }
    card.append(button);
  }
  return card;
}

function renderFriendlyResult(value) {
  resultList.replaceChildren();
  resultList.setAttribute('role', 'list');
  activeResultButtons = [];
  const isSearchBundle = value && typeof value === 'object' && value.resourceType === 'Bundle';
  const bundleEntries = isSearchBundle && Array.isArray(value.entry)
    ? value.entry.map((entry) => {
        const resource = entry && typeof entry === 'object' ? entry.resource : null;
        return resource && typeof resource === 'object' ? { entry, resource } : null;
      }).filter(Boolean)
    : [];
  const outcomeCount = bundleEntries.filter(({ resource }) =>
    resource.resourceType === 'OperationOutcome').length;
  const provenanceCount = bundleEntries.filter(({ entry, resource }) =>
    resource.resourceType === 'Provenance' &&
    entry.search && typeof entry.search === 'object' && entry.search.mode === 'include').length;
  const resources = isSearchBundle
    ? bundleEntries.filter(({ entry, resource }) =>
        resource.resourceType !== 'OperationOutcome' &&
        !(
          resource.resourceType === 'Provenance' &&
          entry.search && typeof entry.search === 'object' && entry.search.mode === 'include'
        )).map(({ resource }) => resource)
    : value && typeof value === 'object' && typeof value.resourceType === 'string'
      ? [value]
      : [];
  renderTemporalGraph(resources, isSearchBundle);
  if (resources.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-result';
    empty.setAttribute('role', 'listitem');
    empty.textContent = isSearchBundle ? 'No records were found for this selection.' : 'No readable record summary is available.';
    resultList.append(empty);
  } else if (!isSearchBundle) {
    for (const resource of resources) {
      resultList.append(renderResourceCard(resource, isSearchBundle));
    }
  }
  if (outcomeCount > 0) {
    const warning = document.createElement('p');
    warning.className = 'result-warning';
    warning.setAttribute('role', 'listitem');
    warning.textContent = 'The response also includes ' + outcomeCount + ' processing notice' +
      (outcomeCount === 1 ? '' : 's') + '. Review Advanced only if you need the technical details.';
    resultList.append(warning);
  }
  if (provenanceCount > 0) {
    const provenanceNotice = document.createElement('p');
    provenanceNotice.className = 'result-warning';
    provenanceNotice.setAttribute('role', 'listitem');
    provenanceNotice.textContent = 'Epic included ' + provenanceCount + ' record source' +
      (provenanceCount === 1 ? '' : 's') + '. Open Advanced to review the full Provenance details.';
    resultList.append(provenanceNotice);
  }
  resultList.hidden = resultList.children.length === 0;
  return {
    recordCount: isSearchBundle ? resources.length : null,
    outcomeCount,
    provenanceCount,
  };
}

function showResult(value, label, pageNumber, previousView, trace) {
  currentDataView = { value, label, pageNumber, trace };
  copyRequestSequence += 1;
  copyResourcesStatus.textContent = '';
  result.textContent = JSON.stringify(value, null, 2);
  copyResourcesButton.disabled = false;
  const friendlySummary = renderFriendlyResult(value);
  renderResponseTrace(value, trace);
  advancedResult.hidden = false;
  advancedResult.open = false;
  resultError.textContent = '';
  resultError.hidden = true;
  const pageDescription = Number.isInteger(pageNumber)
    ? ' Page ' + pageNumber + (friendlySummary.recordCount === null
        ? ''
        : ' contains ' + friendlySummary.recordCount + ' record' + (friendlySummary.recordCount === 1 ? '' : 's')) + '.'
    : '';
  const outcomeDescription = friendlySummary.outcomeCount > 0
    ? ' The response also includes ' + friendlySummary.outcomeCount + ' processing notice' +
      (friendlySummary.outcomeCount === 1 ? '' : 's') + '.'
    : '';
  const provenanceDescription = friendlySummary.provenanceCount > 0
    ? ' Epic included ' + friendlySummary.provenanceCount + ' record source' +
      (friendlySummary.provenanceCount === 1 ? '' : 's') + '.'
    : '';
  const displayDescription = value && typeof value === 'object' && value.resourceType === 'Patient'
    ? ' Every field returned by Epic is shown below; complete application FHIR JSON remains available in Advanced.'
    : ' A readable summary is shown below; complete application FHIR JSON remains available in Advanced.';
  resultStatus.textContent = label + ' loaded.' + pageDescription + outcomeDescription + provenanceDescription +
    displayDescription;
  paginationControls.replaceChildren();
  if (previousView) {
    const backButton = document.createElement('button');
    backButton.type = 'button';
    backButton.className = 'secondary';
    backButton.textContent = 'Back to search results';
    backButton.addEventListener('click', () => {
      showResult(previousView.value, previousView.label, previousView.pageNumber, undefined, previousView.trace);
    });
    activeResultButtons.push(backButton);
    paginationControls.append(backButton);
  }
  const nextPageUrl = safeNextPageUrl(value);
  if (nextPageUrl && Number.isInteger(pageNumber)) {
    const pageLabel = document.createElement('span');
    pageLabel.className = 'page-label';
    pageLabel.textContent = 'Page ' + pageNumber;
    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className = 'secondary';
    nextButton.textContent = 'Load next page';
    nextButton.addEventListener('click', async () => {
      await runDataRequest(nextPageUrl, label, pageNumber + 1);
    });
    activeResultButtons.push(nextButton);
    paginationControls.append(pageLabel, nextButton);
  }
  paginationControls.hidden = paginationControls.children.length === 0;
  resultStatus.focus();
}

copyResourcesButton.addEventListener('click', async () => {
  const text = result.textContent;
  if (copyResourcesButton.disabled || !text) return;
  const requestSequence = ++copyRequestSequence;
  copyResourcesButton.disabled = true;
  copyResourcesStatus.textContent = 'Copying…';
  try {
    if (
      typeof navigator === 'undefined' ||
      !navigator.clipboard ||
      typeof navigator.clipboard.writeText !== 'function'
    ) {
      throw new Error('Clipboard access is unavailable.');
    }
    await navigator.clipboard.writeText(text);
    if (requestSequence !== copyRequestSequence || result.textContent !== text) return;
    copyResourcesStatus.textContent = 'Application FHIR JSON copied to your clipboard.';
  } catch {
    if (requestSequence !== copyRequestSequence || result.textContent !== text) return;
    copyResourcesStatus.textContent = 'Could not copy. Select the application JSON and copy it manually.';
  } finally {
    if (requestSequence === copyRequestSequence) {
      copyResourcesButton.disabled = result.textContent.length === 0;
    }
  }
});

function apiErrorMessage(error, fallback) {
  const message = error instanceof Error ? error.message : fallback;
  if (!error || typeof error !== 'object') return message;
  const references = [];
  if (Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
    references.push('HTTP ' + error.status);
  }
  if (typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error.code)) {
    references.push('error ' + error.code);
  }
  if (typeof error.requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(error.requestId)) {
    references.push('request ' + error.requestId);
  }
  return references.length > 0 ? message + ' Support details: ' + references.join(' · ') + '.' : message;
}

function showApiError(error) {
  clearDataDisplay('No health data is displayed.');
  resultError.textContent = apiErrorMessage(error, 'The health-data request failed.');
  resultError.hidden = false;
  resultError.focus();
}

function isFhirResourceScope(scope) {
  const smart = /^(?:patient|user)\\/(?:\\*|[A-Z][A-Za-z0-9]*)\\.([^?\\s]+)(?:\\?[^\\s]+)?$/.exec(scope);
  if (smart) {
    const permission = smart[1].toLowerCase();
    return permission === 'read' ||
      permission === 'write' ||
      permission === '*' ||
      /^(?!$)c?r?u?d?s?$/.test(permission);
  }

  const legacy = /^([A-Z][A-Za-z0-9]*)\\.([A-Za-z]+)$/.exec(scope);
  return legacy !== null && /^(?:read|search|write|create|update|delete)$/i.test(legacy[2]);
}

function showGrantedAccess(connection) {
  const scopes = Array.isArray(connection.scope)
    ? connection.scope.filter((scope) => typeof scope === 'string')
    : [];
  const resourceScopes = scopes.filter(isFhirResourceScope);
  grantedAccess.hidden = false;
  grantedScopeCount.textContent = '(' + resourceScopes.length + ' FHIR resource scope' + (resourceScopes.length === 1 ? '' : 's') + ')';
  grantedScopes.textContent = scopes.length ? scopes.join(' ') : 'Epic returned no scope value.';
  if (resourceScopes.length === 0) {
    scopeWarning.textContent = 'Epic returned no FHIR resource permissions in this grant. If you changed the app’s Incoming APIs, wait for Epic to synchronize the app record, then disconnect and reconnect.';
    scopeWarning.hidden = false;
    grantedAccess.open = true;
  } else {
    scopeWarning.hidden = true;
  }
}

function hubCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function showHubState(value) {
  if (!value || typeof value !== 'object' || typeof value.available !== 'boolean') {
    throw new Error('The private health hub returned an invalid status.');
  }
  clearHubError();
  clearHubSensitiveView();
  hubDeletePanel.hidden = true;
  hubDeleteCheckbox.checked = false;
  hubRefreshButton.hidden = false;
  if (!value.available) {
    hubStatus.textContent = 'Private health hub storage is not available in this deployment.';
    hubEnablePanel.hidden = true;
    hubControls.hidden = true;
    setHubControlsDisabled(false);
    return;
  }
  const hasStoredHub = value.enabled === true;
  const acceptingNewData = hasStoredHub && value.consentCurrent === true;
  hubEnablePanel.hidden = acceptingNewData;
  // Existing data remains exportable and deletable even when a new notice must
  // be accepted before ingestion resumes.
  hubControls.hidden = !hasStoredHub;
  if (hasStoredHub) {
    const currentResources = hubCount(value.currentResourceCount);
    const resourceVersions = hubCount(value.resourceVersionCount);
    const normalizedResources = hubCount(value.normalizedResourceCount);
    const normalizationFailures = hubCount(value.normalizationFailureCount);
    const insights = hubCount(value.insightCount);
    hubCounts.textContent = currentResources + ' current resource' + (currentResources === 1 ? '' : 's') +
      ' · ' + resourceVersions + ' stored version' + (resourceVersions === 1 ? '' : 's') +
      ' · ' + normalizedResources + ' normalized projection' + (normalizedResources === 1 ? '' : 's') +
      (normalizationFailures === 0
        ? ''
        : ' · ' + normalizationFailures + ' normalization notice' + (normalizationFailures === 1 ? '' : 's')) +
      ' · ' + insights + ' source-linked insight' + (insights === 1 ? '' : 's');
  }
  if (!acceptingNewData) {
    hubStatus.textContent = hasStoredHub
      ? 'Review the current private health hub notice to resume retaining newly requested data.'
      : 'The private health hub is off. FHIR data is not retained here unless you opt in.';
    hubConsentCheckbox.checked = false;
    setHubControlsDisabled(false);
    return;
  }
  hubStatus.textContent = 'Private health hub enabled. Newly requested FHIR data is retained under your hub consent.';
  setHubControlsDisabled(false);
}

async function refreshHubStatus(expectedConnectionKey = currentConnectionKey) {
  if (!hubConfigured || !expectedConnectionKey || expectedConnectionKey !== currentConnectionKey) return;
  const requestSequence = ++hubRequestSequence;
  if (hubRequestController) hubRequestController.abort();
  const controller = new AbortController();
  hubRequestController = controller;
  healthHub.hidden = false;
  healthHub.setAttribute('aria-busy', 'true');
  hubStatus.textContent = 'Checking private health hub…';
  clearHubError();
  setHubControlsDisabled(true);
  try {
    const value = await api('/api/hub/status', {
      signal: controller.signal,
      expectedConnectionContext: expectedConnectionKey,
    });
    if (
      requestSequence !== hubRequestSequence ||
      expectedConnectionKey !== currentConnectionKey
    ) return;
    showHubState(value);
  } catch (error) {
    if (
      requestSequence !== hubRequestSequence ||
      expectedConnectionKey !== currentConnectionKey ||
      isAbortError(error)
    ) return;
    if (isAuthenticationLoss(error)) {
      showDisconnectedState('Your MyChart connection ended. Connect again to manage the private health hub.', true);
    } else {
      hubStatus.textContent = 'Private health hub status is unavailable.';
      showHubError(error);
      setHubControlsDisabled(false);
    }
  } finally {
    if (requestSequence === hubRequestSequence) {
      hubRequestController = null;
      healthHub.removeAttribute('aria-busy');
    }
  }
}

function connectionKey(connection) {
  if (
    typeof connection.connectionContext !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(connection.connectionContext)
  ) {
    return null;
  }
  return connection.connectionContext;
}

function announceConnectionChange() {
  connectionChannel?.postMessage({ type: 'connection-state-changed' });
}

function handleExternalConnectionChange() {
  currentConnectionKey = null;
  invalidateStatusRequests();
  scrubSensitiveUi('Rechecking the MyChart connection…');
  resetHubUi();
  explorer.hidden = true;
  healthHub.hidden = true;
  statusElement.textContent = 'MyChart connection changed in another tab. Rechecking…';
  statusElement.className = 'status';
  void refreshStatus();
}

if (connectionChannel) {
  connectionChannel.addEventListener('message', (event) => {
    if (event && event.data && event.data.type === 'connection-state-changed') {
      handleExternalConnectionChange();
    }
  });
}

function showDisconnectedState(message, isError = false) {
  currentConnectionKey = null;
  scrubSensitiveUi();
  resetHubUi();
  statusElement.textContent = message;
  statusElement.className = isError ? 'status error' : 'status';
  statusElement.removeAttribute('aria-busy');
  connectForm.hidden = false;
  legalConsent.hidden = false;
  legalConsentCheckbox.checked = false;
  connectButton.disabled = true;
  disconnectButton.hidden = true;
  explorer.hidden = true;
  healthHub.hidden = true;
  setDataControlsDisabled(true);
}

function showConnectedState(connection) {
  const nextConnectionKey = connectionKey(connection);
  if (!nextConnectionKey) {
    showDisconnectedState('The connection status was incomplete. Connect again before viewing health data.', true);
    return;
  }
  if (nextConnectionKey !== currentConnectionKey) {
    scrubSensitiveUi();
    resetHubUi();
  }
  currentConnectionKey = nextConnectionKey;
  const accessMode = connection.durable
    ? ' · encrypted persistent access enabled'
    : connection.refreshable
      ? ' · refreshable until this service restarts'
      : ' · short-lived access';
  statusElement.textContent = 'Connected to ' + connection.provider + accessMode;
  statusElement.className = 'status connected';
  statusElement.removeAttribute('aria-busy');
  connectForm.hidden = true;
  legalConsent.hidden = true;
  disconnectButton.hidden = false;
  explorer.hidden = false;
  healthHub.hidden = !hubConfigured;
  showGrantedAccess(connection);
  applyEffectiveCapabilities(connection);
  setDataControlsDisabled(false);
}

async function refreshStatus() {
  const requestSequence = ++statusRequestSequence;
  if (statusRequestController) statusRequestController.abort();
  const controller = new AbortController();
  statusRequestController = controller;
  statusElement.setAttribute('aria-busy', 'true');
  try {
    const connection = await api('/api/connection', { signal: controller.signal });
    if (requestSequence !== statusRequestSequence) return;
    if (connection.connected) {
      showConnectedState(connection);
      if (hubConfigured && currentConnectionKey) {
        await refreshHubStatus(currentConnectionKey);
      }
    } else {
      showDisconnectedState('Not connected');
    }
  } catch (error) {
    if (requestSequence !== statusRequestSequence || isAbortError(error)) return;
    showDisconnectedState(error instanceof Error ? error.message : 'Unable to check the MyChart connection.', true);
  } finally {
    if (requestSequence === statusRequestSequence) {
      statusRequestController = null;
      statusElement.removeAttribute('aria-busy');
    }
  }
}

async function runDataRequest(path, label, pageNumber, options) {
  if (!currentConnectionKey || disconnecting) return;
  const requestSequence = ++dataRequestSequence;
  if (dataRequestController) dataRequestController.abort();
  const controller = new AbortController();
  dataRequestController = controller;
  const expectedConnectionKey = currentConnectionKey;
  const previousView = options && options.preservePrevious ? currentDataView : null;
  if (previousView) {
    resultStatus.textContent = 'Loading ' + label.toLowerCase() + '…';
    resultError.textContent = '';
    resultError.hidden = true;
  } else {
    clearDataDisplay('Loading ' + label.toLowerCase() + '…');
  }
  explorer.setAttribute('aria-busy', 'true');
  setDataControlsDisabled(true);
  try {
    const response = await api(path, {
      signal: controller.signal,
      expectedConnectionContext: expectedConnectionKey,
      captureFhirTrace: true,
    });
    if (
      requestSequence !== dataRequestSequence ||
      expectedConnectionKey !== currentConnectionKey
    ) return;
    showResult(response.value, label, pageNumber, previousView, response.trace);
  } catch (error) {
    if (
      requestSequence !== dataRequestSequence ||
      expectedConnectionKey !== currentConnectionKey ||
      isAbortError(error)
    ) return;
    if (isAuthenticationLoss(error)) {
      showDisconnectedState('Your MyChart connection ended. Connect again to view health data.', true);
      await refreshStatus();
    } else if (previousView) {
      resultStatus.textContent = 'The detail request failed; the previous search results remain below.';
      resultError.textContent = apiErrorMessage(error, 'The health-data request failed.');
      resultError.hidden = false;
      resultError.focus();
    } else {
      showApiError(error);
    }
  } finally {
    if (requestSequence === dataRequestSequence) {
      dataRequestController = null;
      explorer.removeAttribute('aria-busy');
      if (currentConnectionKey && !disconnecting) setDataControlsDisabled(false);
    }
  }
}

legalConsentCheckbox.addEventListener('change', () => {
  connectButton.disabled = !legalConsentCheckbox.checked;
});

connectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (connectButton.disabled || !legalConsentCheckbox.checked) return;
  announceConnectionChange();
  currentConnectionKey = null;
  invalidateStatusRequests();
  scrubSensitiveUi('Connecting to MyChart…');
  statusElement.textContent = 'Redirecting to MyChart…';
  statusElement.setAttribute('aria-busy', 'true');
  connectButton.disabled = true;
  try {
    const start = await api('/auth/start', {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        consent: legalConsentCheckbox.value,
        policyVersion: policyVersionInput.value,
      }).toString(),
    });
    if (!start || typeof start.authorizationUrl !== 'string') {
      throw new Error('The authorization server returned an invalid redirect.');
    }
    const target = new URL(start.authorizationUrl);
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      target.hash ||
      target.searchParams.get('response_type') !== 'code' ||
      !target.searchParams.get('state')
    ) {
      throw new Error('The authorization server returned an invalid redirect.');
    }
    window.location.assign(target.toString());
  } catch (error) {
    statusElement.textContent = 'MyChart authorization did not start.';
    statusElement.removeAttribute('aria-busy');
    notice.textContent = error instanceof Error
      ? error.message
      : 'The authorization request failed. Please try again.';
    notice.hidden = false;
    connectButton.disabled = !legalConsentCheckbox.checked;
  }
});

patientButton.addEventListener('click', async () => {
  if (!patientReadAllowed || patientButton.disabled) return;
  await runDataRequest('/api/patient', 'Patient profile');
});

resourceType.addEventListener('change', () => {
  updateResourceActionControls();
  setDataControlsDisabled(false);
});

searchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (searchButton.disabled) return;
  const selected = Array.from(resourceType.options || []).find(
    (option) => option.value === resourceType.value,
  );
  const label = selected && selected.textContent ? selected.textContent.trim() : 'Health records';
  if (directReadableCapabilities.has(resourceType.value)) {
    const resourceId = resourceIdInput.value;
    if (!/^[A-Za-z0-9.-]{1,64}$/.test(resourceId)) {
      showApiError(new Error('Enter a valid FHIR resource ID using 1–64 letters, numbers, periods, or hyphens.'));
      return;
    }
    await runDataRequest(
      '/api/fhir/' + encodeURIComponent(resourceType.value) + '/' + encodeURIComponent(resourceId),
      label,
    );
    return;
  }

  const capability = searchableCapabilities.get(resourceType.value);
  if (!capability) return;
  const parameters = new URLSearchParams();
  parameters.set('_count', countInput.value);
  if (resourceType.value === 'CarePlan') {
    if (!carePlanTypeSelect.value) {
      showApiError(new Error('Choose a care plan type.'));
      return;
    }
    parameters.set('category', carePlanTypeSelect.value);
  }
  for (const constraint of activeConstraintControls) {
    if (!constraint.select.value) {
      showApiError(new Error('Choose an authorized ' + friendlyConstraintName(constraint.name).toLowerCase() + '.'));
      return;
    }
    parameters.append(constraint.name, constraint.select.value);
  }
  await runDataRequest(
    '/api/fhir/' + encodeURIComponent(resourceType.value) + '?' + parameters.toString(),
    label,
    1,
  );
});

async function runHubAction(action) {
  if (!hubConfigured || !currentConnectionKey || hubBusy) return null;
  const expectedConnectionKey = currentConnectionKey;
  const requestSequence = ++hubRequestSequence;
  if (hubRequestController) hubRequestController.abort();
  const controller = new AbortController();
  hubRequestController = controller;
  healthHub.setAttribute('aria-busy', 'true');
  clearHubError();
  setHubControlsDisabled(true);
  try {
    const value = await action(controller.signal, expectedConnectionKey);
    if (
      requestSequence !== hubRequestSequence ||
      expectedConnectionKey !== currentConnectionKey
    ) return null;
    return value;
  } catch (error) {
    if (
      requestSequence !== hubRequestSequence ||
      expectedConnectionKey !== currentConnectionKey ||
      isAbortError(error)
    ) return null;
    if (isAuthenticationLoss(error)) {
      showDisconnectedState('Your MyChart connection ended. Connect again to manage the private health hub.', true);
    } else {
      showHubError(error);
    }
    return null;
  } finally {
    if (requestSequence === hubRequestSequence) {
      hubRequestController = null;
      healthHub.removeAttribute('aria-busy');
      setHubControlsDisabled(false);
    }
  }
}

hubConsentCheckbox.addEventListener('change', () => {
  hubEnableButton.disabled = hubBusy || !hubConsentCheckbox.checked;
});

hubEnableButton.addEventListener('click', async () => {
  if (!hubConsentCheckbox.checked || hubEnableButton.disabled) return;
  hubStatus.textContent = 'Enabling encrypted private health hub…';
  const value = await runHubAction((signal, expectedConnectionContext) =>
    api('/api/hub/enable', {
      method: 'POST',
      signal,
      expectedConnectionContext,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policyVersion: hubPolicyVersionInput.value }),
    })
  );
  if (value) showHubState(value);
});

hubRefreshButton.addEventListener('click', () => {
  void refreshHubStatus();
});

function withoutRawFields(value) {
  if (Array.isArray(value)) return value.map(withoutRawFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'raw')
    .map(([key, nested]) => [key, withoutRawFields(nested)]));
}

function hubProjectionForDisplay(candidate) {
  if (!candidate || typeof candidate !== 'object') return {};
  return withoutRawFields({
    versionKey: candidate.versionKey,
    current: candidate.current,
    provenance: candidate.provenance,
    firstSeenAt: candidate.firstSeenAt,
    lastSeenAt: candidate.lastSeenAt,
    expiresAt: candidate.expiresAt,
    normalization: candidate.normalization,
    projectionError: candidate.projectionError,
  });
}

function hubInsightForDisplay(candidate) {
  if (!candidate || typeof candidate !== 'object') return {};
  return withoutRawFields({
    insightId: candidate.insightId,
    insightType: candidate.insightType,
    insight: candidate.insight,
    sourceResourceVersions: candidate.sourceResourceVersions,
    generatedAt: candidate.generatedAt,
    generator: candidate.generator,
    confidence: candidate.confidence,
    status: candidate.status,
    userConfirmation: candidate.userConfirmation,
    supersedesInsightId: candidate.supersedesInsightId,
  });
}

hubIntelligenceButton.addEventListener('click', async () => {
  clearHubSensitiveView();
  hubStatus.textContent = 'Loading normalized health data and source-linked summaries…';
  const value = await runHubAction((signal, expectedConnectionContext) =>
    api('/api/hub/intelligence?limit=250', {
      signal,
      expectedConnectionContext,
    })
  );
  if (value === null) return;
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray(value.projections) ||
    !Array.isArray(value.insights) ||
    typeof value.hasMore !== 'boolean'
  ) {
    showHubError(new Error('The private health hub returned invalid intelligence data.'));
    return;
  }
  hubProjections.textContent = JSON.stringify(value.projections.map(hubProjectionForDisplay), null, 2);
  hubInsights.textContent = JSON.stringify(value.insights.map(hubInsightForDisplay), null, 2);
  hubIntelligenceView.hidden = false;
  hubStatus.textContent = 'Normalized health data loaded. Projections and summaries are shown separately and cite their source versions.' +
    (value.hasMore ? ' Additional retained intelligence is available in your full export.' : '');
  hubIntelligenceView.focus();
});

hubResourcesButton.addEventListener('click', async () => {
  clearHubSensitiveView();
  hubStatus.textContent = 'Loading stored FHIR versions…';
  const value = await runHubAction((signal, expectedConnectionContext) =>
    api('/api/hub/resources?includeHistory=true&limit=250', {
      signal,
      expectedConnectionContext,
    })
  );
  if (value === null) return;
  hubResult.textContent = JSON.stringify(value, null, 2);
  hubAdvancedResult.hidden = false;
  hubAdvancedResult.open = false;
  hubStatus.textContent = 'Stored FHIR versions loaded. Review the raw source JSON below.';
  hubAdvancedResult.focus();
});

hubExportButton.addEventListener('click', async () => {
  hubStatus.textContent = 'Preparing private health hub export…';
  const value = await runHubAction((signal, expectedConnectionContext) =>
    api('/api/hub/export', { signal, expectedConnectionContext })
  );
  if (value === null) return;
  try {
    const objectUrl = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {
      type: 'application/json',
    }));
    const download = document.createElement('a');
    download.setAttribute('href', objectUrl);
    download.setAttribute('download', 'moonba-health-hub.json');
    document.body.append(download);
    download.click();
    download.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    hubStatus.textContent = 'Private health hub export prepared. Protect the downloaded file.';
  } catch (error) {
    showHubError(error);
  }
});

hubDeleteStageButton.addEventListener('click', () => {
  clearHubSensitiveView();
  hubDeleteCheckbox.checked = false;
  hubConfirmDeleteButton.disabled = true;
  hubDeletePanel.hidden = false;
  hubDeleteCheckbox.focus();
});

hubDeleteCheckbox.addEventListener('change', () => {
  hubConfirmDeleteButton.disabled = hubBusy || !hubDeleteCheckbox.checked;
});

hubCancelDeleteButton.addEventListener('click', () => {
  hubDeleteCheckbox.checked = false;
  hubConfirmDeleteButton.disabled = true;
  hubDeletePanel.hidden = true;
});

hubConfirmDeleteButton.addEventListener('click', async () => {
  if (!hubDeleteCheckbox.checked || hubConfirmDeleteButton.disabled) return;
  hubStatus.textContent = 'Permanently deleting private health hub…';
  const value = await runHubAction((signal, expectedConnectionContext) =>
    api('/api/hub/delete', {
      method: 'POST',
      signal,
      expectedConnectionContext,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'DELETE MY HEALTH HUB' }),
    })
  );
  if (value === null) return;
  clearHubSensitiveView();
  hubDeletePanel.hidden = true;
  hubDeleteCheckbox.checked = false;
  await refreshHubStatus();
  if (currentConnectionKey) {
    hubStatus.textContent = 'Private health hub permanently deleted. Your MyChart source record was not changed.';
  }
});

async function disconnectCurrentConnection() {
  if (disconnecting) return;
  const expectedConnectionContext = currentConnectionKey;
  disconnecting = true;
  announceConnectionChange();
  invalidateStatusRequests();
  currentConnectionKey = null;
  scrubSensitiveUi('Disconnecting…');
  resetHubUi();
  explorer.hidden = true;
  healthHub.hidden = true;
  statusElement.textContent = 'Disconnecting MyChart…';
  statusElement.setAttribute('aria-busy', 'true');
  disconnectButton.disabled = true;
  let manualRevocationRecommended = false;
  let disconnectError = null;
  try {
    const outcome = await api('/api/disconnect-all', {
      method: 'POST',
      headers: expectedConnectionContext
        ? { 'X-Epic-Expected-Connection-Context': expectedConnectionContext }
        : {},
    });
    manualRevocationRecommended = outcome.manualRevocationRecommended;
  } catch (error) {
    disconnectError = error;
  } finally {
    disconnecting = false;
    announceConnectionChange();
    await refreshStatus();
    if (manualRevocationRecommended) {
      notice.textContent = 'Local connection removed. Also remove this app under MyChart’s linked apps/devices settings if it is still listed.';
      notice.hidden = false;
    } else if (disconnectError) {
      notice.textContent = disconnectError instanceof Error ? disconnectError.message : 'The disconnect request failed.';
      notice.hidden = false;
    } else if (!currentConnectionKey) {
      notice.textContent = 'Connection removed.';
      notice.hidden = false;
    }
    disconnectButton.disabled = false;
  }
}

disconnectButton.addEventListener('click', () => {
  void disconnectCurrentConnection();
});

window.addEventListener('pagehide', () => {
  currentConnectionKey = null;
  invalidateStatusRequests();
  scrubSensitiveUi();
  resetHubUi();
  explorer.hidden = true;
  healthHub.hidden = true;
});

window.addEventListener('pageshow', (event) => {
  if (event.persisted) void refreshStatus();
});

function hideConnectedUiForRevalidation() {
  if (!currentConnectionKey) return;
  explorer.hidden = true;
  healthHub.hidden = true;
  advancedResult.open = false;
  hubAdvancedResult.open = false;
  setDataControlsDisabled(true);
}

function revalidateVisibleConnection() {
  if (document.visibilityState !== 'visible') return;
  hideConnectedUiForRevalidation();
  if (lifecycleStatusPromise) return;
  // Keep the current in-memory choices and results until the connection check
  // proves that the session ended or changed to a different account.
  lifecycleStatusPromise = refreshStatus().finally(() => {
    lifecycleStatusPromise = null;
  });
}

window.addEventListener('focus', revalidateVisibleConnection);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hideConnectedUiForRevalidation();
    return;
  }
  revalidateVisibleConnection();
});

void refreshStatus();
`;
