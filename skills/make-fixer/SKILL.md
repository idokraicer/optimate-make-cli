---
name: make-fixer
description: Fetches, analyzes, edits, builds, and pushes Make.com (formerly Integromat) scenario blueprints via the make-fixer CLI. Use when the user mentions Make.com scenarios, blueprints, modules, automation workflows, routers, webhooks, operations cost, or wants to create, debug, optimize, or improve any Make.com automation. Also use when the user asks about Make.com inline functions, expressions, formatDate, parseDate, ifempty, switch, get, map, or any Make.com function syntax — load FUNCTIONS_REFERENCE.md for the complete verified reference. Covers blueprint JSON structure, module mapper formats, variable patterns (Set/Get), error handlers, filters, cost optimization, and community best practices (BEST_PRACTICES.md). This skill and its bundled sub-files are the primary source of truth for all Make.com work.
user-invocable: true
---

# Make.com Scenario Editor & Builder

You can fetch, edit, validate, and push Make.com scenario blueprints using the `make-fixer` CLI. You can also design new scenarios from scratch through collaborative brainstorming.

## Bundled Reference Files — Load On Demand

This skill includes sub-files with deep reference material. **Read them when needed:**

- **[FUNCTIONS_REFERENCE.md](FUNCTIONS_REFERENCE.md)** — Complete catalog of all Make.com inline functions (70+), date/time formatting/parsing tokens, filter operators, data types, and type coercion rules. **Load this file whenever:**
  - The user asks about any Make.com function, expression syntax, or formula
  - You need to write or verify an inline expression in a blueprint
  - You need date formatting tokens, filter operator codes, or type coercion behavior
  - You're unsure whether a function exists (this file is the canonical list — if it's not here, it doesn't exist)

- **[BEST_PRACTICES.md](BEST_PRACTICES.md)** — Error handling patterns, debugging workflows, testing strategies, naming conventions, architecture patterns (webhook chains, queue-based processing), production settings, AI integration patterns, cost optimization checklist, and data store design. **Load this file whenever:**
  - Designing a new scenario from scratch
  - Reviewing or improving an existing scenario's architecture
  - Adding error handlers or debugging a failing scenario
  - The user asks about Make.com best practices, patterns, or production readiness

## Installation

The `make-fixer` CLI lives in a **separate repo** ([github.com/idokraicer/make-fixer](https://github.com/idokraicer/make-fixer)) and must be installed manually — it is NOT bundled with this plugin.

Before first use, check if `make-fixer` is available by running `make-fixer --version`. If the command is not found, walk the user through:

1. **Install Bun** if missing: `curl -fsSL https://bun.sh/install | bash` (then restart shell)
2. **Clone + link the CLI:**
   ```bash
   git clone https://github.com/idokraicer/make-fixer.git ~/.make-fixer
   cd ~/.make-fixer && bun install && bun link
   ```
3. **Verify:** `make-fixer --version`

If `make-fixer: command not found` persists after `bun link`, the user's `~/.bun/bin` is not on PATH — point them to Bun's install docs.

Full setup steps (including how to get a Make.com API token) are in the plugin's [README.md](../../README.md).

## Setup

The API token is stored globally at `~/.make-fixer/.env` and works from any directory.

To configure, run: `make-fixer login --token <YOUR_TOKEN>`

**IMPORTANT:** Always use `--token <token>` flag. Do NOT run bare `make-fixer login` — the interactive prompt does not work inside Claude Code.

Optionally set a custom base URL: `make-fixer login --token <token> --base-url https://us1.make.com` (default: `https://eu1.make.com`). Running login again updates the existing token.

If a command fails with "MAKE_API_TOKEN not found", ask the user for their token and run `make-fixer login --token <token>`.

## CLI Reference

All commands accept `-s <id-or-url>` to specify a scenario. URLs auto-detect the zone.

| Command | Description | Key Flags |
|---------|-------------|-----------|
| `login` | Save API token globally | `--token <token>` (required), `--base-url <url>` |
| `fetch` | Download blueprint to `blueprints/<id>.json` | `-s <id-or-url>` |
| `analyze` | Quality report (no changes) | `--local` (use local file), `--json`, `--var <name>` (trace a variable) |
| `fix` | Auto-fix issues (uses Claude API) | `--dry-run` (preview only), `--only <types>`, `--json` |
| `validate` | Diff local vs remote blueprint | `--json` |
| `push` | Upload local blueprint to Make.com | `--yes` (skip confirmation) |
| `resume` | Generate `builtin:Resume` JSON for 429 retry pattern | `--errored <id>`, `--from <id>`, `--id <id>`, `--x`, `--y` |
| `notes` | List or add scenario notes | `--add`, `--module <ids>`, `--content <text>` |
| `apps` | Search Make.com app catalog | `[query]`, `--limit <n>` |
| `modules` | List modules for an app | `<app-name>`, `--version <n>` |
| `orgs` | List all organizations the token can access | `--search <term>`, `--base-url <url>`, `--json` |
| `teams` | List teams within an organization | `-o <orgId>` / `--from-url <url>`, `--search <term>`, `--json` |
| `scenarios` | List scenarios for a team or organization | `-t <teamId>` / `-o <orgId>` / `--from-url <any-make-url>`, `--active`, `--folder`, `--search <term>`, `--limit`, `--json` |
| `executions` | List recent executions for a scenario (or fetch one) | `-s <id-or-url>`, `--id <executionId>` (full detail), `--failed`, `--status success\|incomplete\|error\|failed`, `--limit`, `--from <ts>`, `--to <ts>`, `--json` |
| `failures` | Scan an entire team/org for recently failed executions | `-t <teamId>` / `-o <orgId>` / `--from-url <url>`, `--since 1h\|24h\|7d\|30d`, `--limit <n>` (per scenario), `--include-paused`, `--json` |

### Useful patterns

```bash
# Trace a specific variable through the scenario
make-fixer analyze -s <id> --local --var myVariableName

# Preview auto-fixes without pushing
make-fixer fix -s <url> --dry-run

# Generate Resume module for 429 retry
make-fixer resume -s <id> --errored 5 --from 20

# Add documentation note to modules
make-fixer notes -s <id> --add --module 1,2,3 --content "Fetches customer data from CRM"

# Look up correct module type strings (ALWAYS do this — never guess)
make-fixer apps <search-query> && make-fixer modules <app-name>

# Discover what the token can see (use this when the user hasn't shared any URL)
make-fixer orgs                           # all orgs, with their zone
make-fixer teams -o <ORG_ID>              # teams within an org

# List all scenarios in a team (derive teamId from ANY Make.com URL the user shared)
make-fixer scenarios --from-url "https://<zone>.make.com/<TEAM_ID>/scenarios/<SCENARIO_ID>/edit"
make-fixer scenarios --from-url "https://<zone>.make.com/organization/<ORG_ID>/dashboard"
make-fixer scenarios -o <ORG_ID> --search "webhook"   # filter by name (case-insensitive)

# Recent executions for a scenario + drill into one
make-fixer executions -s "https://<zone>.make.com/<TEAM_ID>/scenarios/<SCENARIO_ID>/edit" --limit 10
make-fixer executions -s <SCENARIO_ID> --failed              # only non-success runs
make-fixer executions -s <SCENARIO_ID> --id <EXECUTION_ID>   # full JSON for one run

# Org/team-wide failure sweep (use this when the user asks "what's broken?")
make-fixer failures --from-url "https://<zone>.make.com/organization/<ORG_ID>/dashboard" --since 24h
make-fixer failures --from-url "https://<zone>.make.com/<TEAM_ID>/scenarios/<SCENARIO_ID>/edit" --since 7d
```

### Status codes are confusing — read this before reasoning about errors

Make.com's execution `status` field doesn't match the labels in the UI:

| API status | API docs say | Make UI label | What you'll actually see |
|------------|--------------|---------------|--------------------------|
| 1 | success | Success | The vast majority of runs |
| 2 | warning | **Error** | Almost every "error" in the UI is status=2 |
| 3 | error | Error | Rare — only fatal, unhandled crashes |

**Always use `--failed` (or `--status failed`) when looking for problems**, not `--status error`.
The `failures` command does this automatically. The status=2/3 distinction is rarely useful;
treat any non-1 execution as something the user wants to know about.

### Discovering teamId / orgId from URLs

Any Make.com URL the user pastes contains the team or organization ID — never ask the user to look it up manually:

| URL shape | What you can extract |
|-----------|---------------------|
| `https://<zone>.make.com/<TEAM_ID>/scenarios/<id>/edit` | `teamId` + `scenarioId` + zone |
| `https://<zone>.make.com/organization/<ORG_ID>/dashboard` | `organizationId` + zone |
| `https://<zone>.make.com/<TEAM_ID>/...` (any team-scoped page) | `teamId` + zone |

Pass any of these to `make-fixer scenarios --from-url <url>` and the CLI auto-parses them. Use `-t <teamId>` or `-o <orgId>` directly only if the user gives you a bare ID.

**When the user hasn't shared a URL at all**, run `make-fixer orgs` to list what the token can access, then `make-fixer teams -o <orgId>` to drill in. Avoid asking the user for IDs they'd have to dig out of the UI.

## Workflow

<HARD-GATE>
Do NOT edit the blueprint, push changes, or take any implementation action until you have presented a plan of changes and the user has approved it. This applies to EVERY scenario regardless of perceived simplicity.
</HARD-GATE>

**Prefer the full Make.com URL whenever the user provides one.** Passing a URL to `-s` is the most reliable form — the zone and scenario ID are auto-detected and no zone discovery is needed:
```bash
make-fixer fetch -s "https://<zone>.make.com/<TEAM_ID>/scenarios/<SCENARIO_ID>/edit"
```
Bare scenario IDs also work: the CLI first tries the configured zone, then auto-probes the other known zones (eu1, eu2, us1, us2) on 401/404 and caches the discovered zone per scenario in `~/.make-fixer/.zones.json`. If you already have a URL in context, pass it to skip the discovery round-trips.

### Determine Mode

Based on what the user provides, choose the right starting point:

- **Existing scenario** (ID or URL provided): Start at Phase 1 — Gather Context
- **New scenario idea** (description of what they want to build): Start at Phase 2 — Brainstorm & Clarify
- **Vague request** ("help me with my automations", "I need a Make scenario"): Start at Phase 2 — Brainstorm & Clarify

### Phase 1: Gather Context (existing scenarios)

When the user provides a scenario ID or URL — immediately fetch and analyze:

```bash
make-fixer fetch -s <ID-or-URL> && make-fixer analyze -s <ID> --local
```

Then **read** the blueprint file (`blueprints/<id>.json`) to understand the scenario structure: what modules exist, how they connect, what the scenario does, and what issues were found.

Present a brief summary to the user:
- Scenario name and what it does (1-2 sentences)
- Module count and flow structure (linear, branching, etc.)
- Issues found by `analyze` (if any)
- **Proactive improvement suggestions** (see below)

#### Proactive Improvement Suggestions

After analyzing a scenario, always look for and suggest improvements — even if the user didn't ask. Present these as observations, not demands:

- **Cost optimization**: Modules that could be consolidated, redundant steps, logic that could be combined into fewer modules. Every module costs operations.
- **Missing error handlers**: Modules making external API calls without `onerror` handlers
- **Fragile patterns**: Hardcoded values that should use variables, missing `ifempty` fallbacks on fields that could be null
- **Naming**: Modules with default names that don't describe what they do
- **Missing documentation**: Complex modules (HTTP, Code, routers, iterators) without sticky notes — fix with `make-fixer notes --add`, NOT by editing the blueprint
- **Structure**: Overly complex routing that could be simplified, unnecessary intermediate modules
- **Reliability**: Missing retry logic, no fallback paths for critical operations
- **If-else opportunity**: Routers where only one branch should run could be replaced with If-else + Merge (see below)

Frame suggestions as: "I also noticed a few things that could be improved — want me to address any of these along with your main request?"

### Phase 2: Brainstorm & Clarify

Ask questions **one at a time** to understand what the user wants to achieve. Prefer multiple-choice questions when possible (using the AskUserQuestion tool), but open-ended is fine too.

**For existing scenarios**, focus on:
- **What** they want to change and **why**
- Which modules or parts of the flow are involved
- Whether they want to fix existing issues, add new functionality, or restructure
- Any constraints (e.g. "don't touch module X", "must keep the existing webhook")
- Whether they also want to address any of the proactive improvement suggestions

**For new scenarios**, focus on:
- **What triggers the scenario?** (webhook, schedule, watching a service, etc.)
- **What's the end goal?** What should happen when the scenario runs successfully?
- **What services/APIs are involved?** (CRM, email, spreadsheets, HTTP APIs, etc.)
- **What data flows between steps?** What inputs does each step need?
- **Error handling requirements?** What should happen when something fails?
- **Volume & frequency?** How often does this run? How many records per run?
- **Edge cases?** What if a field is empty? What if an API is down?

Use the analysis results and blueprint structure to ask **informed** questions. Reference specific modules by their name/ID when asking about existing scenarios.

**Do NOT batch questions.** One question per message. If a topic needs more exploration, break it into multiple questions.

**Keep asking until you have a clear picture.** Don't rush to propose changes. It's better to ask one more question than to propose the wrong thing.

### Phase 3: Propose Approaches

Once you understand what needs to happen:

1. **Propose 2-3 approaches** when there are meaningful alternatives
   - Describe each approach briefly
   - List trade-offs (cost in operations, complexity, reliability, maintainability)
   - Lead with your recommendation and explain why
2. For straightforward changes, present a single clear plan
3. List the specific edits: which modules change, what gets added/removed, what fields are modified
4. For new scenarios, describe the full flow: trigger → processing → output, with module types
5. **Always consider cost**: can this be done with fewer modules? Can steps be combined?

Get explicit user approval before proceeding.

### Phase 4: Edit and Validate

Only after the user approves your plan:

1. **Look up module types**: `make-fixer apps <query>` and `make-fixer modules <app>` to find correct module type strings. **Always look up — never guess module type strings from memory.**
2. **Edit** the blueprint file directly using your Edit tool
3. **Validate** changes: `make-fixer validate -s <id>` — shows diff vs remote (added/removed/modified modules, issue count)
4. Present the validation results to the user
5. If validation reveals issues, fix them and re-validate

### Phase 5: Push

1. **Always ask the user** for explicit confirmation before pushing
2. **Push** when confirmed: `make-fixer push -s <id> --yes`
3. Confirm success to the user

### Module Documentation — Use `make-fixer notes`, NOT Blueprint Edits

<HARD-RULE>
**Notes are NOT part of the blueprint JSON.** They are a separate Make.com API resource attached to a scenario, displayed as sticky-note annotations on modules in the UI. You CANNOT add, edit, or remove notes by editing `blueprints/<id>.json` — there is no `notes` field, `description` field, or `documentation` field on a module that controls this. Any attempt to add documentation by editing the blueprint will be silently ignored on push.

**The ONLY way to manage notes is the `make-fixer notes` command.** This applies whenever the user (or your own proactive suggestion) involves:
- Documenting what a module does
- Adding/updating sticky notes or comments on modules
- Resolving an `analyze` issue of type "missing documentation"
- Annotating routes, branches, or groups of modules
</HARD-RULE>

**List existing notes** (always do this first before adding — avoids duplicates):
```bash
make-fixer notes -s <id-or-url>
```

**Add a note** to one or more modules:
```bash
make-fixer notes -s <id> --add --module 1,2,3 --content "Fetches customer data from CRM and normalizes phone numbers"
```

- `--module` takes comma-separated module IDs. A single note can attach to multiple modules (it spans them visually in the UI).
- `--content` supports HTML — use `<br>` for line breaks, `<b>...</b>` for bold, etc.
- Notes are pushed to Make.com immediately — there is no separate `push` step for notes, and `validate` does NOT diff notes.
- The blueprint file on disk is irrelevant to notes; you do not need to fetch first to add a note, and adding a note does not change `blueprints/<id>.json`.

**When `analyze` flags missing documentation**, the fix is `make-fixer notes --add`, never a blueprint edit. Confirm the plan with the user (which modules, what content) before running the command — same approval gate as any other change.

### Anti-Patterns

**"This Is Too Simple To Need Questions"** — Even "just add an error handler" requires understanding: which modules? what retry settings? should it break or ignore? A quick question prevents wasted work. The questions can be short for simple tasks, but you MUST ask before editing.

**"I'll just add all the modules"** — More modules = more cost. Always look for ways to consolidate. Three similar HTTP calls might be replaceable with one parameterized call inside an iterator. Question every module: is this strictly necessary?

**"The user said what they want, I can just build it"** — The user described their goal, not the design. You need to understand the design before building. Ask about edge cases, error handling, and data flow before proposing a plan.

**"I'll add documentation by editing the blueprint"** — Notes are NOT in the blueprint JSON. There is no module field that controls sticky-note documentation. Use `make-fixer notes --add` for ALL module documentation — see the "Module Documentation" section above.

**"I know the module type string"** — Never assume module type strings from memory. Apps update their module names. Always run `make-fixer apps <query>` then `make-fixer modules <app>` to get the current, correct type strings.

## Blueprint Structure

A blueprint is a JSON object:

```json
{
  "name": "Scenario Name",
  "flow": [
    {
      "id": 1,
      "module": "gateway:CustomWebHook",
      "version": 1,
      "mapper": { ... },
      "metadata": {
        "designer": { "x": 0, "y": 0, "name": "Custom Name" }
      },
      "onerror": [
        { "id": 2, "module": "builtin:Break", "mapper": { "retry": true, "count": 3, "interval": 60 } }
      ],
      "routes": [
        { "flow": [ ... nested modules ... ] }
      ]
    }
  ],
  "metadata": {
    "scenario": {
      "sequential": false,
      "autoCommit": true,
      "maxErrors": 3,
      "confidential": false,
      "freshVariables": false,
      "dataloss": false
    }
  }
}
```

### Key fields

- **id**: Unique integer. Never reuse. New modules must use the next available ID (shown by `fetch` and `validate` commands).
- **module**: Module type string like `app:ModuleName`. **Always look up with `make-fixer apps` + `make-fixer modules` — never guess.**
- **mapper**: Module configuration (API URLs, field mappings, query parameters)
- **parameters**: Connection IDs and module-level settings (separate from mapper)
- **metadata.designer.name**: Custom display name in the Make.com UI
- **onerror**: Error handler array. Standard break handler: `[{ "id": N, "module": "builtin:Break", "version": 1, "mapper": { "retry": true, "count": 3, "interval": 1 } }]`. The `interval` is in **minutes** (1 = 1 minute, 60 = 1 hour). When `mapper` is omitted, Make.com defaults to `count: 3, interval: 15`.
- **routes**: Array of route objects, each containing a `flow` array (for `builtin:BasicRouter`)
- **branches**: Array of branch objects (for `builtin:BasicIfElse` — see If-else & Merge section)
- **filter**: Filter condition between modules. Format: `{ "name": "Filter Name", "conditions": [[{ "a": "{{1.field}}", "b": "value", "o": "equal" }]] }`. Inner array = AND conditions, outer array = OR groups. See filter operators below.

### Filter operators

Standard operators: `equal`, `notEqual`, `greater`, `less`, `greaterOrEqual`, `lessOrEqual`, `text:equal`, `text:notEqual`, `text:startsWith`, `text:endsWith`, `text:contains`, `text:notContains`, `text:matches` (regex), `exist`, `notExist`, `array:contains`, `array:notContains`

**Case-insensitive variants** — append `:ci` to any text operator:
`text:equal:ci`, `text:notEqual:ci`, `text:contain:ci`, `text:notContain:ci`, `text:startsWith:ci`, `text:endsWith:ci`

**Note:** `text:contain` (not `text:contains`) is the actual operator code for substring matching. Both forms may appear in blueprints.

### Scenario settings (`metadata.scenario`)

The blueprint's `metadata.scenario` object controls execution behavior:

| Setting | Description |
|---------|-------------|
| `sequential` | Process bundles one at a time (prevents race conditions in webhook scenarios) |
| `autoCommit` | Auto-commit after each cycle in multi-cycle runs |
| `autoCommitTriggerLast` | Auto-commit applies to trigger module as well |
| `maxErrors` | Consecutive errors before scenario is disabled (instant/webhook scenarios disable after 1st error regardless) |
| `confidential` | Hide execution data (GDPR/HIPAA — disables debugging) |
| `freshVariables` | Reset variables at start of each execution |
| `dataloss` | Allow data loss for uninterrupted throughput |
| `dlq` | Dead letter queue enabled |

### Module types — builtin only

<HARD-RULE>
**NEVER hardcode or guess app-specific module type strings** (e.g., `google-sheets:filterRows`, `powerlink:plquery`). Apps change their module names between versions. Always run `make-fixer apps <query>` then `make-fixer modules <app-name>` to get the current correct type string before adding any app module to a blueprint.
</HARD-RULE>

The only module types you can use from memory are the **builtin** and **utility** modules — these are stable platform primitives:

**Flow control (`builtin:*`):**
- `builtin:BasicRouter` — router, splits into parallel routes (has `routes` array, `mapper` is always `null`)
- `builtin:BasicFeeder` — iterator, splits arrays into individual bundles. Mapper: `{"array": "{{...}}"}`
- `builtin:BasicAggregator` — array aggregator, merges bundles back. Mapper: `{}`, Parameters: `{"feeder": <iterator-module-id>}`
- `builtin:BasicRepeater` — repeater, runs N times. Mapper: `{"start": "1", "repeats": "5", "step": "1"}`
- `builtin:BasicIfElse` — if-else conditional routing (see If-else & Merge section below)
- `builtin:BasicMerge` — merge if-else branches back together (see If-else & Merge section below)

**Error handlers (`builtin:*`):**
- `builtin:Break` — pause and retry. Mapper: `{"retry": true, "count": 3, "interval": 15}`
- `builtin:Resume` — continue with fallback values. Mapper maps output fields from retry module.
- `builtin:Ignore` — skip and continue. Mapper: `{}`
- `builtin:Commit` — save progress and stop. Mapper: `{}`
- `builtin:Rollback` — revert ACID changes and stop. Mapper: `{}`

**Utility (`util:*`):**
- `util:SetVariables` — set multiple variables. Mapper: `{"variables": [{"name": "", "value": ""}], "scope": "roundtrip"}`
- `util:SetVariable2` — set single variable. Mapper: `{"name": "", "scope": "roundtrip", "value": ""}`
- `util:GetVariables` — get multiple variables. Mapper: `{"variables": ["varName"]}`
- `util:GetVariable2` — get single variable. Mapper: `{"name": ""}`
- `util:FunctionSleep` — delay. Mapper: `{"duration": "1"}` (seconds, max 300)
- `util:FunctionIncrement` — counter. Parameters: `{"reset": "run"}`
- `util:FunctionAggregator2` — numeric aggregator (sum/avg). Parameters: `{"fn": "sum", "feeder": 0}`
- `util:TextAggregator` — text aggregator. Parameters: `{"rowSeparator": "", "feeder": 0}`
- `util:AggregateAggregator` — table aggregator. Parameters: `{"columnSeparator": "", "rowSeparator": "", "feeder": 0}`
- `util:Switcher` — switch/pattern matching. Mapper: `{"input": "", "casesTable": [{"pattern": "", "output": ""}], "elseOutput": ""}`

**Other platform modules:**
- `gateway:CustomWebHook` — instant webhook trigger
- `gateway:WebhookRespond` — send HTTP response back to webhook caller
- `json:ParseJSON` — parse JSON string to collection
- `json:AggregateToJSON` — aggregate bundles into JSON string. Parameters: `{"type": <data-structure-id>, "feeder": <source-module-id>}`
- `xml:ParseXML` — parse XML string to collection. Mapper: `{"xml": "{{...}}"}`
- `code:ExecuteCode` — JavaScript code module (last resort — see Native-First section)
- `placeholder:Placeholder` — empty placeholder module (used in If-else Else routes)

**HTTP modules** have auth-specific variants — the type string changes based on authentication method. Always look up with `make-fixer modules http` to get the exact variant name (e.g., `http:ActionSendData` vs `http:ActionSendDataBasicAuth` vs `http:ActionSendDataAPIKeyAuth`).

### Expression syntax

Expressions use `{{...}}` delimiters inside module mapper fields.

**Critical rules:**
- **Arguments are separated by semicolons `;`** — NEVER use commas. Example: `{{if(1.status = "active"; "Yes"; "No")}}`
- **Module output references:** `{{moduleId.fieldName}}` — e.g. `{{1.phone}}`, `{{3.data.email}}`
- **Nested data:** use dot notation — `{{1.body.results.0.name}}`
- **Array indexing starts at 1** (not 0) when using `get()` — `{{get(1.items; 1)}}` returns first item
- **Functions can be nested:** `{{upper(substring(1.name; 0; 1))}}` — uppercase first letter
- **`now` and `timestamp` are variables, NOT functions** — write `{{now}}` not `{{now()}}`
- **Comparison operators in expressions:** `=`, `!=`, `<`, `>`, `<=`, `>=`
- **Logical operators:** `and`, `or`, `not`
- **Arithmetic:** `+`, `-`, `*`, `/`, `%`

### Variable references

Modules reference other modules' output with `{{moduleId.fieldName}}`:
- `{{1.phone}}` — field `phone` from module #1
- `{{ifempty(1.phone; 0121231234)}}` — with fallback

### `ifempty` fallback values

`ifempty` is used to prevent null/empty values from breaking API calls or queries. The fallback must:
1. **Match the data type of the field** — an email field gets a fake email, a phone field gets a fake phone number, etc.
2. **Never actually match a real record** — the purpose is to let the query run and return zero results.
3. **Never use quoted strings for numeric-like fields** — quotes break most APIs. Write `0121231234` not `"0121231234"`.
4. **Be a realistic-looking value** — not random gibberish, not empty strings, not single characters.

Examples:
- Email field: `{{ifempty(6.email; nomatch@invalid.test)}}`
- Phone field: `{{ifempty(6.phone; 0121231234)}}`
- ID/UUID field: generate a random UUID for each `ifempty` — e.g. `{{ifempty(6.id; f47ac10b-58cc-4372-a567-0e02b2c3d479)}}`. Never reuse the same UUID across different `ifempty` calls.

### Set/Get Variables

There are 4 variable modules — use them correctly:

**Set Variable** (`util:SetVariable2`) — sets a single variable:
```json
{ "mapper": { "name": "myVar", "scope": "roundtrip", "value": "{{1.someField}}" } }
```

**Set Multiple Variables** (`util:SetVariables`) — sets multiple variables at once:
```json
{ "mapper": { "variables": [{ "name": "x", "value": "{{1.field1}}" }, { "name": "y", "value": "{{1.field2}}" }], "scope": "roundtrip" } }
```

**Get Variable** (`util:GetVariable2`) — retrieves a single variable:
```json
{ "mapper": { "name": "myVar" } }
```

**Get Multiple Variables** (`util:GetVariables`) — retrieves multiple variables. **Variables are plain strings, NOT objects:**
```json
{ "mapper": { "variables": ["x", "y"] } }
```

**Variable lifetime (`scope`):**
- `"roundtrip"` = **One Cycle** — persists for one cycle of the scenario
- `"execution"` = **One Execution** — persists for the entire scenario execution

**Important behavior:** Variables with `"roundtrip"` scope do NOT reset between iterator iterations. They persist until explicitly overwritten. If you need per-iteration isolation, use a different pattern (e.g., inline expressions or aggregators).

**Referencing variable output in downstream modules:**
- `util:GetVariables` (multiple): outputs use variable names — `{{moduleId.myVarName}}`
- `util:GetVariable2` (single): output is always named `value` — `{{moduleId.value}}`

**Cost:** Prefer multi-variable modules. `util:SetVariables` with 5 vars = **1 operation**. Five `util:SetVariable2` = **5 operations**.

**Variable naming:** Case-sensitive (`"myVar"` and `"myvar"` are different). Literal strings only — expressions NOT supported in name fields. Typos between Set and Get cause **silent null returns** (no error thrown).

**When to use Set/Get Variables vs inline expressions:**
- Use variables when you need to **pass data between different routes** (after a Router)
- Use variables when a value is **computed once but referenced many times** across distant modules
- Use **inline expressions** (`{{1.field}}`) when data flows linearly — direct module references are simpler, cheaper (no extra module), and clearer

### Inline functions quick reference

<HARD-RULE>
**NEVER fabricate, guess, or invent inline functions.** If you're unsure whether a function exists, check [FUNCTIONS_REFERENCE.md](FUNCTIONS_REFERENCE.md) — it is the canonical list. If a function is not listed there, it does not exist. There is no `dateDifference`, `startOfDay`, `endOfDay`, `toBoolean`, `toNumber`, `log`, `ln`, or `values` function.
</HARD-RULE>

For the **complete function catalog** (70+ functions with signatures, parameters, return types, date/time tokens, filter operators, data types, and type coercion rules), read [FUNCTIONS_REFERENCE.md](FUNCTIONS_REFERENCE.md).

**Most-used functions** (see FUNCTIONS_REFERENCE.md for full list):

| Category | Key functions |
|----------|--------------|
| **Control flow** | `if`, `ifempty`, `switch`, `coalesce` |
| **Collections** | `get`, `pick`, `omit`, `keys`, `map`, `toArray`, `toCollection` |
| **Strings** | `contains`, `replace`, `split`, `join`, `substring`, `trim`, `lower`, `upper`, `length`, `toString`, `indexOf` |
| **Arrays** | `map`, `join`, `merge`, `flatten`, `sort`, `first`, `last`, `length`, `add`, `remove`, `deduplicate`, `slice` |
| **Math** | `round`, `ceil`, `floor`, `abs`, `sum`, `max`, `min`, `formatNumber`, `parseNumber` |
| **Dates** | `formatDate`, `parseDate`, `addDays`, `addHours`, `addMinutes`, `addMonths`, `setDate`, `setDay` |

**Variables (no parentheses):** `now`, `timestamp`, `random`, `pi`, `newline`

**Special values:** `true`, `false`, `null`, `emptystring` (forces truly empty output — not `""`, not `null`), `newline` (literal line break — useful in `replace(text; newline; "<br />")`)

## If-else & Merge (Open Beta)

The **If-else** module (`builtin:BasicIfElse`) and **Merge** module (`builtin:BasicMerge`) are a new pair for conditional routing where only one branch executes and routes can be reconnected.

### If-else vs Router

| | If-else (`builtin:BasicIfElse`) | Router (`builtin:BasicRouter`) |
|---|---|---|
| **Execution** | Runs **only the first matching** condition | Runs **all matching** routes |
| **Merge back** | Routes can be merged with `builtin:BasicMerge` | Routes **cannot** be reconnected |
| **Cost** | Uses operations but **no credits** (free) | Uses operations and credits |
| **Nesting** | Cannot nest Router or another If-else inside | Can nest freely |
| **Use when** | Exactly one path should run based on conditions | Multiple paths may need to run in parallel |

### If-else blueprint structure

```json
{
  "id": 71,
  "module": "builtin:BasicIfElse",
  "version": 1,
  "mapper": null,
  "filter": null,
  "branches": [
    {
      "type": "condition",
      "label": "Record Doesn't Exist",
      "merge": true,
      "conditions": [[{ "a": "{{13.recordId}}", "o": "notexist" }]],
      "flow": [
        { "id": 38, "module": "...", ... }
      ]
    },
    {
      "type": "else",
      "label": "",
      "merge": true,
      "disabled": false,
      "flow": [
        { "id": 72, "module": "placeholder:Placeholder", ... }
      ]
    }
  ]
}
```

**Key differences from Router:**
- Uses `branches` array (not `routes`)
- Each branch has `type` (`"condition"` or `"else"`), `label`, `conditions`, and `merge` (whether it connects to a Merge module)
- Conditions live on the **branch object** (not on filters of the first module in the flow)
- The last branch is always `"type": "else"` — runs if no conditions matched
- Empty branches use `placeholder:Placeholder` as a "Do Nothing" module

### Merge blueprint structure

```json
{
  "id": 73,
  "module": "builtin:BasicMerge",
  "version": 1,
  "mapper": null,
  "filter": null,
  "filters": [null, null],
  "outputs": [
    {
      "name": "outputFieldName",
      "mappings": [
        "{{38.someField}}",
        "{{13.someField}}"
      ]
    }
  ]
}
```

**Key fields:**
- `outputs` — array of named output fields. Each output has a `name` and `mappings` array.
- `mappings` — one entry per branch (in order). Maps the value from whichever branch actually ran.
- `filters` — one filter per incoming branch (usually `null`).
- Downstream modules reference merge output as `{{mergeModuleId.outputFieldName}}`.

### When to use If-else + Merge

- **Conditional create-or-update**: Check if record exists → create on one branch, skip on else → merge back to continue with the record ID regardless of which path ran.
- **Conditional enrichment**: Different API calls based on data type → merge results into a single output for downstream processing.
- **Replace Router with If-else** when only one branch should ever run (saves operations since Router runs all matching routes).

## Rules

1. **Never reuse module IDs.** Check the "Next ID" shown by `fetch` or `validate`.
2. **Always validate before pushing.** Run `make-fixer validate -s <id>` to check your changes.
3. **Always ask the user before pushing.** Show them what changed and get explicit confirmation.
4. **Preserve the `idSequence` field** if present — it is server-managed.
5. **Error handlers need their own unique IDs** — they are separate modules in the `onerror` array.
6. **Position modules visually** using `metadata.designer.x` and `metadata.designer.y`. Increment `x` by ~300 for each subsequent module.
7. **Always look up module type strings** with `make-fixer apps` + `make-fixer modules` before adding app modules. Never guess from memory.

## Native-First Problem Solving

<HARD-RULE>
**Exhaust every native Make.com capability before suggesting a Code module.** A Code module is a last resort, not a default answer. When something seems "impossible" natively, that is a signal to think more creatively — not to reach for code.
</HARD-RULE>

Almost any data transformation, conditional logic, or output shaping can be achieved natively using a combination of inline functions, raw string bodies, and expression composition. The techniques below are your toolkit. Work through all of them before concluding that native is insufficient.

### Native Techniques Checklist

Before proposing a Code module, confirm you have considered **every** technique below:

| Technique | What it unlocks |
|-----------|----------------|
| **Raw string body** | HTTP module body set to `Raw` accepts full `{{...}}` expressions, string concatenation (`+`), and conditionals. Unlocks patterns that structured/mapped field mode cannot express. |
| **String concatenation (`+`)** | Build values character by character — inject quotes, colons, commas, brackets, and entire JSON structures manually. `"\"key\": \"" + {{1.value}} + "\""` |
| **`emptystring`** | Produces truly zero output — not `""`, not `null`, not whitespace. Use it to make entire lines, keys, or segments disappear. |
| **`if` + `emptystring`** | Conditionally include or entirely exclude any piece of output: JSON keys, URL parameters, headers, body segments, array elements. The core pattern for conditional structures. |
| **`ifempty` + `coalesce`** | Fallback chains across multiple possible source fields. `coalesce(1.mobile; 1.phone; 1.altPhone; "no-phone")` |
| **Nested function composition** | Functions nest to arbitrary depth. A single expression can parse, transform, format, and conditionally output a value. `{{if(length(trim(1.name)) > 0; upper(substring(trim(1.name); 0; 1)) + lower(substring(trim(1.name); 1)); emptystring)}}` |
| **`switch`** | Replaces multi-branch if/else logic natively. Cleaner than nested `if` for 3+ conditions. |
| **`omit` / `pick`** | Shape collections without touching individual keys. Pass through an entire object minus sensitive fields, or extract only the fields you need. |
| **`map` + `join`** | Dynamically build comma-separated lists, query strings, or structured text from arrays. `{{join(map(1.items; "name"); ", ")}}` |
| **`toArray` + `join`** | Serialize entire collections into structured strings. Convert key-value pairs into URL params, header strings, or custom formats. |
| **`replace` with regex** | Pattern-based transformations on strings — extract, reformat, strip, or restructure text without code. |
| **`newline` variable** | Literal line break for use in `replace`: `replace(text; newline; "<br />")`. Also useful for building multi-line raw bodies. |

### Worked Example: Conditional JSON Keys

**Problem:** Build an HTTP request body where some JSON keys should only appear if their value exists. Structured mode always sends every mapped field (as `null` or `""`), but the API rejects unknown or empty keys.

**Naive reaction:** "This requires a Code module to build the JSON dynamically."

**Native solution:** Use Raw body mode with `if` + `emptystring` + string concatenation.

```
{
  "name": "{{1.name}}",
  "email": "{{1.email}}"{{if(length(ifempty(1.phone; emptystring)) > 0; ",\n  \"phone\": \"" + 1.phone + "\""; emptystring)}}{{if(length(ifempty(1.company; emptystring)) > 0; ",\n  \"company\": \"" + 1.company + "\""; emptystring)}}
}
```

**How it works:**
1. `name` and `email` are always present (required fields)
2. For each optional field: `if` checks whether the value has content
3. If yes → emits `,"phone": "value"` (including the leading comma)
4. If no → emits `emptystring` (truly nothing — no comma, no key, no trace)
5. The result is valid JSON with only the keys that have values

**The pattern:** `{{if(length(ifempty(FIELD; emptystring)) > 0; ",\"KEY\": \"" + FIELD + "\""; emptystring)}}`

This same pattern extends to:
- **Conditional URL parameters:** `{{if(1.page; "&page=" + 1.page; emptystring)}}`
- **Conditional headers:** include or exclude entire header lines
- **Conditional array elements:** build arrays with only populated values
- **Conditional XML nodes:** same `if` + `emptystring` pattern works for any text format

### When a Code Module IS Justified

Only suggest a Code module when **all three conditions are checked** and at least one applies:

1. **Untrusted data** — The values being inserted could contain characters that break string-built structures (unescaped quotes, backslashes, newlines, unicode). Raw string concatenation with user-generated content risks producing malformed JSON/XML. A Code module with proper `JSON.stringify()` is safer.
2. **Looping/recursion** — The logic requires iterating in ways Make.com's Iterator + Aggregator pattern cannot handle (e.g., recursive tree traversal, variable-depth nesting, complex accumulation across iterations).
3. **Unmaintainable complexity** — The expression would exceed ~200 characters or nest more than 4 levels deep, making it unreadable and un-debuggable. At that point, a Code module with comments is more maintainable.

If none of these apply, the answer is native. Go back to the techniques checklist.

## Common Operations

### Add error handler to a module

Standard break handler (works for most scenarios including webhooks — Make.com auto-responds `200 Accepted` to webhook callers):
```json
"onerror": [{ "id": NEXT_ID, "module": "builtin:Break", "version": 1, "mapper": { "retry": true, "count": 3, "interval": 1 } }]
```

**Only when the scenario uses `gateway:WebhookRespond` for custom responses** — add a WebhookRespond + Commit in the error handler to return an error response to the caller. See [BEST_PRACTICES.md](BEST_PRACTICES.md) for this pattern and the full error handler decision guide.

### Rename a module
Set `metadata.designer.name`:
```json
"metadata": { "designer": { "x": 300, "y": 0, "name": "Descriptive Name" } }
```

### Add a new module to the flow
Insert into the `flow` array at the desired position with a unique ID.

### Add a route
Add an object with a `flow` array to a router module's `routes` array. **Filters go on the first module of each route's `flow` array** — NOT on the router itself. The router's mapper is always `null`.

### Add an If-else branch
Add an object to the `branches` array of a `builtin:BasicIfElse` module. Conditions live on the branch object, not on filters. The last branch must always be `"type": "else"`.

### Quoting strings inside expressions
Inside `{{...}}`, use single quotes to avoid JSON escaping issues:
```json
{ "field": "{{ifempty(1.name; 'Unknown')}}" }
```

## Cost Optimization Principles

- **Every module run costs operations and credits.** Always build scenarios with the minimum number of modules needed.
- **Free modules (operations but no credits):** `builtin:BasicIfElse`, `builtin:BasicMerge`, `scenario-service:NameExecution` ("Name a Run"). Use these freely.
- Consolidate logic where possible. Prefer fewer modules doing more over many modules doing little.
- When proposing approaches, always include the operation cost comparison (e.g. "Approach A: 5 modules per run, Approach B: 3 modules per run").
- Actively question every module: is this strictly necessary? Can it be combined with another step?
- **Prefer If-else over Router** when only one branch should run — Router executes all matching routes (wasting operations on unused branches).

## Handling Arguments

When invoked with arguments (`$ARGUMENTS`), determine the starting point:

**URL or numeric ID?** → Phase 1: `make-fixer fetch -s $ARGUMENTS` then analyze and summarize.
**Description of what to build?** → Phase 2: Begin brainstorming questions immediately.
**Both ID and description?** → Fetch first, then use the description to inform your clarifying questions.

In all cases, go through the workflow phases. Never skip to editing.
