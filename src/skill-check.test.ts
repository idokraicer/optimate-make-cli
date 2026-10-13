import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSkills, formatSkillWarning, refreshSkillPlugins, skillFingerprint } from "./skill-check";

let root: string;
let home: string;
let bundled: string;
let project: string;

function writeSkill(dir: string, body: string, extra: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
  for (const [rel, content] of Object.entries(extra)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

function installClaudePlugin(version: string, entry: Record<string, unknown>, skills: Record<string, string>) {
  const installPath = join(home, ".claude", "plugins", "cache", "optimate-plugins", "make-fixer", version);
  for (const [name, body] of Object.entries(skills)) writeSkill(join(installPath, "skills", name), body);
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({ plugins: { "make-fixer@optimate-plugins": [{ ...entry, installPath, version }] } }),
  );
}

const check = (env: Record<string, string | undefined> = {}) =>
  checkSkills({ bundledDir: bundled, home, cwd: project, env });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-check-"));
  home = join(root, "home");
  bundled = join(root, "cli", "skills");
  project = join(home, "work", "proj");
  mkdirSync(project, { recursive: true });
  writeSkill(join(bundled, "make-fixer"), "current", { "references/debugging.md": "bundles" });
  writeSkill(join(bundled, "make-execution-data"), "exec");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("skillFingerprint", () => {
  test("ignores plugin-only agents/ metadata", () => {
    const a = join(root, "a");
    const b = join(root, "b");
    writeSkill(a, "x");
    writeSkill(b, "x", { "agents/openai.yaml": "ui" });
    expect(skillFingerprint(a)).toBe(skillFingerprint(b));
  });

  test("changes when a reference file changes", () => {
    const a = join(root, "a");
    const b = join(root, "b");
    writeSkill(a, "x", { "references/r.md": "1" });
    writeSkill(b, "x", { "references/r.md": "2" });
    expect(skillFingerprint(a)).not.toBe(skillFingerprint(b));
  });
});

describe("checkSkills", () => {
  test("a stale personal copy is reported (the copy that overrode the plugin)", () => {
    writeSkill(join(home, ".claude", "skills", "make-fixer"), "old");
    const { issues } = check();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ skill: "make-fixer", problem: "differs", source: { kind: "personal" } });
  });

  test("a symlink to the bundled skills is in sync", () => {
    mkdirSync(join(home, ".codex", "skills"), { recursive: true });
    symlinkSync(join(bundled, "make-fixer"), join(home, ".codex", "skills", "make-fixer"));
    expect(check().issues).toEqual([]);
  });

  test("an outdated user-scope plugin, missing a skill, is reported", () => {
    installClaudePlugin("1.0.7", { scope: "user" }, { "make-fixer": "old" });
    const problems = check().issues.map((i) => `${i.skill}:${i.problem}`).sort();
    expect(problems).toEqual(["make-execution-data:missing", "make-fixer:differs"]);
  });

  test("a matching plugin is in sync", () => {
    installClaudePlugin("1.0.8", { scope: "user" }, {});
    const skills = join(home, ".claude", "plugins", "cache", "optimate-plugins", "make-fixer", "1.0.8", "skills");
    writeSkill(join(skills, "make-fixer"), "current", { "references/debugging.md": "bundles", "agents/openai.yaml": "ui" });
    writeSkill(join(skills, "make-execution-data"), "exec");
    expect(check().issues).toEqual([]);
  });

  test("a project-scope plugin for another project is ignored", () => {
    installClaudePlugin("1.0.7", { scope: "local", projectPath: join(home, "other") }, { "make-fixer": "old" });
    expect(check().issues).toEqual([]);
  });

  test("a project-scope plugin for a parent of cwd applies", () => {
    installClaudePlugin("1.0.7", { scope: "local", projectPath: join(home, "work") }, { "make-fixer": "old" });
    expect(check().issues.length).toBeGreaterThan(0);
  });

  test("a stale project copy in a parent folder is reported", () => {
    writeSkill(join(home, "work", ".claude", "skills", "make-fixer"), "old");
    expect(check().issues[0]).toMatchObject({ source: { kind: "project" } });
  });

  test("Claude Code with no skill for this directory is flagged", () => {
    expect(check({ CLAUDECODE: "1" }).claudeCodeHasNoSkill).toBe(true);
    expect(check({}).claudeCodeHasNoSkill).toBe(false);
    installClaudePlugin("1.0.7", { scope: "user" }, { "make-fixer": "old" });
    expect(check({ CLAUDECODE: "1" }).claudeCodeHasNoSkill).toBe(false);
  });

  test("no bundled skills means nothing to compare", () => {
    writeSkill(join(home, ".claude", "skills", "make-fixer"), "old");
    expect(checkSkills({ bundledDir: join(root, "none"), home, cwd: project, env: {} }).issues).toEqual([]);
  });
});

describe("formatSkillWarning", () => {
  test("tells the agent to warn the user and how to fix it", () => {
    writeSkill(join(home, ".claude", "skills", "make-fixer"), "old");
    const msg = formatSkillWarning(check({ CLAUDECODE: "1" }), "0.2.0");
    expect(msg).toContain("NOTE FOR AI AGENTS");
    expect(msg).toContain("Tell the user");
    expect(msg).toContain("make-fixer update");
    expect(msg).toContain("Delete it");
  });
});

describe("refreshSkillPlugins", () => {
  test("updates the installed Claude Code scope through the claude CLI", () => {
    installClaudePlugin("1.0.7", { scope: "user" }, { "make-fixer": "old" });
    const calls: string[] = [];
    refreshSkillPlugins({
      home,
      cwd: project,
      which: (bin) => (bin === "claude" ? "claude" : null),
      run: (cmd) => (calls.push(cmd.join(" ")), { ok: true, out: "" }),
      log: () => {},
    });
    expect(calls).toEqual([
      "claude plugin marketplace update optimate-plugins",
      "claude plugin update make-fixer@optimate-plugins --scope user",
    ]);
  });

  test("suggests a user-scope install instead of installing when absent", () => {
    const calls: string[] = [];
    const logs: string[] = [];
    refreshSkillPlugins({
      home,
      cwd: project,
      which: (bin) => (bin === "claude" ? "claude" : null),
      run: (cmd) => (calls.push(cmd.join(" ")), { ok: true, out: "" }),
      log: (m) => logs.push(m),
    });
    expect(calls).toEqual([]);
    expect(logs.join("")).toContain("--scope user");
  });

  test("refreshes Codex only when make-fixer is installed there", () => {
    const calls: string[] = [];
    refreshSkillPlugins({
      home,
      cwd: project,
      which: (bin) => (bin === "codex" ? "codex" : null),
      run: (cmd) => {
        calls.push(cmd.join(" "));
        const out = JSON.stringify({ installed: [{ name: "make-fixer", marketplaceName: "optimate-plugins", installed: true }] });
        return { ok: true, out: cmd.includes("list") ? out : "" };
      },
      log: () => {},
    });
    expect(calls).toEqual([
      "codex plugin list --json",
      "codex plugin marketplace upgrade optimate-plugins --json",
      "codex plugin add make-fixer@optimate-plugins --json",
    ]);
  });
});
