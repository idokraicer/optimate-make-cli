#!/usr/bin/env bun

import { Command } from "commander";
import { MakeApiClient } from "./make-api/client";
import { BlueprintSchema, type Blueprint } from "./make-api/types";
import { analyze } from "./analyzer/index";
import { filterDataFlow } from "./analyzer/checks/data-flow";
import { applyFixes } from "./fixer/index";
import { formatReport, formatJson } from "./reporter/index";
import { diffBlueprints } from "./agent/blueprint-editor";
import { walkModules } from "./utils/blueprint-traversal";
import { getModuleCustomName, hasErrorHandler, getMaxModuleId } from "./utils/module-helpers";

const MAKE_FIXER_DIR = ".make-fixer";

const program = new Command();

program
  .name("make-fixer")
  .description("Analyze and auto-fix Make.com scenario blueprints")
  .version("0.1.0");

// --- fetch command ---
program
  .command("fetch")
  .description("Fetch a scenario blueprint and save it locally for editing")
  .requiredOption("-s, --scenario <id>", "Make.com scenario ID", parseInt)
  .action(async (opts) => {
    const client = createClient();
    console.log(`Fetching scenario ${opts.scenario}...`);

    const { blueprint } = await client.fetchBlueprint(opts.scenario);

    await ensureDir(MAKE_FIXER_DIR);
    const filePath = `${MAKE_FIXER_DIR}/${opts.scenario}.json`;
    await Bun.write(filePath, JSON.stringify(blueprint, null, 2));

    console.log(`Saved to ${filePath}`);
    console.log("");
    printBlueprintSummary(blueprint);
  });

// --- analyze command ---
program
  .command("analyze")
  .description("Analyze a scenario for quality issues (no changes made)")
  .requiredOption("-s, --scenario <id>", "Make.com scenario ID", parseInt)
  .option("--json", "Output as JSON instead of formatted report")
  .option("--var <name>", "Filter data flow to a specific variable name")
  .option("--local", "Analyze the local file instead of fetching from API")
  .action(async (opts) => {
    let blueprint: Blueprint;
    let notes: any[] = [];

    if (opts.local) {
      blueprint = await readLocalBlueprint(opts.scenario);
    } else {
      const client = createClient();
      console.log(`Fetching scenario ${opts.scenario}...`);
      const fetched = await client.fetchBlueprint(opts.scenario);
      blueprint = fetched.blueprint;
      notes = await client.fetchNotes(opts.scenario);
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
  .requiredOption("-s, --scenario <id>", "Make.com scenario ID", parseInt)
  .option("--dry-run", "Show what would change without pushing")
  .option("--only <types>", "Only fix these issue types (comma-separated)")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const client = createClient();
    console.log(`Fetching scenario ${opts.scenario}...`);

    const { blueprint } = await client.fetchBlueprint(opts.scenario);
    const notes = await client.fetchNotes(opts.scenario);

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
      await client.pushBlueprint(opts.scenario, fixed);
      console.log("Done! Blueprint updated successfully.");
    }
  });

// --- validate command ---
program
  .command("validate")
  .description("Compare local blueprint file against the remote version")
  .requiredOption("-s, --scenario <id>", "Make.com scenario ID", parseInt)
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const client = createClient();
    const local = await readLocalBlueprint(opts.scenario);

    console.log(`Fetching remote scenario ${opts.scenario}...`);
    const { blueprint: remote } = await client.fetchBlueprint(opts.scenario);

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
  .requiredOption("-s, --scenario <id>", "Make.com scenario ID", parseInt)
  .option("--yes", "Skip confirmation prompt")
  .action(async (opts) => {
    const client = createClient();
    const local = await readLocalBlueprint(opts.scenario);

    if (!opts.yes) {
      const modules = walkModules(local.flow);
      console.log(`About to push blueprint "${local.name}" (${modules.length} modules) to scenario ${opts.scenario}.`);
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
    await client.pushBlueprint(opts.scenario, local);
    console.log("Done! Blueprint updated successfully.");
  });

// --- helpers ---

function createClient(): MakeApiClient {
  const token = process.env.MAKE_API_TOKEN;
  const baseUrl = process.env.MAKE_BASE_URL || "https://eu1.make.com";

  if (!token) {
    console.error("Error: MAKE_API_TOKEN environment variable is required.");
    console.error("Set it in .env or export it: export MAKE_API_TOKEN=your_token");
    process.exit(1);
  }

  return new MakeApiClient({ token, baseUrl });
}

async function ensureDir(dir: string): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.mkdir(dir, { recursive: true });
}

async function readLocalBlueprint(scenarioId: number): Promise<Blueprint> {
  const filePath = `${MAKE_FIXER_DIR}/${scenarioId}.json`;
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
