import { describe, expect, test } from "bun:test";
import {
  RequestCoordinator,
  type RequestContext,
  type RequestExecutor,
  type RateLimiterStore,
} from "./request-coordinator";
import type { RateBucket, RateLimitSnapshot } from "./rate-limiter";

const bucket: RateBucket = { zone: "eu1", organizationId: 8430514 };

function fakeTime(start = 0) {
  let now = start;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

function fakeLimiter() {
  const reservations: Array<{ bucket: RateBucket; rpm: number }> = [];
  const cooldowns: number[] = [];
  let retries = 0;
  let exemptRequests = 0;
  const snapshot: RateLimitSnapshot = {
    documentedRpm: null,
    effectiveRpm: 30,
    limitSource: "fallback",
    requestsSent: 0,
    retries: 0,
    cooldownMs: 0,
  };
  const limiter: RateLimiterStore = {
    reserve: async (reservedBucket, rpm) => {
      reservations.push({ bucket: reservedBucket, rpm });
    },
    setCooldown: (_reservedBucket, untilMs) => {
      cooldowns.push(untilMs);
    },
    getSnapshot: () => ({ ...snapshot, retries }),
    noteRetry: () => {
      retries++;
    },
    recordExemptRequest: () => {
      exemptRequests++;
    },
  };
  return { limiter, reservations, cooldowns, get retries() { return retries; }, get exemptRequests() { return exemptRequests; } };
}

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return { bucket, ...overrides };
}

describe("RequestCoordinator", () => {
  test("retries 429 until success without consuming bounded retry budget", async () => {
    const responses = [
      new Response("", { status: 429 }),
      new Response("", { status: 429, headers: { "Retry-After": "2" } }),
      new Response("ok", { status: 200 }),
    ];
    const time = fakeTime();
    const rate = fakeLimiter();
    const coordinator = new RequestCoordinator({
      limiter: rate.limiter,
      now: time.now,
      sleep: time.sleep,
      random: () => 0,
      request: async () => responses.shift()!,
    });

    const result = await coordinator.request("https://eu1.make.com/api/v2/scenarios", {}, context({
      maxRetries: 0,
    }));

    expect(await result.text()).toBe("ok");
    expect(time.sleeps).toEqual([60_000, 2_000]);
    expect(rate.retries).toBe(2);
    expect(rate.cooldowns).toEqual([60_000, 62_000]);
  });

  test("parses an HTTP-date Retry-After value relative to the injected clock", async () => {
    const start = Date.parse("2026-07-23T10:00:00.000Z");
    const time = fakeTime(start);
    const rate = fakeLimiter();
    const responses = [
      new Response("", {
        status: 429,
        headers: { "Retry-After": new Date(start + 5_000).toUTCString() },
      }),
      new Response("ok"),
    ];
    const coordinator = new RequestCoordinator({
      limiter: rate.limiter,
      now: time.now,
      sleep: time.sleep,
      request: async () => responses.shift()!,
    });

    await coordinator.request("https://eu1.make.com/api/v2/scenarios", {}, context());

    expect(time.sleeps).toEqual([5_000]);
  });

  test("bounds 503 retries and uses exponential full jitter", async () => {
    const time = fakeTime();
    const rate = fakeLimiter();
    let calls = 0;
    const coordinator = new RequestCoordinator({
      limiter: rate.limiter,
      now: time.now,
      sleep: time.sleep,
      random: () => 0.5,
      request: async () => {
        calls++;
        return new Response("", { status: 503 });
      },
    });

    const result = await coordinator.request("https://eu1.make.com/api/v2/scenarios", {}, context({
      maxRetries: 2,
    }));

    expect(result.status).toBe(503);
    expect(calls).toBe(3);
    expect(time.sleeps).toEqual([500, 1_000]);
  });

  test("deduplicates identical in-flight GETs and returns independently readable responses", async () => {
    const rate = fakeLimiter();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor: RequestExecutor = async () => {
      calls++;
      await gate;
      return new Response("shared");
    };
    const coordinator = new RequestCoordinator({ limiter: rate.limiter, request: executor });

    const first = coordinator.request(
      "https://eu1.make.com/api/v2/scenarios?teamId=1",
      { headers: { Authorization: "Token first", Accept: "application/json" } },
      context(),
    );
    const second = coordinator.request(
      "https://eu1.make.com/api/v2/scenarios?teamId=1",
      { headers: { Authorization: "Token second", Accept: "application/json" } },
      context(),
    );
    release();

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(await firstResponse.text()).toBe("shared");
    expect(await secondResponse.text()).toBe("shared");
  });

  test("does not put a secret-bearing URL into an in-flight deduplication key", async () => {
    const rate = fakeLimiter();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = new RequestCoordinator({
      limiter: rate.limiter,
      request: async () => {
        calls++;
        await gate;
        return new Response("ok");
      },
    });

    const first = coordinator.request(
      "https://eu1.make.com/api/v2/scenarios?access_token=query-secret",
      {},
      context(),
    );
    const second = coordinator.request(
      "https://eu1.make.com/api/v2/scenarios?access_token=query-secret",
      {},
      context(),
    );
    release();
    await Promise.all([first, second]);

    expect(calls).toBe(2);
  });

  test("does not automatically retry an ambiguous mutation network failure", async () => {
    const rate = fakeLimiter();
    let calls = 0;
    const coordinator = new RequestCoordinator({
      limiter: rate.limiter,
      sleep: async () => {
        throw new Error("must not sleep");
      },
      request: async () => {
        calls++;
        throw new TypeError("connection reset");
      },
    });

    await expect(coordinator.request(
      "https://eu1.make.com/api/v2/scenarios/123",
      { method: "PATCH", body: "{}" },
      context(),
    )).rejects.toThrow("connection reset");
    expect(calls).toBe(1);
  });

  test("retries a mutation network failure only after reconciliation proves it was not applied", async () => {
    const time = fakeTime();
    const rate = fakeLimiter();
    let calls = 0;
    const coordinator = new RequestCoordinator({
      limiter: rate.limiter,
      now: time.now,
      sleep: time.sleep,
      random: () => 0,
      request: async () => {
        calls++;
        if (calls === 1) throw new TypeError("connection reset");
        return new Response("applied");
      },
    });

    const result = await coordinator.request(
      "https://eu1.make.com/api/v2/scenarios/123",
      { method: "PATCH", body: "{}" },
      context({ reconcileMutation: async () => "retry" }),
    );

    expect(await result.text()).toBe("applied");
    expect(calls).toBe(2);
    expect(time.sleeps).toEqual([0]);
  });

  test("cancellation rejects before a queued request is sent", async () => {
    const rate = fakeLimiter();
    let sent = 0;
    const controller = new AbortController();
    controller.abort("cancelled");
    const coordinator = new RequestCoordinator({
      limiter: rate.limiter,
      request: async () => {
        sent++;
        return new Response("unexpected");
      },
    });

    await expect(coordinator.request(
      "https://eu1.make.com/api/v2/scenarios",
      {},
      context({ signal: controller.signal }),
    )).rejects.toHaveProperty("name", "AbortError");
    expect(sent).toBe(0);
  });

  test("only the documented scenario run endpoint may skip organization reservations", async () => {
    const rate = fakeLimiter();
    const coordinator = new RequestCoordinator({
      limiter: rate.limiter,
      request: async () => new Response("ok"),
    });

    await coordinator.request(
      "https://eu1.make.com/api/v2/scenarios/123/run",
      { method: "POST" },
      context({ organizationRateExempt: true }),
    );
    await coordinator.request(
      "https://eu1.make.com/api/v2/scenarios",
      { method: "POST" },
      context({ organizationRateExempt: true }),
    );

    expect(rate.exemptRequests).toBe(1);
    expect(rate.reservations).toHaveLength(1);
  });
});
