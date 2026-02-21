import { describe, expect, test } from "bun:test";
import { checkErrorHandling } from "./error-handling";
import { classifyModules } from "../module-classifier";
import simpleBlueprint from "../../../tests/fixtures/simple-blueprint.json";
import complexBlueprint from "../../../tests/fixtures/complex-blueprint.json";
import type { Blueprint } from "../../make-api/types";

describe("checkErrorHandling", () => {
  test("flags API modules without error handlers", () => {
    const classified = classifyModules(simpleBlueprint as Blueprint);
    const issues = checkErrorHandling(classified);
    // Module 2 (powerlink:plquery) has onerror: null → should be flagged
    // Module 3 (powerlink:updateObject) has onerror with Break → should NOT be flagged
    expect(issues).toHaveLength(1);
    expect(issues[0].moduleId).toBe(2);
    expect(issues[0].category).toBe("error-handling");
    expect(issues[0].autoFixable).toBe(true);
  });

  test("does NOT flag trigger module", () => {
    const classified = classifyModules(simpleBlueprint as Blueprint);
    const issues = checkErrorHandling(classified);
    const triggerIssue = issues.find((i) => i.moduleId === 1);
    expect(triggerIssue).toBeUndefined();
  });

  test("flags multiple modules in complex blueprint", () => {
    const classified = classifyModules(complexBlueprint as Blueprint);
    const issues = checkErrorHandling(classified);
    // Modules 5, 6, 7, 8 all have onerror: null
    expect(issues).toHaveLength(4);
    const ids = issues.map((i) => i.moduleId).sort();
    expect(ids).toEqual([5, 6, 7, 8]);
  });
});
