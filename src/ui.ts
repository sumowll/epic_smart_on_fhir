import type { AppConfig } from "./types.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function renderHome(config: AppConfig): string {
  const resourceOptions = [...config.allowedResourceTypes]
    .sort()
    .map((resourceType) => `<option value="${escapeHtml(resourceType)}">${escapeHtml(resourceType)}</option>`)
    .join("");

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
        <div id="legal-consent" class="consent-control" hidden>
          <label for="legal-consent-checkbox">
            <input id="legal-consent-checkbox" type="checkbox">
            <span>I have reviewed the Terms and Privacy Notice, understand that connection identifiers and tokens may be retained for up to 30 days, and want this application to access the MyChart data I authorize.</span>
          </label>
        </div>
        <form id="connect-form" method="post" action="/auth/start" hidden>
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
          <button id="patient" class="secondary" type="button">Load patient</button>
        </div>
        <details id="granted-access" class="granted-access" hidden>
          <summary>Access granted by Epic <span id="granted-scope-count"></span></summary>
          <p id="scope-warning" class="scope-warning" hidden></p>
          <code id="granted-scopes"></code>
        </details>
        <form id="search-form" class="search-row">
          <label for="resource-type">Resource</label>
          <select id="resource-type">${resourceOptions}</select>
          <label for="count">Count</label>
          <input id="count" type="number" min="1" max="100" value="20">
          <button type="submit">Search</button>
        </form>
        <p class="hint">Results depend on the read/search APIs selected on your Epic app record and authorized by the patient.</p>
        <pre id="result" tabindex="0">Choose a request above.</pre>
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
  return legalPage(
    config,
    "Terms and Conditions",
    "Please review before connecting",
    `<p class="lede">These Terms and Conditions (“Terms”) govern your use of the MyChart connection service operated by ${operator} (“we,” “us,” or “our”). By selecting “Connect MyChart” or otherwise using the service, you agree to these Terms and acknowledge the <a href="/privacy">Privacy Notice</a>.</p>

        <h2>1. What the service does</h2>
        <p>The service lets you authorize read-only access to selected health information available through an Epic/MyChart-compatible FHIR API. It redirects you to your healthcare organization for sign-in and consent, then displays information that the organization makes available under the permissions you approve.</p>
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
        <p>Depending on the permissions you approve and how the service is configured, access may be short-lived or may use a refresh token for persistent access. The connector’s local session becomes unusable after 30 days unless you disconnect sooner; scheduled cleanup of a saved connection record may follow shortly afterward. You can disconnect in the application and can also remove the application in MyChart’s linked apps or devices settings. Remote revocation may require that additional MyChart step.</p>

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
        <h3>Information the service does not request</h3>
        <p>Your MyChart username and password go directly to your healthcare organization and do not pass through this application. The application does not request your device address book, device geolocation, advertising identifiers, or payment-card information, and its code does not include advertising or behavioral-analytics trackers. Provider-supplied health records—especially the Patient resource—may themselves include postal address, telephone, email, or other contact details.</p>
        <h3>Technical information</h3>
        <p>The configured infrastructure provider, ${hostingProvider}, and network providers may process information such as IP address, request timing, security events, and basic device or browser metadata to deliver and protect the service. Application responses direct browsers not to cache health information, and application-level request logging is disabled. Infrastructure processing may still be subject to the provider’s configuration and contract.</p>

        <h2>2. How information is used</h2>
        <p>Information is used only to initiate and validate authorization, maintain your connection, request the health information you select, return it to your browser, refresh or revoke authorization when supported, protect the service, troubleshoot failures, and comply with applicable law.</p>

        <h2>3. When information is disclosed</h2>
        <p>The service sends authorization and FHIR requests to Epic systems operated for your healthcare organization. ${hostingProvider} processes requests and, when persistent hosting is enabled, stores the connector’s encrypted connection records as the configured infrastructure provider. Other network providers may transmit information, subject to the operator’s arrangements with those providers. We may disclose information when required by law or when reasonably necessary to protect users, the service, or others.</p>
        <p>The application does not sell health information, use it for targeted advertising, or disclose it to data brokers.</p>

        <h2>4. Storage and retention</h2>
        <ul>
          <li>Pending OAuth state, including the PKCE verifier and nonce, is held in process memory or encrypted hosted storage depending on the deployment and normally expires after 10 minutes.</li>
          <li>The signed browser-session cookie is set for up to 30 days. Connection records, patient identifiers, and OAuth tokens remain in memory by default. Cloudflare Durable Object and local encrypted-file modes encrypt records before persistent storage. Records become unusable after 30 days unless disconnected sooner and are removed on use or scheduled cleanup shortly afterward.</li>
          <li>FHIR resources returned by your healthcare organization are transmitted to your browser and are not added to the connector’s persistent connection store.</li>
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

export function renderError(message: string): string {
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
label { font-size: .86rem; font-weight: 750; color: #49636b; }
select, input { width: 100%; border: 1px solid #c8d7db; border-radius: 9px; background: white; padding: 10px; font: inherit; color: #15313a; }
.hint { color: #5d747b; font-size: .9rem; line-height: 1.5; }
.granted-access { margin: 12px 0 16px; color: #49636b; font-size: .86rem; }
.granted-access summary { cursor: pointer; font-weight: 750; }
.granted-access code { display: block; margin-top: 10px; color: #36545d; line-height: 1.55; overflow-wrap: anywhere; }
.scope-warning { margin: 10px 0 0; padding: 10px 12px; border-radius: 9px; background: #fff1c9; color: #704d08; line-height: 1.5; }
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
}
`;

export const browserScript = `
const statusElement = document.querySelector('#status');
const connectForm = document.querySelector('#connect-form');
const connectButton = document.querySelector('#connect');
const legalConsent = document.querySelector('#legal-consent');
const legalConsentCheckbox = document.querySelector('#legal-consent-checkbox');
const disconnectButton = document.querySelector('#disconnect');
const notice = document.querySelector('#notice');
const explorer = document.querySelector('#explorer');
const result = document.querySelector('#result');
const patientButton = document.querySelector('#patient');
const searchForm = document.querySelector('#search-form');
const grantedAccess = document.querySelector('#granted-access');
const grantedScopeCount = document.querySelector('#granted-scope-count');
const grantedScopes = document.querySelector('#granted-scopes');
const scopeWarning = document.querySelector('#scope-warning');

async function api(path, options) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Accept': 'application/json', ...(options && options.headers) },
    ...options,
  });
  const body = await response.json().catch(() => ({ error: { message: 'Invalid server response.' } }));
  if (!response.ok) {
    const apiError = body && body.error && typeof body.error === 'object' ? body.error : {};
    const error = new Error(typeof apiError.message === 'string' ? apiError.message : 'Request failed.');
    error.code = typeof apiError.code === 'string' ? apiError.code : 'request_failed';
    error.status = response.status;
    throw error;
  }
  return body;
}

function showResult(value) {
  result.textContent = JSON.stringify(value, null, 2);
  result.focus();
}

function showApiError(error) {
  showResult({
    error: {
      code: typeof error.code === 'string' ? error.code : 'request_failed',
      status: Number.isInteger(error.status) ? error.status : undefined,
      message: error instanceof Error ? error.message : 'Request failed.',
    },
  });
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

async function refreshStatus() {
  try {
    const connection = await api('/api/connection');
    if (connection.connected) {
      const accessMode = connection.durable
        ? ' · encrypted persistent access enabled'
        : connection.refreshable
          ? ' · refreshable until this service restarts'
          : ' · short-lived access';
      statusElement.textContent = 'Connected to ' + connection.provider + accessMode;
      statusElement.className = 'status connected';
      connectForm.hidden = true;
      legalConsent.hidden = true;
      disconnectButton.hidden = false;
      explorer.hidden = false;
      showGrantedAccess(connection);
    } else {
      statusElement.textContent = 'Not connected';
      statusElement.className = 'status';
      connectForm.hidden = false;
      legalConsent.hidden = false;
      disconnectButton.hidden = true;
      explorer.hidden = true;
      grantedAccess.hidden = true;
    }
  } catch (error) {
    statusElement.textContent = error.message;
    statusElement.className = 'status error';
    connectForm.hidden = false;
    legalConsent.hidden = false;
  }
}

legalConsentCheckbox.addEventListener('change', () => {
  connectButton.disabled = !legalConsentCheckbox.checked;
});

patientButton.addEventListener('click', async () => {
  result.textContent = 'Loading…';
  try { showResult(await api('/api/patient')); }
  catch (error) { showApiError(error); await refreshStatus(); }
});

searchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  result.textContent = 'Loading…';
  const resourceType = document.querySelector('#resource-type').value;
  const count = document.querySelector('#count').value;
  try { showResult(await api('/api/fhir/' + encodeURIComponent(resourceType) + '?_count=' + encodeURIComponent(count))); }
  catch (error) { showApiError(error); await refreshStatus(); }
});

disconnectButton.addEventListener('click', async () => {
  disconnectButton.disabled = true;
  let manualRevocationRecommended = false;
  try {
    const outcome = await api('/api/disconnect', { method: 'POST' });
    manualRevocationRecommended = outcome.manualRevocationRecommended;
  } catch (error) {
    notice.textContent = error.message;
    notice.hidden = false;
  } finally {
    disconnectButton.disabled = false;
    await refreshStatus();
    if (manualRevocationRecommended) {
      notice.textContent = 'Local connection removed. Also remove this app under MyChart’s linked apps/devices settings if it is still listed.';
      notice.hidden = false;
    } else if (!notice.textContent) {
      notice.textContent = 'Connection removed.';
      notice.hidden = false;
    }
  }
});

refreshStatus();
`;
