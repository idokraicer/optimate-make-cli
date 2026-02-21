import { describe, expect, test } from "bun:test";
import { checkSecurity } from "./security";
import { classifyModules } from "../module-classifier";
import type { Blueprint } from "../../make-api/types";

describe("checkSecurity", () => {
  test("flags hardcoded API keys in mapper", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        {
          id: 2,
          module: "http:ActionSendData",
          mapper: {
            headers: [{ name: "Authorization", value: "Bearer sk-1234567890abcdef" }],
          },
        },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const issues = checkSecurity(classified);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].severity).toBe("critical");
  });

  test("does NOT flag connection references", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        {
          id: 2,
          module: "http:ActionSendData",
          mapper: {
            headers: [{ name: "Authorization", value: "{{connection.token}}" }],
          },
        },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const issues = checkSecurity(classified);
    expect(issues).toHaveLength(0);
  });
});
