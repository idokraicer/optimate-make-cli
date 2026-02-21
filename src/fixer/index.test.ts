import { describe, expect, test } from "bun:test";
import { applyFixes } from "./index";
import { analyze } from "../analyzer/index";
import simpleBlueprint from "../../tests/fixtures/simple-blueprint.json";
import type { Blueprint } from "../make-api/types";

describe("applyFixes", () => {
  test("adds error handlers to modules missing them", async () => {
    const blueprint = simpleBlueprint as Blueprint;
    const { issues } = analyze(blueprint, []);
    const errorIssues = issues.filter(
      (i) => i.category === "error-handling" && i.autoFixable
    );

    const result = await applyFixes(blueprint, errorIssues, {
      skipAi: true,
      only: ["error-handling"],
    });

    const mod2 = result.fixed.flow.find((m) => m.id === 2);
    expect(mod2?.onerror).toHaveLength(1);
    expect(mod2?.onerror?.[0].module).toBe("builtin:Break");

    const mod3 = result.fixed.flow.find((m) => m.id === 3);
    expect(mod3?.onerror).toHaveLength(1);

    expect(result.changes).toHaveLength(1);
  });

  test("returns empty changes when no auto-fixable issues", async () => {
    const blueprint: Blueprint = {
      name: "Good Scenario Name: Webhook -> Fireberry -> Gmail Notification",
      flow: [
        {
          id: 1,
          module: "gateway:CustomWebHook",
          metadata: { designer: { name: "Incoming Webhook" } },
        },
        {
          id: 2,
          module: "powerlink:plquery",
          metadata: { designer: { name: "Query Contact" } },
          onerror: [{ id: 3, module: "builtin:Break", mapper: { retry: true, count: 3, interval: 60 } }],
        },
      ],
    } as any;
    const { issues } = analyze(blueprint, []);
    const autoFixable = issues.filter((i) => i.autoFixable);
    const result = await applyFixes(blueprint, autoFixable, { skipAi: true });
    expect(result.changes).toHaveLength(0);
  });
});
