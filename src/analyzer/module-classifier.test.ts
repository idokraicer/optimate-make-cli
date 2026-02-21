import { describe, expect, test } from "bun:test";
import { classifyModules } from "./module-classifier";
import simpleBlueprint from "../../tests/fixtures/simple-blueprint.json";
import complexBlueprint from "../../tests/fixtures/complex-blueprint.json";
import type { Blueprint } from "../make-api/types";

describe("classifyModules", () => {
  test("classifies trigger module correctly", () => {
    const result = classifyModules(simpleBlueprint as Blueprint);
    const trigger = result.find((r) => r.module.id === 1);
    expect(trigger?.classification).toBe("trigger");
  });

  test("classifies excluded modules correctly", () => {
    const result = classifyModules(complexBlueprint as Blueprint);
    const router = result.find((r) => r.module.id === 3);
    expect(router?.classification).toBe("excluded");
    const jsonModule = result.find((r) => r.module.id === 2);
    expect(jsonModule?.classification).toBe("excluded");
  });

  test("classifies API modules correctly", () => {
    const result = classifyModules(simpleBlueprint as Blueprint);
    const apiModule = result.find((r) => r.module.id === 2);
    expect(apiModule?.classification).toBe("api");
  });

  test("finds all modules in nested routes", () => {
    const result = classifyModules(complexBlueprint as Blueprint);
    // Should find: 1 (trigger), 2 (excluded json), 3 (excluded router),
    // 5, 6 (api powerlink), 7 (api http), 8 (api gmail)
    expect(result).toHaveLength(7);
    const apiModules = result.filter((r) => r.classification === "api");
    expect(apiModules).toHaveLength(4);
  });
});
