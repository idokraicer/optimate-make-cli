import { describe, expect, test } from "bun:test";
import { checkDataValidation, findUnsafeWebhookVars } from "./data-validation";
import { classifyModules } from "../module-classifier";
import type { Blueprint } from "../../make-api/types";

describe("findUnsafeWebhookVars", () => {
  test("returns unsafe variable references", () => {
    const vars = findUnsafeWebhookVars({ query: "{{1.phone}}", name: "{{1.email}}" });
    expect(vars).toEqual(["1.phone", "1.email"]);
  });

  test("skips variables wrapped in ifempty", () => {
    const vars = findUnsafeWebhookVars({ query: "ifempty({{1.phone}}; 'none')" });
    expect(vars).toEqual([]);
  });

  test("returns empty for null/undefined mapper", () => {
    expect(findUnsafeWebhookVars(null)).toEqual([]);
    expect(findUnsafeWebhookVars(undefined)).toEqual([]);
  });

  test("deduplicates repeated variable references", () => {
    const vars = findUnsafeWebhookVars({ a: "{{1.phone}}", b: "{{1.phone}}" });
    expect(vars).toEqual(["1.phone"]);
  });

  test("returns mix of safe and unsafe", () => {
    const vars = findUnsafeWebhookVars({
      a: "{{1.phone}}",
      b: "ifempty({{1.email}}; '')",
      c: "{{2.name}}",
    });
    expect(vars).toEqual(["1.phone", "2.name"]);
  });
});

describe("checkDataValidation", () => {
  test("flags query modules using webhook data without validation", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        { id: 2, module: "powerlink:plquery", mapper: { query: "{{1.phone}}" } },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const issues = checkDataValidation(classified);
    expect(issues).toHaveLength(1);
    expect(issues[0].moduleId).toBe(2);
    expect(issues[0].message).toContain("{{1.phone}}");
    expect(issues[0].message).toContain("1.phone exists");
    expect(issues[0].autoFixable).toBe(true);
  });

  test("does NOT flag query modules using ifempty wrapper", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        { id: 2, module: "powerlink:plquery", mapper: { query: "ifempty({{1.phone}}; 'none')" } },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const issues = checkDataValidation(classified);
    expect(issues).toHaveLength(0);
  });

  test("shows multiple variable names in message", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        { id: 2, module: "powerlink:plquery", mapper: { a: "{{1.phone}}", b: "{{1.email}}" } },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const issues = checkDataValidation(classified);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("{{1.phone}}, {{1.email}}");
    expect(issues[0].message).toContain("1.phone exists");
    expect(issues[0].message).toContain("1.email exists");
  });
});
