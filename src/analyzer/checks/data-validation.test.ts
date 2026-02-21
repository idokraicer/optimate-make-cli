import { describe, expect, test } from "bun:test";
import { checkDataValidation } from "./data-validation";
import { classifyModules } from "../module-classifier";
import type { Blueprint } from "../../make-api/types";

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
});
