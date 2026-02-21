import { describe, expect, test } from "bun:test";
import { formatReport } from "./index";
import type { Issue } from "../make-api/types";
import type { FixChange } from "../fixer/index";

describe("formatReport", () => {
  test("formats auto-fixed changes", () => {
    const changes: FixChange[] = [
      { type: "error-handler", moduleId: 5, description: "Added Break error handler to module 5" },
    ];
    const report = formatReport(changes, [], { hasErrorHandling: true, hasProperModuleNames: true, hasNotes: true });
    expect(report).toContain("module 5");
  });

  test("formats report-only issues", () => {
    const issues: Issue[] = [
      {
        moduleId: 8,
        moduleType: "http:ActionSendData",
        category: "security",
        severity: "critical",
        message: "API key exposed",
        autoFixable: false,
      },
    ];
    const report = formatReport([], issues, { hasErrorHandling: true, hasProperModuleNames: true, hasNotes: true });
    expect(report).toContain("API key exposed");
  });

  test("shows clean report when no issues", () => {
    const report = formatReport([], [], { hasErrorHandling: true, hasProperModuleNames: true, hasNotes: true });
    expect(report).toContain("No issues");
  });
});
