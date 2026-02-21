import { describe, expect, test } from "bun:test";
import { resolvePath } from "./blueprint-editor";

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
