import type { Command } from "commander";
import type { MakeApiClient } from "../make-api/client";
import { parseRunTimeout } from "../make-api/scenario-runner";
import { BlueprintSchema, type Blueprint } from "../make-api/types";
import type { OwnershipStore } from "../probes/ownership-store";
import {
  runOwnedProbe,
  type ProbeDependencies as ProbeRunnerDependencies,
  type ProbeRequest,
  type ProbeResult,
} from "../probes/probe-runner";
import { sanitizeForIndex } from "../search/search-index";
import { fingerprintBlueprint } from "../utils/blueprint-fingerprint";
import { MakeApiRequestError } from "../make-api/api-error";
import { successEnvelope } from "./output";

type ProbeClient = Pick<
  MakeApiClient,
  | "createScenario"
  | "fetchScenarioDetails"
  | "fetchBlueprint"
  | "fetchScenarioInterface"
  | "startScenario"
  | "runScenario"
  | "fetchExecutionDetails"
  | "stopScenarioExecution"
  | "listModuleLogs"
  | "stopScenario"
  | "listConnections"
  | "getRateLimitSnapshot"
>;

type ProbeCommandDependencies = {
  resolveTarget: (options: { fromUrl: string }) => Promise<{
    teamId: number;
    organizationId: number;
    baseUrl: string;
  }>;
  createClient: (baseUrl?: string) => Promise<ProbeClient>;
  readBlueprint: (path: string) => Promise<unknown>;
  readDataFile: (path: string) => Promise<unknown>;
  ownership: OwnershipStore;
  cliVersion: string;
  writeOutput?: (value: unknown) => void;
  runProbe?: (
    dependencies: ProbeRunnerDependencies,
    request: ProbeRequest,
  ) => Promise<ProbeResult>;
};

export function registerProbeCommand(
  program: Command,
  dependencies: ProbeCommandDependencies,
): void {
  program
    .command("probe")
    .description("Create, run, inspect, and retain an owned on-demand probe scenario")
    .requiredOption("--from-url <url>", "Make.com team-scoped URL")
    .requiredOption("--blueprint <path>", "Probe blueprint JSON file")
    .requiredOption("--name <name>", "Readable probe scenario name")
    .option("--data <json>", "Probe input as a JSON object")
    .option("--data-file <path>", "Read probe input from a JSON file")
    .option("--timeout <duration>", "Maximum run time, for example 30s or 2m", "30s")
    .option("--yes", "Confirm creation and one scenario run")
    .option("--human", "Render readable output instead of JSON")
    .action(async (opts) => {
      const emit = dependencies.writeOutput ?? ((value: unknown) =>
        console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2)));
      const controller = new AbortController();
      const cancel = () => controller.abort(new DOMException("Probe cancelled.", "AbortError"));
      process.once("SIGINT", cancel);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let client: ProbeClient | null = null;
      try {
        const target = await dependencies.resolveTarget({ fromUrl: String(opts.fromUrl) });
        const parsedBlueprint = BlueprintSchema.safeParse(
          await dependencies.readBlueprint(String(opts.blueprint)),
        );
        if (!parsedBlueprint.success) {
          throw new ProbeValidationError("Blueprint JSON does not match the Make blueprint schema.");
        }
        const data = await parseProbeData(
          opts.data,
          opts.dataFile,
          dependencies.readDataFile,
        );
        const timeoutMs = parseRunTimeout(String(opts.timeout));
        client = await dependencies.createClient(target.baseUrl);
        const references = collectConnectionReferences(parsedBlueprint.data);
        const connections = await client.listConnections(target.teamId);
        const available = new Set(connections.map((connection) => connection.id));
        const missing = references.filter((reference) => !available.has(reference));
        if (missing.length > 0) {
          throw new ProbeValidationError(
            `Blueprint references unavailable connection IDs: ${missing.join(", ")}.`,
          );
        }

        const preview = {
          preview: !opts.yes,
          confirmed: Boolean(opts.yes),
          name: String(opts.name),
          teamId: target.teamId,
          organizationId: target.organizationId,
          scheduling: { type: "on-demand" as const },
          input: sanitizeForIndex(data),
          connectionReferences: references,
        };
        if (!opts.yes) {
          emit(opts.human
            ? renderHumanPreview(preview)
            : successEnvelope("probe", preview, probeMeta(dependencies, client)));
          return;
        }

        timeout = setTimeout(
          () => controller.abort(new DOMException("Probe timed out.", "AbortError")),
          timeoutMs,
        );
        const result = await (dependencies.runProbe ?? runOwnedProbe)({
          client,
          ownership: dependencies.ownership,
          fingerprint: fingerprintBlueprint,
        }, {
          ...target,
          blueprint: parsedBlueprint.data,
          name: String(opts.name),
          data,
          signal: controller.signal,
        });
        const safeResult = sanitizeForIndex(result) as ProbeResult;
        emit(opts.human
          ? renderHumanResult(safeResult)
          : successEnvelope(
              "probe",
              safeResult,
              probeMeta(dependencies, client, result.scenarioId),
            ));
      } catch (error) {
        const cleanupFailure = isCleanupFailure(error);
        const partialResult = probeResultFromError(error);
        const apiError = !cleanupFailure && error instanceof MakeApiRequestError
          ? error.apiError
          : null;
        emit({
          ok: false,
          command: "probe",
          error: {
            code: cleanupFailure
              ? "PROBE_CLEANUP_FAILED"
              : error instanceof ProbeValidationError
                ? "PROBE_VALIDATION_FAILED"
                : isAbortError(error) ? "PROBE_CANCELLED" : "PROBE_FAILED",
            message: cleanupFailure
              ? "The owned probe has unresolved cleanup and requires user action."
              : error instanceof ProbeValidationError
                ? error.message
                : isAbortError(error)
                  ? "The probe was cancelled."
                  : apiError
                    ? `The owned probe could not be completed: ${apiError.message}`
                    : "The owned probe could not be completed.",
            httpStatus: apiError?.httpStatus ?? null,
            providerCode: apiError?.providerCode ?? null,
            retryable: apiError?.retryable ?? false,
          },
          ...(partialResult ? { data: sanitizeForIndex(partialResult) } : {}),
          meta: {
            cliVersion: dependencies.cliVersion,
            source: "owned_probe_lifecycle",
            verifiedAt: new Date().toISOString(),
            pendingCleanup: safePending(dependencies.ownership),
            pendingRecovery: safeRecovery(dependencies.ownership),
          },
        });
        process.exitCode = cleanupFailure ? 5 : 1;
      } finally {
        if (timeout) clearTimeout(timeout);
        process.removeListener("SIGINT", cancel);
      }
    });
}

class ProbeValidationError extends Error {}

async function parseProbeData(
  inline: string | undefined,
  filePath: string | undefined,
  readDataFile: (path: string) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  if (inline !== undefined && filePath !== undefined) {
    throw new ProbeValidationError("Use only one of --data or --data-file.");
  }
  let value: unknown = {};
  try {
    value = inline !== undefined
      ? JSON.parse(inline)
      : filePath !== undefined ? await readDataFile(filePath) : {};
  } catch {
    throw new ProbeValidationError("Probe input must be valid JSON.");
  }
  if (!isRecord(value)) {
    throw new ProbeValidationError("Probe input must be a JSON object.");
  }
  return value;
}

export function collectConnectionReferences(blueprint: Blueprint): number[] {
  const references = new Set<number>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (/^__IMTCONN__$/i.test(key)) {
        const id = Number(child);
        if (Number.isInteger(id) && id > 0) references.add(id);
      }
      visit(child);
    }
  };
  visit(blueprint);
  return [...references].sort((a, b) => a - b);
}

function probeMeta(
  dependencies: ProbeCommandDependencies,
  client: ProbeClient,
  excludeScenarioId?: number,
) {
  return {
    cliVersion: dependencies.cliVersion,
    source: "owned_probe_lifecycle",
    verifiedAt: new Date().toISOString(),
    rateLimit: client.getRateLimitSnapshot(),
    pendingCleanup: safePending(dependencies.ownership)
      .filter((record) => record.scenarioId !== excludeScenarioId),
    pendingRecovery: safeRecovery(dependencies.ownership),
  };
}

function safePending(ownership: Pick<OwnershipStore, "listPending">) {
  try {
    return sanitizeForIndex(ownership.listPending()) as ReturnType<OwnershipStore["listPending"]>;
  } catch {
    return [];
  }
}

function safeRecovery(ownership: Pick<OwnershipStore, "listProbeIntents">) {
  try {
    return sanitizeForIndex(ownership.listProbeIntents());
  } catch {
    return [];
  }
}

function isCleanupFailure(error: unknown): error is {
  exitCode: 5;
  result: ProbeResult;
} {
  return isRecord(error) && error.exitCode === 5 && isRecord(error.result);
}

function probeResultFromError(error: unknown): ProbeResult | null {
  return isRecord(error) && isRecord(error.result)
    ? error.result as ProbeResult
    : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function renderHumanPreview(preview: {
  name: string;
  teamId: number;
  connectionReferences: number[];
}): string {
  return [
    `Probe preview: ${preview.name}`,
    `Team: ${preview.teamId}`,
    `Connection references: ${preview.connectionReferences.join(", ") || "none"}`,
    "No scenario was created or run. Re-run with --yes.",
  ].join("\n");
}

function renderHumanResult(result: ProbeResult): string {
  return [
    `Probe scenario ${result.scenarioId}: ${result.executionStatus}`,
    `Execution: ${result.executionId ?? "not assigned"}`,
    `Scenario active: ${String(result.scenarioActive)}`,
    "User decision required: keep, delete, or revise and rerun.",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
