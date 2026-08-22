import { loadConfig } from "./config.js";
import { EpicDiscoveryService } from "./discovery.js";

try {
  const config = loadConfig();
  const discovery = await new EpicDiscoveryService(config).discover();
  process.stdout.write(
    `${JSON.stringify(
      {
        provider: config.providerName,
        fhirBaseUrl: discovery.fhirBaseUrl,
        authorizationEndpoint: discovery.smart.authorizationEndpoint,
        tokenEndpoint: discovery.smart.tokenEndpoint,
        revocationEndpoint: discovery.smart.revocationEndpoint ?? null,
        pkceMethods: discovery.smart.codeChallengeMethods,
        tokenAuthMethods: discovery.smart.tokenAuthMethods,
        capabilities: discovery.smart.capabilities,
        oidcIssuer: discovery.oidc.issuer,
        jwksUri: discovery.oidc.jwksUri,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`Epic discovery check failed: ${message}\n`);
  process.exitCode = 1;
}
