# Native-First Problem Solving

Load before proposing a Code module (`code:ExecuteCode`), or when a transformation looks "impossible" in
native Make.

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
