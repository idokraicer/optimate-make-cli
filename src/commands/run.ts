import type { Command } from "commander";
import {
  ScenarioRunRequestError,
  type MakeApiClient,
} from "../make-api/client";
import {
  parseRunTimeout,
  pollScenarioExecution,
  validateScenarioInput,
} from "../make-api/scenario-runner";
import { successEnvelope } from "./output";
import { sanitizeForIndex } from "../search/search-index";
import type { OwnershipStore } from "../probes/ownership-store";

type RunClient = Pick<
  MakeApiClient,
  | "fetchScenarioInterface"
  | "runScenario"
  | "fetchExecutionDetails"
  | "getRateLimitSnapshot"
>;

type RunDependencies = {
  resolveClient: (
    scenarioId: number,
    baseUrlOverride?: string,
    teamId?: number,
  ) => Promise<RunClient>;
  parseScenarioInput: (input: string) => {
    scenarioId: number;
    teamId?: number;
    baseUrl?: string;
  };
  cliVersion: string;
  writeOutput?: (value: unknown) => void;
  ownership?: Pick<OwnershipStore, "listPending">;
};

type RunFailureCode =
  | "INVALID_DATA"
  | "RUN_STILL_RUNNING"
  | "RUN_CANCELLED"
  | "UNKNOWN_API_ERROR";

export function registerRunCommand(program: Command, dependencies: RunDependencies): void {
  program
    .command("run")
    .description("Validate inputs and run a scenario once")
    .requiredOption("-s, --scenario <id>", "Make.com scenario ID or URL")
    .option("--data <json>", "Scenario input as a JSON object")
    .option("--data-file <path>", "Read scenario input from a JSON file")
    .option("--wait", "Wait for completion and return configured outputs")
    .option("--timeout <duration>", "Maximum wait, for example 30s or 2m", "30s")
    .option("--yes", "Confirm the single scenario run POST")
    .option("--human", "Render readable output instead of the default JSON envelope")
    .action(async (opts) => {
      const emit = dependencies.writeOutput ?? ((value: unknown) => console.log(
        typeof value === "string" ? value : JSON.stringify(value, null, 2),
      ));
      let executionId: string | null = null;
      let client: RunClient | null = null;
      let scenarioId: number | null = null;
      let waitDeadline = 0;
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once("SIGINT", cancel);

      try {
        const input = await parseRunData(opts.data, opts.dataFile);
        const timeoutMs = parseRunTimeout(String(opts.timeout));
        const parsed = dependencies.parseScenarioInput(opts.scenario);
        scenarioId = parsed.scenarioId;
        client = await dependencies.resolveClient(
          parsed.scenarioId,
          parsed.baseUrl,
          parsed.teamId,
        );
        const scenarioInterface = await client.fetchScenarioInterface(
          parsed.scenarioId,
          controller.signal,
        );
        const validation = validateScenarioInput(scenarioInterface, input);
        if (!validation.valid) {
          emit(runFailure("INVALID_DATA", "Scenario input does not match the live interface.", {
            issues: validation.issues,
            interface: sanitizeRunOutput(scenarioInterface),
          }, runPendingMeta(dependencies, client, scenarioId)));
          process.exitCode = 1;
          return;
        }

        if (!opts.yes) {
          const preview = {
            preview: true,
            confirmed: false,
            scenarioId: parsed.scenarioId,
            input: sanitizeRunOutput(validation.normalized),
            interface: sanitizeRunOutput(scenarioInterface),
          };
          emit(opts.human
            ? renderHumanPreview(preview)
            : successEnvelope("run", preview, runMeta(dependencies, client, parsed.scenarioId)));
          return;
        }

        let initial: Awaited<ReturnType<RunClient["runScenario"]>>;
        if (opts.wait) {
          waitDeadline = Date.now() + timeoutMs;
        }
        try {
          initial = await client.runScenario(parsed.scenarioId, {
            data: validation.normalized,
            responsive: Boolean(opts.wait),
          }, controller.signal);
          executionId = initial.executionId;
        } catch (error) {
          if (!(error instanceof ScenarioRunRequestError) || !error.executionId) throw error;
          executionId = error.executionId;
          if (!opts.wait) {
            emit(runFailure("UNKNOWN_API_ERROR", "The run request failed after Make assigned an execution.", {
              executionId,
              httpStatus: error.httpStatus,
            }, runPendingMeta(dependencies, client, scenarioId)));
            process.exitCode = 1;
            return;
          }
          initial = { executionId, status: "RUNNING" };
        }

        let result: {
          status?: string;
          outputs?: object;
          error?: unknown;
          code?: "RUN_STILL_RUNNING";
          executionId?: string;
        } = initial;
        const initialStatus = String(initial.status ?? "").toUpperCase();
        if (opts.wait && !["SUCCESS", "WARNING", "ERROR"].includes(initialStatus)) {
          const remainingMs = waitDeadline - Date.now();
          const pollingClient = client;
          result = remainingMs <= 0
            ? {
                status: "RUNNING",
                code: "RUN_STILL_RUNNING",
                executionId,
              }
            : await pollScenarioExecution({
                scenarioId: parsed.scenarioId,
                executionId,
                timeoutMs: remainingMs,
                signal: controller.signal,
                fetchExecutionDetails: (scenarioId, id, signal) =>
                  pollingClient.fetchExecutionDetails(scenarioId, id, signal),
              });
        }
        if ("code" in result && result.code === "RUN_STILL_RUNNING") {
          emit(runFailure("RUN_STILL_RUNNING", "The scenario is still running.", {
            executionId,
            status: "RUNNING",
            retryable: true,
          }, runPendingMeta(dependencies, client, scenarioId)));
          process.exitCode = 3;
          return;
        }

        const data = {
          scenarioId: parsed.scenarioId,
          executionId,
          status: result.status ?? "RUNNING",
          ...(result.outputs ? { outputs: sanitizeRunOutput(result.outputs) as object } : {}),
          ...(result.error !== undefined ? { executionError: "Scenario execution failed." } : {}),
        };
        emit(opts.human
          ? renderHumanResult(data)
          : successEnvelope("run", data, runMeta(dependencies, client, parsed.scenarioId)));
      } catch (error) {
        const cancelled = error instanceof DOMException && error.name === "AbortError";
        emit(runFailure(
          cancelled ? "RUN_CANCELLED" : "INVALID_DATA",
          cancelled ? "Waiting for the scenario run was cancelled." : safeRunMessage(error),
          executionId ? { executionId } : {},
          runPendingMeta(dependencies, client, scenarioId),
        ));
        process.exitCode = 1;
      } finally {
        process.removeListener("SIGINT", cancel);
      }
    });
}

async function parseRunData(inline: unknown, filePath: unknown): Promise<Record<string, unknown>> {
  if (inline !== undefined && filePath !== undefined) {
    throw new Error("Use only one of --data or --data-file.");
  }
  let raw: unknown = {};
  if (inline !== undefined) {
    if (typeof inline !== "string") throw new Error("--data must be JSON.");
    try {
      raw = JSON.parse(inline);
    } catch {
      throw new Error("--data must contain valid JSON.");
    }
  } else if (filePath !== undefined) {
    if (typeof filePath !== "string") throw new Error("--data-file must be a path.");
    try {
      raw = JSON.parse(await Bun.file(filePath).text());
    } catch {
      throw new Error("--data-file must contain valid JSON.");
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Scenario input must be a JSON object.");
  }
  return raw as Record<string, unknown>;
}

function runFailure(
  code: RunFailureCode,
  message: string,
  extra: Record<string, unknown> = {},
  meta?: Record<string, unknown>,
): unknown {
  return {
    ok: false,
    command: "run",
    error: {
      code,
      message,
      httpStatus: null,
      providerCode: null,
      retryable: code === "RUN_STILL_RUNNING",
      ...extra,
    },
    ...(meta ? { meta } : {}),
  };
}

function safeRunMessage(error: unknown): string {
  if (error instanceof Error && (
    error.message.startsWith("--")
    || error.message.startsWith("Use only")
    || error.message.startsWith("Scenario input")
  )) return error.message;
  return "Unable to run scenario.";
}

const SENSITIVE_OUTPUT_NAME =
  /(?:authorization|cookie|token|secret|password|credential|api[-_]?key|session(?:id)?)/i;

function sanitizeRunOutput(value: unknown, sensitiveDescriptor = false): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => sanitizeRunOutput(child, sensitiveDescriptor));
  }
  if (typeof value === "string") return sanitizeForIndex(value);
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const descriptorSensitive = sensitiveDescriptor || [record.name, record.key, record.header]
    .some((candidate) => typeof candidate === "string" && SENSITIVE_OUTPUT_NAME.test(candidate));
  return Object.fromEntries(Object.entries(record).map(([key, child]) => {
    if (SENSITIVE_OUTPUT_NAME.test(key)) return [key, "[REDACTED]"];
    if (
      descriptorSensitive
      && /^(?:value|values|content|defaultValue)$/i.test(key)
    ) return [key, "[REDACTED]"];
    return [key, sanitizeRunOutput(child, descriptorSensitive)];
  }));
}

function runMeta(dependencies: RunDependencies, client: RunClient, scenarioId: number) {
  const rate = client.getRateLimitSnapshot();
  return {
    cliVersion: dependencies.cliVersion,
    source: "live_scenario_interface",
    verifiedAt: new Date().toISOString(),
    scenarioId,
    rateLimit: rate,
    pendingCleanup: safePending(dependencies.ownership),
  };
}

function runPendingMeta(
  dependencies: RunDependencies,
  client: RunClient | null,
  scenarioId: number | null,
) {
  return {
    cliVersion: dependencies.cliVersion,
    source: "owned_scenario_lifecycle",
    verifiedAt: new Date().toISOString(),
    ...(scenarioId === null ? {} : { scenarioId }),
    ...(client ? { rateLimit: client.getRateLimitSnapshot() } : {}),
    pendingCleanup: safePending(dependencies.ownership),
  };
}

function safePending(ownership?: Pick<OwnershipStore, "listPending">) {
  try {
    return ownership?.listPending() ?? [];
  } catch {
    return [];
  }
}

function renderHumanPreview(preview: {
  scenarioId: number;
  input: unknown;
}): string {
  return [
    `Scenario ${preview.scenarioId} run preview`,
    `Input: ${JSON.stringify(preview.input, null, 2)}`,
    "No run was sent. Re-run with --yes to execute once.",
  ].join("\n");
}

function renderHumanResult(result: {
  executionId: string;
  status?: string;
  outputs?: object;
}): string {
  return [
    `Execution: ${result.executionId}`,
    `Status: ${result.status ?? "RUNNING"}`,
    ...(result.outputs ? [`Outputs: ${JSON.stringify(result.outputs, null, 2)}`] : []),
  ].join("\n");
}
