import type { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MakeApiClient } from "../make-api/client";
import type { ClassifiedApiError } from "../make-api/api-error";
import { exitCodeFor, failureEnvelope, successEnvelope } from "./output";
import {
  refreshSearchIndex,
  searchEntries,
  type SearchQuery,
} from "../search/search-index";

type ParsedMakeUrl = {
  teamId?: number;
  organizationId?: number;
  scenarioId?: number;
  baseUrl?: string;
};

type SearchDependencies = {
  createClient: (baseUrl?: string) => Promise<MakeApiClient>;
  parseMakeUrl: (input: string) => ParsedMakeUrl;
  cliVersion: string;
  indexRoot?: string;
  writeOutput?: (value: unknown) => void;
};

export function registerSearchCommand(program: Command, dependencies: SearchDependencies): void {
  program
    .command("search")
    .description("Search every scenario blueprint in an organization")
    .option("--from-url <url>", "Resolve the organization and Make.com zone from any Make.com URL")
    .option("--organization <id>", "Organization ID")
    .option("--base-url <url>", "Make.com base URL (for example https://eu1.make.com)")
    .option("--query <text>", "Literal text matched against keys and values")
    .option("--regex <pattern>", "Regular expression matched against keys and values")
    .option("--field <name>", "Exact field name (requires --value)")
    .option("--value <value>", "Exact field value (requires --field)")
    .option("--case-sensitive", "Use case-sensitive matching")
    .option("--fresh", "Refetch every scenario instead of reusing unchanged cached records")
    .option("--human", "Render readable matches instead of the default JSON envelope")
    .action(async (opts) => {
      const emit = dependencies.writeOutput ?? ((value: unknown) => console.log(
        typeof value === "string" ? value : JSON.stringify(value, null, 2),
      ));
      try {
        const query = parseSearchQuery(opts);
        const parsed = opts.fromUrl ? dependencies.parseMakeUrl(opts.fromUrl) : {};
        const baseUrl = opts.baseUrl ?? parsed.baseUrl;
        const client = await dependencies.createClient(baseUrl);
        const organizationId = await resolveOrganizationId(client, opts.organization, parsed);
        const listing = await client.listAllScenarios({ organizationId });
        const clientBaseUrl = new URL(client.getScenarioUrl(1)).origin;
        const zone = zoneFromBaseUrl(clientBaseUrl);
        const indexRoot = dependencies.indexRoot ?? join(homedir(), ".make-fixer", "search-index");
        const refreshed = await refreshSearchIndex(client, listing.scenarios, {
          indexPath: join(indexRoot, zone, String(organizationId), "index.json"),
          organizationId,
          zone,
          fresh: Boolean(opts.fresh),
          concurrency: 2,
          pruneMissing: listing.complete,
        });
        const matches = searchEntries(
          refreshed.records.flatMap((record) => record.entries),
          query,
        );
        const data = {
          organizationId,
          matches,
          searchedScenarioCount: refreshed.records.length,
          cacheHits: refreshed.cacheHits,
          fetchedScenarioIds: refreshed.fetchedScenarioIds,
          failedScenarioIds: refreshed.failedScenarioIds,
          incomplete: refreshed.incomplete || !listing.complete,
          listing: {
            complete: listing.complete,
            pagesFetched: listing.pages.length,
            failedOffset: listing.failedOffset,
            failedStatus: listing.failedStatus ?? null,
          },
        };

        if (opts.human) {
          emit(renderHumanSearch(data));
          return;
        }
        const rate = client.getRateLimitSnapshot();
        emit(successEnvelope("search", data, {
          cliVersion: dependencies.cliVersion,
          source: "organization_index",
          verifiedAt: new Date().toISOString(),
          rateLimit: {
            organizationId,
            documentedRpm: rate.documentedRpm,
            effectiveRpm: rate.effectiveRpm,
            limitSource: rate.limitSource,
            requestsSent: rate.requestsSent,
            cacheHits: refreshed.cacheHits,
            retries: rate.retries,
            cooldownMs: rate.cooldownMs,
            checkpointed: true,
          },
        }));
      } catch (error) {
        const classified = classifySearchError(error);
        emit(failureEnvelope("search", classified));
        process.exitCode = exitCodeFor(classified);
      }
    });
}

export function parseSearchQuery(opts: {
  query?: unknown;
  regex?: unknown;
  field?: unknown;
  value?: unknown;
  caseSensitive?: boolean;
}): SearchQuery {
  const selected = [opts.query !== undefined, opts.regex !== undefined, opts.field !== undefined]
    .filter(Boolean).length;
  if (selected !== 1) {
    throw new Error("Choose exactly one of --query, --regex, or --field with --value.");
  }
  if (opts.value !== undefined && opts.field === undefined) {
    throw new Error("--value requires --field.");
  }
  if (opts.field !== undefined && opts.value === undefined) {
    throw new Error("--field requires --value.");
  }
  const caseSensitive = Boolean(opts.caseSensitive);
  if (typeof opts.regex === "string") {
    new RegExp(opts.regex, caseSensitive ? "" : "i");
    return { kind: "regex", pattern: opts.regex, caseSensitive };
  }
  if (typeof opts.field === "string" && typeof opts.value === "string") {
    return { kind: "field", field: opts.field, value: opts.value, caseSensitive };
  }
  if (typeof opts.query === "string") {
    return { kind: "literal", value: opts.query, caseSensitive };
  }
  throw new Error("Search arguments must be strings.");
}

async function resolveOrganizationId(
  client: Pick<MakeApiClient, "fetchTeam">,
  explicit: unknown,
  parsed: ParsedMakeUrl,
): Promise<number> {
  if (explicit !== undefined) {
    const organizationId = Number(explicit);
    if (!Number.isInteger(organizationId) || organizationId <= 0) {
      throw new Error("--organization must be a positive integer.");
    }
    return organizationId;
  }
  if (parsed.organizationId && parsed.organizationId > 0) return parsed.organizationId;
  if (parsed.teamId && parsed.teamId > 0) {
    const team = await client.fetchTeam(parsed.teamId);
    const organizationId = Number(team.organizationId ?? team.organization?.id ?? team.organization_id);
    if (Number.isInteger(organizationId) && organizationId > 0) return organizationId;
    throw new Error(`Team ${parsed.teamId} did not include an organization ID.`);
  }
  throw new Error("--organization <id> or --from-url <url> with a team/organization is required.");
}

function zoneFromBaseUrl(baseUrl: string | undefined): string {
  const value = baseUrl ?? "https://eu1.make.com";
  try {
    return new URL(value).hostname.replace(/\.make\.com$/, "");
  } catch {
    throw new Error("--base-url must be a valid URL.");
  }
}

function classifySearchError(error: unknown): ClassifiedApiError {
  if (error instanceof SyntaxError) {
    return searchError("INVALID_DATA", "Invalid regular expression.", false);
  }
  if (!(error instanceof Error)) return searchError("UNKNOWN_API_ERROR", "Search failed.", false);

  const statusMatch = error.message.match(/\berror\s+(\d{3})\b/i);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  if (status === 401) return searchError("AUTH_INVALID", "Make.com authentication failed.", false, status);
  if (status === 402) return searchError("PLAN_RESTRICTED", "The Make.com plan does not allow this request.", false, status);
  if (status === 403) return searchError("SCOPE_MISSING", "The API token lacks access to the requested organization data.", false, status);
  if (status === 404) return searchError("NOT_FOUND", "The requested Make.com resource was not found.", false, status);
  if (status === 405 || status === 501) return searchError("NOT_SUPPORTED", "The Make.com endpoint is not supported.", false, status);
  if (status === 429) return searchError("RATE_LIMITED", "Make.com rate-limited the request.", true, status);
  if (status !== null && status >= 500) return searchError("TRANSIENT", "Make.com is temporarily unavailable.", true, status);
  if (status !== null) return searchError("INVALID_DATA", "Make.com rejected the search request.", false, status);

  const isLocalInput = /^(Choose |--|Team \d+ did not|Search arguments)/.test(error.message);
  return searchError(
    isLocalInput ? "INVALID_DATA" : "TRANSIENT",
    isLocalInput ? error.message.slice(0, 500) : "Search failed while accessing Make.com.",
    !isLocalInput,
  );
}

function searchError(
  code: ClassifiedApiError["code"],
  message: string,
  retryable: boolean,
  httpStatus: number | null = null,
): ClassifiedApiError {
  return { code, message, httpStatus, providerCode: null, retryable };
}

function renderHumanSearch(data: {
  organizationId: number;
  matches: ReturnType<typeof searchEntries>;
  incomplete: boolean;
  failedScenarioIds: number[];
}): string {
  const lines = [`Organization ${data.organizationId}: ${data.matches.length} match(es)`];
  for (const match of data.matches) {
    const module = match.moduleId === null ? "" : ` module #${match.moduleId}`;
    lines.push(`#${match.scenarioId} ${match.scenarioName}${module} ${match.path}: ${match.snippet}`);
  }
  if (data.incomplete) lines.push(`Incomplete; failed scenarios: ${data.failedScenarioIds.join(", ")}`);
  return lines.join("\n");
}
