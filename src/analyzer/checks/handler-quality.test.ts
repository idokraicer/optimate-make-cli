import { describe, expect, test } from "bun:test";
import { checkHandlerQuality } from "./handler-quality";
import { classifyModules } from "../module-classifier";
import type { Blueprint } from "../../make-api/types";

describe("checkHandlerQuality", () => {
  test("flags HTTP module with Break but no WebhookRespond", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        {
          id: 2,
          module: "http:ActionSendData",
          onerror: [{ id: 3, module: "builtin:Break" }],
        },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const issues = checkHandlerQuality(classified);
    expect(issues).toHaveLength(1);
  });

  test("does NOT flag HTTP module with WebhookRespond + Break", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        {
          id: 2,
          module: "http:ActionSendData",
          onerror: [
            { id: 3, module: "gateway:WebhookRespond" },
            { id: 4, module: "builtin:Break" },
          ],
        },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const issues = checkHandlerQuality(classified);
    expect(issues).toHaveLength(0);
  });
});
