# AI Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a conversational CLI agent (`make-fixer agent -s <id>`) that fetches a Make.com scenario, lets users edit it via natural language, and pushes changes back via API.

**Architecture:** Claude-powered multi-turn conversation loop using the Anthropic SDK's tool_use. The agent sees a blueprint summary in its system prompt, edits via structured JSON path mutations, validates before push. 4 source files: agent loop, tools, system prompt builder, blueprint editor.

**Tech Stack:** Bun, TypeScript, `@anthropic-ai/sdk` (existing), `commander` (existing)

**Reference:** Design doc at `docs/plans/2026-02-21-ai-agent-design.md`

---

### Task 1: Blueprint Editor — Path Resolution

**Files:**
- Create: `src/agent/blueprint-editor.ts`
- Test: `src/agent/blueprint-editor.test.ts`

This is the core engine. It resolves JSON paths like `flow[2].mapper.url` to actual object references and applies set/insert/remove operations.

**Step 1: Write the failing test for path resolution**

`src/agent/blueprint-editor.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { resolvePath } from "./blueprint-editor";

describe("resolvePath", () => {
  const obj = {
    name: "Test",
    flow: [
      { id: 1, module: "gateway:CustomWebHook" },
      { id: 2, module: "powerlink:plquery", mapper: { query: "{{1.phone}}" } },
      {
        id: 3,
        module: "flow:Router",
        routes: [
          { flow: [{ id: 4, module: "gmail:sendEmail" }] },
          { flow: [{ id: 5, module: "slack:sendMessage" }] },
        ],
      },
    ],
  };

  test("resolves top-level field", () => {
    const { parent, key } = resolvePath(obj, "name");
    expect(parent).toBe(obj);
    expect(key).toBe("name");
    expect(parent[key]).toBe("Test");
  });

  test("resolves array element", () => {
    const { parent, key } = resolvePath(obj, "flow[1]");
    expect(parent).toBe(obj.flow);
    expect(key).toBe(1);
    expect(parent[key].id).toBe(2);
  });

  test("resolves nested field", () => {
    const { parent, key } = resolvePath(obj, "flow[1].mapper.query");
    expect(parent).toBe(obj.flow[1].mapper);
    expect(key).toBe("query");
    expect(parent[key]).toBe("{{1.phone}}");
  });

  test("resolves through routes", () => {
    const { parent, key } = resolvePath(obj, "flow[2].routes[0].flow[0]");
    expect(parent[key].id).toBe(4);
  });

  test("throws on invalid path", () => {
    expect(() => resolvePath(obj, "flow[99].mapper")).toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/agent/blueprint-editor.test.ts`
Expected: FAIL — module not found

**Step 3: Implement resolvePath**

`src/agent/blueprint-editor.ts`:
```typescript
export interface PathResult {
  parent: any;
  key: string | number;
}

/**
 * Resolve a JSON path like "flow[2].mapper.url" to its parent object and key.
 * Returns { parent, key } so caller can read parent[key] or write parent[key] = value.
 */
export function resolvePath(obj: any, path: string): PathResult {
  const segments = parsePath(path);
  let current = obj;

  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (current == null || typeof current !== "object") {
      throw new Error(`Cannot traverse path "${path}" — hit non-object at segment "${seg}"`);
    }
    current = current[seg];
  }

  const lastSeg = segments[segments.length - 1];
  if (current == null || typeof current !== "object") {
    throw new Error(`Cannot resolve path "${path}" — parent is not an object`);
  }

  if (typeof lastSeg === "number" && Array.isArray(current) && (lastSeg < 0 || lastSeg >= current.length)) {
    throw new Error(`Array index ${lastSeg} out of bounds in path "${path}" (length: ${current.length})`);
  }
  if (typeof lastSeg === "string" && !(lastSeg in current) && !Array.isArray(current)) {
    // Allow setting new keys on objects, but not accessing missing ones for reads
    // The caller decides whether this is a set or get
  }

  return { parent: current, key: lastSeg };
}

/**
 * Parse "flow[2].mapper.url" into ["flow", 2, "mapper", "url"]
 */
export function parsePath(path: string): (string | number)[] {
  const segments: (string | number)[] = [];
  const regex = /([^.\[\]]+)|\[(\d+)\]/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(path)) !== null) {
    if (match[2] !== undefined) {
      segments.push(parseInt(match[2], 10));
    } else {
      segments.push(match[1]);
    }
  }

  if (segments.length === 0) {
    throw new Error(`Invalid path: "${path}"`);
  }

  return segments;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/agent/blueprint-editor.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/blueprint-editor.ts src/agent/blueprint-editor.test.ts
git commit -m "feat(agent): add blueprint path resolution engine"
```

---

### Task 2: Blueprint Editor — Edit Operations (set, insert, remove)

**Files:**
- Modify: `src/agent/blueprint-editor.ts`
- Modify: `src/agent/blueprint-editor.test.ts`

**Step 1: Write failing tests for edit operations**

Add to `src/agent/blueprint-editor.test.ts`:
```typescript
import { resolvePath, applyEdits, type BlueprintEdit } from "./blueprint-editor";

describe("applyEdits", () => {
  function makeBlueprint() {
    return {
      name: "Test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        { id: 2, module: "powerlink:plquery", mapper: { query: "{{1.phone}}" } },
      ],
    };
  }

  test("set: updates a field value", () => {
    const bp = makeBlueprint();
    const result = applyEdits(bp, [
      { path: "flow[1].mapper.query", action: "set", value: "{{1.email}}" },
    ]);
    expect(result.flow[1].mapper.query).toBe("{{1.email}}");
  });

  test("set: updates top-level field", () => {
    const bp = makeBlueprint();
    const result = applyEdits(bp, [
      { path: "name", action: "set", value: "New Name" },
    ]);
    expect(result.name).toBe("New Name");
  });

  test("insert: adds element to array at index", () => {
    const bp = makeBlueprint();
    const newModule = { id: 5, module: "gmail:sendEmail", mapper: {} };
    const result = applyEdits(bp, [
      { path: "flow", action: "insert", index: 1, value: newModule },
    ]);
    expect(result.flow).toHaveLength(3);
    expect(result.flow[1].id).toBe(5);
    expect(result.flow[2].id).toBe(2);
  });

  test("insert: appends when index equals array length", () => {
    const bp = makeBlueprint();
    const newModule = { id: 5, module: "gmail:sendEmail" };
    const result = applyEdits(bp, [
      { path: "flow", action: "insert", index: 2, value: newModule },
    ]);
    expect(result.flow).toHaveLength(3);
    expect(result.flow[2].id).toBe(5);
  });

  test("remove: removes element from array", () => {
    const bp = makeBlueprint();
    const result = applyEdits(bp, [
      { path: "flow[1]", action: "remove" },
    ]);
    expect(result.flow).toHaveLength(1);
    expect(result.flow[0].id).toBe(1);
  });

  test("remove: removes object field", () => {
    const bp = makeBlueprint();
    const result = applyEdits(bp, [
      { path: "flow[1].mapper", action: "remove" },
    ]);
    expect(result.flow[1].mapper).toBeUndefined();
  });

  test("multiple edits applied in order", () => {
    const bp = makeBlueprint();
    const result = applyEdits(bp, [
      { path: "name", action: "set", value: "Updated" },
      { path: "flow[1].mapper.query", action: "set", value: "new" },
    ]);
    expect(result.name).toBe("Updated");
    expect(result.flow[1].mapper.query).toBe("new");
  });

  test("throws on insert without value", () => {
    const bp = makeBlueprint();
    expect(() =>
      applyEdits(bp, [{ path: "flow", action: "insert" }])
    ).toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/agent/blueprint-editor.test.ts`
Expected: FAIL — `applyEdits` not exported

**Step 3: Implement applyEdits**

Add to `src/agent/blueprint-editor.ts`:
```typescript
export interface BlueprintEdit {
  path: string;
  action?: "set" | "insert" | "remove";
  value?: any;
  index?: number;
}

/**
 * Apply a list of edits to a deep-cloned blueprint.
 * Returns the modified blueprint (does not mutate the input).
 */
export function applyEdits<T>(obj: T, edits: BlueprintEdit[]): T {
  const clone: T = JSON.parse(JSON.stringify(obj));

  for (const edit of edits) {
    const action = edit.action ?? "set";

    if (action === "set") {
      if (edit.value === undefined) {
        throw new Error(`"set" action requires a value (path: "${edit.path}")`);
      }
      const { parent, key } = resolvePath(clone, edit.path);
      parent[key] = edit.value;
    } else if (action === "insert") {
      if (edit.value === undefined) {
        throw new Error(`"insert" action requires a value (path: "${edit.path}")`);
      }
      const { parent, key } = resolvePath(clone, edit.path);
      const arr = parent[key];
      if (!Array.isArray(arr)) {
        throw new Error(`"insert" target at "${edit.path}" is not an array`);
      }
      const idx = edit.index ?? arr.length;
      arr.splice(idx, 0, edit.value);
    } else if (action === "remove") {
      const { parent, key } = resolvePath(clone, edit.path);
      if (Array.isArray(parent) && typeof key === "number") {
        parent.splice(key, 1);
      } else {
        delete parent[key];
      }
    } else {
      throw new Error(`Unknown action: "${action}"`);
    }
  }

  return clone;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/agent/blueprint-editor.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/blueprint-editor.ts src/agent/blueprint-editor.test.ts
git commit -m "feat(agent): add blueprint edit operations (set, insert, remove)"
```

---

### Task 3: Blueprint Editor — Diff and Validation

**Files:**
- Modify: `src/agent/blueprint-editor.ts`
- Modify: `src/agent/blueprint-editor.test.ts`

**Step 1: Write failing tests for diff/validation**

Add to `src/agent/blueprint-editor.test.ts`:
```typescript
import { resolvePath, applyEdits, diffBlueprints, type BlueprintEdit, type BlueprintDiff } from "./blueprint-editor";

describe("diffBlueprints", () => {
  test("detects added modules", () => {
    const original = { name: "Test", flow: [{ id: 1, module: "a" }] };
    const modified = { name: "Test", flow: [{ id: 1, module: "a" }, { id: 2, module: "b" }] };
    const diff = diffBlueprints(original as any, modified as any);
    expect(diff.modulesAdded).toEqual([2]);
    expect(diff.modulesRemoved).toEqual([]);
    expect(diff.idsPreserved).toBe(true);
  });

  test("detects removed modules", () => {
    const original = { name: "Test", flow: [{ id: 1, module: "a" }, { id: 2, module: "b" }] };
    const modified = { name: "Test", flow: [{ id: 1, module: "a" }] };
    const diff = diffBlueprints(original as any, modified as any);
    expect(diff.modulesRemoved).toEqual([2]);
    expect(diff.idsPreserved).toBe(false);
  });

  test("detects modified modules", () => {
    const original = { name: "Test", flow: [{ id: 1, module: "a", mapper: { x: 1 } }] };
    const modified = { name: "Test", flow: [{ id: 1, module: "a", mapper: { x: 2 } }] };
    const diff = diffBlueprints(original as any, modified as any);
    expect(diff.modulesModified).toEqual([1]);
  });

  test("detects duplicate IDs", () => {
    const original = { name: "Test", flow: [{ id: 1, module: "a" }] };
    const modified = { name: "Test", flow: [{ id: 1, module: "a" }, { id: 1, module: "b" }] };
    const diff = diffBlueprints(original as any, modified as any);
    expect(diff.duplicateIds).toEqual([1]);
  });

  test("reports name change", () => {
    const original = { name: "Old", flow: [] };
    const modified = { name: "New", flow: [] };
    const diff = diffBlueprints(original as any, modified as any);
    expect(diff.nameChanged).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/agent/blueprint-editor.test.ts`
Expected: FAIL — `diffBlueprints` not exported

**Step 3: Implement diffBlueprints**

Add to `src/agent/blueprint-editor.ts`:
```typescript
import { walkModules } from "../utils/blueprint-traversal";
import type { Blueprint } from "../make-api/types";

export interface BlueprintDiff {
  modulesAdded: number[];
  modulesRemoved: number[];
  modulesModified: number[];
  duplicateIds: number[];
  idsPreserved: boolean;
  nameChanged: boolean;
}

/**
 * Compare original and modified blueprints.
 * Walks all modules (including nested routes) to detect changes.
 */
export function diffBlueprints(original: Blueprint, modified: Blueprint): BlueprintDiff {
  const origModules = walkModules(original.flow);
  const modModules = walkModules(modified.flow);

  const origIds = new Set(origModules.map((m) => m.module.id));
  const modIds = modModules.map((m) => m.module.id);
  const modIdSet = new Set(modIds);

  const modulesAdded = modIds.filter((id) => !origIds.has(id));
  const modulesRemoved = [...origIds].filter((id) => !modIdSet.has(id));

  // Detect duplicates
  const seen = new Set<number>();
  const duplicateIds: number[] = [];
  for (const id of modIds) {
    if (seen.has(id)) duplicateIds.push(id);
    seen.add(id);
  }

  // Detect modifications (same ID, different content)
  const origMap = new Map(origModules.map((m) => [m.module.id, m.module]));
  const modulesModified: number[] = [];
  for (const walked of modModules) {
    const orig = origMap.get(walked.module.id);
    if (orig && JSON.stringify(orig) !== JSON.stringify(walked.module)) {
      modulesModified.push(walked.module.id);
    }
  }

  return {
    modulesAdded: [...new Set(modulesAdded)],
    modulesRemoved,
    modulesModified,
    duplicateIds: [...new Set(duplicateIds)],
    idsPreserved: modulesRemoved.length === 0,
    nameChanged: original.name !== modified.name,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/agent/blueprint-editor.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/blueprint-editor.ts src/agent/blueprint-editor.test.ts
git commit -m "feat(agent): add blueprint diff and validation"
```

---

### Task 4: System Prompt Builder

**Files:**
- Create: `src/agent/system-prompt.ts`
- Test: `src/agent/system-prompt.test.ts`

**Step 1: Write failing test**

`src/agent/system-prompt.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "./system-prompt";
import type { Blueprint, Issue } from "../make-api/types";
import type { AnalysisResult } from "../analyzer/index";

describe("buildSystemPrompt", () => {
  test("includes role, blueprint summary, and issues", () => {
    const blueprint: Blueprint = {
      name: "Test Scenario",
      flow: [
        { id: 1, module: "gateway:CustomWebHook", metadata: { designer: { name: "Webhook" } } },
        { id: 2, module: "powerlink:plquery", onerror: [{ id: 3, module: "builtin:Break" }] },
      ],
    } as any;

    const analysis: AnalysisResult = {
      classified: [],
      issues: [
        { moduleId: 2, moduleType: "powerlink:plquery", category: "naming", severity: "warning", message: "Missing name", autoFixable: true },
      ],
      checklist: { hasErrorHandling: true, hasProperModuleNames: false, hasNotes: false },
      dataFlow: { entries: [] },
    };

    const prompt = buildSystemPrompt(blueprint, analysis, 3);
    expect(prompt).toContain("Make.com scenario editor");
    expect(prompt).toContain("Test Scenario");
    expect(prompt).toContain("#1");
    expect(prompt).toContain("#2");
    expect(prompt).toContain("gateway:CustomWebHook");
    expect(prompt).toContain("Missing name");
    expect(prompt).toContain("nextId: 4");
  });

  test("includes module names when present", () => {
    const blueprint: Blueprint = {
      name: "Test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook", metadata: { designer: { name: "My Webhook" } } },
      ],
    } as any;

    const analysis: AnalysisResult = {
      classified: [],
      issues: [],
      checklist: { hasErrorHandling: true, hasProperModuleNames: true, hasNotes: true },
      dataFlow: { entries: [] },
    };

    const prompt = buildSystemPrompt(blueprint, analysis, 1);
    expect(prompt).toContain("My Webhook");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/agent/system-prompt.test.ts`
Expected: FAIL — module not found

**Step 3: Implement buildSystemPrompt**

`src/agent/system-prompt.ts`:
```typescript
import type { Blueprint } from "../make-api/types";
import type { AnalysisResult } from "../analyzer/index";
import { walkModules } from "../utils/blueprint-traversal";
import { getModuleCustomName, hasErrorHandler } from "../utils/module-helpers";

/**
 * Build the system prompt for the agent conversation.
 * Includes role, blueprint summary, analysis results, and rules.
 */
export function buildSystemPrompt(
  blueprint: Blueprint,
  analysis: AnalysisResult,
  nextId: number
): string {
  const sections: string[] = [];

  // Role
  sections.push(`You are a Make.com scenario editor agent. You help users build, modify, and fix automation scenarios by editing their blueprint JSON.

You have tools to read the blueprint, make structured edits, run analysis, validate changes, and push to Make.com.

IMPORTANT RULES:
- Respond in the same language the user writes in.
- Always explain what you plan to change before making edits.
- Always call validate_changes before push_blueprint.
- Always ask for user confirmation before calling push_blueprint.
- New modules must use IDs starting from nextId: ${nextId}. Never reuse existing IDs.
- The idSequence field is server-managed — do not set it.
- Use your knowledge of Make.com module structures. For unfamiliar modules, infer from existing ones in the blueprint.`);

  // Blueprint summary
  const modules = walkModules(blueprint.flow);
  const moduleLines = modules.map((m) => {
    const name = getModuleCustomName(m.module);
    const errHandler = hasErrorHandler(m.module) ? "✓" : "✗";
    const nameStr = name ? ` "${name}"` : "";
    const indent = "  ".repeat(m.depth);
    return `${indent}#${m.module.id}: ${m.module.module}${nameStr} [err: ${errHandler}]`;
  });

  sections.push(`SCENARIO: "${blueprint.name}"
MODULES (${modules.length}):
${moduleLines.join("\n")}`);

  // Analysis results
  if (analysis.issues.length > 0) {
    const issueLines = analysis.issues.map((i) => {
      const modRef = i.moduleId ? `#${i.moduleId}` : "scenario";
      return `  [${i.severity}] ${modRef}: ${i.message}`;
    });
    sections.push(`CURRENT ISSUES (${analysis.issues.length}):
${issueLines.join("\n")}`);
  } else {
    sections.push("CURRENT ISSUES: None — scenario looks good!");
  }

  // Checklist
  sections.push(`CHECKLIST:
  Error Handling: ${analysis.checklist.hasErrorHandling ? "✓" : "✗"}
  Module Names: ${analysis.checklist.hasProperModuleNames ? "✓" : "✗"}
  Documentation: ${analysis.checklist.hasNotes ? "✓" : "✗"}`);

  return sections.join("\n\n");
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/agent/system-prompt.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/system-prompt.ts src/agent/system-prompt.test.ts
git commit -m "feat(agent): add system prompt builder"
```

---

### Task 5: Tool Definitions and Execution

**Files:**
- Create: `src/agent/tools.ts`
- Test: `src/agent/tools.test.ts`

This defines the Anthropic tool_use schemas and executes tool calls against the in-memory blueprint state.

**Step 1: Write failing test**

`src/agent/tools.test.ts`:
```typescript
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
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/agent/tools.test.ts`
Expected: FAIL — module not found

**Step 3: Implement tools**

`src/agent/tools.ts`:
```typescript
import type { Anthropic } from "@anthropic-ai/sdk";
import type { Blueprint, Note } from "../make-api/types";
import type { MakeApiClient } from "../make-api/client";
import { applyEdits, diffBlueprints, resolvePath } from "./blueprint-editor";
import { analyze } from "../analyzer/index";

export interface AgentState {
  original: Blueprint;
  current: Blueprint;
  notes: Note[];
  client?: MakeApiClient;
  scenarioId?: number;
}

export function createAgentState(blueprint: Blueprint, notes: Note[], client?: MakeApiClient, scenarioId?: number): AgentState {
  return {
    original: JSON.parse(JSON.stringify(blueprint)),
    current: JSON.parse(JSON.stringify(blueprint)),
    notes,
    client,
    scenarioId,
  };
}

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: "get_blueprint",
    description: "Read the current scenario blueprint JSON. Optionally pass a path to read a specific section (e.g. 'flow[2]' or 'flow[0].mapper').",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "JSON path to read. Omit to get the full blueprint.",
        },
      },
      required: [],
    },
  },
  {
    name: "edit_blueprint",
    description:
      "Apply structured edits to the blueprint. Each edit specifies a JSON path, an action (set/insert/remove), and a value. Examples: set flow[2].mapper.url to change a field, insert into flow to add a module, remove flow[3] to delete a module.",
    input_schema: {
      type: "object" as const,
      properties: {
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "JSON path, e.g. 'flow[2].mapper.url'" },
              action: { type: "string", enum: ["set", "insert", "remove"], description: "Edit action. Default: set" },
              value: { description: "Value for set/insert. Required for set and insert." },
              index: { type: "number", description: "Array index for insert. Appends if omitted." },
            },
            required: ["path"],
          },
          description: "List of edits to apply",
        },
      },
      required: ["edits"],
    },
  },
  {
    name: "run_analysis",
    description: "Run the full quality analyzer on the current blueprint. Returns issues, checklist, and data flow.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "validate_changes",
    description: "Compare the current blueprint against the original. Shows added/removed/modified modules, ID integrity, and issue count before vs after.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "push_blueprint",
    description: "Push the current blueprint to Make.com via API. IMPORTANT: Always ask the user for confirmation before calling this tool.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

export async function executeTool(
  state: AgentState,
  toolName: string,
  input: any
): Promise<string> {
  switch (toolName) {
    case "get_blueprint": {
      if (input.path) {
        const { parent, key } = resolvePath(state.current, input.path);
        return JSON.stringify(parent[key], null, 2);
      }
      return JSON.stringify(state.current, null, 2);
    }

    case "edit_blueprint": {
      try {
        state.current = applyEdits(state.current, input.edits);
        const descriptions = input.edits.map(
          (e: any) => `${e.action || "set"} ${e.path}`
        );
        return JSON.stringify({ success: true, summary: descriptions.join(", ") });
      } catch (err: any) {
        return JSON.stringify({ success: false, error: err.message });
      }
    }

    case "run_analysis": {
      const result = analyze(state.current, state.notes);
      return JSON.stringify({
        issues: result.issues,
        checklist: result.checklist,
        dataFlow: result.dataFlow.entries,
        issueCount: result.issues.length,
      }, null, 2);
    }

    case "validate_changes": {
      const diff = diffBlueprints(state.original, state.current);
      const origAnalysis = analyze(state.original, state.notes);
      const currAnalysis = analyze(state.current, state.notes);
      return JSON.stringify({
        ...diff,
        issuesBefore: origAnalysis.issues.length,
        issuesAfter: currAnalysis.issues.length,
        regressions: currAnalysis.issues.filter(
          (ci) => !origAnalysis.issues.some(
            (oi) => oi.moduleId === ci.moduleId && oi.category === ci.category && oi.message === ci.message
          )
        ),
      }, null, 2);
    }

    case "push_blueprint": {
      if (!state.client || !state.scenarioId) {
        return JSON.stringify({ success: false, error: "No API client configured (running in test mode)" });
      }
      try {
        await state.client.pushBlueprint(state.scenarioId, state.current);
        // Update original to current after successful push
        state.original = JSON.parse(JSON.stringify(state.current));
        return JSON.stringify({ success: true });
      } catch (err: any) {
        return JSON.stringify({ success: false, error: err.message });
      }
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/agent/tools.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/tools.ts src/agent/tools.test.ts
git commit -m "feat(agent): add tool definitions and execution"
```

---

### Task 6: Agent Conversation Loop

**Files:**
- Create: `src/agent/index.ts`
- Test: `src/agent/index.test.ts`

The core agent loop: sends messages to Claude, dispatches tool calls, manages conversation history, reads terminal input.

**Step 1: Write failing test**

`src/agent/index.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { buildInitialMessages, processAssistantResponse } from "./index";
import type { Blueprint } from "../make-api/types";
import type { AnalysisResult } from "../analyzer/index";

describe("buildInitialMessages", () => {
  test("returns a system prompt and empty messages array", () => {
    const blueprint: Blueprint = {
      name: "Test",
      flow: [{ id: 1, module: "gateway:CustomWebHook" }],
    } as any;
    const analysis: AnalysisResult = {
      classified: [],
      issues: [],
      checklist: { hasErrorHandling: true, hasProperModuleNames: true, hasNotes: true },
      dataFlow: { entries: [] },
    };

    const { systemPrompt, messages } = buildInitialMessages(blueprint, analysis, 1);
    expect(systemPrompt).toContain("Make.com scenario editor");
    expect(messages).toEqual([]);
  });
});

describe("processAssistantResponse", () => {
  test("extracts text from text blocks", () => {
    const content = [
      { type: "text" as const, text: "Hello, I'll help you fix this scenario." },
    ];
    const { textParts, toolCalls } = processAssistantResponse(content);
    expect(textParts).toEqual(["Hello, I'll help you fix this scenario."]);
    expect(toolCalls).toEqual([]);
  });

  test("extracts tool calls from tool_use blocks", () => {
    const content = [
      { type: "tool_use" as const, id: "call_1", name: "get_blueprint", input: {} },
      { type: "text" as const, text: "Let me check." },
    ];
    const { textParts, toolCalls } = processAssistantResponse(content);
    expect(textParts).toEqual(["Let me check."]);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("get_blueprint");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/agent/index.test.ts`
Expected: FAIL — module not found

**Step 3: Implement agent loop**

`src/agent/index.ts`:
```typescript
import Anthropic from "@anthropic-ai/sdk";
import type { Blueprint, Note } from "../make-api/types";
import type { MakeApiClient } from "../make-api/client";
import { analyze, type AnalysisResult } from "../analyzer/index";
import { buildSystemPrompt } from "./system-prompt";
import { toolDefinitions, executeTool, createAgentState, type AgentState } from "./tools";
import { getMaxModuleId } from "../utils/module-helpers";

const MODEL = "claude-haiku-4-5-20251001";

export interface AgentConfig {
  client: MakeApiClient;
  scenarioId: number;
  blueprint: Blueprint;
  notes: Note[];
}

interface ToolCall {
  id: string;
  name: string;
  input: any;
}

export function processAssistantResponse(content: Anthropic.ContentBlock[]): {
  textParts: string[];
  toolCalls: ToolCall[];
} {
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
  }

  return { textParts, toolCalls };
}

export function buildInitialMessages(
  blueprint: Blueprint,
  analysis: AnalysisResult,
  nextId: number
): { systemPrompt: string; messages: Anthropic.MessageParam[] } {
  const systemPrompt = buildSystemPrompt(blueprint, analysis, nextId);
  return { systemPrompt, messages: [] };
}

function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.once("data", (data) => {
      resolve(data.toString().trim());
    });
    process.stdin.resume();
  });
}

export async function runAgent(config: AgentConfig): Promise<void> {
  const anthropic = new Anthropic();
  const analysis = analyze(config.blueprint, config.notes);
  const nextId = getMaxModuleId(config.blueprint.flow) + 1;
  const state = createAgentState(config.blueprint, config.notes, config.client, config.scenarioId);

  const { systemPrompt, messages } = buildInitialMessages(config.blueprint, analysis, nextId);

  // Print welcome
  const moduleCount = analysis.classified.length;
  const issueCount = analysis.issues.length;
  console.log("");
  console.log("══════════════════════════════════════");
  console.log(`  Make Fixer Agent — "${config.blueprint.name}"`);
  console.log(`  Modules: ${moduleCount} | Issues: ${issueCount}`);
  console.log("══════════════════════════════════════");

  if (issueCount > 0) {
    console.log("");
    const critical = analysis.issues.filter((i) => i.severity === "critical");
    const warnings = analysis.issues.filter((i) => i.severity === "warning");
    const info = analysis.issues.filter((i) => i.severity === "info");
    if (critical.length > 0) console.log(`  ${critical.length} critical issue(s)`);
    if (warnings.length > 0) console.log(`  ${warnings.length} warning(s)`);
    if (info.length > 0) console.log(`  ${info.length} info`);
  }
  console.log("");

  // Conversation loop
  while (true) {
    const userInput = await readLine("> ");

    if (!userInput || userInput.toLowerCase() === "exit" || userInput.toLowerCase() === "quit") {
      console.log("Goodbye!");
      break;
    }

    messages.push({ role: "user", content: userInput });

    // Agent turn loop (may need multiple rounds for tool calls)
    let continueLoop = true;
    while (continueLoop) {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        tools: toolDefinitions,
        messages,
      });

      const { textParts, toolCalls } = processAssistantResponse(response.content);

      // Add assistant response to history
      messages.push({ role: "assistant", content: response.content });

      // Execute any tool calls
      if (toolCalls.length > 0) {
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const call of toolCalls) {
          // Special handling for push_blueprint — require user confirmation
          if (call.name === "push_blueprint") {
            const confirm = await readLine("Push changes to Make.com? [y/N] ");
            if (confirm.toLowerCase() !== "y") {
              toolResults.push({
                type: "tool_result",
                tool_use_id: call.id,
                content: JSON.stringify({ success: false, error: "User declined to push" }),
              });
              continue;
            }
          }

          const result = await executeTool(state, call.name, call.input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: result,
          });
        }

        messages.push({ role: "user", content: toolResults });
      }

      // Print text parts
      if (textParts.length > 0) {
        console.log("");
        console.log(textParts.join("\n"));
        console.log("");
      }

      // Continue loop if there were tool calls and stop_reason is tool_use
      continueLoop = response.stop_reason === "tool_use";
    }
  }

  process.stdin.pause();
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/agent/index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/index.ts src/agent/index.test.ts
git commit -m "feat(agent): add conversation loop with tool dispatch"
```

---

### Task 7: Wire Agent Command into CLI

**Files:**
- Modify: `src/cli.ts`

**Step 1: Write failing test**

Add to `src/cli.test.ts`:
```typescript
test("CLI has agent command", async () => {
  const proc = Bun.spawn(["bun", "src/cli.ts", "agent", "--help"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  expect(stdout).toContain("--scenario");
  expect(stdout).toContain("interactive AI agent");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/cli.test.ts`
Expected: FAIL — no `agent` command

**Step 3: Add agent command to CLI**

Add to `src/cli.ts` after the existing `fix` command block, before `program.parse()`:

```typescript
import { runAgent } from "./agent/index";

program
  .command("agent")
  .description("Start an interactive AI agent session to edit a scenario")
  .requiredOption("-s, --scenario <id>", "Make.com scenario ID", parseInt)
  .action(async (opts) => {
    const client = createClient();
    console.log(`Fetching scenario ${opts.scenario}...`);

    const { blueprint } = await client.fetchBlueprint(opts.scenario);
    const notes = await client.fetchNotes(opts.scenario);

    await runAgent({
      client,
      scenarioId: opts.scenario,
      blueprint,
      notes,
    });
  });
```

**Step 4: Run test to verify it passes**

Run: `bun test src/cli.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/cli.ts src/cli.test.ts
git commit -m "feat: wire agent command into CLI"
```

---

### Task 8: Integration Test — Full Agent Round-Trip

**Files:**
- Create: `src/agent/integration.test.ts`

End-to-end test that verifies the full pipeline: create state → edit → validate → check result. No network calls.

**Step 1: Write the test**

`src/agent/integration.test.ts`:
```typescript
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
```

**Step 2: Run the test**

Run: `bun test src/agent/integration.test.ts`
Expected: PASS (all code from previous tasks is in place)

**Step 3: Commit**

```bash
git add src/agent/integration.test.ts
git commit -m "test(agent): add integration tests for agent round-trip"
```

---

### Task 9: Run Full Test Suite and Verify

**Step 1: Run all tests**

Run: `bun test`
Expected: All tests pass — existing analyzer/fixer tests still green + all new agent tests pass.

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No TypeScript errors.

**Step 3: Manual smoke test**

Run: `bun run start agent --help`
Expected: Shows agent command help with `--scenario` option.

**Step 4: Final commit (if any typecheck fixes needed)**

```bash
git add -A
git commit -m "chore: fix any remaining type issues"
```
