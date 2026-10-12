// Minimal cross-process mutex using an exclusively created lock file (works on macOS, Linux, Windows).
// Used to serialize refresh-token rotation: Make's refresh tokens are single-use, so two
// processes refreshing the same grant concurrently would make one of them lose it.

import { closeSync, mkdirSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export interface LockOptions {
  timeoutMs?: number;
  /** A lock older than this is considered abandoned by a crashed process. */
  staleMs?: number;
  pollMs?: number;
}

export async function withFileLock<T>(path: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const staleMs = options.staleMs ?? 60_000;
  const pollMs = options.pollMs ?? 100;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      if (lockAge(path) > staleMs) {
        rmSync(path, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for lock ${path}.`);
      await Bun.sleep(pollMs);
    }
  }

  try {
    return await fn();
  } finally {
    rmSync(path, { force: true });
  }
}

function lockAge(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    // Removed between the failed create and this check: retry immediately.
    return Infinity;
  }
}
