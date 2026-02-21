#!/usr/bin/env bun

import { Command } from "commander";
import { MakeApiClient } from "./make-api/client";
import { analyze } from "./analyzer/index";
import { applyFixes } from "./fixer/index";
import { formatReport, formatJson } from "./reporter/index";

const program = new Command();

program
  .name("make-fixer")
  .description("Analyze and auto-fix Make.com scenario blueprints")
  .version("0.1.0");

program
  .command("analyze")
  .description("Analyze a scenario for quality issues (no changes made)")
  .requiredOption("-s, --scenario <id>", "Make.com scenario ID", parseInt)
  .option("--json", "Output as JSON instead of formatted report")
  .action(async (opts) => {
    const client = createClient();
    console.log(`Fetching scenario ${opts.scenario}...`);

    const { blueprint } = await client.fetchBlueprint(opts.scenario);
    const notes = await client.fetchNotes(opts.scenario);
    const result = analyze(blueprint, notes);

    if (opts.json) {
      console.log(formatJson([], result.issues, result.checklist));
    } else {
      console.log(formatReport([], result.issues, result.checklist));
    }
  });

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

    console.log(formatReport(changes, reportOnly, result.checklist));

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

program.parse();
