import { describe, expect, it } from "vitest";

import {
  browserScript,
  renderHome,
  renderPrivacy,
  renderTerms,
} from "../src/ui.js";
import { makeConfig } from "./helpers.js";

describe("legal pages", () => {
  it("links the legal pages before the authorization action", () => {
    const html = renderHome(makeConfig());
    const authorizationAction = html.indexOf('action="/auth/start"');

    expect(html.indexOf('href="/terms"')).toBeGreaterThan(-1);
    expect(html.indexOf('href="/privacy"')).toBeGreaterThan(-1);
    expect(html.indexOf('href="/terms"')).toBeLessThan(authorizationAction);
    expect(html.indexOf('href="/privacy"')).toBeLessThan(authorizationAction);
    expect(html).toContain('id="legal-consent-checkbox"');
    expect(html).toContain('id="connect" type="submit" disabled');
    expect(html).toContain('id="granted-access"');
    expect(html.indexOf('id="granted-access"')).toBeLessThan(html.indexOf('id="search-form"'));
    expect(browserScript).toContain("connection.scope");
    expect(browserScript).toContain("error.status = response.status");
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

  it("renders configured operator details and escapes legal-page content", () => {
    const config = makeConfig({
      APP_LEGAL_NAME: "Example & <Unsafe> Connector",
      APP_LEGAL_CONTACT_EMAIL: "privacy@connector.example.test",
    });
    const terms = renderTerms(config);
    const privacy = renderPrivacy(config);

    expect(terms).toContain("Example &amp; &lt;Unsafe&gt; Connector");
    expect(terms).not.toContain("Example & <Unsafe> Connector");
    expect(privacy).toContain("privacy@connector.example.test");
    expect(privacy).toContain("Example Cloud Host");
    expect(privacy).toContain("Condition, Observation");
    expect(privacy).toContain('datetime="2026-08-23"');
  });
});
