import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerRunCommand } from "./run";
import { ScenarioRunRequestError } from "../make-api/client";

function harness(overrides: Record<string, unknown> = {}) {
  const output: unknown[] = [];
  let runCalls = 0;
  const runImplementation = typeof overrides.runScenario === "function"
    ? overrides.runScenario as (...args: any[]) => Promise<any>
    : async () => ({ executionId: "exec-123", status: "SUCCESS", outputs: { greeting: "Hello" } });
  const client = {
    fetchScenarioInterface: async () => ({
      input: [{ name: "name", type: "text", required: true }],
      output: [{ name: "greeting", type: "text" }],
    }),
    runScenario: async (...args: any[]) => {
      runCalls++;
      return runImplementation(...args);
    },
    fetchExecutionDetails: async () => ({ status: "SUCCESS", outputs: { greeting: "Hello" } }),
    getRateLimitSnapshot: () => ({
      documentedRpm: 60, effectiveRpm: 57, limitSource: "organization_api",
      requestsSent: 1, retries: 0, cooldownMs: 0,
    }),
    ...overrides,
    runScenario: async (...args: any[]) => {
      runCalls++;
      return runImplementation(...args);
    },
  };
  const program = new Command().exitOverride();
  registerRunCommand(program, {
    resolveClient: async () => client as any,
    parseScenarioInput: () => ({ scenarioId: 7, baseUrl: "https://eu1.make.com" }),
    cliVersion: "test",
    writeOutput: (value) => output.push(value),
    ownership: {
      listPending: () => [{ scenarioId: 44, lifecycleState: "inactive" }],
    } as any,
  });
  return { program, output, get runCalls() { return runCalls; } };
}

describe("run command", () => {
  test("previews validated input and never POSTs without --yes", async () => {
    const h = harness();
    await h.program.parseAsync(["run", "-s", "7", "--data", '{"name":"Ada"}'], { from: "user" });
    expect(h.runCalls).toBe(0);
    expect(h.output[0]).toMatchObject({
      ok: true,
      command: "run",
      data: { preview: true, scenarioId: 7, input: { name: "Ada" } },
      meta: { pendingCleanup: [{ scenarioId: 44, lifecycleState: "inactive" }] },
    });
  });

  test("redacts previews and outputs while sending original validated input", async () => {
    let sentData: unknown;
    const h = harness({
      fetchScenarioInterface: async () => ({
        input: [{ name: "password", type: "text", required: true }],
        output: [{ name: "apiToken", type: "text" }],
      }),
      runScenario: async (_scenarioId: number, body: { data?: object }) => {
        sentData = body.data;
        return {
          executionId: "exec-secret",
          status: "SUCCESS",
          outputs: { apiToken: "output-secret", safe: "visible" },
        };
      },
    });
    await h.program.parseAsync([
      "run", "-s", "7", "--data", '{"password":"input-secret"}', "--yes", "--wait",
    ], { from: "user" });
    expect(sentData).toEqual({ password: "input-secret" });
    expect(JSON.stringify(h.output[0])).not.toContain("input-secret");
    expect(JSON.stringify(h.output[0])).not.toContain("output-secret");
    expect(h.output[0]).toMatchObject({
      data: { outputs: { apiToken: "[REDACTED]", safe: "visible" } },
    });
  });

  test("validation failures include a sanitized copy of the live interface", async () => {
    const h = harness({
      fetchScenarioInterface: async () => ({
        input: [{
          name: "password",
          type: "text",
          required: true,
          specification: { defaultValue: "interface-secret" },
        }],
      }),
    });
    await h.program.parseAsync([
      "run", "-s", "7", "--data", "{}",
    ], { from: "user" });
    expect(JSON.stringify(h.output[0])).not.toContain("interface-secret");
    expect(h.output[0]).toMatchObject({
      ok: false,
      error: {
        issues: [{ path: "password", message: "Required input is missing." }],
        interface: {
          input: [{ name: "password", specification: { defaultValue: "[REDACTED]" } }],
        },
      },
    });
  });

  test("rejects malformed or conflicting input before any mutation", async () => {
    for (const args of [
      ["run", "-s", "7", "--data", "{"],
      ["run", "-s", "7", "--data", "{}", "--data-file", "x.json"],
      ["run", "-s", "7", "--data", '{"unknown":1}', "--yes"],
    ]) {
      const h = harness();
      await h.program.parseAsync(args, { from: "user" });
      expect(h.runCalls).toBe(0);
      expect(h.output[0]).toMatchObject({ ok: false, command: "run" });
    }
  });

  test("returns immediate execution ID and configured outputs after one POST", async () => {
    const h = harness();
    await h.program.parseAsync([
      "run", "-s", "7", "--data", '{"name":"Ada"}', "--yes", "--wait",
    ], { from: "user" });
    expect(h.runCalls).toBe(1);
    expect(h.output[0]).toMatchObject({
      ok: true,
      data: {
        scenarioId: 7,
        executionId: "exec-123",
        status: "SUCCESS",
        outputs: { greeting: "Hello" },
      },
    });
  });

  test("returns an immediate execution ID without waiting and sends one POST", async () => {
    const h = harness({
      runScenario: async () => ({ executionId: "exec-immediate", status: "RUNNING" }),
    });
    await h.program.parseAsync([
      "run", "-s", "7", "--data", '{"name":"Ada"}', "--yes",
    ], { from: "user" });
    expect(h.runCalls).toBe(1);
    expect(h.output[0]).toMatchObject({
      ok: true,
      data: { executionId: "exec-immediate", status: "RUNNING" },
    });
  });

  test("polls RUNNING to SUCCESS without resending and returns outputs", async () => {
    let polls = 0;
    const h = harness({
      runScenario: async () => ({ executionId: "exec-polled", status: "RUNNING" }),
      fetchExecutionDetails: async () => {
        polls++;
        return polls === 1
          ? { status: "RUNNING" }
          : { status: "SUCCESS", outputs: { greeting: "Finished" } };
      },
    });
    await h.program.parseAsync([
      "run", "-s", "7", "--data", '{"name":"Ada"}', "--yes", "--wait", "--timeout", "2s",
    ], { from: "user" });
    expect(h.runCalls).toBe(1);
    expect(polls).toBe(2);
    expect(h.output[0]).toMatchObject({
      ok: true,
      data: { executionId: "exec-polled", status: "SUCCESS", outputs: { greeting: "Finished" } },
    });
  });

  test("retains initial execution ID from an HTTP timeout and polls without resending", async () => {
    let polls = 0;
    const h = harness({
      runScenario: async () => {
        throw new ScenarioRunRequestError("timeout", "exec-after-timeout", 408);
      },
      fetchExecutionDetails: async () => {
        polls++;
        return { status: "SUCCESS", outputs: { greeting: "Recovered" } };
      },
    });
    await h.program.parseAsync([
      "run", "-s", "7", "--data", '{"name":"Ada"}', "--yes", "--wait", "--timeout", "2s",
    ], { from: "user" });
    expect(h.runCalls).toBe(1);
    expect(polls).toBe(1);
    expect(h.output[0]).toMatchObject({
      ok: true,
      data: {
        executionId: "exec-after-timeout",
        status: "SUCCESS",
        outputs: { greeting: "Recovered" },
      },
    });
  });

  test("retains initial execution ID on a still-running timeout and never resends", async () => {
    let polls = 0;
    const h = harness({
      runScenario: async () => ({ executionId: "exec-slow", status: "RUNNING" }),
      fetchExecutionDetails: async () => {
        polls++;
        return { status: "RUNNING" };
      },
    });
    await h.program.parseAsync([
      "run", "-s", "7", "--data", '{"name":"Ada"}', "--yes", "--wait", "--timeout", "1ms",
    ], { from: "user" });
    expect(h.runCalls).toBe(1);
    expect(polls).toBeGreaterThanOrEqual(0);
    expect(h.output[0]).toMatchObject({
      ok: false,
      command: "run",
      error: { code: "RUN_STILL_RUNNING", executionId: "exec-slow" },
    });
  });

  test("does not abort a slow responsive POST and retains its ID after the polling deadline", async () => {
    let receivedSignal: AbortSignal | undefined;
    const h = harness({
      runScenario: async (
        _scenarioId: number,
        _body: unknown,
        signal?: AbortSignal,
      ) => {
        receivedSignal = signal;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { executionId: "exec-after-deadline", status: "RUNNING" };
      },
    });
    await h.program.parseAsync([
      "run", "-s", "7", "--data", '{"name":"Ada"}', "--yes", "--wait", "--timeout", "5ms",
    ], { from: "user" });
    expect(receivedSignal?.aborted).toBe(false);
    expect(h.runCalls).toBe(1);
    expect(h.output[0]).toMatchObject({
      ok: false,
      error: {
        code: "RUN_STILL_RUNNING",
        executionId: "exec-after-deadline",
      },
    });
  });
});
