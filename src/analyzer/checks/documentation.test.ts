import { describe, expect, test } from "bun:test";
import { checkDocumentation } from "./documentation";
import { classifyModules } from "../module-classifier";
import type { Blueprint, Note } from "../../make-api/types";

describe("checkDocumentation", () => {
  test("flags HTTP modules without documentation", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        { id: 2, module: "http:ActionSendData" },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const notes: Note[] = [];
    const issues = checkDocumentation(classified, notes);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].moduleId).toBe(2);
  });

  test("does NOT flag standard API modules without docs", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        { id: 2, module: "powerlink:plquery" },
        { id: 3, module: "gmail:sendEmail" },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const issues = checkDocumentation(classified, []);
    expect(issues).toHaveLength(0);
  });

  test("does NOT flag HTTP modules WITH valid English documentation", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        { id: 2, module: "http:ActionSendData" },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const notes: Note[] = [
      { moduleIds: [2], content: "Sends order data to the external fulfillment API" },
    ];
    const issues = checkDocumentation(classified, notes);
    expect(issues).toHaveLength(0);
  });

  test("flags HTTP modules with Hebrew-only documentation", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        { id: 2, module: "http:ActionSendData" },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const notes: Note[] = [
      { moduleIds: [2], content: "שולח נתונים לשרת חיצוני" },
    ];
    const issues = checkDocumentation(classified, notes);
    expect(issues).toHaveLength(1);
  });

  test("flags HTTP modules with too-short documentation", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        { id: 2, module: "http:ActionSendData" },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const notes: Note[] = [{ moduleIds: [2], content: "sends data" }];
    const issues = checkDocumentation(classified, notes);
    expect(issues).toHaveLength(1);
  });
});
