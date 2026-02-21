import { describe, expect, test } from "bun:test";
import { addErrorHandler } from "./add-error-handler";
import type { Module } from "../../make-api/types";

describe("addErrorHandler", () => {
  test("adds Break error handler to module", () => {
    const module: Module = {
      id: 5,
      module: "powerlink:plquery",
      onerror: null,
    } as any;
    const nextId = 100;
    const result = addErrorHandler(module, nextId);
    expect(result.onerror).toHaveLength(1);
    expect(result.onerror![0].id).toBe(100);
    expect(result.onerror![0].module).toBe("builtin:Break");
    expect(result.onerror![0].mapper.retry).toBe(true);
    expect(result.onerror![0].mapper.count).toBe(3);
    expect(result.onerror![0].mapper.interval).toBe(60);
  });

  test("does not modify original module", () => {
    const module: Module = { id: 5, module: "powerlink:plquery", onerror: null } as any;
    addErrorHandler(module, 100);
    expect(module.onerror).toBeNull();
  });
});
