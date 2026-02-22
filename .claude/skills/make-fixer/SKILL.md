---
name: make-fixer
description: Edit Make.com scenario blueprints. Use when the user mentions Make.com scenarios, blueprints, modules, or automation editing.
user-invocable: true
---

# Make.com Scenario Editor

You can fetch, edit, validate, and push Make.com scenario blueprints using the `make-fixer` CLI.

## Installation

Before first use, check if `make-fixer` is available by running `make-fixer --version`. If the command is not found, install it:

```bash
git clone https://github.com/idokraicer/make-fixer.git ~/.make-fixer
cd ~/.make-fixer && bun install && bun link
```

This registers the `make-fixer` command globally. Requires [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`).

## Setup

The API token is stored globally at `~/.make-fixer/.env` and works from any directory.

To configure, run: `make-fixer login --token <YOUR_TOKEN>`

**IMPORTANT:** Always use `--token <token>` flag. Do NOT run bare `make-fixer login` — the interactive prompt does not work inside Claude Code.

Optionally set a custom base URL: `make-fixer login --token <token> --base-url https://us1.make.com` (default: `https://eu1.make.com`). Running login again updates the existing token.

If a command fails with "MAKE_API_TOKEN not found", ask the user for their token and run `make-fixer login --token <token>`.

## Workflow

When the user provides a scenario ID or URL, immediately run these steps without waiting:

1. **Fetch and analyze in one go:**
   ```bash
   make-fixer fetch -s <ID> && make-fixer analyze -s <ID> --local
   ```
   This saves the blueprint to `blueprints/<id>.json` and prints issues.

2. **Read** the blueprint file to understand the scenario: `blueprints/<id>.json`

3. **Edit** the file directly using your Edit tool

4. **Validate** changes: `make-fixer validate -s <id>`
   Shows diff vs remote (added/removed/modified modules, issue count)

5. **Push** when ready: `make-fixer push -s <id> --yes`
   Always ask the user for confirmation before pushing

**To extract a scenario ID from a Make.com URL:** the ID is the number after `/scenarios/` — e.g. `https://eu1.make.com/303722/scenarios/4227637/edit` → scenario ID is `4227637`.

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
        { "id": 2, "module": "builtin:Break", "mapper": { "retry": true, "count": 3, "interval": 15 } }
      ],
      "routes": [
        { "flow": [ ... nested modules ... ] }
      ]
    }
  ]
}
```

### Key fields

- **id**: Unique integer. Never reuse. New modules must use the next available ID (shown by `fetch` and `validate` commands).
- **module**: Module type string like `gmail:sendEmail`, `powerlink:plquery`, `http:ActionSendData`
- **mapper**: Module configuration (API URLs, field mappings, query parameters)
- **metadata.designer.name**: Custom display name in the Make.com UI
- **onerror**: Error handler array. Standard break handler: `[{ "id": N, "module": "builtin:Break", "version": 1, "mapper": { "retry": true, "count": 3, "interval": 15 } }]`. The `interval` is in **minutes** (integer, 1–44640). `count` is number of retries (integer, 1–10). When `mapper` is omitted, Make.com defaults to `count: 3, interval: 15` (3 retries, 15 minutes).
- **routes**: Array of route objects, each containing a `flow` array (for router modules)
- **filter**: Filter condition between modules. Format: `{ "name": "Filter Name", "conditions": [[{ "a": "{{1.field}}", "b": "value", "o": "equal" }]] }`

### Module types

Excluded from checks (utility): `builtin:*`, `gateway:*`, `json:*`, `tools:*`, `util:*`, `flow:*`, `code:*`

Common types:
- Triggers: `gateway:CustomWebHook`, `google-sheets:watchRows`
- API calls: `http:ActionSendData`, `http:MakeRequest`
- CRM: `powerlink:plquery`, `powerlink:createObject`, `powerlink:updateObject`
- Communication: `gmail:sendEmail`, `slack:sendMessage`
- Routing: `flow:Router` (has `routes` array)

### Variable modules

**Get Multiple Variables** (`util:GetVariables`) — `variables` is an array of **plain strings**:
```json
"mapper": { "variables": ["myVar1", "myVar2"] }
```

**Set Multiple Variables** (`util:SetVariables`) — `variables` is an array of **objects** with `name` and `value`, plus a `scope` field:
```json
"mapper": {
  "scope": "roundtrip",
  "variables": [
    { "name": "myVar", "value": "{{1.fieldName}}" }
  ]
}
```
`scope` is `"roundtrip"` (one cycle) or `"execution"` (entire execution).

**WARNING:** These two formats are different. Do NOT use objects for Get or plain strings for Set. When in doubt, copy the exact format from an existing working module in the blueprint.

### Variable references

Modules reference other modules' output with `{{moduleId.fieldName}}`:
- `{{1.phone}}` — field `phone` from module #1
- `{{ifempty(1.phone; "")}}` — with fallback

### Branch scope — CRITICAL

Each route of a Router is an independent execution branch. **Modules in different routes cannot see each other's output.**

```
#5 (upstream)
  ↓
[Router]
  ├─ Route 1: #10 → #11          ← #10 output visible only here
  ├─ Route 2: filter {{10.body.x}}  ← BROKEN: #10 is in Route 1, invisible here
  └─ Route 3: (continue)
       ↓
      #20 (downstream)            ← {{5.x}} works, {{10.x}} does NOT
```

Only **upstream (pre-router)** data is accessible in all routes and downstream. To share data produced inside a route, use SetVariable in the route and GetVariable after the router converges.

## Rules

1. **Optimize for cost efficiency.** Every module run costs operations and credits. Always build scenarios with the minimum number of modules needed. Consolidate logic where possible, avoid redundant modules, and prefer fewer modules doing more over many modules doing little.
2. **"Name a run" is the only free module.** The `builtin:NameARun` module costs zero credits/operations. Use it freely for labeling scenario executions — it has no cost impact. All other modules count toward operations.
3. **Never reuse module IDs.** Check the "Next ID" shown by `fetch` or `validate`.
4. **Always validate before pushing.** Run `make-fixer validate -s <id>` to check your changes.
5. **Always ask the user before pushing.** Show them what changed and get explicit confirmation.
6. **Preserve the `idSequence` field** if present — it is server-managed.
7. **Error handlers need their own unique IDs** — they are separate modules in the `onerror` array.
8. **Position modules visually** using `metadata.designer.x` and `metadata.designer.y`. Increment `x` by ~300 for each subsequent module.
9. **NEVER invent module types.** Only use module types that are confirmed to exist via:
   - Modules already present in the fetched blueprint (copy their `module` and `version` fields exactly)
   - Results from `make-fixer apps` / `make-fixer modules` commands
   - JSON provided by the user (e.g. exported from Make.com)
   If you need a module type that doesn't appear in any of these sources, **ask the user** to provide the JSON for that module (e.g. by adding it manually in Make.com and re-fetching the blueprint). Never guess module type strings or version numbers.
10. **Choose the best solution for the problem.** Before building, think about which approach best balances efficiency and best practices given the available modules and tools. Don't default to the most obvious structure — consider alternatives that are simpler, cheaper, or more maintainable. The best solution is one that is both cost-efficient and follows sound design practices.
11. **Keep scenarios maintainable — avoid excessive routing.** Too many routes create complexity that is very hard to maintain. Clients frequently request changes to modules deep in route branches (leaf modules), and deeply nested or heavily branched scenarios make those changes painful. Prefer flatter, simpler structures when possible. Only add routes when the logic genuinely requires separate execution paths.

## Common Operations

### Add error handler to a module
Edit the module's `onerror` field:
```json
"onerror": [{ "id": NEXT_ID, "module": "builtin:Break", "version": 1, "mapper": { "retry": true, "count": 3, "interval": 15 } }]
```

### Rename a module
Set `metadata.designer.name`:
```json
"metadata": { "designer": { "x": 300, "y": 0, "name": "Descriptive Name" } }
```

### Add a new module to the flow
Insert into the `flow` array at the desired position with a unique ID.

### Add a route
Add an object with a `flow` array to a router module's `routes` array.

## App & Module Discovery

Search available apps and their modules to find the correct `module` type strings for blueprints:

```bash
make-fixer apps <query>          # Search apps by name/label/keywords
make-fixer modules <app-name>    # List modules for an app (auto-detects version)
```

The blueprint `module` field is `appSlug:moduleName` — e.g. `google-sheets:addRow`, `monday:CreateItemV2`.

## $ARGUMENTS

If the user provides a scenario ID or description of what to do, start the workflow immediately.
