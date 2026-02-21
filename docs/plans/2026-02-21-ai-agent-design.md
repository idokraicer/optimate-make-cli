# Make Fixer AI Agent — Design Document

**Date**: 2026-02-21
**Status**: Approved

## Problem

The current `make-fixer` CLI can analyze scenarios and apply a small set of deterministic auto-fixes (error handlers, naming, data validation). But building and editing Make.com scenarios is still a slow, manual process done through the Make.com UI. Engineers need a conversational agent that can fully edit scenarios on their behalf — add modules, change configurations, restructure flows — all from a terminal prompt.

## Solution

A new `make-fixer agent -s <id>` CLI command that starts an interactive, multi-turn conversation with a Claude-powered agent. The agent:

1. Fetches the scenario blueprint from Make.com's API
2. Analyzes it with the existing analyzer
3. Converses with the user about what to build/change
4. Edits the blueprint JSON directly (structured path-based edits)
5. Validates changes (re-analyze + diff + ID integrity)
6. Pushes the corrected blueprint back via API (with explicit user confirmation)

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                CLI: `agent -s <id>`                   │
│  Fetches blueprint, runs analysis, starts agent loop │
└──────────┬───────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────┐
│           Agent Loop (src/agent/index.ts)             │
│                                                      │
│  1. Build system prompt with blueprint summary       │
│     + analysis results + tool definitions            │
│  2. Send user message to Claude                      │
│  3. Claude responds with text and/or tool calls      │
│  4. Execute tool calls → feed results back           │
│  5. Print text response to terminal                  │
│  6. Read next user input → go to step 2              │
│  7. On "exit" / Ctrl+C → end session                 │
└──────────┬───────────────────────────────────────────┘
           │ tool calls
           ▼
┌──────────────────────────────────────────────────────┐
│           Agent Tools (src/agent/tools.ts)            │
│                                                      │
│  Blueprint tools:                                    │
│    get_blueprint    — read current blueprint JSON     │
│    edit_blueprint   — path-based JSON edits           │
│                                                      │
│  Analysis tools:                                     │
│    run_analysis     — full analyzer on current state  │
│    validate_changes — diff + ID check + re-analyze   │
│                                                      │
│  Push tools:                                         │
│    push_blueprint   — push to Make.com               │
└──────────────────────────────────────────────────────┘
```

### Core Principle: Edit JSON Like Editing Code

The agent works the same way Claude Code edits files:

1. **GET** the blueprint JSON from Make.com
2. **Read** the relevant sections to understand the current state
3. **Edit** via structured path-based mutations (insert, update, remove)
4. **Validate** the result against the original
5. **PATCH** it back to Make.com

No specialized fix tools needed. Claude composes the low-level edit primitives to handle any request — from renaming a module to restructuring an entire flow.

## Tool Definitions

### `get_blueprint`

Returns the current in-memory blueprint JSON (or a specific section by path).

```typescript
input:  { path?: string }  // e.g. "flow[2]" or "flow[0].routes[1].flow"
output: { json: any }
```

### `edit_blueprint`

Applies one or more structured edits to the blueprint.

```typescript
input: {
  edits: Array<{
    path: string;         // JSON path, e.g. "flow[2].mapper.url"
    action: "set" | "insert" | "remove";  // default: "set"
    value?: any;          // required for set/insert
    index?: number;       // for insert into arrays
  }>
}
output: { success: boolean; summary: string }
```

Examples:
- Update a field: `{ path: "flow[2].mapper.url", value: "https://..." }`
- Add a module: `{ path: "flow", action: "insert", index: 3, value: { id: 15, module: "slack:sendMessage", ... } }`
- Remove a module: `{ path: "flow[4]", action: "remove" }`
- Add error handler: `{ path: "flow[2].onerror", action: "set", value: [{ id: 16, module: "builtin:Break", ... }] }`

### `run_analysis`

Runs the full analyzer on the current blueprint state.

```typescript
input:  {}
output: { issues: Issue[]; checklist: Checklist; dataFlow: DataFlowMap }
```

### `validate_changes`

Compares the current blueprint against the original fetched version.

```typescript
input:  {}
output: {
  modulesAdded: number[];
  modulesRemoved: number[];
  modulesModified: number[];
  idsPreserved: boolean;
  issuesBefore: number;
  issuesAfter: number;
  regressions: Issue[];  // new issues not in original
}
```

### `push_blueprint`

Pushes the current blueprint to Make.com via PATCH API.

```typescript
input:  {}
output: { success: boolean; error?: string }
```

**Safety rule:** The agent MUST ask for user confirmation via conversation text before calling this tool. The CLI also prompts with `y/N` as a second safeguard.

## Conversation Flow

```
User: make-fixer agent -s 12345

─── INIT ────────────────────────────────────────
  1. Fetch blueprint from Make.com API
  2. Run full analysis
  3. Build system prompt (blueprint summary + issues)
  4. Print welcome message + issue summary
  5. Prompt: "What would you like to do?"

─── CONVERSATION LOOP ───────────────────────────
  User types request
    ↓
  Send to Claude (full message history)
    ↓
  Claude responds: text + tool calls
    ↓
  Execute tools, feed results back to Claude
    ↓
  Claude's final text → print to terminal
    ↓
  Before push: show diff, require y/N confirmation
    ↓
  Prompt for next input (or "exit" to end)
```

## System Prompt Design

The system prompt includes:

1. **Role**: "You are a Make.com scenario editor. You help users build, modify, and fix automation scenarios."
2. **Blueprint summary**: Compact module list — ID, type, name, has error handler, connection count. NOT the full JSON (too large).
3. **Analysis results**: Current issues from the analyzer, categorized by severity.
4. **Module ID rules**: "New modules get IDs starting from the current max + 1. Never reuse existing IDs. The idSequence field is server-managed."
5. **Safety rules**: "Always call validate_changes before push. Always ask user for confirmation before push. Explain what you're about to change before doing it."
6. **Language**: "Respond in the same language the user writes in."
7. **Module knowledge**: Claude uses its training knowledge of Make.com module structures. For unfamiliar modules, it infers from existing modules in the blueprint.

## Module Knowledge Strategy

Make.com's API does not expose module schemas for native apps (Google Sheets, Slack, etc.). The agent relies on:

1. **Claude's training knowledge** — extensive knowledge of common Make.com module structures
2. **Blueprint inference** — learns from existing modules in the current scenario
3. **Error feedback** — if a push fails due to invalid structure, the agent reads the error and corrects

No static catalog needed. This keeps the system simple and leverages Claude's strengths.

## Validation & Safety

Before any `push_blueprint`:

1. **Re-analyze**: Run full analyzer — issue count should not increase for unrelated categories
2. **Structural diff**: Show added/removed/modified modules with details
3. **ID integrity**: All original module IDs present (unless explicitly removed), no duplicate IDs
4. **Conversation confirmation**: Agent asks "Ready to push?" in the conversation
5. **CLI confirmation**: Terminal prompts with `Push N change(s) to Make.com? [y/N]`

## File Structure

```
src/agent/
├── index.ts              # Agent loop: init, conversation, tool dispatch
├── tools.ts              # Tool definitions + execution functions
├── system-prompt.ts      # Builds system prompt from blueprint + analysis
└── blueprint-editor.ts   # JSON path-based edit engine (apply, diff, validate)
```

## Model Choice

- **Agent conversation**: `claude-haiku-4-5-20251001` — fast, cheap, good enough for tool orchestration
- **Content generation** (names, docs): Same Haiku model via existing `ai-content.ts`

Can upgrade to Sonnet if Haiku struggles with complex blueprint edits.

## Example Session

```
$ make-fixer agent -s 12345

Fetching scenario 12345...
Analyzing...

══════════════════════════════════════
  Make Fixer Agent — Scenario: "New Lead Flow"
  Modules: 8 | Routes: 2 | Issues: 5
══════════════════════════════════════

Issues found:
  ⚠  3 modules missing error handlers (#3, #5, #7)
  ⚡ 2 modules unnamed (#3, #5)
  ℹ  Scenario name could be more descriptive

What would you like to do?

> add error handlers to all modules and rename them

I'll add Break error handlers (retry: 3, interval: 60s) to modules
#3, #5, and #7, then generate descriptive names for #3 and #5.

[Calling tools: edit_blueprint × 5, run_analysis]

Done. Here's what changed:
  ✓ Added error handler to #3 (HTTP: Send Request)
  ✓ Added error handler to #5 (Google Sheets: Add Row)
  ✓ Added error handler to #7 (Slack: Send Message)
  ✓ Renamed #3 → "Fetch Lead Data from CRM"
  ✓ Renamed #5 → "Log Lead to Spreadsheet"

Validation: 5 issues → 0 issues. All module IDs preserved.

Push these changes to Make.com? (type 'yes' to confirm)

> yes
Push 5 change(s) to Make.com? [y/N] y
Done! Blueprint updated successfully.

Anything else?

> exit
```
