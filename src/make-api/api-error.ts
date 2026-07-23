const MAX_PROVIDER_MESSAGE_LENGTH = 2_000;
const MAX_PROVIDER_BODY_BYTES = MAX_PROVIDER_MESSAGE_LENGTH * 4;

export type ApiErrorCode =
  | "AUTH_INVALID"
  | "SCOPE_MISSING"
  | "PLAN_RESTRICTED"
  | "NOT_SUPPORTED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "TRANSIENT"
  | "INVALID_DATA"
  | "UNKNOWN_API_ERROR";

export interface ClassifiedApiError {
  code: ApiErrorCode;
  message: string;
  httpStatus: number | null;
  providerCode: string | null;
  retryable: boolean;
}

interface BoundedResponseText {
  text: string;
  truncated: boolean;
}

const SENSITIVE_KEY = /(?:authorization|token|api[-_]?key|cookie|secret|password|credential)/i;
const SENSITIVE_TEXT_ASSIGNMENT = /(^|[^A-Za-z0-9_-])["']?[A-Za-z0-9_-]*(?:token|secret|password|credential|authorization|cookie|api[_-]?key)[A-Za-z0-9_-]*["']?\s*[:=]/i;

function classifyStatus(status: number): Pick<ClassifiedApiError, "code" | "retryable"> {
  if (status === 401) return { code: "AUTH_INVALID", retryable: false };
  if (status === 402) return { code: "PLAN_RESTRICTED", retryable: false };
  if (status === 403) return { code: "SCOPE_MISSING", retryable: false };
  if (status === 404) return { code: "NOT_FOUND", retryable: false };
  if (status === 405 || status === 501) return { code: "NOT_SUPPORTED", retryable: false };
  if (status === 429) return { code: "RATE_LIMITED", retryable: true };
  if (status === 400 || status === 409 || status === 422) return { code: "INVALID_DATA", retryable: false };
  if (status >= 500 && status <= 599) return { code: "TRANSIENT", retryable: true };
  return { code: "UNKNOWN_API_ERROR", retryable: false };
}

async function readBoundedResponseText(response: Response): Promise<BoundedResponseText> {
  const reader = response.clone().body?.getReader();
  if (!reader) return { text: "", truncated: false };

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const available = MAX_PROVIDER_BODY_BYTES - byteLength;
      if (available <= 0) {
        truncated = true;
        await reader.cancel();
        break;
      }

      if (value.byteLength > available) {
        chunks.push(value.slice(0, available));
        byteLength += available;
        truncated = true;
        await reader.cancel();
        break;
      }

      chunks.push(value);
      byteLength += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    text: new TextDecoder().decode(body),
    truncated,
  };
}

function sanitizeProviderValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeProviderText(value);
  if (Array.isArray(value)) return value.map(sanitizeProviderValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeProviderValue(child),
    ]),
  );
}

function sanitizeProviderText(text: string): string {
  return text
    .split(/\r?\n/)
    .map(sanitizeProviderLine)
    .join("\n");
}

function sanitizeProviderLine(line: string): string {
  const assignment = line.match(SENSITIVE_TEXT_ASSIGNMENT);
  if (assignment?.index !== undefined) {
    const sensitiveKeyIndex = assignment.index + assignment[1].length;
    return `${line.slice(0, sensitiveKeyIndex)}[REDACTED]`;
  }

  return line.replace(/\b(Bearer|Token)\s+[^\s,;]+/gi, "$1 [REDACTED]");
}

function valueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function firstValueAtPaths(value: unknown, paths: string[]): unknown {
  for (const path of paths) {
    const candidate = valueAtPath(value, path);
    if (candidate !== undefined && candidate !== null) return candidate;
  }
  return undefined;
}

function providerMessage(payload: unknown, fallback: string): string {
  const message = firstValueAtPaths(payload, ["message", "error.message", "detail", "description", "error"]);
  if (message === undefined) {
    const serialized = JSON.stringify(sanitizeProviderValue(payload));
    return serialized === undefined ? fallback : serialized.slice(0, MAX_PROVIDER_MESSAGE_LENGTH);
  }

  if (typeof message === "string") return sanitizeProviderText(message).slice(0, MAX_PROVIDER_MESSAGE_LENGTH);
  return JSON.stringify(sanitizeProviderValue(message)).slice(0, MAX_PROVIDER_MESSAGE_LENGTH);
}

/**
 * Converts an unsuccessful Make API response into a stable, safe result while
 * leaving the caller's response body readable.
 */
export async function classifyApiResponse(response: Response): Promise<ClassifiedApiError> {
  const { text, truncated } = await readBoundedResponseText(response);
  let payload: unknown;

  if (!truncated && text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
  }

  const fallback = text
    ? sanitizeProviderText(text).slice(0, MAX_PROVIDER_MESSAGE_LENGTH)
    : `Request failed with status ${response.status}`;
  const providerCode = firstValueAtPaths(payload, ["code", "providerCode", "error.code", "error.providerCode"]);
  const { code, retryable } = classifyStatus(response.status);

  return {
    code,
    message: payload === undefined ? fallback : providerMessage(payload, fallback),
    httpStatus: response.status || null,
    providerCode: typeof providerCode === "string"
      ? sanitizeProviderText(providerCode).slice(0, MAX_PROVIDER_MESSAGE_LENGTH)
      : null,
    retryable,
  };
}
