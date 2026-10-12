import { describe, expect, test } from "bun:test";
import { cyclesFor, fetchExecutionData } from "./execution-data";
import type { ToolResult } from "./mcp-client";

const CYCLE_REMARK = "Cycle numbers could not be determined for this run, so the cycle fields are absent.";

// Shapes recorded from Make's MCP server on 2026-10-12, with values replaced.
function fakeMake(modules: any[], records: Record<string, any[]>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const callTool = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    calls.push({ name, args });
    if (name === "scenario_execution_inspect") {
      return {
        data: {
          execution: { id: "e1", status: "error", operations: 2 },
          error: { message: "[429] rate limited", moduleId: 2, moduleName: "google-email: sendAnEmail" },
          modules,
        },
        texts: [CYCLE_REMARK],
        isError: false,
      };
    }
    return {
      data: { records: records[`${args.moduleId}:${args.cycle}`] ?? [] },
      texts: [CYCLE_REMARK],
      isError: false,
    };
  };
  return { callTool, calls };
}

describe("fetchExecutionData", () => {
  test("combines inspect with each module's parsed input/output bundles", async () => {
    const make = fakeMake(
      [
        { id: 1, name: "Webhook", invocations: 1, errors: 0 },
        { id: 2, name: "Send email", invocations: 1, errors: 1 },
      ],
      {
        "1:1": [{ direction: "output", cycle: 1, operation: 1, error: false, data: ['{"email":"a@b.test"}'] }],
        "2:1": [
          { direction: "input", cycle: 1, operation: 1, error: false, data: ['{"to":["a@b.test"],"subject":"Hi"}'] },
          { direction: "output", cycle: 1, operation: 1, error: true, data: [] },
        ],
      },
    );

    const data = await fetchExecutionData(make.callTool, 7888475, "e1");

    expect(data.error).toEqual({ message: "[429] rate limited", moduleId: 2, moduleName: "google-email: sendAnEmail" });
    expect(data.modules.map((m) => m.moduleId)).toEqual([1, 2]);
    expect(data.modules[1]!.records).toEqual([
      { cycle: 1, operation: 1, direction: "input", error: false, bundles: [{ to: ["a@b.test"], subject: "Hi" }], truncated: false },
      { cycle: 1, operation: 1, direction: "output", error: true, bundles: [], truncated: false },
    ]);
    // Make's caveat is kept once, not once per call.
    expect(data.remarks).toEqual([CYCLE_REMARK]);
    expect(make.calls.map((c) => c.name)).toEqual([
      "scenario_execution_inspect",
      "scenario_execution_module_get",
      "scenario_execution_module_get",
    ]);
  });

  test("keeps truncated bundles as text and flags them", async () => {
    const make = fakeMake([{ id: 42, invocations: 1, errors: 0 }], {
      "42:1": [{ direction: "input", cycle: 1, operation: 1, error: false, data: ['{"body":"abc…[truncated]'] }],
    });
    const data = await fetchExecutionData(make.callTool, 1, "e1");
    expect(data.modules[0]!.records[0]).toMatchObject({ truncated: true, bundles: ['{"body":"abc…[truncated]'] });
  });

  test("skips modules that never ran and honors the module filter", async () => {
    const make = fakeMake(
      [{ id: 1, invocations: 0 }, { id: 2, invocations: 1 }, { id: 3, invocations: 1 }],
      {},
    );
    const data = await fetchExecutionData(make.callTool, 1, "e1", { moduleIds: [3] });
    expect(data.modules.map((m) => m.moduleId)).toEqual([1, 2, 3]);
    expect(make.calls.filter((c) => c.name === "scenario_execution_module_get").map((c) => c.args.moduleId)).toEqual([3]);
  });

  test("reads every cycle inspect reports, and only those", async () => {
    const make = fakeMake([{ id: 5, invocations: 3, cycles: [1, 2, 3] }], {});
    await fetchExecutionData(make.callTool, 1, "e1");
    expect(make.calls.slice(1).map((c) => c.args.cycle)).toEqual([1, 2, 3]);
  });
});

describe("cyclesFor", () => {
  test("defaults to cycle 1 when Make cannot determine cycles", () => {
    expect(cyclesFor({ id: 1 })).toEqual([1]);
  });

  test("merges and sorts reported cycles, ignoring counts and junk", () => {
    expect(cyclesFor({ cycles: [3, 1], errorCycles: [2, 3, 0, "x"] })).toEqual([1, 2, 3]);
    expect(cyclesFor({ errorCycles: 2 })).toEqual([1]);
  });
});
