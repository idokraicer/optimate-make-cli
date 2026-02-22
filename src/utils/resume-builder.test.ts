import { describe, test, expect } from "bun:test";
import {
  findModuleById,
  extractInterface,
  buildResumeMapper,
  buildResumeModule,
} from "./resume-builder";
import type { Module } from "../make-api/types";

const makeModule = (id: number, extra: Partial<Module> = {}): Module => ({
  id,
  module: "test:module",
  version: 1,
  ...extra,
});

// --- findModuleById ---

describe("findModuleById", () => {
  test("finds a top-level module", () => {
    const flow: Module[] = [makeModule(1), makeModule(2), makeModule(3)];
    expect(findModuleById(flow, 2)?.id).toBe(2);
  });

  test("finds a module nested inside a router route", () => {
    const flow: Module[] = [
      {
        ...makeModule(1),
        module: "flow:Router",
        routes: [
          { flow: [makeModule(10), makeModule(11)] },
          { flow: [makeModule(20)] },
        ],
      },
    ];
    expect(findModuleById(flow, 11)?.id).toBe(11);
    expect(findModuleById(flow, 20)?.id).toBe(20);
  });

  test("returns null when module is not found", () => {
    const flow: Module[] = [makeModule(1)];
    expect(findModuleById(flow, 99)).toBeNull();
  });
});

// --- extractInterface ---

describe("extractInterface", () => {
  test("returns interface fields when present", () => {
    const mod = makeModule(5, {
      metadata: {
        interface: [
          { name: "name", type: "text", label: "Name" },
          { name: "status", type: "text", label: "Status" },
        ],
      } as any,
    });
    const iface = extractInterface(mod);
    expect(iface).toHaveLength(2);
    expect(iface![0].name).toBe("name");
  });

  test("returns null when metadata has no interface", () => {
    const mod = makeModule(5);
    expect(extractInterface(mod)).toBeNull();
  });

  test("returns null when interface is an empty array", () => {
    const mod = makeModule(5, { metadata: { interface: [] } as any });
    expect(extractInterface(mod)).toBeNull();
  });
});

// --- buildResumeMapper ---

describe("buildResumeMapper", () => {
  test("maps regular fields with simple expression", () => {
    const iface = [
      { name: "name", type: "text" },
      { name: "status", type: "text" },
    ];
    const mapper = buildResumeMapper(iface, 20);
    expect(mapper.name).toBe("{{20.name}}");
    expect(mapper.status).toBe("{{20.status}}");
  });

  test("wraps __DOUBLE_UNDERSCORE__ fields in backticks", () => {
    const iface = [
      { name: "__IMTINDEX__", type: "uinteger" },
      { name: "__IMTLENGTH__", type: "uinteger" },
      { name: "name", type: "text" },
    ];
    const mapper = buildResumeMapper(iface, 42);
    expect(mapper["__IMTINDEX__"]).toBe("{{42.`__IMTINDEX__`}}");
    expect(mapper["__IMTLENGTH__"]).toBe("{{42.`__IMTLENGTH__`}}");
    expect(mapper["name"]).toBe("{{42.name}}");
  });
});

// --- buildResumeModule ---

describe("buildResumeModule", () => {
  test("produces a valid builtin:Resume module structure", () => {
    const erroredModule = makeModule(5, {
      metadata: {
        interface: [
          { name: "name", type: "text", label: "Name" },
          { name: "__IMTINDEX__", type: "uinteger", label: "Bundle order position" },
        ],
      } as any,
    });

    const result = buildResumeModule(erroredModule, 20, 100, { x: 1800, y: 300 });

    expect(result.id).toBe(100);
    expect(result.module).toBe("builtin:Resume");
    expect(result.version).toBe(1);

    const mapper = result.mapper as Record<string, string>;
    expect(mapper.name).toBe("{{20.name}}");
    expect(mapper["__IMTINDEX__"]).toBe("{{20.`__IMTINDEX__`}}");

    const metadata = result.metadata as any;
    expect(metadata.designer.x).toBe(1800);
    expect(metadata.designer.y).toBe(300);
    expect(metadata.expect).toHaveLength(2);
  });

  test("produces empty mapper when module has no interface", () => {
    const erroredModule = makeModule(5);
    const result = buildResumeModule(erroredModule, 20, 100, { x: 0, y: 0 });
    expect(result.mapper).toEqual({});
    expect((result.metadata as any).expect).toEqual([]);
  });
});
