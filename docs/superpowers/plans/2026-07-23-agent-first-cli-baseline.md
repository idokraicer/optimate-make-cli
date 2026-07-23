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
