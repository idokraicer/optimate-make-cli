import { describe, expect, test } from "bun:test";
import { MakeApiClient } from "./client";
import { MakeAppSchema, AppModuleSchema } from "./types";
import type { RequestContext } from "./request-coordinator";
import type { RateBucket, RateLimitSnapshot } from "./rate-limiter";

describe("MakeApiClient", () => {
  test("discovers team organization limit and uses effective 57 RPM in the organization bucket", async () => {
    const requests: Array<{ url: string; context: RequestContext }> = [];
    const snapshots = new Map<number | "unknown", RateLimitSnapshot>();
    const coordinator = {
      request: async (url: string | URL, _init: RequestInit, requestContext: RequestContext) => {
        const stringUrl = String(url);
        requests.push({ url: stringUrl, context: requestContext });
        if (stringUrl.endsWith("/api/v2/teams/2186253")) {
          return Response.json({ team: { id: 2186253, organizationId: 8430514 } });
        }
        if (stringUrl.endsWith("/api/v2/organizations/8430514")) {
          return Response.json({
            organization: { id: 8430514, license: { apiLimit: 60 } },
          });
        }
        return Response.json({ scenario: { id: 123 } });
      },
      setOrganizationLimit: (rateBucket: RateBucket, apiLimit: number) => {
        snapshots.set(rateBucket.organizationId, {
          documentedRpm: apiLimit,
          effectiveRpm: Math.floor(apiLimit * 0.95),
          limitSource: "organization_api",
          requestsSent: 0,
          retries: 0,
          cooldownMs: 0,
        });
      },
      getRateLimitSnapshot: (rateBucket: RateBucket) => snapshots.get(rateBucket.organizationId) ?? {
        documentedRpm: null,
        effectiveRpm: 30,
        limitSource: "fallback",
        requestsSent: 0,
        retries: 0,
        cooldownMs: 0,
      },
    };
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      coordinator,
    });

    expect(await client.discoverOrganizationForTeam(2186253)).toBe(true);
    await client.fetchScenario(123);

    expect(client.getRateLimitSnapshot()).toMatchObject({
      documentedRpm: 60,
      effectiveRpm: 57,
      limitSource: "organization_api",
    });
    expect(requests.map((entry) => entry.context.bucket.organizationId)).toEqual([
      "unknown",
      8430514,
      8430514,
    ]);
  });

  test("keeps unknown 30 RPM fallback when team or organization discovery is inaccessible", async () => {
    const requests: RequestContext[] = [];
    const coordinator = {
      request: async (_url: string | URL, _init: RequestInit, requestContext: RequestContext) => {
        requests.push(requestContext);
        return new Response("forbidden", { status: 403 });
      },
      setOrganizationLimit: () => {
        throw new Error("must not set a limit");
      },
      getRateLimitSnapshot: () => ({
        documentedRpm: null,
        effectiveRpm: 30,
        limitSource: "fallback" as const,
        requestsSent: 0,
        retries: 0,
        cooldownMs: 0,
      }),
    };
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      coordinator,
    });

    expect(await client.discoverOrganizationForTeam(2186253)).toBe(false);
    expect(client.getRateLimitSnapshot()).toMatchObject({
      documentedRpm: null,
      effectiveRpm: 30,
      limitSource: "fallback",
    });
    expect(requests[0]!.bucket.organizationId).toBe("unknown");
  });

  test("organization-scoped methods initialize rate context automatically", async () => {
    const urls: string[] = [];
    const coordinator = {
      request: async (url: string | URL) => {
        const value = String(url);
        urls.push(value);
        if (value.endsWith("/api/v2/organizations/8430514")) {
          return Response.json({
            organization: { id: 8430514, license: { apiLimit: 60 } },
          });
        }
        return Response.json({ teams: [] });
      },
      setOrganizationLimit: () => undefined,
      getRateLimitSnapshot: () => ({
        documentedRpm: 60,
        effectiveRpm: 57,
        limitSource: "organization_api" as const,
        requestsSent: 0,
        retries: 0,
        cooldownMs: 0,
      }),
    };
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      coordinator,
    });

    expect(await client.listTeams(8430514)).toEqual([]);
    expect(urls).toEqual([
      "https://eu1.make.com/api/v2/organizations/8430514",
      "https://eu1.make.com/api/v2/teams?organizationId=8430514",
    ]);
  });

  test("bare scenario discovery resolves scenario to team to organization", async () => {
    const urls: string[] = [];
    const coordinator = {
      request: async (url: string | URL) => {
        const value = String(url);
        urls.push(value);
        if (value.endsWith("/api/v2/scenarios/6648651")) {
          return Response.json({ scenario: { id: 6648651, teamId: 2186253 } });
        }
        if (value.endsWith("/api/v2/teams/2186253")) {
          return Response.json({ team: { id: 2186253, organizationId: 8430514 } });
        }
        return Response.json({
          organization: { id: 8430514, license: { apiLimit: 60 } },
        });
      },
      setOrganizationLimit: () => undefined,
      getRateLimitSnapshot: () => ({
        documentedRpm: 60,
        effectiveRpm: 57,
        limitSource: "organization_api" as const,
        requestsSent: 0,
        retries: 0,
        cooldownMs: 0,
      }),
    };
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      coordinator,
    });

    expect(await client.discoverOrganizationForScenario(6648651)).toBe(true);
    expect(urls).toEqual([
      "https://eu1.make.com/api/v2/scenarios/6648651",
      "https://eu1.make.com/api/v2/teams/2186253",
      "https://eu1.make.com/api/v2/organizations/8430514",
    ]);
  });

  test("routes requests through one coordinator with authentication and rate context", async () => {
    const requests: Array<{ url: string; init: RequestInit; context: RequestContext }> = [];
    const coordinator = {
      request: async (url: string | URL, init: RequestInit, context: RequestContext) => {
        requests.push({ url: String(url), init, context });
        return Response.json({ scenario: { id: 123 } });
      },
    };
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      organizationId: 8430514,
      coordinator,
    });

    expect(await client.fetchScenario(123)).toEqual({ id: 123 });
    expect(requests).toHaveLength(1);
    expect(new Headers(requests[0]!.init.headers).get("authorization")).toBe("Token test-token");
    expect(requests[0]!.context.bucket).toEqual({
      zone: "eu1",
      organizationId: 8430514,
    });
  });

  test("constructs correct blueprint URL", () => {
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
    });
    expect(client.getBlueprintUrl(12345)).toBe(
      "https://eu1.make.com/api/v2/scenarios/12345/blueprint"
    );
  });

  test("constructs correct scenario URL for patching", () => {
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
    });
    expect(client.getScenarioUrl(12345)).toBe(
      "https://eu1.make.com/api/v2/scenarios/12345"
    );
  });

  test("constructs editor URL from teamId, not orgId", () => {
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://us2.make.com",
    });
    // teamId 51026 in the path — NOT the org id (1943554)
    expect(client.getEditUrl(51026, 4718889)).toBe(
      "https://us2.make.com/51026/scenarios/4718889/edit"
    );
  });

  test("strips trailing slash from base URL", () => {
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com/",
    });
    expect(client.getBlueprintUrl(1)).toBe(
      "https://eu1.make.com/api/v2/scenarios/1/blueprint"
    );
  });

  test("constructs execution and webhook log URLs", () => {
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
    });

    expect(client.getExecutionLogUrl(123, "execution/id")).toBe(
      "https://eu1.make.com/api/v2/scenarios/123/logs/execution%2Fid",
    );
    expect(client.getHookLogsUrl(456, {
      from: "1784102400000",
      to: "1784102520000",
      limit: 100,
    })).toBe(
      "https://eu1.make.com/api/v2/hooks/456/logs?from=1784102400000&to=1784102520000&pg%5Blimit%5D=100&pg%5BsortDir%5D=desc",
    );
    expect(client.getHookLogUrl(456, "hook/log")).toBe(
      "https://eu1.make.com/api/v2/hooks/456/logs/hook%2Flog",
    );
  });

  test("createNote method exists and is callable", () => {
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
    });
    expect(typeof client.createNote).toBe("function");
  });

  test("fetchApps method exists and is callable", () => {
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
    });
    expect(typeof client.fetchApps).toBe("function");
  });

  test("fetchAppModules method exists and is callable", () => {
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
    });
    expect(typeof client.fetchAppModules).toBe("function");
  });
});

describe("MakeAppSchema", () => {
  test("parses a full app object", () => {
    const app = MakeAppSchema.parse({
      name: "google-sheets",
      label: "Google Sheets",
      version: 2,
      theme: "#0f9d58",
      keywords: "spreadsheet,sheets",
      categories: ["productivity"],
      isPrivate: false,
      premiumTier: 0,
    });

    expect(app.name).toBe("google-sheets");
    expect(app.label).toBe("Google Sheets");
    expect(app.version).toBe(2);
    expect(app.keywords).toBe("spreadsheet,sheets");
    expect(app.categories).toEqual(["productivity"]);
  });

  test("handles null fields gracefully", () => {
    const app = MakeAppSchema.parse({
      name: "test-app",
      label: "Test",
      version: 1,
      theme: null,
      keywords: null,
      categories: null,
      isPrivate: null,
      premiumTier: null,
    });

    expect(app.theme).toBe("");
    expect(app.keywords).toBe("");
    expect(app.categories).toEqual([]);
    expect(app.isPrivate).toBe(false);
    expect(app.premiumTier).toBe(0);
  });

  test("handles missing optional fields", () => {
    const app = MakeAppSchema.parse({
      name: "minimal",
      label: "Minimal App",
      version: 1,
    });

    expect(app.keywords).toBe("");
    expect(app.categories).toEqual([]);
  });

  test("preserves extra fields via catchall", () => {
    const app = MakeAppSchema.parse({
      name: "test",
      label: "Test",
      version: 1,
      brand: { logo: "url" },
      coming_soon: false,
    });

    expect((app as any).brand).toEqual({ logo: "url" });
  });
});

describe("AppModuleSchema", () => {
  test("parses a full module object", () => {
    const mod = AppModuleSchema.parse({
      id: "addRow",
      name: "addRow",
      label: "Add a Row",
      type: "account:google",
      hook: false,
    });

    expect(mod.id).toBe("addRow");
    expect(mod.label).toBe("Add a Row");
    expect(mod.hook).toBe(false);
  });

  test("handles missing optional fields", () => {
    const mod = AppModuleSchema.parse({
      id: "test",
      name: "test",
      label: "Test Module",
    });

    expect(mod.type).toBe("");
    expect(mod.hook).toBe(false);
  });
});

describe("MakeApiClient.searchApps", () => {
  const client = new MakeApiClient({
    token: "test-token",
    baseUrl: "https://eu1.make.com",
  });

  const mockApps = [
    { name: "google-sheets", label: "Google Sheets", version: 2, theme: "", keywords: "spreadsheet,sheets", categories: [] as string[], isPrivate: false, premiumTier: 0 },
    { name: "google-drive", label: "Google Drive", version: 4, theme: "", keywords: "storage,files", categories: [] as string[], isPrivate: false, premiumTier: 0 },
    { name: "monday", label: "monday.com", version: 2, theme: "", keywords: "project,management", categories: [] as string[], isPrivate: false, premiumTier: 0 },
    { name: "powerlink", label: "Fireberry", version: 1, theme: "", keywords: "crm", categories: [] as string[], isPrivate: false, premiumTier: 0 },
    { name: "airtable", label: "Airtable", version: 2, theme: "", keywords: "database,spreadsheet", categories: [] as string[], isPrivate: false, premiumTier: 0 },
  ];

  test("filters by label", async () => {
    const results = await client.searchApps("google", mockApps);
    expect(results).toHaveLength(2);
    expect(results[0].name).toBe("google-sheets");
    expect(results[1].name).toBe("google-drive");
  });

  test("filters by name slug", async () => {
    const results = await client.searchApps("powerlink", mockApps);
    expect(results).toHaveLength(1);
    expect(results[0].label).toBe("Fireberry");
  });

  test("filters by keywords", async () => {
    const results = await client.searchApps("spreadsheet", mockApps);
    expect(results).toHaveLength(2);
    expect(results.map((a) => a.name)).toEqual(["google-sheets", "airtable"]);
  });

  test("is case-insensitive", async () => {
    const results = await client.searchApps("MONDAY", mockApps);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("monday");
  });

  test("returns empty for no matches", async () => {
    const results = await client.searchApps("nonexistent", mockApps);
    expect(results).toHaveLength(0);
  });

  test("matches partial strings", async () => {
    const results = await client.searchApps("crm", mockApps);
    expect(results).toHaveLength(1);
    expect(results[0].label).toBe("Fireberry");
  });
});
