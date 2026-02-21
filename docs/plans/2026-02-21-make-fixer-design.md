# Make Fixer — Design Document

**Date**: 2026-02-21
**Author**: Ido Kraicer (Optimate)
**Status**: Approved

## Problem

Optimate builds Make.com automations for B2B clients. An existing AI-powered analyzer (LLM prompt running in n8n) identifies quality issues in scenario blueprints — missing error handlers, unnamed modules, missing documentation, hardcoded data, security risks. But applying fixes is entirely manual: engineers open each scenario in Make.com's UI and fix issues by hand.

## Solution

`make-fixer` — a CLI tool that:

1. Fetches a scenario blueprint from Make.com's API
2. Analyzes it with deterministic TypeScript checks (replaces the LLM-based analyzer)
3. Auto-fixes structural issues (error handlers, module names, scenario name)
4. Reports issues requiring human judgment (security, hardcoded data)
5. Pushes the corrected blueprint back via API

## Validated API Behavior

Tested and confirmed on 2026-02-21:

- **Module IDs are preserved** in read-modify-write cycles via API
- **Endpoint**: `PATCH /api/v2/scenarios/{id}` with `{"blueprint": "<stringified JSON>"}`
- **`idSequence` is server-managed** — auto-computed from highest module ID
- **Base URL**: `https://eu1.make.com/api/v2`
- Error handlers added via `onerror` array injection work correctly
- Module name changes via `metadata.designer.name` persist in UI

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Make.com API                          │
│  GET /scenarios/{id}/blueprint ── PATCH /scenarios/{id} │
└────────┬────────────────────────────────────────────────┘
         │                                ▲
         ▼                                │
┌─────────────────────────────────────────────────────────┐
│              Blueprint Fix Engine (TypeScript)           │
│                                                         │
│  1. Parse blueprint JSON                                │
│  2. Classify modules (excluded / trigger / API)         │
│  3. Run deterministic checks                            │
│  4. Apply auto-fixes (structural + AI content)          │
│  5. Validate modified blueprint                         │
│  6. Push via API (with user confirmation)               │
│  7. Generate change report                              │
└─────────────────────────────────────────────────────────┘
```

Two categories of AI usage:
- **Deterministic code**: All structural analysis and fixes (error handlers, classification, validation)
- **Claude API (small calls)**: Content generation only (module names, documentation text, scenario names)

## Fix Types

| # | Issue | Fix Type | Implementation |
|---|-------|----------|----------------|
| 1 | Missing error handler | Auto-fix | Inject `onerror` with `builtin:Break` (retry: true, count: 3, interval: 60) |
| 2 | Missing custom name | Auto-fix (AI) | Claude generates descriptive name → set `metadata.designer.name` |
| 3 | Missing documentation | Auto-fix (AI) | Claude generates English doc → create note (pending notes API) |
| 4 | Data validation before queries | Report only | Flag with specific guidance |
| 4b | Hardcoded data | Report only | Flag with recommendation to externalize |
| 5 | Error handler quality | Report + suggest | Suggest better handler type, optionally swap |
| 6 | JSON safety for HTTP | Report only | Requires data flow restructuring |
| 7 | Character escaping | Report only | Needs mapper changes |
| 8 | API key security | Report only (critical) | Always human review |
| 9 | Connection validation | Report only (critical) | Requires new connection creation |
| 10 | Route merging | Report only | Architectural change |
| 11 | Scenario naming | Auto-fix (AI) | Claude generates name → update `blueprint.name` |

## Module Classification

Excluded from all checks (utility/internal):
- `builtin:*`, `gateway:*`, `json:*`, `tools:*`, `util:*`, `flow:*`, `code:*`, `phonenumber:*`
- Any module containing `:Transformer`

Trigger module (first in `flow[]`):
- Excluded from error handling checks
- Included in naming and documentation checks

API modules (everything else):
- All checks apply

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript
- **Dependencies**: `@anthropic-ai/sdk`, `commander`, `zod`
- **Location**: `~/Developer/make-fixer`

## Project Structure

```
make-fixer/
├── src/
│   ├── cli.ts                         # CLI entry point
│   ├── make-api/
│   │   ├── client.ts                  # Make.com API client
│   │   └── types.ts                   # Blueprint, Module, Route types
│   ├── analyzer/
│   │   ├── index.ts                   # Runs all checks, returns issues[]
│   │   ├── checks/
│   │   │   ├── error-handling.ts
│   │   │   ├── naming.ts
│   │   │   ├── documentation.ts
│   │   │   ├── security.ts
│   │   │   ├── hardcoded.ts
│   │   │   ├── data-validation.ts
│   │   │   ├── json-safety.ts
│   │   │   ├── handler-quality.ts
│   │   │   ├── connection-validation.ts
│   │   │   ├── route-merging.ts
│   │   │   └── scenario-naming.ts
│   │   └── module-classifier.ts
│   ├── fixer/
│   │   ├── index.ts                   # Applies all auto-fixes
│   │   ├── fixes/
│   │   │   ├── add-error-handler.ts
│   │   │   ├── set-module-name.ts
│   │   │   ├── rename-scenario.ts
│   │   │   └── swap-handler-type.ts
│   │   └── ai-content.ts             # Claude API for name/doc generation
│   ├── reporter/
│   │   └── index.ts                   # Terminal table + JSON output
│   └── utils/
│       ├── blueprint-traversal.ts     # Recursive flow/routes walker
│       └── module-helpers.ts          # isExcluded, isTrigger helpers
├── package.json
├── tsconfig.json
└── .env                               # MAKE_API_TOKEN, ANTHROPIC_API_KEY
```

## CLI Interface

```bash
# Analyze only (no changes)
make-fixer analyze --scenario 12345

# Fix with dry-run (show changes without pushing)
make-fixer fix --scenario 12345 --dry-run

# Fix and push (with confirmation prompt)
make-fixer fix --scenario 12345

# Fix specific issue types only
make-fixer fix --scenario 12345 --only error-handlers,naming
```

## Workflow (7 Steps)

1. **Fetch** — GET blueprint from API, parse JSON
2. **Classify** — Walk `flow[]` recursively, tag each module
3. **Analyze** — Run all deterministic checks, categorize issues
4. **Fix** — Apply auto-fixes to in-memory blueprint copy
5. **Validate** — Diff original vs modified, verify IDs preserved
6. **Confirm & Push** — Show changes, prompt user, PATCH via API
7. **Report** — Display what was fixed and what needs manual attention

## Error Handler Template

```json
{
  "id": "<next available — server manages idSequence>",
  "module": "builtin:Break",
  "version": 1,
  "parameters": {},
  "mapper": {
    "retry": true,
    "count": 3,
    "interval": 60
  },
  "metadata": {
    "designer": { "x": 0, "y": 0 },
    "parameters": [
      { "name": "retry", "type": "boolean", "label": "Automatically retry" },
      { "name": "count", "type": "number", "label": "Number of retries" },
      { "name": "interval", "type": "number", "label": "Interval between retries" }
    ],
    "expect": [
      { "name": "retry", "type": "boolean" },
      { "name": "count", "type": "integer" },
      { "name": "interval", "type": "integer" }
    ]
  }
}
```

## Phase 2 (Future)

- **Claude Agent SDK wrapper** — conversational interface over the fix engine
- **Batch mode** — process all scenarios in an organization
- **Web UI** — dashboard for scenario health across clients
- **Natural language to scenario** — generate blueprints from descriptions
