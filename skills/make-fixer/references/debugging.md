# Debugging Runs & Executions

Load when the user asks why a scenario failed, what's broken across an account, whether a run worked, or
why a webhook "isn't receiving data".

## CLI patterns

```bash
# Account / team-wide sweep ("what's broken?")
make-fixer failures --from-url "https://<zone>.make.com/organization/<ORG_ID>/dashboard" --since 24h
make-fixer failures --from-url "https://<zone>.make.com/<TEAM_ID>/scenarios/<SCENARIO_ID>/edit" --since 7d

# One scenario's history
make-fixer executions -s "<scenario-url>" --limit 10
make-fixer executions -s <SCENARIO_ID> --failed
make-fixer executions -s <SCENARIO_ID> --since 2h --compact           # stable, token-efficient JSON
make-fixer executions -s <SCENARIO_ID> --from 2026-07-15T09:00:00+03:00 --to 2026-07-15T10:00:00+03:00
make-fixer executions -s <SCENARIO_ID> --since 2h --json --output executions.json

# One run
make-fixer executions -s <SCENARIO_ID> --id <EXECUTION_ID>            # status + configured outputs/error
make-fixer executions -s <SCENARIO_ID> --id <EXECUTION_ID> --include-input --output execution.json
```

- `--id` uses Make's public execution endpoint, which returns status plus configured outputs or an error. It
  does **not** return every module's bundles.
- `--include-input` adds the retained webhook request when a timestamp match is safe. Otherwise `input` is
  `null` and `inputAvailability.reason` explains why.

## Status codes don't match the UI

| API status | Docs say | UI shows | Reality |
|---|---|---|---|
| 1 | success | Success | most runs |
| 2 | warning | **Error** | almost every "error" in the UI |
| 3 | error | Error | rare, fatal unhandled crashes |

Use `--failed` (or `--status failed`), never `--status error`. Treat any non-1 status as a problem.

## Per-module input/output bundles

- Make's public REST API does not return per-module bundles for completed runs.
- Make's official MCP server (`https://mcp.make.com/claude`, OAuth, one organization per grant) does:
  - `scenario_execution_inspect` lists each module with invocation and error counts, plus the error that ended
    the run;
  - `scenario_execution_module_get` takes a `moduleId` and `cycle` (use the cycle `inspect` reports, usually
    1) and returns the real input/output bundles.
- Use whichever is available: the CLI if it has gained a command for this, otherwise the MCP. Without
  either, ask the user to open the run in the Make UI.

Interpretation rules:
- Make records **one** error per run (the one that ended it). Other failures only show as error counts.
- A **warning** run has no top-level error, and module error counts are the only signal. "No error found" is
  not "nothing went wrong".
- Modules with no downstream consumer (`ReturnData`, `WebhookRespond`, throws) show an empty output even when
  correct.
- `…[truncated]` marks a cut payload. It is text, not JSON.

## Before blaming the current config

Compare the scenario's last edit time with the run's start time. If the scenario was edited after the run,
the blueprint you fetched is **not** what ran. Say so before attributing the bug.

## Classify the failure

1. **Internal:** wrong data shape or a misconfigured mapper. Trace upstream to the module that produced the
   bad value.
2. **External:** a third-party 4xx/5xx. Check the status code, then fix the request or add the right handler
   (`references/error-handling.md`).
3. **Silent:** the run succeeded but the result is wrong. Check, in order:
   - filters with malformed operator codes (`references/blueprint-format.md`);
   - stranded or cross-route references;
   - empty `ifempty` chains;
   - an aggregator that dropped fields.

## Common "stopped working" causes

- **A connection was deleted or its authorization expired.** The fix is to reconnect it in Make.
- **A sequential scenario is stuck behind incomplete executions,** so no new data flows until they're
  resolved in the UI.
- **The scenario was deactivated after errors.** Webhook scenarios deactivate after the first error.
- **Webhook requests are queued.** If a webhook "receives nothing", the requests are usually queued because
  the scenario is inactive, paused or rate-limited, not lost. The MCP's `scenario_trigger_inspect` shows
  queued deliveries and recent payloads. To capture a payload's structure without running the scenario, use
  `scenario_trigger_learn` and have the user send one request.

## Make debugging easier next time

- Add `scenario-service:NameExecution` ("Name a run", free) with a record ID or status, so execution history
  can be scanned without opening each run.
- Log AI-module outputs to a data store or sheet so prompt failures can be reviewed later.
