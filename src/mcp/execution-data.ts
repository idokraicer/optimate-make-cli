// Full per-module execution data via Make's official MCP tools:
//   scenario_execution_inspect     → run status/error + every module that ran (invocations, errors)
//   scenario_execution_module_get  → the real input/output bundles of one module in one cycle
// The public REST API only exposes run summaries; see skills/make-execution-data/SKILL.md.

import type { ToolResult } from "./mcp-client";

export type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

export interface ModuleRecord {
  cycle: number;
  operation: number;
  direction: "input" | "output";
  error: boolean;
  /** Parsed bundles; a bundle Make truncated stays a string ending in "…[truncated]". */
  bundles: unknown[];
  truncated: boolean;
}

export interface ModuleExecutionData {
  moduleId: number;
  name: string | null;
  invocations: number | null;
  errors: number | null;
  cycles: number[];
  records: ModuleRecord[];
}

export interface ExecutionData {
  scenarioId: number;
  executionId: string;
  execution: Record<string, unknown> | null;
  error: { message: string | null; moduleId: number | null; moduleName: string | null } | null;
  modules: ModuleExecutionData[];
  /** Make's caveats (unknown cycles, truncation, withheld payloads), verbatim. */
  remarks: string[];
}

export interface FetchExecutionDataOptions {
  /** Only fetch bundles for these modules (inspect still lists all of them). */
  moduleIds?: number[];
}

export async function fetchExecutionData(
  callTool: CallTool,
  scenarioId: number,
  executionId: string,
  options: FetchExecutionDataOptions = {},
): Promise<ExecutionData> {
  const inspect = await callTool("scenario_execution_inspect", { scenarioId, executionId });
  const report: any = inspect.data ?? {};
  const remarks = [...inspect.texts];
  const modules: ModuleExecutionData[] = [];

  for (const entry of Array.isArray(report.modules) ? report.modules : []) {
    const moduleId = Number(entry?.id ?? entry?.moduleId);
    if (!Number.isInteger(moduleId) || moduleId <= 0) continue;
    const cycles = cyclesFor(entry);
    const module: ModuleExecutionData = {
      moduleId,
      name: typeof entry.name === "string" ? entry.name : null,
      invocations: numberOrNull(entry.invocations),
      errors: numberOrNull(entry.errors),
      cycles,
      records: [],
    };
    modules.push(module);
    if (options.moduleIds && !options.moduleIds.includes(moduleId)) continue;
    if (module.invocations === 0) continue;

    for (const cycle of cycles) {
      const result = await callTool("scenario_execution_module_get", { scenarioId, executionId, moduleId, cycle });
      for (const text of result.texts) {
        if (!remarks.includes(text)) remarks.push(text);
      }
      const records: any[] = Array.isArray((result.data as any)?.records) ? (result.data as any).records : [];
      for (const record of records) {
        const parsed = (Array.isArray(record?.data) ? record.data : []).map(parseBundle);
        module.records.push({
          cycle: numberOrNull(record?.cycle) ?? cycle,
          operation: numberOrNull(record?.operation) ?? 1,
          direction: record?.direction === "input" ? "input" : "output",
          error: Boolean(record?.error),
          bundles: parsed.map((p: { value: unknown }) => p.value),
          truncated: parsed.some((p: { truncated: boolean }) => p.truncated),
        });
      }
    }
  }

  return {
    scenarioId,
    executionId,
    execution: isRecord(report.execution) ? report.execution : null,
    error: isRecord(report.error)
      ? {
          message: typeof report.error.message === "string" ? report.error.message : null,
          moduleId: numberOrNull(report.error.moduleId),
          moduleName: typeof report.error.moduleName === "string" ? report.error.moduleName : null,
        }
      : null,
    modules,
    remarks,
  };
}

/**
 * Cycles to read for a module. Make warns that a wrong cycle silently returns unrelated data,
 * so only cycles inspect reports are used; when it reports none, cycle 1 (correct for
 * single-cycle runs) is used and Make's own remark explaining that is kept in `remarks`.
 */
export function cyclesFor(entry: any): number[] {
  const candidates = [entry?.cycles, entry?.errorCycles];
  const cycles = new Set<number>();
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const value of candidate) if (Number.isInteger(value) && value > 0) cycles.add(value);
    }
  }
  return cycles.size > 0 ? [...cycles].sort((a, b) => a - b) : [1];
}

function parseBundle(raw: unknown): { value: unknown; truncated: boolean } {
  if (typeof raw !== "string") return { value: raw, truncated: false };
  try {
    return { value: JSON.parse(raw), truncated: false };
  } catch {
    return { value: raw, truncated: /\[truncated\]\s*$/.test(raw) };
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
