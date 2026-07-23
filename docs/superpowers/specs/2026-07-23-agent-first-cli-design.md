# Agent-First Make Fixer CLI Design

## Goal

Make Fixer remains a standalone, backward-compatible Bun CLI, but becomes much
more effective for AI agents inspecting, changing, running, and verifying
Make.com scenarios.

The work is driven by the failure documented in the supplied conversation:

- nested `BasicIfElse.branches` modules were invisible to traversal;
- `Next ID: 18` was printed even though module 18 already existed;
- agents had to recreate recursive inspection, dependency validation, batch
  patching, and execution polling with large PowerShell scripts;
- a stale external-system identifier was treated as a blueprint/runtime
  contradiction instead of being checked by running a small diagnostic
  scenario against the real system;
- validation described ancestor modules as modified without identifying the
  exact changed leaf fields;
- an installed CLI/documentation mismatch caused an ISO timestamp to fail.

## Product Principles

1. **Standalone CLI.** Do not require an MCP client, MCP token, or MCP
   transport.
2. **Backward compatibility.** Existing commands, flags, human output, and JSON
   shapes remain unchanged. New behavior is added through new commands or new
   optional flags.
3. **Agent-first interfaces.** New commands produce stable JSON by default,
   write operational messages to stderr, use deterministic exit codes, and
   expose exact provenance.
4. **API evidence, not assumptions.** Implement capabilities from documented
   Make API endpoints and verify them with read-only real API requests where
   possible.
5. **Capability-aware behavior.** Distinguish invalid authentication, missing
   token scope, plan/subscription restriction, unsupported endpoint, transient
   failure, and invalid data. Never infer universal availability from one
   account.
6. **Safe mutation.** Read and inspect immediately. Preview changes before
   writing. Require explicit confirmation for remote writes. Detect remote
   drift before pushing.
7. **Independent full-text search.** Provide organization-wide search by
   indexing scenario data from the public API. Do not depend on Make Grid or its
   subscription-gated search implementation.
8. **No secret disclosure.** Tokens remain in environment/config files and are
   never returned in JSON or logs.
9. **Rate-limit preservation.** Proactively pace requests below the
   organization's actual API allowance, coordinate concurrent CLI processes,
   cache repeatable reads, and checkpoint long scans.
10. **Framework-agnostic diagnostics.** Make Fixer supplies generic scenario,
    connection, example-discovery, execution, and cleanup primitives. Provider
    semantics belong in the probe blueprint, not in provider-specific CLI code.

## Official MCP Ideas to Reproduce Through the API

The useful MCP behaviors are transport-independent:

- self-describing operations with structured input and output;
- scenario interfaces used as schemas for tool input;
- scope-aware resource management;
- durable `executionId` values when a run exceeds the synchronous timeout;
- later retrieval of status and configured outputs;
- narrow tools instead of requiring agents to manipulate raw payloads.

Make's public API exposes the required primitives:

- `GET /api/v2/scenarios/{scenarioId}/interface`;
- `POST /api/v2/scenarios/{scenarioId}/run`;
- `GET /api/v2/scenarios/{scenarioId}/executions/{executionId}`;
- `POST /api/v2/scenarios`;
- `POST /api/v2/scenarios/{scenarioId}/start`;
- `POST /api/v2/scenarios/{scenarioId}/stop`;
- `DELETE /api/v2/scenarios/{scenarioId}`;
- scenario blueprints, scenario details, execution logs, connections, hooks,
  organizations, and teams.

The public API does not expose one universal configuration schema for every
standard app module. Make Fixer therefore learns reusable module shapes from
real blueprints already accessible to the organization. This is an explicit
limitation, not a reason to hard-code individual providers.

The current configured token was verified with a real read-only
`GET /api/v2/organizations` request across the known zones on 2026-07-23. That
proves the existing token and multi-zone organization discovery path work, but
does not prove every endpoint or subscription-gated capability is available.
Each new live capability therefore gets its own request-level verification.

## Architecture

### 1. Shared Organization Rate Limiting

Replace independent per-request retry behavior with one shared request
coordinator used by every `MakeApiClient` request.

Make documents organization limits by subscription:

- Core: 60 requests per minute;
- Pro: 120 requests per minute;
- Teams: 240 requests per minute;
- Enterprise: 1,000 requests per minute.

`GET /api/v2/organizations/{organizationId}` exposes the account's exact
`license.apiLimit`. A real read-only request for organization `8430514` on
2026-07-23 returned HTTP 200 and `apiLimit: 60`, confirming the documented
discovery path for the supplied account.

The coordinator uses a bucket per Make zone and organization. It uses 95% of
the discovered allowance, rounded down:

```ts
effectiveRequestsPerMinute = Math.max(1, Math.floor(apiLimit * 0.95));
```

`--max-rpm <n>` may set a lower command-specific ceiling but cannot exceed 95%
of the discovered organization limit. There is no adaptive utilization model or
automatic increase/decrease policy.

When organization details are inaccessible, use a conservative 30 requests per
minute and report `limitSource: "fallback"` rather than guessing the plan.

Coordination must work across multiple AI agents and CLI processes. Store rate
state in a small `bun:sqlite` database under Make Fixer's global state
directory. Use WAL mode and short transactions to atomically reserve request
slots. Each reservation records zone, organization ID or `unknown`, timestamp,
and process ID. Old reservations are pruned after the rolling 60-second window.

The scheduler:

- waits before sending a request rather than deliberately hitting 429;
- limits in-flight requests per organization to two by default;
- allows sequential mode for mutation batches;
- adds small random jitter to prevent multiple agents waking simultaneously;
- exposes an abort signal so cancellation or user interruption stops queued
  requests before they are sent;
- never holds a SQLite transaction while sleeping or performing network I/O.

429 and 503 use different recovery policies:

- **429:** honor `Retry-After` in either integer-seconds or HTTP-date form; when
  absent, wait at least 60 seconds as Make documents. Record a shared
  organization cooldown so other processes do not continue sending requests.
  Retry indefinitely until the request succeeds or the process receives a user
  cancellation/abort signal. A 429 never consumes a retry budget.
- **503:** exponential backoff with full jitter, capped at 30 seconds.
- **Network errors:** bounded retry with jitter; mutations are retried only when
  the method/endpoint is known to be idempotent or an idempotency/reconciliation
  check proves whether it completed.

Retry budgets are command-wide as well as request-local for failures other than
429. A large scan cannot retry every 503 or network failure indefinitely.
Default budgets:

- maximum five retries for one request;
- maximum twenty retry attempts across one command;
- unlimited 429 cooldown/retry cycles until success or user cancellation.

Read-heavy commands minimize calls before scheduling:

- use the largest API-supported page size;
- use scenario `lastEdit` to avoid refetching unchanged blueprints;
- cache organization limit metadata with a one-hour TTL;
- persist each successfully indexed scenario immediately;
- resume incomplete organization scans from checkpoints;
- deduplicate identical in-flight GET requests within one process.

Every new command includes rate evidence in `meta.rateLimit`:

```json
{
  "organizationId": 8430514,
  "documentedRpm": 60,
  "effectiveRpm": 57,
  "limitSource": "organization_api",
  "requestsSent": 12,
  "cacheHits": 8,
  "retries": 0,
  "cooldownMs": 0,
  "checkpointed": true
}
```

Existing commands remain behavior-compatible, but their HTTP requests also use
the shared coordinator and persistent 429 retry behavior.

Endpoints that Make explicitly documents as exempt from organization request
limits, currently `POST /scenarios/{scenarioId}/run`, do not reserve a rolling
organization-rate slot. They still use cancellation, sanitized errors, and
indefinite 429 handling because an upstream component may still throttle them.

Tests use an injectable clock, sleep function, random source, and request
executor so rate-limit behavior is deterministic and does not actually wait.

### 2. Canonical Blueprint Traversal

Create one canonical recursive traversal implementation and use it everywhere.
It must cover:

- top-level `flow`;
- router `routes[].flow`;
- If/Else `branches[].flow`;
- `onerror` modules;
- routes or branches nested inside error handlers;
- nullable placeholder module IDs without losing their paths.

Each result contains:

```ts
interface WalkedModule {
  module: Module;
  path: string;
  depth: number;
  parentModuleId: number | null;
  container: "flow" | "route" | "branch" | "onerror";
}
```

`getMaxModuleId`, analyzer classification, data-flow analysis, summary output,
module lookup, duplicate detection, diffing, and resume generation all consume
this traversal. There must not be a second recursive walker with different
coverage.

The Zod schemas model recursive `routes`, `branches`, and `onerror` structures
instead of retaining `branches` only through `catchall`.

### 3. `inspect` Command

Add:

```bash
make-fixer inspect -s <id-or-url> --module <id>
make-fixer inspect -s <id-or-url> --module <id> --local
make-fixer inspect -s <id-or-url> --summary
```

Remote data is the default. `--local` explicitly reads
`blueprints/<scenarioId>.json`.

Module inspection returns:

```json
{
  "ok": true,
  "scenarioId": 6648651,
  "source": "remote",
  "module": {
    "id": 18,
    "path": "flow[1].branches[0].flow[2]",
    "type": "monday:ChangeMultipleColumnValues",
    "name": "Update customer",
    "container": "branch",
    "parentModuleId": 17,
    "mapper": {},
    "parameters": {},
    "resolvedLabels": {
      "boardId": "לקוחות"
    }
  }
}
```

The full mapper and parameters are intentional: agents need exact configuration
data. `resolvedLabels` extracts Make restore metadata without replacing the raw
fields. Unicode is emitted as valid UTF-8 without ad hoc mojibake conversion.

`--summary` returns scenario name, all modules with paths and names, total
module count, maximum assigned ID, next available ID, trigger information, and
branch/container counts.

Duplicate module IDs return a nonzero exit with every matching path instead of
silently selecting one.

### 4. Semantic Blueprint Diff and Drift Protection

Extend validation with optional exact changes while preserving its current
output:

```bash
make-fixer validate -s <id-or-url> --changes --json
```

The result distinguishes:

- directly changed modules;
- ancestors that only contain nested changes;
- added or removed modules;
- exact JSON leaf paths with before/after values;
- scenario-level changes;
- duplicate IDs.

The existing `modulesModified` field remains backward-compatible. New
`directlyModifiedModules`, `ancestorModules`, and `changes` fields are additive.

Every fetched blueprint receives a local sidecar containing a deterministic
remote fingerprint and fetch metadata. Before `push`, Make Fixer fetches the
remote blueprint again. If it differs from the recorded fingerprint, the push
stops with `REMOTE_DRIFT` unless the agent explicitly passes
`--allow-remote-drift`. The override does not bypass the existing confirmation
gate.

### 5. Scenario `run` Command

Add:

```bash
make-fixer run -s <id-or-url>
make-fixer run -s <id-or-url> --data '{"userName":"Jane"}'
make-fixer run -s <id-or-url> --data-file input.json
make-fixer run -s <id-or-url> --wait
make-fixer run -s <id-or-url> --wait --timeout 60s
```

Before execution, the command requests the scenario interface and validates
required input names and basic JSON-compatible types. The raw interface is
included in validation errors so the agent can correct its request.

Run behavior:

- without `--wait`, call the API non-responsively and return `executionId`;
- with `--wait`, request a responsive run and poll the documented execution
  endpoint when the initial request times out or returns an unfinished run;
- always preserve and return `executionId`;
- use bounded polling with retry/backoff and a caller-controlled timeout;
- return configured scenario outputs when available;
- never claim a timeout means the execution failed;
- do not automatically replay or resend an ambiguous run.

`run` is a remote mutation and therefore requires `--yes`. Omitting `--yes`
returns a preview containing the scenario interface and normalized input,
without executing anything.

### 6. Organization-Wide Full-Text Search

Add:

```bash
make-fixer search --from-url <make-url> --query "5100313109"
make-fixer search --from-url <make-url> --query "boardId"
make-fixer search --from-url <make-url> --regex "monday:.*V2"
make-fixer search --from-url <make-url> --field boardId --value 5100313109
make-fixer search --organization <organizationId> --base-url https://eu1.make.com --query "text"
```

Organization-wide is the default and only implicit scope. A supplied scenario
or team URL resolves:

1. zone and team ID from the URL;
2. organization ID through `GET /api/v2/teams/{teamId}`;
3. every scenario through `GET /api/v2/scenarios?organizationId=<id>`;
4. each scenario blueprint through its documented blueprint endpoint.

The team-to-organization request was verified against the supplied real team on
2026-07-23: `GET /api/v2/teams/2186253` returned HTTP 200 and organization ID
`8430514`. The preceding live scenario-list and blueprint requests also returned
HTTP 200. These observations validate the API path for this organization; error
classification still handles accounts where equivalent access is unavailable.

Search covers:

- scenario names and descriptions;
- module IDs, types, and custom names;
- mapper and parameter keys and values;
- board, field, column, connection, hook, and data-structure IDs;
- filters, formulas, URLs, prompts, and arbitrary nested configuration;
- routes, If/Else branches, and error handlers through canonical traversal;
- notes when their endpoint is accessible.

Each match returns scenario ID/name, team ID, module ID/type when applicable,
the exact JSON path, matched key/value, and a bounded snippet. Sensitive values
whose paths or keys indicate tokens, secrets, passwords, authorization, API
keys, cookies, or credentials are redacted before output and before caching.

The index is stored under Make Fixer's global state directory, partitioned by
zone and organization. Scenario `lastEdit` values drive incremental refresh:
unchanged scenarios reuse their cached sanitized documents, changed or new
scenarios are refetched, and deleted scenarios are removed. `--fresh` bypasses
the cache.

Fetches use the shared organization-aware request coordinator. At the verified
Core limit of 60 requests per minute, the default effective ceiling is 57 per
minute with at most two requests in flight. Checkpointing happens after every
scenario so a cooldown, interruption, or command restart does not discard
completed indexing work. Partial failure is explicit: results include
successfully searched scenarios plus per-scenario fetch failures and an
`incomplete: true` marker. Notes being unavailable never prevents blueprint
search.

Literal, case-insensitive text search is the default. `--case-sensitive`,
`--regex`, and exact `--field` plus `--value` matching are additive modes.
Invalid regular expressions fail before any network request.

The command requires `scenarios:read`. Team lookup, scenario listing, blueprint,
or notes failures use the common capability taxonomy rather than being
misreported as zero matches.

### 7. `doctor` Command and Capability Model

Add:

```bash
make-fixer doctor
make-fixer doctor --from-url <make-url> --json
make-fixer doctor -s <scenario-id-or-url> --json
```

The command reports:

- CLI version and platform;
- configured/default zone;
- successful authenticated zone probes;
- selected scenario and resolved zone when supplied;
- endpoint capabilities proven by safe requests;
- documented organization `license.apiLimit`, effective CLI allowance, limit
  source, and active shared cooldown;
- failures classified as:
  `AUTH_INVALID`, `SCOPE_MISSING`, `PLAN_RESTRICTED`,
  `NOT_SUPPORTED`, `NOT_FOUND`, `RATE_LIMITED`, `TRANSIENT`, or
  `UNKNOWN_API_ERROR`.

Capability detection is evidence-based. HTTP status alone is not sufficient:
the parser retains a sanitized response error code/message and request
provenance. It never prints authorization headers or tokens.

No feature is described as universally available based on `doctor` succeeding
for one organization.

### 8. Organization Module Examples

Add:

```bash
make-fixer examples --from-url <make-url> --module monday:getBoardItems
make-fixer examples --from-url <make-url> --app monday
make-fixer examples --from-url <make-url> --search "boardId"
make-fixer examples --from-url <make-url> --scenario <id> --module-id <id> --full
```

`examples` reuses the organization-wide incremental index and canonical
traversal. It finds modules already used in accessible scenarios and returns
real blueprint fragments an agent can adapt. Matching supports:

- exact Make module name;
- app prefix;
- module version;
- literal text within parameters, mapper, filters, or metadata;
- exact scenario ID and module ID for selecting one result.

Search results are grouped by a deterministic configuration signature composed
of module name, version, parameter-key shape, mapper-key shape, and metadata
schema shape. The default result includes one representative per signature plus
the number and locations of equivalent examples. This avoids flooding an agent
with hundreds of copies while retaining provenance.

Each representative includes scenario ID/name, team ID, module ID, exact JSON
path, module name/version, connection references, parameters, mapper structure,
filter structure, restore labels, and interface metadata. Values whose paths or
keys indicate tokens, passwords, authorization headers, API keys, cookies, or
credentials are always redacted. Ordinary resource IDs, connection IDs, field
names, labels, URLs without credentials, and structural configuration remain
available because the feature is intended to produce usable examples.

`--full` requires an exact scenario and module selection. It returns that
module's complete sanitized blueprint fragment and its immediate structural
context. It never returns credentials or Make API tokens.

Examples are evidence, not a universal module catalog. If no accessible
scenario contains the requested module, the command returns `found: false` and
does not invent a configuration schema.

### 9. Generic Scenario Creation and Probe Lifecycle

Add:

```bash
make-fixer connections --from-url <make-url>
make-fixer create --from-url <make-url> --blueprint <file> --name <name>
make-fixer run -s <id-or-url> --data-file input.json --wait
make-fixer probe --from-url <make-url> --blueprint <file> --data-file input.json
make-fixer cleanup -s <id-or-url> --delete
```

`connections` lists connections visible to the URL's team using
`GET /api/v2/connections?teamId=<id>`. It returns IDs, names, account/package
types, scope status, and non-secret metadata. It never returns credentials.
Agents combine these connection references with `examples` output when
constructing a provider-specific blueprint.

`create` accepts a complete local blueprint, validates it locally, forces
on-demand scheduling, previews the exact target team/name/module count, and
requires `--yes` before `POST /api/v2/scenarios`. The created scenario name is
prefixed with `[make-fixer probe]` unless `--no-probe-label` is explicitly
passed. The result persists a local ownership record containing scenario ID,
team ID, organization ID, zone, creation time, blueprint fingerprint, creator
process, and lifecycle state.

The generic `probe` command orchestrates:

1. validate the supplied blueprint and inputs locally;
2. preview the scenario that will be created unless `--yes` is present;
3. create an inactive, on-demand scenario in the selected team;
4. fetch the created blueprint and interface to verify the remote state;
5. activate only that newly created scenario;
6. run it once and retain the returned `executionId`;
7. poll the documented execution endpoint until `SUCCESS`, `WARNING`, or
   `ERROR`;
8. return configured scenario outputs or the structured execution error;
9. fetch the blueprint again to expose interface metadata populated by the
   real run;
10. query module logs for per-module status and bundle counts;
11. deactivate the scenario after the execution reaches a terminal state;
12. leave the scenario in Make and return a cleanup decision for the agent to
    present to the user.

The public API guarantees configured scenario outputs through
`GET /scenarios/{scenarioId}/executions/{executionId}`. Module logs expose
operation status and bundle counts, not arbitrary intermediate bundle contents.
Make Fixer must state this distinction. Probe blueprints should map the target
system response into explicit scenario outputs when the agent needs the actual
payload. A post-run blueprint interface can describe fields learned by Make,
but it is not misrepresented as the original bundle.

If the process is cancelled while its owned execution is still running,
`probe` requests a stop for that execution and then deactivates its owned
scenario. If stopping or deactivation cannot be confirmed, the result uses exit
code 5 and records `cleanupRequired: true` with the exact unresolved state.
The command never activates, stops, or deactivates a pre-existing scenario.

Successful and failed probes both retain the created scenario for inspection.
No automatic deletion occurs. The final JSON contains:

```json
{
  "scenarioId": 7654321,
  "executionId": "abc123",
  "scenarioActive": false,
  "cleanupRequired": true,
  "cleanupOptions": [
    "keep",
    "delete",
    "revise_and_rerun"
  ],
  "userDecisionRequired": true
}
```

An AI agent must present those options to the user after reporting the test
result. `cleanup --delete --yes` deletes only a scenario whose local ownership
record and remote fingerprint both match. Drift, a missing ownership record, or
an active/running scenario blocks deletion. `cleanup` without `--delete --yes`
is read-only and reports the current lifecycle state.

The ownership fingerprint is refreshed only after a CLI-controlled lifecycle
operation is verified remotely, including the post-run blueprint fetch. This
allows Make-populated interface metadata to be recorded without weakening the
later drift check.

On startup, new mutation commands check for unresolved owned probe records.
They report them in `meta.pendingCleanup` so an interrupted agent can ask the
user later. They do not delete or modify those scenarios automatically.

### 10. Agent-Oriented Output Contract

New commands return stable JSON by default. Human formatting is available with
`--human`.

Successful results include:

```json
{
  "ok": true,
  "command": "inspect",
  "data": {},
  "meta": {
    "cliVersion": "0.2.0",
    "source": "remote",
    "verifiedAt": "2026-07-23T00:00:00.000Z"
  }
}
```

Failures include:

```json
{
  "ok": false,
  "command": "run",
  "error": {
    "code": "SCOPE_MISSING",
    "message": "The configured Make token lacks scenarios:run.",
    "httpStatus": 403,
    "providerCode": "SC403",
    "retryable": false
  }
}
```

Exit codes:

- `0`: successful operation;
- `1`: invalid input or unresolved/unsafe requested change;
- `2`: authentication, scope, plan, or capability limitation;
- `3`: transient provider/network failure;
- `4`: remote drift;
- `5`: remote mutation completed but post-write verification failed.

Existing commands keep their current exit behavior for backward compatibility.

## API Verification Strategy

Tests use three levels:

1. **Pure unit tests:** recursive traversal, schema parsing, exact module lookup,
   semantic diffs, fingerprints, example grouping/redaction, ownership checks,
   error classification, probe cleanup transitions, and polling state
   transitions.
2. **Mock HTTP contract tests:** assert exact method, path, body, headers, and
   response parsing for each new Make API call. Tests include 401, 403 scope,
   403 plan, 404, 422, 429, 5xx, timeout-with-execution-ID, and malformed JSON.
3. **Real read-only verification:** use the configured token against an
   explicitly selected existing scenario and organization. Verify blueprint,
   interface, execution-status, and organization behavior without running or
   modifying scenarios.

Remote mutation verification is separate:

- a real scenario run requires explicit user approval and a known safe on-demand
  scenario;
- real create/probe verification requires explicit user approval, a selected
  team, a harmless blueprint, and confirmation that the scenario is inactive
  after testing;
- no live blueprint push is required to validate local patching and drift
  detection;
- post-write verification is mandatory whenever a remote mutation is approved.

Real-account observations are recorded as evidence for that account and time,
not encoded as universal plan behavior.

## Compatibility and Migration

- Do not rename or remove existing commands.
- Do not change default output of existing commands.
- Do not wrap existing `--json` responses in the new envelope.
- New commands may use the new envelope from their first release.
- Existing blueprint files remain valid.
- Sidecar fingerprints live under `blueprints/.make-fixer/` and do not alter
  blueprint JSON.
- New Zod fields are permissive for unknown Make data.
- Windows, macOS, and Linux use UTF-8 JSON and Bun APIs.

## Out of Scope

- Make Grid's native search endpoint or UI;
- implementing the MCP protocol or connecting to Make MCP;
- complete parity with every Make REST resource;
- connection, data-store, organization, or team mutation commands;
- a universal schema catalog for every Make app module;
- provider-specific CLI integrations or direct Monday API calls;
- automatic deletion of probe scenarios;
- activation, stopping, or deactivation of pre-existing scenarios by `probe`;
- automatic replay after ambiguous timeouts;
- automatic remote batch pushing;
- bypassing subscription, role, or token-scope restrictions.

## Success Criteria

1. The supplied module-18 scenario shape is represented by a fixture.
2. Traversal finds module 18 inside `branches`, and next ID is greater than every
   module and error-handler ID.
3. Analysis and diffs include nested branch/error-handler modules exactly once.
4. `inspect --module 18` returns its exact path, mapper, label, and parent.
5. Validation identifies a precise nested leaf change without falsely
   presenting the If/Else parent as directly edited.
6. `examples` finds real modules inside nested organization scenarios, groups
   structural duplicates, preserves usable non-secret configuration, and
   redacts credentials.
7. `run` validates the live interface, returns an execution ID, and can poll an
   unfinished execution without resending it.
8. `doctor` distinguishes scope/plan/auth/transient failures using sanitized real
   API responses.
9. `search` resolves the organization from a normal scenario URL, incrementally
   indexes every accessible blueprint, finds nested matches by exact path, and
   redacts sensitive values.
10. A partially inaccessible organization returns available matches plus
    explicit per-scenario failures instead of an incorrect complete result.
11. The shared rate coordinator discovers `license.apiLimit`, keeps default
    traffic at 95% or less, coordinates two simulated processes, and proactively
    waits before the rolling organization window is exceeded.
12. A 429 without `Retry-After` creates a shared cooldown of at least 60 seconds;
    integer and HTTP-date headers are both honored, and the request continues
    retrying until it succeeds or receives a cancellation signal.
13. Interrupted organization scans resume from persisted checkpoints without
    refetching completed unchanged scenarios.
14. A probe created from a harmless fixture blueprint is verified remotely,
    run once, returns configured outputs and post-run interface evidence, and
    is confirmed inactive afterward.
15. The probe is retained with `userDecisionRequired: true`; deletion is
    rejected unless ownership and remote fingerprint checks pass.
16. Existing tests and command-help tests continue passing.
17. Full `bun test` and `bun run typecheck` pass.
