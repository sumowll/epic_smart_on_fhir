import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  try {
    const shutdown = async (): Promise<void> => {
      await app.close();
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());

    await app.listen({ host: config.host, port: config.port });
    process.stdout.write(
      `MyChart connector ready at ${config.publicOrigin} for ${config.providerName}.\n`,
    );
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  process.stderr.write(`MyChart connector failed to start: ${message}\n`);
  process.exitCode = 1;
});
