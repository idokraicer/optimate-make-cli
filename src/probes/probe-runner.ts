import type { MakeApiClient } from "../make-api/client";
import type {
  Blueprint,
  ModuleLogSummary,
} from "../make-api/types";
import type { ExecutionDetails } from "../make-api/scenario-runner";
import { validateScenarioInput } from "../make-api/scenario-runner";
import { fingerprintBlueprint } from "../utils/blueprint-fingerprint";
import { walkModules } from "../utils/blueprint-traversal";
import type { OwnershipStore } from "./ownership-store";

export interface ProbeRequest {
  teamId: number;
  organizationId: number;
  baseUrl: string;
  blueprint: Blueprint;
  name: string;
  data?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ProbeResult {
  scenarioId: number;
  executionId: string | null;
  executionStatus: "SUCCESS" | "WARNING" | "ERROR" | "CANCELLED" | "UNKNOWN";
  outputs: Record<string, unknown> | null;
  executionError: unknown | null;
  postRunInterfaces: Array<{ moduleId: number; path: string; interface: unknown }>;
  moduleLogs: Array<{ moduleId: number; status: number; bundles: number }>;
  scenarioActive: boolean | null;
  cleanupRequired: true;
  cleanupOptions: ["keep", "delete", "revise_and_rerun"];
  userDecisionRequired: true;
}

export interface ProbeDependencies {
  client: Pick<
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
  >;
  ownership: OwnershipStore;
  fingerprint: typeof fingerprintBlueprint;
  randomUUID?: () => string;
  now?: () => string;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export class ProbeCleanupError extends Error {
  readonly exitCode = 5;
  constructor(readonly result: ProbeResult) {
    super("Owned probe cleanup could not be verified.");
    this.name = "ProbeCleanupError";
  }
}

const CLEANUP_OPTIONS = ["keep", "delete", "revise_and_rerun"] as const;

export async function runOwnedProbe(
  deps: ProbeDependencies,
  request: ProbeRequest,
): Promise<ProbeResult> {
  const baseUrl = request.baseUrl.replace(/\/+$/, "");
  const now = deps.now ?? (() => new Date().toISOString());
  const operationId = deps.randomUUID?.() ?? crypto.randomUUID();
  const ownedName = `[make-fixer probe] ${request.name.trim() || "Untitled"} [${operationId}]`;
  const sentBlueprint: Blueprint = {
    ...request.blueprint,
    name: ownedName,
  };
  let scenarioId: number | null = null;
  let executionId: string | null = null;
  let scenarioActive: boolean | null = null;
  let executionStatus: ProbeResult["executionStatus"] = "UNKNOWN";
  let outputs: Record<string, unknown> | null = null;
  let executionError: unknown | null = null;
  let postRunInterfaces: ProbeResult["postRunInterfaces"] = [];
  let moduleLogs: ProbeResult["moduleLogs"] = [];
  let terminal = false;
  let primaryError: unknown = null;
  let cleanupFailed = false;
  let mayBeActive = false;

  // Open the durable store before the first remote mutation.
  deps.ownership.listPending();
  const requestedFingerprint = await deps.fingerprint(sentBlueprint);
  const intentCreatedAt = now();
  deps.ownership.beginProbe({
    operationId,
    teamId: request.teamId,
    organizationId: request.organizationId,
    baseUrl,
    createdAt: intentCreatedAt,
    updatedAt: intentCreatedAt,
    lastVerifiedFingerprint: requestedFingerprint,
    remoteVerifiedAt: null,
    lifecycleState: "creating",
    executionId: null,
  });

  try {
    throwIfAborted(request.signal);
    const created = await deps.client.createScenario({
      teamId: request.teamId,
      blueprint: sentBlueprint,
      scheduling: { type: "on-demand" },
      confirmed: true,
    });
    scenarioId = created.id;
    scenarioActive = created.isActive;
    mayBeActive = created.isActive !== false;

    // A pre-existing row means this ID cannot safely be claimed or mutated.
    if (deps.ownership.get(baseUrl, scenarioId)) {
      scenarioId = null;
      throw new Error("The created scenario ID already has an ownership record.");
    }

    try {
      deps.ownership.assignProbeScenario(baseUrl, operationId, scenarioId);
    } catch (error) {
      cleanupFailed = true;
      throw error;
    }

    const { blueprint: verifiedBlueprint } = await deps.client.fetchBlueprint(scenarioId);
    const scenarioInterface = await deps.client.fetchScenarioInterface(scenarioId, request.signal);
    const verifiedFingerprint = await deps.fingerprint(verifiedBlueprint);
    if (
      created.id !== scenarioId
      || created.teamId !== request.teamId
      || created.isActive
      || !created.name.includes(`[${operationId}]`)
    ) {
      throw new Error("Created probe verification did not match the requested owned scenario.");
    }
    const validation = validateScenarioInput(scenarioInterface, request.data ?? {});
    if (!validation.valid) {
      throw new Error("Probe input does not match the created scenario interface.");
    }
    deps.ownership.update(baseUrl, scenarioId, {
      lastVerifiedFingerprint: verifiedFingerprint,
      remoteVerifiedAt: now(),
      lifecycleState: "verified",
    });

    throwIfAborted(request.signal);
    scenarioActive = null;
    mayBeActive = true;
    const started = await deps.client.startScenario(scenarioId, request.signal);
    if (!started.isActive) throw new Error("Make did not confirm probe activation.");
    scenarioActive = true;
    deps.ownership.update(baseUrl, scenarioId, { lifecycleState: "active" });

    throwIfAborted(request.signal);
    const initial = await deps.client.runScenario(
      scenarioId,
      { data: validation.normalized, responsive: false },
      request.signal,
    );
    executionId = initial.executionId;
    deps.ownership.update(baseUrl, scenarioId, {
      lifecycleState: "running",
      executionId,
    });

    const terminalDetails = await waitForTerminalExecution(
      deps,
      scenarioId,
      executionId,
      initial,
      request.signal,
    );
    terminal = true;
    executionStatus = normalizeTerminalStatus(terminalDetails.status);
    outputs = isRecord(terminalDetails.outputs) ? terminalDetails.outputs : null;
    executionError = terminalDetails.error ?? null;
    deps.ownership.update(baseUrl, scenarioId, { lifecycleState: "terminal" });

    const { blueprint: postRunBlueprint } = await deps.client.fetchBlueprint(scenarioId);
    const walked = walkModules(postRunBlueprint.flow);
    postRunInterfaces = walked.flatMap(({ module, path }) =>
      Number.isInteger(module.id)
          && Number(module.id) > 0
          && module.metadata?.interface !== undefined
        ? [{
            moduleId: Number(module.id),
            path,
            interface: module.metadata.interface,
          }]
        : []
    );
    const summaries: ModuleLogSummary[] = [];
    for (const { module } of walked) {
      if (!Number.isInteger(module.id) || Number(module.id) <= 0) continue;
      const logs = await deps.client.listModuleLogs(scenarioId, Number(module.id), request.signal);
      summaries.push(...logs.filter((log) => log.executionId === executionId));
    }
    moduleLogs = summaries.map(({ moduleId, status, bundles }) => ({
      moduleId,
      status,
      bundles,
    }));
  } catch (error) {
    primaryError = error;
    if (scenarioId === null) {
      deps.ownership.discardProbeIntent(baseUrl, operationId);
    }
    if (isAbortError(error)) executionStatus = "CANCELLED";
    const assignedExecutionId = executionIdFromError(error);
    if (scenarioId !== null && executionId === null && assignedExecutionId !== null) {
      executionId = assignedExecutionId;
      try {
        deps.ownership.update(baseUrl, scenarioId, {
          lifecycleState: "running",
          executionId,
        });
      } catch {
        cleanupFailed = true;
      }
    }
  } finally {
    if (scenarioId !== null) {
      if (!terminal && executionId !== null) {
        try {
          await deps.client.stopScenarioExecution(scenarioId, executionId, true);
        } catch {
          cleanupFailed = true;
        }
      }
      try {
        scenarioActive = null;
        // Only stop a probe that may be active; inactivity is verified below either way.
        if (mayBeActive) await deps.client.stopScenario(scenarioId);
        const inactive = await deps.client.fetchScenarioDetails(scenarioId);
        if (inactive.isActive || inactive.iswaiting) {
          throw new Error("Make did not confirm probe deactivation.");
        }
        scenarioActive = false;
        const { blueprint: inactiveBlueprint } = await deps.client.fetchBlueprint(scenarioId);
        deps.ownership.update(baseUrl, scenarioId, {
          lifecycleState: "inactive",
          lastVerifiedFingerprint: await deps.fingerprint(inactiveBlueprint),
          remoteVerifiedAt: now(),
        });
      } catch {
        cleanupFailed = true;
      }
      if (cleanupFailed) {
        try {
          deps.ownership.update(baseUrl, scenarioId, { lifecycleState: "cleanup_failed" });
        } catch {
          // Preserve the exit-5 result even when the durable store itself is unavailable.
        }
      }
    }
  }

  if (scenarioId !== null && cleanupFailed) {
    throw new ProbeCleanupError(buildResult({
      scenarioId,
      executionId,
      executionStatus,
      outputs,
      executionError,
      postRunInterfaces,
      moduleLogs,
      scenarioActive,
    }));
  }
  if (primaryError !== null) {
    if (scenarioId !== null) {
      throw attachProbeResult(primaryError, buildResult({
        scenarioId,
        executionId,
        executionStatus,
        outputs,
        executionError,
        postRunInterfaces,
        moduleLogs,
        scenarioActive,
      }));
    }
    throw primaryError;
  }
  if (scenarioId === null) {
    throw new Error("Probe creation did not produce an owned scenario.");
  }
  return buildResult({
    scenarioId,
    executionId,
    executionStatus,
    outputs,
    executionError,
    postRunInterfaces,
    moduleLogs,
    scenarioActive,
  });
}

async function waitForTerminalExecution(
  deps: ProbeDependencies,
  scenarioId: number,
  executionId: string,
  _initial: { status?: string; outputs?: object },
  signal?: AbortSignal,
): Promise<ExecutionDetails> {
  let delay = 250;
  while (true) {
    throwIfAborted(signal);
    const details = await deps.client.fetchExecutionDetails(scenarioId, executionId, signal);
    if (details.status !== "RUNNING") return details;
    throwIfAborted(signal);
    await (deps.sleep ?? abortableSleep)(delay, signal);
    delay = Math.min(delay * 2, 5_000);
  }
}

function buildResult(
  value: Omit<
    ProbeResult,
    "cleanupRequired" | "cleanupOptions" | "userDecisionRequired"
  >,
): ProbeResult {
  return {
    ...value,
    cleanupRequired: true,
    cleanupOptions: [...CLEANUP_OPTIONS],
    userDecisionRequired: true,
  };
}

function normalizeTerminalStatus(status: string): ProbeResult["executionStatus"] {
  const normalized = status.toUpperCase();
  return normalized === "SUCCESS" || normalized === "WARNING" || normalized === "ERROR"
    ? normalized
    : "UNKNOWN";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof DOMException && signal.reason.name === "AbortError") {
    throw signal.reason;
  }
  throw new DOMException("Probe cancelled.", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function executionIdFromError(error: unknown): string | null {
  if (
    error
    && typeof error === "object"
    && "executionId" in error
    && typeof error.executionId === "string"
    && error.executionId.length > 0
  ) {
    return error.executionId;
  }
  return null;
}

function attachProbeResult(error: unknown, result: ProbeResult): unknown {
  if (error && typeof error === "object") {
    try {
      Object.defineProperty(error, "result", {
        value: result,
        enumerable: true,
        configurable: true,
      });
      return error;
    } catch {
      // Fall through to a safe error that carries the retained scenario state.
    }
  }
  return Object.assign(new Error("The owned probe could not be completed."), {
    result,
  });
}

async function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      reject(new DOMException("Probe cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
