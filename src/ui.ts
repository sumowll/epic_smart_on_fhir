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
        <div id="status" class="status" aria-live="polite">Checking connection…</div>
        <div id="notice" class="status warning" role="status" hidden></div>
        <form id="connect-form" method="post" action="/auth/start" hidden>
          <button type="submit">Connect MyChart</button>
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
    </main>
    <script src="/app.js" defer></script>
  </body>
</html>`;
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
pre { min-height: 240px; max-height: 620px; overflow: auto; border-radius: 12px; background: #0f2931; color: #d9f1ec; padding: 18px; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.note p { margin-bottom: 0; color: #526c74; line-height: 1.65; }
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
const disconnectButton = document.querySelector('#disconnect');
const notice = document.querySelector('#notice');
const explorer = document.querySelector('#explorer');
const result = document.querySelector('#result');
const patientButton = document.querySelector('#patient');
const searchForm = document.querySelector('#search-form');

async function api(path, options) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Accept': 'application/json', ...(options && options.headers) },
    ...options,
  });
  const body = await response.json().catch(() => ({ error: { message: 'Invalid server response.' } }));
  if (!response.ok) throw new Error(body.error && body.error.message ? body.error.message : 'Request failed.');
  return body;
}

function showResult(value) {
  result.textContent = JSON.stringify(value, null, 2);
  result.focus();
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
      disconnectButton.hidden = false;
      explorer.hidden = false;
    } else {
      statusElement.textContent = 'Not connected';
      statusElement.className = 'status';
      connectForm.hidden = false;
      disconnectButton.hidden = true;
      explorer.hidden = true;
    }
  } catch (error) {
    statusElement.textContent = error.message;
    statusElement.className = 'status error';
    connectForm.hidden = false;
  }
}

patientButton.addEventListener('click', async () => {
  result.textContent = 'Loading…';
  try { showResult(await api('/api/patient')); }
  catch (error) { showResult({ error: error.message }); await refreshStatus(); }
});

searchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  result.textContent = 'Loading…';
  const resourceType = document.querySelector('#resource-type').value;
  const count = document.querySelector('#count').value;
  try { showResult(await api('/api/fhir/' + encodeURIComponent(resourceType) + '?_count=' + encodeURIComponent(count))); }
  catch (error) { showResult({ error: error.message }); await refreshStatus(); }
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
