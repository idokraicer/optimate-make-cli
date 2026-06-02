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
import { fetchWithRetry } from "./fetch-retry";

export interface MakeApiConfig {
  token: string;
  baseUrl: string;
}

export class MakeApiClient {
  private token: string;
  private baseUrl: string;

  constructor(config: MakeApiConfig) {
    this.token = config.token;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
  }

  getBlueprintUrl(scenarioId: number): string {
    return `${this.baseUrl}/api/v2/scenarios/${scenarioId}/blueprint`;
  }

  getScenarioUrl(scenarioId: number): string {
    return `${this.baseUrl}/api/v2/scenarios/${scenarioId}`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Token ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  async fetchBlueprint(scenarioId: number): Promise<{ blueprint: Blueprint; raw: any }> {
    const res = await fetchWithRetry(this.getBlueprintUrl(scenarioId), {
      headers: this.headers(),
    });
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

    const res = await fetchWithRetry(this.getScenarioUrl(scenarioId), {
      method: "PATCH",
      headers: this.headers(),
      body,
    });

    if (!res.ok) {
      throw new Error(`Make API PATCH error ${res.status}: ${await res.text()}`);
    }
  }

  async createNote(scenarioId: number, moduleIds: number[], content: string): Promise<Note> {
    const res = await fetchWithRetry(`${this.baseUrl}/api/v2/scenarios/${scenarioId}/notes`, {
      method: "POST",
      headers: this.headers(),
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
      const res = await fetchWithRetry(`${this.baseUrl}/api/v2/scenarios/${scenarioId}/notes`, {
        headers: this.headers(),
      });
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

    const res = await fetchWithRetry(url, { headers: this.headers() });
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

    const res = await fetchWithRetry(url, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`Make API error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const raw = Array.isArray(data.appModules) ? data.appModules : [];
    return raw.map((mod: unknown) => AppModuleSchema.parse(mod));
  }

  async listOrganizations(): Promise<any[]> {
    const res = await this.fetchWithBackoff(`${this.baseUrl}/api/v2/organizations`);
    if (!res.ok) {
      throw new Error(`Make API list organizations error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return Array.isArray(data.organizations) ? data.organizations : [];
  }

  async listTeams(organizationId: number): Promise<any[]> {
    const url = `${this.baseUrl}/api/v2/teams?organizationId=${organizationId}`;
    const res = await this.fetchWithBackoff(url);
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
    const params = new URLSearchParams();
    if (opts.teamId != null) params.set("teamId", String(opts.teamId));
    if (opts.organizationId != null) params.set("organizationId", String(opts.organizationId));
    if (opts.isActive != null) params.set("isActive", String(opts.isActive));
    if (opts.folderId != null) params.set("folderId", String(opts.folderId));
    if (opts.limit != null) params.set("pg[limit]", String(opts.limit));
    if (opts.offset != null) params.set("pg[offset]", String(opts.offset));

    const url = `${this.baseUrl}/api/v2/scenarios?${params.toString()}`;
    const res = await fetchWithRetry(url, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`Make API list scenarios error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return Array.isArray(data.scenarios) ? data.scenarios : [];
  }

  async fetchScenario(scenarioId: number): Promise<any> {
    const res = await fetchWithRetry(this.getScenarioUrl(scenarioId), { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`Make API fetch scenario error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return data.scenario ?? data;
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
    const res = await this.fetchWithBackoff(url);
    if (!res.ok) {
      throw new Error(`Make API list executions error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return Array.isArray(data.scenarioLogs) ? data.scenarioLogs : (Array.isArray(data.logs) ? data.logs : []);
  }

  /**
   * Fetch wrapper that injects auth headers and rides through Make.com rate
   * limits via the shared fetchWithRetry helper (429/503, Retry-After aware,
   * exponential backoff).
   */
  private async fetchWithBackoff(url: string, init?: RequestInit): Promise<Response> {
    const headers = { ...(init?.headers ?? {}), ...this.headers() };
    return fetchWithRetry(url, { ...init, headers });
  }

  async fetchExecution(scenarioId: number, executionId: string): Promise<any> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/api/v2/scenarios/${scenarioId}/executions/${encodeURIComponent(executionId)}`,
      { headers: this.headers() },
    );
    if (!res.ok) {
      throw new Error(`Make API fetch execution error ${res.status}: ${await res.text()}`);
    }
    return await res.json();
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
