# Agent-First Make Fixer CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the standalone Make Fixer CLI reliable and efficient for AI agents by fixing complete blueprint traversal and adding rate-aware inspection, search, execution, capability, diff, and Monday board-ID workflows.

**Architecture:** Introduce small command modules over an expanded `MakeApiClient`, with one canonical recursive blueprint walker and one cross-process request coordinator. New commands use stable JSON envelopes while existing commands and JSON shapes remain unchanged. All provider behavior is grounded in documented endpoints, mock HTTP contract tests, and safe live read-only probes.

**Tech Stack:** Bun 1.3+, TypeScript, Commander 14, Zod 4, `bun:test`, `bun:sqlite`, Make REST API v2, Monday GraphQL API.

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
- Dynamic Monday board mappings are never modified.
- Only exact, unique, active, same-type Monday board matches may be synchronized.
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
- `src/commands/monday.ts` — Monday audit/sync CLI orchestration.
- `src/make-api/api-error.ts` — sanitized provider error parsing and capability classification.
- `src/make-api/rate-limiter.ts` — cross-process rolling-window reservations and shared cooldowns.
- `src/make-api/request-coordinator.ts` — pacing, retry, cancellation, and GET deduplication.
- `src/make-api/scenario-runner.ts` — pure input validation and polling state machine.
- `src/utils/semantic-diff.ts` — exact leaf changes and ancestor classification.
- `src/utils/blueprint-fingerprint.ts` — stable remote fingerprints and sidecar metadata.
- `src/search/search-index.ts` — redacted flattened documents, cache, and matching.
- `src/monday/board-reconciliation.ts` — pure extraction, classification, and scalar patch planning.
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

- [ ] **Step 4: Commit only if the baseline file is isolated**

Run:

```bash
git diff -- docs/superpowers/plans/2026-07-23-agent-first-cli-baseline.md
```

If that is the only staged content:

```bash
git add docs/superpowers/plans/2026-07-23-agent-first-cli-baseline.md
git commit -m "test: record agent-first cli baseline"
```

Otherwise leave it uncommitted and continue without staging unrelated work.

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

Do not stage `src/make-api/client.ts` if its existing execution-query changes
would be captured unintentionally. If it overlaps, leave the full task
uncommitted and document the reason in the baseline file.

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

export function sanitizeForIndex(value: unknown): unknown;
export function flattenSearchDocument(value: unknown, basePath?: string): SearchEntry[];
export function searchEntries(entries: SearchEntry[], query: SearchQuery): SearchMatch[];
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
entries, and fetch timestamp. Never persist raw unredacted blueprints.

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

export function validateScenarioInput(spec: ScenarioInterface, data: unknown): InputValidationResult;
export function parseRunTimeout(value: string): number;

MakeApiClient.prototype.fetchScenarioInterface(scenarioId: number): Promise<ScenarioInterface>;
MakeApiClient.prototype.runScenario(
  scenarioId: number,
  body: { data?: object; responsive: boolean },
): Promise<{ executionId: string; status?: string; outputs?: object }>;
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

---

### Task 10: Add Monday Board-ID Audit and Local Sync

**Files:**
- Create: `src/monday/board-reconciliation.ts`
- Create: `src/monday/board-reconciliation.test.ts`
- Create: `src/commands/monday.ts`
- Create: `src/commands/monday.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`

**Interfaces:**
- Produces:

```ts
export type BoardReferenceStatus =
  | "valid"
  | "stale"
  | "dynamic"
  | "missing-label"
  | "no-match"
  | "ambiguous"
  | "type-conflict"
  | "inaccessible";

export interface BoardReferenceAudit {
  scenarioId: number;
  moduleId: number;
  path: string;
  boardPath: string;
  currentBoardId: string;
  savedBoardName: string | null;
  expectedType: "board" | "sub_items_board";
  status: BoardReferenceStatus;
  replacementBoardId: string | null;
}

export function extractMondayBoardReferences(blueprint: Blueprint, scenarioId: number): BoardReference[];
export function classifyBoardReference(reference: BoardReference, boards: MondayBoard[]): BoardReferenceAudit;
export function applyBoardSyncPlan(blueprint: Blueprint, plan: BoardReferenceAudit[]): Blueprint;
```

- [ ] **Step 1: Write failing extraction tests**

Cover board IDs in mapper and parameters, nested branch modules, saved restore
labels, subitem boards, dynamic expressions, blank labels, and modules without
board fields.

- [ ] **Step 2: Write failing classification tests**

Cover all eight statuses. Assert only `stale` with one exact active same-type
candidate receives a replacement.

- [ ] **Step 3: Write failing patch tests**

Assert only the exact scalar paths change and semantic diff reports only the
target Monday modules.

- [ ] **Step 4: Verify RED**

```bash
bun test src/monday/board-reconciliation.test.ts src/commands/monday.test.ts
```

- [ ] **Step 5: Implement Monday API reader**

Read `MONDAY_TOKEN` from the current project environment. Request the active API
version, then page through boards with `id`, `name`, `type`, and `state`. Send
the discovered API version header. Reuse a small provider-specific coordinator
with conservative concurrency and 429 retry-until-success behavior.

- [ ] **Step 6: Implement audit orchestration**

Resolve the supplied Make scenario by default. When `--scope team` is present,
page through every scenario in that URL's team. Fetch through the shared
coordinator, extract all Monday references, and classify them against the live
Monday board list. Do not silently expand a Monday audit to the organization.

- [ ] **Step 7: Implement local sync plan**

`sync-board-ids` without `--apply` returns a plan. With `--apply`, write only
local blueprint files and a manifest:

```json
{
  "scenarioId": 6648651,
  "moduleId": 18,
  "path": "flow[1].branches[0].flow[0].mapper.boardId",
  "oldId": "5100313109",
  "newId": "5100794841",
  "boardName": "לקוחות",
  "evidence": "unique_active_same_name_same_type"
}
```

No push occurs.

- [ ] **Step 8: Register and verify CLI**

Commands:

```bash
make-fixer monday audit-board-ids --from-url <url>
make-fixer monday audit-board-ids --from-url <url> --scope team
make-fixer monday sync-board-ids --from-url <url> --scope team
make-fixer monday sync-board-ids --from-url <url> --scope team --apply
```

Run:

```bash
bun test src/monday/board-reconciliation.test.ts src/commands/monday.test.ts src/cli.test.ts
```

---

### Task 11: Update Agent Documentation Without Growing Resident Context

**Files:**
- Modify: `README.md`
- Modify: `skills/make-fixer/SKILL.md`
- Modify: `.agents/skills/make-fixer/SKILL.md` only if it is the repository-owned active mirror and not generated.

**Interfaces:**
- Consumes: final command help and stable output contracts.
- Produces: concise routing guidance for AI agents.

- [ ] **Step 1: Add README command examples**

Document exact examples for `inspect`, `search`, `run`, `doctor`, semantic
validation, and Monday audit/sync. State that search defaults organization-wide
and that sync does not push.

- [ ] **Step 2: Replace ad hoc parsing guidance in the skill**

Add routing rules:

```markdown
- Exact module question -> `make-fixer inspect --module`.
- Find an ID, URL, prompt, field, or module across Make -> `make-fixer search`.
- Diagnose capability/auth/plan behavior -> `make-fixer doctor`.
- Run on-demand scenario -> `make-fixer run`; never resend after timeout.
- Monday board migration -> audit first, sync locally second, validate third, push only after approval.
```

Remove instructions that tell agents to manually recurse through blueprint JSON
when a new command now handles it. Keep deep reference files load-on-demand.

- [ ] **Step 3: Correct the debugging contract**

State that a provider error such as `board_id:null` must be checked against the
live dependency before suggesting stale execution or runtime mapping theories.

- [ ] **Step 4: Verify examples against help**

Run:

```bash
bun src/cli.ts inspect --help
bun src/cli.ts search --help
bun src/cli.ts run --help
bun src/cli.ts doctor --help
bun src/cli.ts monday --help
```

Expected: every documented flag exists exactly as written.

---

### Task 12: Full Verification and Safe Live API Evidence

**Files:**
- Modify only if failures require fixes in owned files.
- Update: `docs/superpowers/plans/2026-07-23-agent-first-cli-baseline.md`

**Interfaces:**
- Consumes: all implemented commands.
- Produces: fresh local verification and read-only real API evidence.

- [ ] **Step 1: Run complete automated verification**

```bash
bun test
bun run typecheck
git diff --check
```

Expected: zero test failures, zero type errors, zero whitespace errors.

- [ ] **Step 2: Verify the original branch regression locally**

```bash
bun test src/commands/inspect.test.ts
```

Expected: the fixture-backed test proves module 18 is found inside `branches`,
and the next ID exceeds every module/error-handler ID.

- [ ] **Step 3: Run read-only `doctor` against the supplied real scenario**

```bash
bun src/cli.ts doctor --from-url "https://eu1.make.com/2186253/scenarios/6648651/edit"
```

Expected evidence for the current account: organization resolution succeeds,
`license.apiLimit` is reported, and no token value appears.

- [ ] **Step 4: Run read-only organization search**

```bash
bun src/cli.ts search --from-url "https://eu1.make.com/2186253/scenarios/6648651/edit" --field boardId --value 5100794841 --fresh
```

Expected: organization-wide coverage metadata, exact scenario/module paths,
rate statistics, and no sensitive values. If some scenarios are inaccessible,
the result must say `incomplete: true`.

- [ ] **Step 5: Run read-only Monday audit**

Only if the current project contains `MONDAY_TOKEN` and the user has authorized
this real account:

```bash
bun src/cli.ts monday audit-board-ids --from-url "https://eu1.make.com/2186253/scenarios/6648651/edit"
```

Expected: no Make or Monday writes; every reference has an explicit status and
evidence.

- [ ] **Step 6: Do not run a live scenario or push**

`make-fixer run --yes`, `make-fixer push`, and Monday `--apply` are not part of
read-only final verification. They require a separate known-safe target and
explicit approval.

- [ ] **Step 7: Review the final diff against scope**

```bash
git status --short
git diff --stat HEAD
git diff --check HEAD
```

Confirm no unrelated dirty file was reverted, staged, or absorbed.

- [ ] **Step 8: Record final evidence**

Append exact command results, test counts, live endpoint statuses, rate-limit
metadata, and any unavailable capability to the baseline evidence document.
Do not record organization lists, customer data, tokens, or full blueprints.
