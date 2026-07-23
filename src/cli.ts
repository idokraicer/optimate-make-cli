#!/usr/bin/env bun

import { Command } from "commander";
import { MakeApiClient } from "./make-api/client";
import { fetchWithRetry } from "./make-api/fetch-retry";
import { BlueprintSchema, type Blueprint } from "./make-api/types";
import { BUILTIN_MODULE_TEMPLATES } from "./data/builtin-modules";
import { analyze } from "./analyzer/index";
import { filterDataFlow } from "./analyzer/checks/data-flow";
import { applyFixes } from "./fixer/index";
import { formatReport, formatJson } from "./reporter/index";
import { diffBlueprints } from "./agent/blueprint-editor";
import { fingerprintBlueprint } from "./utils/blueprint-fingerprint";
import { semanticDiff, type SemanticDiff } from "./utils/semantic-diff";
import { InspectInputError, registerInspectCommand } from "./commands/inspect";
import { registerSearchCommand } from "./commands/search";
import { registerRunCommand } from "./commands/run";
import { registerDoctorCommand } from "./commands/doctor";
import { registerExamplesCommand } from "./commands/examples";
import { registerConnectionsCommand } from "./commands/connections";
import { registerCreateCommand } from "./commands/create";
import { registerCleanupCommand } from "./commands/cleanup";
import { registerProbeCommand } from "./commands/probe";
import { getDefaultOwnershipStore, type OwnershipStore } from "./probes/ownership-store";
import { walkModules } from "./utils/blueprint-traversal";
import { getModuleCustomName, hasErrorHandler, getMaxModuleId } from "./utils/module-helpers";
import { findModuleById, extractInterface, buildResumeModule } from "./utils/resume-builder";
import {
  compactExecution,
  parseDuration,
  resolveExecutionTimeWindow,
  selectWebhookInputLog,
  writeJsonOutput,
} from "./utils/execution-query";
import { checkForUpdate, forceUpdate } from "./updater";
import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

const BLUEPRINTS_DIR = "blueprints";
const BLUEPRINT_SIDECARS_DIR = `${BLUEPRINTS_DIR}/.make-fixer`;
const GLOBAL_CONFIG_DIR = join(homedir(), ".make-fixer");
const GLOBAL_ENV_PATH = join(GLOBAL_CONFIG_DIR, ".env");
const ZONE_CACHE_PATH = join(GLOBAL_CONFIG_DIR, ".zones.json");
const KNOWN_ZONES = [
  "https://eu1.make.com",
  "https://eu2.make.com",
  "https://us1.make.com",
  "https://us2.make.com",
];
const ownershipStore: OwnershipStore = {
  put: (record) => getDefaultOwnershipStore().put(record),
  get: (baseUrl, scenarioId) => getDefaultOwnershipStore().get(baseUrl, scenarioId),
  update: (baseUrl, scenarioId, patch) =>
    getDefaultOwnershipStore().update(baseUrl, scenarioId, patch),
  listPending: () => getDefaultOwnershipStore().listPending(),
  markDeleted: (baseUrl, scenarioId) =>
    getDefaultOwnershipStore().markDeleted(baseUrl, scenarioId),
};

const toInt = (v: string) => parseInt(v, 10);

const program = new Command();

program
  .name("make-fixer")
  .description("Analyze and auto-fix Make.com scenario blueprints")
  .version(pkg.version)
  .addHelpText(
    "after",
    `
Tips:
  • Any Make.com URL works in place of an ID — the zone is auto-detected.
      Scenario URL → teamId + scenarioId:  https://eu2.make.com/<TEAM_ID>/scenarios/<SCENARIO_ID>/edit
      Organization URL → orgId:            https://eu2.make.com/organization/<ORG_ID>/dashboard
  • Don't have the team ID? Ask the user for any Make.com URL and use
      \`make-fixer scenarios --from-url <url>\` — the CLI parses teamId/orgId out of it.
  • Token is stored once at ~/.make-fixer/.env via \`make-fixer login\` and used by all commands.

Common workflows:
  make-fixer orgs                                        Discover accessible organizations
  make-fixer teams -o <ORG_ID>                           List teams within an org
  make-fixer scenarios -o <ORG_ID> --search "<term>"     Find scenarios by name
  make-fixer fetch -s <url>                              Download blueprint locally
  make-fixer analyze -s <id> --local                     Quality report from local file
  make-fixer fix -s <url> --dry-run                      Preview auto-fixes
  make-fixer executions -s <url> --failed                Recent failed runs for a scenario
  make-fixer executions -s <url> --id <executionId>      Public result for a single execution
  make-fixer failures --from-url <any-make-url>          Org/team-wide scan for failed runs
`,
  );

// --- login command ---
program
  .command("login")
  .description("Save your Make.com API token globally to ~/.make-fixer/.env (no local .env needed)")
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
    console.log(`Saved API token to global config: ${GLOBAL_ENV_PATH}`);
    console.log("All make-fixer commands will use this token automatically. No local .env file is needed.");
  });

// --- update command ---
program
  .command("update")
  .description("Update make-fixer to the latest version from GitHub")
  .action(async () => {
    await forceUpdate(pkg.version);
  });

// --- fetch command ---
program
  .command("fetch")
  .description("Fetch a scenario blueprint and save it locally for editing")
  .requiredOption("-s, --scenario <id>", "Make.com scenario ID or URL")
  .action(async (opts) => {
    const { scenarioId, teamId, baseUrl } = parseScenarioInput(opts.scenario);
    const client = await resolveClient(scenarioId, baseUrl, teamId);
    console.log(`Fetching scenario ${scenarioId}...`);

    const { blueprint } = await client.fetchBlueprint(scenarioId);

    await ensureDir(BLUEPRINTS_DIR);
    const filePath = `${BLUEPRINTS_DIR}/${scenarioId}.json`;
    await Bun.write(filePath, JSON.stringify(blueprint, null, 2));
    await writeBlueprintSidecar(scenarioId, getClientBaseUrl(client, scenarioId), blueprint);

    console.log(`Saved to ${filePath}`);
    console.log("");
    printBlueprintSummary(blueprint);
  });

registerInspectCommand(program, {
  resolveClient: resolveClientOrThrow,
  parseScenarioInput: parseInspectScenarioInput,
  readLocalBlueprint: readInspectLocalBlueprint,
  cliVersion: pkg.version,
});

registerSearchCommand(program, {
  createClient: createClientOrThrow,
  parseMakeUrl,
  cliVersion: pkg.version,
});

registerRunCommand(program, {
  resolveClient: resolveClientOrThrow,
  parseScenarioInput: parseInspectScenarioInput,
  cliVersion: pkg.version,
  ownership: ownershipStore,
});

registerDoctorCommand(program, {
  createClient: createClientOrThrow,
  parseMakeUrl,
  parseScenarioInput: parseInspectScenarioInput,
  configuredBaseUrl: async () => (await resolveCredentialsOrThrow()).preferred,
  cliVersion: pkg.version,
});

registerExamplesCommand(program, {
  createClient: createClientOrThrow,
  parseMakeUrl,
  cliVersion: pkg.version,
});

registerConnectionsCommand(program, {
  createClient: createClientOrThrow,
  parseMakeUrl,
  cliVersion: pkg.version,
});

registerCreateCommand(program, {
  createClient: createClientOrThrow,
  resolveTeam: async ({ team, fromUrl, baseUrl }) => {
    const parsed = fromUrl ? parseMakeUrl(fromUrl) : {};
    const optionTeamId = team === undefined ? undefined : Number(team);
    if (
      parsed.teamId !== undefined
      && optionTeamId !== undefined
      && parsed.teamId !== optionTeamId
    ) {
      throw new InspectInputError("--team does not match the team in --from-url.");
    }
    const teamId = parsed.teamId ?? optionTeamId;
    if (typeof teamId !== "number" || !Number.isInteger(teamId) || teamId <= 0) {
      throw new InspectInputError("create requires a positive --team ID or a team-scoped --from-url.");
    }
    const resolvedTeamId = teamId as number;
    const configured = (await resolveCredentialsOrThrow()).preferred;
    const resolvedBaseUrl = normalizeMakeBaseUrl(parsed.baseUrl ?? baseUrl ?? configured);
    const client = await createClientOrThrow(resolvedBaseUrl);
    const teamDetails = await client.fetchTeam(resolvedTeamId);
    const organizationId = Number(
      teamDetails.organizationId ?? teamDetails.organization?.id ?? teamDetails.organization_id,
    );
    if (!Number.isInteger(organizationId) || organizationId <= 0) {
      throw new InspectInputError("Unable to resolve the team's organization.");
    }
    await client.discoverOrganization(organizationId);
    return {
      teamId: resolvedTeamId,
      organizationId,
      baseUrl: resolvedBaseUrl.replace(/\/+$/, ""),
    };
  },
  readBlueprint: async (path) => JSON.parse(await Bun.file(path).text()),
  ownership: ownershipStore,
  cliVersion: pkg.version,
});

registerCleanupCommand(program, {
  resolveClient: resolveClientOrThrow,
  parseScenarioInput: parseInspectScenarioInput,
  resolveOrganizationId: async (client, teamId) => {
    const team = await client.fetchTeam(teamId);
    const organizationId = Number(
      team.organizationId ?? team.organization?.id ?? team.organization_id,
    );
    if (!Number.isInteger(organizationId) || organizationId <= 0) {
      throw new InspectInputError("Unable to resolve the team's organization.");
    }
    return organizationId;
  },
  ownership: ownershipStore,
  cliVersion: pkg.version,
});

registerProbeCommand(program, {
  resolveTarget: async ({ fromUrl }) => {
    const parsed = parseMakeUrl(fromUrl);
    if (!parsed.baseUrl || !parsed.teamId || parsed.teamId <= 0) {
      throw new InspectInputError(
        "probe requires a team-scoped --from-url.",
      );
    }
    const baseUrl = normalizeMakeBaseUrl(parsed.baseUrl);
    const client = await createClientOrThrow(baseUrl);
    const team = await client.fetchTeam(parsed.teamId);
    const organizationId = Number(
      team.organizationId ?? team.organization?.id ?? team.organization_id,
    );
    if (!Number.isInteger(organizationId) || organizationId <= 0) {
      throw new InspectInputError("Unable to resolve the team's organization.");
    }
    await client.discoverOrganization(organizationId);
    return { teamId: parsed.teamId, organizationId, baseUrl };
  },
  createClient: createClientOrThrow,
  readBlueprint: async (path) => JSON.parse(await Bun.file(path).text()),
  readDataFile: async (path) => JSON.parse(await Bun.file(path).text()),
  ownership: ownershipStore,
  cliVersion: pkg.version,
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
    const { scenarioId, teamId, baseUrl } = parseScenarioInput(opts.scenario);
    let blueprint: Blueprint;
    let notes: any[] = [];

    if (opts.local) {
      blueprint = await readLocalBlueprint(scenarioId);
    } else {
      const client = await resolveClient(scenarioId, baseUrl, teamId);
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
    const { scenarioId, teamId, baseUrl } = parseScenarioInput(opts.scenario);
    const client = await resolveClient(scenarioId, baseUrl, teamId);
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
  .option("--changes", "Include semantic leaf-level changes")
  .action(async (opts) => {
    const { scenarioId, teamId, baseUrl } = parseScenarioInput(opts.scenario);
    const client = await resolveClient(scenarioId, baseUrl, teamId);
    const local = await readLocalBlueprint(scenarioId);

    console.log(`Fetching remote scenario ${scenarioId}...`);
    const { blueprint: remote } = await client.fetchBlueprint(scenarioId);

    const diff = diffBlueprints(remote, local);
    const semantic = opts.changes ? semanticDiff(remote, local) : undefined;
    const remoteAnalysis = analyze(remote, []);
    const localAnalysis = analyze(local, []);

    const result = {
      ...diff,
      issuesBefore: remoteAnalysis.issues.length,
      issuesAfter: localAnalysis.issues.length,
      nextId: getMaxModuleId(local.flow) + 1,
      ...(semantic ?? {}),
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
    if (semantic) printSemanticChanges(semantic);
    console.log("");
  });

// --- push command ---
program
  .command("push")
  .description("Push a local blueprint file to Make.com")
  .requiredOption("-s, --scenario <id>", "Make.com scenario ID or URL")
  .option("--yes", "Skip confirmation prompt")
  .option("--allow-remote-drift", "Allow a push when the remote blueprint changed after fetch")
  .action(async (opts) => {
    const { scenarioId, teamId, baseUrl } = parseScenarioInput(opts.scenario);
    const client = await resolveClient(scenarioId, baseUrl, teamId);
    const local = await readLocalBlueprint(scenarioId);
    const remoteDrift = await detectRemoteDrift(
      scenarioId,
      getClientBaseUrl(client, scenarioId),
      client,
    );

    if (remoteDrift) {
      if (!opts.allowRemoteDrift) {
        console.error(`REMOTE_DRIFT: ${remoteDrift}`);
        process.exitCode = 4;
        return;
      }
      console.warn(`REMOTE_DRIFT: ${remoteDrift}`);
    }

    if (!opts.yes || remoteDrift) {
      const modules = walkModules(local.flow);
      console.log(`About to push blueprint "${local.name}" (${modules.length} modules) to scenario ${scenarioId}.`);
      process.stdout.write(remoteDrift ? "Continue despite remote drift? [y/N] " : "Continue? [y/N] ");
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
    await writeBlueprintSidecar(scenarioId, getClientBaseUrl(client, scenarioId), local);
    console.log("Done! Blueprint updated successfully.");
  });

// --- resume command ---
program
  .command("resume")
  .description("Generate a builtin:Resume module JSON for the 429 retry pattern")
  .requiredOption("-s, --scenario <id>", "Make.com scenario ID or URL (reads local blueprint)")
  .requiredOption("--errored <id>", "ID of the module that can fail (provides interface fields)", toInt)
  .requiredOption("--from <id>", "ID of the retry clone module (fields will be mapped from this module)", toInt)
  .option("--id <id>", "ID to assign to the Resume module (default: next available ID)", toInt)
  .option("--x <n>", "Designer x position", toInt)
  .option("--y <n>", "Designer y position", toInt)
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
    if (opts.add && (!opts.module || !opts.content)) {
      console.error("Error: --add requires both --module and --content.");
      process.exit(1);
    }

    const { scenarioId, teamId, baseUrl } = parseScenarioInput(opts.scenario);
    const client = await resolveClient(scenarioId, baseUrl, teamId);

    if (opts.add) {
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
  .option("--limit <n>", "Maximum results to show", toInt, 20)
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
  .option("--version <n>", "App version (auto-detected if omitted)", toInt)
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

// --- scenarios command ---
program
  .command("scenarios")
  .description("List Make.com scenarios for a team or organization")
  .option("-t, --team <id>", "Team ID (or pass any scenario URL via --from-url to auto-derive)", toInt)
  .option("-o, --org <id>", "Organization ID", toInt)
  .option("--from-url <url>", "Derive teamId/orgId + zone from any Make.com URL — scenario URL (https://<zone>.make.com/<TEAM_ID>/scenarios/<SCENARIO_ID>/edit) or organization URL (https://<zone>.make.com/organization/<ORG_ID>/dashboard)")
  .option("--active", "Only active scenarios")
  .option("--folder <id>", "Filter by folder ID", toInt)
  .option("--search <term>", "Filter results by name (case-insensitive substring match)")
  .option("--limit <n>", "Max scenarios to return", toInt, 50)
  .option("--base-url <url>", "Make.com base URL (skips zone discovery)")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    let teamId: number | undefined = opts.team;
    let organizationId: number | undefined = opts.org;
    let baseUrl: string | undefined = opts.baseUrl;

    if (opts.fromUrl) {
      const parsed = parseMakeUrl(opts.fromUrl);
      teamId ??= parsed.teamId;
      organizationId ??= parsed.organizationId;
      baseUrl ??= parsed.baseUrl;
    }

    if (!teamId && !organizationId) {
      console.error("Error: --team <id>, --org <id>, or --from-url <url> is required.");
      console.error("Tip: any Make.com URL contains the team or org ID:");
      console.error("  scenario URL → teamId: https://eu2.make.com/<TEAM_ID>/scenarios/<id>/edit");
      console.error("  org URL → orgId: https://eu2.make.com/organization/<ORG_ID>/dashboard");
      process.exit(1);
    }

    const client = await createClient(baseUrl);
    let scenarios = await client.listScenarios({
      teamId,
      organizationId,
      isActive: opts.active ? true : undefined,
      folderId: opts.folder,
      limit: opts.limit,
    });

    if (opts.search) {
      const q = opts.search.toLowerCase();
      scenarios = scenarios.filter((s: any) => s.name?.toLowerCase().includes(q));
    }

    if (opts.json) {
      console.log(JSON.stringify(scenarios, null, 2));
      return;
    }

    const searchSuffix = opts.search ? ` matching "${opts.search}"` : "";
    console.log(`\n${scenarios.length} scenario(s)${searchSuffix}:\n`);
    for (const s of scenarios) {
      const status = s.isActive ? "●" : "○";
      const paused = s.isPaused ? " [paused]" : "";
      const folder = s.folderId ? ` (folder ${s.folderId})` : "";
      console.log(`  ${status} #${s.id}  ${s.name}${paused}${folder}`);
      // Print the ready-to-open editor URL built from the scenario's OWN teamId.
      // Hand-constructing this from a -o <orgId> lookup is the classic trap:
      // the editor path needs the team id, not the org id.
      if (s.teamId != null) {
        console.log(`      ${client.getEditUrl(s.teamId, s.id)}`);
      }
    }
    console.log("");
  })
  .addHelpText(
    "after",
    `
How to get a teamId or orgId:
  Any Make.com URL contains one — no need to ask the user to dig for it.
    Scenario URL  → teamId:  https://<zone>.make.com/<TEAM_ID>/scenarios/<SCENARIO_ID>/edit
    Org URL       → orgId:   https://<zone>.make.com/organization/<ORG_ID>/dashboard
  Pass either directly via \`--from-url\` and the CLI will parse it.

Examples:
  make-fixer scenarios --from-url "https://<zone>.make.com/<TEAM_ID>/scenarios/<SCENARIO_ID>/edit"
  make-fixer scenarios --from-url "https://<zone>.make.com/organization/<ORG_ID>/dashboard"
  make-fixer scenarios -t <TEAM_ID> --active --limit 100
  make-fixer scenarios -o <ORG_ID> --search "webhook"        # case-insensitive name filter
  make-fixer scenarios -o <ORG_ID> --json | jq '.[] | {id, name}'
`,
  );

// --- orgs command ---
program
  .command("orgs")
  .description("List all Make.com organizations the token can access")
  .option("--search <term>", "Filter results by name (case-insensitive substring match)")
  .option("--base-url <url>", "Make.com base URL (default: https://eu1.make.com)")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const client = await createClient(opts.baseUrl);
    let orgs = await client.listOrganizations();

    if (opts.search) {
      const q = opts.search.toLowerCase();
      orgs = orgs.filter((o: any) => o.name?.toLowerCase().includes(q));
    }

    if (opts.json) {
      console.log(JSON.stringify(orgs, null, 2));
      return;
    }

    const searchSuffix = opts.search ? ` matching "${opts.search}"` : "";
    console.log(`\n${orgs.length} organization(s)${searchSuffix}:\n`);
    for (const o of orgs) {
      const zone = o.zone ? ` [${o.zone}]` : "";
      console.log(`  #${o.id}  ${o.name}${zone}`);
    }
    console.log("");
  })
  .addHelpText(
    "after",
    `
Lists every organization the configured token can access. Each row shows the orgId
(pass to other commands via -o) and the zone (each org lives in exactly one zone).

Note: the token only sees orgs in zones where it was issued. If you have orgs in
multiple zones (eu1, eu2, us1, us2), re-run with --base-url to inspect each zone.

Examples:
  make-fixer orgs                          # all orgs in default zone
  make-fixer orgs --search "acme"          # filter by name
  make-fixer orgs --base-url https://us1.make.com
  make-fixer orgs --json | jq '.[] | {id, name, zone}'
`,
  );

// --- teams command ---
program
  .command("teams")
  .description("List teams within a Make.com organization")
  .option("-o, --org <id>", "Organization ID", toInt)
  .option("--from-url <url>", "Derive orgId from any Make.com URL")
  .option("--search <term>", "Filter results by name (case-insensitive substring match)")
  .option("--base-url <url>", "Make.com base URL (skips zone discovery)")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    let organizationId: number | undefined = opts.org;
    let baseUrl: string | undefined = opts.baseUrl;

    if (opts.fromUrl) {
      const parsed = parseMakeUrl(opts.fromUrl);
      organizationId ??= parsed.organizationId;
      baseUrl ??= parsed.baseUrl;
    }

    if (!organizationId) {
      console.error("Error: --org <id> or --from-url <url> is required.");
      console.error("Tip: run `make-fixer orgs` to list accessible organizations.");
      process.exit(1);
    }

    const client = await createClient(baseUrl);
    let teams = await client.listTeams(organizationId);

    if (opts.search) {
      const q = opts.search.toLowerCase();
      teams = teams.filter((t: any) => t.name?.toLowerCase().includes(q));
    }

    if (opts.json) {
      console.log(JSON.stringify(teams, null, 2));
      return;
    }

    const searchSuffix = opts.search ? ` matching "${opts.search}"` : "";
    console.log(`\n${teams.length} team(s) in org ${organizationId}${searchSuffix}:\n`);
    for (const t of teams) {
      console.log(`  #${t.id}  ${t.name}`);
    }
    console.log("");
  })
  .addHelpText(
    "after",
    `
Use this when you have an organizationId but need to find a specific team.
First run \`make-fixer orgs\` to discover orgIds.

Examples:
  make-fixer teams -o <ORG_ID>
  make-fixer teams --from-url "https://<zone>.make.com/organization/<ORG_ID>/dashboard"
  make-fixer teams -o <ORG_ID> --search "production"
`,
  );

// --- executions command ---
async function fetchExecutionWithWebhookInput(
  client: MakeApiClient,
  scenarioId: number,
  executionId: string,
  execution: any,
): Promise<any> {
  const basePayload = {
    executionId,
    execution,
    executionLog: null as any,
    input: null as any,
  };

  try {
    const [scenario, executionLog] = await Promise.all([
      client.fetchScenario(scenarioId),
      client.fetchExecutionLog(scenarioId, executionId),
    ]);
    basePayload.executionLog = executionLog;

    const hookId = scenario.hookId;
    if (hookId == null) {
      return {
        ...basePayload,
        inputAvailability: {
          available: false,
          reason: "scenario_has_no_webhook",
        },
      };
    }

    const timestamp = executionLog.timestamp ?? executionLog.executionTime;
    const executionTime = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
    if (Number.isNaN(executionTime)) {
      return {
        ...basePayload,
        inputAvailability: {
          available: false,
          reason: "execution_timestamp_unavailable",
          hookId,
        },
      };
    }

    const matchWindowMs = 120_000;
    const hookLogs = await client.listHookLogs(hookId, {
      from: String(executionTime - matchWindowMs),
      to: String(executionTime + matchWindowMs),
      limit: 100,
    });
    const selection = selectWebhookInputLog(hookLogs, timestamp, { maxDistanceMs: matchWindowMs });

    if (!selection.match) {
      return {
        ...basePayload,
        inputAvailability: {
          available: false,
          reason: selection.reason === "ambiguous"
            ? "ambiguous_webhook_match"
            : "webhook_log_not_found",
          hookId,
          candidateLogIds: selection.candidateLogIds,
          note: "Webhook logs have limited retention and no documented execution ID linkage.",
        },
      };
    }

    const hookLog = await client.fetchHookLog(hookId, String(selection.match.id));
    return {
      ...basePayload,
      input: {
        source: "webhook_log",
        hookId,
        hookLogId: String(selection.match.id),
        loggedAt: hookLog.loggedAt ?? selection.match.loggedAt ?? null,
        match: {
          method: "nearest_timestamp",
          differenceMs: selection.differenceMs,
        },
        request: hookLog.data?.request ?? null,
        parsed: hookLog.data?.parsed ?? null,
      },
      inputAvailability: {
        available: true,
        hookId,
        hookLogId: String(selection.match.id),
        retentionDays: hookLog.logRetentionDays ?? null,
      },
    };
  } catch (error) {
    return {
      ...basePayload,
      inputAvailability: {
        available: false,
        reason: "webhook_lookup_failed",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

program
  .command("executions")
  .description("List recent executions for a scenario, or fetch one by ID")
  .requiredOption("-s, --scenario <id>", "Make.com scenario ID or URL")
  .option("--id <executionId>", "Fetch a single execution result by raw ID")
  .option("--include-input", "Include webhook request data when a matching webhook log is available (requires --id)")
  .option("--limit <n>", "Max executions to list", toInt, 20)
  .option("--status <s>", "Filter: success (1) | incomplete (2, Make UI calls these 'errors') | error (3, rare fatal) | failed (any non-success)")
  .option("--failed", "Shortcut for --status failed (anything that isn't a success)")
  .option("--from <date>", "Start time: ISO 8601 or epoch milliseconds")
  .option("--to <date>", "End time: ISO 8601 or epoch milliseconds")
  .option("--since <duration>", "Relative window ending now: 30m, 2h, 7d, 1mo")
  .option("--json", "Output as JSON")
  .option("--compact", "Output stable, token-efficient JSON fields (list mode)")
  .option("--output <file>", "Also write the JSON payload to a file (stdout remains available)")
  .action(async (opts) => {
    const { scenarioId, teamId, baseUrl } = parseScenarioInput(opts.scenario);
    const client = await resolveClient(scenarioId, baseUrl, teamId);

    if (opts.id) {
      if (opts.from || opts.to || opts.since) {
        console.error("Error: --from, --to, and --since only apply when listing executions, not with --id.");
        process.exit(1);
      }
      const execution = await client.fetchExecution(scenarioId, opts.id);
      const payload = opts.includeInput
        ? await fetchExecutionWithWebhookInput(client, scenarioId, opts.id, execution)
        : execution;
      const json = await writeJsonOutput(payload, opts.output);
      if (opts.output) console.error(`Saved execution JSON to ${opts.output}`);
      console.log(json);
      return;
    }

    if (opts.includeInput) {
      console.error("Error: --include-input requires --id because webhook input is matched to one execution.");
      process.exit(1);
    }

    if (!Number.isInteger(opts.limit) || opts.limit <= 0) {
      console.error("Error: --limit must be a positive integer.");
      process.exit(1);
    }

    let timeWindow: { from?: string; to?: string };
    try {
      timeWindow = resolveExecutionTimeWindow(opts);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }

    const statusMap: Record<string, 1 | 2 | 3> = {
      success: 1, ok: 1,
      incomplete: 2, warning: 2,
      error: 3, fatal: 3,
    };
    const wantFailed = opts.failed || opts.status?.toLowerCase() === "failed";
    const status = !wantFailed && opts.status ? statusMap[opts.status.toLowerCase()] : undefined;
    if (opts.status && !status && !wantFailed) {
      console.error(`Error: --status must be one of: success, incomplete, error, failed.`);
      process.exit(1);
    }

    let executions = await client.listExecutions(scenarioId, {
      limit: opts.limit,
      status,
      from: timeWindow.from,
      to: timeWindow.to,
    });
    if (wantFailed) executions = executions.filter((e) => e.status !== 1);

    const outputPayload = opts.compact
      ? {
        scenarioId,
        count: executions.length,
        from: timeWindow.from ?? null,
        to: timeWindow.to ?? null,
        executions: executions.map(compactExecution),
      }
      : executions;

    if (opts.output || opts.compact || opts.json) {
      const json = await writeJsonOutput(outputPayload, opts.output);
      if (opts.output) console.error(`Saved execution JSON to ${opts.output}`);
      if (opts.compact || opts.json) {
        console.log(json);
        return;
      }
    }

    if (executions.length === 0) {
      console.log(`No executions found for scenario ${scenarioId}.`);
      return;
    }

    const statusLabel = (s: number) => (s === 1 ? "OK" : s === 2 ? "FAIL" : s === 3 ? "ERR!" : String(s ?? "?"));
    console.log(`\n${executions.length} execution(s) for scenario ${scenarioId}:\n`);
    for (const e of executions) {
      const id = e.id ?? e.imtId ?? "?";
      const st = statusLabel(e.status);
      const ts = e.timestamp ?? e.executionTime ?? "";
      const ops = e.operations != null ? `${e.operations} ops` : "";
      const dur = e.duration != null ? `${e.duration}ms` : "";
      const name = e.executionName ? ` "${e.executionName}"` : "";
      console.log(`  [${st.padEnd(4)}] ${id}  ${ts}  ${ops}  ${dur}${name}`);
    }
    console.log(`\nFetch details: make-fixer executions -s ${scenarioId} --id <executionId>\n`);
  })
  .addHelpText(
    "after",
    `
Output columns (list mode): [STATUS] <executionId>  <timestamp>  <operations>  <duration>  "<runName>"
  STATUS: OK = success (1), FAIL = incomplete/error (2, what Make's UI calls "errors"), ERR! = fatal (3, rare)

Make.com's status codes are confusing: the UI labels status=2 runs as errors, but the API
documents 2 as "warning". In practice, --status incomplete (or --failed) is what catches
the failures you actually care about. --status error (3) almost never matches.

The executionId column is the raw ID accepted by \`--id\`. Make's public execution endpoint
returns status plus configured scenario outputs or an error when available; it does not expose
all module bundles. Add \`--include-input\` to retrieve webhook request data when a webhook log
can be matched safely. The output includes match provenance and an availability reason.

Examples:
  make-fixer executions -s "https://<zone>.make.com/<TEAM_ID>/scenarios/<SCENARIO_ID>/edit"
  make-fixer executions -s <SCENARIO_ID> --failed --limit 50          # all non-success runs
  make-fixer executions -s <SCENARIO_ID> --status incomplete           # status=2 only
  make-fixer executions -s <SCENARIO_ID> --since 2h --compact           # compact agent-friendly JSON
  make-fixer executions -s <SCENARIO_ID> --since 2h --json --output executions.json | jq '.[] | .imtId'
  make-fixer executions -s <SCENARIO_ID> --from 2026-07-15T09:00:00+03:00 --to 2026-07-15T10:00:00+03:00
  make-fixer executions -s <SCENARIO_ID> --id <EXECUTION_ID> --include-input | jq '.input'
  make-fixer executions -s <SCENARIO_ID> --from <FROM_MS> --to <TO_MS> --json
`,
  );

// --- failures command ---
program
  .command("failures")
  .description("Scan an entire team or organization for recently failed executions")
  .option("-t, --team <id>", "Team ID", toInt)
  .option("-o, --org <id>", "Organization ID", toInt)
  .option("--from-url <url>", "Derive teamId/orgId + zone from any Make.com URL")
  .option("--since <duration>", "Time window: 1h, 24h, 7d, 30d (default: 7d)", "7d")
  .option("--limit <n>", "Max executions to inspect per scenario (default: 50)", toInt, 50)
  .option("--include-paused", "Also scan paused/inactive scenarios (default: active only)")
  .option("--base-url <url>", "Make.com base URL (skips zone discovery)")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    let teamId: number | undefined = opts.team;
    let organizationId: number | undefined = opts.org;
    let baseUrl: string | undefined = opts.baseUrl;

    if (opts.fromUrl) {
      const parsed = parseMakeUrl(opts.fromUrl);
      teamId ??= parsed.teamId;
      organizationId ??= parsed.organizationId;
      baseUrl ??= parsed.baseUrl;
    }

    if (!teamId && !organizationId) {
      console.error("Error: --team <id>, --org <id>, or --from-url <url> is required.");
      process.exit(1);
    }

    const sinceMs = parseDuration(opts.since);
    if (sinceMs == null) {
      console.error(`Error: --since must look like 30m, 1h, 7d, or 1mo. Got: ${opts.since}`);
      process.exit(1);
    }
    const fromTs = String(Date.now() - sinceMs);

    const client = await createClient(baseUrl);
    const scenarios = await client.listScenarios({
      teamId,
      organizationId,
      isActive: opts.includePaused ? undefined : true,
      limit: 200,
    });

    if (!opts.json) {
      console.error(`Scanning ${scenarios.length} ${opts.includePaused ? "" : "active "}scenarios for failures in the last ${opts.since}...`);
    }

    const results: Array<{ id: number; name: string; fails: any[]; err?: string }> = [];
    for (let i = 0; i < scenarios.length; i++) {
      const s: any = scenarios[i];
      try {
        const all = await client.listExecutions(s.id, { limit: opts.limit, from: fromTs });
        const fails = all.filter((e: any) => e.status !== 1);
        results.push({ id: s.id, name: s.name, fails });
      } catch (e) {
        results.push({ id: s.id, name: s.name, fails: [], err: String(e) });
      }
      if (!opts.json && i % 10 === 9) process.stderr.write(".");
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!opts.json) process.stderr.write("\n");

    const failed = results
      .filter((r) => r.fails.length > 0)
      .sort((a, b) => b.fails.length - a.fails.length);

    if (opts.json) {
      console.log(JSON.stringify(failed.map((r) => ({
        scenarioId: r.id,
        name: r.name,
        failureCount: r.fails.length,
        executions: r.fails.map((e: any) => ({
          executionId: e.id,
          imtId: e.imtId,
          status: e.status,
          timestamp: e.timestamp,
          operations: e.operations,
          duration: e.duration,
        })),
      })), null, 2));
      return;
    }

    if (failed.length === 0) {
      console.log(`\n✓ No failures in the last ${opts.since} across ${scenarios.length} scenarios.`);
      return;
    }

    const totalFailures = failed.reduce((sum, r) => sum + r.fails.length, 0);
    console.log(`\n${failed.length} of ${scenarios.length} scenarios had failures (${totalFailures} total) in the last ${opts.since}:\n`);

    for (const r of failed) {
      const s2 = r.fails.filter((e: any) => e.status === 2).length;
      const s3 = r.fails.filter((e: any) => e.status === 3).length;
      const other = r.fails.length - s2 - s3;
      const breakdown = [
        s2 ? `${s2} incomplete` : null,
        s3 ? `${s3} fatal` : null,
        other ? `${other} other` : null,
      ].filter(Boolean).join(", ");
      console.log(`#${r.id}  [${r.fails.length} fails: ${breakdown}]  ${r.name}`);
      for (const e of r.fails.slice(0, 2)) {
        console.log(`    ${e.timestamp}  exec=${e.id}`);
      }
      if (r.fails.length > 2) console.log(`    ...and ${r.fails.length - 2} more (run: make-fixer executions -s ${r.id} --failed)`);
    }

    const errored = results.filter((r) => r.err);
    if (errored.length) {
      console.error(`\n${errored.length} scenarios could not be queried (likely rate-limited).`);
    }
  })
  .addHelpText(
    "after",
    `
Scans every scenario in a team/org and reports which ones have non-success executions
in the time window. Uses sequential queries with built-in rate-limit backoff (Make.com
throttles aggressively at org level).

Examples:
  make-fixer failures --from-url "https://<zone>.make.com/organization/<ORG_ID>/dashboard"
  make-fixer failures --from-url "https://<zone>.make.com/<TEAM_ID>/scenarios/<SCENARIO_ID>/edit" --since 24h
  make-fixer failures -o <ORG_ID> --since 30d --include-paused
  make-fixer failures -t <TEAM_ID> --json | jq '.[] | select(.failureCount > 5)'

Drill into a specific scenario's failures:
  make-fixer executions -s <SCENARIO_ID> --failed
`,
  );

// --- helpers ---

/**
 * Extract teamId / organizationId / scenarioId / baseUrl from any Make.com URL.
 * Handles scenario URLs (`/<teamId>/scenarios/<id>/...`) and organization URLs
 * (`/organization/<orgId>/...`). Returns whatever it can identify.
 */
function parseMakeUrl(input: string): {
  baseUrl?: string;
  teamId?: number;
  organizationId?: number;
  scenarioId?: number;
} {
  const zoneMatch = input.match(/^https?:\/\/((?:eu|us)\d+\.make\.com)(\/.*)?$/);
  if (!zoneMatch) return {};
  const baseUrl = `https://${zoneMatch[1]}`;
  const path = zoneMatch[2] ?? "";

  const orgMatch = path.match(/^\/organization\/(\d+)/);
  if (orgMatch) return { baseUrl, organizationId: parseInt(orgMatch[1], 10) };

  const scenarioMatch = path.match(/^\/(\d+)\/scenarios\/(\d+)/);
  if (scenarioMatch) {
    return {
      baseUrl,
      teamId: parseInt(scenarioMatch[1], 10),
      scenarioId: parseInt(scenarioMatch[2], 10),
    };
  }

  const teamOnlyMatch = path.match(/^\/(\d+)(?:\/|$)/);
  if (teamOnlyMatch) return { baseUrl, teamId: parseInt(teamOnlyMatch[1], 10) };

  return { baseUrl };
}

function normalizeMakeBaseUrl(input: string): string {
  const normalized = input.replace(/\/+$/, "");
  if (!/^https:\/\/(?:eu|us)\d+\.make\.com$/i.test(normalized)) {
    throw new InspectInputError("The Make.com base URL must be an HTTPS eu*/us*.make.com zone.");
  }
  return normalized;
}

function parseScenarioInput(input: string): { scenarioId: number; teamId?: number; baseUrl?: string } {
  const parsed = parseMakeUrl(input);
  if (parsed.scenarioId != null) {
    return { scenarioId: parsed.scenarioId, teamId: parsed.teamId, baseUrl: parsed.baseUrl };
  }

  // Otherwise treat as a bare scenario ID
  const id = parseInt(input, 10);
  if (isNaN(id)) {
    console.error(`Error: "${input}" is not a valid scenario ID or Make.com URL.`);
    process.exit(1);
  }
  return { scenarioId: id };
}

function parseInspectScenarioInput(input: unknown): { scenarioId: number; teamId?: number; baseUrl?: string } {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new InspectInputError("A scenario ID or Make.com URL is required.");
  }

  const parsed = parseMakeUrl(input);
  if (parsed.scenarioId != null && parsed.scenarioId > 0) {
    return { scenarioId: parsed.scenarioId, teamId: parsed.teamId, baseUrl: parsed.baseUrl };
  }

  const id = Number(input);
  if (!Number.isInteger(id) || id <= 0) {
    throw new InspectInputError(`"${input}" is not a valid scenario ID or Make.com URL.`);
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
  try {
    return await createClientOrThrow(baseUrlOverride);
  } catch (error) {
    exitLegacyResolutionError(error);
  }
}

async function createClientOrThrow(baseUrlOverride?: string): Promise<MakeApiClient> {
  const { token, preferred } = await resolveCredentialsOrThrow();
  return new MakeApiClient({ token, baseUrl: baseUrlOverride ?? preferred });
}

async function resolveCredentialsOrThrow(): Promise<{ token: string; preferred: string }> {
  const globalEnv = await loadGlobalEnv();
  const token = process.env.MAKE_API_TOKEN || globalEnv.MAKE_API_TOKEN;
  if (!token) {
    throw new InspectInputError("Unable to inspect scenario.", [
      "Error: MAKE_API_TOKEN not found. Run: make-fixer login --token <your-token>",
      "This saves the token globally to ~/.make-fixer/.env — do NOT create a local .env file.",
    ]);
  }
  return {
    token,
    preferred: process.env.MAKE_BASE_URL || globalEnv.MAKE_BASE_URL || "https://eu1.make.com",
  };
}

async function resolveClient(
  scenarioId: number,
  baseUrlOverride?: string,
  teamId?: number,
): Promise<MakeApiClient> {
  try {
    return await resolveClientOrThrow(scenarioId, baseUrlOverride, teamId);
  } catch (error) {
    exitLegacyResolutionError(error);
  }
}

async function resolveClientOrThrow(
  scenarioId: number,
  baseUrlOverride?: string,
  teamId?: number,
): Promise<MakeApiClient> {
  const { token, preferred } = await resolveCredentialsOrThrow();
  // If the user passed a full URL, trust the zone from it — no discovery.
  if (baseUrlOverride) {
    const client = new MakeApiClient({ token, baseUrl: baseUrlOverride });
    if (teamId != null) {
      await client.discoverOrganizationForTeam(teamId);
    } else {
      await client.discoverOrganizationForScenario(scenarioId);
    }
    return client;
  }

  const baseUrl = await resolveZoneOrThrow(scenarioId, token, preferred);
  const client = new MakeApiClient({ token, baseUrl });
  if (teamId != null) {
    await client.discoverOrganizationForTeam(teamId);
  } else {
    await client.discoverOrganizationForScenario(scenarioId);
  }
  return client;
}

function exitLegacyResolutionError(error: unknown): never {
  if (error instanceof InspectInputError && error.legacyDiagnostics.length > 0) {
    for (const diagnostic of error.legacyDiagnostics) console.error(diagnostic);
  } else if (error instanceof Error) {
    console.error(`Error: ${error.message}`);
  } else {
    console.error("Error: Unable to resolve Make.com client.");
  }
  process.exit(1);
}

async function resolveZoneOrThrow(
  scenarioId: number,
  token: string,
  preferred: string,
): Promise<string> {
  const cache = await loadZoneCache();
  const cached = cache[scenarioId];
  if (cached) return cached;

  const tryOrder = [preferred, ...KNOWN_ZONES.filter((z) => z !== preferred)];
  let firstAuthError: { status: number; body: string } | null = null;

  for (const baseUrl of tryOrder) {
    const result = await probeScenario(scenarioId, token, baseUrl);
    if (result.ok) {
      if (baseUrl !== preferred) {
        console.error(
          `ℹ Scenario ${scenarioId} found in ${zoneLabel(baseUrl)} (configured: ${zoneLabel(preferred)}). Caching for next time.`,
        );
      }
      cache[scenarioId] = baseUrl;
      await saveZoneCache(cache);
      return baseUrl;
    }
    if (result.status === 401 && !firstAuthError) {
      firstAuthError = { status: result.status, body: result.body };
    }
  }

  if (firstAuthError) {
    throw new InspectInputError("Unable to inspect scenario.", [
      `Error: Make API returned 401 Unauthorized for scenario ${scenarioId} in every zone tried (${KNOWN_ZONES.map(zoneLabel).join(", ")}).`,
      "Your token is likely invalid or scoped to a zone not in the known list. Re-run: make-fixer login --token <token> --base-url <your-zone-url>",
    ]);
  }

  throw new InspectInputError("Unable to inspect scenario.", [
    `Error: Scenario ${scenarioId} not found in any known zone (${KNOWN_ZONES.map(zoneLabel).join(", ")}).`,
    `Pass the full Make.com URL instead of the bare ID (e.g. https://eu2.make.com/<team>/scenarios/${scenarioId}/edit) to skip discovery.`,
  ]);
}

async function probeScenario(
  scenarioId: number,
  token: string,
  baseUrl: string,
): Promise<{ ok: true } | { ok: false; status: number; body: string }> {
  try {
    const res = await fetchWithRetry(`${baseUrl}/api/v2/scenarios/${scenarioId}`, {
      headers: { Authorization: `Token ${token}` },
    });
    if (res.ok) return { ok: true };
    const body = await res.text().catch(() => "");
    return { ok: false, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) };
  }
}

function zoneLabel(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, "").replace(/\.make\.com$/, "");
}

async function loadZoneCache(): Promise<Record<string, string>> {
  const file = Bun.file(ZONE_CACHE_PATH);
  if (!(await file.exists())) return {};
  try {
    return JSON.parse(await file.text());
  } catch {
    return {};
  }
}

async function saveZoneCache(cache: Record<string, string>): Promise<void> {
  await ensureDir(GLOBAL_CONFIG_DIR);
  await Bun.write(ZONE_CACHE_PATH, JSON.stringify(cache, null, 2));
}

async function ensureDir(dir: string): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.mkdir(dir, { recursive: true });
}

interface BlueprintSidecar {
  scenarioId: number;
  baseUrl: string;
  fingerprint: string;
  fetchedAt: string;
}

function blueprintSidecarPath(scenarioId: number): string {
  return `${BLUEPRINT_SIDECARS_DIR}/${scenarioId}.json`;
}

function getClientBaseUrl(client: MakeApiClient, scenarioId: number): string {
  return new URL(client.getBlueprintUrl(scenarioId)).origin;
}

async function writeBlueprintSidecar(
  scenarioId: number,
  baseUrl: string,
  blueprint: Blueprint,
): Promise<void> {
  const sidecar: BlueprintSidecar = {
    scenarioId,
    baseUrl,
    fingerprint: await fingerprintBlueprint(blueprint),
    fetchedAt: new Date().toISOString(),
  };
  await ensureDir(BLUEPRINT_SIDECARS_DIR);
  await Bun.write(blueprintSidecarPath(scenarioId), JSON.stringify(sidecar, null, 2));
}

async function readBlueprintSidecar(scenarioId: number): Promise<BlueprintSidecar | null> {
  const file = Bun.file(blueprintSidecarPath(scenarioId));
  if (!(await file.exists())) return null;
  try {
    const sidecar = await file.json() as Partial<BlueprintSidecar>;
    if (
      sidecar.scenarioId !== scenarioId
      || typeof sidecar.baseUrl !== "string"
      || typeof sidecar.fingerprint !== "string"
      || typeof sidecar.fetchedAt !== "string"
    ) return null;
    return sidecar as BlueprintSidecar;
  } catch {
    return null;
  }
}

async function detectRemoteDrift(
  scenarioId: number,
  baseUrl: string,
  client: MakeApiClient,
): Promise<string | null> {
  const { blueprint: remote } = await client.fetchBlueprint(scenarioId);
  const sidecar = await readBlueprintSidecar(scenarioId);
  if (!sidecar) return "No valid fetch baseline exists; run make-fixer fetch before pushing.";
  if (sidecar.baseUrl !== baseUrl) return "The fetch baseline belongs to a different Make.com zone.";
  if (sidecar.fingerprint !== await fingerprintBlueprint(remote)) {
    return "The remote blueprint changed since the last fetch.";
  }
  return null;
}

function printSemanticChanges(semantic: SemanticDiff): void {
  const formatModules = (moduleIds: number[]) => moduleIds.length > 0
    ? moduleIds.map((id) => `#${id}`).join(", ")
    : "none";
  console.log(`  Directly modified modules: ${formatModules(semantic.directlyModifiedModules)}`);
  console.log(`  Ancestor modules: ${formatModules(semantic.ancestorModules)}`);
  console.log(`  Leaf changes: ${semantic.changes.length}`);
  for (const change of semantic.changes) {
    console.log(`    ${change.path}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`);
  }
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

async function readInspectLocalBlueprint(scenarioId: number): Promise<Blueprint> {
  const filePath = `${BLUEPRINTS_DIR}/${scenarioId}.json`;
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new InspectInputError(`Local blueprint not found at ${filePath}`);
  }
  return BlueprintSchema.parse(await file.json());
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

async function main() {
  // Best-effort, throttled auto-update before running the command. Skipped for meta
  // commands and the explicit `update` command (which checks unconditionally itself).
  const argv = process.argv.slice(2);
  const META = ["update", "--version", "-V", "--help", "-h"];
  const isMeta = argv.length === 0 || argv.some((a) => META.includes(a));
  if (!isMeta) {
    await checkForUpdate(pkg.version);
  }
  await program.parseAsync();
}

main();
