import { describe, expect, test } from "bun:test";
import fixture from "../../tests/fixtures/if-else-blueprint.json";
import type { Blueprint } from "../make-api/types";
import { inspectBlueprint } from "./inspect";

function blueprintWithInspectableModule(): Blueprint {
  const blueprint = structuredClone(fixture) as Blueprint;
  const module = blueprint.flow[1].branches?.[0].flow?.[0];
  if (!module) throw new Error("Fixture is missing module 18");

  const errorRoute = module.onerror?.[0].routes?.[0].flow;
  if (!errorRoute) throw new Error("Fixture is missing the nested error route");
  errorRoute[1].id = 22;

  module.mapper = { url: "https://example.test", body: "{{1.value}}" };
  module.parameters = { handleErrors: true };
  module.metadata = {
    ...module.metadata,
    designer: { name: "Send customer update" },
    restore: {
      expect: {
        boardId: { label: "Customers" },
        nested: {
          field: { name: "status", label: "Status" },
        },
      },
    },
  };

  return blueprint;
}

describe("inspectBlueprint", () => {
  test("returns the exact nested module configuration and provenance", () => {
    const result = inspectBlueprint(blueprintWithInspectableModule(), 6648651, {
      moduleId: 18,
      source: "local",
    });

    expect(result).toEqual({
      scenarioId: 6648651,
      source: "local",
      module: {
        id: 18,
        path: "flow[1].branches[0].flow[0]",
        type: "http:ActionSendData",
        name: "Send customer update",
        container: "branch",
        parentModuleId: 17,
        mapper: { url: "https://example.test", body: "{{1.value}}" },
        parameters: { handleErrors: true },
        resolvedLabels: {
          boardId: "Customers",
          status: "Status",
        },
      },
    });
  });

  test("summarizes every nested and error-handler module for safe ID allocation", () => {
    const result = inspectBlueprint(fixture as Blueprint, 6648651, {
      summary: true,
      source: "remote",
    });

    expect(result).toMatchObject({
      scenarioId: 6648651,
      source: "remote",
      summary: {
        name: "Nested If/Else error handler",
        moduleCount: 6,
        maxModuleId: 21,
        nextModuleId: 22,
        trigger: {
          id: 1,
          path: "flow[0]",
          type: "gateway:CustomWebHook",
        },
        containerCounts: {
          flow: 2,
          branch: 1,
          onerror: 1,
          route: 2,
        },
      },
    });
    expect(result.summary.modules).toContainEqual({
      id: 21,
      path: "flow[1].branches[0].flow[0].onerror[0].routes[0].flow[0]",
      type: "builtin:Ignore",
      name: null,
      container: "route",
      parentModuleId: null,
    });
  });

  test("rejects duplicate module IDs with every conflicting path", () => {
    const duplicate = blueprintWithInspectableModule();
    const errorRoute = duplicate.flow[1].branches?.[0].flow?.[0].onerror?.[0].routes?.[0].flow;
    if (!errorRoute) throw new Error("Fixture is missing the nested error route");
    errorRoute[1].id = 18;

    expect(() => inspectBlueprint(duplicate, 6648651, {
      moduleId: 18,
      source: "remote",
    })).toThrow(
      "Module #18 is ambiguous at paths: flow[1].branches[0].flow[0], flow[1].branches[0].flow[0].onerror[0].routes[0].flow[1]",
    );
  });
});
