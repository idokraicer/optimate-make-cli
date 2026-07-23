import { describe, expect, test } from "bun:test";
import { analyze } from "./analyzer/index";
import { applyFixes } from "./fixer/index";
import { formatReport } from "./reporter/index";
import simpleBlueprint from "../tests/fixtures/simple-blueprint.json";
import type { Blueprint } from "./make-api/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
