import {
  getDefaultRequestCoordinator,
  type RequestCoordinatorLike,
} from "./request-coordinator";

export interface FetchRetryOptions {
  /** Maximum number of retries after the initial attempt. Default 5. */
  maxRetries?: number;
  /** Injectable coordinator for deterministic tests and embedded callers. */
  coordinator?: RequestCoordinatorLike;
}

function zoneFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/\.make\.com$/, "");
  } catch {
    return "unknown";
  }
}

/**
 * `fetch` wrapper that rides through Make.com rate limits.
 *
 * Backward-compatible wrapper over the shared request coordinator. Calls made
 * without organization metadata use the conservative `unknown` bucket.
 */
export async function fetchWithRetry(
  url: string | URL | Request,
  init?: RequestInit,
  opts?: FetchRetryOptions,
): Promise<Response> {
  const coordinator = opts?.coordinator ?? getDefaultRequestCoordinator();
  const request = url instanceof Request ? url : null;
  const requestUrl = request ?? url;
  const requestInit: RequestInit = init ?? {};

  return coordinator.request(requestUrl, requestInit, {
    bucket: {
      zone: zoneFromUrl(request instanceof Request ? request.url : String(requestUrl)),
      organizationId: "unknown",
    },
    maxRetries: opts?.maxRetries,
    signal: requestInit.signal ?? undefined,
  });
}
