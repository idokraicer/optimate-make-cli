import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerCreateCommand } from "./create";

const blueprint = { name: "Output probe", flow: [], metadata: {} };

function harness(overrides: Record<string, unknown> = {}) {
  const output: unknown[] = [];
  const posts: unknown[] = [];
  const records: any[] = [];
  const client = {
    createScenario: async (input: unknown) => {
      posts.push(input);
      return {
        id: 44,
        name: "created [123e4567-e89b-12d3-a456-426614174000]",
        teamId: 21,
        isActive: false,
        scheduling: { type: "on-demand" },
      };
    },
    fetchScenarioDetails: async () => ({
      id: 44,
      name: "created [123e4567-e89b-12d3-a456-426614174000]",
      teamId: 21,
      isActive: false,
      scheduling: { type: "on-demand" },
    }),
    fetchBlueprint: async () => ({ blueprint: { ...blueprint, name: "created" } }),
    listAllScenarios: async () => ({ scenarios: [], complete: true }),
    getRateLimitSnapshot: () => ({ effectiveRpm: 57 }),
    ...overrides,
  };
  const ownership = {
    put: (value: unknown) => records.push(value),
    update: (_baseUrl: string, scenarioId: number, patch: Record<string, unknown>) => {
      const value = records.find((record) => record.scenarioId === scenarioId);
      if (value) Object.assign(value, patch);
    },
    listPending: () => records,
  };
  const program = new Command().exitOverride();
  registerCreateCommand(program, {
    createClient: async () => client as any,
    resolveTeam: async () => ({
      teamId: 21, organizationId: 9, baseUrl: "https://eu1.make.com",
    }),
    readBlueprint: async () => blueprint as any,
    ownership: ownership as any,
    cliVersion: "test",
    writeOutput: (value) => output.push(value),
    randomUUID: () => "123e4567-e89b-12d3-a456-426614174000",
  });
  return { program, output, posts, records };
}

describe("create command", () => {
  test("previews without POST and retains the exact operation marker", async () => {
    const h = harness();
    await h.program.parseAsync(["create", "--team", "21", "--blueprint", "probe.json"], { from: "user" });
    expect(h.posts).toHaveLength(0);
    expect(h.output[0]).toMatchObject({
      ok: true,
      data: {
        preview: true,
        operationId: "123e4567-e89b-12d3-a456-426614174000",
        name: "[make-fixer probe] Output probe [123e4567-e89b-12d3-a456-426614174000]",
      },
    });
  });

  test("creates on demand, verifies the remote blueprint, and records ownership", async () => {
    const h = harness();
    await h.program.parseAsync([
      "create", "--team", "21", "--blueprint", "probe.json", "--yes",
    ], { from: "user" });
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toMatchObject({
      teamId: 21,
      scheduling: { type: "on-demand" },
      confirmed: true,
    });
    const sent = h.posts[0] as any;
    expect(sent.blueprint.name).toContain("[123e4567-e89b-12d3-a456-426614174000]");
    expect(h.records[0]).toMatchObject({
      scenarioId: 44,
      operationId: "123e4567-e89b-12d3-a456-426614174000",
      teamId: 21,
      organizationId: 9,
      lifecycleState: "verified",
      remoteVerifiedAt: expect.any(String),
    });
    expect((h.output[0] as any).meta.pendingCleanup).toHaveLength(1);
  });

  test("--no-probe-label removes only the readable prefix", async () => {
    const h = harness();
    await h.program.parseAsync([
      "create", "--team", "21", "--blueprint", "probe.json", "--no-probe-label",
    ], { from: "user" });
    expect((h.output[0] as any).data.name).toBe(
      "Output probe [123e4567-e89b-12d3-a456-426614174000]",
    );
  });

  test("retains created ownership when remote verification fails", async () => {
    const h = harness({
      fetchScenarioDetails: async () => ({
        id: 44,
        name: "wrong marker",
        teamId: 21,
        isActive: false,
        scheduling: { type: "on-demand" },
      }),
    });
    await h.program.parseAsync([
      "create", "--team", "21", "--blueprint", "probe.json", "--yes",
    ], { from: "user" });
    expect(h.records[0]).toMatchObject({
      scenarioId: 44,
      lifecycleState: "created",
      remoteVerifiedAt: null,
      operationId: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(h.output[0]).toMatchObject({
      ok: false,
      meta: { pendingCleanup: [{ scenarioId: 44, lifecycleState: "created" }] },
    });
  });

  test("surfaces ambiguous create reconciliation with an explicit stable code", async () => {
    const error = Object.assign(new Error("private provider detail"), { code: "AMBIGUOUS_CREATE" });
    const h = harness({
      createScenario: async () => { throw error; },
    });
    await h.program.parseAsync([
      "create", "--team", "21", "--blueprint", "probe.json", "--yes",
    ], { from: "user" });
    expect(h.posts).toHaveLength(0);
    expect(h.output[0]).toMatchObject({
      ok: false,
      error: { code: "AMBIGUOUS_CREATE" },
    });
    expect(JSON.stringify(h.output[0])).not.toContain("private provider detail");
  });
});
