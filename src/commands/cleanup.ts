import type { Command } from "commander";
import type { MakeApiClient } from "../make-api/client";
import type { OwnershipStore } from "../probes/ownership-store";
import { fingerprintBlueprint } from "../utils/blueprint-fingerprint";
import { successEnvelope } from "./output";

type CleanupClient = Pick<
  MakeApiClient,
  | "fetchScenarioDetails"
  | "fetchBlueprint"
  | "deleteScenario"
  | "getRateLimitSnapshot"
  | "getBaseUrl"
  | "fetchTeam"
>;

type CleanupDependencies = {
  resolveClient: (
    scenarioId: number,
    baseUrl?: string,
    teamId?: number,
  ) => Promise<CleanupClient>;
  parseScenarioInput: (input: string) => {
    scenarioId: number;
    teamId?: number;
    baseUrl?: string;
  };
  resolveOrganizationId: (client: CleanupClient, teamId: number) => Promise<number>;
  ownership: OwnershipStore;
  cliVersion: string;
  writeOutput?: (value: unknown) => void;
};

export function registerCleanupCommand(program: Command, dependencies: CleanupDependencies): void {
  program
    .command("cleanup")
    .description("Inspect or delete a verified owned scenario")
    .requiredOption("-s, --scenario <id>", "Owned Make.com scenario ID or URL")
    .option("--delete", "Request deletion after all ownership guards pass")
    .option("--yes", "Confirm deletion")
    .option("--human", "Render readable output instead of JSON")
    .action(async (opts) => {
      const emit = dependencies.writeOutput ?? ((value: unknown) =>
        console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2)));
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once("SIGINT", cancel);
      try {
        const parsed = dependencies.parseScenarioInput(opts.scenario);
        const client = await dependencies.resolveClient(parsed.scenarioId, parsed.baseUrl, parsed.teamId);
        const details = await client.fetchScenarioDetails(parsed.scenarioId);
        const baseUrl = normalizeBaseUrl(parsed.baseUrl ?? client.getBaseUrl());
        let owned = dependencies.ownership.get(baseUrl, parsed.scenarioId);
        const organizationId = await dependencies.resolveOrganizationId(client, details.teamId);
        if (!owned) {
          const operationId = extractOwnedOperationId(details.name);
          const intent = operationId
            ? dependencies.ownership.getProbeIntent(baseUrl, operationId)
            : null;
          if (
            operationId !== null
            && intent
            && intent.teamId === details.teamId
            && intent.organizationId === organizationId
            && normalizeBaseUrl(intent.baseUrl) === baseUrl
            && !details.isActive
            && !details.iswaiting
          ) {
            dependencies.ownership.assignProbeScenario(baseUrl, operationId, parsed.scenarioId);
            const { blueprint: recoveredBlueprint } = await client.fetchBlueprint(parsed.scenarioId);
            dependencies.ownership.update(baseUrl, parsed.scenarioId, {
              lifecycleState: "inactive",
              lastVerifiedFingerprint: await fingerprintBlueprint(recoveredBlueprint),
              remoteVerifiedAt: new Date().toISOString(),
            });
            owned = dependencies.ownership.get(baseUrl, parsed.scenarioId);
          }
        }
        const reasons: string[] = [];
        if (!owned) reasons.push("No ownership record exists for this exact zone and scenario.");
        if (owned?.lifecycleState === "deleted") reasons.push("The ownership record is already deleted.");
        if (owned && (
          !owned.remoteVerifiedAt
          || Number.isNaN(Date.parse(owned.remoteVerifiedAt))
        )) {
          reasons.push("The owned scenario has not been remotely verified.");
        }
        if (owned && normalizeBaseUrl(owned.baseUrl) !== baseUrl) {
          reasons.push("The owned zone does not match.");
        }
        if (parsed.teamId !== undefined && parsed.teamId !== details.teamId) {
          reasons.push("The URL team does not match the remote scenario.");
        }
        if (owned && owned.teamId !== details.teamId) reasons.push("The owned team does not match.");
        if (owned && owned.organizationId !== organizationId) reasons.push("The owned organization does not match.");
        if (details.isActive || details.iswaiting) reasons.push("The remote scenario is active or waiting.");
        if (owned) {
          const { blueprint } = await client.fetchBlueprint(parsed.scenarioId);
          if (await fingerprintBlueprint(blueprint) !== owned.lastVerifiedFingerprint) {
            reasons.push("The remote blueprint has drifted since ownership verification.");
          }
        }
        const eligible = reasons.length === 0;
        const status = {
          scenarioId: parsed.scenarioId,
          deleteRequested: Boolean(opts.delete),
          eligible,
          reasons,
          remote: { teamId: details.teamId, organizationId, isActive: details.isActive },
        };

        if (!opts.delete) {
          emit(opts.human
            ? renderCleanupStatus(status)
            : successEnvelope("cleanup", status, cleanupMeta(dependencies, client)));
          return;
        }
        if (!opts.yes) reasons.push("Deletion requires both --delete and --yes.");
        if (reasons.length > 0) {
          emit(cleanupFailure(reasons, dependencies));
          process.exitCode = 1;
          return;
        }

        try {
          await client.deleteScenario(parsed.scenarioId, controller.signal);
        } catch {
          if (owned) dependencies.ownership.update(owned.baseUrl, owned.scenarioId, {
            lifecycleState: "cleanup_failed",
          });
          throw new Error("Owned scenario deletion could not be verified.");
        }
        dependencies.ownership.markDeleted(owned!.baseUrl, owned!.scenarioId);
        emit(opts.human
          ? `Deleted owned scenario ${parsed.scenarioId}.`
          : successEnvelope(
              "cleanup",
              { ...status, deleted: true },
              cleanupMeta(dependencies, client),
            ));
      } catch (error) {
        emit(cleanupFailure([safeCleanupMessage(error)], dependencies));
        process.exitCode = 1;
      } finally {
        process.removeListener("SIGINT", cancel);
      }
    });
}

function cleanupMeta(dependencies: CleanupDependencies, client: CleanupClient) {
  return {
    cliVersion: dependencies.cliVersion,
    source: "owned_scenario_lifecycle",
    verifiedAt: new Date().toISOString(),
    rateLimit: client.getRateLimitSnapshot(),
    pendingCleanup: safePending(dependencies.ownership),
  };
}

function cleanupFailure(reasons: string[], dependencies: CleanupDependencies) {
  return {
    ok: false,
    command: "cleanup",
    error: {
      code: "CLEANUP_BLOCKED",
      message: "Scenario deletion was blocked by ownership safeguards.",
      httpStatus: null,
      providerCode: null,
      retryable: false,
      reasons,
    },
    meta: {
      cliVersion: dependencies.cliVersion,
      source: "owned_scenario_lifecycle",
      verifiedAt: new Date().toISOString(),
      pendingCleanup: safePending(dependencies.ownership),
    },
  };
}

function safeCleanupMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "Cleanup was cancelled.";
  if (error instanceof Error && error.message.startsWith("Owned scenario deletion")) return error.message;
  return "Unable to verify the owned scenario for cleanup.";
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function extractOwnedOperationId(name: string): string | null {
  const match = name.match(
    /\[([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\]\s*$/i,
  );
  return match?.[1] ?? null;
}

function renderCleanupStatus(status: { scenarioId: number; eligible: boolean; reasons: string[] }): string {
  return [
    `Scenario ${status.scenarioId}: ${status.eligible ? "eligible for owned cleanup" : "not eligible"}`,
    ...status.reasons.map((reason) => `- ${reason}`),
    "No deletion was sent. Use --delete --yes after reviewing this status.",
  ].join("\n");
}

function safePending(ownership: OwnershipStore) {
  try {
    return ownership.listPending();
  } catch {
    return [];
  }
}
