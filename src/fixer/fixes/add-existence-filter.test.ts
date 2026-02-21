import { describe, expect, test } from "bun:test";
import { addExistenceFilter } from "./add-existence-filter";
import type { Module } from "../../make-api/types";

function makeModule(overrides: Partial<Module> = {}): Module {
  return {
    id: 2,
    module: "powerlink:plquery",
    mapper: { query: "{{1.phone}}" },
    ...overrides,
  } as Module;
}

describe("addExistenceFilter", () => {
  test("adds filter to module with no existing filter", () => {
    const mod = makeModule();
    const result = addExistenceFilter(mod, ["1.phone"]);
    expect(result.filter).toEqual({
      name: "",
      conditions: [[{ a: "{{1.phone}}", o: "exist" }]],
    });
  });

  test("adds multiple vars as conditions in one AND group", () => {
    const mod = makeModule();
    const result = addExistenceFilter(mod, ["1.phone", "1.email"]);
    expect(result.filter!.conditions).toEqual([
      [
        { a: "{{1.phone}}", o: "exist" },
        { a: "{{1.email}}", o: "exist" },
      ],
    ]);
  });

  test("merges with existing filter conditions", () => {
    const mod = makeModule({
      filter: {
        name: "my filter",
        conditions: [[{ a: "{{1.status}}", o: "equal", b: "active" }]],
      },
    });
    const result = addExistenceFilter(mod, ["1.phone"]);
    expect(result.filter!.name).toBe("my filter");
    expect(result.filter!.conditions[0]).toEqual([
      { a: "{{1.phone}}", o: "exist" },
      { a: "{{1.status}}", o: "equal", b: "active" },
    ]);
  });

  test("skips vars that already have existence conditions (dedup)", () => {
    const mod = makeModule({
      filter: {
        name: "",
        conditions: [[{ a: "{{1.phone}}", o: "exist" }]],
      },
    });
    const result = addExistenceFilter(mod, ["1.phone", "1.email"]);
    // Only 1.email should be added, 1.phone already exists
    expect(result.filter!.conditions[0]).toEqual([
      { a: "{{1.email}}", o: "exist" },
      { a: "{{1.phone}}", o: "exist" },
    ]);
  });

  test("returns module unchanged when all vars already checked", () => {
    const mod = makeModule({
      filter: {
        name: "",
        conditions: [[{ a: "{{1.phone}}", o: "exist" }]],
      },
    });
    const result = addExistenceFilter(mod, ["1.phone"]);
    expect(result).toEqual(mod);
  });

  test("returns module unchanged for empty unsafeVars", () => {
    const mod = makeModule();
    const result = addExistenceFilter(mod, []);
    expect(result).toBe(mod);
  });

  test("handles null filter", () => {
    const mod = makeModule({ filter: null });
    const result = addExistenceFilter(mod, ["1.phone"]);
    expect(result.filter).toEqual({
      name: "",
      conditions: [[{ a: "{{1.phone}}", o: "exist" }]],
    });
  });
});
