# Make.com Best Practices Reference

Deep reference for error handling, debugging, testing, naming, architecture, and community-proven patterns. Load this file when designing scenarios from scratch, reviewing architecture decisions, or troubleshooting.

---

## Error Handler Directives

| Handler | Execution stops | Bundle data | Other bundles | Status | Creates incomplete exec |
|---------|-----------------|-------------|---------------|--------|------------------------|
| **Break** | No | N/A | Continue | Warning | Yes (requires "Store Incomplete Executions" setting ON) |
| **Resume** | No | Fallback value | Continue | Success | No |
| **Ignore** | No | Dropped | Continue | Success | No |
| **Commit** | Yes | Saved | Stop | Success | No |
| **Rollback** | Yes | Reverted (ACID only) | Stop | Error | No |

### When to use each

- **Break** — Transient API errors, network issues. Stores state for automatic or manual retry. Default for most production scenarios.
- **Resume** — Non-critical lookup failed; a fallback empty value is acceptable and the flow should continue.
- **Ignore** — Truly optional side effects (e.g., logging, non-critical notifications) where skipping one item is fine.
- **Commit** — Partial completion is acceptable; preserve work done up to this point even if the full run failed.
- **Rollback** — Only for ACID-tagged modules where partial writes are worse than no writes at all. Non-ACID changes will NOT be reverted.

### Break handler auto-retry settings

```json
"onerror": [{
  "id": NEXT_ID,
  "module": "builtin:Break",
  "version": 1,
  "mapper": { "retry": true, "count": 3, "interval": 15 }
}]
```

`interval` is in minutes (1–44640). `count` is retry attempts (1–10). With `"retry": true`, Make retries automatically from the incomplete executions queue.

### Automatic system-level retry backoff

Make auto-retries `RateLimitError`, `ConnectionError`, and `ModuleTimeoutError` without any handler configuration (requires "Store Incomplete Executions" ON):

| Retry | Delay | Cumulative |
|-------|-------|------------|
| 1 | 1 min | 1 min |
| 2 | 10 min | 11 min |
| 3 | 10 min | 21 min |
| 4 | 30 min | 51 min |
| 5–6 | 30 min each | ~2 hours |
| 7–8 | 3 hours each | ~8 hours |

### 429 rate limit in-execution retry pattern

The full pattern uses a router inside the `onerror` array so that 429s retry while other errors still Break:

```
[Original Module #5]
  onerror:
    [BasicRouter #22]
      Route A — filter: error contains "429"
        [Sleep #19: 45s]
        [Retry Module #20]  ← identical mapper to original
          onerror: [Break #29]
        [Resume #23]        ← maps ALL output fields from #20
      Route B — (else/fallback)
        [Break #24]
```

**Critical: the `builtin:Resume` mapper must replicate every output field** of the errored module, mapping each from the retry module. The downstream flow sees a bundle identical to what the original module would have produced.

```json
{
  "id": 23,
  "module": "builtin:Resume",
  "version": 1,
  "mapper": {
    "name":                  "{{20.name}}",
    "pcftitle":              "{{20.pcftitle}}",
    "pcfDocType":            "{{20.pcfDocType}}",
    "pcfProject":            "{{20.pcfProject}}",
    "__IMTINDEX__":          "{{20.`__IMTINDEX__`}}",
    "__IMTLENGTH__":         "{{20.`__IMTLENGTH__`}}"
  }
}
```

Map **every field** listed in the errored module's `interface` definition. If a field is omitted from the Resume mapper, downstream modules that reference `{{5.thatField}}` will receive empty values.

The retry module (#20) must be a copy of the original module (#5) with the same `mapper` and `parameters`. Its own `onerror` should use `builtin:Break` so that a second 429 on the retry is stored as an incomplete execution rather than looping infinitely.

To detect 429s on the error route filter, use:
```json
{
  "a": "{{5.error.type}}{{5.error.message}}{{5.error.detail}}",
  "b": "429",
  "o": "text:contain"
}
```
(Replace `5` with the errored module's ID.)

### Error notification pattern

Always add a notification module BEFORE the directive on critical error routes:

```
[Critical Module]
  --error route-->
    [Slack: post alert with error + bundle data + scenario name]
    [Data Store: log error record]
    [Break / Resume / Ignore]
```

The notification module does not need its own error handler unless it itself could fail.

---

## Debugging Workflow

1. **Check colored bubbles** after "Run Once": Green = success, Red = error, Gray = module did not run (upstream filter or failure)
2. **Click the bubble** to read the exact error message and inspect input/output data at that step
3. **Classify the error:**
   - *Internal* — wrong data format, misconfigured mapper (e.g., passing plain text instead of JSON)
   - *External* — third-party API returned 4xx/5xx; check the HTTP status code
   - *Silent* — no error thrown, but results are wrong; manually verify each module's output against expectations
4. **For internal errors**: trace backward to find which upstream module produced malformed data
5. **For external errors**: check HTTP status code, add appropriate error handler
6. **For silent errors**: run trigger alone, inspect its bundle, then add modules one at a time and verify output at each step
7. **Use webhook.site** as a dummy webhook endpoint to capture and inspect raw HTTP request payloads during debugging

### Debug labeling with Name a Run

`scenario-service:NameExecution` is the only zero-cost module. Use it to label each execution with meaningful data (record ID, status, timestamp) so the execution history is scannable without opening each run.

---

## Testing Strategies

### Safe testing checklist

- Confirm scenario is OFF (not scheduled) before running tests
- Use dedicated test accounts or sandboxes
- Create clearly labeled test records (e.g., "TEST – John Doe") for easy cleanup
- Disable destructive actions (delete row, send email to customers) until scenario is confirmed stable
- Right-click trigger → "Choose where to start" → "Choose manually" to avoid advancing the "last seen" cursor in Watch triggers

### Mock data layer pattern

1. After the trigger, add `util:SetVariables` to copy trigger fields into named variables
2. Create a dormant `json:ParseJSON` module with sample/mock data
3. **When testing**: disconnect trigger, connect mock data module, update variable mappings
4. **When live**: reconnect trigger

Result: all downstream modules reference variables, never the trigger directly — making the scenario trigger-agnostic and easy to unit-test in isolation.

### Deliberate failure testing

Before going live, intentionally cause each expected error type (invalid API key, malformed data, rate limit simulation) to verify error handlers actually trigger. Never trust a handler until you've seen it fire.

---

## Naming Conventions

### Scenarios

Pattern: `[APP] | [ENV] | [DOMAIN] | [TRIGGER > OUTCOME]`

Examples:
- `CRM | PROD | Leads | Form Submit > Slack Alert`
- `Shopify | PROD | Orders | New Order > Fulfillment`
- `HR | STAGING | Onboarding | Webhook > BambooHR`

### Modules

Pattern: `[Step#] [Verb] [System] [Object]`

Examples:
- `01 Watch Shopify Orders`
- `02 Filter — Skip Test Orders`
- `03 Get Airtable Lead Record`
- `04 Post Slack Notification`

### Subscenarios

Use action-based names describing what the subscenario does:
- `Format Customer Data`
- `Send Alert Notification`
- `Validate Email Domain`

### Emoji tags for visual scanning

- 🔔 Notifications/alerts
- 💼 Client onboarding
- 📊 Reporting/analytics
- ✅ Task management
- 🤖 AI integrations
- ⚡ Reusable subscenario stems
- 🪝 Webhook-triggered scenarios

---

## Architecture Patterns

### Modular webhook-chain pattern

For complex multi-step workflows, split into focused scenarios connected by webhooks:

```
Scenario A (Trigger + Filter)
  → HTTP POST webhook → Scenario B (Transform + Enrich)
                          → HTTP POST webhook → Scenario C (Deliver)
```

Each scenario is independently debuggable. If Scenario B fails, Scenario A does not re-run.

### Queue-based architecture for bulk operations

For processing large datasets that exceed the 40-minute execution timeout:

**Scenario 1 — Scheduler** (runs on schedule):
- Fetches all records needing processing
- Checks each against a Data Store queue to avoid duplicates
- Adds new items with status `pending`

**Data Store — Queue**:
- Fields: `id` (primary key), `status` (pending/processing/done/failed), `created_at`

**Scenario 2 — Processor** (runs every 15 min):
- Fetches N items from queue where `status = pending` (e.g., limit 70 to stay under rate limits)
- Early-exit check: if no pending items, stop immediately (saves operations)
- Processes each item, updates status after success/failure

Benefits: handles unlimited items, respects API rate limits, recovers gracefully from timeouts, prevents duplicate processing.

### Subscenarios vs. webhook chains

| Concern | Subscenario | Webhook Chain |
|---------|-------------|---------------|
| Synchronous (parent needs response) | Yes | Limited |
| Async parallel fan-out | No | Yes |
| Tight coupling acceptable | Yes | No |
| Cross-scenario state passing | Yes (typed I/O) | Via payload |

Use **subscenarios** when the parent needs the result back. Use **webhook chains** when the child should run independently and the parent doesn't need to wait.

### Execution timeout workarounds (40-min limit)

1. **Webhook handoff**: At near-timeout, send a webhook to a second scenario to continue from where the first left off
2. **Queue-based batch processing**: Process N items every 15 minutes instead of one enormous run
3. **Status tracking column**: Add a `processed` flag to your data source; restart scenario filtering for unprocessed records after timeout

---

## Scenario Settings for Production

| Setting | Recommendation |
|---------|---------------|
| Store Incomplete Executions | Always **ON** — required for Break handler retries |
| Sequential Processing | **ON** for webhook scenarios where event order matters; prevents race conditions |
| Consecutive Error Limit | 3–5 for most production; 1 for critical/financial workflows |
| Auto Commit | **ON** for long multi-cycle runs to preserve progress |
| Data is Confidential | Only for GDPR/HIPAA — disables execution log detail, making debugging impossible |
| Max Number of Cycles | Set a reasonable cap to prevent runaway executions |
| Enable Data Loss | Only if uninterrupted throughput matters more than guaranteed processing |

**Note:** Instant-trigger (webhook) scenarios disable after the **first** consecutive error. Scheduled scenarios use the configurable threshold.

---

## AI Integration Patterns

### Reliable routing with structured output

Vague AI prompts produce variable output that breaks downstream filters. Use constrained prompts:

```
Prompt: "You are a lead qualifier. Respond ONLY with exactly one of: Qualified / Not Qualified"
```

The exact string output becomes a reliable filter condition.

### Single AI call for multiple classifications

Save operations by getting multiple data points in one call:

```
Prompt: "Classify this support ticket. Respond in exactly this format:
Category: [support/billing/feature]
Urgency: [high/medium/low]"
```

Parse `Category:` and `Urgency:` with `substring` or regex in downstream modules.

### Human review gate pattern

For high-stakes AI-driven actions (send emails, process payments):
1. Route AI draft to Slack/email for review
2. Use Make's Webhook Response to capture approve/reject from the reviewer
3. Only execute the action after approval is confirmed

### Always log AI outputs

Every AI module result should be logged to a Data Store or Google Sheet:
- Enables prompt debugging
- Creates audit trail for compliance
- Reveals patterns in AI failures over time

---

## Cost Optimization Checklist

Before activating any scenario, verify:

- [ ] Filter placed immediately after trigger (not after any processing modules)
- [ ] Polling interval matches actual data freshness requirement (not set to 1-minute by default)
- [ ] No lookups or API calls inside an iterator that could be moved before it
- [ ] Bulk write endpoints used where available (not per-record individual writes)
- [ ] `util:SetVariables` used for multi-variable sets (not separate `util:SetVariable2` per variable)
- [ ] Array Aggregator used before bulk operations
- [ ] `Max results` / `Limit` set on all search and list modules
- [ ] Error handlers use Break (not no-handler) so handled errors don't count toward consecutive error threshold
- [ ] AI providers called via HTTP module (1 credit) not Make's premium AI modules where possible

---

## Data Store Design Principles

- **Plan the primary key first** — must be unique and stable (order ID, email, not auto-increment when external lookups are needed)
- **Design for query patterns** — include fields that scenarios will actually filter/search on
- **Separate stores per domain** — `contacts`, `orders`, `config`, `job_queue` — never mix unrelated datasets
- **Upsert for idempotent writes** — use "update or insert" to safely handle reprocessing
- **Clean up old records** — stale records consume storage quota; delete processed items periodically
- **Document cross-scenario writers** — note which scenarios write which fields to prevent conflicting updates

### Deduplication gate pattern

```
[Receive Event]
  → [Data Store: Search for event ID]
  → [Router]
      Branch A (record found)  → ignore (already processed)
      Branch B (record not found) → [Data Store: Add event ID] → [Process event]
```

---

## Version Control (Manual)

Make.com has no native git-style versioning. Recommended automated backup:

```
[Schedule: Daily 5:00 AM]
  → [Make API: List all scenarios]
  → [Iterator]
  → [Make API: Get scenario blueprint JSON]
  → [GitHub / Google Drive: Upload file named "{scenarioName}.json"]
```

Required API token scopes: `organizations:read`, `scenarios:read`.

Development workflow:
- Maintain separate workspaces for `dev`, `staging`, `production`
- Never edit production scenarios directly — clone, test, then replace
- Use Custom Scenario Properties to tag scenarios with `environment`, `owner`, `version`

---

## Module Types Quick Reference

[Live docs](https://help.make.com/types-of-modules.md)

### By Function

| Type | Description | Naming Pattern |
|------|-------------|----------------|
| **Trigger (Polling)** | Checks for new data on schedule. Consumes 1 op per check even with no data | "Watch..." |
| **Trigger (Instant)** | Webhook-based — fires only on real events, zero cost when idle | "Instant trigger" |
| **Search** | Retrieves filtered data. Returns multiple bundles (max 3,200 objects or 5MB) | "Search..." / "List..." |
| **Action** | Processes data — Get, Create, Update, Delete, plus service-specific actions | Verb-based |
| **Universal** | Custom API calls when no pre-built module exists | "Make an API Call" |

### By Connection

| Category | Description |
|----------|-------------|
| **Apps** | Require connection to third-party services (Google, Slack, HubSpot, etc.) |
| **Tools** | No connection needed — Iterator, Aggregator, Router, Data Store, Variables |

---

## Data Types & Type Coercion

[Live docs: types](https://help.make.com/item-data-types.md) | [Live docs: coercion](https://help.make.com/type-coercion.md)

For the complete reference including coercion tables, see [FUNCTIONS_REFERENCE.md](FUNCTIONS_REFERENCE.md#data-types).

### Key coercion gotchas

- **Number → Boolean** = always `Yes` (even `0`)
- **Empty text → Boolean** = `No`; any non-empty text = `Yes`
- **Non-numeric text → Number** = validation error (no silent fallback)
- **Collection → anything** = validation error (collections don't auto-convert)
- **Any value → Array** = wrapped as single-element array

---

## Inline Functions Reference

For the complete function catalog (70+ functions with signatures, parameters, return types), date/time tokens, and filter operators, see [FUNCTIONS_REFERENCE.md](FUNCTIONS_REFERENCE.md).

### Quick syntax reminders

- Arguments separated by **semicolons**: `if(1=1; "yes"; "no")`
- `now` and `timestamp` are **variables** (no parentheses)
- Array indexing: **1-based** in `get()`, **0-based** in `slice()`
- Days between dates: `{{round((date2 - date1) / 1000 / 60 / 60 / 24)}}`
