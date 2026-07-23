import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseExampleQuery, registerExamplesCommand } from "./examples";

describe("examples command", () => {
  test("requires exactly one lookup mode and protects --full", () => {
    expect(() => parseExampleQuery({ module: "http:Action", app: "http" })).toThrow(
      "exactly one",
    );
    expect(() => parseExampleQuery({ scenario: "20", moduleId: "2", full: true }))
      .not.toThrow();
    expect(() => parseExampleQuery({ module: "http:Action", full: true })).toThrow(
      "--full requires both --scenario and --module-id",
    );
  });

  test("refreshes the organization index and emits found false for inaccessible examples", async () => {
    const output: any[] = [];
    const calls: string[] = [];
    const program = new Command().exitOverride();
    registerExamplesCommand(program, {
      cliVersion: "test",
      indexRoot: mkdtempSync(join(tmpdir(), "make-fixer-examples-")),
      parseMakeUrl: () => ({ baseUrl: "https://eu1.make.com", teamId: 7 }),
      createClient: async () => ({
        fetchTeam: async () => ({ id: 7, organizationId: 99 }),
        listAllScenarios: async () => {
          calls.push("list");
          return {
            scenarios: [{ id: 20, name: "One", teamId: 7, lastEdit: "now" }],
            pages: [{}],
            complete: true,
            failedOffset: null,
          };
        },
        fetchBlueprint: async () => {
          calls.push("blueprint");
          return { blueprint: { name: "One", flow: [] }, raw: {} };
        },
        fetchNotes: async () => [],
        getScenarioUrl: () => "https://eu1.make.com/api/v2/scenarios/20",
        getRateLimitSnapshot: () => ({
          documentedRpm: 60,
          effectiveRpm: 57,
          limitSource: "organization_api",
          requestsSent: 2,
          retries: 0,
          cooldownMs: 0,
        }),
      } as any),
      writeOutput: (value) => output.push(value),
    });

    await program.parseAsync([
      "examples",
      "--from-url",
      "https://eu1.make.com/7/scenarios/20/edit",
      "--module",
      "salesforce:CreateRecord",
    ], { from: "user" });

    expect(calls).toEqual(["list", "blueprint"]);
    expect(output[0]).toMatchObject({
      ok: true,
      command: "examples",
      data: {
        organizationId: 99,
        found: false,
        examples: [],
        incomplete: false,
      },
      meta: { source: "organization_index" },
    });
  });
});
