// Copies this repo's skills into the optimate-plugins make-fixer plugin, which is how Claude Code and Codex
// install them. This repo is the only source of truth: never edit the plugin's copy directly.
//
//   bun scripts/sync-plugin-skills.ts [--plugins <optimate-plugins checkout>] [--check]
//
// --check exits 1 when the plugin's copy differs, without writing anything.
// Plugin-only files (agents/openai.yaml, Codex UI metadata) are kept.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

const SKILLS = ["make-fixer", "make-execution-data"];
const PLUGIN_ONLY = new Set(["agents"]);

const args = process.argv.slice(2);
const check = args.includes("--check");
const pluginsIdx = args.indexOf("--plugins");
const pluginsRoot =
  pluginsIdx >= 0 ? args[pluginsIdx + 1]! : join(homedir(), "Developer", "optimate-plugins");
const repoSkills = join(import.meta.dir, "..", "skills");
const pluginSkills = join(pluginsRoot, "plugins", "make-fixer", "skills");

if (!existsSync(pluginSkills)) {
  console.error(`Plugin skills folder not found: ${pluginSkills}\nPass --plugins <optimate-plugins checkout>.`);
  process.exit(2);
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((p) => !p.split(/[\\/]/).some((part) => PLUGIN_ONLY.has(part) || part === ".DS_Store"))
    .filter((p) => statSync(join(dir, p)).isFile())
    .sort();
}

const drift: string[] = [];
for (const skill of SKILLS) {
  const src = join(repoSkills, skill);
  const dst = join(pluginSkills, skill);
  const srcFiles = files(src);
  const dstFiles = files(dst);
  for (const f of new Set([...srcFiles, ...dstFiles])) {
    const a = join(src, f);
    const b = join(dst, f);
    if (!existsSync(a)) drift.push(`extra in plugin: ${skill}/${f}`);
    else if (!existsSync(b)) drift.push(`missing in plugin: ${skill}/${f}`);
    else if (!readFileSync(a).equals(readFileSync(b))) drift.push(`differs: ${skill}/${f}`);
  }
  if (check) continue;
  for (const f of dstFiles) if (!srcFiles.includes(f)) rmSync(join(dst, f));
  for (const f of srcFiles) cpSync(join(src, f), join(dst, f));
}

if (drift.length === 0) {
  console.log("Plugin skills match this repo.");
} else if (check) {
  console.error(`Plugin skills are out of date (${relative(process.cwd(), pluginSkills)}):`);
  for (const d of drift) console.error(`  ${d}`);
  console.error("Run: bun run sync-skills, then bump the plugin version and open a PR in optimate-plugins.");
  process.exit(1);
} else {
  for (const d of drift) console.log(`  synced ${d}`);
  console.log("Now bump the plugin version (plugin.json + marketplace.json) and open a PR in optimate-plugins.");
}
