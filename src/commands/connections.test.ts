import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerConnectionsCommand } from "./connections";

describe("connections command", () => {
  test("requires a team-bearing Make URL and emits sanitized JSON-first results", async () => {
    const output: any[] = [];
    const program = new Command().exitOverride();
    registerConnectionsCommand(program, {
      cliVersion: "test",
      parseMakeUrl: () => ({ baseUrl: "https://eu1.make.com", teamId: 2186253 }),
      createClient: async () => ({
        listConnections: async (teamId: number) => [{
          id: 5,
          name: "CRM",
          accountName: "agent@example.test",
          accountLabel: "CRM account",
          packageName: "monday",
          teamId,
          scoped: true,
          metadata: { region: "eu" },
        }],
        getRateLimitSnapshot: () => ({
          documentedRpm: 60,
          effectiveRpm: 57,
          limitSource: "organization_api",
          requestsSent: 1,
          retries: 0,
          cooldownMs: 0,
        }),
      } as any),
      writeOutput: (value) => output.push(value),
    });

    await program.parseAsync([
      "connections",
      "--from-url",
      "https://eu1.make.com/2186253/scenarios/1/edit",
    ], { from: "user" });

    expect(output[0]).toMatchObject({
      ok: true,
      command: "connections",
      data: {
        teamId: 2186253,
        connections: [{ id: 5, packageName: "monday", metadata: { region: "eu" } }],
      },
      meta: { source: "make_api" },
    });
  });
});
