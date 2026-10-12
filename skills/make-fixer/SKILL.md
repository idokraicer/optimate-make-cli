---
name: make-fixer
description: Fetches, analyzes, edits, builds, debugs, and pushes Make.com (formerly Integromat) scenario blueprints via the make-fixer CLI. Use when the user mentions Make.com scenarios, blueprints, modules, automation workflows, routers, if-else, iterators, aggregators, webhooks, executions, failed runs, operations cost, subscenarios, data stores, AI agents in Make, or wants to create, debug, optimize, or improve any Make.com automation. Also use for Make.com inline functions and expressions (formatDate, parseDate, ifempty, switch, get, map) and filter operators. This skill and its topic references are the primary source of truth for all Make.com work.
user-invocable: true
---

# Make.com Scenario Editor & Builder

Fetch, edit, validate, push and debug Make.com scenarios with the `make-fixer` CLI, and design new ones with
the user.

## Topic references — load ONLY the one the task needs

This file holds the workflow and the hard rules. The details live in topic files; read a file when its
trigger applies, not up front.

| Trigger | File |
|---|---|
| Reading or editing blueprint JSON: modules, filters/operator codes, router, if-else + merge, iterator, aggregator, variables, scenario settings | [references/blueprint-format.md](references/blueprint-format.md) |
| Writing `{{…}}` mappings, `ifempty` fallbacks, or a mapped field came back empty | [references/mapping.md](references/mapping.md) |
| Any inline function, date token, or "does this function exist?" | [FUNCTIONS_REFERENCE.md](FUNCTIONS_REFERENCE.md) |
| About to propose a Code module, or a transform looks "impossible" | [references/native-first.md](references/native-first.md) |
| Adding/reviewing error handlers, retries, 429s, webhook error responses | [references/error-handling.md](references/error-handling.md) |
| A run failed, "what's broken?", execution history, per-module bundles, a webhook receives nothing | [references/debugging.md](references/debugging.md) |
| Subscenarios / on-demand, data stores and dedup, bulk or long runs, production settings | [references/architecture.md](references/architecture.md) |
| AI provider modules, Make AI Tools, the AI Agent module and its tools | [references/ai.md](references/ai.md) |
| Google Sheets, Gmail, date-math configuration | [references/app-gotchas.md](references/app-gotchas.md) |
| Naming, safe testing, pre-activation cost checklist, versioning | [references/conventions.md](references/conventions.md) |
| monday.com modules or GraphQL in Make | the `monday-make-modules` skill |

## Installation

The `make-fixer` CLI lives in a **separate repo** ([github.com/idokraicer/optimate-make-cli](https://github.com/idokraicer/optimate-make-cli)) and must be installed manually — it is NOT bundled with this plugin.

Before first use, check if `make-fixer` is available (`Get-Command make-fixer`
on Windows PowerShell or `command -v make-fixer` on macOS/Linux). If the command
is not found, walk the user through:

1. **Install Bun and Git** using their current platform-specific official instructions, then open a fresh shell.
2. **Install the CLI globally:**
   ```bash
   bun install -g git+https://github.com/idokraicer/optimate-make-cli.git
   ```
3. **Verify the executable:** `make-fixer --help`

If the command remains unavailable, point the user to Bun's installation output
and [PATH instructions](https://bun.sh/docs/installation), then have them open a
fresh shell.

Full setup steps (including how to get a Make.com API token) are in the plugin's [README.md](../../README.md).

## Setup

The API token is stored once for the current OS user at `~/.make-fixer/.env`
(inside the Windows user profile on Windows) and works from any directory. Bun
stores the globally installed executable separately; projects do not need a
local token or `.env` entry.

First run the read-only `make-fixer orgs` command. If it succeeds, preserve the
working credentials. If authentication is missing, never ask the user to paste
their token into chat and never pass it through an AI-managed terminal. Direct
the user to the secure PowerShell, bash, or zsh login block in the plugin's
[README.md](../../README.md), which they must run in their own local terminal.
Afterward, verify authentication with `make-fixer orgs`.

`make-fixer --help` verifies only the executable, not authentication. Do not use
`whoami` or `--help` as an authentication check.

The default base URL is `https://eu1.make.com`. For another Make zone, have the
user add the matching `--base-url`, such as `https://us1.make.com`, to the secure
login command in their own terminal. Running login again updates the existing
token.

If a command fails with "MAKE_API_TOKEN not found", have the user repeat the
secure login flow in their own terminal. Diagnose network and Make zone/base URL
errors separately instead of assuming credentials are missing.

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
| `executions` | List recent executions for a scenario (or fetch one) | `-s <id-or-url>`, `--id <rawExecutionId>`, `--include-input` (retained webhook request when safely matched), `--failed`, `--status success\|incomplete\|error\|failed`, `--limit`, `--from <date>`, `--to <date>`, `--since 30m\|2h\|7d\|1mo`, `--json`, `--compact`, `--output <file>` |
| `failures` | Scan an entire team/org for recently failed executions | `-t <teamId>` / `-o <orgId>` / `--from-url <url>`, `--since 1h\|24h\|7d\|30d`, `--limit <n>` (per scenario), `--include-paused`, `--json` |

### Useful patterns

```bash
make-fixer fetch -s "<scenario-url>" && make-fixer analyze -s <id> --local   # start of every existing-scenario task
make-fixer analyze -s <id> --local --var myVariableName                      # trace a variable
make-fixer fix -s <url> --dry-run                                            # preview auto-fixes
make-fixer apps <query> && make-fixer modules <app-name>                     # module type strings — never guess
make-fixer resume -s <id> --errored 5 --from 20                              # Resume module for the 429 pattern
make-fixer notes -s <id> --add --module 1,2,3 --content "What these modules do"
make-fixer orgs && make-fixer teams -o <ORG_ID>                              # no URL shared yet
make-fixer scenarios --from-url "<any make.com url>" --search "webhook"
make-fixer failures --from-url "<org or team url>" --since 24h               # "what's broken?"
```

For execution history, status codes and per-module bundles, see [references/debugging.md](references/debugging.md).

### IDs from URLs — never ask the user to dig them up

| URL shape | Gives |
|---|---|
| `https://<zone>.make.com/<TEAM_ID>/scenarios/<id>/edit` | teamId + scenarioId + zone |
| `https://<zone>.make.com/organization/<ORG_ID>/dashboard` | organizationId + zone |

Pass the full URL to `-s` / `--from-url` whenever you have one. Bare IDs also work: the CLI probes
eu1/eu2/us1/us2 and caches the zone in `~/.make-fixer/.zones.json`. With no URL at all, start from
`make-fixer orgs`.

## Workflow

<HARD-GATE>
Do NOT edit the blueprint, push changes, add notes, or take any implementation action until you have presented a plan of changes and the user has approved it. This applies to EVERY scenario regardless of perceived simplicity.
</HARD-GATE>

**Mode:**
- An existing scenario (ID/URL) → Phase 1.
- A new idea or a vague request → Phase 2.
- An ID plus a description → fetch first, then use the description to drive your questions.

### Phase 1 — Gather context

1. Run `make-fixer fetch -s <url> && make-fixer analyze -s <id> --local`, then read `blueprints/<id>.json`.
2. Summarize:
   - what the scenario does (1–2 sentences);
   - module count and flow shape;
   - the issues `analyze` found;
   - proactive suggestions, framed as "I also noticed a few things — want me to address any?":
     - **Cost:** modules that could be merged; an Iterator after a search module; a Get Variable after a Set on
       the same path; a router whose routes are mutually exclusive (→ if-else).
     - **Risky failure points:** external calls where a failure is costly (payments, sync,
       customer-facing, known rate limits) and has no handler. Don't flag low-stakes steps
       (`references/error-handling.md`).
     - **Fragile mappings:** missing `ifempty` on nullable fields, hard-coded values, malformed filter
       operator codes.
     - **Naming and docs:** default module names; complex modules without notes (fix with
       `make-fixer notes`).

### Phase 2 — Brainstorm & clarify

Ask **one question per message**, multiple-choice when possible.
- **Existing scenario:** what changes and why, which modules, constraints, and which suggestions to include.
- **New scenario:**
  - the trigger;
  - the end goal;
  - every app **by name** (ask when the user names a category like "email" or "AI");
  - the data flow;
  - what happens to items that don't match;
  - failure requirements;
  - volume and frequency;
  - edge cases.
- Keep asking until the picture is clear.

### Phase 3 — Propose

- Offer 2–3 approaches when real alternatives exist, recommendation first, each with **operations per run**,
  complexity and reliability. Use a single plan when the change is straightforward.
- List the exact edits: modules added, removed or changed, and the fields touched.
- Don't over-build: no handlers, aggregators, variables or data stores unless the design needs them.
- Get explicit approval.

### Phase 4 — Edit & validate

1. Look up module types (`make-fixer apps` → `make-fixer modules`). Load
   [references/blueprint-format.md](references/blueprint-format.md) before writing JSON.
2. Edit `blueprints/<id>.json`.
3. Run `make-fixer validate -s <id>` and show the user the diff. Fix any issues and validate again.

### Phase 5 — Push & verify

1. Get explicit confirmation, then run `make-fixer push -s <id> --yes`.
2. Verify with a real run where possible:
   - polling, scheduled and on-demand scenarios can be run directly;
   - a webhook only runs on a real request, so have the user send one;
   - then check `make-fixer executions`.

## Hard rules

<HARD-RULE>
**Notes are not in the blueprint.** Sticky-note documentation is a separate API resource. Manage it ONLY with
`make-fixer notes -s <id>` (list first, to avoid duplicates) and `make-fixer notes -s <id> --add --module 1,2
--content "..."` (HTML allowed). Notes save immediately: no push, and `validate` does not diff them. Get the
same approval as any other change. Never add `notes`, `description` or `documentation` fields to modules —
they are silently dropped.
</HARD-RULE>

<HARD-RULE>
**Never guess app module type strings** (e.g. `google-sheets:filterRows`). Apps rename modules between
versions. Run `make-fixer apps <query>` then `make-fixer modules <app>`. Only the builtin/util/gateway types
in `references/blueprint-format.md` may be written from memory. HTTP modules change type by auth method.
</HARD-RULE>

<HARD-RULE>
**Never invent inline functions or filter operator codes.** Functions come from
[FUNCTIONS_REFERENCE.md](FUNCTIONS_REFERENCE.md). If a function isn't listed, it doesn't exist (no
`dateDifference`, `startOfDay`, `endOfDay`, `toBoolean`, `toNumber`, `log`, `ln`, `values`). Operator codes
come from `references/blueprint-format.md`. A wrong function or code saves fine and fails, or never matches,
at run time.
</HARD-RULE>

<HARD-RULE>
**Native first.** A Code module is a last resort — read [references/native-first.md](references/native-first.md) before proposing one.
</HARD-RULE>

**Blueprint essentials:**
- Never reuse module IDs; take the next free one. Error handlers need their own IDs.
- Preserve `idSequence`.
- Validate before every push and get confirmation before pushing.
- Position new modules with `metadata.designer.x`/`y`, about 300 apart.
- When you remove or move a module, fix every reference to it in the same edit.

**Expression essentials** (details in `references/mapping.md`):
- Arguments are separated by `;`.
- `{{moduleId.field}}` references; array indexes are 1-based.
- `now`, `timestamp` and `uuid` take no parentheses.
- AND/OR are `&`/`|`.

## Cost principles

- Every module run costs operations and credits, so use the minimum number of modules.
- Free of credits: if-else, Merge, "Name a run" (`scenario-service:NameExecution`), and `CallSubscenario`
  calls.
- Prefer if-else over a router when only one route should run.
- Prefer one multi-variable `util:SetVariables` over several single-variable modules.
- Map `{{setId.name}}` directly instead of adding a Get Variable module.
- Don't add an Iterator after search/list modules; they already iterate.
- Always state the operation cost of each proposed approach.

## Handling arguments

`$ARGUMENTS` is a URL or ID → Phase 1. A description → Phase 2. Both → fetch first, then ask. Never skip
straight to editing.
