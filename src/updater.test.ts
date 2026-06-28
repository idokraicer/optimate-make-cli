import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareSemver,
  shouldCheck,
  resolveIntervalMs,
  isDevCheckout,
  checkForUpdate,
  DEFAULT_INTERVAL_MS,
  type CheckDeps,
} from "./updater";

describe("compareSemver", () => {
  test("returns positive when a > b", () => {
    expect(compareSemver("0.2.0", "0.1.0")).toBeGreaterThan(0);
  });

  test("returns negative when a < b", () => {
    expect(compareSemver("0.1.0", "0.2.0")).toBeLessThan(0);
  });

  test("returns zero when equal", () => {
    expect(compareSemver("0.1.0", "0.1.0")).toBe(0);
  });

  test("compares numerically, not lexically (0.10.0 > 0.9.0)", () => {
    expect(compareSemver("0.10.0", "0.9.0")).toBeGreaterThan(0);
  });

  test("major version dominates (1.0.0 > 0.99.99)", () => {
    expect(compareSemver("1.0.0", "0.99.99")).toBeGreaterThan(0);
  });

  test("pads missing components with zero (0.2 > 0.1.0)", () => {
    expect(compareSemver("0.2", "0.1.0")).toBeGreaterThan(0);
  });
});

describe("shouldCheck", () => {
  test("checks when never checked before (null)", () => {
    expect(shouldCheck(null, 1000, 200)).toBe(true);
  });

  test("skips when inside the throttle window", () => {
    expect(shouldCheck(1000, 1100, 200)).toBe(false);
  });

  test("checks when outside the throttle window", () => {
    expect(shouldCheck(1000, 1300, 200)).toBe(true);
  });

  test("checks exactly at the boundary", () => {
    expect(shouldCheck(1000, 1200, 200)).toBe(true);
  });
});

describe("resolveIntervalMs", () => {
  test("defaults when unset", () => {
    expect(resolveIntervalMs({})).toBe(DEFAULT_INTERVAL_MS);
  });

  test("reads whole hours from the env var", () => {
    expect(resolveIntervalMs({ MAKE_FIXER_UPDATE_INTERVAL: "2" })).toBe(2 * 3600_000);
  });

  test("accepts fractional hours", () => {
    expect(resolveIntervalMs({ MAKE_FIXER_UPDATE_INTERVAL: "0.5" })).toBe(1_800_000);
  });

  test("falls back to default on non-numeric input", () => {
    expect(resolveIntervalMs({ MAKE_FIXER_UPDATE_INTERVAL: "abc" })).toBe(DEFAULT_INTERVAL_MS);
  });

  test("falls back to default on zero or negative input", () => {
    expect(resolveIntervalMs({ MAKE_FIXER_UPDATE_INTERVAL: "0" })).toBe(DEFAULT_INTERVAL_MS);
    expect(resolveIntervalMs({ MAKE_FIXER_UPDATE_INTERVAL: "-5" })).toBe(DEFAULT_INTERVAL_MS);
  });
});

describe("isDevCheckout", () => {
  const dirs: string[] = [];
  const makeTmp = () => {
    const d = mkdtempSync(join(tmpdir(), "updater-test-"));
    dirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("true when a .git directory exists at the package root", async () => {
    const root = makeTmp();
    mkdirSync(join(root, ".git"));
    expect(await isDevCheckout(root)).toBe(true);
  });

  test("false when there is no .git", async () => {
    const root = makeTmp();
    expect(await isDevCheckout(root)).toBe(false);
  });
});

describe("checkForUpdate", () => {
  type Calls = { fetched: number; install: number; stamps: number[]; logs: string[] };

  const makeDeps = (overrides: Partial<CheckDeps> = {}) => {
    const calls: Calls = { fetched: 0, install: 0, stamps: [], logs: [] };
    const deps: CheckDeps = {
      now: () => 10_000,
      env: {},
      isDev: async () => false,
      readLastCheck: async () => null,
      stampLastCheck: async (ms: number) => {
        calls.stamps.push(ms);
      },
      fetchRemoteVersion: async () => {
        calls.fetched++;
        return "1.0.0";
      },
      runInstall: async () => {
        calls.install++;
        return true;
      },
      log: (m: string) => {
        calls.logs.push(m);
      },
      ...overrides,
    };
    return { deps, calls };
  };

  test("reinstalls when a newer version is available", async () => {
    const { deps, calls } = makeDeps({ fetchRemoteVersion: async () => "1.0.0" });
    await checkForUpdate("0.1.0", deps);
    expect(calls.install).toBe(1);
    expect(calls.stamps).toEqual([10_000]);
    expect(calls.logs.join("")).toContain("0.1.0 → 1.0.0");
  });

  test("does not reinstall when already up to date", async () => {
    const { deps, calls } = makeDeps({ fetchRemoteVersion: async () => "0.1.0" });
    await checkForUpdate("0.1.0", deps);
    expect(calls.install).toBe(0);
    expect(calls.stamps).toEqual([10_000]); // throttle still advances
  });

  test("skips everything when opted out via MAKE_FIXER_NO_UPDATE", async () => {
    const { deps, calls } = makeDeps({ env: { MAKE_FIXER_NO_UPDATE: "1" } });
    await checkForUpdate("0.1.0", deps);
    expect(calls.fetched).toBe(0);
    expect(calls.install).toBe(0);
    expect(calls.stamps).toEqual([]);
  });

  test("skips on a dev checkout without touching the network", async () => {
    const { deps, calls } = makeDeps({ isDev: async () => true });
    await checkForUpdate("0.1.0", deps);
    expect(calls.fetched).toBe(0);
    expect(calls.install).toBe(0);
  });

  test("skips while inside the throttle window", async () => {
    const { deps, calls } = makeDeps({
      now: () => 10_000,
      readLastCheck: async () => 9_990, // 10ms ago, far inside the default 4h window
    });
    await checkForUpdate("0.1.0", deps);
    expect(calls.fetched).toBe(0);
    expect(calls.install).toBe(0);
  });

  test("stamps the timestamp even when the remote check fails (offline)", async () => {
    const { deps, calls } = makeDeps({ fetchRemoteVersion: async () => null });
    await checkForUpdate("0.1.0", deps);
    expect(calls.install).toBe(0);
    expect(calls.stamps).toEqual([10_000]);
  });

  test("logs failure and never throws when the reinstall fails", async () => {
    let installCalled = 0;
    const { deps, calls } = makeDeps({
      fetchRemoteVersion: async () => "1.0.0",
      runInstall: async () => {
        installCalled++;
        return false;
      },
    });
    await checkForUpdate("0.1.0", deps);
    expect(installCalled).toBe(1);
    expect(calls.logs.join("").toLowerCase()).toContain("failed");
  });
});
