import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { compareSemver } from "./updater";

// The skills an agent uses to drive this CLI ship in the same repo (`skills/`). Agents load them from
// elsewhere — the optimate-plugins plugin, or hand-copied folders — and those copies go stale. A stale skill
// doesn't know about newer commands and flags (that is how `executions --bundles` went unused), so every
// command compares each copy an agent could load against the skills bundled with this CLI and, when one
// differs, tells the agent to warn the user.

export const SKILL_NAMES = ["make-fixer", "make-execution-data"] as const;

/** Plugin-only files (Codex UI metadata) that the sync script never copies. */
const IGNORED_PARTS = new Set(["agents", ".DS_Store"]);

const PKG_ROOT = dirname(import.meta.dir);

/** Claude Code's config dir (`CLAUDE_CONFIG_DIR`, default ~/.claude). */
function claudeDir(home: string, env: Record<string, string | undefined>): string {
  return env.CLAUDE_CONFIG_DIR || join(home, ".claude");
}

/** Codex's config dir (`CODEX_HOME`, default ~/.codex). */
function codexDir(home: string, env: Record<string, string | undefined>): string {
  return env.CODEX_HOME || join(home, ".codex");
}
const BUNDLED_SKILLS_DIR = join(PKG_ROOT, "skills");

export type SkillSourceKind = "personal" | "project" | "claude-plugin" | "codex-plugin";

export interface SkillSource {
  kind: SkillSourceKind;
  /** Human-readable name, e.g. "Claude Code plugin make-fixer@optimate-plugins 1.0.7 (user)". */
  label: string;
  /** Folder that holds `<skill-name>/SKILL.md` folders. */
  skillsDir: string;
}

export interface SkillIssue {
  source: SkillSource;
  skill: string;
  problem: "differs" | "missing";
}

export interface SkillCheckResult {
  issues: SkillIssue[];
  /** True when Claude Code is running this CLI and no make-fixer skill applies to the current directory. */
  claudeCodeHasNoSkill: boolean;
}

/** sha256 over a skill folder's files (path + content), or null when it has no SKILL.md. */
export function skillFingerprint(dir: string): string | null {
  if (!existsSync(join(dir, "SKILL.md"))) return null;
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((p) => !p.split(/[\\/]/).some((part) => IGNORED_PARTS.has(part)))
    .filter((p) => statSync(join(dir, p)).isFile())
    .map((p) => p.split(sep).join("/"))
    .sort();
  const hash = createHash("sha256");
  for (const f of files) {
    // Git on Windows may check text out with CRLF; the same skill must hash the same everywhere.
    const content = readFileSync(join(dir, f)).toString("utf8").replace(/\r\n/g, "\n");
    hash.update(f).update("\0").update(content).update("\0");
  }
  return hash.digest("hex");
}

function isWithin(child: string, parent: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const rel = relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel));
}

interface InstalledPluginEntry {
  scope?: string;
  projectPath?: string;
  installPath?: string;
  version?: string;
}

/** Claude Code plugin installs of make-fixer that apply to `cwd` (user scope, or a project containing cwd). */
function claudePluginSources(home: string, cwd: string, env: Record<string, string | undefined>): SkillSource[] {
  const file = join(claudeDir(home, env), "plugins", "installed_plugins.json");
  if (!existsSync(file)) return [];
  let plugins: Record<string, InstalledPluginEntry[]>;
  try {
    plugins = JSON.parse(readFileSync(file, "utf8")).plugins ?? {};
  } catch {
    return [];
  }
  const sources: SkillSource[] = [];
  for (const [key, entries] of Object.entries(plugins)) {
    if (!key.startsWith("make-fixer@") || !Array.isArray(entries)) continue;
    for (const e of entries) {
      if (!e.installPath) continue;
      const applies = e.scope === "user" || (e.projectPath != null && isWithin(cwd, e.projectPath));
      if (!applies) continue;
      sources.push({
        kind: "claude-plugin",
        label: `Claude Code plugin ${key} ${e.version ?? "?"} (${e.scope ?? "?"} scope)`,
        skillsDir: join(e.installPath, "skills"),
      });
    }
  }
  return sources;
}

/** Newest cached Codex install of make-fixer per marketplace. */
function codexPluginSources(home: string, env: Record<string, string | undefined>): SkillSource[] {
  const cache = join(codexDir(home, env), "plugins", "cache");
  if (!existsSync(cache)) return [];
  const sources: SkillSource[] = [];
  for (const marketplace of readdirSync(cache)) {
    const pluginDir = join(cache, marketplace, "make-fixer");
    if (!existsSync(pluginDir)) continue;
    const versions = readdirSync(pluginDir).filter((v) => existsSync(join(pluginDir, v, "skills")));
    const newest = versions.sort(compareSemver).at(-1);
    if (!newest) continue;
    sources.push({
      kind: "codex-plugin",
      label: `Codex plugin make-fixer@${marketplace} ${newest}`,
      skillsDir: join(pluginDir, newest, "skills"),
    });
  }
  return sources;
}

/** Hand-placed skill folders: personal (~/.claude, ~/.codex, ~/.agents) and project (cwd up to home or root). */
function folderSources(home: string, cwd: string, env: Record<string, string | undefined>): SkillSource[] {
  const sources: SkillSource[] = personalSkillDirs(home, env).map(({ label, dir }) => ({
    kind: "personal" as const,
    label,
    skillsDir: dir,
  }));
  let dir = resolve(cwd);
  while (dir !== resolve(home)) {
    for (const tool of [".claude", ".agents"]) {
      sources.push({ kind: "project", label: join(dir, tool, "skills"), skillsDir: join(dir, tool, "skills") });
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return sources;
}

/** Personal skill folders per host: Claude Code reads its own; Codex reads its own and ~/.agents. */
function personalSkillDirs(home: string, env: Record<string, string | undefined>, hosts = ["claude", "codex"]) {
  const dirs: { host: string; label: string; dir: string }[] = [];
  if (hosts.includes("claude")) dirs.push({ host: "claude", label: "~/.claude/skills", dir: join(claudeDir(home, env), "skills") });
  if (hosts.includes("codex")) {
    dirs.push({ host: "codex", label: "~/.codex/skills", dir: join(codexDir(home, env), "skills") });
    dirs.push({ host: "agents", label: "~/.agents/skills", dir: join(home, ".agents", "skills") });
  }
  return dirs;
}

export function checkSkills(opts: {
  bundledDir?: string;
  home?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}): SkillCheckResult {
  const bundledDir = opts.bundledDir ?? BUNDLED_SKILLS_DIR;
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  const bundled = new Map<string, string>();
  for (const name of SKILL_NAMES) {
    const fp = skillFingerprint(join(bundledDir, name));
    if (fp) bundled.set(name, fp);
  }
  // Without the bundled skills there is nothing to compare against.
  if (bundled.size === 0) return { issues: [], claudeCodeHasNoSkill: false };

  const claudePlugins = claudePluginSources(home, cwd, env);
  const sources = [...claudePlugins, ...codexPluginSources(home, env), ...folderSources(home, cwd, env)];

  const issues: SkillIssue[] = [];
  let claudeFolderCopy = false;
  for (const source of sources) {
    const isPlugin = source.kind === "claude-plugin" || source.kind === "codex-plugin";
    for (const [name, expected] of bundled) {
      const dir = join(source.skillsDir, name);
      const actual = skillFingerprint(dir);
      if (actual == null) {
        if (isPlugin) issues.push({ source, skill: name, problem: "missing" });
        continue;
      }
      const readByClaude = source.label === "~/.claude/skills" || source.label.endsWith(join(".claude", "skills"));
      if (name === "make-fixer" && !isPlugin && readByClaude) claudeFolderCopy = true;
      if (actual !== expected) issues.push({ source, skill: name, problem: "differs" });
    }
  }

  const inClaudeCode = env.CLAUDECODE === "1";
  return { issues, claudeCodeHasNoSkill: inClaudeCode && claudePlugins.length === 0 && !claudeFolderCopy };
}

export function formatSkillWarning(result: SkillCheckResult, cliVersion: string): string {
  const lines = [`⚠ make-fixer ${cliVersion}: the make-fixer skill an AI agent loads is out of sync with this CLI.`];
  for (const issue of result.issues) {
    const what = issue.problem === "missing" ? "is missing" : "differs";
    let note = "";
    if (issue.source.kind === "personal") note = " — a personal copy; it overrides the plugin and never updates. Delete it.";
    else if (issue.source.kind === "project") note = " — a project copy; update or delete it.";
    lines.push(`  • ${issue.source.label}: ${issue.skill} ${what}${note}`);
  }
  if (result.claudeCodeHasNoSkill) {
    lines.push(
      "  • Claude Code has no make-fixer skill for this directory. Install it for every project:",
      "      claude plugin install make-fixer@optimate-plugins --scope user",
    );
  }
  lines.push(
    "  Fix: make-fixer update   (updates the CLI and installs/updates the plugin in Claude Code and Codex)",
    "  If this persists after `make-fixer update`, the published plugin is behind this CLI: a maintainer runs",
    "  `bun run sync-skills` in the make-fixer repo and releases the plugin in optimate-plugins.",
    "  NOTE FOR AI AGENTS: the make-fixer skill you loaded may be outdated or missing and may not know this",
    "  CLI's current commands and flags. Tell the user about this warning before you continue, and confirm",
    "  commands with `make-fixer <command> --help` rather than relying on the skill alone.",
    "  (Silence with MAKE_FIXER_SKIP_SKILL_CHECK=1.)",
  );
  return lines.join("\n") + "\n";
}

/** Best-effort: never throws, prints to stderr so --json stdout stays clean. */
export function warnIfSkillsOutdated(cliVersion: string): void {
  if (process.env.MAKE_FIXER_SKIP_SKILL_CHECK === "1") return;
  try {
    const result = checkSkills({});
    if (result.issues.length > 0 || result.claudeCodeHasNoSkill) {
      process.stderr.write(formatSkillWarning(result, cliVersion));
    }
  } catch {
    // A broken skill folder must never stop the CLI.
  }
}

/** `out` is stdout + stderr for messages; parse JSON from `stdout` only (CLIs print warnings on stderr). */
type Runner = (
  cmd: string[],
  env?: Record<string, string | undefined>,
) => { ok: boolean; out: string; stdout?: string };

/**
 * npm installs `claude`/`codex` on Windows as .cmd shims, which can't be spawned directly; run them through
 * cmd.exe. Arguments here are fixed tokens (no quotes or metacharacters), so verbatim joining is safe.
 */
export function spawnCommand(cmd: string[], platform: string = process.platform): { argv: string[]; verbatim: boolean } {
  const [bin, ...args] = cmd;
  if (platform === "win32" && bin && /\.(cmd|bat)$/i.test(bin)) {
    return { argv: ["cmd.exe", "/d", "/s", "/c", `""${bin}" ${args.join(" ")}"`], verbatim: true };
  }
  return { argv: cmd, verbatim: false };
}

export const defaultRunner: Runner = (cmd, env = process.env) => {
  try {
    const { argv, verbatim } = spawnCommand(cmd);
    const proc = Bun.spawnSync(argv, {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 180_000,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      // Pass env explicitly: without it Bun spawns with the environment from process start, ignoring later
      // process.env changes (e.g. CLAUDE_CONFIG_DIR / CODEX_HOME).
      env,
    });
    const stdout = proc.stdout.toString();
    return { ok: proc.exitCode === 0, out: `${stdout}${proc.stderr.toString()}`.trim(), stdout };
  } catch (e) {
    return { ok: false, out: String(e) };
  }
};

const MARKETPLACE = "optimate-plugins";
const MARKETPLACE_SOURCE = "idokraicer/optimate-plugins";
const PLUGIN = `make-fixer@${MARKETPLACE}`;

export interface SkillFixOptions {
  home?: string;
  cwd?: string;
  which?: (bin: string) => string | null;
  run?: Runner;
  log?: (msg: string) => void;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  /** Where to add the marketplace from when it's missing (default: the optimate-plugins GitHub repo). */
  marketplaceSource?: string;
}

/** The lines that explain a failure: progress chatter and warnings first, the actual error last. */
function errorText(out: string): string {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const errors = lines.filter((l) => /error|fail|not found|denied|refus/i.test(l) && !/^warning:/i.test(l));
  return (errors.length > 0 ? errors : lines).slice(-3).join(" | ") || "unknown error";
}

/**
 * Move hand-placed personal copies of the skills out of the way once the host's plugin provides them: a
 * personal copy overrides the plugin and never updates. Folders go to ~/.make-fixer/skill-backups; symlinks
 * are just removed.
 */
function removePersonalCopies(
  dirs: { host: string; label: string; dir: string }[],
  backupRoot: string,
  log: (m: string) => void,
) {
  for (const { host, label, dir } of dirs) {
    for (const name of SKILL_NAMES) {
      const path = join(dir, name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      try {
        if (stat.isSymbolicLink()) {
          // A directory symlink or junction on Windows needs rmdir; unlink works elsewhere.
          try {
            unlinkSync(path);
          } catch {
            rmdirSync(path);
          }
          log(`  removed symlink ${label}/${name} (the plugin provides it)\n`);
        } else {
          const dest = join(backupRoot, host, name);
          mkdirSync(dirname(dest), { recursive: true });
          renameSync(path, dest);
          log(`  moved personal copy ${label}/${name} → ${dest}\n`);
        }
      } catch (e) {
        log(`⚠ could not remove ${label}/${name}: ${(e as Error).message}. Delete it by hand.\n`);
      }
    }
  }
}

/**
 * Part of `make-fixer update`: make Claude Code and Codex load the current make-fixer skills. For each host
 * on PATH it adds the optimate-plugins marketplace if needed, refreshes it, installs or updates the plugin
 * (user scope in Claude Code), and then removes personal copies that would override the plugin. Always
 * through the hosts' own plugin managers — never by copying skill files. Best-effort; logs to stderr.
 */
export function fixSkillInstalls(opts: SkillFixOptions = {}): void {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const which = opts.which ?? ((bin: string) => Bun.which(bin));
  const env = opts.env ?? process.env;
  const source = opts.marketplaceSource ?? MARKETPLACE_SOURCE;
  const runner = opts.run ?? defaultRunner;
  const run = (cmd: string[]) => runner(cmd, env);
  const log = opts.log ?? ((msg: string) => void process.stderr.write(msg));
  const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
  const backupRoot = join(home, ".make-fixer", "skill-backups", stamp);

  const claude = which("claude");
  if (claude) {
    if (!run([claude, "plugin", "marketplace", "list"]).out.includes(MARKETPLACE)) {
      run([claude, "plugin", "marketplace", "add", source]);
    }
    run([claude, "plugin", "marketplace", "update", MARKETPLACE]);
    const scopes = new Set(
      claudePluginSources(home, cwd, env)
        .filter((s) => s.label.includes(PLUGIN))
        .map((s) => /\((\w+) scope\)/.exec(s.label)?.[1])
        .filter((s): s is string => s != null),
    );
    // User scope makes the skill available in every project; update any narrower installs too.
    const user = scopes.has("user")
      ? run([claude, "plugin", "update", PLUGIN, "--scope", "user"])
      : run([claude, "plugin", "install", PLUGIN, "--scope", "user"]);
    log(user.ok
      ? `↻ Claude Code: ${PLUGIN} ${scopes.has("user") ? "updated" : "installed"} (user scope). Restart Claude Code to load it.\n`
      : `⚠ Claude Code: could not install/update ${PLUGIN}: ${errorText(user.out)}\n`);
    for (const scope of scopes) {
      if (scope === "user") continue;
      const r = run([claude, "plugin", "update", PLUGIN, "--scope", scope]);
      if (!r.ok) log(`⚠ Claude Code: could not update ${PLUGIN} (${scope} scope): ${errorText(r.out)}\n`);
    }
    if (user.ok) removePersonalCopies(personalSkillDirs(home, env, ["claude"]), backupRoot, log);
  } else {
    log("  Claude Code CLI (claude) not on PATH; skipped.\n");
  }

  const codex = which("codex");
  if (codex) {
    let hasMarketplace = false;
    try {
      const r = run([codex, "plugin", "marketplace", "list", "--json"]);
      const { marketplaces } = JSON.parse(r.stdout ?? r.out);
      hasMarketplace = (marketplaces ?? []).some((m: { name?: string }) => m.name === MARKETPLACE);
    } catch {
      // Unparseable output: try adding; Codex rejects duplicates harmlessly.
    }
    if (!hasMarketplace) run([codex, "plugin", "marketplace", "add", source]);
    run([codex, "plugin", "marketplace", "upgrade", MARKETPLACE, "--json"]);
    const r = run([codex, "plugin", "add", PLUGIN, "--json"]);
    log(r.ok ? `↻ Codex: ${PLUGIN} installed/updated. Restart Codex to load it.\n`
             : `⚠ Codex: could not install/update ${PLUGIN}: ${errorText(r.out)}\n`);
    if (r.ok) removePersonalCopies(personalSkillDirs(home, env, ["codex"]), backupRoot, log);
  } else {
    log("  Codex CLI (codex) not on PATH; skipped.\n");
  }
}
