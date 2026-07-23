import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface ExecutionTimeWindowInput {
  from?: string;
  to?: string;
  since?: string;
}

export interface ExecutionTimeWindow {
  from?: string;
  to?: string;
}

const DURATION_UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
  mo: 30 * 86_400_000,
};

/** Parse compact agent-friendly durations such as 30m, 2h, 7d, or 1mo. */
export function parseDuration(input: string): number | null {
  const match = input.trim().match(/^(\d+)\s*(s|m|min|h|d|w|mo)$/i);
  if (!match) return null;

  const amount = Number(match[1]);
  const duration = amount * DURATION_UNITS[match[2].toLowerCase()];
  return amount > 0 && Number.isSafeInteger(duration) ? duration : null;
}

/** Convert an epoch-millisecond or unambiguous ISO 8601 value to Make's millisecond format. */
export function parseExecutionTimestamp(input: string): string {
  const value = input.trim();
  if (/^\d{13,16}$/.test(value)) {
    const milliseconds = Number(value);
    if (Number.isSafeInteger(milliseconds) && !Number.isNaN(new Date(milliseconds).getTime())) {
      return String(milliseconds);
    }
  }

  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
  if (isoDate.test(value) || isoDateTime.test(value)) {
    const [year, month, day] = value.slice(0, 10).split("-").map(Number);
    const calendarDateIsValid = new Date(Date.UTC(year, month - 1, day))
      .toISOString()
      .startsWith(value.slice(0, 10));
    const milliseconds = Date.parse(value);
    if (calendarDateIsValid && !Number.isNaN(milliseconds)) return String(milliseconds);
  }

  throw new Error(
    `Invalid timestamp "${input}". Use epoch milliseconds or ISO 8601 (for example 2026-07-15T10:30:00+03:00).`,
  );
}

/** Resolve --from/--to/--since into the exact query values sent to Make. */
export function resolveExecutionTimeWindow(
  input: ExecutionTimeWindowInput,
  now = Date.now(),
): ExecutionTimeWindow {
  if (input.since && (input.from || input.to)) {
    throw new Error("--since cannot be combined with --from or --to.");
  }

  let from: string | undefined;
  let to: string | undefined;

  if (input.since) {
    const duration = parseDuration(input.since);
    if (duration == null) {
      throw new Error(`Invalid --since value "${input.since}". Use values such as 30m, 2h, 7d, or 1mo.`);
    }
    from = String(now - duration);
  } else {
    from = input.from ? parseExecutionTimestamp(input.from) : undefined;
    to = input.to ? parseExecutionTimestamp(input.to) : undefined;
  }

  if (from && to && Number(from) > Number(to)) {
    throw new Error("--from must be before or equal to --to.");
  }

  return { from, to };
}

/** Normalize a log row to stable fields that consume fewer agent tokens than the raw API object. */
export function compactExecution(execution: any): {
  id: string | number | null;
  imtId: string | number | null;
  status: number | null;
  statusLabel: string;
  timestamp: string | null;
  operations: number | null;
  durationMs: number | null;
  name: string | null;
} {
  const status = typeof execution.status === "number" ? execution.status : null;
  const statusLabel = status === 1
    ? "success"
    : status === 2
      ? "failed"
      : status === 3
        ? "fatal"
        : "unknown";

  return {
    id: execution.id ?? null,
    imtId: execution.imtId ?? null,
    status,
    statusLabel,
    timestamp: execution.timestamp ?? execution.executionTime ?? null,
    operations: execution.operations ?? null,
    durationMs: execution.duration ?? null,
    name: execution.executionName ?? null,
  };
}

export type WebhookInputLogSelection = {
  match: any | null;
  differenceMs: number | null;
  reason: "not_found" | "ambiguous" | null;
  candidateLogIds: string[];
};

/**
 * Match a scenario execution to a webhook log without silently guessing when
 * concurrent requests produce similarly close candidates.
 */
export function selectWebhookInputLog(
  logs: any[],
  executionTimestamp: string,
  options: { maxDistanceMs?: number; ambiguityThresholdMs?: number } = {},
): WebhookInputLogSelection {
  const executionTime = Date.parse(executionTimestamp);
  const maxDistanceMs = options.maxDistanceMs ?? 120_000;
  const ambiguityThresholdMs = options.ambiguityThresholdMs ?? 1_000;

  if (Number.isNaN(executionTime)) {
    return { match: null, differenceMs: null, reason: "not_found", candidateLogIds: [] };
  }

  const candidates = logs
    .map((log) => ({ log, differenceMs: Math.abs(Date.parse(log.loggedAt) - executionTime) }))
    .filter(({ differenceMs }) => Number.isFinite(differenceMs) && differenceMs <= maxDistanceMs)
    .sort((a, b) => a.differenceMs - b.differenceMs);

  if (candidates.length === 0) {
    return { match: null, differenceMs: null, reason: "not_found", candidateLogIds: [] };
  }

  const candidateLogIds = candidates.map(({ log }) => String(log.id));
  if (
    candidates[1]
    && candidates[1].differenceMs - candidates[0].differenceMs < ambiguityThresholdMs
  ) {
    return { match: null, differenceMs: null, reason: "ambiguous", candidateLogIds };
  }

  return {
    match: candidates[0].log,
    differenceMs: candidates[0].differenceMs,
    reason: null,
    candidateLogIds,
  };
}

/** Serialize once for stdout and, when requested, persist that exact JSON as an artifact. */
export async function writeJsonOutput(value: unknown, outputPath?: string): Promise<string> {
  const json = JSON.stringify(value, null, 2);
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await Bun.write(outputPath, json + "\n");
  }
  return json;
}
