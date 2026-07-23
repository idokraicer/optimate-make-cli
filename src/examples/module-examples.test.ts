import { describe, expect, test } from "bun:test";
import type { ScenarioIndexRecord } from "../search/search-index";
import {
  findModuleExamples,
  moduleConfigurationSignature,
  sanitizeModuleFragment,
} from "./module-examples";

const records: ScenarioIndexRecord[] = [{
  scenarioId: 20,
  scenarioName: "Nested examples",
  teamId: 7,
  lastEdit: "now",
  indexedAt: "now",
  entries: [],
  sanitizedBlueprint: {
    name: "Nested examples",
    flow: [{
      id: 1,
      module: "monday:CreateItem",
      version: 2,
      parameters: { connection: 44, boardId: 123 },
      mapper: { name: "Top" },
      branches: [{
        label: "Priority branch",
        authorization: "Bearer branch-secret",
        flow: [{
          id: 2,
          module: "monday:CreateItem",
          version: 2,
          parameters: { boardId: 456, connection: 45 },
          mapper: { name: "Branch" },
          filter: {
            name: "Recovery filter",
            conditions: {
              token: "token-secret",
              header: "Authorization: Bearer private",
            },
          },
        }],
      }],
      onerror: [{
        id: 3,
        module: "monday:CreateItem",
        version: 2,
        parameters: { boardId: 789, connection: 46 },
        mapper: { name: "Recovery" },
      }],
    }, {
      id: 4,
      module: "http:ActionSendData",
      version: 3,
      mapper: { url: "https://example.test/resources/991", restoreLabel: "Retry me" },
      metadata: { interface: [{ name: "output", type: "text" }] },
    }],
  },
}];

describe("module example discovery", () => {
  test("matches exact modules, app prefixes, versions, literal text, and exact locations on canonical paths", () => {
    expect(findModuleExamples(records, { module: "monday:CreateItem" })[0]?.equivalentLocations)
      .toEqual([
        { scenarioId: 20, moduleId: 1, path: "flow[0]" },
        { scenarioId: 20, moduleId: 2, path: "flow[0].branches[0].flow[0]" },
        { scenarioId: 20, moduleId: 3, path: "flow[0].onerror[0]" },
      ]);
    expect(findModuleExamples(records, { app: "http" })[0]?.path)
      .toBe("flow[1]");
    expect(findModuleExamples(records, { app: "monday", version: 2 })).toHaveLength(1);
    expect(findModuleExamples(records, { search: "resources/991" })[0]?.moduleId).toBe(4);
    const exact = findModuleExamples(records, { scenarioId: 20, moduleId: 2, full: true });
    expect(exact[0]?.path).toBe("flow[0].branches[0].flow[0]");
    expect(exact[0]?.equivalentCount).toBe(1);
  });

  test("groups equivalent key shapes regardless of values and returns usable sanitized fragments", () => {
    const top = records[0]!.sanitizedBlueprint.flow[0]!;
    const branch = top.branches![0]!.flow![0]!;
    expect(moduleConfigurationSignature(top)).toBe(moduleConfigurationSignature(branch));

    const fragment = sanitizeModuleFragment({
      id: 9,
      module: "http:ActionSendData",
      version: 3,
      parameters: { connection: 44, resourceId: 991, apiKey: "hide" },
      mapper: {
        url: "https://example.test/resources/991",
        restoreLabel: "Retry me",
        headers: [
          { name: "Authorization", value: "Bearer hide" },
          { name: "X-Trace", value: "keep" },
        ],
      },
      metadata: {
        interface: [{ name: "output", type: "text" }],
        credentials: { accessToken: "hide" },
      },
    } as any) as any;
    expect(fragment.parameters.connection).toBe(44);
    expect(fragment.parameters.resourceId).toBe(991);
    expect(fragment.parameters.apiKey).toBe("[REDACTED]");
    expect(fragment.mapper.url).toBe("https://example.test/resources/991");
    expect(fragment.mapper.restoreLabel).toBe("Retry me");
    expect(fragment.mapper.headers).toEqual([
      { name: "Authorization", value: "[REDACTED]" },
      { name: "X-Trace", value: "keep" },
    ]);
    expect(fragment.metadata.interface).toEqual([{ name: "output", type: "text" }]);
    expect(JSON.stringify(fragment)).not.toContain("Bearer hide");
    expect(JSON.stringify(fragment)).not.toContain("accessToken");
  });

  test("signatures ignore every configured leaf value and primitive type", () => {
    const first = {
      id: 1,
      module: "tools:Example",
      version: 1,
      parameters: {
        scalar: 123,
        nested: { enabled: true, nullable: null },
        list: ["one", { count: 7 }],
      },
      mapper: { value: "text" },
      metadata: { schema: { required: false } },
    } as any;
    const second = {
      id: 2,
      module: "tools:Example",
      version: 1,
      parameters: {
        list: [false, { count: "seven" }],
        nested: { nullable: "not-null", enabled: 0 },
        scalar: null,
      },
      mapper: { value: 42 },
      metadata: { schema: { required: "yes" } },
    } as any;

    expect(moduleConfigurationSignature(first)).toBe(moduleConfigurationSignature(second));
  });

  test("--full adds complete sanitized canonical context without changing default examples", () => {
    const normal = findModuleExamples(records, { module: "monday:CreateItem" });
    expect(normal[0]?.full).toBeUndefined();

    const [full] = findModuleExamples(records, {
      scenarioId: 20,
      moduleId: 2,
      full: true,
    });
    expect(full?.full).toMatchObject({
      fragment: {
        id: 2,
        module: "monday:CreateItem",
        parameters: { boardId: 456, connection: 45 },
      },
      context: {
        path: "flow[0].branches[0].flow[0]",
        container: "branch",
        depth: 1,
        parentModuleId: 1,
        parent: {
          path: "flow[0]",
          id: 1,
          module: "monday:CreateItem",
        },
        containerMetadata: {
          label: "Priority branch",
          authorization: "[REDACTED]",
        },
      },
    });
    expect(JSON.stringify(full?.full)).not.toMatch(
      /token-secret|Bearer private|branch-secret/,
    );
  });

  test("returns no examples instead of inventing a module schema", () => {
    expect(findModuleExamples(records, { module: "salesforce:CreateRecord" })).toEqual([]);
  });
});
