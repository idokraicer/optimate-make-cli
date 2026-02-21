import { describe, expect, test } from "bun:test";
import { createAgentState, executeTool } from "./tools";
import type { Blueprint } from "../make-api/types";

describe("Agent integration (no network)", () => {
  const blueprint: Blueprint = {
    name: "Test Scenario",
    flow: [
      { id: 1, module: "gateway:CustomWebHook", metadata: { designer: { x: 0, y: 0 } } },
      {
        id: 2,
        module: "powerlink:plquery",
        mapper: { query: "{{1.phone}}" },
        metadata: { designer: { x: 300, y: 0 } },
        onerror: null,
      },
      {
        id: 3,
        module: "powerlink:updateObject",
        mapper: {},
        metadata: { designer: { x: 600, y: 0, name: "Update Contact" } },
        onerror: [{ id: 4, module: "builtin:Break", mapper: { retry: true, count: 3, interval: 60 } }],
      },
    ],
    metadata: { instant: true },
    scheduling: { type: "immediately" },
  } as any;

  test("edit → validate round trip: rename scenario", async () => {
    const state = createAgentState(blueprint, []);
    await executeTool(state, "edit_blueprint", {
      edits: [{ path: "name", action: "set", value: "Webhook: Query & Update Contact" }],
    });

    const validation = JSON.parse(await executeTool(state, "validate_changes", {}));
    expect(validation.nameChanged).toBe(true);
    expect(validation.idsPreserved).toBe(true);
    expect(validation.modulesRemoved).toEqual([]);
    expect(state.current.name).toBe("Webhook: Query & Update Contact");
  });

  test("edit → validate round trip: add error handler", async () => {
    const state = createAgentState(blueprint, []);
    await executeTool(state, "edit_blueprint", {
      edits: [{
        path: "flow[1].onerror",
        action: "set",
        value: [{ id: 5, module: "builtin:Break", version: 1, mapper: { retry: true, count: 3, interval: 60 } }],
      }],
    });

    const validation = JSON.parse(await executeTool(state, "validate_changes", {}));
    expect(validation.idsPreserved).toBe(true);
    expect(validation.modulesModified).toContain(2);
  });

  test("edit → validate round trip: add new module", async () => {
    const state = createAgentState(blueprint, []);
    const newModule = {
      id: 5,
      module: "gmail:sendEmail",
      version: 1,
      mapper: { to: "admin@example.com", subject: "New lead" },
      metadata: { designer: { x: 900, y: 0, name: "Notify Admin" } },
      onerror: [{ id: 6, module: "builtin:Break", mapper: { retry: true, count: 3, interval: 60 } }],
    };

    await executeTool(state, "edit_blueprint", {
      edits: [{ path: "flow", action: "insert", index: 3, value: newModule }],
    });

    expect(state.current.flow).toHaveLength(4);
    expect(state.current.flow[3].id).toBe(5);

    const validation = JSON.parse(await executeTool(state, "validate_changes", {}));
    expect(validation.modulesAdded).toContain(5);
    expect(validation.idsPreserved).toBe(true);
  });

  test("edit → validate round trip: remove module", async () => {
    const state = createAgentState(blueprint, []);
    await executeTool(state, "edit_blueprint", {
      edits: [{ path: "flow[2]", action: "remove" }],
    });

    expect(state.current.flow).toHaveLength(2);
    const validation = JSON.parse(await executeTool(state, "validate_changes", {}));
    expect(validation.modulesRemoved).toContain(3);
    expect(validation.idsPreserved).toBe(false);
  });

  test("push_blueprint fails gracefully without API client", async () => {
    const state = createAgentState(blueprint, []);
    const result = JSON.parse(await executeTool(state, "push_blueprint", {}));
    expect(result.success).toBe(false);
    expect(result.error).toContain("No API client");
  });
});
