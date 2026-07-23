import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compactExecution,
  parseDuration,
  parseExecutionTimestamp,
  resolveExecutionTimeWindow,
  selectWebhookInputLog,
  writeJsonOutput,
} from "./execution-query";

describe("parseDuration", () => {
  test("supports agent-friendly duration units", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("15m")).toBe(15 * 60_000);
    expect(parseDuration("2h")).toBe(2 * 3_600_000);
    expect(parseDuration("7d")).toBe(7 * 86_400_000);
    expect(parseDuration("2w")).toBe(14 * 86_400_000);
    expect(parseDuration("1mo")).toBe(30 * 86_400_000);
  });

  test("rejects zero, malformed, and unsafe durations", () => {
    expect(parseDuration("0h")).toBeNull();
    expect(parseDuration("yesterday")).toBeNull();
    expect(parseDuration("999999999999999999d")).toBeNull();
  });
});

describe("parseExecutionTimestamp", () => {
  test("accepts epoch milliseconds and ISO 8601 dates", () => {
    expect(parseExecutionTimestamp("1784102400000")).toBe("1784102400000");
    expect(parseExecutionTimestamp("2026-07-15T10:30:00+03:00")).toBe("1784100600000");
    expect(parseExecutionTimestamp("2026-07-15")).toBe("1784073600000");
  });

  test("rejects invalid or ambiguous timestamps", () => {
    expect(() => parseExecutionTimestamp("15/07/2026 10:30")).toThrow("ISO 8601");
    expect(() => parseExecutionTimestamp("123")).toThrow("epoch milliseconds");
    expect(() => parseExecutionTimestamp("2026-02-30")).toThrow("ISO 8601");
  });
});

describe("resolveExecutionTimeWindow", () => {
  test("turns --since into a stable from timestamp", () => {
    expect(resolveExecutionTimeWindow({ since: "2h" }, 1784102400000)).toEqual({
      from: "1784095200000",
      to: undefined,
    });
  });

  test("normalizes explicit from and to values", () => {
    expect(resolveExecutionTimeWindow({
      from: "2026-07-15T00:00:00Z",
      to: "2026-07-15T01:00:00Z",
    })).toEqual({
      from: "1784073600000",
      to: "1784077200000",
    });
  });

  test("rejects conflicting and reversed windows", () => {
    expect(() => resolveExecutionTimeWindow({ since: "1h", from: "1784102400000" }))
      .toThrow("cannot be combined");
    expect(() => resolveExecutionTimeWindow({ from: "1784102400000", to: "1784095200000" }))
      .toThrow("must be before");
  });
});

describe("compactExecution", () => {
  test("returns stable token-efficient fields for agents", () => {
    expect(compactExecution({
      id: "raw-execution-id",
      imtId: "abc",
      status: 2,
      timestamp: "2026-07-15T10:30:00.000Z",
      operations: 4,
      duration: 512,
      executionName: "Inbound lead",
      largePayload: { ignored: true },
    })).toEqual({
      id: "raw-execution-id",
      imtId: "abc",
      status: 2,
      statusLabel: "failed",
      timestamp: "2026-07-15T10:30:00.000Z",
      operations: 4,
      durationMs: 512,
      name: "Inbound lead",
    });
  });
});

describe("selectWebhookInputLog", () => {
  const executionTimestamp = "2026-07-15T10:30:00.000Z";

  test("selects the only webhook log close to the execution timestamp", () => {
    expect(selectWebhookInputLog([
      { id: "hook-log-1", loggedAt: "2026-07-15T10:30:04.500Z" },
      { id: "too-old", loggedAt: "2026-07-15T10:20:00.000Z" },
    ], executionTimestamp)).toEqual({
      match: { id: "hook-log-1", loggedAt: "2026-07-15T10:30:04.500Z" },
      differenceMs: 4_500,
      reason: null,
      candidateLogIds: ["hook-log-1"],
    });
  });

  test("does not match a webhook log outside the safe time window", () => {
    expect(selectWebhookInputLog([
      { id: "far-away", loggedAt: "2026-07-15T10:33:00.001Z" },
    ], executionTimestamp)).toEqual({
      match: null,
      differenceMs: null,
      reason: "not_found",
      candidateLogIds: [],
    });
  });

  test("does not attach input when two webhook logs are similarly close", () => {
    expect(selectWebhookInputLog([
      { id: "candidate-a", loggedAt: "2026-07-15T10:30:04.500Z" },
      { id: "candidate-b", loggedAt: "2026-07-15T10:30:05.000Z" },
    ], executionTimestamp)).toEqual({
      match: null,
      differenceMs: null,
      reason: "ambiguous",
      candidateLogIds: ["candidate-a", "candidate-b"],
    });
  });
});

describe("writeJsonOutput", () => {
  test("returns stdout JSON and writes the identical payload to a nested file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "make-fixer-executions-"));
    const outputPath = join(directory, "artifacts", "runs.json");

    try {
      const stdout = await writeJsonOutput({ executions: [{ id: "abc" }] }, outputPath);
      expect(JSON.parse(stdout)).toEqual({ executions: [{ id: "abc" }] });
      expect(await readFile(outputPath, "utf8")).toBe(stdout + "\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
