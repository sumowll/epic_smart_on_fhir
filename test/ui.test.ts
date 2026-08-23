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
    expect(() => new Function(browserScript)).not.toThrow();
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
