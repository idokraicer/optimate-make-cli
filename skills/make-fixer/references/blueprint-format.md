# Blueprint Format — Structure, Modules, Flow Control

Load when reading or editing blueprint JSON: adding/moving modules, routers, if-else/merge, iterators,
aggregators, variables, filters, or scenario settings.

## Skeleton

```json
{
  "name": "Scenario Name",
  "flow": [
    {
      "id": 1,
      "module": "gateway:CustomWebHook",
      "version": 1,
      "parameters": { },
      "mapper": { },
      "metadata": { "designer": { "x": 0, "y": 0, "name": "Custom Name" } },
      "filter": null,
      "onerror": [ { "id": 2, "module": "builtin:Break", "version": 1, "mapper": { "retry": true, "count": 3, "interval": 15 } } ],
      "routes": [ { "flow": [ ] } ]
    }
  ],
  "metadata": { "scenario": { "sequential": false, "autoCommit": true, "maxErrors": 3, "confidential": false, "freshVariables": false, "dataloss": false } }
}
```

### Key fields

- **id** — unique integer, never reused. New modules take the next free ID (shown by `fetch` / `validate`).
  Error-handler modules in `onerror` need their own IDs too. Preserve a server-managed `idSequence` if present.
- **module** — `app:ModuleName`. Look up app modules with `make-fixer apps` + `make-fixer modules`; only the
  builtin/util types below may be written from memory.
- **parameters** — connection IDs and static module settings. **mapper** — per-item values and expressions.
- **metadata.designer** — `name` is the UI label; `x`/`y` position (step `x` by ~300 per module).
- **onerror** — error-handler chain (see `references/error-handling.md`).
- **routes** — router arms, each `{ "flow": [...] }`. **branches** — if-else arms (below).
- **filter** — `{ "name": "...", "conditions": [[{ "a": "{{1.x}}", "o": "text:equal", "b": "y" }]] }`.
  Outer array = OR groups, inner array = AND conditions.

## Filter operators

`o` is lowercase with a `type:` prefix (except existence). A malformed code **saves fine and never matches** —
the #1 cause of "filters that don't fire".

| Type | Codes |
|------|-------|
| Existence (no `b`) | `exist`, `notexist` |
| Text (append `:ci` for case-insensitive, e.g. `text:equal:ci`, `text:pattern:ci`) | `text:equal`, `text:notequal`, `text:contain`, `text:notcontain`, `text:startwith`, `text:endwith`, `text:pattern` (regex in `b`) |
| Number | `number:equal`, `number:notequal`, `number:greater`, `number:greaterorequal`, `number:less`, `number:lessorequal` |
| Date | `date:greater` (later than), `date:greaterorequal`, `date:less` (earlier than) |
| Boolean | `boolean:equal`, `boolean:notequal` |
| Array | `array:contain` |

Note the spelling: it is `startwith`/`endwith` (no "s"), **not** `startswith`/`endswith`.

**Sources (checked 2026-10-12):**
- `text:startwith`, `text:endwith`, `text:pattern(:ci)`, `date:greater` and `date:greaterorequal` appear as
  `"o"` values in public Make blueprint exports. Make's official agent skills list the same codes.
- `exist`, `notexist`, `text:equal`, `text:notequal(:ci)` and `boolean:equal` appear in our fetched blueprints.
- `date:before`/`date:after` are **Notion app filter options**, not Make filter codes.

For any code not listed (e.g. `date:lessorequal`, `text:notpattern`), **don't guess**. Build the filter once
in the Make editor, export the blueprint, and read the `o` value.

**Broken codes seen in the wild:** `notExist`, `greaterOrEqual`, `text:startswith`, `text:startsWith`, `text:endswith`, `text:contains`,
`numeric:greater`, `boolean:exist`, and bare `equal`/`greater`. Make does not use camelCase, the `numeric:`
prefix, or `boolean:exist`.

A filtered-out bundle stops silently: every module downstream on that path skips it, with no error.

## Scenario settings (`metadata.scenario`)

| Setting | Effect |
|---------|--------|
| `sequential` | One run at a time; a stored failed run then **blocks the queue** until resolved in Make |
| `autoCommit` / `autoCommitTriggerLast` | Commit after each cycle / include the trigger |
| `maxErrors` | Consecutive errors before deactivation. Instant/webhook scenarios deactivate after the **first** error regardless |
| `confidential` | Hides execution data (GDPR/HIPAA) — makes debugging impossible |
| `freshVariables` | Reset variables at the start of each execution |
| `dataloss` | Allow data loss for throughput |
| `dlq` | Store incomplete executions (needed for Break retries) |

Change these only on request; the defaults suit most scenarios. Production recommendations are in
`references/architecture.md`.

## Builtin / utility module catalog (safe from memory)

**Flow control**
- `builtin:BasicRouter` — `mapper: null`, `routes: [{flow: [...]}]`
- `builtin:BasicIfElse` / `builtin:BasicMerge` — see below
- `builtin:BasicFeeder` (iterator) — `mapper: {"array": "{{...}}"}`
- `builtin:BasicAggregator` — `mapper: {}` (NOT `null`), `parameters: {"feeder": <id>}`
- `builtin:BasicRepeater` — `mapper: {"start": "1", "repeats": "N", "step": "1"}`, output `i`

**Error directives** — `builtin:Break`, `builtin:Resume`, `builtin:Ignore`, `builtin:Commit`,
`builtin:Rollback`. Raise errors with `builtin:ThrowError` (`mapper: {message}`) or `builtin:ThrowWarning`.
Details are in `references/error-handling.md`.

**Utility**
- `util:SetVariables` — `{"variables": [{"name": "x", "value": "..."}], "scope": "roundtrip"}`
- `util:SetVariable2` — `{"name": "x", "scope": "roundtrip", "value": "..."}`
- `util:GetVariables` — `{"variables": ["x", "y"]}` (**plain strings**, not objects)
- `util:GetVariable2` — `{"name": "x"}`, output is `value`
- `util:FunctionSleep` — `{"duration": "1"}` (seconds, max 300)
- `util:FunctionIncrement` — `parameters: {"reset": "run"}`
- `util:FunctionAggregator2` — `parameters: {"fn": "sum", "feeder": <id>}`, `mapper.value`, output `result`
- `util:TextAggregator` — `parameters: {"rowSeparator": "", "feeder": <id>}`, `mapper.value`, output `text`
- `util:AggregateAggregator` — `parameters: {"columnSeparator": "", "rowSeparator": "", "feeder": <id>}`
- `util:Switcher` — `{"input": "", "casesTable": [{"pattern": "", "output": ""}], "elseOutput": ""}`

**Other platform modules**
- `gateway:CustomWebHook` (instant trigger), `gateway:WebhookRespond` (HTTP reply to the caller)
- `json:ParseJSON`; `json:AggregateToJSON` — `parameters: {"type": <data-structure-id>, "feeder": <id>}`
- `xml:ParseXML` — `mapper: {"xml": "{{...}}"}`
- `code:ExecuteCode` — last resort (`references/native-first.md`)
- `placeholder:Placeholder` — "do nothing" module for empty if-else branches
- `scenario-service:NameExecution` ("Name a run") — free; `scenario-service:StartSubscenario`,
  `ReturnData`, `CallSubscenario` — see `references/architecture.md`

**HTTP modules** change type by auth method (`http:ActionSendData` vs `...BasicAuth` vs `...APIKeyAuth`).
Always run `make-fixer modules http`.

## Choosing a flow shape

| Situation | Use |
|---|---|
| Skip items that do not match, nothing else to do | `filter` on the next module |
| Exactly one of several actions per item, then continue together | if-else + merge |
| Several independent actions, possibly all for one item | router |
| One bundle holding an array, act per element | iterator |
| Many bundles → one message / payload / total | aggregator |
| Repeat a fixed number of times | repeater |

## Router

- Arms run **sequentially in index order**. A filter on an arm's **first module** decides whether that arm runs.
  Several arms can run for the same bundle.
- Routes never rejoin, and a module on one route **cannot reference** a module on another route.
- Use a router for fan-out (log AND notify AND archive), not for a mutually exclusive choice. That is if-else.

## If-else & Merge

| | If-else | Router |
|---|---|---|
| Runs | only the **first** matching branch | **all** matching routes |
| Rejoin | yes, via `builtin:BasicMerge` | never |
| Credits | free (operations only) | operations + credits |
| Nesting | no router/if-else directly inside a branch | nests freely |

```json
{
  "id": 71, "module": "builtin:BasicIfElse", "version": 1, "mapper": null, "filter": null,
  "branches": [
    { "type": "condition", "label": "Record Doesn't Exist", "merge": true,
      "conditions": [[{ "a": "{{13.recordId}}", "o": "notexist" }]],
      "flow": [ { "id": 38, "module": "..." } ] },
    { "type": "else", "label": "", "merge": true, "disabled": false,
      "flow": [ { "id": 72, "module": "placeholder:Placeholder" } ] }
  ]
}
```

- Conditions live on the **branch object**. **Never put a filter on the first module of a branch** — Make
  deletes it.
- Branches are evaluated in order and the first match wins, so order them from most to least specific. The last
  branch is always `"type": "else"`.

```json
{
  "id": 73, "module": "builtin:BasicMerge", "version": 1, "mapper": null, "filter": null,
  "filters": [null, null],
  "outputs": [ { "name": "recordId", "mappings": ["{{38.id}}", "{{13.recordId}}"] } ]
}
```

- `filters` and every output's `mappings` need **one entry per merging branch, in branch order**. Make
  refuses a length mismatch.
- Downstream modules reference `{{73.recordId}}`.
- Typical uses:
  - create-or-update, then continue with the ID;
  - a different enrichment call per type, merged into one output;
  - replacing a router whose routes are mutually exclusive.

## Iterators and aggregators

- **Search/list modules are implicit iterators.** They emit one bundle per result, so don't add an Iterator
  after them. Use `builtin:BasicFeeder` only when one bundle *contains* an array. Prefer an app's own
  specialized iterator (e.g. "iterate attachments") when `make-fixer modules` lists one.
- Every module after an iteration point runs N times (N operations). Close the loop with an aggregator when you
  need one result.
- `parameters.feeder` is the module whose bundles start the loop (an iterator or an implicit iterator). It
  must be upstream.
- Bundles between the feeder and the aggregator are **not forwarded**. Collect everything needed downstream in
  the aggregator's mapper (`{"email": "{{3.email}}"}`).
- Optional aggregator settings: group output by a value (`groupBy`), stop when nothing arrives
  (`stopIfEmpty`).

## Variables

- **Scope:** `"roundtrip"` = one cycle; `"execution"` = the whole run. Roundtrip variables do **not** reset
  between iterator bundles — they keep the last written value.
- **Reading:**
  - `util:SetVariable2`'s value is readable downstream as `{{<setId>.<name>}}`, so a Get module is
    unnecessary on the same path.
  - `util:GetVariables` exposes `{{id.<name>}}`; `util:GetVariable2` exposes `{{id.value}}`.
- **Cost:** one `util:SetVariables` with 5 values = 1 operation; five `SetVariable2` = 5 operations.
- **Names** are case-sensitive literals. A typo between Set and Get returns `null` with no error.
- **Use variables only** to carry a value across router routes, or for a value computed once and used far
  away. Otherwise map straight from the source module — it's cheaper and clearer.

## Edit recipes

- **Rename:** set `metadata.designer.name`.
- **Add a module:** insert into the right `flow` array with a fresh ID. Then fix every `{{id.field}}` that a
  moved or removed module leaves dangling — a stranded reference resolves to empty without an error.
- **Add a route:** append `{ "flow": [...] }` to `routes`, with the filter on the route's first module.
- **Add an if-else branch:** insert before the final `else` branch, then extend the Merge's `filters` and
  `mappings` to match.
- **Strings inside expressions:** prefer single quotes to avoid JSON escaping: `{{ifempty(1.name; 'Unknown')}}`.
