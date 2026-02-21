import { describe, expect, test } from "bun:test";
import { isExcludedModule, isTriggerModule, getMaxModuleId } from "./module-helpers";

describe("isExcludedModule", () => {
  test("excludes builtin modules", () => {
    expect(isExcludedModule("builtin:Router")).toBe(true);
    expect(isExcludedModule("builtin:BasicFilter")).toBe(true);
  });

  test("excludes gateway modules", () => {
    expect(isExcludedModule("gateway:CustomWebHook")).toBe(true);
    expect(isExcludedModule("gateway:WebhookRespond")).toBe(true);
  });

  test("excludes json modules", () => {
    expect(isExcludedModule("json:ParseJSON")).toBe(true);
    expect(isExcludedModule("json:CreateJSON")).toBe(true);
  });

  test("excludes tools modules", () => {
    expect(isExcludedModule("tools:SetVariables")).toBe(true);
    expect(isExcludedModule("tools:Compose")).toBe(true);
  });

  test("excludes util, flow, code, phonenumber modules", () => {
    expect(isExcludedModule("util:Switcher")).toBe(true);
    expect(isExcludedModule("flow:something")).toBe(true);
    expect(isExcludedModule("code:ExecuteCode")).toBe(true);
    expect(isExcludedModule("phonenumber:Parse")).toBe(true);
  });

  test("excludes Transformer modules", () => {
    expect(isExcludedModule("google-sheets:Transformer")).toBe(true);
    expect(isExcludedModule("monday:Transformer")).toBe(true);
  });

  test("does NOT exclude API modules", () => {
    expect(isExcludedModule("monday:ListBoardItems")).toBe(false);
    expect(isExcludedModule("powerlink:plquery")).toBe(false);
    expect(isExcludedModule("gmail:sendEmail")).toBe(false);
    expect(isExcludedModule("http:ActionSendData")).toBe(false);
    expect(isExcludedModule("green-api:SendMessage")).toBe(false);
  });
});

describe("getMaxModuleId", () => {
  test("finds highest ID in flat flow", () => {
    const flow = [
      { id: 1, module: "a:b" },
      { id: 5, module: "c:d" },
      { id: 3, module: "e:f" },
    ] as any;
    expect(getMaxModuleId(flow)).toBe(5);
  });

  test("finds highest ID including onerror handlers", () => {
    const flow = [
      { id: 1, module: "a:b", onerror: [{ id: 10, module: "builtin:Break" }] },
      { id: 5, module: "c:d" },
    ] as any;
    expect(getMaxModuleId(flow)).toBe(10);
  });
});
