import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "./system-prompt";
import type { Blueprint } from "../make-api/types";
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

    const prompt = buildSystemPrompt(blueprint, analysis, 4);
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
