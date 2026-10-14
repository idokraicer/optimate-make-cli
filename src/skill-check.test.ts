import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import {
  checkSkills,
  defaultRunner,
  fixSkillInstalls,
  formatSkillWarning,
  skillFingerprint,
  spawnCommand,
} from "./skill-check";

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

  test("ignores CRLF vs LF line endings (Git on Windows)", () => {
    const a = join(root, "a");
    const b = join(root, "b");
    writeSkill(a, "line1\nline2\n");
    writeSkill(b, "line1\r\nline2\r\n");
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
    symlinkSync(join(bundled, "make-fixer"), join(home, ".codex", "skills", "make-fixer"), "junction");
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

  test("honors CLAUDE_CONFIG_DIR and CODEX_HOME", () => {
    writeSkill(join(root, "claude-cfg", "skills", "make-fixer"), "old");
    writeSkill(join(root, "codex-cfg", "skills", "make-fixer"), "old");
    const env = { CLAUDE_CONFIG_DIR: join(root, "claude-cfg"), CODEX_HOME: join(root, "codex-cfg") };
    expect(check(env).issues).toHaveLength(2);
  });

  test("a ~/.agents copy doesn't count as a Claude Code skill", () => {
    writeSkill(join(home, ".agents", "skills", "make-fixer"), "current", { "references/debugging.md": "bundles" });
    expect(check({ CLAUDECODE: "1" }).claudeCodeHasNoSkill).toBe(true);
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

describe("fixSkillInstalls", () => {
  type Call = string;
  function fake(responses: Record<string, { ok?: boolean; out?: string }> = {}) {
    const calls: Call[] = [];
    const logs: string[] = [];
    return {
      calls,
      logs,
      opts: {
        home,
        cwd: project,
        now: () => new Date("2026-10-13T00:00:00Z"),
        which: (bin: string) => bin,
        run: (cmd: string[]) => {
          const key = cmd.join(" ");
          calls.push(key);
          const hit = Object.entries(responses).find(([k]) => key.startsWith(k))?.[1];
          return { ok: hit?.ok ?? true, out: hit?.out ?? "" };
        },
        log: (m: string) => void logs.push(m),
      },
    };
  }
  const codexHasMarketplace = { out: JSON.stringify({ marketplaces: [{ name: "optimate-plugins" }] }) };

  test("installs at user scope in Claude Code and installs/updates in Codex", () => {
    const f = fake({
      "claude plugin marketplace list": { out: "optimate-plugins" },
      "codex plugin marketplace list": codexHasMarketplace,
    });
    fixSkillInstalls(f.opts);
    expect(f.calls).toEqual([
      "claude plugin marketplace list",
      "claude plugin marketplace update optimate-plugins",
      "claude plugin install make-fixer@optimate-plugins --scope user",
      "codex plugin marketplace list --json",
      "codex plugin marketplace upgrade optimate-plugins --json",
      "codex plugin add make-fixer@optimate-plugins --json",
    ]);
  });

  test("updates existing installs and adds missing marketplaces", () => {
    installClaudePlugin("1.0.7", { scope: "user" }, { "make-fixer": "old" });
    const f = fake({ "codex plugin marketplace list": { out: JSON.stringify({ marketplaces: [] }) } });
    fixSkillInstalls(f.opts);
    expect(f.calls).toContain("claude plugin marketplace add idokraicer/optimate-plugins");
    expect(f.calls).toContain("claude plugin update make-fixer@optimate-plugins --scope user");
    expect(f.calls).toContain("codex plugin marketplace add idokraicer/optimate-plugins");
  });

  test("moves personal copies aside and removes symlinks once the plugin is installed", () => {
    writeSkill(join(home, ".claude", "skills", "make-fixer"), "old");
    mkdirSync(join(home, ".codex", "skills"), { recursive: true });
    symlinkSync(join(bundled, "make-fixer"), join(home, ".codex", "skills", "make-fixer"), "junction");
    writeSkill(join(home, ".agents", "skills", "make-execution-data"), "old");
    fixSkillInstalls(fake({ "codex plugin marketplace list": codexHasMarketplace }).opts);
    expect(existsSync(join(home, ".claude", "skills", "make-fixer"))).toBe(false);
    expect(existsSync(join(home, ".codex", "skills", "make-fixer"))).toBe(false);
    expect(existsSync(join(home, ".agents", "skills", "make-execution-data"))).toBe(false);
    const backups = join(home, ".make-fixer", "skill-backups", "2026-10-13T00-00-00-000Z");
    expect(readFileSync(join(backups, "claude", "make-fixer", "SKILL.md"), "utf8")).toBe("old");
    expect(existsSync(join(backups, "agents", "make-execution-data", "SKILL.md"))).toBe(true);
    expect(existsSync(join(bundled, "make-fixer", "SKILL.md"))).toBe(true); // symlink target untouched
  });

  test("keeps personal copies when the plugin install fails", () => {
    writeSkill(join(home, ".claude", "skills", "make-fixer"), "old");
    writeSkill(join(home, ".codex", "skills", "make-fixer"), "old");
    const f = fake({
      "claude plugin install": { ok: false, out: "network down" },
      "codex plugin add": { ok: false, out: "network down" },
      "codex plugin marketplace list": codexHasMarketplace,
    });
    fixSkillInstalls(f.opts);
    expect(existsSync(join(home, ".claude", "skills", "make-fixer"))).toBe(true);
    expect(existsSync(join(home, ".codex", "skills", "make-fixer"))).toBe(true);
    expect(f.logs.join("")).toContain("network down");
  });

  test("skips a host that is not on PATH", () => {
    const f = fake();
    fixSkillInstalls({ ...f.opts, which: (bin) => (bin === "codex" ? "codex" : null) });
    expect(f.calls.some((c) => c.startsWith("claude"))).toBe(false);
    expect(f.logs.join("")).toContain("claude) not on PATH");
  });
});

describe("spawning claude/codex", () => {
  test("Windows .cmd shims run through cmd.exe; everything else runs directly", () => {
    const shim = "C:\\Program Files\\nodejs\\claude.cmd";
    expect(spawnCommand([shim, "plugin", "list"], "win32")).toEqual({
      argv: ["cmd.exe", "/d", "/s", "/c", `""${shim}" plugin list"`],
      verbatim: true,
    });
    expect(spawnCommand(["C:\\bin\\claude.exe", "plugin"], "win32").verbatim).toBe(false);
    expect(spawnCommand(["/usr/local/bin/claude", "plugin"], "darwin")).toEqual({
      argv: ["/usr/local/bin/claude", "plugin"],
      verbatim: false,
    });
  });

  test("the real runner passes arguments to a shim on this OS (folder with a space)", () => {
    const dir = join(root, "bin dir");
    mkdirSync(dir, { recursive: true });
    let bin: string;
    if (process.platform === "win32") {
      bin = join(dir, "fake-claude.cmd");
      writeFileSync(bin, "@echo off\r\necho args:%*\r\n");
    } else {
      bin = join(dir, "fake-claude");
      writeFileSync(bin, '#!/bin/sh\necho "args:$*"\n');
      chmodSync(bin, 0o755);
    }
    const r = defaultRunner([bin, "plugin", "update", "make-fixer@optimate-plugins", "--scope", "user"]);
    expect(r.ok).toBe(true);
    expect(r.out.trim()).toBe("args:plugin update make-fixer@optimate-plugins --scope user");
  });

  test("fixSkillInstalls passes its env to the spawned CLIs (Bun ignores later process.env changes)", () => {
    const seen: (string | undefined)[] = [];
    fixSkillInstalls({
      home,
      cwd: project,
      env: { CLAUDE_CONFIG_DIR: "/custom/claude" },
      which: (bin) => (bin === "claude" ? "claude" : null),
      run: (_cmd, env) => (seen.push(env?.CLAUDE_CONFIG_DIR), { ok: true, out: "" }),
      log: () => {},
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => v === "/custom/claude")).toBe(true);
  });
});
