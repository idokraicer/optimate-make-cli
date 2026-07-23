import { describe, expect, test } from "bun:test";
import { fetchWithRetry } from "./fetch-retry";
import type { RequestContext } from "./request-coordinator";

describe("fetchWithRetry", () => {
  test("remains a backward-compatible wrapper using an unknown organization bucket", async () => {
    let capturedContext: RequestContext | undefined;
    const response = new Response("ok");
    const coordinator = {
      request: async (_url: string | URL | Request, _init: RequestInit, context: RequestContext) => {
        capturedContext = context;
        return response;
      },
    };

    const result = await fetchWithRetry(
      "https://eu2.make.com/api/v2/scenarios",
      { headers: { Authorization: "Token secret" } },
      { maxRetries: 3, coordinator },
    );

    expect(result).toBe(response);
    expect(capturedContext).toMatchObject({
      bucket: { zone: "eu2", organizationId: "unknown" },
      maxRetries: 3,
    });
  });

  test("preserves Request input headers and method", async () => {
    let capturedInit: RequestInit | undefined;
    const coordinator = {
      request: async (_url: string | URL | Request, init: RequestInit) => {
        capturedInit = init;
        return new Response("ok");
      },
    };
    const request = new Request("https://us2.make.com/api/v2/scenarios/1", {
      method: "PATCH",
      headers: { Authorization: "Token secret", "Content-Type": "application/json" },
      body: "{}",
    });

    await fetchWithRetry(request, undefined, { coordinator });

    expect(capturedInit?.method).toBe("PATCH");
    expect(new Headers(capturedInit?.headers).get("authorization")).toBe("Token secret");
  });
});
