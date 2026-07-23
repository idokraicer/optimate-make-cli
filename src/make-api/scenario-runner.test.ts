import { describe, expect, test } from "bun:test";
import {
  parseRunTimeout,
  pollScenarioExecution,
  validateScenarioInput,
  type ScenarioInterface,
} from "./scenario-runner";

const spec: ScenarioInterface = {
  input: [
    { name: "title", type: "text", required: true },
    { name: "count", type: "number", required: true },
    { name: "enabled", type: "boolean" },
    {
      name: "customer",
      type: "collection",
      required: true,
      specification: [
        { name: "email", type: "text", required: true },
        { name: "age", type: "number" },
      ],
    },
    {
      name: "items",
      type: "array",
      specification: {
        type: "collection",
        specification: [{ name: "sku", type: "text", required: true }],
      },
    },
  ],
};

describe("scenario input validation", () => {
  test("accepts and normalizes supported scalar, collection, and array input", () => {
    expect(validateScenarioInput(spec, {
      title: "Order",
      count: 2,
      enabled: false,
      customer: { email: "a@example.com", age: 42 },
      items: [{ sku: "A" }, { sku: "B" }],
    })).toEqual({
      valid: true,
      normalized: {
        title: "Order",
        count: 2,
        enabled: false,
        customer: { email: "a@example.com", age: 42 },
        items: [{ sku: "A" }, { sku: "B" }],
      },
    });
  });

  test("reports required, type, nested, array, and unknown-name issues by path", () => {
    const result = validateScenarioInput(spec, {
      count: "2",
      customer: { email: 7, extra: true },
      items: [{ nope: "A" }],
      surprise: true,
    });
    expect(result).toEqual({
      valid: false,
      issues: [
        { path: "title", message: "Required input is missing." },
        { path: "count", message: "Expected number." },
        { path: "customer.email", message: "Expected text." },
        { path: "customer.extra", message: "Unknown input field." },
        { path: "items[0].sku", message: "Required input is missing." },
        { path: "items[0].nope", message: "Unknown input field." },
        { path: "surprise", message: "Unknown input field." },
      ],
    });
  });

  test("rejects non-object data and all input for no-input scenarios", () => {
    expect(validateScenarioInput(spec, [])).toMatchObject({ valid: false });
    expect(validateScenarioInput({}, {})).toEqual({ valid: true, normalized: {} });
    expect(validateScenarioInput({}, { anything: 1 })).toEqual({
      valid: false,
      issues: [{ path: "anything", message: "Unknown input field." }],
    });
  });

  test("parses positive CLI timeout durations", () => {
    expect(parseRunTimeout("30s")).toBe(30_000);
    expect(parseRunTimeout("2m")).toBe(120_000);
    expect(() => parseRunTimeout("0s")).toThrow("--timeout");
    expect(() => parseRunTimeout("forever")).toThrow("--timeout");
  });
});

describe("execution polling", () => {
  test("polls running through success and returns configured outputs", async () => {
    const delays: number[] = [];
    const responses = [
      { status: "RUNNING" as const },
      { status: "SUCCESS" as const, outputs: { result: 42 } },
    ];
    const result = await pollScenarioExecution({
      scenarioId: 1,
      executionId: "exec-1",
      timeoutMs: 60_000,
      fetchExecutionDetails: async () => responses.shift()!,
      sleep: async (ms) => { delays.push(ms); },
      now: (() => {
        let now = 0;
        return () => now += 100;
      })(),
    });
    expect(result).toEqual({ status: "SUCCESS", outputs: { result: 42 } });
    expect(delays).toEqual([250]);
  });

  test("uses bounded exponential delays and retains execution ID on timeout", async () => {
    const delays: number[] = [];
    let now = 0;
    const result = await pollScenarioExecution({
      scenarioId: 1,
      executionId: "exec-timeout",
      timeoutMs: 20_000,
      fetchExecutionDetails: async () => ({ status: "RUNNING" }),
      sleep: async (ms) => { delays.push(ms); now += ms; },
      now: () => now,
    });
    expect(result).toEqual({
      status: "RUNNING",
      code: "RUN_STILL_RUNNING",
      executionId: "exec-timeout",
    });
    expect(Math.max(...delays)).toBeLessThanOrEqual(5_000);
  });

  test("supports cancellation without issuing another status request", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(pollScenarioExecution({
      scenarioId: 1,
      executionId: "exec-cancel",
      timeoutMs: 1_000,
      signal: controller.signal,
      fetchExecutionDetails: async () => {
        calls++;
        return { status: "RUNNING" };
      },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
  });
});
