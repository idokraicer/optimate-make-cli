import { describe, expect, test } from "bun:test";
import { walkModules } from "./blueprint-traversal";
import type { Module } from "../make-api/types";

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
});
