import type { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MakeApiClient } from "../make-api/client";
import type { ClassifiedApiError } from "../make-api/api-error";
import {
  findModuleExamples,
  type ModuleExampleQuery,
} from "../examples/module-examples";
import { refreshSearchIndex } from "../search/search-index";
import { exitCodeFor, failureEnvelope, successEnvelope } from "./output";

type ParsedMakeUrl = {
  teamId?: number;
  organizationId?: number;
  baseUrl?: string;
};

type ExamplesDependencies = {
  createClient: (baseUrl?: string) => Promise<MakeApiClient>;
  parseMakeUrl: (input: string) => ParsedMakeUrl;
  cliVersion: string;
  indexRoot?: string;
  writeOutput?: (value: unknown) => void;
};

export function registerExamplesCommand(
  program: Command,
  dependencies: ExamplesDependencies,
): void {
  program
    .command("examples")
    .description("Discover reusable module configurations from accessible organization scenarios")
    .requiredOption("--from-url <url>", "Any Make.com URL identifying the zone and organization/team")
    .option("--module <module>", "Exact Make module name, for example monday:CreateItem")
    .option("--app <app>", "App prefix, for example monday")
    .option("--search <text>", "Literal text in a sanitized module configuration")
    .option("--version <number>", "Exact module version")
    .option("--scenario <id>", "Exact scenario ID (use with --module-id)")
    .option("--module-id <id>", "Exact module ID (use with --scenario)")
    .option("--full", "Return one exact full sanitized fragment; requires --scenario and --module-id")
    .option("--fresh", "Refetch all organization scenario blueprints")
    .action(async (opts) => {
      const emit = dependencies.writeOutput ?? defaultEmitter;
      try {
        const query = parseExampleQuery(opts);
        const parsed = dependencies.parseMakeUrl(opts.fromUrl);
        if (!parsed.baseUrl) throw new Error("--from-url must be a valid Make.com URL.");
        const client = await dependencies.createClient(parsed.baseUrl);
        const organizationId = await resolveOrganizationId(client, parsed);
        const listing = await client.listAllScenarios({ organizationId });
        const zone = new URL(client.getScenarioUrl(1)).hostname.replace(/\.make\.com$/, "");
        const refreshed = await refreshSearchIndex(client, listing.scenarios, {
          indexPath: join(
            dependencies.indexRoot ?? join(homedir(), ".make-fixer", "search-index"),
            zone,
            String(organizationId),
            "index.json",
          ),
          organizationId,
          zone,
          fresh: Boolean(opts.fresh),
          concurrency: 2,
          pruneMissing: listing.complete,
        });
        const examples = findModuleExamples(refreshed.records, query);
        const rate = client.getRateLimitSnapshot();
        emit(successEnvelope("examples", {
          organizationId,
          found: examples.length > 0,
          examples,
          incomplete: refreshed.incomplete || !listing.complete,
          failedScenarioIds: refreshed.failedScenarioIds,
          cacheHits: refreshed.cacheHits,
          fetchedScenarioIds: refreshed.fetchedScenarioIds,
        }, {
          cliVersion: dependencies.cliVersion,
          source: "organization_index",
          verifiedAt: new Date().toISOString(),
          rateLimit: {
            organizationId,
            ...rate,
            cacheHits: refreshed.cacheHits,
            checkpointed: true,
          },
        }));
      } catch (error) {
        const classified = classifyCommandError(error, "Example discovery failed.");
        emit(failureEnvelope("examples", classified));
        process.exitCode = exitCodeFor(classified);
      }
    });
}

export function parseExampleQuery(opts: {
  module?: unknown;
  app?: unknown;
  search?: unknown;
  version?: unknown;
  scenario?: unknown;
  moduleId?: unknown;
  full?: boolean;
}): ModuleExampleQuery {
  const hasExact = opts.scenario !== undefined || opts.moduleId !== undefined;
  if (hasExact && (opts.scenario === undefined || opts.moduleId === undefined)) {
    throw new Error("--scenario and --module-id must be provided together.");
  }
  const selected = [
    opts.module !== undefined,
    opts.app !== undefined,
    opts.search !== undefined,
    hasExact,
  ].filter(Boolean).length;
  if (selected !== 1) throw new Error("Choose exactly one example lookup mode.");
  if (opts.full && !hasExact) {
    throw new Error("--full requires both --scenario and --module-id.");
  }
  const version = opts.version === undefined ? undefined : positiveInteger(opts.version, "--version");
  if (hasExact) {
    return {
      scenarioId: positiveInteger(opts.scenario, "--scenario"),
      moduleId: positiveInteger(opts.moduleId, "--module-id"),
      version,
      full: Boolean(opts.full),
    };
  }
  if (typeof opts.module === "string" && opts.module.length > 0) {
    return { module: opts.module, version };
  }
  if (typeof opts.app === "string" && opts.app.length > 0) return { app: opts.app, version };
  if (typeof opts.search === "string" && opts.search.length > 0) {
    return { search: opts.search, version };
  }
  throw new Error("Example lookup values must be non-empty strings.");
}

async function resolveOrganizationId(
  client: Pick<MakeApiClient, "fetchTeam">,
  parsed: ParsedMakeUrl,
): Promise<number> {
  if (parsed.organizationId && parsed.organizationId > 0) return parsed.organizationId;
  if (!parsed.teamId || parsed.teamId <= 0) {
    throw new Error("--from-url must identify a team or organization.");
  }
  const team = await client.fetchTeam(parsed.teamId);
  const organizationId = Number(team.organizationId ?? team.organization?.id ?? team.organization_id);
  if (!Number.isInteger(organizationId) || organizationId <= 0) {
    throw new Error(`Team ${parsed.teamId} did not include an organization ID.`);
  }
  return organizationId;
}

function positiveInteger(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer.`);
  return number;
}

export function classifyCommandError(error: unknown, fallback: string): ClassifiedApiError {
  const message = error instanceof Error ? error.message : "";
  const statusMatch = message.match(/\berror\s+(\d{3})\b/i);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  if (status === 401) return commandError("AUTH_INVALID", "Make.com authentication failed.", false, status);
  if (status === 402) return commandError("PLAN_RESTRICTED", "The Make.com plan does not allow this request.", false, status);
  if (status === 403) return commandError("SCOPE_MISSING", "The API token lacks access to the requested Make.com data.", false, status);
  if (status === 404) return commandError("NOT_FOUND", "The requested Make.com resource was not found.", false, status);
  if (status === 405 || status === 501) return commandError("NOT_SUPPORTED", "The Make.com endpoint is not supported.", false, status);
  if (status === 429) return commandError("RATE_LIMITED", "Make.com rate-limited the request.", true, status);
  if (status !== null && status >= 500) return commandError("TRANSIENT", "Make.com is temporarily unavailable.", true, status);
  const local = /^(Choose |--|Team |Example lookup)/.test(message);
  return commandError(local ? "INVALID_DATA" : "TRANSIENT", local ? message.slice(0, 500) : fallback, !local);
}

function commandError(
  code: ClassifiedApiError["code"],
  message: string,
  retryable: boolean,
  httpStatus: number | null = null,
): ClassifiedApiError {
  return { code, message, httpStatus, providerCode: null, retryable };
}

function defaultEmitter(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
