import { loadConfig } from "./config.js";
import { EpicOAuthClient } from "./oauth.js";
import { EncryptedFileConnectionStore } from "./store.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.tokenStorage !== "encrypted-file" || !config.tokenEncryptionKey) {
    process.stdout.write("TOKEN_STORAGE is not encrypted-file; there are no durable local tokens to purge.\n");
    return;
  }

  const store = new EncryptedFileConnectionStore(
    config.tokenStoreFile,
    config.tokenEncryptionKey,
  );
  await store.initialize();
  try {
    const oauth = new EpicOAuthClient(config);
    const entries = await store.list();
    let remotelyRevoked = 0;
    let manualRevocationNeeded = 0;

    for (const [sessionId, record] of entries) {
      try {
        if (record.revocationEndpoint && oauth.canSafelyRevoke(record)) {
          await oauth.revoke(record.revocationEndpoint, record);
          remotelyRevoked += 1;
        } else {
          manualRevocationNeeded += 1;
        }
      } catch {
        manualRevocationNeeded += 1;
      } finally {
        await store.delete(sessionId);
      }
    }

    process.stdout.write(
      [
        `Purged ${entries.length} durable local connection(s).`,
        `Remote revocation confirmed: ${remotelyRevoked}.`,
        `Manual MyChart revocation recommended: ${manualRevocationNeeded}.`,
        "",
      ].join("\n"),
    );
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown purge error";
  process.stderr.write(`Token purge failed: ${message}\n`);
  process.exitCode = 1;
});
