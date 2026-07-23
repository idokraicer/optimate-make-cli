import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FALLBACK_RPM,
  SharedRateLimiter,
  effectiveRequestsPerMinute,
  type RateBucket,
} from "./rate-limiter";

const bucket: RateBucket = { zone: "eu1", organizationId: 8430514 };
const temporaryDirectories: string[] = [];

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "make-fixer-rate-"));
  temporaryDirectories.push(directory);
  return join(directory, "rate.sqlite");
}

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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SharedRateLimiter", () => {
  test("uses 95 percent of a documented allowance rounded down", () => {
    expect(effectiveRequestsPerMinute(60)).toBe(57);
    expect(effectiveRequestsPerMinute(1)).toBe(1);
  });

  test("uses a conservative 30 RPM fallback", () => {
    const limiter = new SharedRateLimiter({ dbPath: temporaryDatabasePath() });

    expect(FALLBACK_RPM).toBe(30);
    expect(limiter.getSnapshot(bucket)).toMatchObject({
      documentedRpm: null,
      effectiveRpm: 30,
      limitSource: "fallback",
    });
    limiter.close();
  });

  test("the 58th reservation waits until the oldest leaves the rolling window", async () => {
    const time = fakeTime();
    const limiter = new SharedRateLimiter({
      dbPath: temporaryDatabasePath(),
      now: time.now,
      sleep: time.sleep,
      random: () => 0,
    });

    for (let request = 0; request < 57; request++) {
      await limiter.reserve(bucket, effectiveRequestsPerMinute(60));
    }
    await limiter.reserve(bucket, effectiveRequestsPerMinute(60));

    expect(time.sleeps).toEqual([60_000]);
    expect(limiter.getSnapshot(bucket).requestsSent).toBe(58);
    limiter.close();
  });

  test("two limiter instances see reservations in the same database", async () => {
    const time = fakeTime();
    const dbPath = temporaryDatabasePath();
    const first = new SharedRateLimiter({
      dbPath,
      now: time.now,
      sleep: time.sleep,
      random: () => 0,
      pid: 101,
    });
    const second = new SharedRateLimiter({
      dbPath,
      now: time.now,
      sleep: time.sleep,
      random: () => 0,
      pid: 202,
    });

    await first.reserve(bucket, 1);
    await second.reserve(bucket, 1);

    expect(time.sleeps).toEqual([60_000]);
    first.close();
    second.close();
  });

  test("a cooldown written by one instance blocks another instance", async () => {
    const time = fakeTime(1_000);
    const dbPath = temporaryDatabasePath();
    const first = new SharedRateLimiter({ dbPath, now: time.now, sleep: time.sleep });
    const second = new SharedRateLimiter({
      dbPath,
      now: time.now,
      sleep: time.sleep,
      random: () => 0,
    });

    first.setCooldown(bucket, 3_500);
    await second.reserve(bucket, 30);

    expect(time.sleeps).toEqual([2_500]);
    first.close();
    second.close();
  });

  test("cooldown-only waiting rechecks when another process extends the cooldown", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const dbPath = temporaryDatabasePath();
    const writer = new SharedRateLimiter({ dbPath, now: () => now });
    let extended = false;
    const waiter = new SharedRateLimiter({
      dbPath,
      now: () => now,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
        if (!extended) {
          extended = true;
          writer.setCooldown(bucket, now + 2_000);
        }
      },
    });
    writer.setCooldown(bucket, 1_000);

    await waiter.waitForCooldown(bucket);

    expect(sleeps).toEqual([1_000, 2_000]);
    expect(waiter.getSnapshot(bucket).requestsSent).toBe(0);
    writer.close();
    waiter.close();
  });

  test("aborting after a reservation begins waiting prevents it from being granted", async () => {
    const dbPath = temporaryDatabasePath();
    let notifySleeping!: () => void;
    const sleeping = new Promise<void>((resolve) => {
      notifySleeping = resolve;
    });
    const limiter = new SharedRateLimiter({
      dbPath,
      now: () => 0,
      sleep: async () => {
        notifySleeping();
        await new Promise<void>(() => undefined);
      },
      random: () => 0,
    });
    await limiter.reserve(bucket, 1);
    const controller = new AbortController();

    const queued = limiter.reserve(bucket, 1, controller.signal);
    await sleeping;
    controller.abort();

    await expect(queued).rejects.toHaveProperty("name", "AbortError");
    expect(limiter.getSnapshot(bucket).requestsSent).toBe(1);
    limiter.close();
  });

  test("aborting while waiting for a cross-process executor lease does not acquire it", async () => {
    const dbPath = temporaryDatabasePath();
    let notifySleeping!: () => void;
    const sleeping = new Promise<void>((resolve) => {
      notifySleeping = resolve;
    });
    const limiter = new SharedRateLimiter({
      dbPath,
      now: () => 0,
      sleep: async () => {
        notifySleeping();
        await new Promise<void>(() => undefined);
      },
      random: () => 0,
    });
    const releaseFirst = await limiter.acquireExecutionLease(bucket);
    const releaseSecond = await limiter.acquireExecutionLease(bucket);
    const controller = new AbortController();

    const queued = limiter.acquireExecutionLease(bucket, controller.signal);
    await sleeping;
    controller.abort();

    await expect(queued).rejects.toHaveProperty("name", "AbortError");
    releaseFirst();
    releaseSecond();
    limiter.close();
  });

  test("stale unrenewed crash leases expire after ten minutes", async () => {
    let now = 0;
    const limiter = new SharedRateLimiter({
      dbPath: temporaryDatabasePath(),
      now: () => now,
      random: () => 0,
    });
    const first = await limiter.acquireExecutionLease(bucket);
    const second = await limiter.acquireExecutionLease(bucket);

    now = 600_001;
    const recovered = await limiter.acquireExecutionLease(bucket);

    const release = (lease: unknown) => {
      if (typeof lease === "function") lease();
      else (lease as { release: () => void }).release();
    };
    release(first);
    release(second);
    release(recovered);
    limiter.close();
  });

  test("stores a discovered organization limit for other processes to reuse", () => {
    const time = fakeTime(10_000);
    const dbPath = temporaryDatabasePath();
    const first = new SharedRateLimiter({ dbPath, now: time.now, sleep: time.sleep });
    const second = new SharedRateLimiter({ dbPath, now: time.now, sleep: time.sleep });

    first.setOrganizationLimit(bucket, 60);

    expect(first.getSnapshot(bucket)).toMatchObject({
      documentedRpm: 60,
      effectiveRpm: 57,
      limitSource: "organization_api",
    });
    expect(second.getSnapshot(bucket)).toMatchObject({
      documentedRpm: 60,
      effectiveRpm: 57,
      limitSource: "cache",
    });
    first.close();
    second.close();
  });
});
