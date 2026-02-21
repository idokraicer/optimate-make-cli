import { describe, expect, test } from "bun:test";
import { toolDefinitions, executeTool, createAgentState } from "./tools";
import type { Blueprint } from "../make-api/types";

describe("toolDefinitions", () => {
  test("exports all 5 tool definitions", () => {
    expect(toolDefinitions).toHaveLength(5);
    const names = toolDefinitions.map((t) => t.name);
    expect(names).toContain("get_blueprint");
    expect(names).toContain("edit_blueprint");
    expect(names).toContain("run_analysis");
    expect(names).toContain("validate_changes");
    expect(names).toContain("push_blueprint");
  });

  test("each tool has name, description, and input_schema", () => {
    for (const tool of toolDefinitions) {
      expect(tool.name).toBeDefined();
      expect(tool.description).toBeDefined();
      expect(tool.input_schema).toBeDefined();
    }
  });
});

describe("executeTool", () => {
  const blueprint: Blueprint = {
    name: "Test",
    flow: [
      { id: 1, module: "gateway:CustomWebHook" },
      { id: 2, module: "powerlink:plquery", mapper: { query: "{{1.phone}}" } },
    ],
  } as any;

  test("get_blueprint: returns full blueprint", async () => {
    const state = createAgentState(blueprint, []);
    const result = await executeTool(state, "get_blueprint", {});
    const parsed = JSON.parse(result);
    expect(parsed.name).toBe("Test");
    expect(parsed.flow).toHaveLength(2);
  });

  test("get_blueprint: returns section by path", async () => {
    const state = createAgentState(blueprint, []);
    const result = await executeTool(state, "get_blueprint", { path: "flow[1].mapper" });
    const parsed = JSON.parse(result);
    expect(parsed.query).toBe("{{1.phone}}");
  });

  test("edit_blueprint: applies edits", async () => {
    const state = createAgentState(blueprint, []);
    const result = await executeTool(state, "edit_blueprint", {
      edits: [{ path: "name", action: "set", value: "Updated" }],
    });
    expect(result).toContain("success");
    expect(state.current.name).toBe("Updated");
  });

  test("run_analysis: returns issues", async () => {
    const state = createAgentState(blueprint, []);
    const result = await executeTool(state, "run_analysis", {});
    const parsed = JSON.parse(result);
    expect(parsed.issues).toBeDefined();
    expect(parsed.checklist).toBeDefined();
  });

  test("validate_changes: detects modifications", async () => {
    const state = createAgentState(blueprint, []);
    await executeTool(state, "edit_blueprint", {
      edits: [{ path: "name", action: "set", value: "Changed" }],
    });
    const result = await executeTool(state, "validate_changes", {});
    const parsed = JSON.parse(result);
    expect(parsed.nameChanged).toBe(true);
    expect(parsed.idsPreserved).toBe(true);
  });

  test("push_blueprint: fails without client", async () => {
    const state = createAgentState(blueprint, []);
    const result = await executeTool(state, "push_blueprint", {});
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("No API client");
  });

  test("unknown tool: returns error", async () => {
    const state = createAgentState(blueprint, []);
    const result = await executeTool(state, "nonexistent_tool", {});
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("Unknown tool");
  });
});
