import { describe, expect, test } from "bun:test";
import { buildDataFlow, filterDataFlow } from "./data-flow";
import { classifyModules } from "../module-classifier";
import type { Blueprint } from "../../make-api/types";

function makeBp(flow: any[]): Blueprint {
  return { name: "test", flow } as Blueprint;
}

describe("buildDataFlow", () => {
  test("extracts variable references from mapper", () => {
    const bp = makeBp([
      { id: 1, module: "gateway:CustomWebHook" },
      { id: 2, module: "powerlink:plquery", mapper: { query: "{{1.phone}}" } },
    ]);
    const result = buildDataFlow(classifyModules(bp));

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].varName).toBe("phone");
    expect(result.entries[0].usages).toHaveLength(1);
    expect(result.entries[0].usages[0]).toEqual({
      moduleId: 2,
      field: "query",
      sourceModuleId: 1,
      varName: "phone",
    });
  });

  test("extracts variable references from filter conditions", () => {
    const bp = makeBp([
      { id: 1, module: "gateway:CustomWebHook" },
      {
        id: 2,
        module: "powerlink:plquery",
        mapper: {},
        filter: {
          name: "check email",
          conditions: [[{ a: "{{1.email}}", o: "text:equal", b: "test@test.com" }]],
        },
      },
    ]);
    const result = buildDataFlow(classifyModules(bp));

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].varName).toBe("email");
    expect(result.entries[0].usages[0].sourceModuleId).toBe(1);
    expect(result.entries[0].usages[0].moduleId).toBe(2);
  });

  test("tracks multiple variables across multiple modules", () => {
    const bp = makeBp([
      { id: 1, module: "gateway:CustomWebHook" },
      { id: 5, module: "powerlink:plquery", mapper: { query: "{{1.email}}" } },
      {
        id: 7,
        module: "http:ActionSendData",
        mapper: { body: '{"name": "{{1.name}}", "phone": "{{1.phone}}"}' },
      },
    ]);
    const result = buildDataFlow(classifyModules(bp));

    const varNames = result.entries.map((e) => e.varName).sort();
    expect(varNames).toEqual(["email", "name", "phone"]);
  });

  test("handles nested routes", () => {
    const bp = makeBp([
      { id: 1, module: "gateway:CustomWebHook" },
      {
        id: 3,
        module: "builtin:Router",
        routes: [
          {
            flow: [
              { id: 5, module: "powerlink:plquery", mapper: { query: "{{1.email}}" } },
            ],
          },
        ],
      },
    ]);
    const result = buildDataFlow(classifyModules(bp));

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].usages[0].moduleId).toBe(5);
  });

  test("returns empty for modules with no variable references", () => {
    const bp = makeBp([
      { id: 1, module: "gateway:CustomWebHook" },
      { id: 2, module: "powerlink:plquery", mapper: { query: "static value" } },
    ]);
    const result = buildDataFlow(classifyModules(bp));
    expect(result.entries).toHaveLength(0);
  });

  test("handles dotted variable paths grouped by leaf name", () => {
    const bp = makeBp([
      { id: 1, module: "gateway:CustomWebHook" },
      { id: 2, module: "powerlink:plquery", mapper: { query: "{{1.data.email}}" } },
    ]);
    const result = buildDataFlow(classifyModules(bp));

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].varName).toBe("email");
  });

  test("deduplicates same moduleId + field", () => {
    const bp = makeBp([
      { id: 1, module: "gateway:CustomWebHook" },
      {
        id: 2,
        module: "powerlink:plquery",
        mapper: { query: "{{1.email}} and also {{1.email}}" },
      },
    ]);
    const result = buildDataFlow(classifyModules(bp));

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].usages).toHaveLength(1);
  });

  test("chains variable through multiple modules", () => {
    const bp = makeBp([
      { id: 1, module: "gateway:CustomWebHook" },
      { id: 5, module: "powerlink:plquery", mapper: { webinarId: "{{1.registrationId}}" } },
      { id: 3, module: "powerlink:updateObject", mapper: { webinarId: "{{1.registrationId}}" } },
    ]);
    const result = buildDataFlow(classifyModules(bp));

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].varName).toBe("registrationId");
    // Sorted by moduleId: 3 before 5
    expect(result.entries[0].usages[0].moduleId).toBe(3);
    expect(result.entries[0].usages[1].moduleId).toBe(5);
  });
});

describe("filterDataFlow", () => {
  test("filters entries by variable name (case-insensitive)", () => {
    const dataFlow = {
      entries: [
        { varName: "email", usages: [{ moduleId: 2, field: "query", sourceModuleId: 1, varName: "email" }] },
        { varName: "phone", usages: [{ moduleId: 2, field: "query", sourceModuleId: 1, varName: "phone" }] },
      ],
    };

    const filtered = filterDataFlow(dataFlow, "Email");
    expect(filtered.entries).toHaveLength(1);
    expect(filtered.entries[0].varName).toBe("email");
  });

  test("supports partial match", () => {
    const dataFlow = {
      entries: [
        { varName: "email", usages: [] },
        { varName: "recipientEmail", usages: [] },
        { varName: "phone", usages: [] },
      ],
    };

    const filtered = filterDataFlow(dataFlow, "email");
    expect(filtered.entries).toHaveLength(2);
  });
});
