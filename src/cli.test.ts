import { describe, expect, test } from "bun:test";
import { analyze } from "./analyzer/index";
import { applyFixes } from "./fixer/index";
import { formatReport } from "./reporter/index";
import simpleBlueprint from "../tests/fixtures/simple-blueprint.json";
import type { Blueprint } from "./make-api/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ifElseBlueprint from "../tests/fixtures/if-else-blueprint.json";
import { fingerprintBlueprint } from "./utils/blueprint-fingerprint";

async function runInspect(
  args: string[],
  options: { cwd?: string; home?: string; preload?: string; token?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = ["bun"];
  if (options.preload) command.push("--preload", options.preload);
  command.push(join(process.cwd(), "src/cli.ts"), "inspect", ...args);

  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      MAKE_FIXER_NO_UPDATE: "1",
      MAKE_FIXER_RATE_DB: join(options.cwd ?? tmpdir(), "inspect-rate.sqlite"),
      ...(options.home ? { HOME: options.home } : {}),
      ...(options.token ? { MAKE_API_TOKEN: options.token } : {}),
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

async function runCli(
  commandName: string,
  args: string[],
  options: { cwd: string; preload?: string; input?: string } ,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = ["bun"];
  if (options.preload) command.push("--preload", options.preload);
  command.push(join(process.cwd(), "src/cli.ts"), commandName, ...args);

  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      MAKE_API_TOKEN: "fake",
      MAKE_FIXER_NO_UPDATE: "1",
      MAKE_FIXER_RATE_DB: join(options.cwd, "rate.sqlite"),
    },
  });
  if (options.input) proc.stdin.write(options.input);
  proc.stdin.end();

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

function expectInspectFailure(result: { stdout: string; stderr: string; code: number }): any {
  expect(result.code).toBe(1);
  expect(result.stderr).toBe("");
  const output = JSON.parse(result.stdout);
  expect(output).toMatchObject({
    ok: false,
    command: "inspect",
    error: { code: "INVALID_DATA", retryable: false },
  });
  return output;
}

describe("CLI commands", () => {
  test("CLI exposes owned scenario creation and guarded cleanup", async () => {
    const create = Bun.spawn(["bun", "src/cli.ts", "create", "--help"], {
      stdout: "pipe",
      env: { ...process.env, MAKE_FIXER_NO_UPDATE: "1", MAKE_FIXER_RATE_DB: ":memory:" },
    });
    const cleanup = Bun.spawn(["bun", "src/cli.ts", "cleanup", "--help"], {
      stdout: "pipe",
      env: { ...process.env, MAKE_FIXER_NO_UPDATE: "1", MAKE_FIXER_RATE_DB: ":memory:" },
    });
    const [createHelp, cleanupHelp] = await Promise.all([
      new Response(create.stdout).text(),
      new Response(cleanup.stdout).text(),
    ]);
    expect(createHelp).toContain("owned on-demand scenario");
    expect(createHelp).toContain("--no-probe-label");
    expect(cleanupHelp).toContain("verified owned scenario");
    expect(cleanupHelp).toContain("--delete");
  });

  test("CLI exposes organization examples and scoped connections discovery", async () => {
    const examples = Bun.spawn(["bun", "src/cli.ts", "examples", "--help"], {
      stdout: "pipe",
      env: { ...process.env, MAKE_FIXER_NO_UPDATE: "1" },
    });
    const connections = Bun.spawn(["bun", "src/cli.ts", "connections", "--help"], {
      stdout: "pipe",
      env: { ...process.env, MAKE_FIXER_NO_UPDATE: "1" },
    });
    const [examplesHelp, connectionsHelp] = await Promise.all([
      new Response(examples.stdout).text(),
      new Response(connections.stdout).text(),
    ]);
    expect(examplesHelp).toContain("reusable module configurations");
    expect(examplesHelp).toContain("--module-id");
    expect(examplesHelp).toContain("--full");
    expect(connectionsHelp).toContain("team-scoped connections");
    expect(connectionsHelp).toContain("--from-url");
  });

  test("CLI exposes read-only capability diagnostics", async () => {
    const proc = Bun.spawn(["bun", "src/cli.ts", "doctor", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MAKE_FIXER_NO_UPDATE: "1" },
    });
    const stdout = await new Response(proc.stdout).text();
    expect(stdout).toContain("safe, read-only capability probes");
    expect(stdout).toContain("--from-url");
    expect(stdout).toContain("--scenario");
    expect(stdout).toContain("--json");
    expect(stdout).toContain("--human");
  });

  test("doctor performs GET-only probes and reports discovered rate evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "make-fixer-doctor-"));
    const preload = join(directory, "mock-fetch.ts");
    await Bun.write(preload, `
      globalThis.fetch = async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        console.error("MOCK_FETCH " + request.method + " " + url.pathname);
        if (request.method !== "GET") {
          return Response.json({ code: "UNSAFE_METHOD" }, { status: 500 });
        }
        if (url.pathname === "/api/v2/organizations") {
          return Response.json({ organizations: [{ id: 12 }] });
        }
        if (url.pathname === "/api/v2/organizations/12") {
          return Response.json({ organization: { id: 12, license: { apiLimit: 120 } } });
        }
        return Response.json({ code: "NOT_FOUND" }, { status: 404 });
      };
    `);

    const result = await runCli("doctor", [
      "--from-url",
      "https://eu2.make.com/organization/12/dashboard",
    ], { cwd: directory, preload });
    rmSync(directory, { recursive: true, force: true });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("MOCK_FETCH GET /api/v2/organizations");
    expect(result.stderr).toContain("MOCK_FETCH GET /api/v2/organizations/12");
    expect(result.stderr).not.toContain("MOCK_FETCH POST");
    expect(result.stderr).not.toContain("MOCK_FETCH PATCH");
    expect(result.stderr).not.toContain("MOCK_FETCH DELETE");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "doctor",
      data: {
        configuredZone: expect.any(String),
        resolvedZone: "eu2",
        organizationId: 12,
        rateLimit: {
          documentedRpm: 120,
          effectiveRpm: 114,
          limitSource: "organization_api",
        },
      },
    });
  });

  test("CLI exposes safe scenario run controls", async () => {
    const proc = Bun.spawn(["bun", "src/cli.ts", "run", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MAKE_FIXER_NO_UPDATE: "1" },
    });
    const stdout = await new Response(proc.stdout).text();
    expect(stdout).toContain("--scenario");
    expect(stdout).toContain("--data");
    expect(stdout).toContain("--data-file");
    expect(stdout).toContain("--wait");
    expect(stdout).toContain("--timeout");
    expect(stdout).toContain("--yes");
    expect(stdout).toContain("--human");
  });
  test("CLI has organization search command with agent-safe controls", async () => {
    const proc = Bun.spawn(["bun", "src/cli.ts", "search", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(stdout).toContain("Search every scenario blueprint in an organization");
    expect(stdout).toContain("--from-url");
    expect(stdout).toContain("--organization");
    expect(stdout).toContain("--query");
    expect(stdout).toContain("--regex");
    expect(stdout).toContain("--field");
    expect(stdout).toContain("--value");
    expect(stdout).toContain("--case-sensitive");
    expect(stdout).toContain("--fresh");
    expect(stdout).toContain("--human");
  });
  test("scenario URL resolution discovers team and organization details before production calls", async () => {
    const directory = mkdtempSync(join(tmpdir(), "make-fixer-cli-rate-"));
    const preload = join(directory, "mock-fetch.ts");
    await Bun.write(preload, `
      globalThis.fetch = async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        console.error("MOCK_FETCH " + new URL(url).pathname);
        if (url.endsWith("/api/v2/teams/2186253")) {
          return Response.json({ team: { id: 2186253, organizationId: 8430514 } });
        }
        if (url.endsWith("/api/v2/organizations/8430514")) {
          return Response.json({ organization: { id: 8430514, license: { apiLimit: 60 } } });
        }
        if (url.includes("/api/v2/scenarios/6648651/logs")) {
          return Response.json({ scenarioLogs: [] });
        }
        return new Response("not found", { status: 404 });
      };
    `);
    const proc = Bun.spawn([
      "bun",
      "--preload",
      preload,
      "src/cli.ts",
      "executions",
      "-s",
      "https://eu1.make.com/2186253/scenarios/6648651/edit",
      "--json",
    ], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        MAKE_API_TOKEN: "fake",
        MAKE_FIXER_RATE_DB: join(directory, "rate.sqlite"),
      },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    rmSync(directory, { recursive: true, force: true });

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
    expect(stderr.indexOf("/api/v2/teams/2186253")).toBeLessThan(
      stderr.indexOf("/api/v2/organizations/8430514"),
    );
    expect(stderr.indexOf("/api/v2/organizations/8430514")).toBeLessThan(
      stderr.indexOf("/api/v2/scenarios/6648651/logs"),
    );
  });

  test("CLI has fetch command", async () => {
    const proc = Bun.spawn(["bun", "src/cli.ts", "fetch", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(stdout).toContain("--scenario");
    expect(stdout).toContain("Fetch a scenario blueprint");
  });

  test("CLI has validate command", async () => {
    const proc = Bun.spawn(["bun", "src/cli.ts", "validate", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(stdout).toContain("--scenario");
    expect(stdout).toContain("Compare local blueprint");
  });

  test("fetch writes a secret-free fingerprint sidecar alongside the blueprint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "make-fixer-fetch-sidecar-"));
    const preload = join(directory, "mock-fetch.ts");
    await Bun.write(preload, `
      globalThis.fetch = async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/api/v2/teams/2186253")) return Response.json({ team: { organizationId: 8430514 } });
        if (url.endsWith("/api/v2/organizations/8430514")) return Response.json({ organization: { license: { apiLimit: 60 } } });
        if (url.endsWith("/api/v2/scenarios/6648651/blueprint")) return Response.json(${JSON.stringify({ blueprint: JSON.stringify(simpleBlueprint) })});
        return new Response("not found", { status: 404 });
      };
    `);

    const result = await runCli("fetch", ["-s", "https://eu1.make.com/2186253/scenarios/6648651/edit"], {
      cwd: directory,
      preload,
    });
    const sidecar = JSON.parse(await Bun.file(join(directory, "blueprints/.make-fixer/6648651.json")).text());
    rmSync(directory, { recursive: true, force: true });

    expect(result.code).toBe(0);
    expect(sidecar).toMatchObject({
      scenarioId: 6648651,
      baseUrl: "https://eu1.make.com",
      fingerprint: await fingerprintBlueprint(simpleBlueprint as Blueprint),
    });
    expect(Date.parse(sidecar.fetchedAt)).not.toBeNaN();
    expect(JSON.stringify(sidecar)).not.toContain("fake");
  });

  test("validate adds semantic leaf changes only with --changes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "make-fixer-validate-changes-"));
    const local = structuredClone(simpleBlueprint) as Blueprint;
    local.flow[1].mapper.query = "{{1.email}}";
    await Bun.write(join(directory, "blueprints/6648651.json"), JSON.stringify(local));
    const preload = join(directory, "mock-fetch.ts");
    await Bun.write(preload, `
      globalThis.fetch = async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/api/v2/teams/2186253")) return Response.json({ team: { organizationId: 8430514 } });
        if (url.endsWith("/api/v2/organizations/8430514")) return Response.json({ organization: { license: { apiLimit: 60 } } });
        if (url.endsWith("/api/v2/scenarios/6648651/blueprint")) return Response.json(${JSON.stringify({ blueprint: JSON.stringify(simpleBlueprint) })});
        return new Response("not found", { status: 404 });
      };
    `);

    const json = await runCli("validate", ["-s", "https://eu1.make.com/2186253/scenarios/6648651/edit", "--json", "--changes"], {
      cwd: directory,
      preload,
    });
    const human = await runCli("validate", ["-s", "https://eu1.make.com/2186253/scenarios/6648651/edit", "--changes"], {
      cwd: directory,
      preload,
    });
    rmSync(directory, { recursive: true, force: true });

    expect(json.code).toBe(0);
    const output = JSON.parse(json.stdout.slice(json.stdout.indexOf("{")));
    expect(output.modulesModified).toEqual([2]);
    expect(output.directlyModifiedModules).toEqual([2]);
    expect(output.changes).toEqual([{ path: "flow[1].mapper.query", moduleId: 2, before: "{{1.phone}}", after: "{{1.email}}" }]);
    expect(human.stdout).toContain("Directly modified modules: #2");
  });

  test("CLI has inspect command with agent-safe output controls", async () => {
    const proc = Bun.spawn(["bun", "src/cli.ts", "inspect", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(stdout).toContain("Inspect a scenario");
    expect(stdout).toContain("--scenario");
    expect(stdout).toContain("--module");
    expect(stdout).toContain("--summary");
    expect(stdout).toContain("--local");
    expect(stdout).toContain("--human");
  });

  test("inspect fetches remote by default and emits one JSON envelope", async () => {
    const directory = mkdtempSync(join(tmpdir(), "make-fixer-inspect-remote-"));
    const preload = join(directory, "mock-fetch.ts");
    await Bun.write(preload, `
      globalThis.fetch = async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/api/v2/teams/2186253")) {
          return Response.json({ team: { id: 2186253, organizationId: 8430514 } });
        }
        if (url.endsWith("/api/v2/organizations/8430514")) {
          return Response.json({ organization: { id: 8430514, license: { apiLimit: 60 } } });
        }
        if (url.endsWith("/api/v2/scenarios/6648651/blueprint")) {
          return Response.json(${JSON.stringify({ blueprint: JSON.stringify(simpleBlueprint) })});
        }
        return new Response("not found", { status: 404 });
      };
    `);

    const result = await runInspect([
      "-s",
      "https://eu1.make.com/2186253/scenarios/6648651/edit",
      "--summary",
    ], { cwd: directory, preload, token: "fake" });
    rmSync(directory, { recursive: true, force: true });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      ok: true,
      command: "inspect",
      data: { scenarioId: 6648651, source: "remote", summary: { moduleCount: 4 } },
    });
  });

  test("inspect --local never fetches and emits one JSON envelope", async () => {
    const directory = mkdtempSync(join(tmpdir(), "make-fixer-inspect-local-"));
    await Bun.write(join(directory, "blueprints/6648651.json"), JSON.stringify(simpleBlueprint));

    const result = await runInspect(["-s", "6648651", "--summary", "--local"], { cwd: directory });
    rmSync(directory, { recursive: true, force: true });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "inspect",
      data: { scenarioId: 6648651, source: "local", summary: { moduleCount: 4 } },
    });
  });

  test("inspect option and local-file errors always emit stable JSON failures", async () => {
    const cases = [
      { args: ["--summary"], message: "A scenario ID or Make.com URL is required." },
      { args: ["-s", "not-an-id", "--summary"], message: '"not-an-id" is not a valid scenario ID or Make.com URL.' },
      { args: ["-s", "https://eu1.make.com/1/scenarios/0/edit", "--summary"], message: '"https://eu1.make.com/1/scenarios/0/edit" is not a valid scenario ID or Make.com URL.' },
      { args: ["-s", "https://eu1.make.com/1/scenarios/-1/edit", "--summary"], message: '"https://eu1.make.com/1/scenarios/-1/edit" is not a valid scenario ID or Make.com URL.' },
      { args: ["-s", "1", "--module", "abc"], message: "--module must be a positive integer." },
      { args: ["-s", "1", "--module", "0"], message: "--module must be a positive integer." },
      { args: ["-s", "1", "--module", "1", "--summary"], message: "Choose exactly one of --module or --summary." },
      { args: ["-s", "1"], message: "Choose exactly one of --module or --summary." },
      { args: ["-s", "1", "--summary", "--local"], message: "Local blueprint not found at blueprints/1.json" },
    ];

    for (const testCase of cases) {
      const output = expectInspectFailure(await runInspect(testCase.args));
      expect(output.error.message).toBe(testCase.message);
    }
  });

  test("inspect resolves bare scenario failures through JSON envelopes", async () => {
    const missingTokenDirectory = mkdtempSync(join(tmpdir(), "make-fixer-inspect-missing-token-"));
    const missingToken = expectInspectFailure(await runInspect(["-s", "987654321", "--summary"], {
      cwd: missingTokenDirectory,
      home: missingTokenDirectory,
    }));
    rmSync(missingTokenDirectory, { recursive: true, force: true });
    expect(missingToken.error.message).toBe("Unable to inspect scenario.");

    const directory = mkdtempSync(join(tmpdir(), "make-fixer-inspect-zone-failure-"));
    const preload = join(directory, "mock-fetch.ts");
    await Bun.write(preload, `
      globalThis.fetch = async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("/scenarios/987654322")) return new Response("Token provider-secret", { status: 404 });
        if (url.includes("/scenarios/987654323")) return new Response("Token provider-secret", { status: 401 });
        return new Response("not found", { status: 404 });
      };
    `);

    for (const scenarioId of ["987654322", "987654323"]) {
      const output = expectInspectFailure(await runInspect(["-s", scenarioId, "--summary"], {
        cwd: directory,
        home: directory,
        preload,
        token: "fake",
      }));
      expect(output.error.message).toBe("Unable to inspect scenario.");
      expect(JSON.stringify(output)).not.toContain("provider-secret");
    }
    rmSync(directory, { recursive: true, force: true });
  });

  test("inspect rejects duplicates and sanitizes remote fetch failures", async () => {
    const directory = mkdtempSync(join(tmpdir(), "make-fixer-inspect-duplicate-"));
    await Bun.write(join(directory, "blueprints/6648651.json"), JSON.stringify(ifElseBlueprint));
    const duplicate = expectInspectFailure(await runInspect([
      "-s", "6648651", "--summary", "--local",
    ], { cwd: directory }));
    rmSync(directory, { recursive: true, force: true });

    expect(duplicate.error.message).toBe("Blueprint contains duplicate module IDs.");
    expect(duplicate.error.duplicates).toEqual({
      "18": [
        "flow[1].branches[0].flow[0]",
        "flow[1].branches[0].flow[0].onerror[0].routes[0].flow[1]",
      ],
    });

    const failedDirectory = mkdtempSync(join(tmpdir(), "make-fixer-inspect-fetch-failure-"));
    const preload = join(failedDirectory, "mock-fetch.ts");
    await Bun.write(preload, `
      globalThis.fetch = async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/api/v2/teams/2186253")) return Response.json({ team: { organizationId: 8430514 } });
        if (url.endsWith("/api/v2/organizations/8430514")) return Response.json({ organization: { license: { apiLimit: 60 } } });
        if (url.endsWith("/blueprint")) return new Response("Token super-secret", { status: 400 });
        return new Response("not found", { status: 404 });
      };
    `);
    const remoteFailure = expectInspectFailure(await runInspect([
      "-s", "https://eu1.make.com/2186253/scenarios/6648651/edit", "--summary",
    ], { preload, token: "fake" }));
    rmSync(failedDirectory, { recursive: true, force: true });

    expect(remoteFailure.error.message).toBe("Unable to inspect scenario.");
    expect(remoteFailure.error.message).not.toContain("super-secret");
  });

  test("CLI has push command", async () => {
    const proc = Bun.spawn(["bun", "src/cli.ts", "push", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(stdout).toContain("--scenario");
    expect(stdout).toContain("Push a local blueprint");
  });

  test("push blocks remote drift before PATCH and forces confirmation for an override", async () => {
    const directory = mkdtempSync(join(tmpdir(), "make-fixer-push-drift-"));
    const local = structuredClone(simpleBlueprint) as Blueprint;
    const remote = structuredClone(simpleBlueprint) as Blueprint;
    remote.flow[1].mapper.query = "{{1.remoteChange}}";
    await Bun.write(join(directory, "blueprints/6648651.json"), JSON.stringify(local));
    await Bun.write(join(directory, "blueprints/.make-fixer/6648651.json"), JSON.stringify({
      scenarioId: 6648651,
      baseUrl: "https://eu1.make.com",
      fingerprint: await fingerprintBlueprint(local),
      fetchedAt: new Date().toISOString(),
    }));
    const preload = join(directory, "mock-fetch.ts");
    await Bun.write(preload, `
      globalThis.fetch = async (input, init = {}) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/api/v2/teams/2186253")) return Response.json({ team: { organizationId: 8430514 } });
        if (url.endsWith("/api/v2/organizations/8430514")) return Response.json({ organization: { license: { apiLimit: 60 } } });
        if (url.endsWith("/api/v2/scenarios/6648651/blueprint")) return Response.json(${JSON.stringify({ blueprint: JSON.stringify(remote) })});
        if (url.endsWith("/api/v2/scenarios/6648651") && init.method === "PATCH") {
          console.error("PATCH_SENT");
          return new Response(null, { status: 204 });
        }
        return new Response("not found", { status: 404 });
      };
    `);

    const blocked = await runCli("push", ["-s", "https://eu1.make.com/2186253/scenarios/6648651/edit", "--yes"], {
      cwd: directory,
      preload,
    });
    const overridden = await runCli("push", ["-s", "https://eu1.make.com/2186253/scenarios/6648651/edit", "--yes", "--allow-remote-drift"], {
      cwd: directory,
      preload,
      input: "n\n",
    });
    rmSync(directory, { recursive: true, force: true });

    expect(blocked.code).toBe(4);
    expect(blocked.stderr).toContain("REMOTE_DRIFT");
    expect(blocked.stderr).not.toContain("PATCH_SENT");
    expect(overridden.code).toBe(0);
    expect(overridden.stdout).toContain("Continue despite remote drift? [y/N]");
    expect(overridden.stdout).toContain("Aborted.");
    expect(overridden.stderr).not.toContain("PATCH_SENT");
  });

  test("executions exposes agent-friendly time and compact output options", async () => {
    const proc = Bun.spawn(["bun", "src/cli.ts", "executions", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(stdout).toContain("--limit");
    expect(stdout).toContain("--from");
    expect(stdout).toContain("--to");
    expect(stdout).toContain("--since");
    expect(stdout).toContain("--compact");
    expect(stdout).toContain("--output");
    expect(stdout).toContain("--include-input");
  });
  test("CLI has notes command", async () => {
    const proc = Bun.spawn(["bun", "src/cli.ts", "notes", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(stdout).toContain("--scenario");
    expect(stdout).toContain("--add");
    expect(stdout).toContain("--module");
    expect(stdout).toContain("--content");
    expect(stdout).toContain("List or add notes");
  });

  test("notes --add requires --module and --content", async () => {
    const proc = Bun.spawn(
      ["bun", "src/cli.ts", "notes", "-s", "12345", "--add"],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, MAKE_API_TOKEN: "fake" } }
    );
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(code).not.toBe(0);
    expect(stderr).toContain("--add requires both --module and --content");
  });

  test("notes --add with --module but no --content fails", async () => {
    const proc = Bun.spawn(
      ["bun", "src/cli.ts", "notes", "-s", "12345", "--add", "--module", "1"],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, MAKE_API_TOKEN: "fake" } }
    );
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(code).not.toBe(0);
    expect(stderr).toContain("--add requires both --module and --content");
  });
});

describe("CLI integration (no network)", () => {
  test("full analyze → fix → report pipeline works", async () => {
    const blueprint = simpleBlueprint as Blueprint;

    const { issues, checklist } = analyze(blueprint, []);
    expect(issues.length).toBeGreaterThan(0);

    const autoFixable = issues.filter((i) => i.autoFixable);
    const reportOnly = issues.filter((i) => !i.autoFixable);
    const { fixed, changes } = await applyFixes(blueprint, autoFixable, { skipAi: true });

    const mod2 = fixed.flow.find((m) => m.id === 2);
    expect(mod2?.onerror).toHaveLength(1);

    const report = formatReport(changes, reportOnly, checklist);
    expect(typeof report).toBe("string");
    expect(report.length).toBeGreaterThan(0);
  });
});
