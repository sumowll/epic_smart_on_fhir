import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { saveCapabilityStatement } from "../scripts/save-capability-statement.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function temporaryOutputPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "epic-capability-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "capability-statement.json");
}

describe("CapabilityStatement snapshot script", () => {
  it("writes the complete formatted CapabilityStatement with a trailing newline", async () => {
    const outputPath = await temporaryOutputPath();
    const capabilityStatement = {
      resourceType: "CapabilityStatement",
      fhirVersion: "4.0.1",
      instantiates: [
        "http://hl7.org/fhir/us/core/CapabilityStatement/us-core-server|6.1.0",
      ],
      rest: [{
        mode: "server",
        resource: [{
          type: "Patient",
          supportedProfile: [
            "http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient",
          ],
        }],
      }],
    };
    const fetchImplementation = vi.fn(async () =>
      new Response(JSON.stringify(capabilityStatement), {
        status: 200,
        headers: { "Content-Type": "application/fhir+json" },
      }));

    await expect(saveCapabilityStatement({
      fhirBaseUrl: "https://ehr.example.test/api/FHIR/R4",
      clientId: "client-id",
      outputPath,
      fetchImplementation,
    })).resolves.toBe(outputPath);

    const saved = await readFile(outputPath, "utf8");
    expect(saved.endsWith("\n")).toBe(true);
    expect(JSON.parse(saved)).toEqual(capabilityStatement);
    expect(await readdir(join(outputPath, ".."))).toEqual([
      "capability-statement.json",
    ]);
  });

  it("does not replace the previous snapshot when Epic rejects the request", async () => {
    const outputPath = await temporaryOutputPath();
    await writeFile(outputPath, "previous snapshot\n", "utf8");
    const fetchImplementation = vi.fn(async () =>
      new Response(JSON.stringify({ resourceType: "OperationOutcome" }), {
        status: 503,
        headers: { "Content-Type": "application/fhir+json" },
      }));

    await expect(saveCapabilityStatement({
      fhirBaseUrl: "https://ehr.example.test/api/FHIR/R4",
      clientId: "client-id",
      outputPath,
      fetchImplementation,
    })).rejects.toThrow(/rejected.*503/);
    await expect(readFile(outputPath, "utf8")).resolves.toBe("previous snapshot\n");
  });

  it("does not replace the previous snapshot with non-R4 metadata", async () => {
    const outputPath = await temporaryOutputPath();
    await writeFile(outputPath, "previous snapshot\n", "utf8");
    const fetchImplementation = vi.fn(async () =>
      new Response(JSON.stringify({
        resourceType: "CapabilityStatement",
        fhirVersion: "5.0.0",
      }), {
        status: 200,
        headers: { "Content-Type": "application/fhir+json" },
      }));

    await expect(saveCapabilityStatement({
      fhirBaseUrl: "https://ehr.example.test/api/FHIR/R4",
      clientId: "client-id",
      outputPath,
      fetchImplementation,
    })).rejects.toThrow(/R4 CapabilityStatement/);
    await expect(readFile(outputPath, "utf8")).resolves.toBe("previous snapshot\n");
  });
});
