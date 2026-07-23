import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RequestCoordinator,
  type RequestContext,
  type RequestExecutor,
  type RateLimiterStore,
} from "./request-coordinator";
import {
  SharedRateLimiter,
  type RateBucket,
  type RateLimitSnapshot,
} from "./rate-limiter";

const bucket: RateBucket = { zone: "eu1", organizationId: 8430514 };
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
  let leaseReleases = 0;
  const limits: Array<{ bucket: RateBucket; rpm: number }> = [];
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
    waitForCooldown: async () => undefined,
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
    setOrganizationLimit: (limitedBucket, rpm) => {
      limits.push({ bucket: limitedBucket, rpm });
    },
    acquireExecutionLease: async () => () => {
      leaseReleases++;
    },
  };
  return {
    limiter,
    reservations,
    cooldowns,
    limits,
    get retries() { return retries; },
    get exemptRequests() { return exemptRequests; },
    get leaseReleases() { return leaseReleases; },
  };
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

  test("deduplicates identical in-flight GETs for the same credential and bucket", async () => {
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
      { headers: { Authorization: "Token same", Accept: "application/json" } },
      context(),
    );
    const second = coordinator.request(
      "https://eu1.make.com/api/v2/scenarios?teamId=1",
      { headers: { Authorization: "Token same", Accept: "application/json" } },
      context(),
    );
    release();

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(await firstResponse.text()).toBe("shared");
    expect(await secondResponse.text()).toBe("shared");
  });

  test("never deduplicates across authorization, cookie, API-key identities, or organization buckets", async () => {
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

    const firstToken = coordinator.request(
      "https://eu1.make.com/api/v2/scenarios",
      { headers: { Authorization: "Token first-secret" } },
      context(),
    );
    const secondToken = coordinator.request(
      "https://eu1.make.com/api/v2/scenarios",
      { headers: { Authorization: "Token second-secret" } },
      context(),
    );
    const secondOrganization = coordinator.request(
      "https://eu1.make.com/api/v2/scenarios",
      { headers: { Authorization: "Token first-secret" } },
      context({ bucket: { zone: "eu1", organizationId: 999 } }),
    );
    const firstCookie = coordinator.request(
      "https://eu1.make.com/api/v2/teams",
      { headers: { Cookie: "session=first-cookie-secret" } },
      context(),
    );
    const secondCookie = coordinator.request(
      "https://eu1.make.com/api/v2/teams",
      { headers: { Cookie: "session=second-cookie-secret" } },
      context(),
    );
    const firstApiKey = coordinator.request(
      "https://eu1.make.com/api/v2/hooks",
      { headers: { "X-API-Key": "first-api-key-secret" } },
      context(),
    );
    const secondApiKey = coordinator.request(
      "https://eu1.make.com/api/v2/hooks",
      { headers: { "X-API-Key": "second-api-key-secret" } },
      context(),
    );
    release();
    await Promise.all([
      firstToken,
      secondToken,
      secondOrganization,
      firstCookie,
      secondCookie,
      firstApiKey,
      secondApiKey,
    ]);

    expect(calls).toBe(7);
  });

  test("keeps dedup keys opaque for credentials and secrets in userinfo, paths, and arbitrary queries", async () => {
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
    const secretUrls = [
      "https://user:userinfo-secret@eu1.make.com/api/v2/scenarios",
      "https://eu1.make.com/api/path-secret/scenarios",
      "https://eu1.make.com/api/v2/scenarios?arbitrary=query-secret",
    ];
    const requests = secretUrls.flatMap((url) => [
      coordinator.request(url, { headers: { Authorization: "Token header-secret" } }, context()),
      coordinator.request(url, { headers: { Authorization: "Token header-secret" } }, context()),
    ]);
    release();
    await Promise.all(requests);

    expect(calls).toBe(3);
  });

  test("one deduplicated caller can abort without failing a live follower", async () => {
    const rate = fakeLimiter();
    let calls = 0;
    let notifyFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      notifyFirstStarted = resolve;
    });
    const firstController = new AbortController();
    const coordinator = new RequestCoordinator({
      limiter: rate.limiter,
      request: async (input, init) => {
        calls++;
        if (calls === 1) notifyFirstStarted();
        const signal = input instanceof Request ? input.signal : init?.signal;
        if (signal) {
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => reject(new DOMException("aborted", "AbortError"));
            signal.addEventListener("abort", onAbort, { once: true });
            setTimeout(resolve, 0);
          });
        }
        return new Response("ok");
      },
    });

    const first = coordinator.request(
      "https://eu1.make.com/api/v2/scenarios",
      { headers: { Authorization: "Token same" } },
      context({ signal: firstController.signal }),
    );
    const follower = coordinator.request(
      "https://eu1.make.com/api/v2/scenarios",
      { headers: { Authorization: "Token same" } },
      context(),
    );
    await firstStarted;
    firstController.abort();

    await expect(first).rejects.toHaveProperty("name", "AbortError");
    expect(await (await follower).text()).toBe("ok");
    expect(calls).toBe(2);
  });

  test("coordinates the max-two executor cap across coordinator instances sharing SQLite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "make-fixer-inflight-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "rate.sqlite");
    const leaseWaiters: Array<() => void> = [];
    const limiterOptions = {
      dbPath,
      now: () => 0,
      random: () => 0,
      sleep: async () => {
        await new Promise<void>((resolve) => leaseWaiters.push(resolve));
      },
    };
    const firstLimiter = new SharedRateLimiter({ ...limiterOptions, pid: 101 });
    const secondLimiter = new SharedRateLimiter({ ...limiterOptions, pid: 202 });
    let active = 0;
    let maxActive = 0;
    const executorReleases: Array<() => void> = [];
    const executor: RequestExecutor = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => executorReleases.push(resolve));
      active--;
      return new Response("ok");
    };
    const firstCoordinator = new RequestCoordinator({ limiter: firstLimiter, request: executor });
    const secondCoordinator = new RequestCoordinator({ limiter: secondLimiter, request: executor });

    const requests = [
      firstCoordinator.request("https://eu1.make.com/api/v2/scenarios/1", {}, context()),
      secondCoordinator.request("https://eu1.make.com/api/v2/scenarios/2", {}, context()),
      secondCoordinator.request("https://eu1.make.com/api/v2/scenarios/3", {}, context()),
    ];
    for (let tick = 0; tick < 8; tick++) await Promise.resolve();
    expect(active).toBe(2);
    expect(maxActive).toBe(2);

    executorReleases.shift()!();
    for (let tick = 0; tick < 5; tick++) await Promise.resolve();
    leaseWaiters.shift()!();
    for (let tick = 0; tick < 8; tick++) await Promise.resolve();
    expect(maxActive).toBe(2);

    while (executorReleases.length > 0) executorReleases.shift()!();
    await Promise.all(requests);
    firstLimiter.close();
    secondLimiter.close();
  });

  test("heartbeats keep cross-process leases valid beyond the initial TTL", async () => {
    const directory = mkdtempSync(join(tmpdir(), "make-fixer-heartbeat-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "rate.sqlite");
    let now = 0;
    const leaseWaiters: Array<() => void> = [];
    const callbacks = new Set<() => void>();
    const limiterOptions = {
      dbPath,
      now: () => now,
      random: () => 0,
      sleep: async () => {
        await new Promise<void>((resolve) => leaseWaiters.push(resolve));
      },
    };
    const firstLimiter = new SharedRateLimiter({ ...limiterOptions, pid: 101 });
    const secondLimiter = new SharedRateLimiter({ ...limiterOptions, pid: 202 });
    let active = 0;
    let maxActive = 0;
    const executorReleases: Array<() => void> = [];
    const executor: RequestExecutor = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => executorReleases.push(resolve));
      active--;
      return new Response("ok");
    };
    const coordinatorOptions = {
      request: executor,
      scheduleInterval: (callback: () => void) => {
        callbacks.add(callback);
        return callback;
      },
      clearInterval: (handle: unknown) => {
        callbacks.delete(handle as () => void);
      },
    };
    const firstCoordinator = new RequestCoordinator({
      ...coordinatorOptions,
      limiter: firstLimiter,
    });
    const secondCoordinator = new RequestCoordinator({
      ...coordinatorOptions,
      limiter: secondLimiter,
    });

    const first = firstCoordinator.request(
      "https://eu1.make.com/api/v2/scenarios/1",
      {},
      context(),
    );
    const second = secondCoordinator.request(
      "https://eu1.make.com/api/v2/scenarios/2",
      {},
      context(),
    );
    for (let tick = 0; tick < 8; tick++) await Promise.resolve();
    expect(active).toBe(2);

    now = 300_000;
    for (const callback of [...callbacks]) callback();
    now = 600_001;
    const third = secondCoordinator.request(
      "https://eu1.make.com/api/v2/scenarios/3",
      {},
      context(),
    );
    for (let tick = 0; tick < 8; tick++) await Promise.resolve();

    expect(active).toBe(2);
    expect(maxActive).toBe(2);
    executorReleases.shift()!();
    for (let tick = 0; tick < 5; tick++) await Promise.resolve();
    leaseWaiters.shift()!();
    for (let tick = 0; tick < 8; tick++) await Promise.resolve();
    while (executorReleases.length > 0) executorReleases.shift()!();
    await Promise.all([first, second, third]);
    expect(callbacks.size).toBe(0);
    firstLimiter.close();
    secondLimiter.close();
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
    expect(rate.leaseReleases).toBe(1);
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

  test("an exempt run observes another process shared cooldown without reserving RPM", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const directory = mkdtempSync(join(tmpdir(), "make-fixer-exempt-cooldown-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "rate.sqlite");
    const writer = new SharedRateLimiter({ dbPath, now: () => now });
    const waiter = new SharedRateLimiter({
      dbPath,
      now: () => now,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    writer.setCooldown(bucket, 2_000);
    let sentAt = -1;
    const coordinator = new RequestCoordinator({
      limiter: waiter,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      request: async () => {
        sentAt = now;
        return new Response("ok");
      },
    });

    await coordinator.request(
      "https://eu1.make.com/api/v2/scenarios/123/run",
      { method: "POST" },
      context({ organizationRateExempt: true }),
    );

    expect(sentAt).toBe(2_000);
    expect(sleeps).toEqual([2_000]);
    expect(waiter.getSnapshot(bucket).requestsSent).toBe(1);
    writer.close();
    waiter.close();
  });

  test("acquires the execution lease before making a fresh send-adjacent reservation", async () => {
    let now = 0;
    const events: string[] = [];
    const limiter: RateLimiterStore = {
      getSnapshot: () => ({
        documentedRpm: 60,
        effectiveRpm: 57,
        limitSource: "organization_api",
        requestsSent: 0,
        retries: 0,
        cooldownMs: 0,
      }),
      acquireExecutionLease: async () => {
        events.push(`lease:${now}`);
        now = 61_000;
        return () => events.push(`release:${now}`);
      },
      waitForCooldown: async () => {
        events.push(`cooldown:${now}`);
      },
      reserve: async (_bucket, rpm) => {
        events.push(`reserve:${rpm}:${now}`);
      },
      setCooldown: () => undefined,
      noteRetry: () => undefined,
      recordExemptRequest: () => undefined,
      setOrganizationLimit: () => undefined,
    };
    const coordinator = new RequestCoordinator({
      limiter,
      request: async () => {
        events.push(`send:${now}`);
        return new Response("ok");
      },
    });

    await coordinator.request("https://eu1.make.com/api/v2/scenarios/1", {}, context());

    expect(events).toEqual([
      "lease:0",
      "cooldown:61000",
      "reserve:57:61000",
      "send:61000",
      "release:61000",
    ]);
  });

  test("clamps effective RPM overrides to the discovered allowance", async () => {
    const rpms: number[] = [];
    const limiter: RateLimiterStore = {
      reserve: async (_bucket, rpm) => {
        rpms.push(rpm);
      },
      waitForCooldown: async () => undefined,
      setCooldown: () => undefined,
      getSnapshot: () => ({
        documentedRpm: 60,
        effectiveRpm: 57,
        limitSource: "organization_api",
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
      request: async () => new Response("ok"),
    });

    await coordinator.request(
      "https://eu1.make.com/api/v2/scenarios/1",
      {},
      context({ effectiveRpm: 100 }),
    );
    await coordinator.request(
      "https://eu1.make.com/api/v2/scenarios/2",
      {},
      context({ effectiveRpm: 10 }),
    );

    expect(rpms).toEqual([57, 10]);
  });
});
