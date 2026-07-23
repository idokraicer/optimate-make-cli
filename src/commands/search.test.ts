import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerSearchCommand } from "./search";

describe("search command", () => {
  test("rejects an invalid regex before resolving a client or making network calls", async () => {
    let clientCalls = 0;
    const output: unknown[] = [];
    const program = new Command().exitOverride();
    registerSearchCommand(program, {
      cliVersion: "test",
      createClient: async () => {
        clientCalls++;
        throw new Error("network should not be reached");
      },
      parseMakeUrl: () => ({}),
      indexRoot: "/tmp/not-used",
      writeOutput: (value) => output.push(value),
    });

    process.exitCode = 0;
    await program.parseAsync(["search", "--organization", "9", "--regex", "["], { from: "user" });
    expect(clientCalls).toBe(0);
    expect(process.exitCode).toBe(1);
    expect(output[0]).toMatchObject({
      ok: false,
      command: "search",
      error: { code: "INVALID_DATA", retryable: false },
    });
    process.exitCode = 0;
  });

  test("resolves organization from a scenario URL's team and searches all organization scenarios", async () => {
    const calls: string[] = [];
    const output: any[] = [];
    const program = new Command().exitOverride();
    const client = {
      fetchTeam: async (teamId: number) => {
        calls.push(`team:${teamId}`);
        return { id: teamId, organizationId: 99 };
      },
      fetchOrganization: async (organizationId: number) => {
        calls.push(`organization:${organizationId}`);
        return { id: organizationId, license: { apiLimit: 60 } };
      },
      listScenarios: async ({ organizationId }: { organizationId: number }) => {
        calls.push(`scenarios:${organizationId}`);
        return [{ id: 1, name: "One", teamId: 7, lastEdit: "now" }];
      },
      fetchBlueprint: async () => ({ blueprint: {
        name: "One",
        flow: [{ id: 1, module: "monday:CreateItemV2", parameters: { boardId: 5100313109 } }],
      }, raw: {} }),
      fetchNotes: async () => [],
      getScenarioUrl: (id: number) => `https://eu1.make.com/api/v2/scenarios/${id}`,
      getRateLimitSnapshot: () => ({
        documentedRpm: 60,
        effectiveRpm: 57,
        limitSource: "organization_api",
        requestsSent: 4,
        retries: 0,
        cooldownMs: 0,
      }),
    };
    registerSearchCommand(program, {
      cliVersion: "test",
      createClient: async (baseUrl) => {
        expect(baseUrl).toBe("https://eu1.make.com");
        return client as any;
      },
      parseMakeUrl: () => ({ teamId: 7, scenarioId: 1, baseUrl: "https://eu1.make.com" }),
      indexRoot: "/tmp/make-fixer-search-command-test",
      writeOutput: (value) => output.push(value),
    });

    await program.parseAsync([
      "search",
      "--from-url",
      "https://eu1.make.com/7/scenarios/1/edit",
      "--field",
      "boardId",
      "--value",
      "5100313109",
      "--fresh",
    ], { from: "user" });

    expect(calls).toEqual(["team:7", "organization:99", "scenarios:99"]);
    expect(output[0]).toMatchObject({
      ok: true,
      command: "search",
      data: {
        organizationId: 99,
        incomplete: false,
        cacheHits: 0,
        failedScenarioIds: [],
        matches: [{ scenarioId: 1, moduleId: 1, key: "boardId", value: "5100313109" }],
      },
      meta: {
        source: "organization_index",
        rate: { documentedRpm: 60, effectiveRpm: 57 },
      },
    });
  });
});
