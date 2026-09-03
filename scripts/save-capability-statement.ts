// to run this script, firt "cd epic"
// pnpm run fhir:save-capability

import { randomUUID } from "node:crypto";
import { open, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_FHIR_PATH,
  formatResponseBody,
  requestEpicFhir,
  type FetchImplementation,
} from "./epic-fhir-get.js";

export const CAPABILITY_STATEMENT_PATH = fileURLToPath(
  new URL("../src/capability-statement.json", import.meta.url),
);

export interface SaveCapabilityStatementOptions {
  readonly fhirBaseUrl: string;
  readonly clientId: string;
  readonly outputPath?: string;
  readonly fetchImplementation?: FetchImplementation;
}

function requiredEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} must be configured.`);
  return value;
}

export async function saveCapabilityStatement({
  fhirBaseUrl,
  clientId,
  outputPath = CAPABILITY_STATEMENT_PATH,
  fetchImplementation,
}: SaveCapabilityStatementOptions): Promise<string> {
  const result = await requestEpicFhir({
    fhirBaseUrl,
    clientId,
    requestPath: DEFAULT_FHIR_PATH,
    ...(fetchImplementation === undefined ? {} : { fetchImplementation }),
  });
  if (!result.ok) {
    throw new Error(`Epic rejected the CapabilityStatement request (${result.status}).`);
  }

  const capabilityStatement = JSON.parse(result.body) as { readonly fhirVersion?: unknown };
  if (
    typeof capabilityStatement.fhirVersion !== "string" ||
    !/^4\.0(?:\.\d+)?$/.test(capabilityStatement.fhirVersion)
  ) {
    throw new Error("Epic metadata was not an R4 CapabilityStatement.");
  }
  const formatted = formatResponseBody(result.body);
  const temporaryPath = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryHandle: FileHandle | undefined;
  try {
    temporaryHandle = await open(temporaryPath, "wx", 0o644);
    await temporaryHandle.writeFile(`${formatted}\n`, "utf8");
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await temporaryHandle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return outputPath;
}

function usage(): string {
  return [
    "Usage: pnpm run fhir:save-capability",
    "",
    "Fetches the configured Epic server's unauthenticated /metadata response and",
    "atomically writes it to src/capability-statement.json.",
  ].join("\n");
}

export async function run(
  args: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (args.length > 0) throw new Error(`Invalid arguments.\n\n${usage()}`);

  const outputPath = await saveCapabilityStatement({
    fhirBaseUrl: requiredEnvironmentValue(environment, "EPIC_FHIR_BASE_URL"),
    clientId: requiredEnvironmentValue(environment, "EPIC_CLIENT_ID"),
  });
  process.stdout.write(`Saved Epic CapabilityStatement to ${outputPath}\n`);
  return 0;
}

const entrypoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entrypoint === import.meta.url) {
  run()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown error";
      process.stderr.write(`CapabilityStatement save failed: ${message}\n`);
      process.exitCode = 1;
    });
}
