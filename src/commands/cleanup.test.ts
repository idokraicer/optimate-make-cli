import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerCleanupCommand } from "./cleanup";
import type { OwnedScenarioRecord } from "../probes/ownership-store";
import { fingerprintBlueprint } from "../utils/blueprint-fingerprint";

const blueprint = { name: "owned", flow: [], metadata: {} } as any;

async function harness(options: {
  owned?: Partial<OwnedScenarioRecord> | null;
  remote?: Record<string, unknown>;
  remoteBlueprint?: unknown;
  deleteImpl?: () => Promise<number>;
} = {}) {
  const output: unknown[] = [];
  let deletes = 0;
  const fingerprint = await fingerprintBlueprint(blueprint);
  const owned = options.owned === null ? null : {
    scenarioId: 44,
    operationId: "op",
    teamId: 21,
    organizationId: 9,
    baseUrl: "https://eu1.make.com",
    createdAt: "2026-07-23T10:00:00.000Z",
    updatedAt: "2026-07-23T10:00:00.000Z",
    lastVerifiedFingerprint: fingerprint,
    lifecycleState: "inactive",
    executionId: null,
    ...options.owned,
  } as OwnedScenarioRecord;
  const store = {
    get: () => owned,
    listPending: () => owned ? [owned] : [],
    markDeleted: () => { if (owned) owned.lifecycleState = "deleted"; },
    update: () => undefined,
  };
  const client = {
    getBaseUrl: () => "https://eu1.make.com",
    getRateLimitSnapshot: () => ({ effectiveRpm: 57 }),
    fetchScenarioDetails: async () => ({
      id: 44, name: "owned", teamId: 21, isActive: false, scheduling: { type: "on-demand" },
      ...options.remote,
    }),
    fetchBlueprint: async () => ({ blueprint: options.remoteBlueprint ?? blueprint }),
    deleteScenario: async () => {
      deletes++;
      return options.deleteImpl ? options.deleteImpl() : 204;
    },
  };
  const program = new Command().exitOverride();
  registerCleanupCommand(program, {
    resolveClient: async () => client as any,
    parseScenarioInput: () => ({ scenarioId: 44, teamId: 21, baseUrl: "https://eu1.make.com" }),
    resolveOrganizationId: async () => 9,
    ownership: store as any,
    cliVersion: "test",
    writeOutput: (value) => output.push(value),
  });
  return { program, output, get deletes() { return deletes; }, owned };
}

describe("cleanup command", () => {
  test("defaults to read-only status", async () => {
    const h = await harness();
    await h.program.parseAsync(["cleanup", "-s", "44"], { from: "user" });
    expect(h.deletes).toBe(0);
    expect(h.output[0]).toMatchObject({ ok: true, data: { deleteRequested: false, eligible: true } });
  });

  test("blocks every unsafe condition without sending DELETE", async () => {
    const cases = [
      await harness({ owned: null }),
      await harness({ owned: { teamId: 99 } }),
      await harness({ owned: { baseUrl: "https://us1.make.com" } }),
      await harness({ owned: { organizationId: 99 } }),
      await harness({ remote: { isActive: true } }),
      await harness({ remoteBlueprint: { ...blueprint, flow: [{ id: 1, module: "tools:SetVariable2" }] } }),
    ];
    for (const h of cases) {
      await h.program.parseAsync(["cleanup", "-s", "44", "--delete", "--yes"], { from: "user" });
      expect(h.deletes).toBe(0);
      expect(h.output[0]).toMatchObject({ ok: false, command: "cleanup" });
    }
  });

  test("requires both --delete and --yes and deletes an eligible owned scenario", async () => {
    const missingYes = await harness();
    await missingYes.program.parseAsync(["cleanup", "-s", "44", "--delete"], { from: "user" });
    expect(missingYes.deletes).toBe(0);

    const h = await harness();
    await h.program.parseAsync(["cleanup", "-s", "44", "--delete", "--yes"], { from: "user" });
    expect(h.deletes).toBe(1);
    expect(h.owned?.lifecycleState).toBe("deleted");
    expect(h.output[0]).toMatchObject({ ok: true, data: { deleted: true } });
  });
});
