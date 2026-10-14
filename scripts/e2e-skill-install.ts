// End-to-end check of `make-fixer update`'s skill fix against the REAL Claude Code and Codex CLIs, in
// throwaway config folders (CLAUDE_CONFIG_DIR / CODEX_HOME), so it never touches your own setup.
// CI runs it on Windows, macOS and Linux; on Windows npm installs both CLIs as .cmd shims.
//
//   bun scripts/e2e-skill-install.ts
//
// Needs `claude` and `codex` on PATH and network access to GitHub. Exits 1 on any failed check.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSkills, defaultRunner, fixSkillInstalls } from "../src/skill-check";

const root = mkdtempSync(join(tmpdir(), "mf-e2e-"));
const home = join(root, "home");
const claudeDir = join(root, "claude-config");
const codexDir = join(root, "codex-home");
for (const d of [home, claudeDir, codexDir]) mkdirSync(d, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.CODEX_HOME = codexDir;
const env = { ...process.env, CLAUDECODE: "1" };

// Stale personal copies, like the one that hid the plugin in the original incident.
for (const dir of [join(claudeDir, "skills", "make-fixer"), join(codexDir, "skills", "make-fixer")]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: make-fixer\ndescription: stale\n---\nstale\n");
}

const failures: string[] = [];
const ok = (cond: boolean, what: string) => {
  console.log(`${cond ? "✔" : "✘"} ${what}`);
  if (!cond) failures.push(what);
};

for (const bin of ["claude", "codex"]) {
  const path = Bun.which(bin);
  ok(path != null, `${bin} on PATH (${path ?? "missing"})`);
}

fixSkillInstalls({ home, cwd: home, env });

const installed = join(claudeDir, "plugins", "installed_plugins.json");
const claudeEntries = existsSync(installed)
  ? JSON.parse(readFileSync(installed, "utf8")).plugins?.["make-fixer@optimate-plugins"] ?? []
  : [];
ok(
  claudeEntries.some((e: { scope?: string }) => e.scope === "user"),
  "Claude Code: make-fixer@optimate-plugins installed at user scope",
);

const codexList = defaultRunner([Bun.which("codex") ?? "codex", "plugin", "list", "--json"]);
let codexInstalled = false;
try {
  codexInstalled = (JSON.parse(codexList.out).installed ?? []).some(
    (p: { pluginId?: string; installed?: boolean }) => p.pluginId === "make-fixer@optimate-plugins" && p.installed,
  );
} catch {
  console.log(codexList.out.slice(0, 500));
}
ok(codexInstalled, "Codex: make-fixer@optimate-plugins installed");

ok(!existsSync(join(claudeDir, "skills", "make-fixer")), "stale ~/.claude/skills copy moved aside");
ok(!existsSync(join(codexDir, "skills", "make-fixer")), "stale ~/.codex/skills copy moved aside");
const backups = join(home, ".make-fixer", "skill-backups");
ok(existsSync(backups), `backups kept in ${backups}`);

const result = checkSkills({ home, cwd: home, env });
ok(!result.claudeCodeHasNoSkill, "skill check sees the Claude Code plugin");
ok(
  result.issues.every((i) => i.source.kind === "claude-plugin" || i.source.kind === "codex-plugin"),
  "no personal or project copies left",
);
for (const i of result.issues) console.log(`  (info) ${i.source.label}: ${i.skill} ${i.problem}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
