# Error Handling

Load when adding, reviewing or proposing error handlers, retries, fallbacks, or failure-related scenario
settings.

## When to add handlers

With no handler, Make stops the run on the first error, records it, and eventually deactivates the scenario.
For many automations that is the right behavior, because it keeps failures visible. Recommend handlers where a
failed run has a **real cost**:

- payments and financial writes;
- data sync, where a missed record means drift;
- customer-facing replies, or callers waiting on a webhook response;
- external APIs known to rate-limit (429) or flake;
- the user asks for retries or "never lose a record".

Don't flag a missing handler on a low-stakes notification or logging step. Match the directive to the
failure:

- connection, rate-limit or outage errors → `Break`;
- bad or optional data → `Resume` or `Ignore`;
- a misconfigured module → fix the config. No handler helps there.

## Directives

| Handler | Run continues? | Failed bundle | Status | Incomplete execution |
|---------|----------------|---------------|--------|----------------------|
| **Break** | other bundles continue | stored for retry | Warning | Yes (needs `dlq` / "Store incomplete executions" ON) |
| **Resume** | yes | replaced by substitute output | Success | No |
| **Ignore** | yes | dropped | Success | No |
| **Commit** | stops | work so far kept | Success | No |
| **Rollback** | stops | ACID modules reverted | Error | No |

- **Break:** `mapper: {"retry": true, "count": 3, "interval": 15}`. `interval` is in **minutes** (1–44640)
  and `count` is 1–10. With no mapper, Make defaults to count 3 and interval 15.
- **Resume:** the mapper must replicate **every output field** of the failed module, or downstream references
  to it come back empty.
- **Rollback** only reverts modules that support transactions. Earlier non-transactional writes stay.
- Routers and directives cannot carry a handler themselves.

Make also retries `RateLimitError`, `ConnectionError` and `ModuleTimeoutError` automatically when incomplete
executions are stored. The backoff is 1 min, 10, 10, 30, 30, 30, 3 h, 3 h.

## Raising errors deliberately

`builtin:ThrowError` (`mapper: {message}`) fails the run; `builtin:ThrowWarning` records a warning and
continues.

**Guard against an empty success.** When a lookup or AI step returns nothing, the run still reports
success. Before the output module, branch on `exist` / `notexist` and send the empty case to `ThrowError`
(or to a response that reports the error).

## 429 in-run retry pattern

`make-fixer resume` generates the Resume module for this.

```
[Original #5]
  onerror:
    [Router #22]
      Route A — filter: {{5.error.type}}{{5.error.message}}{{5.error.detail}} text:contain "429"
        [Sleep #19: 45s]
        [Retry #20]   ← exact copy of #5's mapper and parameters; its own onerror: [Break #29]
        [Resume #23]  ← maps EVERY output field of #5 from #20 (incl. __IMTINDEX__/__IMTLENGTH__)
      Route B
        [Break #24]
```

The retry's own `Break` stops a second 429 from looping forever.

## Notify before the directive

On critical paths, put an alert (Slack/email with the error, key bundle data and scenario name) and an
optional data-store log record **before** the directive in the `onerror` chain.

## Webhooks

- By default Make answers webhook callers `200 Accepted` immediately, so `Break` is fine.
- **Only when the scenario uses `gateway:WebhookRespond`** for a custom response, add a `WebhookRespond`
  (status 4xx/5xx, error body) followed by `builtin:Commit` to the `onerror` chain, so the caller still gets
  an answer:

```json
"onerror": [
  { "id": N, "module": "gateway:WebhookRespond", "version": 1,
    "mapper": { "status": "400", "body": "{\"error\": \"{{5.error.message}}\"}",
                "headers": [{ "key": "Content-Type", "value": "application/json" }] } },
  { "id": N1, "module": "builtin:Commit", "version": 1, "mapper": {} }
]
```

- Webhook-triggered scenarios deactivate on the **first** unhandled error, whatever `maxErrors` says.

## Things to tell the user

- `Break` and `dlq` create **incomplete executions** that someone must retry or discard in the Make UI.
- A `sequential` scenario with stored incomplete executions **stops processing new data** until they are
  resolved.
- Test every handler by deliberately causing the error (bad key, malformed data) before trusting it.
