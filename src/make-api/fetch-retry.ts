export interface FetchRetryOptions {
  /** Maximum number of retries after the initial attempt. Default 5. */
  maxRetries?: number;
}

/** HTTP statuses that should trigger a retry. */
const RETRYABLE_STATUSES = new Set([429, 503]);

/** Exponential backoff schedule (ms) used when no Retry-After header is present. */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse the `Retry-After` header (integer seconds) into milliseconds.
 * Returns null when the header is absent or not a valid number.
 */
function parseRetryAfter(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (!header) return null;
  const seconds = parseInt(header.trim(), 10);
  if (Number.isNaN(seconds) || seconds < 0) return null;
  return seconds * 1000;
}

/**
 * `fetch` wrapper that rides through Make.com rate limits.
 *
 * - Retries on HTTP 429 and 503.
 * - Honors the `Retry-After` response header (integer seconds) when present,
 *   otherwise falls back to exponential backoff: 1s, 2s, 4s, 8s, 16s.
 * - Retries once on a thrown network error (fetch rejection) with a short backoff.
 * - After exhausting retries, returns the last response so the caller's existing
 *   `if (!res.ok) throw ...` logic can surface the error — it never swallows it.
 * - Logs each backoff to stderr so stdout/JSON output stays clean.
 */
export async function fetchWithRetry(
  url: string | URL | Request,
  init?: RequestInit,
  opts?: FetchRetryOptions,
): Promise<Response> {
  const maxRetries = opts?.maxRetries ?? 5;
  let networkRetried = false;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      // Retry once on a thrown network error with a short backoff.
      if (!networkRetried) {
        networkRetried = true;
        const waitSec = 1;
        console.error(
          `make-fixer: network error, retrying in ${waitSec}s (1/1): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        await sleep(waitSec * 1000);
        continue;
      }
      throw err;
    }

    if (!RETRYABLE_STATUSES.has(res.status) || attempt >= maxRetries) {
      return res;
    }

    const retryAfterMs = parseRetryAfter(res);
    const backoffMs = retryAfterMs ?? BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
    const waitSec = Math.round(backoffMs / 1000);
    console.error(
      `make-fixer: rate limited (${res.status}), retrying in ${waitSec}s (${attempt + 1}/${maxRetries})`,
    );
    await sleep(backoffMs);
  }
}
