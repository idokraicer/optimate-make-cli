import { describe, expect, test } from "bun:test";
import type { Blueprint } from "../make-api/types";
import { ScenarioRunRequestError } from "../make-api/client";
import type { OwnedScenarioRecord, OwnershipStore } from "./ownership-store";
import {
  ProbeCleanupError,
  runOwnedProbe,
  type ProbeDependencies,
} from "./probe-runner";

const operationId = "123e4567-e89b-12d3-a456-426614174000";
const blueprint: Blueprint = {
  name: "Output probe",
  flow: [{
    id: 1,
    module: "builtin:BasicFeeder",
    metadata: { interface: [{ name: "value", type: "text" }] },
  }],
};

function memoryOwnership(order: string[]): OwnershipStore {
  const records: OwnedScenarioRecord[] = [];
  const intents: any[] = [];
  return {
    beginProbe(intent) {
      order.push("record creating");
      intents.push({ ...intent });
    },
    assignProbeScenario(baseUrl, assignedOperationId, scenarioId) {
      const intent = intents.find((candidate) =>
        candidate.baseUrl === baseUrl.replace(/\/+$/, "")
        && candidate.operationId === assignedOperationId
      );
      if (!intent) throw new Error("missing intent");
      intents.splice(intents.indexOf(intent), 1);
      records.push({ ...intent, scenarioId, lifecycleState: "created" });
      order.push("record created");
    },
    discardProbeIntent(baseUrl, discardedOperationId) {
      const index = intents.findIndex((candidate) =>
        candidate.baseUrl === baseUrl.replace(/\/+$/, "")
        && candidate.operationId === discardedOperationId
      );
      if (index >= 0) intents.splice(index, 1);
    },
    getProbeIntent(baseUrl, wantedOperationId) {
      return intents.find((candidate) =>
        candidate.baseUrl === baseUrl.replace(/\/+$/, "")
        && candidate.operationId === wantedOperationId
      ) ?? null;
    },
    listProbeIntents: () => intents.map((intent) => ({ ...intent })),
    put(record) {
      records.push({ ...record });
    },
    get(baseUrl, scenarioId) {
      return records.find((record) =>
        record.baseUrl === baseUrl.replace(/\/+$/, "") && record.scenarioId === scenarioId
      ) ?? null;
    },
    update(baseUrl, scenarioId, patch) {
      const record = records.find((candidate) =>
        candidate.baseUrl === baseUrl.replace(/\/+$/, "") && candidate.scenarioId === scenarioId
      );
      if (record) Object.assign(record, patch);
      order.push(`record ${String(patch.lifecycleState)}`);
    },
    listPending: () => records.filter((record) => record.lifecycleState !== "deleted"),
    markDeleted() {
      throw new Error("probe must never delete");
    },
  };
}

function harness(overrides: Record<string, unknown> = {}) {
  const order: string[] = [];
  let polls = 0;
  const ownership = memoryOwnership(order);
  const client = {
    createScenario: async (input: any) => {
      order.push("create");
      return {
        id: 44,
        name: input.blueprint.name,
        teamId: input.teamId,
        isActive: false,
        scheduling: { type: "on-demand" },
      };
    },
    fetchScenarioDetails: async () => {
      order.push("verify inactive");
      return {
        id: 44,
        name: `[make-fixer probe] Output probe [${operationId}]`,
        teamId: 21,
        isActive: false,
        scheduling: { type: "on-demand" },
      };
    },
    fetchBlueprint: async () => {
      order.push("fetch blueprint");
      return { blueprint };
    },
    fetchScenarioInterface: async () => {
      order.push("fetch interface");
      return { input: [], output: [{ name: "answer", type: "text" }] };
    },
    startScenario: async () => {
      order.push("start");
      return {
        id: 44, name: "probe", teamId: 21, isActive: true,
        scheduling: { type: "on-demand" },
      };
    },
    runScenario: async () => {
      order.push("run once");
      return { executionId: "exec-1", status: "RUNNING" };
    },
    fetchExecutionDetails: async () => {
      polls++;
      order.push(`poll ${polls === 1 ? "RUNNING" : "SUCCESS"}`);
      return polls === 1
        ? { status: "RUNNING" }
        : { status: "SUCCESS", outputs: { answer: "ok" } };
    },
    stopScenarioExecution: async (_scenarioId: number, executionId: string) => {
      order.push(`stop execution ${executionId}`);
    },
    listModuleLogs: async (_scenarioId: number, moduleId: number) => {
      order.push(`logs ${moduleId}`);
      return [{ moduleId, executionId: "exec-1", status: 1, bundles: 2 }];
    },
    stopScenario: async () => {
      order.push("stop scenario");
      return {
        id: 44, name: "probe", teamId: 21, isActive: false,
        scheduling: { type: "on-demand" },
      };
    },
    ...overrides,
  };
  const dependencies: ProbeDependencies = {
    client: client as any,
    ownership,
    fingerprint: async () => "fingerprint",
    randomUUID: () => operationId,
    sleep: async () => undefined,
    now: () => "2026-07-23T10:00:00.000Z",
  };
  return { order, ownership, client, dependencies };
}

function request(signal?: AbortSignal) {
  return {
    teamId: 21,
    organizationId: 9,
    baseUrl: "https://eu1.make.com",
    blueprint,
    name: "Output probe",
    data: {},
    signal,
  };
}

describe("runOwnedProbe", () => {
  test("persists each successful transition before the next mutation and returns truthful outputs", async () => {
    const h = harness();
    const result = await runOwnedProbe(h.dependencies, request());

    expect(h.order).toEqual([
      "record creating",
      "create",
      "record created",
      "fetch blueprint",
      "fetch interface",
      "record verified",
      "start",
      "record active",
      "run once",
      "record running",
      "poll RUNNING",
      "poll SUCCESS",
      "record terminal",
      "fetch blueprint",
      "logs 1",
      "stop scenario",
      "verify inactive",
      "fetch blueprint",
      "record inactive",
    ]);
    expect(result).toEqual({
      scenarioId: 44,
      executionId: "exec-1",
      executionStatus: "SUCCESS",
      outputs: { answer: "ok" },
      executionError: null,
      postRunInterfaces: [{
        moduleId: 1,
        path: "flow[0]",
        interface: [{ name: "value", type: "text" }],
      }],
      moduleLogs: [{ moduleId: 1, status: 1, bundles: 2 }],
      scenarioActive: false,
      cleanupRequired: true,
      cleanupOptions: ["keep", "delete", "revise_and_rerun"],
      userDecisionRequired: true,
    });
    expect(h.ownership.listPending()[0]).toMatchObject({
      lifecycleState: "inactive",
      executionId: "exec-1",
      lastVerifiedFingerprint: "fingerprint",
    });
  });

  test("accepts Make-normalized blueprints and stores the verified remote fingerprint", async () => {
    const h = harness();
    h.dependencies.fingerprint = async (value) => value.name;
    const result = await runOwnedProbe(h.dependencies, request());
    expect(result.executionStatus).toBe("SUCCESS");
    expect(h.ownership.listPending()[0]).toMatchObject({
      lifecycleState: "inactive",
      lastVerifiedFingerprint: "Output probe",
    });
  });

  test("generates an operation ID with the platform crypto when none is injected", async () => {
    const h = harness();
    const { randomUUID: _injected, ...dependencies } = h.dependencies;
    const result = await runOwnedProbe(dependencies, request());
    expect(result.scenarioId).toBe(44);
  });

  test("does not write ownership or compensate when creation fails", async () => {
    const h = harness({
      createScenario: async () => {
        h.order.push("create");
        throw new Error("failed");
      },
    });
    await expect(runOwnedProbe(h.dependencies, request())).rejects.toThrow();
    expect(h.order).toEqual(["record creating", "create"]);
    expect(h.ownership.listPending()).toHaveLength(0);
  });

  test("fails before creation when the initial fingerprint cannot be persisted", async () => {
    const h = harness();
    h.dependencies.fingerprint = async () => {
      throw new Error("fingerprint failed");
    };
    await expect(runOwnedProbe(h.dependencies, request())).rejects.toThrow("fingerprint failed");
    expect(h.order).not.toContain("create");
    expect(h.ownership.listPending()).toHaveLength(0);
  });

  test("uses a non-responsive single run and trusts only execution details for results", async () => {
    let body: unknown;
    let polls = 0;
    const h = harness({
      runScenario: async (_scenarioId: number, input: unknown) => {
        body = input;
        h.order.push("run once");
        return {
          executionId: "exec-1",
          status: "SUCCESS",
          outputs: { source: "untrusted immediate response" },
        };
      },
      fetchExecutionDetails: async () => {
        polls++;
        h.order.push(`poll ${polls === 1 ? "RUNNING" : "SUCCESS"}`);
        return polls === 1
          ? { status: "RUNNING" }
          : { status: "SUCCESS", outputs: { source: "execution details" } };
      },
    });
    const result = await runOwnedProbe(h.dependencies, request());
    expect(body).toEqual({ data: {}, responsive: false });
    expect(polls).toBe(2);
    expect(result.outputs).toEqual({ source: "execution details" });
    expect(h.order.indexOf("record running")).toBeLessThan(
      h.order.indexOf("poll RUNNING"),
    );
  });

  test("reconciles creation after cancellation, then records and deactivates the exact scenario", async () => {
    const controller = new AbortController();
    const h = harness({
      createScenario: async (input: any) => {
        h.order.push("create");
        expect(input.signal).toBeUndefined();
        controller.abort(new DOMException("cancelled after send", "AbortError"));
        return {
          id: 44,
          name: input.blueprint.name,
          teamId: input.teamId,
          isActive: false,
          scheduling: { type: "on-demand" },
        };
      },
      fetchScenarioInterface: async () => {
        throw controller.signal.reason;
      },
    });
    await expect(runOwnedProbe(h.dependencies, request(controller.signal)))
      .rejects.toMatchObject({
        name: "AbortError",
        result: {
          scenarioId: 44,
          scenarioActive: false,
          cleanupRequired: true,
        },
      });
    expect(h.ownership.listPending()).toMatchObject([{
      scenarioId: 44,
      lifecycleState: "inactive",
    }]);
    expect(h.order).not.toContain("stop scenario");
    expect(h.order).toContain("verify inactive");
  });

  test("does not depend on a post-create legacy put to retain cleanup ownership", async () => {
    const h = harness();
    (h.ownership as any).put = () => {
      throw new Error("post-create legacy put failed");
    };
    const result = await runOwnedProbe(h.dependencies, request());
    expect(result.scenarioId).toBe(44);
    expect(h.ownership.listPending()).toMatchObject([{
      scenarioId: 44,
      operationId,
      lifecycleState: "inactive",
    }]);
  });

  test("returns exit 5 with a retrievable operation intent if scenario assignment fails", async () => {
    const h = harness();
    h.ownership.assignProbeScenario = () => {
      throw new Error("ownership assignment failed");
    };
    await expect(runOwnedProbe(h.dependencies, request()))
      .rejects.toMatchObject({
        exitCode: 5,
        result: {
          scenarioId: 44,
          scenarioActive: false,
          cleanupRequired: true,
        },
      });
    expect(h.ownership.listProbeIntents()).toMatchObject([{
      operationId,
      teamId: 21,
      organizationId: 9,
      lifecycleState: "creating",
    }]);
  });

  test("deactivates but never runs when activation fails", async () => {
    const h = harness({
      startScenario: async () => {
        h.order.push("start");
        throw new Error("failed");
      },
    });
    try {
      await runOwnedProbe(h.dependencies, request());
      throw new Error("expected activation failure");
    } catch (error) {
      expect(error).toMatchObject({
        result: {
          scenarioId: 44,
          scenarioActive: false,
          cleanupRequired: true,
          userDecisionRequired: true,
        },
      });
    }
    expect(h.order).not.toContain("run once");
    expect(h.order).toContain("stop scenario");
    expect(h.ownership.listPending()[0]).toMatchObject({ lifecycleState: "inactive" });
  });

  test("confirms inactivity without a stop request when the probe was never started", async () => {
    const h = harness({
      stopScenario: async () => {
        h.order.push("stop scenario");
        throw new Error("Make API stop scenario error 400.");
      },
    });
    const rejection = await runOwnedProbe(h.dependencies, {
      ...request(),
      data: { unexpected: "input" },
    }).catch((error) => error);

    expect(rejection).not.toBeInstanceOf(ProbeCleanupError);
    expect(rejection).toMatchObject({
      message: "Probe input does not match the created scenario interface.",
      result: { scenarioId: 44, scenarioActive: false, userDecisionRequired: true },
    });
    expect(h.order).not.toContain("start");
    expect(h.order).not.toContain("stop scenario");
    expect(h.order).toContain("verify inactive");
    expect(h.ownership.listPending()[0]).toMatchObject({ lifecycleState: "inactive" });
  });

  test("retains an inactive owned result when remote verification fails", async () => {
    const h = harness({
      fetchScenarioInterface: async () => {
        h.order.push("fetch interface");
        throw new Error("verification failed");
      },
    });
    try {
      await runOwnedProbe(h.dependencies, request());
      throw new Error("expected verification failure");
    } catch (error) {
      expect(error).toMatchObject({
        result: {
          scenarioId: 44,
          executionId: null,
          scenarioActive: false,
          cleanupRequired: true,
          userDecisionRequired: true,
        },
      });
    }
    expect(h.order).not.toContain("start");
    expect(h.ownership.listPending()[0]).toMatchObject({ lifecycleState: "inactive" });
  });

  test("deactivates when the run fails before assigning an execution ID", async () => {
    const h = harness({
      runScenario: async () => {
        h.order.push("run once");
        throw new Error("run failed");
      },
    });
    await expect(runOwnedProbe(h.dependencies, request())).rejects.toThrow();
    expect(h.order).not.toContain("stop execution exec-1");
    expect(h.order).toContain("stop scenario");
    expect(h.ownership.listPending()[0]).toMatchObject({
      lifecycleState: "inactive",
      executionId: null,
    });
  });

  test("records and stops an execution ID assigned by a failed run response", async () => {
    const h = harness({
      runScenario: async () => {
        h.order.push("run once");
        throw new ScenarioRunRequestError("safe", "exec-assigned", 503);
      },
    });
    await expect(runOwnedProbe(h.dependencies, request())).rejects.toThrow();
    expect(h.order).toContain("record running");
    expect(h.order).toContain("stop execution exec-assigned");
    expect(h.ownership.listPending()[0]).toMatchObject({
      lifecycleState: "inactive",
      executionId: "exec-assigned",
    });
  });

  test("returns terminal execution errors and still deactivates", async () => {
    const h = harness({
      fetchExecutionDetails: async () => {
        h.order.push("poll ERROR");
        return { status: "ERROR", error: { code: "MODULE_FAILED" } };
      },
    });
    const result = await runOwnedProbe(h.dependencies, request());
    expect(result).toMatchObject({
      executionStatus: "ERROR",
      executionError: { code: "MODULE_FAILED" },
      scenarioActive: false,
    });
    expect(h.order).toContain("stop scenario");
  });

  test("cancellation stops only the recorded execution then deactivates", async () => {
    const controller = new AbortController();
    const h = harness({
      fetchExecutionDetails: async () => {
        h.order.push("poll RUNNING");
        controller.abort();
        return { status: "RUNNING" };
      },
    });
    await expect(runOwnedProbe(h.dependencies, request(controller.signal)))
      .rejects.toHaveProperty("name", "AbortError");
    expect(h.order).toContain("stop execution exec-1");
    expect(h.order).toContain("stop scenario");
  });

  test("persists an immediate execution ID before handling cancellation", async () => {
    const controller = new AbortController();
    let detailCalls = 0;
    const h = harness({
      runScenario: async () => {
        h.order.push("run once");
        controller.abort(new DOMException("cancelled after ID", "AbortError"));
        return { executionId: "exec-immediate", status: "RUNNING" };
      },
      fetchExecutionDetails: async () => {
        detailCalls++;
        return { status: "RUNNING" };
      },
    });
    await expect(runOwnedProbe(h.dependencies, request(controller.signal)))
      .rejects.toHaveProperty("name", "AbortError");
    expect(detailCalls).toBe(0);
    expect(h.order.indexOf("record running")).toBeLessThan(
      h.order.indexOf("stop execution exec-immediate"),
    );
    expect(h.ownership.listPending()[0]).toMatchObject({
      executionId: "exec-immediate",
      lifecycleState: "inactive",
    });
  });

  test("reports exact unresolved state and exit-code contract when cleanup fails", async () => {
    const h = harness({
      stopScenario: async () => {
        h.order.push("stop scenario");
        throw new Error("private detail");
      },
    });
    try {
      await runOwnedProbe(h.dependencies, request());
      throw new Error("expected cleanup failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ProbeCleanupError);
      expect((error as ProbeCleanupError).exitCode).toBe(5);
      expect((error as ProbeCleanupError).result).toMatchObject({
        scenarioId: 44,
        executionId: "exec-1",
        scenarioActive: null,
        cleanupRequired: true,
        userDecisionRequired: true,
      });
    }
    expect(h.ownership.listPending()[0]).toMatchObject({
      lifecycleState: "cleanup_failed",
      executionId: "exec-1",
    });
  });

  test("marks cleanup failed when stopping the recorded execution fails", async () => {
    const controller = new AbortController();
    const h = harness({
      fetchExecutionDetails: async () => {
        controller.abort();
        return { status: "RUNNING" };
      },
      stopScenarioExecution: async () => {
        h.order.push("stop execution exec-1");
        throw new Error("failed");
      },
    });
    await expect(runOwnedProbe(h.dependencies, request(controller.signal)))
      .rejects.toBeInstanceOf(ProbeCleanupError);
    expect(h.order).toContain("stop scenario");
    expect(h.ownership.listPending()[0]).toMatchObject({
      lifecycleState: "cleanup_failed",
      executionId: "exec-1",
    });
  });

  test("does not mutate a scenario ID already present in ownership", async () => {
    const h = harness();
    h.ownership.put({
      scenarioId: 44,
      operationId: "older",
      teamId: 21,
      organizationId: 9,
      baseUrl: "https://eu1.make.com",
      createdAt: "2026-07-22T10:00:00.000Z",
      updatedAt: "2026-07-22T10:00:00.000Z",
      lastVerifiedFingerprint: "older",
      remoteVerifiedAt: null,
      lifecycleState: "inactive",
      executionId: null,
    });
    h.order.length = 0;
    await expect(runOwnedProbe(h.dependencies, request())).rejects.toThrow("already");
    expect(h.order).toEqual(["record creating", "create"]);
    expect(h.ownership.get("https://eu1.make.com", 44)).toMatchObject({
      operationId: "older",
      lifecycleState: "inactive",
    });
  });
});
