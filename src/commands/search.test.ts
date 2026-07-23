import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      listAllScenarios: async ({ organizationId }: { organizationId: number }) => {
        calls.push(`scenarios:${organizationId}`);
        return {
          scenarios: [{ id: 1, name: "One", teamId: 7, lastEdit: "now" }],
          pages: [{ scenarios: [], pagination: null }],
          complete: true,
          failedOffset: null,
        };
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

    expect(calls).toEqual(["team:7", "scenarios:99"]);
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
        rateLimit: {
          organizationId: 99,
          documentedRpm: 60,
          effectiveRpm: 57,
          cacheHits: 0,
          checkpointed: true,
        },
      },
    });
    expect(output[0].meta.rate).toBeUndefined();
    expect(output[0].meta.cache).toBeUndefined();
    expect(output[0].meta.rateLimit).toEqual({
      organizationId: 99,
      documentedRpm: 60,
      effectiveRpm: 57,
      limitSource: "organization_api",
      requestsSent: 4,
      cacheHits: 0,
      retries: 0,
      cooldownMs: 0,
      checkpointed: true,
    });
  });

  test("surfaces an incomplete listing and retains unseen cached organization records", async () => {
    const indexRoot = mkdtempSync(join(tmpdir(), "make-fixer-search-command-partial-"));
    const indexDirectory = join(indexRoot, "eu1", "99");
    mkdirSync(indexDirectory, { recursive: true });
    await Bun.write(join(indexDirectory, "index.json"), JSON.stringify({
      version: 1,
      organizationId: 99,
      zone: "eu1",
      records: [{
        scenarioId: 88,
        scenarioName: "Cached",
        teamId: 7,
        lastEdit: "old",
        sanitizedBlueprint: { name: "Cached", flow: [] },
        entries: [{
          scenarioId: 88,
          scenarioName: "Cached",
          teamId: 7,
          moduleId: null,
          moduleType: null,
          path: "scenario.name",
          key: "name",
          value: "Cached",
        }],
        indexedAt: "2026-01-01T00:00:00.000Z",
      }],
    }));
    const output: any[] = [];
    const program = new Command().exitOverride();
    registerSearchCommand(program, {
      cliVersion: "test",
      createClient: async () => ({
        fetchOrganization: async () => ({ id: 99 }),
        listAllScenarios: async () => ({
          scenarios: [],
          pages: [],
          complete: false,
          failedOffset: 0,
        }),
        fetchBlueprint: async () => {
          throw new Error("must retain cache without fetching");
        },
        getScenarioUrl: (id: number) => `https://eu1.make.com/api/v2/scenarios/${id}`,
        getRateLimitSnapshot: () => ({
          documentedRpm: 60,
          effectiveRpm: 57,
          limitSource: "organization_api",
          requestsSent: 2,
          retries: 0,
          cooldownMs: 0,
        }),
      } as any),
      parseMakeUrl: () => ({ organizationId: 99, baseUrl: "https://eu1.make.com" }),
      indexRoot,
      writeOutput: (value) => output.push(value),
    });

    await program.parseAsync([
      "search",
      "--from-url",
      "https://eu1.make.com/organization/99/dashboard",
      "--query",
      "cached",
    ], { from: "user" });

    expect(output[0]).toMatchObject({
      ok: true,
      data: {
        incomplete: true,
        listing: { complete: false, failedOffset: 0 },
        matches: [{ scenarioId: 88 }],
      },
    });
  });

  test("emits capability error envelopes when organization listing fails before page one", async () => {
    const cases = [
      { status: 401, code: "AUTH_INVALID" },
      { status: 402, code: "PLAN_RESTRICTED" },
      { status: 403, code: "SCOPE_MISSING" },
      { status: 404, code: "NOT_FOUND" },
    ];
    for (const { status, code } of cases) {
      const output: any[] = [];
      const program = new Command().exitOverride();
      registerSearchCommand(program, {
        cliVersion: "test",
        createClient: async () => ({
          listAllScenarios: async () => {
            throw new Error(`Make API list scenarios error ${status}: private provider body`);
          },
        } as any),
        parseMakeUrl: () => ({ organizationId: 99, baseUrl: "https://eu1.make.com" }),
        indexRoot: "/tmp/not-used-first-page-failure",
        writeOutput: (value) => output.push(value),
      });

      process.exitCode = 0;
      await program.parseAsync([
        "search",
        "--from-url",
        "https://eu1.make.com/organization/99/dashboard",
        "--query",
        "anything",
      ], { from: "user" });

      expect(output[0]).toMatchObject({
        ok: false,
        command: "search",
        error: { code, httpStatus: status, retryable: false },
      });
      expect(JSON.stringify(output[0])).not.toContain("private provider body");
    }
    process.exitCode = 0;
  });
});
