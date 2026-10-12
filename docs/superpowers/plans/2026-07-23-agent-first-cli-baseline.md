# Agent-first Make CLI baseline — 2026-07-23

## Scope and ownership

This checkpoint preserves the existing execution-query work before subsequent
agent-first CLI TDD tasks. Its permitted feature commit contains only:

- `README.md`
- `skills/make-fixer/SKILL.md`
- `src/cli.ts` and `src/cli.test.ts`
- `src/make-api/client.ts` and `src/make-api/client.test.ts`
- `src/utils/execution-query.ts` and `src/utils/execution-query.test.ts`

`.agents/` and `AGENTS.md` were present as unrelated untracked work and are
explicitly excluded from both commits.

## Working-tree baseline

Current commit SHA:

```text
4204545473164118608bc716950d9cb1b5c89cd7
```

`git status --short`:

```text
 M README.md
 M skills/make-fixer/SKILL.md
 M src/cli.test.ts
 M src/cli.ts
 M src/make-api/client.test.ts
 M src/make-api/client.ts
?? .agents/
?? AGENTS.md
?? src/utils/execution-query.test.ts
?? src/utils/execution-query.ts
```

`git diff --stat`:

```text
 README.md                   |  49 +++++++++++
 skills/make-fixer/SKILL.md  |  14 ++-
 src/cli.test.ts             |  15 ++++
 src/cli.ts                  | 202 +++++++++++++++++++++++++++++++++++++-------
 src/make-api/client.test.ts |  21 +++++
 src/make-api/client.ts      |  54 ++++++++++++
 6 files changed, 324 insertions(+), 31 deletions(-)
```

`git diff --check`:

```text
(no output; passed)
```

## Test and typecheck baseline

`bun test`:

```text
181 pass
0 fail
354 expect() calls
Ran 181 tests across 25 files. [303.00ms]
```

`bun run typecheck`:

```text
$ tsc --noEmit
(exit 0; passed)
```

## Execution-query retention check

`git diff -- src/cli.ts src/make-api/client.ts README.md skills/make-fixer/SKILL.md`
confirmed the retained WIP exposes and documents `executions --since`,
`--compact`, `--output`, and `--include-input`. No API tokens or API response
bodies were captured in this baseline.

## Task 14 verification — 2026-10-12

Runtime: Bun 1.4.2. Target: team `2186253`, organization `8430514`, zone `eu1`.

### Automated

- `bun test`: 408 pass, 0 fail (46 files).
- `bun run typecheck`: exit 0. `git diff --check`: clean.
- `bun test src/commands/inspect.test.ts`: 3 pass, 0 fail.

### Live read-only

- `doctor`: authentication valid; organizations.list, teams.read,
  organizations.read, scenarios.read, blueprints.read, scenario_interface.read
  all HTTP 200. Rate limit: documented 60 rpm, effective 57 rpm
  (`organization_api`), 0 retries.
- `search --query boardId --fresh`: 18/18 scenarios fetched, 0 failed,
  `incomplete: false`, exact `blueprint.flow[...]` paths returned.
- `examples --search boardId`: served from cache (18 hits), `incomplete: false`.
- `connections`: 6 connections listed, no credential values.
- A key-pattern scan of all four outputs found no tokens or secrets.

### Live probe

The probe surfaced six defects, each fixed with a regression test:

1. `crypto.randomUUID` called unbound (Bun 1.4.2 `TypeError`) — also in `create`.
2. Create refusals discarded Make's status, code, and message.
3. Make `detail`/`suberrors` dropped behind a generic `Bad Request`.
4. `scheduling` sent inside the blueprint (HTTP 400 `SC400`, additional property).
5. Never-started probes were stop-requested, reporting false cleanup failure.
6. Finished executions from a failed run request were force-stopped instead of
   reported.

Final attempt: scenario `7904710` was created, verified, activated, run once,
and deactivated (remote `isActive: false`). Execution
`5629930959f447a8bcefa9513746ac10` ended `ERROR`:
`BlueprintValidationError — Scenario validation failed - 1 problem(s) found.`

Unavailable capability: the probe never declares the scenario interface. Probe
scenarios report `{"input":[],"output":[]}`, while working output scenarios
declare inputs/outputs through the separate scenario-interface resource. A
configured-output probe needs an interface-declaration step after creation —
tracked as follow-up work.

Retained probe scenarios awaiting the user's keep/delete decision: `7904646`
(created, never activated) and `7904710` (ran once). Both are inactive.
