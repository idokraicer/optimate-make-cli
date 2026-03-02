#!/usr/bin/env bun

import { Command } from "commander";
import { MakeApiClient } from "./make-api/client";
import { BlueprintSchema, type Blueprint } from "./make-api/types";
import { BUILTIN_MODULE_TEMPLATES } from "./data/builtin-modules";
import { analyze } from "./analyzer/index";
import { filterDataFlow } from "./analyzer/checks/data-flow";
import { applyFixes } from "./fixer/index";
import { formatReport, formatJson } from "./reporter/index";
import { diffBlueprints } from "./agent/blueprint-editor";
import { walkModules } from "./utils/blueprint-traversal";
import { getModuleCustomName, hasErrorHandler, getMaxModuleId } from "./utils/module-helpers";
import { findModuleById, extractInterface, buildResumeModule } from "./utils/resume-builder";

const BLUEPRINTS_DIR = "blueprints";
const GLOBAL_CONFIG_DIR = `${process.env.HOME}/.make-fixer`;
const GLOBAL_ENV_PATH = `${GLOBAL_CONFIG_DIR}/.env`;

const program = new Command();

program
  .name("make-fixer")
  .description("Analyze and auto-fix Make.com scenario blueprints")
  .version("0.1.0");

// --- login command ---
program
  .command("login")
  .description("Save your Make.com API token to ~/.make-fixer/.env")
  .option("--token <token>", "API token (will prompt if not provided)")
  .option("--base-url <url>", "Make.com base URL (default: https://eu1.make.com)")
  .action(async (opts) => {
    let token = opts.token;

    if (!token) {
      process.stdout.write("Enter your Make.com API token: ");
      token = await new Promise<string>((resolve) => {
        process.stdin.once("data", (data) => resolve(data.toString().trim()));
        process.stdin.resume();
      });
    }

    if (!token) {
      console.error("Error: No token provided.");
      process.exit(1);
    }

    await ensureDir(GLOBAL_CONFIG_DIR);
    const envFile = Bun.file(GLOBAL_ENV_PATH);
    let content = (await envFile.exists()) ? await envFile.text() : "";

    content = setEnvVar(content, "MAKE_API_TOKEN", token);
    if (opts.baseUrl) {
      content = setEnvVar(content, "MAKE_BASE_URL", opts.baseUrl);
    }

    await Bun.write(GLOBAL_ENV_PATH, content);
    console.log(`Saved API token to ${GLOBAL_ENV_PATH}`);
  });

// --- fetch command ---
program
  .command("fetch")
  .description("Fetch a scenario blueprint and save it locally for editing")
  .requiredOption("-s, --scenario <id>", "Make.com scenario ID or URL")
  .action(async (opts) => {
    const { scenarioId, baseUrl } = parseScenarioInput(opts.scenario);
    const client = await createClient(baseUrl);
    console.log(`Fetching scenario ${scenarioId}...`);

    const { blueprint } = await client.fetchBlueprint(scenarioId);

    await ensureDir(BLUEPRINTS_DIR);
    const filePath = `${BLUEPRINTS_DIR}/${scenarioId}.json`;
    await Bun.write(filePath, JSON.stringify(blueprint, null, 2));

    console.log(`Saved to ${filePath}`);
    console.log("");
    printBlueprintSummary(blueprint);
  });

// --- analyze command ---
program
  .command("analyze")
  .description("Analyze a scenario for quality issues (no changes made)")
  .requiredOption("-s, --scenario <id>", "Make.com scenario ID or URL")
  .option("--json", "Output as JSON instead of formatted report")
  .option("--var <name>", "Filter data flow to a specific variable name")
  .option("--local", "Analyze the local file instead of fetching from API")
  .action(async (opts) => {
    const { scenarioId, baseUrl } = parseScenarioInput(opts.scenario);
    let blueprint: Blueprint;
    let notes: any[] = [];

    if (opts.local) {
      blueprint = await readLocalBlueprint(scenarioId);
    } else {
      const client = await createClient(baseUrl);
      console.log(`Fetching scenario ${scenarioId}...`);
      const fetched = await client.fetchBlueprint(scenarioId);
      blueprint = fetched.blueprint;
      notes = await client.fetchNotes(scenarioId);
    }

    const result = analyze(blueprint, notes);

    const dataFlow = opts.var
      ? filterDataFlow(result.dataFlow, opts.var)
      : result.dataFlow;

    if (opts.json) {
      console.log(formatJson([], result.issues, result.checklist, dataFlow));
    } else {
      console.log(formatReport([], result.issues, result.checklist, dataFlow));
    }
  });

// --- fix command ---
program
  .command("fix")
  .description("Analyze and auto-fix a scenario")
  .requiredOption("-s, --scenario <id>", "Make.com scenario ID or URL")
  .option("--dry-run", "Show what would change without pushing")
  .option("--only <types>", "Only fix these issue types (comma-separated)")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const { scenarioId, baseUrl } = parseScenarioInput(opts.scenario);
    const client = await createClient(baseUrl);
    console.log(`Fetching scenario ${scenarioId}...`);

    const { blueprint } = await client.fetchBlueprint(scenarioId);
    const notes = await client.fetchNotes(scenarioId);

    console.log("Analyzing...");
    const result = analyze(blueprint, notes);

    const autoFixable = result.issues.filter((i) => i.autoFixable);
    const reportOnly = result.issues.filter((i) => !i.autoFixable);

    if (autoFixable.length === 0) {
      console.log("No auto-fixable issues found.");
      if (reportOnly.length > 0) {
        console.log(formatReport([], reportOnly, result.checklist));
      }
      return;
    }

    console.log(`Found ${autoFixable.length} auto-fixable issue(s). Applying fixes...`);

    const only = opts.only?.split(",");
    const { fixed, changes } = await applyFixes(blueprint, autoFixable, { only });

    console.log(formatReport(changes, reportOnly, result.checklist, result.dataFlow));

    if (opts.dryRun) {
      console.log("\n--dry-run: No changes pushed to Make.com.");
      return;
    }

    if (changes.length > 0) {
      process.stdout.write(`\nPush ${changes.length} fix(es) to Make.com? [y/N] `);
      const answer = await new Promise<string>((resolve) => {
        process.stdin.once("data", (data) => {
          resolve(data.toString().trim());
        });
        process.stdin.resume();
      });
      if (answer.toLowerCase() !== "y") {
        console.log("Aborted.");
        return;
      }

      console.log("Pushing fixed blueprint...");
      await client.pushBlueprint(scenarioId, fixed);
      console.log("Done! Blueprint updated successfully.");
    }
  });

// --- validate command ---
program
  .command("validate")
  .description("Compare local blueprint file against the remote version")
  .requiredOption("-s, --scenario <id>", "Make.com scenario ID or URL")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const { scenarioId, baseUrl } = parseScenarioInput(opts.scenario);
    const client = await createClient(baseUrl);
    const local = await readLocalBlueprint(scenarioId);

    console.log(`Fetching remote scenario ${scenarioId}...`);
    const { blueprint: remote } = await client.fetchBlueprint(scenarioId);

    const diff = diffBlueprints(remote, local);
    const remoteAnalysis = analyze(remote, []);
    const localAnalysis = analyze(local, []);

    const result = {
      ...diff,
      issuesBefore: remoteAnalysis.issues.length,
      issuesAfter: localAnalysis.issues.length,
      nextId: getMaxModuleId(local.flow) + 1,
    };

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log("");
    console.log("Validation Results:");
    console.log(`  Name changed: ${diff.nameChanged ? `yes ("${remote.name}" → "${local.name}")` : "no"}`);
    console.log(`  Modules added: ${diff.modulesAdded.length > 0 ? diff.modulesAdded.map(id => `#${id}`).join(", ") : "none"}`);
    console.log(`  Modules removed: ${diff.modulesRemoved.length > 0 ? diff.modulesRemoved.map(id => `#${id}`).join(", ") : "none"}`);
    console.log(`  Modules modified: ${diff.modulesModified.length > 0 ? diff.modulesModified.map(id => `#${id}`).join(", ") : "none"}`);
    console.log(`  Duplicate IDs: ${diff.duplicateIds.length > 0 ? diff.duplicateIds.join(", ") : "none"}`);
    console.log(`  IDs preserved: ${diff.idsPreserved ? "yes" : "NO — some original modules were removed"}`);
    console.log(`  Issues: ${result.issuesBefore} (remote) → ${result.issuesAfter} (local)`);
    console.log(`  Next available ID: ${result.nextId}`);
    console.log("");
  });

// --- push command ---
program
  .command("push")
  .description("Push a local blueprint file to Make.com")
  .requiredOption("-s, --scenario <id>", "Make.com scenario ID or URL")
  .option("--yes", "Skip confirmation prompt")
  .action(async (opts) => {
    const { scenarioId, baseUrl } = parseScenarioInput(opts.scenario);
    const client = await createClient(baseUrl);
    const local = await readLocalBlueprint(scenarioId);

    if (!opts.yes) {
      const modules = walkModules(local.flow);
      console.log(`About to push blueprint "${local.name}" (${modules.length} modules) to scenario ${scenarioId}.`);
      process.stdout.write("Continue? [y/N] ");
      const answer = await new Promise<string>((resolve) => {
        process.stdin.once("data", (data) => {
          resolve(data.toString().trim());
        });
        process.stdin.resume();
      });
      if (answer.toLowerCase() !== "y") {
        console.log("Aborted.");
        return;
      }
    }

    console.log("Pushing blueprint...");
    await client.pushBlueprint(scenarioId, local);
    console.log("Done! Blueprint updated successfully.");
  });

// --- resume command ---
program
  .command("resume")
  .description("Generate a builtin:Resume module JSON for the 429 retry pattern")
  .requiredOption("-s, --scenario <id>", "Make.com scenario ID or URL (reads local blueprint)")
  .requiredOption("--errored <id>", "ID of the module that can fail (provides interface fields)", parseInt)
  .requiredOption("--from <id>", "ID of the retry clone module (fields will be mapped from this module)", parseInt)
  .option("--id <id>", "ID to assign to the Resume module (default: next available ID)", parseInt)
  .option("--x <n>", "Designer x position", parseInt)
  .option("--y <n>", "Designer y position", parseInt)
  .action(async (opts) => {
    const { scenarioId } = parseScenarioInput(opts.scenario);
    const local = await readLocalBlueprint(scenarioId);

    // Find the errored module
    const erroredModule = findModuleById(local.flow, opts.errored);
    if (!erroredModule) {
      console.error(`Error: Module #${opts.errored} not found in blueprint ${scenarioId}.`);
      console.error(`Run: make-fixer fetch -s ${scenarioId}`);
      process.exit(1);
    }

    // Resolve Resume module ID
    const maxId = getMaxModuleId(local.flow);
    const resumeId: number = opts.id ?? maxId + 1;

    // Determine position
    const x: number = opts.x ?? 0;
    const y: number = opts.y ?? 0;

    // Check interface
    const iface = extractInterface(erroredModule);
    if (!iface) {
      console.warn(
        `Warning: Module #${opts.errored} (${erroredModule.module}) has no interface defined in its metadata.`
      );
      console.warn(
        `The Resume mapper will be empty. You may need to add field mappings manually.`
      );
      console.warn(
        `Tip: Fetch a fresh copy of the blueprint after the scenario has run at least once — Make.com populates the interface after execution.`
      );
    } else {
      console.error(`Found ${iface.length} interface field(s) on module #${opts.errored} (${erroredModule.module})`);
      console.error(`Mapping from retry module #${opts.from} → Resume module #${resumeId}\n`);
    }

    const resumeModule = buildResumeModule(erroredModule, opts.from, resumeId, { x, y });

    console.log(JSON.stringify(resumeModule, null, 2));
  });

// --- notes command ---
program
  .command("notes")
  .description("List or add notes on a Make.com scenario")
  .requiredOption("-s, --scenario <id>", "Make.com scenario ID or URL")
  .option("--add", "Create a new note (requires --module and --content)")
  .option("--module <ids>", "Comma-separated module IDs for the note")
  .option("--content <text>", "Note content (supports HTML, e.g. <br> for line breaks)")
  .action(async (opts) => {
    const { scenarioId, baseUrl } = parseScenarioInput(opts.scenario);
    const client = await createClient(baseUrl);

    if (opts.add) {
      if (!opts.module || !opts.content) {
        console.error("Error: --add requires both --module and --content.");
        process.exit(1);
      }
      const moduleIds = opts.module.split(",").map((s: string) => parseInt(s.trim(), 10));
      const note = await client.createNote(scenarioId, moduleIds, opts.content);
      console.log(`Created note #${note.id} on module(s) ${moduleIds.map((id: number) => `#${id}`).join(", ")}`);
      return;
    }

    // List notes
    const notes = await client.fetchNotes(scenarioId);
    if (notes.length === 0) {
      console.log(`No notes found for scenario ${scenarioId}.`);
      return;
    }

    console.log(`\nNotes for scenario ${scenarioId} (${notes.length} note${notes.length !== 1 ? "s" : ""}):\n`);
    for (const note of notes) {
      const modules = note.moduleIds.map((id) => `#${id}`).join(", ");
      const author = note.createdByUser?.name || note.createdByUser?.email || "";
      const authorStr = author ? ` (by ${author})` : "";
      const content = note.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const preview = content.length > 100 ? content.slice(0, 100) + "..." : content;
      console.log(`  Note #${note.id} → Modules: ${modules}${authorStr}`);
      console.log(`    ${preview}`);
      console.log("");
    }
  });

// --- apps command ---
program
  .command("apps")
  .description("Search Make.com app catalog")
  .argument("[query]", "Search query (filters by name, label, or keywords)")
  .option("--limit <n>", "Maximum results to show", parseInt, 20)
  .action(async (query, opts) => {
    const client = await createClient();
    console.log("Fetching app catalog...");

    const apps = query
      ? await client.searchApps(query)
      : await client.fetchApps();

    const display = apps.slice(0, opts.limit);

    console.log(`\nFound ${apps.length} app(s)${query ? ` matching "${query}"` : ""}${apps.length > opts.limit ? ` (showing first ${opts.limit})` : ""}:\n`);

    for (const app of display) {
      const tags = [
        app.isPrivate ? "private" : null,
        app.premiumTier > 0 ? `premium:${app.premiumTier}` : null,
      ].filter(Boolean);
      const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
      console.log(`  ${app.name} (v${app.version}) - ${app.label}${tagStr}`);
    }
    console.log("");
  });

// --- modules command ---
program
  .command("modules")
  .description("List modules for a Make.com app")
  .argument("<app-name>", "App name/slug (e.g. google-sheets, monday)")
  .option("--version <n>", "App version (auto-detected if omitted)", parseInt)
  .action(async (appName, opts) => {
    const client = await createClient();

    let version = opts.version;
    if (!version) {
      const apps = await client.searchApps(appName);
      const exact = apps.find((a) => a.name === appName);
      if (!exact) {
        console.error(`App "${appName}" not found. Try: make-fixer apps ${appName}`);
        process.exit(1);
      }
      version = exact.version;
    }

    console.log(`Fetching modules for ${appName} v${version}...\n`);
    const modules = await client.fetchAppModules(appName, version);

    console.log(`${appName} — ${modules.length} module(s):\n`);
    for (const mod of modules) {
      const hookStr = mod.hook ? " [webhook]" : "";
      console.log(`  ${mod.name.padEnd(45)} ${mod.label}${hookStr}`);

      const template = BUILTIN_MODULE_TEMPLATES[mod.id];
      if (template) {
        if (template.mapper != null) {
          console.log(`    mapper: ${JSON.stringify(template.mapper)}`);
        }
        if (template.parameters) {
          console.log(`    parameters: ${JSON.stringify(template.parameters)}`);
        }
      }
    }
    console.log("");
  });

// --- helpers ---

function parseScenarioInput(input: string): { scenarioId: number; baseUrl?: string } {
  // Try parsing as a Make.com URL first
  const urlMatch = input.match(
    /^https?:\/\/((?:eu|us)\d+\.make\.com)\/\d+\/scenarios\/(\d+)/
  );
  if (urlMatch) {
    return {
      scenarioId: parseInt(urlMatch[2], 10),
      baseUrl: `https://${urlMatch[1]}`,
    };
  }

  // Otherwise treat as a bare scenario ID
  const id = parseInt(input, 10);
  if (isNaN(id)) {
    console.error(`Error: "${input}" is not a valid scenario ID or Make.com URL.`);
    process.exit(1);
  }
  return { scenarioId: id };
}

function setEnvVar(content: string, key: string, value: string): string {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }
  return content + (content.length > 0 && !content.endsWith("\n") ? "\n" : "") + line + "\n";
}

async function loadGlobalEnv(): Promise<Record<string, string>> {
  const file = Bun.file(GLOBAL_ENV_PATH);
  if (!(await file.exists())) return {};
  const vars: Record<string, string> = {};
  for (const line of (await file.text()).split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

async function createClient(baseUrlOverride?: string): Promise<MakeApiClient> {
  const globalEnv = await loadGlobalEnv();
  const token = process.env.MAKE_API_TOKEN || globalEnv.MAKE_API_TOKEN;
  const baseUrl = baseUrlOverride || process.env.MAKE_BASE_URL || globalEnv.MAKE_BASE_URL || "https://eu1.make.com";

  if (!token) {
    console.error("Error: MAKE_API_TOKEN not found.");
    console.error("Run: make-fixer login --token <your-token>");
    process.exit(1);
  }

  return new MakeApiClient({ token, baseUrl });
}

async function ensureDir(dir: string): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.mkdir(dir, { recursive: true });
}

async function readLocalBlueprint(scenarioId: number): Promise<Blueprint> {
  const filePath = `${BLUEPRINTS_DIR}/${scenarioId}.json`;
  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    console.error(`Error: Local blueprint not found at ${filePath}`);
    console.error(`Run: make-fixer fetch -s ${scenarioId}`);
    process.exit(1);
  }

  const raw = await file.json();
  return BlueprintSchema.parse(raw);
}

function printBlueprintSummary(blueprint: Blueprint): void {
  const modules = walkModules(blueprint.flow);
  const maxId = getMaxModuleId(blueprint.flow);

  console.log(`Scenario: "${blueprint.name}"`);
  console.log(`Modules: ${modules.length} | Next ID: ${maxId + 1}`);
  console.log("");

  for (const m of modules) {
    const name = getModuleCustomName(m.module);
    const errHandler = hasErrorHandler(m.module) ? " [err: ✓]" : "";
    const nameStr = name ? ` "${name}"` : "";
    const indent = "  ".repeat(m.depth);
    console.log(`  ${indent}#${m.module.id}: ${m.module.module}${nameStr}${errHandler}`);
  }
  console.log("");
}

program.parse();
