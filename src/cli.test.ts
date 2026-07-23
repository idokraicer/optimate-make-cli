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

async function runInspect(
  args: string[],
  options: { cwd?: string; preload?: string; token?: string } = {},
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
