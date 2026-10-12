# Mapping & Expressions

Load when writing or reviewing `{{...}}` mapper values, or when a mapped field came back empty. Look up
function names in `FUNCTIONS_REFERENCE.md`; this file covers how references and expressions are written.

## Reference forms

| Form | Meaning |
|---|---|
| `{{1.email}}` | field `email` of module 1's output |
| `{{1.body.results.0.name}}` / `{{3.items[1].name}}` | nested access; `[n]` indexing is **1-based** |
| ``{{1.`Customer Name`}}``, ``{{1.`0`}}`` | backticks for names with spaces, special characters, or leading digits |
| ``{{`1`}}`` | module 1's **whole bundle**. A bare `{{1}}` does not parse |

`{{input.x}}`, `{{trigger.x}}` and a bare `{{x}}` don't exist. They **resolve to nothing without an error**.
The trigger's data (webhook payload, subscenario inputs) is just the trigger module's own output:
`{{1.field}}`.

## Syntax rules

- Arguments are separated by **semicolons**: `{{if(1.status = "active"; "Yes"; "No")}}`. Never use commas.
- Use straight quotes only, never typographic ones.
- **Comparison:** `=`, `!=`, `<`, `>`, `<=`, `>=`. **Arithmetic:** `+`, `-`, `*`, `/`, `%`.
- **Logical operators:** use the symbols `&` (AND) and `|` (OR); in exported blueprints they appear as the
  pills `{{&}}` / `{{|}}`. The words `and`/`or`/`AND`/`OR` do not parse. For NOT, verify by exporting from
  the UI.
- No inline JSON objects (`{key: value}`) and no `set()`. Build objects with the module's own fields, or with
  a Raw body (`references/native-first.md`).
- `now`, `timestamp`, `uuid`, `executionId`, `random`, `pi` are variables and take no parentheses.
- Put a JSON object into a text field with `{{toString(1.json)}}`.

## `ifempty` fallback values (house rule)

Fallbacks exist so a lookup still runs and returns zero matches instead of breaking. The fallback must:

1. **match the field's type** — a fake email for an email field, a phone number for a phone field;
2. **never match a real record;**
3. **leave numeric-like values unquoted** — `0121231234`, not `"0121231234"`;
4. **look realistic** — not gibberish, empty, or a single character.

Examples:
- `{{ifempty(6.email; nomatch@invalid.test)}}`
- `{{ifempty(6.phone; 0121231234)}}`
- `{{ifempty(6.id; f47ac10b-58cc-4372-a567-0e02b2c3d479)}}` — use a fresh UUID for each `ifempty`; never
  reuse one.

## Knowing which output fields exist

- Static modules: `make-fixer modules <app>` and existing blueprints show the shape.
- Config-dependent output (a Sheets trigger's columns, a webhook's payload) is only known after a real run.
  Map what the app is known to produce, then confirm against a real execution
  (`references/debugging.md`).
- For webhooks, capture one real request before mapping fields. Don't activate a webhook scenario whose
  payload nobody has seen.

## Gotchas validation does not catch

- **An empty string is a write.** On update/upsert modules, omit keys you don't intend to change; `""` blanks
  the field in the target app.
- **Stranded references.** Removing or moving a module leaves its `{{id.field}}` references resolving to
  nothing. Fix them in the same edit.
- **Cross-route references don't resolve.** A module can only read modules upstream of it on the same path.
- **An array mapped into a single-value field** fails at run time. Use `first()`, `last()`, or an index.
- **Full datetimes:** use one `formatDate` call with a literal `T` in the format, not separately formatted
  date and time joined together. The only sanctioned join is for day boundaries:
  `{{formatDate(now; "YYYY-MM-DD")}}T00:00:00Z`.
