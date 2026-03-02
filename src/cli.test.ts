import { describe, expect, test } from "bun:test";
import { analyze } from "./analyzer/index";
import { applyFixes } from "./fixer/index";
import { formatReport } from "./reporter/index";
import simpleBlueprint from "../tests/fixtures/simple-blueprint.json";
import type { Blueprint } from "./make-api/types";

describe("CLI commands", () => {
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
