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
  const program = new Command().exitOverride();
  registerDoctorCommand(program, {
    createClient: async () => client as any,
    resolveScenarioClient: async () => {
      resolvedBareScenario = true;
      return client as any;
    },
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
        resolvedZone: "eu2",
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

    expect(h.resolvedBareScenario).toBe(true);
    expect(h.output[0]).toMatchObject({
      data: {
        scenarioId: 56,
        resolvedZone: "eu2",
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
});
