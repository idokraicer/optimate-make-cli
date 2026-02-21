import { describe, expect, test } from "bun:test";
import { setModuleName } from "./set-module-name";
import type { Module } from "../../make-api/types";

describe("setModuleName", () => {
  test("sets name in metadata.designer.name", () => {
    const module: Module = {
      id: 5,
      module: "powerlink:plquery",
      metadata: { designer: { x: 0, y: 0 } },
    } as any;
    const result = setModuleName(module, "Query Contact by Phone");
    expect(result.metadata?.designer?.name).toBe("Query Contact by Phone");
  });

  test("creates metadata.designer if missing", () => {
    const module: Module = { id: 5, module: "powerlink:plquery" } as any;
    const result = setModuleName(module, "Query Contact");
    expect(result.metadata?.designer?.name).toBe("Query Contact");
  });

  test("does not mutate original module", () => {
    const module: Module = {
      id: 5,
      module: "powerlink:plquery",
      metadata: { designer: { x: 100, y: 200 } },
    } as any;
    const result = setModuleName(module, "New Name");
    expect(module.metadata?.designer?.name).toBeUndefined();
    expect(result.metadata?.designer?.x).toBe(100);
  });
});
