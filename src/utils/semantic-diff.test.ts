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

  test("reports common IDs swapped within the top-level flow as semantic movements", () => {
    const before = {
      name: "Top-level reorder",
      flow: [
        { id: 1, module: "http:ActionSendData", mapper: { value: "one" } },
        { id: 2, module: "http:ActionSendData", mapper: { value: "two" } },
      ],
    } as Blueprint;
    const after = structuredClone(before);
    [after.flow[0], after.flow[1]] = [after.flow[1], after.flow[0]];

    expect(semanticDiff(before, after)).toEqual({
      directlyModifiedModules: [1, 2],
      ancestorModules: [],
      changes: [
        {
          path: "flow[0]",
          moduleId: 2,
          before: "flow[1]",
          after: "flow[0]",
        },
        {
          path: "flow[1]",
          moduleId: 1,
          before: "flow[0]",
          after: "flow[1]",
        },
      ],
    });
  });

  test("reports common IDs swapped within an error-handler container as movements", () => {
    const before = {
      name: "Nested reorder",
      flow: [{
        id: 1,
        module: "http:ActionSendData",
        onerror: [
          { id: 2, module: "builtin:Ignore", mapper: { value: "two" } },
          { id: 3, module: "builtin:Ignore", mapper: { value: "three" } },
        ],
      }],
    } as Blueprint;
    const after = structuredClone(before);
    [after.flow[0].onerror![0], after.flow[0].onerror![1]] = [
      after.flow[0].onerror![1],
      after.flow[0].onerror![0],
    ];

    expect(semanticDiff(before, after)).toEqual({
      directlyModifiedModules: [2, 3],
      ancestorModules: [1],
      changes: [
        {
          path: "flow[0].onerror[0]",
          moduleId: 3,
          before: "flow[0].onerror[1]",
          after: "flow[0].onerror[0]",
        },
        {
          path: "flow[0].onerror[1]",
          moduleId: 2,
          before: "flow[0].onerror[0]",
          after: "flow[0].onerror[1]",
        },
      ],
    });
  });

  test("reports route metadata leaves on the owning module", () => {
    const before = {
      name: "Route metadata",
      flow: [{
        id: 1,
        module: "flow:Router",
        routes: [{ filter: { name: "before" }, flow: [] }],
      }],
    } as Blueprint;
    const after = structuredClone(before);
    after.flow[0].routes![0].filter.name = "after";

    expect(semanticDiff(before, after)).toEqual({
      directlyModifiedModules: [1],
      ancestorModules: [],
      changes: [{
        path: "flow[0].routes[0].filter.name",
        moduleId: 1,
        before: "before",
        after: "after",
      }],
    });
  });

  test("reports a same-ID module moving between routes as an owned semantic movement", () => {
    const before = {
      name: "Move module",
      flow: [{
        id: 1,
        module: "flow:Router",
        routes: [
          { flow: [{ id: 2, module: "http:ActionSendData", mapper: { value: "same" } }] },
          { flow: [] },
        ],
      }],
    } as Blueprint;
    const after = structuredClone(before);
    const [moved] = after.flow[0].routes![0].flow!;
    after.flow[0].routes![0].flow = [];
    after.flow[0].routes![1].flow = [moved];

    expect(semanticDiff(before, after)).toEqual({
      directlyModifiedModules: [2],
      ancestorModules: [1],
      changes: [{
        path: "flow[0].routes[1].flow[0]",
        moduleId: 2,
        before: "flow[0].routes[0].flow[0]",
        after: "flow[0].routes[1].flow[0]",
      }],
    });
  });

  test("reports an unambiguous null-ID module leaf with null ownership", () => {
    const before = {
      name: "Null handler",
      flow: [{
        id: 1,
        module: "http:ActionSendData",
        onerror: [{ id: null, module: "builtin:Ignore", mapper: { value: "before" } }],
      }],
    } as Blueprint;
    const after = structuredClone(before);
    after.flow[0].onerror![0].mapper.value = "after";

    expect(semanticDiff(before, after)).toEqual({
      directlyModifiedModules: [],
      ancestorModules: [1],
      changes: [{
        path: "flow[0].onerror[0].mapper.value",
        moduleId: null,
        before: "before",
        after: "after",
      }],
    });
  });
});
