# Agent-First Make Fixer CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the standalone Make Fixer CLI reliable and efficient for AI agents by fixing complete blueprint traversal and adding rate-aware inspection, organization search, reusable module examples, scenario creation, execution, probing, and ownership-safe cleanup.

**Architecture:** Introduce small command modules over an expanded `MakeApiClient`, with one canonical recursive blueprint walker, one cross-process request coordinator, and a durable owned-probe registry. New commands use stable JSON envelopes while existing commands and JSON shapes remain unchanged. Provider-specific knowledge comes from real organization blueprints and connections; the CLI itself remains framework agnostic.

**Tech Stack:** Bun 1.3+, TypeScript, Commander 14, Zod 4, `bun:test`, `bun:sqlite`, Make REST API v2.

## Global Constraints

- Keep the CLI standalone; do not add MCP transport or MCP-token dependencies.
- Preserve every existing command, flag, default output, and existing `--json` shape.
- New commands are JSON-first and send operational logs only to stderr.
- Use 95% of `organization.license.apiLimit`; use 30 RPM only when the limit cannot be read.
- Retry HTTP 429 indefinitely until success or cancellation; honor `Retry-After`, otherwise wait at least 60 seconds.
- Keep 503 and network retry budgets bounded.
- Coordinate rate state across CLI processes with `bun:sqlite`.
- Default full-text search scope is the entire organization resolved from the supplied Make URL.
- Never expose or cache tokens, passwords, authorization values, cookies, API keys, or credentials.
- Remote mutation requires `--yes`; scenario runs preview by default.
- Never automatically replay or resend an execution after an ambiguous timeout.
- Keep provider semantics in blueprints and example discovery; do not add provider-specific API integrations.
- Never automatically delete a probe scenario; return a user cleanup decision after every probe.
- `probe` may activate, stop, or deactivate only a scenario it created and recorded locally.
- Cleanup deletion requires a matching ownership record, last verified remote fingerprint, inactive state, and `--delete --yes`.
- The documented scenario-run endpoint is exempt from the organization rolling-rate bucket, but still honors cancellation and indefinite 429 retry.
- Use Bun commands (`bun test`, `bun run typecheck`) and Bun APIs.
- Preserve all pre-existing dirty-worktree changes. Do not stage or commit a file if doing so would include unrelated existing changes; use isolated commits only when the staged diff is exclusively owned by this plan.

---

## File Structure

### New files

- `src/commands/output.ts` — stable result envelope and exit-code mapping for new commands.
- `src/commands/inspect.ts` — remote/local scenario and module inspection.
- `src/commands/search.ts` — organization resolution, incremental indexing, and search orchestration.
- `src/commands/run.ts` — scenario interface validation, preview, execution, and polling.
- `src/commands/doctor.ts` — safe capability probes and diagnostic result.
- `src/commands/examples.ts` — organization module-example discovery and grouping.
- `src/commands/connections.ts` — safe team connection discovery.
- `src/commands/create.ts` — validated on-demand scenario creation and ownership recording.
- `src/commands/probe.ts` — owned create/run/inspect/deactivate orchestration.
- `src/commands/cleanup.ts` — read-only lifecycle status and guarded deletion.
- `src/make-api/api-error.ts` — sanitized provider error parsing and capability classification.
- `src/make-api/rate-limiter.ts` — cross-process rolling-window reservations and shared cooldowns.
- `src/make-api/request-coordinator.ts` — pacing, retry, cancellation, and GET deduplication.
- `src/make-api/scenario-runner.ts` — pure input validation and polling state machine.
- `src/utils/semantic-diff.ts` — exact leaf changes and ancestor classification.
- `src/utils/blueprint-fingerprint.ts` — stable remote fingerprints and sidecar metadata.
- `src/search/search-index.ts` — redacted flattened documents, cache, and matching.
- `src/examples/module-examples.ts` — module matching, signatures, grouping, and sanitized fragments.
- `src/probes/ownership-store.ts` — SQLite-backed owned-scenario lifecycle records.
- `src/probes/probe-runner.ts` — generic probe state machine with compensation.
- Corresponding `*.test.ts` files beside every new implementation file.
- `tests/fixtures/if-else-blueprint.json` — regression fixture with module 18 inside a branch and nested error routes.

### Existing files modified

- `src/make-api/types.ts` — recursive branch/error-handler schemas and scenario interface/run types.
- `src/utils/blueprint-traversal.ts` — canonical recursive traversal.
- `src/utils/module-helpers.ts` — maximum-ID logic delegates to canonical traversal.
- `src/utils/resume-builder.ts` — module lookup delegates to canonical traversal.
- `src/analyzer/module-classifier.ts` — consumes richer walked-module metadata.
- `src/agent/blueprint-editor.ts` — additive semantic diff fields.
- `src/make-api/client.ts` — all calls use coordinated request path; new documented endpoints.
- `src/make-api/fetch-retry.ts` — retained compatibility wrapper delegates to the coordinator policy.
- `src/cli.ts` — registers new focused command modules without changing existing definitions.
- `src/cli.test.ts` — command help and backward-compatibility coverage.
- `README.md` — concise new command examples and safety behavior.
- `skills/make-fixer/SKILL.md` — short agent routing rules for new commands and less ad hoc blueprint parsing.

---

### Task 1: Establish the Baseline and Preserve Existing WIP

**Files:**
- Inspect: `src/cli.ts`
- Inspect: `src/make-api/client.ts`
- Inspect: `src/utils/execution-query.ts`
- Inspect: `README.md`
- Inspect: `skills/make-fixer/SKILL.md`
- Create: `docs/superpowers/plans/2026-07-23-agent-first-cli-baseline.md`

**Interfaces:**
- Consumes: current dirty worktree and existing execution-query implementation.
- Produces: a recorded baseline of tests, typecheck status, dirty files, and ownership boundaries.

- [ ] **Step 1: Record the exact working-tree baseline**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Write the command outputs and current commit SHA to
`docs/superpowers/plans/2026-07-23-agent-first-cli-baseline.md`. Do not copy
tokens or API response bodies.

- [ ] **Step 2: Run the current test and typecheck baseline**

Run:

```bash
bun test
bun run typecheck
```

Expected: record the actual pass/fail counts. Existing failures are baseline
constraints and must not be silently attributed to this implementation.

- [ ] **Step 3: Confirm current execution-query WIP is retained**

Run:

```bash
git diff -- src/cli.ts src/make-api/client.ts README.md skills/make-fixer/SKILL.md
```

Expected: the existing `executions --since`, `--compact`, `--output`, and
`--include-input` work remains present throughout subsequent tasks.

- [ ] **Step 4: Checkpoint the existing execution-query WIP**

If the baseline tests pass, commit only the already-present execution-query
feature files so later task commits do not absorb them:

```bash
git add README.md skills/make-fixer/SKILL.md src/cli.ts src/cli.test.ts src/make-api/client.ts src/make-api/client.test.ts src/utils/execution-query.ts src/utils/execution-query.test.ts
git diff --cached --check
git commit -m "feat: improve execution querying"
```

Do not add `.agents/` or `AGENTS.md`. If the staged diff contains anything
other than the already-recorded execution-query feature, unstage it and report
`DONE_WITH_CONCERNS` rather than committing.

- [ ] **Step 5: Commit the isolated baseline evidence**

Run:

```bash
git diff -- docs/superpowers/plans/2026-07-23-agent-first-cli-baseline.md
```

Then:

```bash
git add docs/superpowers/plans/2026-07-23-agent-first-cli-baseline.md
git diff --cached --check
git commit -m "test: record agent-first cli baseline"
```

---

### Task 2: Fix Recursive Blueprint Schemas and Traversal

**Files:**
- Create: `tests/fixtures/if-else-blueprint.json`
- Modify: `src/make-api/types.ts`
- Modify: `src/utils/blueprint-traversal.ts`
- Modify: `src/utils/blueprint-traversal.test.ts`
- Modify: `src/utils/module-helpers.ts`
- Modify: `src/utils/module-helpers.test.ts`
- Modify: `src/utils/resume-builder.ts`
- Modify: `src/utils/resume-builder.test.ts`

**Interfaces:**
- Produces:

```ts
export type ModuleContainer = "flow" | "route" | "branch" | "onerror";

export interface WalkedModule {
  module: Module;
  path: string;
  depth: number;
  parentModuleId: number | null;
  container: ModuleContainer;
}

export function walkModules(
  flow: Module[],
  options?: { includeErrorHandlers?: boolean },
): WalkedModule[];

export function findWalkedModulesById(flow: Module[], id: number): WalkedModule[];
```

- [ ] **Step 1: Add a regression fixture reproducing the chat failure**

Create a blueprint whose top-level maximum module ID is 17, whose
`builtin:BasicIfElse.branches[0].flow` contains module 18, and whose nested
module has an `onerror` router containing module 21.

- [ ] **Step 2: Write failing traversal tests**

Add:

```ts
test("walks modules inside BasicIfElse branches", () => {
  const blueprint = fixture as Blueprint;
  const modules = walkModules(blueprint.flow);
  const nested = modules.find((entry) => entry.module.id === 18);
  expect(nested).toMatchObject({
    path: "flow[1].branches[0].flow[0]",
    parentModuleId: 17,
    container: "branch",
  });
});

test("walks nested error-handler routes", () => {
  const modules = walkModules((fixture as Blueprint).flow);
  expect(modules.find((entry) => entry.module.id === 21)?.container).toBe("route");
});

test("returns every duplicate module path", () => {
  const matches = findWalkedModulesById((fixture as Blueprint).flow, 18);
  expect(matches).toHaveLength(1);
});
```

- [ ] **Step 3: Run tests and verify RED**

Run:

```bash
bun test src/utils/blueprint-traversal.test.ts src/utils/module-helpers.test.ts src/utils/resume-builder.test.ts
```

Expected: branch and nested-error tests fail because current traversal only
visits `routes`.

- [ ] **Step 4: Implement recursive Zod schemas**

Define one lazy `ModuleSchema` whose `routes`, `branches`, and `onerror` entries
all recursively contain module-compatible objects. Preserve `.catchall()` and
nullable IDs.

- [ ] **Step 5: Implement canonical traversal**

Use a private recursive function that receives `path`, `depth`,
`parentModuleId`, and `container`. Visit the module once, then visit:

```ts
visitChildren(module.routes, "routes", "route");
visitChildren(module.branches, "branches", "branch");
visitErrorHandlers(module.onerror);
```

Do not use generic object recursion because arbitrary mapper objects can contain
`id` and `module` keys that are not Make modules.

- [ ] **Step 6: Delegate maximum-ID and lookup logic**

Implement:

```ts
export function getMaxModuleId(flow: Module[]): number {
  return walkModules(flow)
    .map(({ module }) => module.id)
    .filter((id): id is number => typeof id === "number")
    .reduce((max, id) => Math.max(max, id), 0);
}
```

Update resume lookup to reject duplicates with all paths rather than selecting
the first.

- [ ] **Step 7: Run tests and verify GREEN**

Run:

```bash
bun test src/utils/blueprint-traversal.test.ts src/utils/module-helpers.test.ts src/utils/resume-builder.test.ts src/analyzer
```

Expected: all pass, module 18 is found, and next ID is at least 22 for the
fixture.

- [ ] **Step 8: Commit isolated traversal work**

Stage only the fixture and traversal/schema/helper files if their diff contains
no pre-existing unrelated changes:

```bash
git add tests/fixtures/if-else-blueprint.json src/make-api/types.ts src/utils/blueprint-traversal.ts src/utils/blueprint-traversal.test.ts src/utils/module-helpers.ts src/utils/module-helpers.test.ts src/utils/resume-builder.ts src/utils/resume-builder.test.ts
git commit -m "fix: traverse all nested Make modules"
```

---

### Task 3: Add Sanitized API Errors and Stable New-Command Output

**Files:**
- Create: `src/make-api/api-error.ts`
- Create: `src/make-api/api-error.test.ts`
- Create: `src/commands/output.ts`
- Create: `src/commands/output.test.ts`

**Interfaces:**
- Produces:

```ts
export type ApiErrorCode =
  | "AUTH_INVALID"
  | "SCOPE_MISSING"
  | "PLAN_RESTRICTED"
  | "NOT_SUPPORTED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "TRANSIENT"
  | "INVALID_DATA"
  | "UNKNOWN_API_ERROR";

export interface ClassifiedApiError {
  code: ApiErrorCode;
  message: string;
  httpStatus: number | null;
  providerCode: string | null;
  retryable: boolean;
}

export async function classifyApiResponse(response: Response): Promise<ClassifiedApiError>;
export function successEnvelope<T>(command: string, data: T, meta: object): CommandEnvelope<T>;
export function failureEnvelope(command: string, error: ClassifiedApiError): CommandEnvelope<never>;
export function exitCodeFor(error: ClassifiedApiError): 1 | 2 | 3;
```

- [ ] **Step 1: Write failing classification tests**

Cover:

```ts
test.each([
  [401, { code: "AUTH_INVALID" }],
  [403, { code: "SCOPE_MISSING", providerCode: "SC403" }],
  [402, { code: "PLAN_RESTRICTED" }],
  [404, { code: "NOT_FOUND" }],
  [429, { code: "RATE_LIMITED", retryable: true }],
  [503, { code: "TRANSIENT", retryable: true }],
])("classifies status %i", async (status, expected) => {
  const response = new Response(JSON.stringify({ code: "SC403", message: "Permission denied" }), { status });
  expect(await classifyApiResponse(response)).toMatchObject(expected);
});
```

Add secret-redaction tests where provider messages contain
`Authorization`, `Token`, `apiKey`, or cookie values.

- [ ] **Step 2: Verify RED**

Run:

```bash
bun test src/make-api/api-error.test.ts src/commands/output.test.ts
```

Expected: modules are missing.

- [ ] **Step 3: Implement bounded response parsing**

Clone the response before reading it. Parse JSON when possible, otherwise use
at most 2,000 characters of text. Provider messages are sanitized using
key-aware and bearer/token patterns.

- [ ] **Step 4: Implement envelopes and exit mapping**

Keep existing command output untouched. New command modules call these helpers
and always include `cliVersion`, `source`, and `verifiedAt` in metadata.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
bun test src/make-api/api-error.test.ts src/commands/output.test.ts
```

- [ ] **Step 6: Commit isolated error/output work**

```bash
git add src/make-api/api-error.ts src/make-api/api-error.test.ts src/commands/output.ts src/commands/output.test.ts
git commit -m "feat: add agent-safe api results"
```

---

### Task 4: Implement Cross-Process 95% Rate Coordination

**Files:**
- Create: `src/make-api/rate-limiter.ts`
- Create: `src/make-api/rate-limiter.test.ts`
- Create: `src/make-api/request-coordinator.ts`
- Create: `src/make-api/request-coordinator.test.ts`
- Modify: `src/make-api/fetch-retry.ts`
- Create: `src/make-api/fetch-retry.test.ts`
- Modify: `src/make-api/client.ts`
- Modify: `src/make-api/client.test.ts`

**Interfaces:**
- Produces:

```ts
export interface RateBucket {
  zone: string;
  organizationId: number | "unknown";
}

export interface RateLimitSnapshot {
  documentedRpm: number | null;
  effectiveRpm: number;
  limitSource: "organization_api" | "cache" | "fallback";
  requestsSent: number;
  retries: number;
  cooldownMs: number;
}

export class SharedRateLimiter {
  reserve(bucket: RateBucket, rpm: number, signal?: AbortSignal): Promise<void>;
  setCooldown(bucket: RateBucket, untilMs: number): void;
  getSnapshot(bucket: RateBucket): RateLimitSnapshot;
}

export class RequestCoordinator {
  request(url: string | URL, init: RequestInit, context: RequestContext): Promise<Response>;
}
```

- [ ] **Step 1: Write failing deterministic rate tests**

Use a temporary SQLite path, fake clock, fake sleeper, and deterministic random
source. Cover:

- `Math.floor(60 * 0.95) === 57`;
- fallback is 30 RPM;
- the 58th reservation waits until the oldest reservation exits the rolling
  60-second window;
- two limiter instances sharing one database see the same reservations;
- a shared cooldown blocks another instance;
- cancellation rejects before a queued request is sent.

- [ ] **Step 2: Write failing retry tests**

Cover:

```ts
test("retries 429 until success without consuming bounded retry budget", async () => {
  const responses = [
    new Response("", { status: 429 }),
    new Response("", { status: 429, headers: { "Retry-After": "2" } }),
    new Response("ok", { status: 200 }),
  ];
  const result = await coordinator.request(url, {}, context);
  expect(await result.text()).toBe("ok");
  expect(sleeps).toEqual([60_000, 2_000]);
});
```

Also cover HTTP-date `Retry-After`, bounded 503 retries with full jitter,
one-process GET deduplication, and no automatic retry of an ambiguous mutation
network failure.

- [ ] **Step 3: Verify RED**

Run:

```bash
bun test src/make-api/rate-limiter.test.ts src/make-api/request-coordinator.test.ts src/make-api/fetch-retry.test.ts
```

- [ ] **Step 4: Implement SQLite reservation storage**

Create tables:

```sql
CREATE TABLE IF NOT EXISTS request_reservations (
  bucket TEXT NOT NULL,
  reserved_at_ms INTEGER NOT NULL,
  pid INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_reservations_bucket_time
  ON request_reservations(bucket, reserved_at_ms);
CREATE TABLE IF NOT EXISTS rate_cooldowns (
  bucket TEXT PRIMARY KEY,
  until_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS organization_limits (
  bucket TEXT PRIMARY KEY,
  api_limit INTEGER NOT NULL,
  fetched_at_ms INTEGER NOT NULL
);
```

Use WAL mode, `BEGIN IMMEDIATE`, pruning, counting, and insertion in one short
transaction. Sleep outside transactions.

- [ ] **Step 5: Implement request coordination**

Separate 429 from 503/network handling. Parse `Retry-After` as seconds or HTTP
date. A missing 429 header yields 60,000 ms. Loop on 429 until success or abort.

Allow request metadata to set `organizationRateExempt: true`. Use it only for
`POST /scenarios/{scenarioId}/run`, which Make explicitly documents as exempt
from organization request limits. Exempt calls skip SQLite reservations but
retain cancellation, sanitized errors, and indefinite 429 retry.

For GET requests, key in-flight deduplication by method, URL, and safe
non-authorization headers. Do not include token values in keys or logs.

- [ ] **Step 6: Route every client request through the coordinator**

Give `MakeApiClient` a single private `request()` method and replace direct
`fetchWithRetry` calls. Retain `fetchWithRetry` as a backward-compatible wrapper
over the new coordinator with an `unknown` bucket.

- [ ] **Step 7: Verify GREEN**

Run:

```bash
bun test src/make-api/rate-limiter.test.ts src/make-api/request-coordinator.test.ts src/make-api/fetch-retry.test.ts src/make-api/client.test.ts
```

- [ ] **Step 8: Commit isolated rate-limit work**

Task 1 must have checkpointed the execution-query changes first. Verify the
staged diff is limited to this task:

```bash
git add src/make-api/rate-limiter.ts src/make-api/rate-limiter.test.ts src/make-api/request-coordinator.ts src/make-api/request-coordinator.test.ts src/make-api/fetch-retry.ts src/make-api/fetch-retry.test.ts src/make-api/client.ts src/make-api/client.test.ts
git diff --cached --check
git commit -m "feat: coordinate Make API rate limits"
```

---

### Task 5: Add `inspect` and Correct Summary/Lookup Behavior

**Files:**
- Create: `src/commands/inspect.ts`
- Create: `src/commands/inspect.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`

**Interfaces:**
- Consumes: `walkModules`, `findWalkedModulesById`, `MakeApiClient.fetchBlueprint`.
- Produces:

```ts
export interface InspectModuleData {
  id: number | null;
  path: string;
  type: string;
  name: string | null;
  container: ModuleContainer;
  parentModuleId: number | null;
  mapper: unknown;
  parameters: unknown;
  resolvedLabels: Record<string, string>;
}

export function inspectBlueprint(
  blueprint: Blueprint,
  scenarioId: number,
  options: { moduleId?: number; summary?: boolean; source: "remote" | "local" },
): InspectResult;
```

- [ ] **Step 1: Write failing pure inspection tests**

Use `if-else-blueprint.json`. Assert module 18 path, label, mapper, parent ID,
container, total module count, maximum ID, and next ID. Add duplicate-ID failure
with all paths.

- [ ] **Step 2: Verify RED**

```bash
bun test src/commands/inspect.test.ts
```

- [ ] **Step 3: Implement inspection**

Extract restore labels recursively from `metadata.restore.expect`, but retain raw
mapper and parameters. Do not perform encoding transcoding; JSON remains UTF-8.

- [ ] **Step 4: Register CLI command**

```ts
registerInspectCommand(program, {
  resolveClient,
  parseScenarioInput,
  readLocalBlueprint,
  cliVersion: pkg.version,
});
```

Flags: required `-s`, mutually exclusive `--module <id>` and `--summary`,
optional `--local`, optional `--human`.

- [ ] **Step 5: Verify CLI and compatibility**

```bash
bun test src/commands/inspect.test.ts src/cli.test.ts
bun src/cli.ts inspect --help
```

Expected: existing CLI help tests remain unchanged and new help lists all
inspect flags.

- [ ] **Step 6: Commit**

```bash
git add src/commands/inspect.ts src/commands/inspect.test.ts src/cli.ts src/cli.test.ts
git diff --cached --check
git commit -m "feat: add exact scenario inspection"
```

---

### Task 6: Add Semantic Diff and Remote Drift Protection

**Files:**
- Create: `src/utils/semantic-diff.ts`
- Create: `src/utils/semantic-diff.test.ts`
- Create: `src/utils/blueprint-fingerprint.ts`
- Create: `src/utils/blueprint-fingerprint.test.ts`
- Modify: `src/agent/blueprint-editor.ts`
- Modify: `src/agent/blueprint-editor.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`

**Interfaces:**
- Produces:

```ts
export interface LeafChange {
  path: string;
  moduleId: number | null;
  before: unknown;
  after: unknown;
}

export interface SemanticDiff {
  directlyModifiedModules: number[];
  ancestorModules: number[];
  changes: LeafChange[];
}

export function semanticDiff(before: Blueprint, after: Blueprint): SemanticDiff;
export function fingerprintBlueprint(blueprint: Blueprint): Promise<string>;
```

- [ ] **Step 1: Write failing exact-diff tests**

Change only module 18 `mapper.boardId`. Assert:

```ts
expect(result.directlyModifiedModules).toEqual([18]);
expect(result.ancestorModules).toEqual([17]);
expect(result.changes).toEqual([{
  path: "flow[1].branches[0].flow[0].mapper.boardId",
  moduleId: 18,
  before: "old",
  after: "new",
}]);
```

- [ ] **Step 2: Write failing fingerprint tests**

Assert object-key order does not change the fingerprint, while a scalar value
does. Use Web Crypto SHA-256 through `crypto.subtle.digest`.

- [ ] **Step 3: Verify RED**

```bash
bun test src/utils/semantic-diff.test.ts src/utils/blueprint-fingerprint.test.ts src/agent/blueprint-editor.test.ts
```

- [ ] **Step 4: Implement stable canonicalization and leaf diff**

Sort object keys, preserve array order, and classify module ownership using
canonical walked paths. Never include ancestor object serialization as a direct
module change.

- [ ] **Step 5: Add sidecars and push drift gate**

On fetch write:

```json
{
  "scenarioId": 6648651,
  "baseUrl": "https://eu1.make.com",
  "fingerprint": "<sha256>",
  "fetchedAt": "<ISO timestamp>"
}
```

Store under `blueprints/.make-fixer/<scenarioId>.json`.

Before push, refetch and compare. Exit 4 with `REMOTE_DRIFT` unless
`--allow-remote-drift` is present.

- [ ] **Step 6: Add additive validate output**

Only when `--changes` is passed, add semantic fields to JSON/human output.
Preserve current `modulesModified`.

- [ ] **Step 7: Verify GREEN**

```bash
bun test src/utils/semantic-diff.test.ts src/utils/blueprint-fingerprint.test.ts src/agent/blueprint-editor.test.ts src/cli.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add src/utils/semantic-diff.ts src/utils/semantic-diff.test.ts src/utils/blueprint-fingerprint.ts src/utils/blueprint-fingerprint.test.ts src/agent/blueprint-editor.ts src/agent/blueprint-editor.test.ts src/cli.ts src/cli.test.ts
git diff --cached --check
git commit -m "feat: add semantic blueprint drift protection"
```

---

### Task 7: Add Organization-Wide Incremental Full-Text Search

**Files:**
- Create: `src/search/search-index.ts`
- Create: `src/search/search-index.test.ts`
- Create: `src/commands/search.ts`
- Create: `src/commands/search.test.ts`
- Modify: `src/make-api/client.ts`
- Modify: `src/make-api/client.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SearchMatch {
  scenarioId: number;
  scenarioName: string;
  teamId: number;
  moduleId: number | null;
  moduleType: string | null;
  path: string;
  key: string | null;
  value: string;
  snippet: string;
}

export interface SearchEntry {
  scenarioId: number;
  scenarioName: string;
  teamId: number;
  moduleId: number | null;
  moduleType: string | null;
  path: string;
  key: string | null;
  value: string;
}

export type SearchQuery =
  | { kind: "literal"; value: string; caseSensitive: boolean }
  | { kind: "regex"; pattern: string; caseSensitive: boolean }
  | { kind: "field"; field: string; value: string; caseSensitive: boolean };

export function sanitizeForIndex(value: unknown): unknown;
export function flattenSearchDocument(value: unknown, basePath?: string): SearchEntry[];
export function searchEntries(entries: SearchEntry[], query: SearchQuery): SearchMatch[];

export interface ScenarioIndexRecord {
  scenarioId: number;
  scenarioName: string;
  teamId: number;
  lastEdit: string;
  sanitizedBlueprint: Blueprint;
  entries: SearchEntry[];
  indexedAt: string;
}
```

- [ ] **Step 1: Write failing redaction and matching tests**

Cover nested branches, Hebrew text, board IDs, keys, values, case sensitivity,
valid regex, invalid regex before network, exact field/value, bounded snippets,
and redaction of:

```ts
["token", "secret", "password", "authorization", "apiKey", "cookie", "credentials"]
```

- [ ] **Step 2: Write failing incremental-cache tests**

Given three scenarios where two `lastEdit` values match cache and one changes,
assert only the changed scenario blueprint is fetched. Assert removed scenarios
are pruned and a partially failed fetch returns `incomplete: true`.

- [ ] **Step 3: Verify RED**

```bash
bun test src/search/search-index.test.ts src/commands/search.test.ts
```

- [ ] **Step 4: Add team detail and organization detail client methods**

Implement documented:

```ts
fetchTeam(teamId: number): Promise<TeamDetails>;
fetchOrganization(organizationId: number): Promise<OrganizationDetails>;
```

Use `fetchTeam` to resolve organization ID from a normal scenario URL.

- [ ] **Step 5: Implement sanitized incremental index**

Store under:

```text
~/.make-fixer/search-index/<zone>/<organizationId>/index.json
```

Persist after each fetched scenario with `lastEdit`, sanitized flattened
entries, a sanitized blueprint used by `examples`, and fetch timestamp. Never
persist raw unredacted blueprints.

- [ ] **Step 6: Implement organization-wide orchestration**

Default flow:

```ts
const team = await client.fetchTeam(teamId);
const scenarios = await client.listScenarios({ organizationId: team.organizationId });
await refreshChangedScenarios(scenarios, { concurrency: 2, checkpointEach: true });
```

Use the shared rate coordinator. Include rate metadata, cache hit count, failed
scenario IDs, and `incomplete`.

- [ ] **Step 7: Register and verify CLI**

Flags: `--from-url`, `--organization`, `--base-url`, exactly one of `--query`,
`--regex`, or `--field` plus `--value`; optional `--case-sensitive`, `--fresh`,
`--human`.

Run:

```bash
bun test src/search/search-index.test.ts src/commands/search.test.ts src/make-api/client.test.ts src/cli.test.ts
bun src/cli.ts search --help
```

- [ ] **Step 8: Commit**

```bash
git add src/search/search-index.ts src/search/search-index.test.ts src/commands/search.ts src/commands/search.test.ts src/make-api/client.ts src/make-api/client.test.ts src/cli.ts src/cli.test.ts
git diff --cached --check
git commit -m "feat: add organization blueprint search"
```

---

### Task 8: Add Scenario Interface Validation, Run, and Polling

**Files:**
- Create: `src/make-api/scenario-runner.ts`
- Create: `src/make-api/scenario-runner.test.ts`
- Create: `src/commands/run.ts`
- Create: `src/commands/run.test.ts`
- Modify: `src/make-api/client.ts`
- Modify: `src/make-api/client.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ScenarioInterface {
  input?: ScenarioInputField[];
  output?: ScenarioOutputField[] | null;
}

export interface ScenarioInputField {
  name: string;
  label?: string;
  type: string;
  required?: boolean;
  specification?: unknown;
}

export type ScenarioOutputField = ScenarioInputField;

export type InputValidationResult =
  | { valid: true; normalized: Record<string, unknown> }
  | { valid: false; issues: Array<{ path: string; message: string }> };

export function validateScenarioInput(spec: ScenarioInterface, data: unknown): InputValidationResult;
export function parseRunTimeout(value: string): number;

MakeApiClient.prototype.fetchScenarioInterface(scenarioId: number): Promise<ScenarioInterface>;
MakeApiClient.prototype.runScenario(
  scenarioId: number,
  body: { data?: object; responsive: boolean },
): Promise<{ executionId: string; status?: string; outputs?: object }>;
MakeApiClient.prototype.fetchExecutionDetails(
  scenarioId: number,
  executionId: string,
): Promise<{
  status: "RUNNING" | "SUCCESS" | "WARNING" | "ERROR";
  outputs?: Record<string, unknown>;
  error?: unknown;
}>;
```

- [ ] **Step 1: Write failing input validation tests**

Cover required text/number/boolean fields, arrays, nested collections, unknown
input names, malformed JSON, and no-input scenarios.

- [ ] **Step 2: Write failing run/poll tests**

Cover preview without `--yes`, immediate execution ID, responsive success,
initial timeout containing an execution ID, polling `RUNNING` to `SUCCESS`,
configured outputs, polling timeout that retains the ID, cancellation, and no
automatic resend.

- [ ] **Step 3: Verify RED**

```bash
bun test src/make-api/scenario-runner.test.ts src/commands/run.test.ts
```

- [ ] **Step 4: Implement documented API methods**

Use:

```text
GET  /api/v2/scenarios/{scenarioId}/interface
POST /api/v2/scenarios/{scenarioId}/run
GET  /api/v2/scenarios/{scenarioId}/executions/{executionId}
```

The run POST is sent only after `--yes`.
Mark only this POST as `organizationRateExempt: true`; interface and execution
status GETs remain within the organization rolling-rate bucket.

- [ ] **Step 5: Implement bounded polling**

Use exponential polling delays capped at five seconds and the shared
coordinator. A CLI wait timeout returns `ok: false`, code `RUN_STILL_RUNNING`,
and the execution ID without retrying the POST.

- [ ] **Step 6: Register and verify CLI**

Flags: `-s`, `--data`, `--data-file`, `--wait`, `--timeout`, `--yes`, `--human`.
Reject simultaneous `--data` and `--data-file`.

Run:

```bash
bun test src/make-api/scenario-runner.test.ts src/commands/run.test.ts src/make-api/client.test.ts src/cli.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/make-api/scenario-runner.ts src/make-api/scenario-runner.test.ts src/commands/run.ts src/commands/run.test.ts src/make-api/client.ts src/make-api/client.test.ts src/cli.ts src/cli.test.ts
git diff --cached --check
git commit -m "feat: run scenarios with durable outputs"
```

---

### Task 9: Add Capability-Aware `doctor`

**Files:**
- Create: `src/commands/doctor.ts`
- Create: `src/commands/doctor.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`

**Interfaces:**
- Consumes: `classifyApiResponse`, team/org/scenario/interface methods, rate snapshot.
- Produces:

```ts
export interface CapabilityProbe {
  name: string;
  supported: boolean;
  evidence: {
    method: "GET";
    path: string;
    httpStatus: number | null;
    providerCode: string | null;
  };
  limitation?: ClassifiedApiError;
}
```

- [ ] **Step 1: Write failing doctor tests**

Cover valid token, invalid token, missing organization scope, plan restriction,
scenario not found, zone resolution, fallback rate limit, discovered API limit,
and sanitized provider messages.

- [ ] **Step 2: Verify RED**

```bash
bun test src/commands/doctor.test.ts
```

- [ ] **Step 3: Implement safe probes**

Only use GET requests. Probe organization details, scenario details, blueprint,
and interface when corresponding IDs are supplied. Do not probe mutation
endpoints.

- [ ] **Step 4: Register and verify CLI**

Flags: `--from-url`, `-s`, `--json` accepted as a harmless explicit alias for
the default, and `--human`.

Run:

```bash
bun test src/commands/doctor.test.ts src/cli.test.ts
bun src/cli.ts doctor --help
```

- [ ] **Step 5: Commit**

```bash
git add src/commands/doctor.ts src/commands/doctor.test.ts src/cli.ts src/cli.test.ts
git diff --cached --check
git commit -m "feat: add Make capability diagnostics"
```

---

### Task 10: Add Connection Discovery and Organization Module Examples

**Files:**
- Create: `src/examples/module-examples.ts`
- Create: `src/examples/module-examples.test.ts`
- Create: `src/commands/examples.ts`
- Create: `src/commands/examples.test.ts`
- Create: `src/commands/connections.ts`
- Create: `src/commands/connections.test.ts`
- Modify: `src/make-api/types.ts`
- Modify: `src/make-api/client.ts`
- Modify: `src/make-api/client.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`

**Interfaces:**
- Consumes: `ScenarioIndexRecord`, `walkModules`, and the shared output envelope.
- Produces:

```ts
export interface ModuleExample {
  scenarioId: number;
  scenarioName: string;
  teamId: number;
  moduleId: number;
  path: string;
  module: string;
  version: number;
  signature: string;
  equivalentCount: number;
  equivalentLocations: Array<{ scenarioId: number; moduleId: number; path: string }>;
  fragment: Module;
}

export interface ModuleExampleQuery {
  module?: string;
  app?: string;
  search?: string;
  version?: number;
  scenarioId?: number;
  moduleId?: number;
  full?: boolean;
}

export interface ConnectionSummary {
  id: number;
  name: string;
  accountName: string;
  accountLabel: string;
  packageName: string | null;
  teamId: number;
  scoped: boolean;
  metadata: unknown;
}

export function moduleConfigurationSignature(module: Module): string;
export function findModuleExamples(
  records: ScenarioIndexRecord[],
  query: ModuleExampleQuery,
): ModuleExample[];

MakeApiClient.prototype.listConnections(teamId: number): Promise<ConnectionSummary[]>;
```

- [ ] **Step 1: Write failing example matching tests**

Create fixtures containing the same app action in top-level flow, a branch, and
an error route. Assert exact module, app-prefix, version, literal search, and
exact scenario/module selection all use canonical paths.

- [ ] **Step 2: Write failing grouping and redaction tests**

Assert examples with the same module/version and recursively sorted
parameter/mapper/metadata key shapes share one signature. Assert mapper values,
ordinary URLs, resource IDs, connection IDs, restore labels, and interface
metadata remain usable while values under these case-insensitive keys are
redacted:

```ts
["token", "secret", "password", "authorization", "apiKey", "cookie", "credentials"]
```

Assert `--full` is rejected unless both exact scenario ID and module ID are
present.

- [ ] **Step 3: Write failing connection contract tests**

Assert `GET /api/v2/connections?teamId=2186253` is paged through the shared
coordinator. The public result includes `id`, `name`, `accountName`,
`accountLabel`, `packageName`, `teamId`, `scoped`, and sanitized metadata, but
excludes authentication data and credentials.

- [ ] **Step 4: Verify RED**

```bash
bun test src/examples/module-examples.test.ts src/commands/examples.test.ts src/commands/connections.test.ts src/make-api/client.test.ts
```

- [ ] **Step 5: Implement deterministic example discovery**

Run Task 7's incremental organization refresh first, then read its sanitized
blueprints. Walk every module, filter before grouping, sort groups by module
name/version/signature, and sort locations by scenario ID/module ID/path.
Return `found: false`, not a guessed schema, when no accessible scenario
contains a match.

- [ ] **Step 6: Implement and register the commands**

```bash
make-fixer examples --from-url <url> --module <module>
make-fixer examples --from-url <url> --app <app>
make-fixer examples --from-url <url> --search <text>
make-fixer examples --from-url <url> --scenario <id> --module-id <id> --full
make-fixer connections --from-url <url>
```

Require exactly one example lookup mode. `connections` always scopes to the
team in the supplied URL; it does not list or mutate credentials.

- [ ] **Step 7: Verify GREEN**

```bash
bun test src/examples/module-examples.test.ts src/commands/examples.test.ts src/commands/connections.test.ts src/make-api/client.test.ts src/cli.test.ts
bun src/cli.ts examples --help
bun src/cli.ts connections --help
```

- [ ] **Step 8: Commit**

```bash
git add src/examples/module-examples.ts src/examples/module-examples.test.ts src/commands/examples.ts src/commands/examples.test.ts src/commands/connections.ts src/commands/connections.test.ts src/make-api/types.ts src/make-api/client.ts src/make-api/client.test.ts src/cli.ts src/cli.test.ts
git diff --cached --check
git commit -m "feat: discover reusable Make module examples"
```

---

### Task 11: Add Owned Scenario Creation and Guarded Cleanup

**Files:**
- Create: `src/probes/ownership-store.ts`
- Create: `src/probes/ownership-store.test.ts`
- Create: `src/commands/create.ts`
- Create: `src/commands/create.test.ts`
- Create: `src/commands/cleanup.ts`
- Create: `src/commands/cleanup.test.ts`
- Modify: `src/commands/run.ts`
- Modify: `src/commands/run.test.ts`
- Modify: `src/make-api/types.ts`
- Modify: `src/make-api/client.ts`
- Modify: `src/make-api/client.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`

**Interfaces:**
- Consumes: blueprint validation, fingerprints, the request coordinator, and
  team/organization resolution.
- Produces:

```ts
export type ProbeLifecycleState =
  | "created"
  | "verified"
  | "active"
  | "running"
  | "terminal"
  | "inactive"
  | "cleanup_failed"
  | "deleted";

export interface OwnedScenarioRecord {
  scenarioId: number;
  operationId: string;
  teamId: number;
  organizationId: number;
  baseUrl: string;
  createdAt: string;
  updatedAt: string;
  lastVerifiedFingerprint: string;
  lifecycleState: ProbeLifecycleState;
  executionId: string | null;
}

export interface OwnershipStore {
  put(record: OwnedScenarioRecord): void;
  get(baseUrl: string, scenarioId: number): OwnedScenarioRecord | null;
  update(baseUrl: string, scenarioId: number, patch: Partial<OwnedScenarioRecord>): void;
  listPending(): OwnedScenarioRecord[];
  markDeleted(baseUrl: string, scenarioId: number): void;
}

export interface CreateScenarioInput {
  teamId: number;
  blueprint: Blueprint;
  scheduling: { type: "on-demand" };
  confirmed?: boolean;
}

export interface ScenarioDetails {
  id: number;
  name: string;
  teamId: number;
  isActive: boolean;
  iswaiting?: boolean;
  scheduling: unknown;
}

MakeApiClient.prototype.createScenario(input: CreateScenarioInput): Promise<ScenarioDetails>;
MakeApiClient.prototype.fetchScenarioDetails(scenarioId: number): Promise<ScenarioDetails>;
MakeApiClient.prototype.startScenario(scenarioId: number): Promise<ScenarioDetails>;
MakeApiClient.prototype.stopScenario(scenarioId: number): Promise<ScenarioDetails>;
MakeApiClient.prototype.deleteScenario(scenarioId: number): Promise<number>;
```

- [ ] **Step 1: Write failing ownership-store tests**

Use a temporary SQLite file. Assert WAL mode, insert/update/read, unique
`baseUrl + scenarioId`, pending cleanup ordering, lifecycle transitions, and
that a record marked `deleted` is absent from pending cleanup.

- [ ] **Step 2: Write failing create contract tests**

Assert preview mode performs no POST. With `--yes`, assert:

```json
{
  "blueprint": "<JSON string>",
  "teamId": 2186253,
  "scheduling": "{\"type\":\"on-demand\"}"
}
```

is sent to `POST /api/v2/scenarios`, the default name begins
`[make-fixer probe]`, contains a generated UUID operation marker, the response
is fetched back, and the last verified fingerprint is recorded. Assert
`--no-probe-label` removes only the human-readable prefix while retaining the
operation marker needed for reconciliation.

- [ ] **Step 3: Write failing guarded-cleanup tests**

Cover missing ownership, mismatched team/zone, active remote scenario, drifted
remote fingerprint, read-only cleanup status, missing `--yes`, successful
delete, and delete response reconciliation after a network timeout. No blocked
case sends DELETE.

Assert `create` and `run` results include
`meta.pendingCleanup = ownership.listPending()` without mutating any pending
scenario.

- [ ] **Step 4: Verify RED**

```bash
bun test src/probes/ownership-store.test.ts src/commands/create.test.ts src/commands/cleanup.test.ts src/make-api/client.test.ts
```

- [ ] **Step 5: Implement the SQLite ownership store**

Store records in the shared global-state SQLite database but a separate
`owned_scenarios` table. Use short transactions. Never store blueprint content,
inputs, outputs, or credentials.

- [ ] **Step 6: Implement scenario lifecycle API methods**

Use documented endpoints:

```bash
POST   /api/v2/scenarios
POST   /api/v2/scenarios/{scenarioId}/start
POST   /api/v2/scenarios/{scenarioId}/stop
DELETE /api/v2/scenarios/{scenarioId}
```

Before POST, generate one `operationId` with `crypto.randomUUID()` and set the
blueprint name to `[make-fixer probe] <requested-name> [<operationId>]`, or
`<requested-name> [<operationId>]` with `--no-probe-label`. Creation is
reconciled after ambiguous transport failure by listing scenarios in the target
team and matching that exact operation marker. More than one match is an
explicit `AMBIGUOUS_CREATE` failure. Deletion is reconciled with a scenario GET:
404 means the owned delete completed.

- [ ] **Step 7: Implement and register `create` and `cleanup`**

`create` validates the blueprint, forces on-demand scheduling, previews unless
`--yes`, verifies remote state, and records ownership. `cleanup` defaults to
status-only. Deletion requires `--delete --yes`, inactive state, exact ownership,
and the current remote fingerprint matching `lastVerifiedFingerprint`. Add
pending owned records to new mutation-command metadata so an interrupted agent
can ask the user about them later.

- [ ] **Step 8: Verify GREEN**

```bash
bun test src/probes/ownership-store.test.ts src/commands/create.test.ts src/commands/cleanup.test.ts src/make-api/client.test.ts src/cli.test.ts
bun src/cli.ts create --help
bun src/cli.ts cleanup --help
```

- [ ] **Step 9: Commit**

```bash
git add src/probes/ownership-store.ts src/probes/ownership-store.test.ts src/commands/create.ts src/commands/create.test.ts src/commands/cleanup.ts src/commands/cleanup.test.ts src/commands/run.ts src/commands/run.test.ts src/make-api/types.ts src/make-api/client.ts src/make-api/client.test.ts src/cli.ts src/cli.test.ts
git diff --cached --check
git commit -m "feat: add owned scenario lifecycle"
```

---

### Task 12: Add Generic Probe Orchestration

**Files:**
- Create: `src/probes/probe-runner.ts`
- Create: `src/probes/probe-runner.test.ts`
- Create: `src/commands/probe.ts`
- Create: `src/commands/probe.test.ts`
- Modify: `src/make-api/types.ts`
- Modify: `src/make-api/client.ts`
- Modify: `src/make-api/client.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`

**Interfaces:**
- Consumes: `createScenario`, `runScenario`, execution polling, the ownership
  store, fingerprints, canonical traversal, and stable output envelopes.
- Produces:

```ts
export interface ProbeRequest {
  teamId: number;
  organizationId: number;
  baseUrl: string;
  blueprint: Blueprint;
  name: string;
  data?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ProbeResult {
  scenarioId: number;
  executionId: string | null;
  executionStatus: "SUCCESS" | "WARNING" | "ERROR" | "CANCELLED" | "UNKNOWN";
  outputs: Record<string, unknown> | null;
  executionError: unknown | null;
  postRunInterfaces: Array<{ moduleId: number; path: string; interface: unknown }>;
  moduleLogs: Array<{ moduleId: number; status: number; bundles: number }>;
  scenarioActive: boolean | null;
  cleanupRequired: true;
  cleanupOptions: ["keep", "delete", "revise_and_rerun"];
  userDecisionRequired: true;
}

export interface ProbeDependencies {
  client: Pick<
    MakeApiClient,
    | "createScenario"
    | "fetchScenarioDetails"
    | "fetchBlueprint"
    | "fetchScenarioInterface"
    | "startScenario"
    | "runScenario"
    | "fetchExecutionDetails"
    | "stopScenarioExecution"
    | "listModuleLogs"
    | "stopScenario"
  >;
  ownership: OwnershipStore;
  fingerprint: typeof fingerprintBlueprint;
}

export interface ModuleLogSummary {
  moduleId: number;
  executionId: string;
  status: number;
  bundles: number;
}

MakeApiClient.prototype.stopScenarioExecution(
  scenarioId: number,
  executionId: string,
  force?: boolean,
): Promise<void>;
MakeApiClient.prototype.listModuleLogs(
  scenarioId: number,
  moduleId: number,
): Promise<ModuleLogSummary[]>;

export async function runOwnedProbe(
  deps: ProbeDependencies,
  request: ProbeRequest,
): Promise<ProbeResult>;
```

- [ ] **Step 1: Write the failing successful-lifecycle test**

With a fake client, assert this exact order:

```text
create -> fetch blueprint -> fetch interface -> record verified
-> start -> record active -> run once -> record execution ID
-> poll RUNNING -> poll SUCCESS -> fetch blueprint -> fetch module logs
-> stop scenario -> verify inactive -> refresh fingerprint -> record inactive
```

Assert outputs, post-run module interfaces, module-log counts, and all three
cleanup options are returned. Assert DELETE is never called.

- [ ] **Step 2: Write failing compensation and cancellation tests**

Cover:

- create failure: no ownership record and no compensation;
- remote verification failure: scenario remains owned/inactive and cleanup is
  required;
- activation failure: no run POST, then verify inactive;
- run failure before execution ID: deactivate the owned scenario;
- terminal execution error: return its error, then deactivate;
- cancellation while running: stop that exact execution, then deactivate;
- stop-execution or deactivation failure: exit code 5, state
  `cleanup_failed`, exact unresolved state returned;
- no path mutates a pre-existing scenario ID.

- [ ] **Step 3: Write failing API contract tests**

Assert:

```text
POST /api/v2/scenarios/{scenarioId}/executions/{executionId}/stop
GET  /api/v2/scenarios/{scenarioId}/modules/{moduleId}/logs
```

use encoded IDs, the shared coordinator, and sanitized errors. The run POST is
sent exactly once and remains organization-rate-exempt.

- [ ] **Step 4: Verify RED**

```bash
bun test src/probes/probe-runner.test.ts src/commands/probe.test.ts src/make-api/client.test.ts
```

- [ ] **Step 5: Implement the probe state machine**

Use one `try/catch/finally` orchestration boundary and persist every confirmed
lifecycle transition before the next remote mutation. Poll until terminal or
abort. On abort, stop only the recorded execution. Deactivate only the owned
scenario. Refetch after the run and collect every module's populated
`metadata.interface` through canonical traversal.

- [ ] **Step 6: Implement output truthfulness**

Return `execution.outputs` as actual payload only when provided by the
documented execution endpoint. Return post-run interface metadata separately.
Module logs report only status/bundle counts. Never label either one as
intermediate bundle contents.

- [ ] **Step 7: Register `probe`**

Flags: `--from-url`, `--blueprint`, `--name`, `--data`, `--data-file`,
`--timeout`, `--yes`, `--human`. Preview performs validation and connection
reference checks but no mutation. A completed mutation always returns
`userDecisionRequired: true`; its metadata includes every other pending owned
scenario without modifying them.

- [ ] **Step 8: Verify GREEN**

```bash
bun test src/probes/probe-runner.test.ts src/commands/probe.test.ts src/make-api/client.test.ts src/cli.test.ts
bun src/cli.ts probe --help
```

- [ ] **Step 9: Commit**

```bash
git add src/probes/probe-runner.ts src/probes/probe-runner.test.ts src/commands/probe.ts src/commands/probe.test.ts src/make-api/types.ts src/make-api/client.ts src/make-api/client.test.ts src/cli.ts src/cli.test.ts
git diff --cached --check
git commit -m "feat: add generic Make scenario probes"
```

---

### Task 13: Update Agent Documentation Without Growing Resident Context

**Files:**
- Modify: `README.md`
- Modify: `skills/make-fixer/SKILL.md`

**Interfaces:**
- Consumes: final command help and stable output contracts.
- Produces: concise routing and cleanup guidance for AI agents.

- [ ] **Step 1: Add README command examples**

Document exact examples for `inspect`, `search`, `examples`, `connections`,
`create`, `run`, `probe`, `cleanup`, `doctor`, and semantic validation. State
that search/examples default organization-wide, probes retain scenarios, and
only the user decides whether to keep, delete, or revise them.

- [ ] **Step 2: Replace ad hoc parsing guidance in the skill**

Add:

```markdown
- Exact module question -> `make-fixer inspect --module`.
- Find an ID, URL, prompt, field, or module across Make -> `make-fixer search`.
- Learn a real module configuration -> `make-fixer examples`.
- Discover an existing connection -> `make-fixer connections`.
- Learn a provider response -> create an explicit-output blueprint and use `make-fixer probe`.
- After every probe -> report results and ask the user to keep, delete, or revise and rerun.
- Never treat module logs or post-run interfaces as intermediate output bundles.
```

Remove provider-specific recovery instructions and manual recursive blueprint
parsing where the new commands now apply.

- [ ] **Step 3: Verify documentation against help**

```bash
bun src/cli.ts inspect --help
bun src/cli.ts search --help
bun src/cli.ts examples --help
bun src/cli.ts connections --help
bun src/cli.ts create --help
bun src/cli.ts run --help
bun src/cli.ts probe --help
bun src/cli.ts cleanup --help
bun src/cli.ts doctor --help
```

Expected: every documented command and flag exists exactly as written.

- [ ] **Step 4: Commit**

```bash
git add README.md skills/make-fixer/SKILL.md
git diff --cached --check
git commit -m "docs: teach agents the probe workflow"
```

---

### Task 14: Full Verification and Safe Live API Evidence

**Files:**
- Modify only if failures require fixes in owned files.
- Update: `docs/superpowers/plans/2026-07-23-agent-first-cli-baseline.md`

**Interfaces:**
- Consumes: all implemented commands.
- Produces: complete automated evidence plus real read-only and approved probe
  evidence.

- [ ] **Step 1: Run complete automated verification**

```bash
bun test
bun run typecheck
git diff --check
```

Expected: zero test failures, zero type errors, zero whitespace errors.

- [ ] **Step 2: Verify the original branch regression**

```bash
bun test src/commands/inspect.test.ts
```

Expected: module 18 is found inside `branches`, and next ID exceeds every
module/error-handler ID.

- [ ] **Step 3: Run safe real read-only commands**

```bash
bun src/cli.ts doctor --from-url "https://eu1.make.com/2186253/scenarios/6648651/edit"
bun src/cli.ts search --from-url "https://eu1.make.com/2186253/scenarios/6648651/edit" --query "boardId" --fresh
bun src/cli.ts examples --from-url "https://eu1.make.com/2186253/scenarios/6648651/edit" --search "boardId"
bun src/cli.ts connections --from-url "https://eu1.make.com/2186253/scenarios/6648651/edit"
```

Expected: organization coverage and exact paths are explicit, connections omit
credentials, limit metadata reports the discovered API limit and 95% effective
rate, and no secret values appear.

- [ ] **Step 4: Prepare a harmless explicit-output probe**

Use `examples` to locate the organization's real Scenarios `Return output`
module shape. Build a minimal local blueprint containing only built-in
data-construction modules plus that output module; use no external connection
and no write-capable provider module. Validate it locally and retain the exact
fixture in `tests/fixtures/probe-blueprint.json`.

- [ ] **Step 5: Run one approved live probe**

The user approved scenario creation/testing in this thread. Target only team
`2186253` from the supplied scenario URL:

```bash
bun src/cli.ts probe --from-url "https://eu1.make.com/2186253/scenarios/6648651/edit" --blueprint tests/fixtures/probe-blueprint.json --name "Make Fixer verification" --yes
```

Expected: one labeled scenario is created, verified, activated, run once,
returns a configured output and post-run interface evidence, is deactivated,
and remains present with `userDecisionRequired: true`. Do not delete it without
the user's cleanup decision.

- [ ] **Step 6: Verify retained probe state**

```bash
bun src/cli.ts cleanup -s <created-scenario-url>
```

Expected: ownership and fingerprint match, the scenario is inactive, and the
three options `keep`, `delete`, and `revise_and_rerun` are returned without
mutation.

- [ ] **Step 7: Review the final diff against scope**

```bash
git status --short
git diff --stat HEAD
git diff --check HEAD
```

Confirm no unrelated dirty file was reverted, staged, or absorbed.

- [ ] **Step 8: Record evidence and ask the cleanup question**

Append exact command results, test counts, live endpoint statuses, rate-limit
metadata, created scenario ID/URL, terminal execution status, configured output
shape, inactive-state proof, and any unavailable capability to the baseline
evidence document. Do not record organization lists, customer data, tokens, or
full blueprints. Report the result to the user and ask whether to keep, delete,
or revise and rerun the retained scenario.

- [ ] **Step 9: Commit final fixture and evidence**

```bash
git add tests/fixtures/probe-blueprint.json docs/superpowers/plans/2026-07-23-agent-first-cli-baseline.md
git diff --cached --check
git commit -m "test: verify agent-first Make workflows"
```
