import { describe, expect, test } from "bun:test";
import { checkErrorHandling, describeErrorHandler } from "./error-handling";
import { classifyModules } from "../module-classifier";
import simpleBlueprint from "../../../tests/fixtures/simple-blueprint.json";
import complexBlueprint from "../../../tests/fixtures/complex-blueprint.json";
import type { Blueprint, ErrorHandler } from "../../make-api/types";

describe("checkErrorHandling", () => {
  test("flags API modules without error handlers", () => {
    const classified = classifyModules(simpleBlueprint as Blueprint);
    const issues = checkErrorHandling(classified);
    // Module 2 (powerlink:plquery) has onerror: null → should be flagged as warning
    // Module 3 (powerlink:updateObject) has onerror with Break → should emit info
    const warnings = issues.filter((i) => i.severity === "warning");
    const infos = issues.filter((i) => i.severity === "info");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].moduleId).toBe(2);
    expect(warnings[0].category).toBe("error-handling");
    expect(warnings[0].autoFixable).toBe(true);
    expect(infos).toHaveLength(1);
    expect(infos[0].moduleId).toBe(3);
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
    // Modules 5, 6, 7, 8 all have onerror: null → warnings
    const warnings = issues.filter((i) => i.severity === "warning");
    expect(warnings).toHaveLength(4);
    const ids = warnings.map((i) => i.moduleId).sort();
    expect(ids).toEqual([5, 6, 7, 8]);
  });

  test("emits info issue describing Break handler with retry", () => {
    const classified = classifyModules(simpleBlueprint as Blueprint);
    const issues = checkErrorHandling(classified);
    const info = issues.find((i) => i.moduleId === 3 && i.severity === "info");
    expect(info).toBeDefined();
    expect(info!.message).toContain("Break (retry=3, interval=1h)");
  });
});

describe("describeErrorHandler", () => {
  test("describes Break without retry", () => {
    const handlers: ErrorHandler[] = [
      { id: 10, module: "builtin:Break", mapper: {} },
    ];
    expect(describeErrorHandler(handlers)).toBe("Break (retry=3, interval=15m)");
  });

  test("describes Break with retry", () => {
    const handlers: ErrorHandler[] = [
      { id: 10, module: "builtin:Break", mapper: { retry: true, count: 5, interval: 120 } },
    ];
    expect(describeErrorHandler(handlers)).toBe("Break (retry=5, interval=2h)");
  });

  test("describes Resume and Ignore", () => {
    expect(describeErrorHandler([{ id: 1, module: "builtin:Resume" }])).toBe("Resume");
    expect(describeErrorHandler([{ id: 1, module: "builtin:Ignore" }])).toBe("Ignore");
  });

  test("describes Router with nested flow", () => {
    const handlers: ErrorHandler[] = [
      {
        id: 10,
        module: "builtin:BasicRouter",
        routes: [
          {
            flow: [
              { id: 11, module: "util:FunctionSleep", mapper: { duration: 45 } },
              { id: 12, module: "powerlink:plquery" },
              { id: 13, module: "builtin:Break", mapper: { retry: true, count: 3, interval: 60 } },
            ],
          },
        ],
      },
    ];
    expect(describeErrorHandler(handlers)).toBe(
      "Router [Sleep(45s) → Fireberry - שליפת נתונים → Break (retry=3, interval=1h)]"
    );
  });

  test("describes Sleep with hours", () => {
    const handlers: ErrorHandler[] = [
      { id: 10, module: "util:FunctionSleep", mapper: { duration: 3600 } },
    ];
    expect(describeErrorHandler(handlers)).toBe("Sleep(1h)");
  });

  test("uses custom name for unknown modules", () => {
    const handlers: ErrorHandler[] = [
      { id: 10, module: "custom:Something", metadata: { designer: { name: "My Handler" } } },
    ];
    expect(describeErrorHandler(handlers)).toBe("My Handler");
  });
});
