import { describe, expect, test } from "bun:test";
import { resolvePath, applyEdits, type BlueprintEdit } from "./blueprint-editor";

describe("resolvePath", () => {
  const obj = {
    name: "Test",
    flow: [
      { id: 1, module: "gateway:CustomWebHook" },
      { id: 2, module: "powerlink:plquery", mapper: { query: "{{1.phone}}" } },
      {
        id: 3,
        module: "flow:Router",
        routes: [
          { flow: [{ id: 4, module: "gmail:sendEmail" }] },
          { flow: [{ id: 5, module: "slack:sendMessage" }] },
        ],
      },
    ],
  };

  test("resolves top-level field", () => {
    const { parent, key } = resolvePath(obj, "name");
    expect(parent).toBe(obj);
    expect(key).toBe("name");
    expect(parent[key]).toBe("Test");
  });

  test("resolves array element", () => {
    const { parent, key } = resolvePath(obj, "flow[1]");
    expect(parent).toBe(obj.flow);
    expect(key).toBe(1);
    expect(parent[key].id).toBe(2);
  });

  test("resolves nested field", () => {
    const { parent, key } = resolvePath(obj, "flow[1].mapper.query");
    expect(parent).toBe(obj.flow[1].mapper);
    expect(key).toBe("query");
    expect(parent[key]).toBe("{{1.phone}}");
  });

  test("resolves through routes", () => {
    const { parent, key } = resolvePath(obj, "flow[2].routes[0].flow[0]");
    expect(parent[key].id).toBe(4);
  });

  test("throws on invalid path", () => {
    expect(() => resolvePath(obj, "flow[99].mapper")).toThrow();
  });
});

describe("applyEdits", () => {
  function makeBlueprint() {
    return {
      name: "Test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        { id: 2, module: "powerlink:plquery", mapper: { query: "{{1.phone}}" } },
      ],
    };
  }

  test("set: updates a field value", () => {
    const bp = makeBlueprint();
    const result = applyEdits(bp, [
      { path: "flow[1].mapper.query", action: "set", value: "{{1.email}}" },
    ]);
    expect(result.flow[1].mapper.query).toBe("{{1.email}}");
  });

  test("set: updates top-level field", () => {
    const bp = makeBlueprint();
    const result = applyEdits(bp, [
      { path: "name", action: "set", value: "New Name" },
    ]);
    expect(result.name).toBe("New Name");
  });

  test("insert: adds element to array at index", () => {
    const bp = makeBlueprint();
    const newModule = { id: 5, module: "gmail:sendEmail", mapper: {} };
    const result = applyEdits(bp, [
      { path: "flow", action: "insert", index: 1, value: newModule },
    ]);
    expect(result.flow).toHaveLength(3);
    expect(result.flow[1].id).toBe(5);
    expect(result.flow[2].id).toBe(2);
  });

  test("insert: appends when index equals array length", () => {
    const bp = makeBlueprint();
    const newModule = { id: 5, module: "gmail:sendEmail" };
    const result = applyEdits(bp, [
      { path: "flow", action: "insert", index: 2, value: newModule },
    ]);
    expect(result.flow).toHaveLength(3);
    expect(result.flow[2].id).toBe(5);
  });

  test("remove: removes element from array", () => {
    const bp = makeBlueprint();
    const result = applyEdits(bp, [
      { path: "flow[1]", action: "remove" },
    ]);
    expect(result.flow).toHaveLength(1);
    expect(result.flow[0].id).toBe(1);
  });

  test("remove: removes object field", () => {
    const bp = makeBlueprint();
    const result = applyEdits(bp, [
      { path: "flow[1].mapper", action: "remove" },
    ]);
    expect(result.flow[1].mapper).toBeUndefined();
  });

  test("multiple edits applied in order", () => {
    const bp = makeBlueprint();
    const result = applyEdits(bp, [
      { path: "name", action: "set", value: "Updated" },
      { path: "flow[1].mapper.query", action: "set", value: "new" },
    ]);
    expect(result.name).toBe("Updated");
    expect(result.flow[1].mapper.query).toBe("new");
  });

  test("throws on insert without value", () => {
    const bp = makeBlueprint();
    expect(() =>
      applyEdits(bp, [{ path: "flow", action: "insert" }])
    ).toThrow();
  });
});
