import { describe, expect, test } from "bun:test";
import type { Blueprint } from "../make-api/types";
import { semanticDiff } from "./semantic-diff";

describe("semanticDiff", () => {
  test("reports a nested mapper leaf on its owning module without serializing ancestors", () => {
    const before = {
      name: "Nested flow",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        {
          id: 17,
          module: "builtin:BasicIfElse",
          branches: [
            {
              flow: [
                { id: 18, module: "monday:createItem", mapper: { boardId: "old" } },
              ],
            },
          ],
        },
      ],
    } as Blueprint;
    const after = structuredClone(before);
    after.flow[1].branches![0].flow![0].mapper.boardId = "new";

    const result = semanticDiff(before, after);

    expect(result.directlyModifiedModules).toEqual([18]);
    expect(result.ancestorModules).toEqual([17]);
    expect(result.changes).toEqual([
      {
        path: "flow[1].branches[0].flow[0].mapper.boardId",
        moduleId: 18,
        before: "old",
        after: "new",
      },
    ]);
  });

  test("collects every numeric ancestor for a deeply nested direct modification", () => {
    const before = {
      name: "Three levels",
      flow: [
        {
          id: 10,
          module: "flow:Router",
          routes: [{
            flow: [{
              id: 20,
              module: "flow:Router",
              routes: [{
                flow: [{ id: 30, module: "http:ActionSendData", mapper: { value: "before" } }],
              }],
            }],
          }],
        },
      ],
    } as Blueprint;
    const after = structuredClone(before);
    after.flow[0].routes![0].flow![0].routes![0].flow![0].mapper.value = "after";

    const result = semanticDiff(before, after);

    expect(result.directlyModifiedModules).toEqual([30]);
    expect(result.ancestorModules).toEqual([10, 20]);
  });

  test("does not classify unchanged IDs as direct changes when modules are inserted or removed before them", () => {
    const before = {
      name: "Stable identity",
      flow: [
        { id: 1, module: "http:ActionSendData", mapper: { value: "one" } },
        { id: 2, module: "http:ActionSendData", mapper: { value: "two" } },
      ],
    } as Blueprint;
    const inserted = structuredClone(before);
    inserted.flow.unshift({ id: 3, module: "http:ActionSendData", mapper: { value: "three" } });
    const removed = structuredClone(inserted);
    removed.flow.shift();

    expect(semanticDiff(before, inserted).directlyModifiedModules).toEqual([]);
    expect(semanticDiff(before, inserted).changes).toEqual([]);
    expect(semanticDiff(inserted, removed).directlyModifiedModules).toEqual([]);
    expect(semanticDiff(inserted, removed).changes).toEqual([]);
  });
});
