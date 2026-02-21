# Make Fixer — Claude Code Integration Design

**Date**: 2026-02-21
**Status**: Approved

## Problem

The previous approach built a custom agent loop with its own conversation management. This duplicates what Claude Code already does — and requires a separate Anthropic API key. Instead, Claude Code should BE the agent, with make-fixer providing the CLI tools it needs.

## Solution

Expose make-fixer operations as CLI commands + a skill that teaches Claude Code the workflow. Claude Code edits blueprint JSON files directly using its own Read/Edit tools.

## Architecture

```
User ↔ Claude Code (the agent)
           │
           ├── Reads: ~/.claude/skills/make-fixer/SKILL.md
           │          (teaches workflow + Make.com knowledge)
           │
           ├── Bash: make-fixer fetch/analyze/validate/push
           │         (CLI commands for API operations)
           │
           └── Read/Edit: .make-fixer/<id>.json
                          (local blueprint file)
```

## CLI Commands

### `make-fixer fetch -s <id>`
Fetches blueprint from Make.com API, saves to `.make-fixer/<id>.json`.
Prints a compact module summary (ID, type, name, error handler status).

### `make-fixer analyze -s <id>`
Existing command — runs quality analysis, prints issues.
Enhanced: if `.make-fixer/<id>.json` exists, analyzes local file instead of fetching.

### `make-fixer validate -s <id>`
Reads `.make-fixer/<id>.json`, fetches remote blueprint, compares.
Shows: modules added/removed/modified, ID integrity, issue count before vs after.

### `make-fixer push -s <id>`
Reads `.make-fixer/<id>.json`, pushes to Make.com via PATCH.
Requires `--yes` flag or interactive y/N confirmation.

## Skill File

Location: `~/.claude/skills/make-fixer/SKILL.md`

Teaches Claude Code:
1. What Make.com blueprints are (modules, routes, flows, mappers)
2. The workflow: fetch → read → edit → validate → push
3. Module structure and ID rules
4. Safety rules (validate before push, confirm with user)
5. Common operations (add modules, error handlers, rename, restructure)

## Local File Convention

```
.make-fixer/
├── 4227637.json       # Blueprint for scenario 4227637
├── 1234567.json       # Blueprint for scenario 1234567
└── .gitignore         # Ignore all .json files (contains live data)
```

## What Changes from Previous Implementation

**Keep:**
- `blueprint-editor.ts` — `diffBlueprints()` used by `validate` command
- All analyzer checks — used by `analyze` command
- All existing fixer logic — can still be used by `fix` command
- `make-api/client.ts` — API client

**Delete:**
- `agent/index.ts` — Claude Code replaces the agent loop
- `agent/tools.ts` — CLI commands replace tool definitions
- `agent/system-prompt.ts` — skill.md replaces system prompt

**New:**
- `fetch` CLI command
- `validate` CLI command
- `push` CLI command (refactored from inline in `fix`)
- `.claude/skills/make-fixer/SKILL.md`
