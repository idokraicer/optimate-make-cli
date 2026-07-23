import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerDoctorCommand } from "./doctor";

type ClientOverrides = Record<string, unknown>;

function apiFailure(label: string, status: number, payload: unknown): Error {
  return new Error(`${label} ${status}: ${JSON.stringify(payload)}`);
}

function harness(overrides: ClientOverrides = {}) {
  const output: unknown[] = [];
  const calls: string[] = [];
  let resolvedBareScenario = false;
  const client = {
    getScenarioUrl: (scenarioId: number) =>
      `https://eu2.make.com/api/v2/scenarios/${scenarioId}`,
    listOrganizations: async () => {
      calls.push("GET /api/v2/organizations");
      return [{ id: 12 }];
    },
    fetchTeam: async (teamId: number) => {
      calls.push(`GET /api/v2/teams/${teamId}`);
      return { id: teamId, organizationId: 12 };
    },
    fetchOrganization: async (organizationId: number) => {
      calls.push(`GET /api/v2/organizations/${organizationId}`);
      return { id: organizationId, license: { apiLimit: 60 } };
    },
    fetchScenario: async (scenarioId: number) => {
      calls.push(`GET /api/v2/scenarios/${scenarioId}`);
      return { id: scenarioId, organizationId: 12 };
    },
    fetchBlueprint: async (scenarioId: number) => {
      calls.push(`GET /api/v2/scenarios/${scenarioId}/blueprint`);
      return { blueprint: { name: "Probe", flow: [], metadata: {} }, raw: {} };
    },
    fetchScenarioInterface: async (scenarioId: number) => {
      calls.push(`GET /api/v2/scenarios/${scenarioId}/interface`);
      return { input: [], output: [] };
    },
    getRateLimitSnapshot: () => ({
      documentedRpm: null,
      effectiveRpm: 30,
      limitSource: "fallback",
      requestsSent: calls.length,
      retries: 0,
      cooldownMs: 0,
    }),
    ...overrides,
  };
  (client as any).diagnosticGet = async (path: string) => {
    try {
      if (path === "/api/v2/organizations") {
        return Response.json({ organizations: await (client as any).listOrganizations() });
      }
      const team = path.match(/^\/api\/v2\/teams\/(\d+)$/);
      if (team) return Response.json({ team: await (client as any).fetchTeam(Number(team[1])) });
      const organization = path.match(/^\/api\/v2\/organizations\/(\d+)$/);
      if (organization) {
        return Response.json({
          organization: await (client as any).fetchOrganization(Number(organization[1])),
        });
      }
      const scenario = path.match(/^\/api\/v2\/scenarios\/(\d+)$/);
      if (scenario) {
        return Response.json({
          scenario: await (client as any).fetchScenario(Number(scenario[1])),
        });
      }
      const blueprint = path.match(/^\/api\/v2\/scenarios\/(\d+)\/blueprint$/);
      if (blueprint) {
        return Response.json(await (client as any).fetchBlueprint(Number(blueprint[1])));
      }
      const scenarioInterface = path.match(/^\/api\/v2\/scenarios\/(\d+)\/interface$/);
      if (scenarioInterface) {
        return Response.json({
          interface: await (client as any).fetchScenarioInterface(Number(scenarioInterface[1])),
        });
      }
      return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const match = message.match(/\b(\d{3}):\s*([\s\S]*)$/);
      if (!match) throw error;
      return new Response(match[2], {
        status: Number(match[1]),
        headers: { "content-type": "application/json" },
      });
    }
  };
  const program = new Command().exitOverride();
  registerDoctorCommand(program, {
    createClient: async () => client as any,
    parseMakeUrl: (value) => {
      if (value.includes("/organization/12")) {
        return { baseUrl: "https://eu2.make.com", organizationId: 12 };
      }
      if (value.includes("/34/scenarios/56")) {
        return {
          baseUrl: "https://eu2.make.com",
          teamId: 34,
          scenarioId: 56,
        };
      }
      return {};
    },
    parseScenarioInput: (value) => {
      if (value.includes("/34/scenarios/56")) {
        return { scenarioId: 56, teamId: 34, baseUrl: "https://eu2.make.com" };
      }
      return { scenarioId: Number(value) };
    },
    cliVersion: "test",
    platform: "test-platform",
    configuredBaseUrl: async () => "https://eu1.make.com",
    writeOutput: (value) => output.push(value),
  });
  return {
    program,
    output,
    calls,
    get resolvedBareScenario() {
      return resolvedBareScenario;
    },
  };
}

function evidenceHarness(
  responder: (zone: string, path: string) => Promise<Response>,
  rateSnapshot: Record<string, unknown> = {
    documentedRpm: null,
    effectiveRpm: 30,
    limitSource: "fallback",
    requestsSent: 0,
    retries: 0,
    cooldownMs: 0,
  },
) {
  const output: unknown[] = [];
  const calls: Array<{ zone: string; method: "GET"; path: string }> = [];
  let legacyResolverCalls = 0;
  const createClient = async (baseUrl = "https://eu1.make.com") => {
    const zone = new URL(baseUrl).hostname.replace(/\.make\.com$/, "");
    return {
      getScenarioUrl: (scenarioId: number) =>
        `${baseUrl}/api/v2/scenarios/${scenarioId}`,
      diagnosticGet: async (path: string) => {
        calls.push({ zone, method: "GET", path });
        return responder(zone, path);
      },
      getRateLimitSnapshot: () => rateSnapshot,
    } as any;
  };
  const program = new Command().exitOverride();
  registerDoctorCommand(program, {
    createClient,
    parseMakeUrl: (value) => {
      if (value.includes("/organization/12")) {
        return { baseUrl: "https://eu2.make.com", organizationId: 12 };
      }
      if (value.includes("/34/scenarios/56")) {
        return {
          baseUrl: "https://eu2.make.com",
          teamId: 34,
          scenarioId: 56,
        };
      }
      return {};
    },
    parseScenarioInput: (value) => {
      if (value.includes("/34/scenarios/56")) {
        return { scenarioId: 56, teamId: 34, baseUrl: "https://eu2.make.com" };
      }
      return { scenarioId: Number(value) };
    },
    cliVersion: "test",
    platform: "test-platform",
    configuredBaseUrl: async () => "https://eu1.make.com",
    writeOutput: (value) => output.push(value),
  });
  return {
    program,
    output,
    calls,
    get legacyResolverCalls() {
      return legacyResolverCalls;
    },
  };
}

describe("doctor command", () => {
  test("validates authentication with a safe organization-list GET", async () => {
    const h = harness();
    await h.program.parseAsync(["doctor"], { from: "user" });

    expect(h.calls).toEqual(["GET /api/v2/organizations"]);
    expect(h.output[0]).toMatchObject({
      ok: true,
      command: "doctor",
      data: {
        platform: "test-platform",
        configuredZone: "eu1",
        resolvedZone: "eu1",
        authentication: { valid: true },
        capabilities: expect.arrayContaining([
          {
            name: "organizations.list",
            probed: true,
            supported: true,
            evidence: {
              method: "GET",
              path: "/api/v2/organizations",
              httpStatus: 200,
              providerCode: null,
            },
          },
        ]),
      },
    });
  });

  test("classifies an invalid token without attempting mutation", async () => {
    const h = harness({
      listOrganizations: async () => {
        h.calls.push("GET /api/v2/organizations");
        throw apiFailure("Make API list organizations error", 401, {
          code: "INVALID_TOKEN",
          message: "Invalid API token",
        });
      },
    });
    await h.program.parseAsync(["doctor", "--json"], { from: "user" });

    expect(h.output[0]).toMatchObject({
      ok: true,
      data: {
        authentication: { valid: false },
      },
    });
    expect((h.output[0] as any).data.capabilities[0]).toMatchObject({
      supported: false,
      limitation: {
        code: "AUTH_INVALID",
        providerCode: "INVALID_TOKEN",
        httpStatus: 401,
      },
    });
    expect(h.calls.every((call) => call.startsWith("GET "))).toBe(true);
  });

  test("distinguishes missing organization scope and leaves scenario probes unprobed", async () => {
    const h = harness({
      fetchOrganization: async (organizationId: number) => {
        h.calls.push(`GET /api/v2/organizations/${organizationId}`);
        throw apiFailure("Make API fetch organization error", 403, {
          code: "SCOPE",
          message: "organizations:read is required",
        });
      },
    });
    await h.program.parseAsync([
      "doctor",
      "--from-url",
      "https://eu2.make.com/organization/12/dashboard",
    ], { from: "user" });

    expect(h.output[0]).toMatchObject({ data: { organizationId: 12 } });
    const capabilities = (h.output[0] as any).data.capabilities;
    expect(capabilities.find((item: any) => item.name === "organizations.list"))
      .toMatchObject({ supported: true });
    expect(capabilities.find((item: any) => item.name === "organizations.read"))
      .toMatchObject({
        supported: false,
        limitation: { code: "SCOPE_MISSING", httpStatus: 403 },
      });
    expect(capabilities.find((item: any) => item.name === "scenarios.read"))
      .toMatchObject({
        probed: false,
        supported: false,
        evidence: { httpStatus: null },
      });
  });

  test("reports plan-restricted interfaces separately from readable scenarios", async () => {
    const h = harness({
      fetchScenarioInterface: async (scenarioId: number) => {
        h.calls.push(`GET /api/v2/scenarios/${scenarioId}/interface`);
        throw apiFailure("Make API fetch scenario interface error", 402, {
          code: "PLAN_LIMIT",
          message: "Upgrade required",
        });
      },
    });
    await h.program.parseAsync([
      "doctor",
      "-s",
      "https://eu2.make.com/34/scenarios/56/edit",
    ], { from: "user" });

    expect(h.output[0]).toMatchObject({
      data: {
        scenarioId: 56,
        resolvedZone: "eu2",
        capabilities: [
          { name: "organizations.list", supported: true },
          { name: "teams.read", supported: true },
          { name: "organizations.read", supported: true },
          { name: "scenarios.read", supported: true },
          { name: "blueprints.read", supported: true },
          {
            name: "scenario_interface.read",
            supported: false,
            limitation: { code: "PLAN_RESTRICTED", httpStatus: 402 },
          },
        ],
      },
    });
    expect(h.calls.every((call) => call.startsWith("GET "))).toBe(true);
  });

  test("reports scenario-not-found evidence instead of claiming support", async () => {
    const h = harness({
      fetchScenario: async (scenarioId: number) => {
        h.calls.push(`GET /api/v2/scenarios/${scenarioId}`);
        throw apiFailure("Make API fetch scenario error", 404, {
          code: "SCENARIO_NOT_FOUND",
          message: "Scenario not found",
        });
      },
    });
    await h.program.parseAsync(["doctor", "-s", "56"], { from: "user" });

    expect(h.resolvedBareScenario).toBe(false);
    expect(h.output[0]).toMatchObject({
      data: {
        scenarioId: 56,
        resolvedZone: null,
      },
    });
    expect((h.output[0] as any).data.capabilities.find(
      (item: any) => item.name === "scenarios.read",
    )).toMatchObject({
      supported: false,
      limitation: {
        code: "NOT_FOUND",
        providerCode: "SCENARIO_NOT_FOUND",
      },
    });
  });

  test("uses bare-scenario GET evidence to resolve and probe its organization", async () => {
    const h = harness();
    await h.program.parseAsync(["doctor", "-s", "56"], { from: "user" });

    expect(h.calls).toContain("GET /api/v2/scenarios/56");
    expect(h.calls).toContain("GET /api/v2/organizations/12");
    expect((h.output[0] as any).data).toMatchObject({
      organizationId: 12,
      scenarioId: 56,
    });
    expect((h.output[0] as any).data.capabilities.find(
      (item: any) => item.name === "organizations.read",
    )).toMatchObject({ probed: true, supported: true });
  });

  test("reports fallback and organization-discovered rate limits", async () => {
    const fallback = harness();
    await fallback.program.parseAsync(["doctor"], { from: "user" });
    expect(fallback.output[0]).toMatchObject({
      data: {
        rateLimit: {
          documentedRpm: null,
          effectiveRpm: 30,
          limitSource: "fallback",
        },
      },
    });

    const discovered = harness({
      getRateLimitSnapshot: () => ({
        documentedRpm: 120,
        effectiveRpm: 114,
        limitSource: "organization_api",
        requestsSent: 3,
        retries: 1,
        cooldownMs: 250,
      }),
    });
    await discovered.program.parseAsync([
      "doctor",
      "--from-url",
      "https://eu2.make.com/organization/12/dashboard",
    ], { from: "user" });
    expect(discovered.output[0]).toMatchObject({
      data: {
        rateLimit: {
          documentedRpm: 120,
          effectiveRpm: 114,
          limitSource: "organization_api",
          cooldownMs: 250,
        },
      },
    });
  });

  test("sanitizes provider evidence before returning it", async () => {
    const h = harness({
      fetchScenarioInterface: async (scenarioId: number) => {
        h.calls.push(`GET /api/v2/scenarios/${scenarioId}/interface`);
        throw apiFailure("Make API fetch scenario interface error", 403, {
          code: "NO_SCOPE",
          message: "token=super-secret",
          authorization: "Bearer hidden",
        });
      },
    });
    await h.program.parseAsync([
      "doctor",
      "-s",
      "https://eu2.make.com/34/scenarios/56/edit",
    ], { from: "user" });

    const serialized = JSON.stringify(h.output[0]);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("Bearer hidden");
    expect(serialized).toContain("[REDACTED]");
  });

  test("renders human diagnostics and accepts --json as the default-output alias", async () => {
    const json = harness();
    await json.program.parseAsync(["doctor", "--json"], { from: "user" });
    expect(json.output[0]).toMatchObject({ ok: true, command: "doctor" });

    const human = harness();
    await human.program.parseAsync(["doctor", "--human"], { from: "user" });
    expect(human.output[0]).toEqual(expect.stringContaining("Make Fixer doctor"));
    expect(human.output[0]).toEqual(expect.stringContaining("organizations.list: supported"));
  });

  test("resolves bare IDs from structured per-zone GET evidence without the legacy resolver", async () => {
    const h = evidenceHarness(async (zone, path) => {
      if (path === "/api/v2/scenarios/56") {
        if (zone === "eu1") {
          return Response.json(
            { code: "SCENARIO_NOT_FOUND", message: "not here" },
            { status: 404 },
          );
        }
        if (zone === "eu2") {
          return new Response(JSON.stringify({
            scenario: { id: 56, teamId: 34 },
          }), { status: 200 });
        }
      }
      if (path === "/api/v2/organizations") {
        return Response.json({ organizations: [{ id: 12 }] });
      }
      if (path === "/api/v2/teams/34") {
        return Response.json({ team: { id: 34, organizationId: 12 } });
      }
      if (path === "/api/v2/organizations/12") {
        return Response.json({ organization: { id: 12, license: { apiLimit: 60 } } });
      }
      if (path === "/api/v2/scenarios/56/blueprint") {
        return Response.json({ blueprint: "{}" });
      }
      if (path === "/api/v2/scenarios/56/interface") {
        return Response.json({ interface: { input: [], output: [] } });
      }
      return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    });

    await h.program.parseAsync(["doctor", "-s", "56"], { from: "user" });

    expect(h.legacyResolverCalls).toBe(0);
    expect((h.output[0] as any).data).toMatchObject({
      resolvedZone: "eu2",
      organizationId: 12,
      scenarioId: 56,
      authentication: { valid: true, status: "valid" },
      zoneProbes: [
        {
          zone: "eu1",
          evidence: { method: "GET", path: "/api/v2/scenarios/56", httpStatus: 404 },
          limitation: { code: "NOT_FOUND", providerCode: "SCENARIO_NOT_FOUND" },
        },
        {
          zone: "eu2",
          evidence: { method: "GET", path: "/api/v2/scenarios/56", httpStatus: 200 },
        },
      ],
    });
    expect(h.calls).toContainEqual({
      zone: "eu2",
      method: "GET",
      path: "/api/v2/teams/34",
    });
    expect(h.calls).toContainEqual({
      zone: "eu2",
      method: "GET",
      path: "/api/v2/organizations/12",
    });
  });

  test("uses actual success response metadata instead of fabricating status 200", async () => {
    const h = evidenceHarness(async (_zone, path) => {
      if (path === "/api/v2/organizations") {
        return new Response(JSON.stringify({ code: "READ_OK", organizations: [] }), {
          status: 206,
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json({});
    });

    await h.program.parseAsync(["doctor"], { from: "user" });

    expect((h.output[0] as any).data.capabilities[0]).toMatchObject({
      name: "organizations.list",
      supported: true,
      evidence: {
        method: "GET",
        path: "/api/v2/organizations",
        httpStatus: 206,
        providerCode: "READ_OK",
      },
    });
  });

  test("preserves every bare-ID discovery failure and accounts for those GETs", async () => {
    const h = evidenceHarness(async (zone, path) => {
      if (path === "/api/v2/scenarios/56") {
        if (zone === "eu1") throw new Error("connection reset");
        if (zone === "eu2") {
          return Response.json(
            { code: "INVALID_TOKEN", message: "bad token" },
            { status: 401 },
          );
        }
        if (zone === "us1") {
          return Response.json(
            { code: "SCENARIO_NOT_FOUND", message: "not here" },
            { status: 404 },
          );
        }
        return Response.json({ scenario: { id: 56 } });
      }
      if (path === "/api/v2/organizations") {
        return Response.json({ organizations: [] });
      }
      if (path.endsWith("/blueprint")) return Response.json({ blueprint: "{}" });
      if (path.endsWith("/interface")) return Response.json({ interface: {} });
      return Response.json({});
    });

    await h.program.parseAsync(["doctor", "-s", "56"], { from: "user" });

    const data = (h.output[0] as any).data;
    expect(data.zoneProbes.map((probe: any) => ({
      zone: probe.zone,
      code: probe.limitation?.code ?? null,
      status: probe.evidence.httpStatus,
    }))).toEqual([
      { zone: "eu1", code: "TRANSIENT", status: null },
      { zone: "eu2", code: "AUTH_INVALID", status: 401 },
      { zone: "us1", code: "NOT_FOUND", status: 404 },
      { zone: "us2", code: null, status: 200 },
    ]);
    expect(data.rateLimit).toMatchObject({
      discoveryRequests: 4,
    });
  });

  test("authentication is valid for exact scope and plan limitations, but unknown for transport failure", async () => {
    for (const [status, code, expected] of [
      [403, "SCOPE_MISSING", "SCOPE_MISSING"],
      [402, "PLAN_LIMIT", "PLAN_RESTRICTED"],
    ] as const) {
      const h = evidenceHarness(async () => Response.json(
        { code, message: "limited" },
        { status },
      ));
      await h.program.parseAsync(["doctor"], { from: "user" });
      expect((h.output[0] as any).data.authentication).toEqual({
        valid: true,
        status: "valid",
      });
      expect((h.output[0] as any).data.capabilities[0]).toMatchObject({
        supported: false,
        limitation: { code: expected, httpStatus: status },
      });
    }

    const transport = evidenceHarness(async () => {
      throw new Error("socket disconnected token=must-not-leak");
    });
    await transport.program.parseAsync(["doctor"], { from: "user" });
    expect((transport.output[0] as any).data.authentication).toEqual({
      valid: null,
      status: "unknown",
    });
    expect(JSON.stringify(transport.output[0])).not.toContain("must-not-leak");
    expect((transport.output[0] as any).data.capabilities[0]).toMatchObject({
      limitation: { code: "TRANSIENT", httpStatus: null },
    });
  });
});
