import { describe, expect, test } from "bun:test";
import { buildModuleNamePrompt, buildScenarioNamePrompt, parseAiName } from "./ai-content";

describe("buildModuleNamePrompt", () => {
  test("constructs prompt with module context", () => {
    const prompt = buildModuleNamePrompt("powerlink:plquery", { query: "{{1.phone}}" });
    expect(prompt).toContain("powerlink:plquery");
    expect(prompt).toContain("phone");
  });
});

describe("buildScenarioNamePrompt", () => {
  test("constructs prompt with blueprint context", () => {
    const prompt = buildScenarioNamePrompt("Sync", ["gateway:CustomWebHook", "powerlink:plquery", "gmail:sendEmail"]);
    expect(prompt).toContain("Sync");
    expect(prompt).toContain("powerlink");
  });
});

describe("parseAiName", () => {
  test("extracts clean name from AI response", () => {
    expect(parseAiName('"Query Contact by Phone"')).toBe("Query Contact by Phone");
    expect(parseAiName("Query Contact by Phone")).toBe("Query Contact by Phone");
    expect(parseAiName("  Query Contact by Phone  ")).toBe("Query Contact by Phone");
  });
});
