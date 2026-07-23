import {
  SharedRateLimiter,
  type RateBucket,
  type RateLimitSnapshot,
} from "./rate-limiter";

const DEFAULT_REQUEST_RETRIES = 5;
const DEFAULT_COMMAND_RETRIES = 20;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_429_WAIT_MS = 60_000;
const SENSITIVE_QUERY_KEY = /(?:authorization|token|api[-_]?key|cookie|secret|password|credential)/i;
const SAFE_DEDUP_HEADERS = new Set([
  "accept",
  "content-type",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-unmodified-since",
  "range",
]);

export type RequestExecutor = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface RateLimiterStore {
  reserve(bucket: RateBucket, rpm: number, signal?: AbortSignal): Promise<void>;
  setCooldown(bucket: RateBucket, untilMs: number): void;
  getSnapshot(bucket: RateBucket): RateLimitSnapshot;
  noteRetry(bucket: RateBucket): void;
  recordExemptRequest(bucket: RateBucket): void;
}

export type MutationReconciliation = "retry" | Response | undefined;

export interface RequestContext {
  bucket: RateBucket;
  signal?: AbortSignal;
  maxRetries?: number;
  effectiveRpm?: number;
  organizationRateExempt?: boolean;
  networkRetrySafe?: boolean;
  reconcileMutation?: (error: unknown) => Promise<MutationReconciliation>;
}

export interface RequestCoordinatorOptions {
  limiter?: RateLimiterStore;
  request?: RequestExecutor;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxCommandRetries?: number;
}

export interface RequestCoordinatorLike {
  request(
    url: string | URL | Request,
    init: RequestInit,
    context: RequestContext,
  ): Promise<Response>;
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

export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

function methodOf(init: RequestInit): string {
  return (init.method ?? "GET").toUpperCase();
}

function isMutation(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method);
}

function isDocumentedRateExempt(url: string | URL | Request, init: RequestInit): boolean {
  if (methodOf(init) !== "POST") return false;
  const parsed = new URL(url instanceof Request ? url.url : String(url));
  return /^\/api\/v2\/scenarios\/[^/]+\/run\/?$/.test(parsed.pathname);
}

function deduplicationKey(url: string | URL | Request, init: RequestInit): string | null {
  if (methodOf(init) !== "GET") return null;
  const rawUrl = url instanceof Request ? url.url : String(url);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return null;
  }
  if ([...parsedUrl.searchParams.keys()].some((name) => SENSITIVE_QUERY_KEY.test(name))) {
    return null;
  }
  const headers = new Headers(init.headers);
  const safeHeaders = [...headers.entries()]
    .filter(([name]) => SAFE_DEDUP_HEADERS.has(name.toLowerCase()))
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(["GET", rawUrl, safeHeaders]);
}

export class RequestCoordinator implements RequestCoordinatorLike {
  private readonly limiter: RateLimiterStore;
  private readonly executor: RequestExecutor;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly maxCommandRetries: number;
  private commandRetries = 0;
  private readonly inFlightGets = new Map<string, Promise<Response>>();

  constructor(options: RequestCoordinatorOptions = {}) {
    this.limiter = options.limiter ?? new SharedRateLimiter();
    this.executor = options.request ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.maxCommandRetries = options.maxCommandRetries ?? DEFAULT_COMMAND_RETRIES;
  }

  async request(
    url: string | URL | Request,
    init: RequestInit = {},
    context: RequestContext,
  ): Promise<Response> {
    if (context.signal?.aborted) throw abortError(context.signal);
    const key = deduplicationKey(url, init);
    if (!key) return this.execute(url, init, context);

    let pending = this.inFlightGets.get(key);
    if (!pending) {
      pending = this.execute(url, init, context);
      this.inFlightGets.set(key, pending);
      void pending.finally(() => {
        if (this.inFlightGets.get(key) === pending) this.inFlightGets.delete(key);
      }).catch(() => undefined);
    }
    return (await pending).clone();
  }

  private async execute(
    url: string | URL | Request,
    init: RequestInit,
    context: RequestContext,
  ): Promise<Response> {
    const method = methodOf(init);
    const signal = context.signal ?? init.signal ?? undefined;
    const maxRetries = context.maxRetries ?? DEFAULT_REQUEST_RETRIES;
    const exempt = context.organizationRateExempt === true
      && isDocumentedRateExempt(url, { ...init, method });
    let boundedRetries = 0;

    while (true) {
      if (signal?.aborted) throw abortError(signal);
      if (exempt) {
        this.limiter.recordExemptRequest(context.bucket);
      } else {
        const rpm = context.effectiveRpm
          ?? this.limiter.getSnapshot(context.bucket).effectiveRpm;
        await this.limiter.reserve(context.bucket, rpm, signal);
      }
      if (signal?.aborted) throw abortError(signal);

      let response: Response;
      try {
        response = await this.executor(url, { ...init, method, signal });
      } catch (error) {
        if (signal?.aborted) throw abortError(signal);
        if (isMutation(method) && !context.networkRetrySafe) {
          const reconciliation = await context.reconcileMutation?.(error);
          if (reconciliation instanceof Response) return reconciliation;
          if (reconciliation !== "retry") throw error;
        }
        if (!this.consumeBoundedRetry(context.bucket, boundedRetries, maxRetries)) throw error;
        boundedRetries++;
        await sleepWithAbort(
          this.sleep,
          this.fullJitterDelay(boundedRetries),
          signal,
        );
        continue;
      }

      if (response.status === 429) {
        this.limiter.noteRetry(context.bucket);
        const waitMs = parseRetryAfter(response.headers.get("retry-after"), this.now())
          ?? DEFAULT_429_WAIT_MS;
        this.limiter.setCooldown(context.bucket, this.now() + waitMs);
        await response.body?.cancel();
        await sleepWithAbort(this.sleep, waitMs, signal);
        continue;
      }

      if (response.status !== 503) return response;
      if (!this.consumeBoundedRetry(context.bucket, boundedRetries, maxRetries)) {
        return response;
      }
      boundedRetries++;
      await response.body?.cancel();
      await sleepWithAbort(
        this.sleep,
        this.fullJitterDelay(boundedRetries),
        signal,
      );
    }
  }

  private consumeBoundedRetry(
    bucket: RateBucket,
    requestRetries: number,
    maxRequestRetries: number,
  ): boolean {
    if (requestRetries >= maxRequestRetries) return false;
    if (this.commandRetries >= this.maxCommandRetries) return false;
    this.commandRetries++;
    this.limiter.noteRetry(bucket);
    return true;
  }

  private fullJitterDelay(retryNumber: number): number {
    const cap = Math.min(MAX_BACKOFF_MS, 1_000 * (2 ** (retryNumber - 1)));
    return Math.floor(this.random() * cap);
  }
}

let defaultCoordinator: RequestCoordinator | undefined;

export function getDefaultRequestCoordinator(): RequestCoordinator {
  defaultCoordinator ??= new RequestCoordinator();
  return defaultCoordinator;
}
