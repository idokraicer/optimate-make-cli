import { describe, expect, test } from "bun:test";
import { checkHardcodedData } from "./hardcoded";
import { classifyModules } from "../module-classifier";
import type { Blueprint } from "../../make-api/types";

describe("checkHardcodedData", () => {
  test("flags long hardcoded lists in filters", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        {
          id: 2,
          module: "builtin:Router",
          routes: [
            {
              flow: [
                {
                  id: 3,
                  module: "powerlink:plquery",
                  filter: {
                    name: "Phone filter",
                    conditions: [[{
                      a: '{{contains(split("0547803904,0546210188,0526212469,0541234567,0552345678,0561234567,0571234567,0581234567,0591234567,0501234567,0511234567"; ","); 1.phone)}}',
                      o: "boolean:true",
                    }]],
                  },
                },
              ],
            },
          ],
        },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const issues = checkHardcodedData(classified);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].category).toBe("hardcoded-data");
  });

  test("does NOT flag short lists", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        {
          id: 2,
          module: "powerlink:plquery",
          filter: {
            conditions: [[{ a: '{{split("a,b,c"; ",")}}', o: "boolean:true" }]],
          },
        },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const issues = checkHardcodedData(classified);
    expect(issues).toHaveLength(0);
  });
});
