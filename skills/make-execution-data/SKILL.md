---
name: make-execution-data
description: Gets the real per-module input/output bundles of a Make.com scenario run (what Make's run-history inspector shows) through the make-fixer CLI and Make's official MCP server, including the per-organization OAuth consent it needs. Use when debugging why a Make run failed or produced wrong data, when an e2e probe needs to assert on what each module received or returned, or when the user asks for "execution data", "bundles", "module output", "what did module X get", or hits MCP_CONSENT_REQUIRED / MCP_ORGANIZATION_MISMATCH.
user-invocable: true
---

# Make execution data (module input/output bundles)

Make's public REST API only returns run summaries — status, operations, scenario outputs, the error. It never returns what each module received and produced. Make's **official MCP server** (`https://mcp.make.com`) does, through two tools:

- `scenario_execution_inspect` — run status and error, plus every module that ran with its invocation and error counts.
- `scenario_execution_module_get` — the real input and output bundles of one module in one cycle.

`make-fixer` calls both for you. Prefer it over hand-rolled curl calls; it handles auth, token refresh, and parsing.

## Consent is per organization

Access is granted **per organization** through OAuth. On Make's consent page the person picks **one** organization and approves it. Rules that follow from that:

- Every organization you work in needs its own consent, once. A grant lasts about 6 months between uses and is renewed silently on every use.
- Grants are stored in the OS credential store (macOS Keychain, libsecret, Windows Credential Manager) under the service **`make-fixer`**, keyed by organization ID. They are never written to files; `~/.make-fixer/mcp-grants.json` only lists which organizations have one.
- **You cannot complete consent yourself.** It needs the person to approve in their browser. When a command opens the consent page, tell them which organization to choose — the error and log messages name it — and wait.
- If they approve the wrong organization, the CLI keeps that grant (it's valid for that org) and fails with `MCP_ORGANIZATION_MISMATCH`, naming the organization that was needed. Run the command again and ask them to choose the right one.

```bash
make-fixer mcp status                       # which organizations have a grant, and when each expires
make-fixer mcp login --org <ORG_ID>         # consent ahead of time (opens the browser)
make-fixer mcp login --from-url "<any Make URL>"   # organization from the URL (team URLs are looked up)
make-fixer mcp logout --org <ORG_ID>        # delete a grant
```

To find an organization ID, use `make-fixer orgs --search <name>`. Any scenario or team URL also works with `--from-url`.

## Getting a run's data

```bash
# Find the run
make-fixer executions -s <SCENARIO_URL_OR_ID> --failed --limit 5

# Every module's input/output, plus the failing module and error
make-fixer executions -s <SCENARIO_URL_OR_ID> --id <EXECUTION_ID> --bundles > run.json
jq '.executionData.error' run.json
jq '.executionData.modules[] | {moduleId, name, errors, records: [.records[] | {direction, error, bundles}]}' run.json

# One module only (faster on big runs)
make-fixer executions -s <SCENARIO_ID> --id <EXECUTION_ID> --bundles --module 4

# Non-interactive (CI, or no one at the browser): fail instead of opening the consent page
make-fixer executions -s <SCENARIO_ID> --id <EXECUTION_ID> --bundles --no-consent
```

The organization is read from the execution itself, so you never pass it. When the organization has no grant, the consent page opens automatically, unless `--no-consent` is set.

### Output: `executionData`

```jsonc
{
  "execution": { "id": "…", "status": "error", "startedAt": "…", "duration": 1070, "operations": 2, "credits": 2 },
  "error": { "message": "[429] User-rate limit exceeded…", "moduleId": 2, "moduleName": "google-email: sendAnEmail" },
  "modules": [
    {
      "moduleId": 2, "name": "…", "invocations": 1, "errors": 1, "cycles": [1],
      "records": [
        { "cycle": 1, "operation": 1, "direction": "input",  "error": false, "bundles": [{ "to": ["…"], "subject": "…" }], "truncated": false },
        { "cycle": 1, "operation": 1, "direction": "output", "error": true,  "bundles": [], "truncated": false }
      ]
    }
  ],
  "remarks": ["Make's caveats, verbatim — read them"]
}
```

- **Operations:** a module that ran N times (inside an iterator, for example) has N input/output record pairs, told apart by `operation`.
- **Truncation:** large bundles come back cut. They stay a string ending in `…[truncated]`, and the record has `truncated: true`. Don't parse those strings.
- **Redaction:** credentials inside bundles, such as auth headers and fields named like tokens or passwords, are replaced with `[REDACTED]`.
- **Modules with no consumer:** modules like `ReturnData`, `WebhookRespond`, or a throw report an empty output even when they worked. The scenario's own output is in the top-level execution `outputs`.

### Cycles

Make sometimes can't determine a run's cycle numbers. When that happens, it says so in `remarks`, and the CLI reads cycle 1. That's correct for single-cycle runs, which are the vast majority. For a run that processed several batches of trigger data, cycle 1 is only the first batch. Make warns that requesting the wrong cycle silently returns unrelated data, so the CLI only reads cycles that `inspect` reports. Say this when it matters for your conclusion.

### Before blaming a module's configuration

Compare the scenario's `lastEdit` to the run's `startedAt`. If the scenario was edited after the run, the current blueprint is not necessarily what ran. Say so before attributing a bug to it.

## E2E probes

`make-fixer probe … --yes` attaches each module's data to its result automatically:

- `executionData`: the same shape as above.
- `executionDataError`: `{code, message}` when the data couldn't be fetched. The probe itself still succeeds or fails on its own terms.

The probe checks consent **before** it creates the scenario, so a consent page never pauses a live probe. A failed consent stops the probe before anything is created.

- `--no-consent`: don't open the consent page. A missing grant then shows up as `executionDataError.code = "MCP_CONSENT_REQUIRED"`.
- `--no-bundles`: skip per-module data entirely.

Assert on `executionData.modules[].records[].bundles` rather than on `moduleLogs` counts. Counts can't tell you whether a module got the right data.

## Errors

| Code | Meaning | Fix |
|------|---------|-----|
| `MCP_CONSENT_REQUIRED` | No grant for the organization, and consent wasn't allowed | `make-fixer mcp login --org <ID>` with the person present, then retry |
| `MCP_ORGANIZATION_MISMATCH` | A different organization was approved on the consent page | Retry; ask the person to choose the named organization |
| `MCP_OAUTH_FAILED` | The consent was declined or timed out (5 min), or Make's OAuth server failed | Retry. If it persists, `make-fixer mcp logout --org <ID>` and log in again |
| `MCP_TOOL_ERROR` | A Make MCP tool refused, for example an unknown execution or a scenario outside the granted org | Check the IDs. Check that the scenario belongs to the granted organization |

A grant that was revoked, expired, or whose refresh token was already used is deleted, and consent is requested again automatically.

## What does not work, and why

These were all checked live:

- **Public REST API:** `/scenarios/{id}/logs/{execId}`, `/scenarios/{id}/executions/{execId}`, and `/scenarios/{id}/modules/{m}/logs` return summaries or bundle counts only. `/dlqs/{id}/bundle` covers incomplete executions only.
- **The zone MCP endpoint:** `https://<zone>.make.com/mcp/stateless` accepts the API token, but its `executions_get-detail` returns only `{status}`.
- **The UI's internal `/streamer/` endpoints:** they do return bundles, but only with a browser session cookie. That session dies after about 30 minutes idle, when you switch organizations, or when you log in elsewhere. Don't build on them.
