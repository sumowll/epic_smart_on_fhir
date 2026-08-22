import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { exportJWK } from "jose";

const outputDirectory = resolve(".secrets");
const privateKeyPath = resolve(outputDirectory, "epic-private-key.pem");
const jwksPath = resolve(outputDirectory, "public.jwks.json");
const force = process.argv.includes("--force");

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-384",
});
const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const publicJwk = await exportJWK(publicKey);
const keyId = randomUUID();
const jwks = {
  keys: [
    {
      ...publicJwk,
      alg: "ES384",
      kid: keyId,
      key_ops: ["verify"],
      use: "sig",
    },
  ],
};

await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const flag = force ? "w" : "wx";
try {
  await writeFile(privateKeyPath, privateKeyPem, { encoding: "utf8", flag, mode: 0o600 });
  await writeFile(jwksPath, `${JSON.stringify(jwks, null, 2)}\n`, {
    encoding: "utf8",
    flag,
    mode: 0o644,
  });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "EEXIST") {
    process.stderr.write("Key files already exist. Use --force only when deliberate rotation is intended.\n");
    process.exitCode = 1;
  } else {
    throw error;
  }
}

if (process.exitCode !== 1) {
  process.stdout.write(
    [
      `Private key: ${privateKeyPath}`,
      `Public JWKS: ${jwksPath}`,
      `EPIC_PRIVATE_KEY_ALG=ES384`,
      `EPIC_PRIVATE_KEY_KID=${keyId}`,
      "Host public.jwks.json at a stable public HTTPS URL and register that URL with Epic.",
      "",
    ].join("\n"),
  );
}
