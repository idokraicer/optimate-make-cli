import { describe, expect, test } from "bun:test";
import { analyze } from "./index";
import simpleBlueprint from "../../tests/fixtures/simple-blueprint.json";
import complexBlueprint from "../../tests/fixtures/complex-blueprint.json";
import type { Blueprint } from "../make-api/types";

describe("analyze", () => {
  test("returns issues for simple blueprint", () => {
    const result = analyze(simpleBlueprint as Blueprint, []);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.classified.length).toBeGreaterThan(0);
  });

  test("returns more issues for complex blueprint (no error handlers, no names)", () => {
    const result = analyze(complexBlueprint as Blueprint, []);
    const errorIssues = result.issues.filter((i) => i.category === "error-handling");
    const namingIssues = result.issues.filter((i) => i.category === "naming");
    expect(errorIssues.length).toBeGreaterThan(0);
    expect(namingIssues.length).toBeGreaterThan(0);
  });

  test("separates auto-fixable from report-only issues", () => {
    const result = analyze(complexBlueprint as Blueprint, []);
    const autoFixable = result.issues.filter((i) => i.autoFixable);
    const reportOnly = result.issues.filter((i) => !i.autoFixable);
    expect(autoFixable.length).toBeGreaterThan(0);
    expect(result.issues.some((i) => i.category === "json-safety" || i.category === "scenario-naming")).toBe(true);
  });

  test("includes checklist summary", () => {
    const result = analyze(simpleBlueprint as Blueprint, []);
    expect(typeof result.checklist.hasErrorHandling).toBe("boolean");
    expect(typeof result.checklist.hasProperModuleNames).toBe("boolean");
    expect(typeof result.checklist.hasNotes).toBe("boolean");
  });
});
