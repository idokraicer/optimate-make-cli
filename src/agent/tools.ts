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

export function createAgentState(
  blueprint: Blueprint,
  notes: Note[],
  client?: MakeApiClient,
  scenarioId?: number,
): AgentState {
  return {
    original: JSON.parse(JSON.stringify(blueprint)),
    current: JSON.parse(JSON.stringify(blueprint)),
    notes,
    client,
    scenarioId,
  };
}

// Tool definitions for Anthropic's tool_use format.
// These are plain objects — do NOT import from "@anthropic-ai/sdk" here
// to keep this file testable without the SDK dependency.
export const toolDefinitions = [
  {
    name: "get_blueprint",
    description:
      "Read the current scenario blueprint JSON. Optionally pass a path to read a specific section (e.g. 'flow[2]' or 'flow[0].mapper').",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "JSON path to read. Omit to get the full blueprint.",
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
              path: {
                type: "string",
                description: "JSON path, e.g. 'flow[2].mapper.url'",
              },
              action: {
                type: "string",
                enum: ["set", "insert", "remove"],
                description: "Edit action. Default: set",
              },
              value: {
                description:
                  "Value for set/insert. Required for set and insert.",
              },
              index: {
                type: "number",
                description:
                  "Array index for insert. Appends if omitted.",
              },
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
    description:
      "Run the full quality analyzer on the current blueprint. Returns issues, checklist, and data flow.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "validate_changes",
    description:
      "Compare the current blueprint against the original. Shows added/removed/modified modules, ID integrity, and issue count before vs after.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "push_blueprint",
    description:
      "Push the current blueprint to Make.com via API. IMPORTANT: Always ask the user for confirmation before calling this tool.",
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
  input: any,
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
          (e: any) => `${e.action || "set"} ${e.path}`,
        );
        return JSON.stringify({
          success: true,
          summary: descriptions.join(", "),
        });
      } catch (err: any) {
        return JSON.stringify({ success: false, error: err.message });
      }
    }

    case "run_analysis": {
      const result = analyze(state.current, state.notes);
      return JSON.stringify(
        {
          issues: result.issues,
          checklist: result.checklist,
          dataFlow: result.dataFlow.entries,
          issueCount: result.issues.length,
        },
        null,
        2,
      );
    }

    case "validate_changes": {
      const diff = diffBlueprints(state.original, state.current);
      const origAnalysis = analyze(state.original, state.notes);
      const currAnalysis = analyze(state.current, state.notes);
      return JSON.stringify(
        {
          ...diff,
          issuesBefore: origAnalysis.issues.length,
          issuesAfter: currAnalysis.issues.length,
          regressions: currAnalysis.issues.filter(
            (ci) =>
              !origAnalysis.issues.some(
                (oi) =>
                  oi.moduleId === ci.moduleId &&
                  oi.category === ci.category &&
                  oi.message === ci.message,
              ),
          ),
        },
        null,
        2,
      );
    }

    case "push_blueprint": {
      if (!state.client || !state.scenarioId) {
        return JSON.stringify({
          success: false,
          error: "No API client configured (running in test mode)",
        });
      }
      try {
        await state.client.pushBlueprint(state.scenarioId, state.current);
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
