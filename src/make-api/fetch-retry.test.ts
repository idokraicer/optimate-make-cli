import { describe, expect, test } from "bun:test";
import { fetchWithRetry } from "./fetch-retry";
import {
  RequestCoordinator,
  type RateLimiterStore,
  type RequestContext,
} from "./request-coordinator";

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

  test("preserves complete Request metadata and replayable body across retries", async () => {
    const attempts: Request[] = [];
    const limiter: RateLimiterStore = {
      reserve: async () => undefined,
      setCooldown: () => undefined,
      getSnapshot: () => ({
        documentedRpm: null,
        effectiveRpm: 30,
        limitSource: "fallback",
        requestsSent: 0,
        retries: 0,
        cooldownMs: 0,
      }),
      noteRetry: () => undefined,
      recordExemptRequest: () => undefined,
      setOrganizationLimit: () => undefined,
      acquireExecutionLease: async () => () => undefined,
    };
    const coordinator = new RequestCoordinator({
      limiter,
      random: () => 0,
      sleep: async () => undefined,
      request: async (input) => {
        expect(input).toBeInstanceOf(Request);
        attempts.push(input as Request);
        return attempts.length === 1
          ? new Response("", { status: 503 })
          : new Response("ok");
      },
    });
    const request = new Request("https://us2.make.com/api/v2/scenarios/1", {
      method: "POST",
      headers: { Authorization: "Token secret", "Content-Type": "application/json" },
      body: "{}",
      redirect: "manual",
      credentials: "include",
      cache: "no-store",
      integrity: "sha256-example",
      keepalive: true,
      referrer: "https://example.com/source",
      referrerPolicy: "origin",
      mode: "cors",
    });
    for (const [property, value] of Object.entries({
      cache: "no-store",
      integrity: "sha256-example",
      keepalive: true,
      referrer: "https://example.com/source",
      referrerPolicy: "origin",
      mode: "cors",
    })) {
      Object.defineProperty(request, property, {
        configurable: true,
        enumerable: true,
        value,
      });
    }

    await fetchWithRetry(request, undefined, { coordinator });

    expect(attempts).toHaveLength(2);
    const captured = attempts[0]!;
    expect(captured.method).toBe("POST");
    expect(captured.headers.get("authorization")).toBe("Token secret");
    expect(captured.redirect).toBe("manual");
    expect(captured.credentials).toBe("include");
    expect(captured.cache).toBe("no-store");
    expect(captured.integrity).toBe("sha256-example");
    expect(captured.keepalive).toBe(true);
    expect(captured.referrer).toBe("https://example.com/source");
    expect(captured.referrerPolicy).toBe("origin");
    expect(captured.mode).toBe("cors");
    expect(await captured.text()).toBe("{}");
    expect(await attempts[1]!.text()).toBe("{}");
  });
});
