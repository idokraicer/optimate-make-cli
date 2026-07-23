import { describe, expect, test } from "bun:test";
import { AmbiguousCreateError, MakeApiClient, ScenarioRunRequestError } from "./client";
import { MakeAppSchema, AppModuleSchema } from "./types";
import type { RequestContext } from "./request-coordinator";
import type { RateBucket, RateLimitSnapshot } from "./rate-limiter";
import { RequestCoordinator, type RateLimiterStore } from "./request-coordinator";

function immediateLimiter(): RateLimiterStore {
  return {
    reserve: async () => undefined,
    waitForCooldown: async () => undefined,
    setCooldown: () => undefined,
    getSnapshot: () => ({
      documentedRpm: 60,
      effectiveRpm: 57,
      limitSource: "organization_api",
      requestsSent: 0,
      retries: 0,
      cooldownMs: 0,
    }),
    noteRetry: () => undefined,
    recordExemptRequest: () => undefined,
    setOrganizationLimit: () => undefined,
    acquireExecutionLease: async () => () => undefined,
  };
}

describe("MakeApiClient", () => {
  test("uses documented scenario lifecycle endpoints and serialized create body", async () => {
    const requests: Array<{ url: string; init: RequestInit; context: RequestContext }> = [];
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      coordinator: {
        request: async (url, init, context) => {
          requests.push({ url: String(url), init, context });
          if (init.method === "DELETE") return Response.json({ scenario: 44 });
          return Response.json({
            scenario: {
              id: 44, name: "probe", teamId: 21, isActive: false,
              scheduling: { type: "on-demand" },
            },
          });
        },
      },
    });
    const blueprint = { name: "probe", flow: [], metadata: {} } as any;

    await client.createScenario({
      teamId: 21, blueprint, scheduling: { type: "on-demand" }, confirmed: true,
    });
    await client.fetchScenarioDetails(44);
    await client.startScenario(44);
    await client.stopScenario(44);
    expect(await client.deleteScenario(44)).toBe(44);

    expect(requests.map(({ url }) => url)).toEqual([
      "https://eu1.make.com/api/v2/scenarios?confirmed=true",
      "https://eu1.make.com/api/v2/scenarios/44",
      "https://eu1.make.com/api/v2/scenarios/44/start",
      "https://eu1.make.com/api/v2/scenarios/44",
      "https://eu1.make.com/api/v2/scenarios/44/stop",
      "https://eu1.make.com/api/v2/scenarios/44",
      "https://eu1.make.com/api/v2/scenarios/44",
    ]);
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      blueprint: JSON.stringify(blueprint),
      teamId: 21,
      scheduling: JSON.stringify({ type: "on-demand" }),
    });
    expect(requests.filter(({ init }) => init.method !== undefined).map(({ init }) => init.method))
      .toEqual(["POST", "POST", "POST", "DELETE"]);
    for (const request of requests.filter(({ init }) => init.method && init.method !== "GET")) {
      expect(request.context.retryTransientResponses).toBe(false);
      expect(request.context.networkRetrySafe).toBe(false);
    }
  });

  test("reconciles an ambiguous create transport failure by a complete exact-marker listing", async () => {
    let createCalls = 0;
    const coordinator = new RequestCoordinator({
      limiter: immediateLimiter(),
      request: async (request) => {
        const url = new URL(request.url);
        if (request.method === "POST") {
          createCalls++;
          throw new TypeError("socket closed after send");
        }
        if (url.pathname.endsWith("/teams/21")) {
          return Response.json({ team: { id: 21, organizationId: 9 } });
        }
        if (url.pathname.endsWith("/organizations/9")) {
          return Response.json({ organization: { id: 9, license: { apiLimit: 60 } } });
        }
        return Response.json({
          scenarios: [{
            id: 44,
            teamId: 21,
            name: "probe [123e4567-e89b-12d3-a456-426614174000]",
            isActive: false,
            scheduling: { type: "on-demand" },
          }],
        });
      },
    });
    const client = new MakeApiClient({
      token: "test-token", baseUrl: "https://eu1.make.com", coordinator,
    });
    const result = await client.createScenario({
      teamId: 21,
      blueprint: {
        name: "probe [123e4567-e89b-12d3-a456-426614174000]",
        flow: [],
      } as any,
      scheduling: { type: "on-demand" },
      confirmed: true,
    });
    expect(result.id).toBe(44);
    expect(createCalls).toBe(1);
  });

  test("reports multiple create reconciliation matches as AMBIGUOUS_CREATE without replay", async () => {
    let createCalls = 0;
    const coordinator = new RequestCoordinator({
      limiter: immediateLimiter(),
      request: async (request) => {
        const url = new URL(request.url);
        if (request.method === "POST") {
          createCalls++;
          throw new TypeError("socket closed after send");
        }
        if (url.pathname.endsWith("/teams/21")) {
          return Response.json({ team: { id: 21, organizationId: 9 } });
        }
        if (url.pathname.endsWith("/organizations/9")) {
          return Response.json({ organization: { id: 9, license: { apiLimit: 60 } } });
        }
        const marker = "[123e4567-e89b-12d3-a456-426614174000]";
        return Response.json({ scenarios: [
          { id: 44, name: `one ${marker}` },
          { id: 45, name: `two ${marker}` },
        ] });
      },
    });
    const client = new MakeApiClient({
      token: "test-token", baseUrl: "https://eu1.make.com", coordinator,
    });
    await expect(client.createScenario({
      teamId: 21,
      blueprint: {
        name: "probe [123e4567-e89b-12d3-a456-426614174000]",
        flow: [],
      } as any,
      scheduling: { type: "on-demand" },
      confirmed: true,
    })).rejects.toBeInstanceOf(AmbiguousCreateError);
    expect(createCalls).toBe(1);
  });

  test("reconciles an ambiguous delete transport failure only when GET proves 404", async () => {
    let deletes = 0;
    let gets = 0;
    const coordinator = new RequestCoordinator({
      limiter: immediateLimiter(),
      request: async (request) => {
        if (request.method === "DELETE") {
          deletes++;
          throw new TypeError("socket closed after send");
        }
        gets++;
        return new Response(null, { status: 404 });
      },
    });
    const client = new MakeApiClient({
      token: "test-token", baseUrl: "https://eu1.make.com", coordinator,
    });
    expect(await client.deleteScenario(44)).toBe(44);
    expect({ deletes, gets }).toEqual({ deletes: 1, gets: 1 });
  });

  test("start and stop accept documented partial mutation bodies then fetch full details", async () => {
    const responses = [
      Response.json({ scenario: { id: 44, isActive: true, islinked: true } }),
      Response.json({ scenario: {
        id: 44, name: "probe", teamId: 21, isActive: true,
        scheduling: { type: "on-demand" },
      } }),
      Response.json({ scenario: { id: 44, isActive: false, islinked: true } }),
      Response.json({ scenario: {
        id: 44, name: "probe", teamId: 21, isActive: false,
        scheduling: { type: "on-demand" },
      } }),
    ];
    const client = new MakeApiClient({
      token: "token",
      baseUrl: "https://eu1.make.com",
      coordinator: { request: async () => responses.shift()! },
    });
    expect(await client.startScenario(44)).toMatchObject({ id: 44, teamId: 21, isActive: true });
    expect(await client.stopScenario(44)).toMatchObject({ id: 44, teamId: 21, isActive: false });
  });

  test("delete returns the documented deleted scenario ID from its response body", async () => {
    const client = new MakeApiClient({
      token: "token",
      baseUrl: "https://eu1.make.com",
      coordinator: {
        request: async () => Response.json({ scenario: 77 }),
      },
    });
    expect(await client.deleteScenario(77)).toBe(77);
  });

  test("diagnostic GET preserves response metadata and updates the observed organization limit", async () => {
    const requests: Array<{ method: string; path: string; organizationId: number | "unknown" }> = [];
    const client = new MakeApiClient({
      token: "token",
      baseUrl: "https://eu2.make.com",
      coordinator: {
        request: async (input, init, context) => {
          const request = new Request(input, init);
          requests.push({
            method: request.method,
            path: new URL(request.url).pathname,
            organizationId: context.bucket.organizationId,
          });
          return new Response(JSON.stringify({
            organization: { id: 12, license: { apiLimit: 120 } },
          }), {
            status: 206,
            headers: { "content-type": "application/json", "x-provider-code": "PARTIAL" },
          });
        },
        getRateLimitSnapshot: () => ({
          documentedRpm: null,
          effectiveRpm: 30,
          limitSource: "fallback",
          requestsSent: 1,
          retries: 0,
          cooldownMs: 0,
        }),
        setOrganizationLimit: (_bucket, documentedRpm) => {
          expect(documentedRpm).toBe(120);
        },
      },
    });

    const response = await client.diagnosticGet("/api/v2/organizations/12", 12);

    expect(response.status).toBe(206);
    expect(response.headers.get("x-provider-code")).toBe("PARTIAL");
    expect(await response.json()).toMatchObject({
      organization: { id: 12, license: { apiLimit: 120 } },
    });
    expect(requests).toEqual([{
      method: "GET",
      path: "/api/v2/organizations/12",
      organizationId: 12,
    }]);
  });

  test("diagnostic GET rejects non-API and absolute paths before sending", async () => {
    let requests = 0;
    const client = new MakeApiClient({
      token: "token",
      baseUrl: "https://eu2.make.com",
      coordinator: {
        request: async () => {
          requests++;
          return Response.json({});
        },
      },
    });

    await expect(client.diagnosticGet("https://attacker.test/api/v2/organizations"))
      .rejects.toThrow("relative Make API path");
    await expect(client.diagnosticGet("/organizations"))
      .rejects.toThrow("relative Make API path");
    expect(requests).toBe(0);
  });

  test("uses documented interface, run, and execution endpoints with only run rate-exempt", async () => {
    const requests: Array<{ url: string; init: RequestInit; context: RequestContext }> = [];
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      coordinator: {
        request: async (url, init, context) => {
          requests.push({ url: String(url), init, context });
          if (String(url).endsWith("/interface")) return Response.json({ interface: { input: [], output: [] } });
          if (String(url).endsWith("/run")) return Response.json({ executionId: "e1", status: "RUNNING" });
          return Response.json({ execution: { status: "SUCCESS", outputs: { value: 1 } } });
        },
      },
    });

    expect(await client.fetchScenarioInterface(7)).toEqual({ input: [], output: [] });
    expect(await client.runScenario(7, { data: {}, responsive: true })).toMatchObject({ executionId: "e1" });
    expect(await client.fetchExecutionDetails(7, "e1")).toEqual({
      status: "SUCCESS",
      outputs: { value: 1 },
    });
    expect(requests.map(({ url }) => url)).toEqual([
      "https://eu1.make.com/api/v2/scenarios/7/interface",
      "https://eu1.make.com/api/v2/scenarios/7/run",
      "https://eu1.make.com/api/v2/scenarios/7/executions/e1",
    ]);
    expect(requests.map(({ context }) => context.organizationRateExempt)).toEqual([
      undefined, true, undefined,
    ]);
    expect(requests[1].init.method).toBe("POST");
    expect(JSON.parse(String(requests[1].init.body))).toEqual({ data: {}, responsive: true });
  });

  test("stops an exact execution and lists sanitized module log summaries", async () => {
    const requests: Array<{ url: string; init: RequestInit; context: RequestContext }> = [];
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      coordinator: {
        request: async (url, init, context) => {
          requests.push({ url: String(url), init, context });
          if (init.method === "POST") return new Response(null, { status: 204 });
          return Response.json({
            logs: [{
              moduleId: 3,
              executionId: "execution/id",
              status: 1,
              bundles: 4,
              data: { secret: "must not escape" },
            }],
          });
        },
      },
    });

    await client.stopScenarioExecution(7, "execution/id", true);
    expect(await client.listModuleLogs(7, 3)).toEqual([{
      moduleId: 3,
      executionId: "execution/id",
      status: 1,
      bundles: 4,
    }]);
    expect(requests.map(({ url }) => url)).toEqual([
      "https://eu1.make.com/api/v2/scenarios/7/executions/execution%2Fid/stop",
      "https://eu1.make.com/api/v2/scenarios/7/modules/3/logs",
    ]);
    expect(requests[0].init.method).toBe("POST");
    expect(JSON.parse(String(requests[0].init.body))).toEqual({ force: true });
    expect(requests.map(({ context }) => context.organizationRateExempt))
      .toEqual([undefined, undefined]);
    expect(requests[0].context.retryTransientResponses).toBe(false);
    expect(requests[0].context.networkRetrySafe).toBe(false);
  });

  test("sanitizes execution-stop and module-log API errors", async () => {
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      coordinator: {
        request: async () => new Response(
          "Authorization: Bearer provider-secret",
          { status: 500 },
        ),
      },
    });
    await expect(client.stopScenarioExecution(7, "e1")).rejects.toThrow(
      "Make API stop execution error 500.",
    );
    await expect(client.listModuleLogs(7, 3)).rejects.toThrow(
      "Make API list module logs error 500.",
    );
  });

  test("preserves an execution ID assigned in an unsuccessful run response", async () => {
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      coordinator: {
        request: async () => Response.json(
          { executionId: "e-timeout", message: "provider private detail" },
          { status: 408 },
        ),
      },
    });

    try {
      await client.runScenario(7, { responsive: true });
      throw new Error("Expected runScenario to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ScenarioRunRequestError);
      expect(error).toMatchObject({ executionId: "e-timeout", httpStatus: 408 });
      expect((error as Error).message).not.toContain("provider private detail");
    }
  });

  test("the real coordinator never retries a run POST after a 503", async () => {
    let postCalls = 0;
    const coordinator = new RequestCoordinator({
      limiter: immediateLimiter(),
      sleep: async () => {
        throw new Error("run POST must not enter 503 backoff");
      },
      request: async () => {
        postCalls++;
        return Response.json({ executionId: "e-503" }, { status: 503 });
      },
    });
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      coordinator,
    });

    await expect(client.runScenario(7, { responsive: true })).rejects.toMatchObject({
      executionId: "e-503",
      httpStatus: 503,
    });
    expect(postCalls).toBe(1);
  });

  test("create reconciliation is not cancelled after the POST may have been sent", async () => {
    const controller = new AbortController();
    let postCalls = 0;
    const coordinator = new RequestCoordinator({
      limiter: immediateLimiter(),
      request: async (request) => {
        const url = new URL(request.url);
        if (request.method === "POST") {
          postCalls++;
          controller.abort(new DOMException("cancelled after send", "AbortError"));
          throw new TypeError("socket closed after send");
        }
        if (url.pathname.endsWith("/teams/21")) {
          return Response.json({ team: { id: 21, organizationId: 9 } });
        }
        if (url.pathname.endsWith("/organizations/9")) {
          return Response.json({ organization: { id: 9, license: { apiLimit: 60 } } });
        }
        return Response.json({
          scenarios: [{
            id: 44,
            teamId: 21,
            name: "probe [123e4567-e89b-12d3-a456-426614174000]",
            isActive: false,
            scheduling: { type: "on-demand" },
          }],
        });
      },
    });
    const client = new MakeApiClient({
      token: "test-token", baseUrl: "https://eu1.make.com", coordinator,
    });
    const result = await client.createScenario({
      teamId: 21,
      blueprint: {
        name: "probe [123e4567-e89b-12d3-a456-426614174000]",
        flow: [],
      } as any,
      scheduling: { type: "on-demand" },
      confirmed: true,
      signal: controller.signal,
    });
    expect(result.id).toBe(44);
    expect(postCalls).toBe(1);
    expect(controller.signal.aborted).toBeTrue();
  });

  test("run cancellation interrupts the real coordinator's indefinite 429 wait", async () => {
    let notifySent!: () => void;
    const sent = new Promise<void>((resolve) => { notifySent = resolve; });
    let postCalls = 0;
    const coordinator = new RequestCoordinator({
      limiter: immediateLimiter(),
      sleep: async () => new Promise<void>(() => undefined),
      request: async () => {
        postCalls++;
        notifySent();
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "60" },
        });
      },
    });
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      coordinator,
    });
    const controller = new AbortController();
    const pending = client.runScenario(7, { responsive: true }, controller.signal);
    await sent;
    controller.abort();

    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    expect(postCalls).toBe(1);
  });

  test("run cancellation interrupts a shared cooldown before the POST is sent", async () => {
    let notifyWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => { notifyWaiting = resolve; });
    const limiter = immediateLimiter();
    limiter.waitForCooldown = async (_bucket, signal) => {
      notifyWaiting();
      return await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("cancelled", "AbortError"));
        }, { once: true });
      });
    };
    let postCalls = 0;
    const coordinator = new RequestCoordinator({
      limiter,
      request: async () => {
        postCalls++;
        return Response.json({ executionId: "must-not-run" });
      },
    });
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      coordinator,
    });
    const controller = new AbortController();
    const pending = client.runScenario(7, { responsive: true }, controller.signal);
    await waiting;
    controller.abort();

    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    expect(postCalls).toBe(0);
  });

  test("poll cancellation reaches an in-flight execution GET", async () => {
    let notifySent!: () => void;
    const sent = new Promise<void>((resolve) => { notifySent = resolve; });
    const coordinator = new RequestCoordinator({
      limiter: immediateLimiter(),
      request: async (request) => {
        notifySent();
        return await new Promise<Response>((_resolve, reject) => {
          (request as Request).signal.addEventListener("abort", () => {
            reject(new DOMException("cancelled", "AbortError"));
          }, { once: true });
        });
      },
    });
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      coordinator,
    });
    const controller = new AbortController();
    const pending = client.fetchExecutionDetails(7, "e-running", controller.signal);
    await sent;
    controller.abort();

    await expect(pending).rejects.toHaveProperty("name", "AbortError");
  });

  test("normalizes documented numeric run and execution statuses", async () => {
    let call = 0;
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      coordinator: {
        request: async () => {
          call++;
          return call === 1
            ? Response.json({ executionId: "e-numeric", status: 1, outputs: { done: true } })
            : call === 2
              ? Response.json({ execution: { status: 2 } })
              : Response.json({ execution: { status: 3 } });
        },
      },
    });

    expect(await client.runScenario(7, { responsive: true })).toEqual({
      executionId: "e-numeric",
      status: "SUCCESS",
      outputs: { done: true },
    });
    expect(await client.fetchExecutionDetails(7, "e-warning")).toEqual({ status: "WARNING" });
    expect(await client.fetchExecutionDetails(7, "e-error")).toEqual({ status: "ERROR" });
  });
  test("fetches documented team and organization details", async () => {
    const urls: string[] = [];
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      coordinator: {
        request: async (url) => {
          urls.push(String(url));
          return String(url).includes("/teams/")
            ? Response.json({ team: { id: 7, organizationId: 9, name: "Ops" } })
            : Response.json({ organization: { id: 9, name: "Acme", license: { apiLimit: 60 } } });
        },
      },
    });

    expect(await client.fetchTeam(7)).toMatchObject({ id: 7, organizationId: 9 });
    expect(await client.fetchOrganization(9)).toMatchObject({ id: 9, license: { apiLimit: 60 } });
    expect(urls).toEqual([
      "https://eu1.make.com/api/v2/teams/7",
      "https://eu1.make.com/api/v2/organizations/9",
    ]);
  });

  test("lists every organization scenario with the documented 1000-item page size", async () => {
    const urls: string[] = [];
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({
      id: index + 1,
      name: `Scenario ${index + 1}`,
    }));
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      organizationId: 9,
      coordinator: {
        request: async (url) => {
          const value = String(url);
          urls.push(value);
          if (value.endsWith("/api/v2/organizations/9")) {
            return Response.json({ organization: { id: 9, license: { apiLimit: 60 } } });
          }
          const offset = Number(new URL(value).searchParams.get("pg[offset]"));
          return offset === 0
            ? Response.json({ scenarios: firstPage, pg: { offset: 0, limit: 1000, total: 1001 } })
            : Response.json({ scenarios: [{ id: 1001, name: "Last" }], pg: { offset: 1000, limit: 1000, total: 1001 } });
        },
      },
    });

    const result = await client.listAllScenarios({ organizationId: 9 });
    expect(result.complete).toBe(true);
    expect(result.scenarios).toHaveLength(1001);
    expect(result.pages.map((page) => page.pagination)).toEqual([
      { offset: 0, limit: 1000, total: 1001 },
      { offset: 1000, limit: 1000, total: 1001 },
    ]);
    expect(urls.filter((url) => url.includes("/api/v2/scenarios?"))).toEqual([
      "https://eu1.make.com/api/v2/scenarios?organizationId=9&pg%5Blimit%5D=1000&pg%5Boffset%5D=0",
      "https://eu1.make.com/api/v2/scenarios?organizationId=9&pg%5Blimit%5D=1000&pg%5Boffset%5D=1000",
    ]);
  });

  test("lists and sanitizes every team connection page through the shared coordinator", async () => {
    const urls: string[] = [];
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      organizationId: 9,
      coordinator: {
        request: async (url) => {
          const value = String(url);
          urls.push(value);
          if (value.endsWith("/api/v2/teams/2186253")) {
            return Response.json({ team: { id: 2186253, organizationId: 9 } });
          }
          if (value.endsWith("/api/v2/organizations/9")) {
            return Response.json({ organization: { id: 9, license: { apiLimit: 60 } } });
          }
          const offset = Number(new URL(value).searchParams.get("pg[offset]") ?? 0);
          return offset === 0
            ? Response.json({
                connections: [{
                  id: 1,
                  name: "CRM",
                  accountName: "agent@example.test",
                  accountLabel: "CRM",
                  packageName: "monday",
                  teamId: 2186253,
                  scoped: true,
                  metadata: {
                    region: "eu",
                    authorization: "hide",
                    headers: [{ name: "apiKey", value: "hide too" }],
                  },
                  credentials: { token: "never return" },
                }],
                pg: { offset: 0, limit: 1, total: 2 },
              })
            : Response.json({
                connections: [{
                  id: 2,
                  name: "HTTP",
                  account: { name: "Agent", label: "API" },
                  package: { name: "http" },
                  teamId: 2186253,
                  scoped: false,
                  metadata: { resourceId: 991 },
                }],
                pg: { offset: 1, limit: 1, total: 2 },
              });
        },
      },
    });

    const result = await client.listConnections(2186253);
    expect(result).toEqual([
      {
        id: 1,
        name: "CRM",
        accountName: "agent@example.test",
        accountLabel: "CRM",
        packageName: "monday",
        teamId: 2186253,
        scoped: true,
        metadata: {
          region: "eu",
          authorization: "[REDACTED]",
          headers: [{ name: "apiKey", value: "[REDACTED]" }],
        },
      },
      {
        id: 2,
        name: "HTTP",
        accountName: "Agent",
        accountLabel: "API",
        packageName: "http",
        teamId: 2186253,
        scoped: false,
        metadata: { resourceId: 991 },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("never return");
    expect(JSON.stringify(result)).not.toContain("hide too");
    expect(urls.filter((url) => url.includes("/api/v2/connections"))).toEqual([
      "https://eu1.make.com/api/v2/connections?teamId=2186253",
      "https://eu1.make.com/api/v2/connections?teamId=2186253&pg%5Blimit%5D=1&pg%5Boffset%5D=1",
    ]);
  });

  test("returns completed pages and failure metadata when a later scenario page fails", async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({ id: index + 1 }));
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      coordinator: {
        request: async (url) => {
          const value = String(url);
          if (value.endsWith("/api/v2/organizations/9")) {
            return Response.json({ organization: { id: 9, license: { apiLimit: 60 } } });
          }
          const offset = Number(new URL(value).searchParams.get("pg[offset]"));
          return offset === 0
            ? Response.json({ scenarios: firstPage, pg: { total: 1001 } })
            : new Response("temporary", { status: 503 });
        },
      },
    });

    const result = await client.listAllScenarios({ organizationId: 9 });
    expect(result.scenarios).toHaveLength(1000);
    expect(result).toMatchObject({
      complete: false,
      failedOffset: 1000,
      failure: { code: "TRANSIENT", httpStatus: 503, retryable: true },
    });
  });

  test("rethrows a capability failure before any scenario page succeeds", async () => {
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      coordinator: {
        request: async (url) => String(url).endsWith("/api/v2/organizations/9")
          ? Response.json({ organization: { id: 9, license: { apiLimit: 60 } } })
          : new Response("forbidden", { status: 403 }),
      },
    });

    expect(client.listAllScenarios({ organizationId: 9 })).rejects.toThrow(
      "Make API list scenarios error 403",
    );
  });

  test("later-page capability failures retain partial results with explicit safe semantics", async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({ id: index + 1 }));
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      coordinator: {
        request: async (url) => {
          const value = String(url);
          if (value.endsWith("/api/v2/organizations/9")) {
            return Response.json({ organization: { id: 9, license: { apiLimit: 60 } } });
          }
          return Number(new URL(value).searchParams.get("pg[offset]")) === 0
            ? Response.json({ scenarios: firstPage })
            : new Response("private provider body", { status: 403 });
        },
      },
    });

    const result = await client.listAllScenarios({ organizationId: 9 });
    expect(result.scenarios).toHaveLength(1000);
    expect(result).toMatchObject({
      complete: false,
      failedOffset: 1000,
      failure: { code: "SCOPE_MISSING", httpStatus: 403, retryable: false },
    });
    expect(JSON.stringify(result)).not.toContain("private provider body");
  });

  test("configured organization IDs still load details unless details or a valid rate cache exist", async () => {
    const urls: string[] = [];
    const coordinator = {
      request: async (url: string | URL) => {
        const value = String(url);
        urls.push(value);
        return value.endsWith("/api/v2/organizations/9")
          ? Response.json({ organization: { id: 9, license: { apiLimit: 60 } } })
          : Response.json({ scenarios: [] });
      },
      getRateLimitSnapshot: () => ({
        documentedRpm: null,
        effectiveRpm: 30,
        limitSource: "fallback" as const,
        requestsSent: 0,
        retries: 0,
        cooldownMs: 0,
      }),
      setOrganizationLimit: () => undefined,
    };
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      organizationId: 9,
      coordinator,
    });

    await client.listScenarios({ organizationId: 9 });
    await client.listScenarios({ organizationId: 9 });
    expect(urls.filter((url) => url.endsWith("/api/v2/organizations/9"))).toHaveLength(1);
  });

  test("a valid coordinator organization-limit cache avoids redundant detail loading", async () => {
    const urls: string[] = [];
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      organizationId: 9,
      coordinator: {
        request: async (url) => {
          urls.push(String(url));
          return Response.json({ scenarios: [] });
        },
        getRateLimitSnapshot: () => ({
          documentedRpm: 60,
          effectiveRpm: 57,
          limitSource: "cache",
          requestsSent: 0,
          retries: 0,
          cooldownMs: 0,
        }),
      },
    });

    await client.listScenarios({ organizationId: 9 });
    expect(urls).toEqual(["https://eu1.make.com/api/v2/scenarios?organizationId=9"]);
  });
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

  test("keeps a discovered organization bucket when limit details are inaccessible", async () => {
    const requestBuckets: Array<number | "unknown"> = [];
    const coordinator = {
      request: async (url: string | URL, _init: RequestInit, requestContext: RequestContext) => {
        requestBuckets.push(requestContext.bucket.organizationId);
        if (String(url).endsWith("/api/v2/teams/2186253")) {
          return Response.json({ team: { id: 2186253, organizationId: 8430514 } });
        }
        if (String(url).endsWith("/api/v2/organizations/8430514")) {
          return new Response("forbidden", { status: 403 });
        }
        return Response.json({ scenario: { id: 123 } });
      },
      getRateLimitSnapshot: (rateBucket: RateBucket) => ({
        documentedRpm: null,
        effectiveRpm: 30,
        limitSource: "fallback" as const,
        requestsSent: 0,
        retries: 0,
        cooldownMs: 0,
        organizationId: rateBucket.organizationId,
      }),
    };
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
      coordinator,
    });

    expect(await client.discoverOrganizationForTeam(2186253)).toBe(false);
    await client.fetchScenario(123);

    expect(requestBuckets).toEqual(["unknown", 8430514, 8430514]);
    expect(client.getRateLimitSnapshot()).toMatchObject({
      documentedRpm: null,
      effectiveRpm: 30,
      limitSource: "fallback",
      organizationId: 8430514,
    });
  });

  test("reuses an exact-organization cached limit when detail refresh is inaccessible", async () => {
    const coordinator = {
      request: async (url: string | URL) => {
        if (String(url).endsWith("/api/v2/teams/2186253")) {
          return Response.json({ team: { id: 2186253, organizationId: 8430514 } });
        }
        return new Response("forbidden", { status: 403 });
      },
      getRateLimitSnapshot: (rateBucket: RateBucket) => rateBucket.organizationId === 8430514
        ? {
            documentedRpm: 60,
            effectiveRpm: 57,
            limitSource: "cache" as const,
            requestsSent: 0,
            retries: 0,
            cooldownMs: 0,
          }
        : {
            documentedRpm: null,
            effectiveRpm: 30,
            limitSource: "fallback" as const,
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

    expect(await client.discoverOrganizationForTeam(2186253)).toBe(false);
    expect(client.getRateLimitSnapshot()).toMatchObject({
      documentedRpm: 60,
      effectiveRpm: 57,
      limitSource: "cache",
    });
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
