import { describe, expect, test } from "bun:test";
import { checkScenarioNaming } from "./scenario-naming";
import type { Blueprint } from "../../make-api/types";

describe("checkScenarioNaming", () => {
  test("flags short, vague names", () => {
    const issues = checkScenarioNaming({ name: "Sync" } as Blueprint);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe("scenario-naming");
    expect(issues[0].autoFixable).toBe(true);
  });

  test("flags generic names", () => {
    const issues = checkScenarioNaming({ name: "Test" } as Blueprint);
    expect(issues).toHaveLength(1);
  });

  test("does NOT flag descriptive names", () => {
    const issues = checkScenarioNaming({
      name: "Order Function: (Wordpress?) -> Fireberry -> Bingo Dashboard",
    } as Blueprint);
    expect(issues).toHaveLength(0);
  });

  test("does NOT flag names with good context", () => {
    const issues = checkScenarioNaming({
      name: "New Lead from Website Form -> Create in Fireberry + Send WhatsApp Alert",
    } as Blueprint);
    expect(issues).toHaveLength(0);
  });
});
