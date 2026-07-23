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
});
