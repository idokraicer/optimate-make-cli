import { describe, expect, test } from "bun:test";
import { findWalkedModulesById, walkModules } from "./blueprint-traversal";
import { BlueprintSchema, type Blueprint, type Module } from "../make-api/types";
import fixture from "../../tests/fixtures/if-else-blueprint.json";

const makeModule = (id: number, module: string, extras: Partial<Module> = {}): Module => ({
  id,
  module,
  ...extras,
});

describe("walkModules", () => {
  test("walks flat flow", () => {
    const flow = [makeModule(1, "gateway:CustomWebHook"), makeModule(2, "monday:ListBoardItems")];
    const result = walkModules(flow);
    expect(result).toHaveLength(2);
    expect(result[0].module.id).toBe(1);
    expect(result[0].path).toBe("flow[0]");
    expect(result[1].path).toBe("flow[1]");
  });

  test("walks nested routes", () => {
    const flow = [
      makeModule(1, "gateway:CustomWebHook"),
      makeModule(2, "builtin:Router", {
        routes: [
          { flow: [makeModule(3, "monday:createItem2")] },
          { flow: [makeModule(4, "gmail:sendEmail")] },
        ],
      }),
    ];
    const result = walkModules(flow);
    expect(result).toHaveLength(4);
    expect(result.find((r) => r.module.id === 3)?.path).toBe("flow[1].routes[0].flow[0]");
    expect(result.find((r) => r.module.id === 4)?.path).toBe("flow[1].routes[1].flow[0]");
  });

  test("walks deeply nested routes", () => {
    const flow = [
      makeModule(1, "gateway:CustomWebHook"),
      makeModule(2, "builtin:Router", {
        routes: [
          {
            flow: [
              makeModule(3, "builtin:Router", {
                routes: [{ flow: [makeModule(4, "http:ActionSendData")] }],
              }),
            ],
          },
        ],
      }),
    ];
    const result = walkModules(flow);
    const deep = result.find((r) => r.module.id === 4);
    expect(deep?.path).toBe("flow[1].routes[0].flow[0].routes[0].flow[0]");
  });

  test("walks modules inside BasicIfElse branches", () => {
    const blueprint = fixture as Blueprint;
    const modules = walkModules(blueprint.flow);
    const nested = modules.find((entry) => entry.module.id === 18);
    expect(nested).toMatchObject({
      path: "flow[1].branches[0].flow[0]",
      parentModuleId: 17,
      container: "branch",
    });
  });

  test("walks nested error-handler routes", () => {
    const modules = walkModules((fixture as Blueprint).flow);
    expect(modules.find((entry) => entry.module.id === 21)).toMatchObject({
      path: "flow[1].branches[0].flow[0].onerror[0].routes[0].flow[0]",
      depth: 3,
      parentModuleId: null,
      container: "route",
    });
  });

  test("can exclude error handlers", () => {
    const modules = walkModules((fixture as Blueprint).flow, { includeErrorHandlers: false });
    expect(modules.some((entry) => entry.module.id === 21)).toBeFalse();
  });

  test("returns every duplicate module path", () => {
    const matches = findWalkedModulesById((fixture as Blueprint).flow, 18);
    expect(matches.map(({ path }) => path)).toEqual([
      "flow[1].branches[0].flow[0]",
      "flow[1].branches[0].flow[0].onerror[0].routes[0].flow[1]",
    ]);
  });

  test("validates modules nested inside branches and error handlers", () => {
    const malformed = structuredClone(fixture) as Record<string, any>;
    delete malformed.flow[1].branches[0].flow[0].onerror[0].routes[0].flow[0].module;

    expect(() => BlueprintSchema.parse(malformed)).toThrow();
  });
});
