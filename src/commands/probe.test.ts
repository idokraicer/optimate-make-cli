import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerProbeCommand } from "./probe";
import { MakeApiRequestError } from "../make-api/api-error";

const blueprint = {
  name: "Probe",
  flow: [{ id: 1, module: "http:ActionSendData", parameters: { __IMTCONN__: 5 } }],
};

function harness(overrides: Record<string, unknown> = {}) {
  const output: any[] = [];
  const runs: any[] = [];
  const program = new Command().exitOverride();
  const ownership = {
    listPending: () => [
      { scenarioId: 44, lifecycleState: "inactive" },
      { scenarioId: 99, lifecycleState: "cleanup_failed" },
    ],
    listProbeIntents: () => [{
      operationId: "recovery-operation",
      lifecycleState: "creating",
    }],
  };
  registerProbeCommand(program, {
    resolveTarget: async () => ({
      teamId: 21, organizationId: 9, baseUrl: "https://eu1.make.com",
    }),
    createClient: async () => ({
      listConnections: async () => [{ id: 5 }],
      getRateLimitSnapshot: () => ({ effectiveRpm: 57 }),
    } as any),
    readBlueprint: async () => blueprint,
    readDataFile: async () => ({ fromFile: true }),
    ownership: ownership as any,
    cliVersion: "test",
    writeOutput: (value) => output.push(value),
    runProbe: async (_deps, request) => {
      runs.push(request);
      return {
        scenarioId: 44,
        executionId: "exec-1",
        executionStatus: "SUCCESS",
        outputs: { answer: "ok" },
        executionError: null,
        postRunInterfaces: [],
        moduleLogs: [],
        scenarioActive: false,
        cleanupRequired: true,
        cleanupOptions: ["keep", "delete", "revise_and_rerun"],
        userDecisionRequired: true,
      };
    },
    ...overrides,
  });
  return { program, output, runs };
}

describe("probe command", () => {
  test("previews validated blueprint, input, and connection references without mutation", async () => {
    const h = harness();
    await h.program.parseAsync([
      "probe",
      "--from-url", "https://eu1.make.com/21/scenarios/1/edit",
      "--blueprint", "probe.json",
      "--name", "Output probe",
      "--data", "{\"value\":1}",
    ], { from: "user" });

    expect(h.runs).toHaveLength(0);
    expect(h.output[0]).toMatchObject({
      ok: true,
      command: "probe",
      data: {
        preview: true,
        confirmed: false,
        connectionReferences: [5],
        input: { value: 1 },
      },
    });
  });

  test("runs only with --yes and returns every other pending scenario", async () => {
    const h = harness();
    await h.program.parseAsync([
      "probe",
      "--from-url", "https://eu1.make.com/21/scenarios/1/edit",
      "--blueprint", "probe.json",
      "--name", "Output probe",
      "--data-file", "data.json",
      "--timeout", "5s",
      "--yes",
    ], { from: "user" });

    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({
      teamId: 21,
      organizationId: 9,
      name: "Output probe",
      data: { fromFile: true },
    });
    expect(h.output[0]).toMatchObject({
      ok: true,
      data: {
        scenarioId: 44,
        userDecisionRequired: true,
      },
      meta: {
        pendingCleanup: [{ scenarioId: 99, lifecycleState: "cleanup_failed" }],
      },
    });
  });

  test("rejects missing connection references before mutation", async () => {
    const h = harness({
      createClient: async () => ({
        listConnections: async () => [],
        getRateLimitSnapshot: () => ({ effectiveRpm: 57 }),
      }),
    });
    await h.program.parseAsync([
      "probe",
      "--from-url", "https://eu1.make.com/21/scenarios/1/edit",
      "--blueprint", "probe.json",
      "--name", "Output probe",
      "--yes",
    ], { from: "user" });
    expect(h.runs).toHaveLength(0);
    expect(h.output[0]).toMatchObject({
      ok: false,
      error: { code: "PROBE_VALIDATION_FAILED" },
    });
  });

  test("maps unresolved cleanup to exit code 5 without exposing secrets", async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = 0;
    const h = harness({
      runProbe: async () => {
        const error = Object.assign(new Error("Bearer private-secret"), {
          exitCode: 5,
          result: {
            scenarioId: 44,
            executionId: "exec-1",
            scenarioActive: true,
            cleanupRequired: true,
            cleanupOptions: ["keep", "delete", "revise_and_rerun"],
            userDecisionRequired: true,
          },
        });
        throw error;
      },
    });
    await h.program.parseAsync([
      "probe",
      "--from-url", "https://eu1.make.com/21/scenarios/1/edit",
      "--blueprint", "probe.json",
      "--name", "Output probe",
      "--yes",
    ], { from: "user" });
    expect(process.exitCode).toBe(5);
    expect(h.output[0]).toMatchObject({
      ok: false,
      error: { code: "PROBE_CLEANUP_FAILED" },
      data: { scenarioId: 44, scenarioActive: true },
      meta: {
        pendingRecovery: [{
          operationId: "recovery-operation",
          lifecycleState: "creating",
        }],
      },
    });
    expect(JSON.stringify(h.output[0])).not.toContain("private-secret");
    process.exitCode = originalExitCode;
  });

  test("returns the retained scenario and decision contract for a failed post-create probe", async () => {
    const error = Object.assign(new Error("provider private detail"), {
      result: {
        scenarioId: 44,
        executionId: null,
        executionStatus: "UNKNOWN",
        outputs: null,
        executionError: null,
        postRunInterfaces: [],
        moduleLogs: [],
        scenarioActive: false,
        cleanupRequired: true,
        cleanupOptions: ["keep", "delete", "revise_and_rerun"],
        userDecisionRequired: true,
      },
    });
    const h = harness({ runProbe: async () => { throw error; } });
    await h.program.parseAsync([
      "probe",
      "--from-url", "https://eu1.make.com/21/scenarios/1/edit",
      "--blueprint", "probe.json",
      "--name", "Output probe",
      "--yes",
    ], { from: "user" });
    expect(h.output[0]).toMatchObject({
      ok: false,
      error: { code: "PROBE_FAILED" },
      data: {
        scenarioId: 44,
        scenarioActive: false,
        userDecisionRequired: true,
      },
    });
    expect(JSON.stringify(h.output[0])).not.toContain("private detail");
  });

  test("reports the classified Make API error when creation is refused", async () => {
    const error = new MakeApiRequestError({
      code: "INVALID_DATA",
      message: "Invalid blueprint",
      httpStatus: 400,
      providerCode: "IM005",
      retryable: false,
    });
    const h = harness({ runProbe: async () => { throw error; } });
    await h.program.parseAsync([
      "probe",
      "--from-url", "https://eu1.make.com/21/scenarios/1/edit",
      "--blueprint", "probe.json",
      "--name", "Output probe",
      "--yes",
    ], { from: "user" });
    expect(h.output[0]).toMatchObject({
      ok: false,
      error: {
        code: "PROBE_FAILED",
        message: "The owned probe could not be completed: Invalid blueprint",
        httpStatus: 400,
        providerCode: "IM005",
        retryable: false,
      },
    });
    expect(h.output[0].data).toBeUndefined();
  });
});
