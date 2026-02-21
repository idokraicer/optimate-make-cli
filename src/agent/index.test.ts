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
