import {
  BlueprintSchema,
  MakeAppSchema,
  AppModuleSchema,
  type Blueprint,
  type Note,
  type MakeApp,
  type AppModule,
} from "./types";
import { BUILTIN_MODULES } from "../data/builtin-modules";
import {
  getDefaultRequestCoordinator,
  type RequestContext,
  type RequestCoordinatorLike,
} from "./request-coordinator";
import {
  FALLBACK_RPM,
  effectiveRequestsPerMinute,
  type RateBucket,
  type RateLimitSnapshot,
} from "./rate-limiter";
import type { ApiErrorCode } from "./api-error";
import type {
  ExecutionDetails,
  ScenarioInterface,
} from "./scenario-runner";

export interface MakeApiConfig {
  token: string;
  baseUrl: string;
  organizationId?: number;
  coordinator?: RequestCoordinatorLike;
}

export interface TeamDetails {
  id: number;
  organizationId?: number;
  organization?: { id?: number };
  organization_id?: number;
  name?: string;
  [key: string]: unknown;
}

export interface OrganizationDetails {
  id: number;
  name?: string;
  license?: {
    apiLimit?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export const SCENARIO_PAGE_SIZE = 1000;

export interface ScenarioListPage {
  scenarios: any[];
  offset: number;
  count: number;
  pagination: Record<string, unknown> | null;
}

export interface ScenarioListResult {
  scenarios: any[];
  pages: ScenarioListPage[];
  complete: boolean;
  failedOffset: number | null;
  failedStatus?: number | null;
  failure?: {
    code: ApiErrorCode;
    httpStatus: number | null;
    retryable: boolean;
  };
}

export class MakeApiClient {
  private token: string;
  private baseUrl: string;
  private organizationId: number | "unknown";
  private coordinator?: RequestCoordinatorLike;
  private documentedRpm: number | null = null;
  private organizationDetailsLoaded = false;

  constructor(config: MakeApiConfig) {
    this.token = config.token;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.organizationId = config.organizationId ?? "unknown";
    this.coordinator = config.coordinator;
  }

  getBlueprintUrl(scenarioId: number): string {
    return `${this.baseUrl}/api/v2/scenarios/${scenarioId}/blueprint`;
  }

  getScenarioUrl(scenarioId: number): string {
    return `${this.baseUrl}/api/v2/scenarios/${scenarioId}`;
  }

  getExecutionLogUrl(scenarioId: number, executionId: string): string {
    return `${this.baseUrl}/api/v2/scenarios/${scenarioId}/logs/${encodeURIComponent(executionId)}`;
  }

  getHookLogsUrl(hookId: number | string, opts?: {
    from?: string;
    to?: string;
    limit?: number;
    sortDir?: "asc" | "desc";
  }): string {
    const params = new URLSearchParams();
    if (opts?.from) params.set("from", opts.from);
    if (opts?.to) params.set("to", opts.to);
    params.set("pg[limit]", String(opts?.limit ?? 100));
    params.set("pg[sortDir]", opts?.sortDir ?? "desc");
    return `${this.baseUrl}/api/v2/hooks/${encodeURIComponent(String(hookId))}/logs?${params.toString()}`;
  }

  getHookLogUrl(hookId: number | string, hookLogId: string): string {
    return `${this.baseUrl}/api/v2/hooks/${encodeURIComponent(String(hookId))}/logs/${encodeURIComponent(hookLogId)}`;
  }

  /**
   * Build the human-facing scenario editor URL.
   * NOTE: the path segment is the TEAM id, NOT the org id — using an org id
   * here produces a broken link. Always pass the scenario's own `teamId`.
   */
  getEditUrl(teamId: number, scenarioId: number): string {
    return `${this.baseUrl}/${teamId}/scenarios/${scenarioId}/edit`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Token ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  private async request(
    url: string | URL,
    init: RequestInit = {},
    context: Partial<Omit<RequestContext, "bucket">> & {
      organizationId?: number | "unknown";
    } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(this.headers())) headers.set(name, value);
    const parsed = new URL(String(url));
    const { organizationId, ...requestContext } = context;
    this.coordinator ??= getDefaultRequestCoordinator();
    return this.coordinator.request(url, { ...init, headers }, {
      bucket: {
        zone: parsed.hostname.replace(/\.make\.com$/, ""),
        organizationId: organizationId ?? this.organizationId,
      },
      ...requestContext,
    });
  }

  private rateBucket(organizationId = this.organizationId): RateBucket {
    return {
      zone: new URL(this.baseUrl).hostname.replace(/\.make\.com$/, ""),
      organizationId,
    };
  }

  private useOrganization(organizationId: number): void {
    if (this.organizationId !== organizationId) {
      this.documentedRpm = null;
      this.organizationDetailsLoaded = false;
    }
    this.organizationId = organizationId;
  }

  private hasValidOrganizationRateContext(organizationId: number): boolean {
    if (this.organizationId !== organizationId) return false;
    if (this.organizationDetailsLoaded) return true;
    this.coordinator ??= getDefaultRequestCoordinator();
    const snapshot = this.coordinator.getRateLimitSnapshot?.(this.rateBucket(organizationId));
    return snapshot?.documentedRpm != null && snapshot.limitSource !== "fallback";
  }

  private async ensureOrganizationDetails(organizationId: number): Promise<void> {
    this.useOrganization(organizationId);
    if (this.hasValidOrganizationRateContext(organizationId)) return;
    await this.discoverOrganization(organizationId);
  }

  getRateLimitSnapshot(): RateLimitSnapshot {
    this.coordinator ??= getDefaultRequestCoordinator();
    return this.coordinator.getRateLimitSnapshot?.(this.rateBucket()) ?? {
      documentedRpm: this.documentedRpm,
      effectiveRpm: this.documentedRpm === null
        ? FALLBACK_RPM
        : effectiveRequestsPerMinute(this.documentedRpm),
      limitSource: this.documentedRpm === null ? "fallback" : "organization_api",
      requestsSent: 0,
      retries: 0,
      cooldownMs: 0,
    };
  }

  async fetchTeam(teamId: number): Promise<TeamDetails> {
    const res = await this.request(
      `${this.baseUrl}/api/v2/teams/${teamId}`,
      {},
      { organizationId: "unknown" },
    );
    if (!res.ok) {
      throw new Error(`Make API fetch team error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return (data.team ?? data) as TeamDetails;
  }

  async fetchOrganization(organizationId: number): Promise<OrganizationDetails> {
    this.useOrganization(organizationId);
    const res = await this.request(
      `${this.baseUrl}/api/v2/organizations/${organizationId}`,
      {},
      { organizationId },
    );
    if (!res.ok) {
      throw new Error(`Make API fetch organization error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    const organization = data.organization ?? data;
    this.organizationDetailsLoaded = true;
    const apiLimit = Number(organization?.license?.apiLimit);
    if (Number.isFinite(apiLimit) && apiLimit > 0) {
      this.documentedRpm = Math.floor(apiLimit);
      this.coordinator?.setOrganizationLimit?.(
        this.rateBucket(organizationId),
        this.documentedRpm,
      );
    }
    return organization as OrganizationDetails;
  }

  async discoverOrganization(organizationId: number): Promise<boolean> {
    this.useOrganization(organizationId);
    try {
      await this.fetchOrganization(organizationId);
      return true;
    } catch {
      return false;
    }
  }

  async discoverOrganizationForTeam(teamId: number): Promise<boolean> {
    try {
      const team = await this.fetchTeam(teamId);
      const organizationId = Number(
        team.organizationId ?? team.organization?.id ?? team.organization_id,
      );
      if (!Number.isInteger(organizationId) || organizationId <= 0) return false;
      this.useOrganization(organizationId);
      return await this.discoverOrganization(organizationId);
    } catch {
      return false;
    }
  }

  async discoverOrganizationForScenario(scenarioId: number): Promise<boolean> {
    try {
      const scenario = await this.fetchScenario(scenarioId);
      const organizationId = Number(
        scenario.organizationId
        ?? scenario.organization?.id
        ?? scenario.organization_id,
      );
      if (Number.isInteger(organizationId) && organizationId > 0) {
        this.useOrganization(organizationId);
        return await this.discoverOrganization(organizationId);
      }
      const teamId = Number(scenario.teamId ?? scenario.team?.id ?? scenario.team_id);
      if (!Number.isInteger(teamId) || teamId <= 0) return false;
      return await this.discoverOrganizationForTeam(teamId);
    } catch {
      return false;
    }
  }

  async fetchBlueprint(scenarioId: number): Promise<{ blueprint: Blueprint; raw: any }> {
    const res = await this.request(this.getBlueprintUrl(scenarioId));
    if (!res.ok) {
      throw new Error(`Make API error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();

    let blueprintData: any;
    if (data.response?.blueprint) {
      blueprintData = data.response.blueprint;
    } else if (data.blueprint) {
      blueprintData =
        typeof data.blueprint === "string" ? JSON.parse(data.blueprint) : data.blueprint;
    } else {
      blueprintData = data;
    }

    const blueprint = BlueprintSchema.parse(blueprintData);
    return { blueprint, raw: data };
  }

  async pushBlueprint(scenarioId: number, blueprint: Blueprint): Promise<void> {
    const body = JSON.stringify({
      blueprint: JSON.stringify(blueprint),
    });

    const res = await this.request(this.getScenarioUrl(scenarioId), {
      method: "PATCH",
      body,
    });

    if (!res.ok) {
      throw new Error(`Make API PATCH error ${res.status}: ${await res.text()}`);
    }
  }

  async createNote(scenarioId: number, moduleIds: number[], content: string): Promise<Note> {
    const res = await this.request(`${this.baseUrl}/api/v2/scenarios/${scenarioId}/notes`, {
      method: "POST",
      body: JSON.stringify({ moduleIds, content }),
    });

    if (!res.ok) {
      throw new Error(`Make API create note error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    return data.note;
  }

  async fetchNotes(scenarioId: number): Promise<Note[]> {
    try {
      const res = await this.request(`${this.baseUrl}/api/v2/scenarios/${scenarioId}/notes`);
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data.notes) ? data.notes : [];
    } catch {
      return [];
    }
  }

  async fetchApps(opts?: { skipSdkApps?: boolean }): Promise<MakeApp[]> {
    const params = new URLSearchParams();
    if (opts?.skipSdkApps) params.set("skipSdkApps", "true");
    const qs = params.toString();
    const url = `${this.baseUrl}/api/v2/imt/apps-meta${qs ? `?${qs}` : ""}`;

    const res = await this.request(url);
    if (!res.ok) {
      throw new Error(`Make API error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const raw = Array.isArray(data.apps) ? data.apps : [];
    return raw.map((app: unknown) => MakeAppSchema.parse(app));
  }

  async fetchAppModules(appName: string, version: number): Promise<AppModule[]> {
    const builtin = BUILTIN_MODULES[appName];
    if (builtin) return builtin;

    const url = `${this.baseUrl}/api/v2/imt/apps/${encodeURIComponent(appName)}/${version}/modules-with-credentials`;

    const res = await this.request(url);
    if (!res.ok) {
      throw new Error(`Make API error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const raw = Array.isArray(data.appModules) ? data.appModules : [];
    return raw.map((mod: unknown) => AppModuleSchema.parse(mod));
  }

  async listOrganizations(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/api/v2/organizations`);
    if (!res.ok) {
      throw new Error(`Make API list organizations error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return Array.isArray(data.organizations) ? data.organizations : [];
  }

  async listTeams(organizationId: number): Promise<any[]> {
    await this.discoverOrganization(organizationId);
    const url = `${this.baseUrl}/api/v2/teams?organizationId=${organizationId}`;
    const res = await this.request(url, {}, { organizationId });
    if (!res.ok) {
      throw new Error(`Make API list teams error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return Array.isArray(data.teams) ? data.teams : [];
  }

  async listScenarios(opts: {
    teamId?: number;
    organizationId?: number;
    isActive?: boolean;
    folderId?: number;
    limit?: number;
    offset?: number;
  }): Promise<any[]> {
    if (opts.organizationId != null) {
      await this.ensureOrganizationDetails(opts.organizationId);
    } else if (opts.teamId != null) {
      await this.discoverOrganizationForTeam(opts.teamId);
    }
    return (await this.fetchScenarioPage(opts)).scenarios;
  }

  async listScenariosPage(opts: {
    teamId?: number;
    organizationId?: number;
    isActive?: boolean;
    folderId?: number;
    limit?: number;
    offset?: number;
  }): Promise<ScenarioListPage> {
    if (opts.organizationId != null) {
      await this.ensureOrganizationDetails(opts.organizationId);
    } else if (opts.teamId != null) {
      await this.discoverOrganizationForTeam(opts.teamId);
    }
    return this.fetchScenarioPage(opts);
  }

  async listAllScenarios(opts: {
    teamId?: number;
    organizationId?: number;
    isActive?: boolean;
    folderId?: number;
  }): Promise<ScenarioListResult> {
    if (opts.organizationId != null) {
      await this.ensureOrganizationDetails(opts.organizationId);
    } else if (opts.teamId != null) {
      await this.discoverOrganizationForTeam(opts.teamId);
    }

    const scenarios: any[] = [];
    const pages: ScenarioListPage[] = [];
    let offset = 0;
    while (true) {
      try {
        const page = await this.fetchScenarioPage({
          ...opts,
          limit: SCENARIO_PAGE_SIZE,
          offset,
        });
        pages.push(page);
        scenarios.push(...page.scenarios);
        if (!hasNextScenarioPage(page, scenarios.length)) {
          return { scenarios, pages, complete: true, failedOffset: null };
        }
        offset += SCENARIO_PAGE_SIZE;
      } catch (error) {
        if (pages.length === 0) throw error;
        const failedStatus = statusFromClientError(error);
        return {
          scenarios,
          pages,
          complete: false,
          failedOffset: offset,
          failedStatus,
          failure: classifyScenarioListFailure(failedStatus),
        };
      }
    }
  }

  private async fetchScenarioPage(opts: {
    teamId?: number;
    organizationId?: number;
    isActive?: boolean;
    folderId?: number;
    limit?: number;
    offset?: number;
  }): Promise<ScenarioListPage> {
    const params = new URLSearchParams();
    if (opts.teamId != null) params.set("teamId", String(opts.teamId));
    if (opts.organizationId != null) params.set("organizationId", String(opts.organizationId));
    if (opts.isActive != null) params.set("isActive", String(opts.isActive));
    if (opts.folderId != null) params.set("folderId", String(opts.folderId));
    if (opts.limit != null) params.set("pg[limit]", String(opts.limit));
    if (opts.offset != null) params.set("pg[offset]", String(opts.offset));

    const url = `${this.baseUrl}/api/v2/scenarios?${params.toString()}`;
    const res = await this.request(url, {}, {
      organizationId: opts.organizationId ?? this.organizationId,
    });
    if (!res.ok) {
      throw new Error(`Make API list scenarios error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    const scenarios = Array.isArray(data.scenarios) ? data.scenarios : [];
    const pagination = paginationMetadata(data);
    return {
      scenarios,
      offset: opts.offset ?? 0,
      count: scenarios.length,
      pagination,
    };
  }

  async fetchScenario(scenarioId: number): Promise<any> {
    const res = await this.request(this.getScenarioUrl(scenarioId));
    if (!res.ok) {
      throw new Error(`Make API fetch scenario error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return data.scenario ?? data;
  }

  async fetchScenarioInterface(
    scenarioId: number,
    signal?: AbortSignal,
  ): Promise<ScenarioInterface> {
    const res = await this.request(
      `${this.baseUrl}/api/v2/scenarios/${scenarioId}/interface`,
      {},
      { signal },
    );
    if (!res.ok) {
      throw new Error(`Make API fetch scenario interface error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return (
      data.interface
      ?? data.scenarioInterface
      ?? data.response?.interface
      ?? data.response?.scenarioInterface
      ?? data.response
      ?? data
    ) as ScenarioInterface;
  }

  async runScenario(
    scenarioId: number,
    body: { data?: object; responsive: boolean },
    signal?: AbortSignal,
  ): Promise<{ executionId: string; status?: string; outputs?: object }> {
    const res = await this.request(
      `${this.baseUrl}/api/v2/scenarios/${scenarioId}/run`,
      { method: "POST", body: JSON.stringify(body) },
      {
        organizationRateExempt: true,
        retryTransientResponses: false,
        signal,
      },
    );
    const data = await readJsonSafely(res);
    const executionId = extractExecutionId(data);
    if (!res.ok) {
      throw new ScenarioRunRequestError(
        `Make API run scenario error ${res.status}`,
        executionId,
        res.status,
      );
    }
    if (!executionId) {
      throw new Error("Make API run scenario response did not include an execution ID.");
    }
    const source = responsePayload(data);
    return {
      executionId,
      ...(source?.status !== undefined ? { status: normalizeExecutionStatus(source.status) } : {}),
      ...(isObject(source?.outputs) ? { outputs: source.outputs } : {}),
    };
  }

  async fetchExecutionDetails(
    scenarioId: number,
    executionId: string,
    signal?: AbortSignal,
  ): Promise<ExecutionDetails> {
    const res = await this.request(
      `${this.baseUrl}/api/v2/scenarios/${scenarioId}/executions/${encodeURIComponent(executionId)}`,
      {},
      { signal },
    );
    if (!res.ok) {
      throw new Error(`Make API fetch execution details error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    const source = responsePayload(data);
    return {
      status: normalizeExecutionStatus(source.status),
      ...(isObject(source.outputs) ? { outputs: source.outputs } : {}),
      ...(source.error !== undefined ? { error: source.error } : {}),
    };
  }

  async listExecutions(scenarioId: number, opts?: {
    from?: string;
    to?: string;
    status?: 1 | 2 | 3;
    limit?: number;
    offset?: number;
    sortDir?: "asc" | "desc";
  }): Promise<any[]> {
    const params = new URLSearchParams();
    if (opts?.from) params.set("from", opts.from);
    if (opts?.to) params.set("to", opts.to);
    if (opts?.status != null) params.set("status", String(opts.status));
    params.set("pg[limit]", String(opts?.limit ?? 20));
    if (opts?.offset != null) params.set("pg[offset]", String(opts.offset));
    params.set("pg[sortBy]", "imtId");
    params.set("pg[sortDir]", opts?.sortDir ?? "desc");

    const url = `${this.baseUrl}/api/v2/scenarios/${scenarioId}/logs?${params.toString()}`;
    const res = await this.request(url);
    if (!res.ok) {
      throw new Error(`Make API list executions error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return Array.isArray(data.scenarioLogs) ? data.scenarioLogs : (Array.isArray(data.logs) ? data.logs : []);
  }

  async fetchExecution(scenarioId: number, executionId: string): Promise<any> {
    const res = await this.request(
      `${this.baseUrl}/api/v2/scenarios/${scenarioId}/executions/${encodeURIComponent(executionId)}`,
    );
    if (!res.ok) {
      throw new Error(`Make API fetch execution error ${res.status}: ${await res.text()}`);
    }
    return await res.json();
  }

  async fetchExecutionLog(scenarioId: number, executionId: string): Promise<any> {
    const res = await this.request(this.getExecutionLogUrl(scenarioId, executionId));
    if (!res.ok) {
      throw new Error(`Make API fetch execution log error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return data.scenarioLog ?? data;
  }

  async listHookLogs(hookId: number | string, opts?: {
    from?: string;
    to?: string;
    limit?: number;
    sortDir?: "asc" | "desc";
  }): Promise<any[]> {
    const res = await this.request(this.getHookLogsUrl(hookId, opts));
    if (!res.ok) {
      throw new Error(`Make API list webhook logs error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return Array.isArray(data.hookLogs) ? data.hookLogs : [];
  }

  async fetchHookLog(hookId: number | string, hookLogId: string): Promise<any> {
    const res = await this.request(this.getHookLogUrl(hookId, hookLogId));
    if (!res.ok) {
      throw new Error(`Make API fetch webhook log error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return data.hookLog ?? data;
  }

  async searchApps(query: string, apps?: MakeApp[]): Promise<MakeApp[]> {
    const catalog = apps ?? await this.fetchApps();
    const q = query.toLowerCase();

    return catalog.filter((app) => {
      return (
        app.name.toLowerCase().includes(q) ||
        app.label.toLowerCase().includes(q) ||
        app.keywords.toLowerCase().includes(q)
      );
    });
  }
}

export class ScenarioRunRequestError extends Error {
  constructor(
    message: string,
    readonly executionId: string | null,
    readonly httpStatus: number | null,
  ) {
    super(message);
    this.name = "ScenarioRunRequestError";
  }
}

async function readJsonSafely(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function extractExecutionId(data: any): string | null {
  const source = responsePayload(data);
  const value = source?.executionId ?? source?.id ?? source?.execution?.id ?? source?.execution;
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function responsePayload(data: any): any {
  const response = isObject(data?.response) ? data.response : data;
  return isObject(response?.execution) ? response.execution : response;
}

function normalizeExecutionStatus(value: unknown): ExecutionDetails["status"] {
  if (value === 1 || value === "1") return "SUCCESS";
  if (value === 2 || value === "2") return "WARNING";
  if (value === 3 || value === "3") return "ERROR";
  const status = String(value ?? "RUNNING").toUpperCase();
  return status === "SUCCESS" || status === "WARNING" || status === "ERROR"
    ? status
    : "RUNNING";
}

function paginationMetadata(data: any): Record<string, unknown> | null {
  const value = data?.pg ?? data?.pagination;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasNextScenarioPage(page: ScenarioListPage, fetchedCount: number): boolean {
  if (page.count < SCENARIO_PAGE_SIZE) return false;
  const pagination = page.pagination;
  if (!pagination) return true;

  const explicit = pagination.hasNextPage ?? pagination.hasNext ?? pagination.hasMore;
  if (typeof explicit === "boolean") return explicit;

  const total = Number(pagination.total ?? pagination.totalCount);
  if (Number.isFinite(total) && total >= 0) return fetchedCount < total;

  const nextOffset = Number(pagination.nextOffset);
  if (Number.isFinite(nextOffset)) return nextOffset > page.offset;
  return true;
}

function statusFromClientError(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const match = error.message.match(/\berror\s+(\d{3})\b/i);
  return match ? Number(match[1]) : null;
}

function classifyScenarioListFailure(status: number | null): {
  code: ApiErrorCode;
  httpStatus: number | null;
  retryable: boolean;
} {
  if (status === 401) return { code: "AUTH_INVALID", httpStatus: status, retryable: false };
  if (status === 402) return { code: "PLAN_RESTRICTED", httpStatus: status, retryable: false };
  if (status === 403) return { code: "SCOPE_MISSING", httpStatus: status, retryable: false };
  if (status === 404) return { code: "NOT_FOUND", httpStatus: status, retryable: false };
  if (status === 405 || status === 501) {
    return { code: "NOT_SUPPORTED", httpStatus: status, retryable: false };
  }
  if (status === 429) return { code: "RATE_LIMITED", httpStatus: status, retryable: true };
  if (status === null || status >= 500) {
    return { code: "TRANSIENT", httpStatus: status, retryable: true };
  }
  return { code: "INVALID_DATA", httpStatus: status, retryable: false };
}
