import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const FALLBACK_RPM = 30;
const ROLLING_WINDOW_MS = 60_000;
const LIMIT_CACHE_TTL_MS = 60 * 60_000;
const CONTENTION_JITTER_MS = 250;
const MAX_IN_FLIGHT_PER_BUCKET = 2;
const INFLIGHT_LEASE_TTL_MS = 10 * 60_000;
const INFLIGHT_POLL_MS = 25;

export interface RateBucket {
  zone: string;
  organizationId: number | "unknown";
}

export interface RateLimitSnapshot {
  documentedRpm: number | null;
  effectiveRpm: number;
  limitSource: "organization_api" | "cache" | "fallback";
  requestsSent: number;
  retries: number;
  cooldownMs: number;
}

export interface SharedRateLimiterOptions {
  dbPath?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  pid?: number;
}

interface ReservationDecision {
  reserved: boolean;
  waitMs: number;
}

interface CountRow {
  count: number;
}

interface TimeRow {
  value: number;
}

interface LimitRow {
  api_limit: number;
  fetched_at_ms: number;
}

export function effectiveRequestsPerMinute(documentedRpm: number): number {
  return Math.max(1, Math.floor(documentedRpm * 0.95));
}

export function defaultRateDatabasePath(): string {
  return process.env.MAKE_FIXER_RATE_DB
    ?? join(homedir(), ".make-fixer", "state.sqlite");
}

function keyForBucket(bucket: RateBucket): string {
  return JSON.stringify([bucket.zone, bucket.organizationId]);
}

function abortError(signal?: AbortSignal): DOMException {
  if (signal?.reason instanceof DOMException && signal.reason.name === "AbortError") {
    return signal.reason;
  }
  return new DOMException("The operation was aborted", "AbortError");
}

async function sleepWithAbort(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw abortError(signal);
  if (!signal) {
    await sleep(ms);
    return;
  }

  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(abortError(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([sleep(ms), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export class SharedRateLimiter {
  private readonly db: Database;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly pid: number;
  private readonly apiLimitsFromThisInstance = new Set<string>();
  private readonly requestsSent = new Map<string, number>();
  private readonly retries = new Map<string, number>();

  constructor(options: SharedRateLimiterOptions = {}) {
    const dbPath = options.dbPath ?? defaultRateDatabasePath();
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true, strict: true });
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.pid = options.pid ?? process.pid;

    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS request_reservations (
        bucket TEXT NOT NULL,
        reserved_at_ms INTEGER NOT NULL,
        pid INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_request_reservations_bucket_time
        ON request_reservations(bucket, reserved_at_ms);
      CREATE TABLE IF NOT EXISTS rate_cooldowns (
        bucket TEXT PRIMARY KEY,
        until_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS organization_limits (
        bucket TEXT PRIMARY KEY,
        api_limit INTEGER NOT NULL,
        fetched_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inflight_leases (
        bucket TEXT NOT NULL,
        lease_id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        acquired_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_inflight_leases_bucket_expiry
        ON inflight_leases(bucket, expires_at_ms);
    `);
  }

  async reserve(bucket: RateBucket, rpm: number, signal?: AbortSignal): Promise<void> {
    const effectiveRpm = Math.max(1, Math.floor(rpm));
    const bucketKey = keyForBucket(bucket);

    while (true) {
      if (signal?.aborted) throw abortError(signal);
      const now = this.now();
      const decision = this.tryReserve(bucketKey, effectiveRpm, now);
      if (decision.reserved) {
        this.requestsSent.set(bucketKey, (this.requestsSent.get(bucketKey) ?? 0) + 1);
        return;
      }

      const jitterMs = Math.floor(this.random() * CONTENTION_JITTER_MS);
      await sleepWithAbort(this.sleep, decision.waitMs + jitterMs, signal);
    }
  }

  setCooldown(bucket: RateBucket, untilMs: number): void {
    const bucketKey = keyForBucket(bucket);
    this.db.query(`
      INSERT INTO rate_cooldowns (bucket, until_ms)
      VALUES (?, ?)
      ON CONFLICT(bucket) DO UPDATE SET until_ms = MAX(until_ms, excluded.until_ms)
    `).run(bucketKey, Math.floor(untilMs));
  }

  setOrganizationLimit(bucket: RateBucket, apiLimit: number, fetchedAtMs = this.now()): void {
    const bucketKey = keyForBucket(bucket);
    const normalizedLimit = Math.max(1, Math.floor(apiLimit));
    this.db.query(`
      INSERT INTO organization_limits (bucket, api_limit, fetched_at_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(bucket) DO UPDATE SET
        api_limit = excluded.api_limit,
        fetched_at_ms = excluded.fetched_at_ms
    `).run(bucketKey, normalizedLimit, Math.floor(fetchedAtMs));
    this.apiLimitsFromThisInstance.add(bucketKey);
  }

  noteRetry(bucket: RateBucket): void {
    const bucketKey = keyForBucket(bucket);
    this.retries.set(bucketKey, (this.retries.get(bucketKey) ?? 0) + 1);
  }

  recordExemptRequest(bucket: RateBucket): void {
    const bucketKey = keyForBucket(bucket);
    this.requestsSent.set(bucketKey, (this.requestsSent.get(bucketKey) ?? 0) + 1);
  }

  async acquireExecutionLease(
    bucket: RateBucket,
    signal?: AbortSignal,
  ): Promise<() => void> {
    const bucketKey = keyForBucket(bucket);
    const leaseId = `${this.pid}:${crypto.randomUUID()}`;

    while (true) {
      if (signal?.aborted) throw abortError(signal);
      if (this.tryAcquireExecutionLease(bucketKey, leaseId, this.now())) {
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.db.query("DELETE FROM inflight_leases WHERE lease_id = ?").run(leaseId);
        };
      }
      const jitterMs = Math.floor(this.random() * CONTENTION_JITTER_MS);
      await sleepWithAbort(this.sleep, INFLIGHT_POLL_MS + jitterMs, signal);
    }
  }

  getSnapshot(bucket: RateBucket): RateLimitSnapshot {
    const bucketKey = keyForBucket(bucket);
    const now = this.now();
    const limit = this.db.query<LimitRow, [string]>(`
      SELECT api_limit, fetched_at_ms
      FROM organization_limits
      WHERE bucket = ?
    `).get(bucketKey);
    const cooldown = this.db.query<TimeRow, [string]>(`
      SELECT until_ms AS value
      FROM rate_cooldowns
      WHERE bucket = ?
    `).get(bucketKey);
    const hasFreshLimit = limit !== null
      && limit.fetched_at_ms >= now - LIMIT_CACHE_TTL_MS;
    const documentedRpm = hasFreshLimit ? limit.api_limit : null;

    return {
      documentedRpm,
      effectiveRpm: documentedRpm === null
        ? FALLBACK_RPM
        : effectiveRequestsPerMinute(documentedRpm),
      limitSource: documentedRpm === null
        ? "fallback"
        : this.apiLimitsFromThisInstance.has(bucketKey)
          ? "organization_api"
          : "cache",
      requestsSent: this.requestsSent.get(bucketKey) ?? 0,
      retries: this.retries.get(bucketKey) ?? 0,
      cooldownMs: Math.max(0, (cooldown?.value ?? 0) - now),
    };
  }

  close(): void {
    this.db.close();
  }

  private tryReserve(bucketKey: string, rpm: number, now: number): ReservationDecision {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.query(`
        DELETE FROM request_reservations
        WHERE bucket = ? AND reserved_at_ms <= ?
      `).run(bucketKey, now - ROLLING_WINDOW_MS);
      this.db.query(`
        DELETE FROM rate_cooldowns
        WHERE bucket = ? AND until_ms <= ?
      `).run(bucketKey, now);

      const cooldown = this.db.query<TimeRow, [string]>(`
        SELECT until_ms AS value
        FROM rate_cooldowns
        WHERE bucket = ?
      `).get(bucketKey);
      if (cooldown && cooldown.value > now) {
        this.db.exec("COMMIT");
        return { reserved: false, waitMs: cooldown.value - now };
      }

      const count = this.db.query<CountRow, [string]>(`
        SELECT COUNT(*) AS count
        FROM request_reservations
        WHERE bucket = ?
      `).get(bucketKey)?.count ?? 0;
      if (count < rpm) {
        this.db.query(`
          INSERT INTO request_reservations (bucket, reserved_at_ms, pid)
          VALUES (?, ?, ?)
        `).run(bucketKey, now, this.pid);
        this.db.exec("COMMIT");
        return { reserved: true, waitMs: 0 };
      }

      const oldest = this.db.query<TimeRow, [string]>(`
        SELECT MIN(reserved_at_ms) AS value
        FROM request_reservations
        WHERE bucket = ?
      `).get(bucketKey)?.value ?? now;
      this.db.exec("COMMIT");
      return {
        reserved: false,
        waitMs: Math.max(1, oldest + ROLLING_WINDOW_MS - now),
      };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original database error.
      }
      throw error;
    }
  }

  private tryAcquireExecutionLease(
    bucketKey: string,
    leaseId: string,
    now: number,
  ): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.query(`
        DELETE FROM inflight_leases
        WHERE expires_at_ms <= ?
      `).run(now);
      const count = this.db.query<CountRow, [string]>(`
        SELECT COUNT(*) AS count
        FROM inflight_leases
        WHERE bucket = ?
      `).get(bucketKey)?.count ?? 0;
      if (count >= MAX_IN_FLIGHT_PER_BUCKET) {
        this.db.exec("COMMIT");
        return false;
      }
      this.db.query(`
        INSERT INTO inflight_leases (
          bucket,
          lease_id,
          pid,
          acquired_at_ms,
          expires_at_ms
        )
        VALUES (?, ?, ?, ?, ?)
      `).run(
        bucketKey,
        leaseId,
        this.pid,
        now,
        now + INFLIGHT_LEASE_TTL_MS,
      );
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original database error.
      }
      throw error;
    }
  }
}
