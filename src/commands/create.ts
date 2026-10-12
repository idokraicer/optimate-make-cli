import type { Command } from "commander";
import type { MakeApiClient } from "../make-api/client";
import { BlueprintSchema, type Blueprint } from "../make-api/types";
import type { OwnershipStore } from "../probes/ownership-store";
import { fingerprintBlueprint } from "../utils/blueprint-fingerprint";
import { successEnvelope } from "./output";

type CreateClient = Pick<
  MakeApiClient,
  "createScenario" | "fetchScenarioDetails" | "fetchBlueprint" | "listAllScenarios" | "getRateLimitSnapshot"
>;

type CreateDependencies = {
  createClient: (baseUrl?: string) => Promise<CreateClient>;
  resolveTeam: (options: { team?: string; fromUrl?: string; baseUrl?: string }) => Promise<{
    teamId: number;
    organizationId: number;
    baseUrl: string;
  }>;
  readBlueprint: (path: string) => Promise<unknown>;
  ownership: OwnershipStore;
  cliVersion: string;
  writeOutput?: (value: unknown) => void;
  randomUUID?: () => string;
  now?: () => string;
};

export function registerCreateCommand(program: Command, dependencies: CreateDependencies): void {
  program
    .command("create")
    .description("Preview or create an owned on-demand scenario")
    .requiredOption("--blueprint <path>", "Blueprint JSON file")
    .option("-t, --team <id>", "Target team ID")
    .option("--from-url <url>", "Make.com team-scoped URL")
    .option("--base-url <url>", "Make.com zone URL for a bare team ID")
    .option("--no-probe-label", "Omit the readable probe prefix; keep the operation marker")
    .option("--yes", "Confirm the scenario creation POST")
    .option("--human", "Render readable output instead of JSON")
    .action(async (opts) => {
      const emit = dependencies.writeOutput ?? ((value: unknown) =>
        console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2)));
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once("SIGINT", cancel);
      try {
        const resolved = await dependencies.resolveTeam(opts);
        const parsed = BlueprintSchema.safeParse(await dependencies.readBlueprint(opts.blueprint));
        if (!parsed.success) throw new Error("Blueprint JSON does not match the Make blueprint schema.");
        const operationId = dependencies.randomUUID?.() ?? crypto.randomUUID();
        const name = buildOwnedScenarioName(parsed.data.name, operationId, opts.probeLabel !== false);
        const blueprint: Blueprint = {
          ...parsed.data,
          name,
          scheduling: { type: "on-demand" },
        };
        const client = await dependencies.createClient(resolved.baseUrl);
        const preview = {
          preview: !opts.yes,
          confirmed: Boolean(opts.yes),
          operationId,
          name,
          teamId: resolved.teamId,
          organizationId: resolved.organizationId,
          scheduling: { type: "on-demand" as const },
        };
        if (!opts.yes) {
          emit(opts.human
            ? `Create preview: ${name}\nNo scenario was created. Re-run with --yes.`
            : successEnvelope("create", preview, createMeta(dependencies, client)));
          return;
        }

        // Fail before the POST if durable ownership state cannot be opened.
        dependencies.ownership.listPending();
        const created = await client.createScenario({
          teamId: resolved.teamId,
          blueprint,
          scheduling: { type: "on-demand" },
          confirmed: true,
          signal: controller.signal,
        });
        const now = (dependencies.now ?? (() => new Date().toISOString()))();
        dependencies.ownership.put({
          scenarioId: created.id,
          operationId,
          teamId: resolved.teamId,
          organizationId: resolved.organizationId,
          baseUrl: resolved.baseUrl,
          createdAt: now,
          updatedAt: now,
          lastVerifiedFingerprint: await fingerprintBlueprint(blueprint),
          remoteVerifiedAt: null,
          lifecycleState: "created",
          executionId: null,
        });
        const details = await client.fetchScenarioDetails(created.id);
        if (details.teamId !== resolved.teamId || !details.name.includes(`[${operationId}]`)) {
          throw new Error("Created scenario verification did not match the target team and operation marker.");
        }
        const { blueprint: remote } = await client.fetchBlueprint(created.id);
        const fingerprint = await fingerprintBlueprint(remote);
        dependencies.ownership.update(resolved.baseUrl, created.id, {
          lastVerifiedFingerprint: fingerprint,
          remoteVerifiedAt: (dependencies.now ?? (() => new Date().toISOString()))(),
          lifecycleState: "verified",
        });
        const data = { ...preview, preview: false, scenarioId: created.id, verified: true };
        emit(opts.human
          ? `Created and verified scenario ${created.id}: ${name}`
          : successEnvelope("create", data, createMeta(dependencies, client)));
      } catch (error) {
        emit(createFailure(
          error instanceof DOMException && error.name === "AbortError"
            ? "CREATE_CANCELLED"
            : isAmbiguousCreate(error) ? "AMBIGUOUS_CREATE" : "CREATE_FAILED",
          safeCreateMessage(error),
          dependencies,
        ));
        process.exitCode = 1;
      } finally {
        process.removeListener("SIGINT", cancel);
      }
    });
}

export function buildOwnedScenarioName(name: string, operationId: string, probeLabel: boolean): string {
  const requested = name.trim() || "Untitled";
  return `${probeLabel ? "[make-fixer probe] " : ""}${requested} [${operationId}]`;
}

function createMeta(dependencies: CreateDependencies, client: CreateClient) {
  return {
    cliVersion: dependencies.cliVersion,
    source: "owned_scenario_lifecycle",
    verifiedAt: new Date().toISOString(),
    rateLimit: client.getRateLimitSnapshot(),
    pendingCleanup: safePending(dependencies.ownership),
  };
}

function createFailure(code: string, message: string, dependencies: CreateDependencies) {
  return {
    ok: false,
    command: "create",
    error: { code, message, httpStatus: null, providerCode: null, retryable: false },
    meta: {
      cliVersion: dependencies.cliVersion,
      source: "owned_scenario_lifecycle",
      verifiedAt: new Date().toISOString(),
      pendingCleanup: safePending(dependencies.ownership),
    },
  };
}

function safeCreateMessage(error: unknown): string {
  if (error instanceof Error && (
    error.message.startsWith("Blueprint")
    || error.message.startsWith("Created scenario verification")
  )) return error.message;
  return "Unable to create and verify the owned scenario.";
}

function isAmbiguousCreate(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error
    && (error as { code?: unknown }).code === "AMBIGUOUS_CREATE");
}

function safePending(ownership: OwnershipStore) {
  try {
    return ownership.listPending();
  } catch {
    return [];
  }
}
