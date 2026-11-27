# Native-First Problem Solving

Load when writing a Fireberry query, choosing custom monday.com GraphQL, before proposing a Code module
(`code:ExecuteCode`), or when a transformation looks "impossible" in native Make.

## Fireberry: Query v3 for every query

Fireberry is retiring the legacy query endpoint (`POST /api/query`). It was announced in November 2026 and
stops working around January 2027. Query v3 (`POST https://api.fireberry.com/api/v3/query`) is the
supported way to search, list or look up Fireberry records by field values. Build the request body with
the `fireberry:fireberry-query-v3` skill.

| Situation | Decision |
|---|---|
| New search, list or lookup by field values | Query v3, formatted as below. |
| Get one record by ID, create, update, delete | The `powerlink:*` connector module for that operation. |
| Existing scenario calls `/api/query`, or a `powerlink:*` search uses the legacy query string | Flag it to the user as a migration item with the deadline. Migrate it when the user approves, in the path being changed, through the normal approval gates. Preserve matching, pagination, mappings and zero/multiple-match behavior. |
| Unsure whether a `powerlink:*` search module calls the legacy endpoint | Say so; verify against a test run or current Fireberry/Make documentation before relying on it after the cutoff. |

## monday.com: standard connector operations first

Build monday.com flows with standard search/get/create/update connector modules and visible Make
filters/mappings whenever they meet the requirements. This concerns user-authored queries, including
queries inside connector modules; a connector's internal API implementation is irrelevant.

Custom queries can make debugging much harder: business logic is hidden in query text rather than visible
module fields, and compact or poorly formatted queries are difficult to read and troubleshoot. That can
leave the team dependent on AI to understand or improve an existing scenario. Manual maintenance and
readable execution bundles are design requirements.

| Condition | Decision |
|---|---|
| No explicit GraphQL request; standard connector operations meet the requirement | Use them, even when a custom query saves operations or combines steps. |
| User explicitly requests monday.com GraphQL | Use it with the safeguards below. Asking for “Monday” or “optimize” alone is not an explicit query request. |
| A critical requirement cannot be met with standard connector operations | Verify the module catalog/mapper limitation, identify the exact missing capability and business impact, and justify the query in the plan. Convenience, fewer modules, deadline pressure, or AI's ability to write it do not qualify. |
| Existing GraphQL module is in the path being improved | Assess it against this table; propose replacement when standard operations suffice. Preserve mappings, matching, pagination, connections and error handling; follow scenario approval gates. Do not silently rewrite unrelated modules. |

If monday.com GraphQL is justified, use the current v2 connector module `monday:ExecuteGraphQLQueryV2`
(`version: 2`) when suitable; use HTTP only for a verified capability the connector cannot provide.
Preserve the project's verified connection and error handling.

## Readable queries (Fireberry Query v3 and monday GraphQL)

- Show the reason for the query in the review plan (for Fireberry, the legacy-query retirement is enough).
- Format the query as readable multiline text, with indentation and one field/condition per line; keep
  dynamic values separate from query structure (GraphQL variables where supported). Preserve line breaks
  in the module query or body field. In JSON exports, encode them correctly as `\n`; do not put literal
  unescaped newlines inside JSON strings.
- Give the module a descriptive name. Through `make-fixer notes` and the normal approval gate, document
  the business purpose, inputs, filters, returned fields, expected result and zero/multiple-match behavior.
  Include a readable query copy if the UI renders its stored query compactly. Never document secrets.
- Verify real input/output bundles and error responses so a teammate can debug and modify the flow
  manually, without needing AI to reconstruct the query.

## Code modules

**Exhaust every native capability before suggesting code.** When something seems impossible natively, think
harder — don't reach for code.

## Native techniques checklist

| Technique | What it unlocks |
|-----------|----------------|
| **Raw string body** | An HTTP body set to `Raw` accepts full `{{...}}` expressions, `+` concatenation and conditionals |
| **String concatenation (`+`)** | Build quotes, colons, brackets and whole JSON structures by hand |
| **`emptystring`** | Truly zero output — not `""`, not `null`. Makes lines, keys or segments disappear |
| **`if` + `emptystring`** | Include or exclude JSON keys, URL params, headers, array elements conditionally |
| **`ifempty` / `coalesce`** | Fallback chains: `coalesce(1.mobile; 1.phone; 1.altPhone; "no-phone")` |
| **Nested composition** | One expression can parse, transform, format and conditionally output |
| **`switch`** | Cleaner than nested `if` for 3+ cases |
| **`omit` / `pick`** | Shape collections without touching individual keys |
| **`map` + `join`** | Lists, query strings, text from arrays: `{{join(map(1.items; "name"); ", ")}}` |
| **`toArray` + `join`** | Serialize collections into params, headers, custom formats |
| **`replace` with regex** | `replace(text; "/pattern/g"; emptystring)` — extract, strip, restructure |
| **`newline`** | Line breaks in raw bodies; `replace(text; newline; "<br />")` |

## Worked example: conditional JSON keys

Structured mode sends every mapped field (as `null`/`""`), and the API rejects empty keys. Use a Raw body
instead:

```
{
  "name": "{{1.name}}",
  "email": "{{1.email}}"{{if(length(ifempty(1.phone; emptystring)) > 0; ",\n  \"phone\": \"" + 1.phone + "\""; emptystring)}}
}
```

Pattern: `{{if(length(ifempty(FIELD; emptystring)) > 0; ",\"KEY\": \"" + FIELD + "\""; emptystring)}}`

The same pattern works for:
- URL parameters: `{{if(1.page; "&page=" + 1.page; emptystring)}}`
- headers
- array elements
- XML nodes

## When a Code module IS justified

Check all three; at least one must apply:

1. **Untrusted data.** Values may contain quotes, backslashes, newlines or unicode that would break a
   string-built JSON/XML structure. `JSON.stringify()` in code is safer.
2. **Looping/recursion** that Iterator + Aggregator cannot express: tree traversal, variable-depth nesting,
   complex accumulation.
3. **Unmaintainable complexity.** The expression would exceed ~200 characters or nest more than 4 levels deep.

If none applies, the answer is native.
