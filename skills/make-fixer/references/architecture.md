# Architecture — Subscenarios, Data Stores, Scale

Load when designing a new scenario or restructuring one: subscenarios and on-demand scenarios, calling one
scenario from another, persisting state between runs, bulk or long-running processing, production settings.

## Subscenarios (on-demand scenarios)

A scenario run on request (by another scenario, an AI agent, or the API) has an on-demand schedule, a declared
`interface` (inputs/outputs), and this frame:

```
id 1  scenario-service:StartSubscenario   receives the declared inputs → {{1.<inputName>}}
id 2…  the work
id N  scenario-service:ReturnData          mapper keyed by the declared output names
```

- **`StartSubscenario` is mandatory.** With any other root module, nothing receives the inputs and every
  reference to them silently resolves to nothing.
- **`ReturnData` keys must exactly match the declared output names.** A missing or misspelled key returns
  `null` for that output, and the run still reports success. Check the mapper against the interface before
  calling the build done.
- **Calling it:** use `scenario-service:CallSubscenario` (preferred over the older `RunScenario`).
  - `parameters.scenario` is the child's ID.
  - `shouldWaitForExecutionEnd: true` waits for the child and returns its outputs; `false` is
    fire-and-forget.
  - The child must be in the same team, active, and on-demand. **Calls through this module use no credits.**
- **`ReturnData` never reaches a webhook caller.** A webhook-triggered flow that must answer uses
  `gateway:WebhookRespond`.
- **Symptoms of getting it wrong:**
  - every output is `null` on a "successful" run: wrong root module or mismatched `ReturnData` keys;
  - a generic `BlueprintValidationError`: often a non-starter module at the root of an on-demand scenario.

| Need | Subscenario | Webhook chain |
|---|---|---|
| Parent needs the result | ✅ sync, typed I/O | limited |
| Async fan-out | ❌ | ✅ |
| Independent retry/debugging per stage | partial | ✅ |

## Data stores

**Default to none.** Use one only when a run must know what an earlier run did (seen this ID? running total?)
or when several scenarios share a lookup table.

- **New scenario, new store.** Reuse an existing store only when the user names it. Sharing mixes records
  and breaks both scenarios' dedup keys.
- **Plan the primary key first.** It must be stable (order ID, email). Include only fields you will query on.
- **Dedup:** look up the key → filter `notexist` → process → **add the record after processing succeeds**.
  Adding it first marks failed items as seen forever.
- **Counters and running totals** are not safe under parallel runs. Make the scenario `sequential` when the
  count must be exact.
- **Shared lookup:** one scenario owns the writes and the others only read. Write down which scenario owns
  them.
- Use upsert for idempotent writes. Clean up old records, because storage quota is finite.
- A **data structure** built from a real sample payload, assigned to a webhook, gives stable field names. With
  `strict`, it also rejects malformed requests.

## Bulk and long-running work (40-minute execution limit)

- **Queue pattern:**
  1. A scheduler scenario enqueues IDs into a data store with `status: pending`, skipping existing ones.
  2. A processor scenario runs every N minutes, takes a capped batch (e.g. 70), exits early when the queue is
     empty, and updates each status.
- **Webhook chain:** stage A hands off to stage B over HTTP. Each stage is debuggable alone, and a failure in
  B doesn't re-run A.
- **Status column:** mark processed rows at the source, so a restart only picks up unprocessed ones.

## Production settings

| Setting | Recommendation |
|---|---|
| Store incomplete executions (`dlq`) | ON when Break handlers are used |
| Sequential | ON when event order matters or counters must be exact (watch for queue blocking) |
| Consecutive error limit | 3–5 normally, 1 for financial/critical (webhooks: always 1) |
| Auto commit | ON for long multi-cycle runs |
| Confidential | only for GDPR/HIPAA — disables debugging |
| Max cycles | set a sane cap |
| Allow data loss | only when throughput beats guaranteed processing |
