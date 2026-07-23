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

  test("adds existence filter for data-validation issues", async () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        { id: 2, module: "powerlink:plquery", mapper: { query: "{{1.phone}}" }, onerror: [{ id: 3, module: "builtin:Break" }] },
      ],
    } as any;
    const { issues } = analyze(blueprint, []);
    const dataIssues = issues.filter(
      (i) => i.category === "data-validation" && i.autoFixable
    );
    expect(dataIssues).toHaveLength(1);

    const result = await applyFixes(blueprint, dataIssues, {
      skipAi: true,
      only: ["data-validation"],
    });

    const mod2 = result.fixed.flow.find((m) => m.id === 2);
    expect(mod2?.filter).toBeDefined();
    expect(mod2?.filter?.conditions[0]).toEqual([
      { a: "{{1.phone}}", o: "exist" },
    ]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].type).toBe("data-validation");
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

  test("applies naming fixes inside branches and error-handler routes", async () => {
    const blueprint = {
      name: "test",
      flow: [
        {
          id: 17,
          module: "builtin:BasicIfElse",
          branches: [
            { flow: [{ id: 18, module: "http:ActionSendData" }] },
          ],
        },
        {
          id: 19,
          module: "http:ActionSendData",
          onerror: [
            {
              id: null,
              module: "builtin:Router",
              routes: [{ flow: [{ id: 21, module: "http:ActionSendData" }] }],
            },
          ],
        },
      ],
    } as Blueprint;
    const issues = [
      { moduleId: 18, moduleType: "http:ActionSendData", category: "naming", severity: "warning", message: "", autoFixable: true },
      { moduleId: 21, moduleType: "http:ActionSendData", category: "naming", severity: "warning", message: "", autoFixable: true },
    ] as any;

    const result = await applyFixes(blueprint, issues, { skipAi: true, only: ["naming"] });

    expect(result.fixed.flow[0].branches?.[0].flow?.[0].metadata?.designer?.name).toBe(
      "http:ActionSendData (auto-named)",
    );
    expect(result.fixed.flow[1].onerror?.[0].routes?.[0].flow?.[0].metadata?.designer?.name).toBe(
      "http:ActionSendData (auto-named)",
    );
    expect(result.changes.map(({ moduleId }) => moduleId)).toEqual([18, 21]);
  });
});
