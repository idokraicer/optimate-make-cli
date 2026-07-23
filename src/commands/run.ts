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
};

type RunFailureCode =
  | "INVALID_DATA"
  | "RUN_STILL_RUNNING"
  | "RUN_TIMEOUT"
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
      let timedOut = false;
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      let waitDeadline = 0;
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once("SIGINT", cancel);

      try {
        const input = await parseRunData(opts.data, opts.dataFile);
        const timeoutMs = parseRunTimeout(String(opts.timeout));
        const parsed = dependencies.parseScenarioInput(opts.scenario);
        const client = await dependencies.resolveClient(
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
          }));
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
            : successEnvelope("run", preview, runMeta(dependencies.cliVersion, client, parsed.scenarioId)));
          return;
        }

        let initial: Awaited<ReturnType<RunClient["runScenario"]>>;
        if (opts.wait) {
          waitDeadline = Date.now() + timeoutMs;
          waitTimer = setTimeout(() => {
            timedOut = true;
            controller.abort(new DOMException("Scenario run wait timed out.", "AbortError"));
          }, timeoutMs);
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
            }));
            process.exitCode = 1;
            return;
          }
          initial = { executionId, status: "RUNNING" };
        }

        let result: {
          status?: string;
          outputs?: object;
          error?: unknown;
        } = initial;
        const initialStatus = String(initial.status ?? "").toUpperCase();
        if (opts.wait && !["SUCCESS", "WARNING", "ERROR"].includes(initialStatus)) {
          result = await pollScenarioExecution({
            scenarioId: parsed.scenarioId,
            executionId,
            timeoutMs: Math.max(1, waitDeadline - Date.now()),
            signal: controller.signal,
            fetchExecutionDetails: (scenarioId, id, signal) =>
              client.fetchExecutionDetails(scenarioId, id, signal),
          });
        }
        if ("code" in result && result.code === "RUN_STILL_RUNNING") {
          emit(runFailure("RUN_STILL_RUNNING", "The scenario is still running.", {
            executionId,
            status: "RUNNING",
            retryable: true,
          }));
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
          : successEnvelope("run", data, runMeta(dependencies.cliVersion, client, parsed.scenarioId)));
      } catch (error) {
        const cancelled = error instanceof DOMException && error.name === "AbortError";
        if (timedOut && executionId) {
          emit(runFailure("RUN_STILL_RUNNING", "The scenario may still be running.", {
            executionId,
            status: "RUNNING",
            retryable: true,
          }));
          process.exitCode = 3;
          return;
        }
        emit(runFailure(
          timedOut ? "RUN_TIMEOUT" : cancelled ? "RUN_CANCELLED" : "INVALID_DATA",
          timedOut
            ? "The run request timed out before Make returned an execution ID."
            : cancelled ? "Waiting for the scenario run was cancelled." : safeRunMessage(error),
          executionId ? { executionId } : {},
        ));
        process.exitCode = 1;
      } finally {
        if (waitTimer) clearTimeout(waitTimer);
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

function runMeta(cliVersion: string, client: RunClient, scenarioId: number) {
  const rate = client.getRateLimitSnapshot();
  return {
    cliVersion,
    source: "live_scenario_interface",
    verifiedAt: new Date().toISOString(),
    scenarioId,
    rateLimit: rate,
  };
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
