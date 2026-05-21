# Make.com Functions Reference

Complete reference for all inline functions available in Make.com scenarios. Each category links to the official documentation for the most up-to-date information.

**Live docs:** Append `.md` to any help.make.com URL for LLM-friendly markdown (e.g., `https://help.make.com/general-functions.md`).

---

## Syntax Rules

- **Semicolons** separate function arguments, NOT commas: `if(1=1; "yes"; "no")`
- **Nesting** is supported: `upper(substring(text; 0; 5))`
- `now` and `timestamp` are **variables** (no parentheses), not functions
- Array indexing is **1-based** in `get()`, **0-based** in `slice()`
- Module output references: `{{moduleId.fieldName}}` (e.g., `{{1.phone}}`)
- Fallback pattern: `{{ifempty(1.phone; "")}}`

### Non-existent functions — NEVER use these

These do NOT exist in Make.com. Using them will cause errors:
`dateDifference`, `startOfDay`, `endOfDay`, `toBoolean`, `toNumber`, `log`, `ln`, `values`

**To calculate days between dates**, use: `{{round((2.value - 1.value) / 1000 / 60 / 60 / 24)}}`

---

## Data Types

[Live docs](https://help.make.com/item-data-types.md)

| Type | Description |
|------|-------------|
| **Text** | Strings — letters, numbers, special characters |
| **Number** | Numeric values — integers and decimals |
| **Boolean** | `true` / `false` (displayed as Yes/No in UI) |
| **Date** | ISO 8601 internally (`2024-01-15T10:30:00.000Z`) |
| **Buffer** | Binary data (files, images, videos) |
| **Collection** | Key-value object: `{"name": "John", "age": 30}` |
| **Array** | Ordered list of items (uniform type) |

### Type Coercion

[Live docs](https://help.make.com/type-coercion.md)

Make automatically converts types when there's a mismatch:

| Target | From Text | From Number | From Boolean | From Date |
|--------|-----------|-------------|--------------|-----------|
| **Text** | — | Stringify | `"true"`/`"false"` | ISO 8601 string |
| **Number** | Parse (errors if non-numeric) | — | N/A | N/A |
| **Boolean** | `No` if empty or `"false"`, else `Yes` | `Yes` (even `0`) | — | N/A |
| **Date** | Parse (needs day+month+year) | Milliseconds since epoch | N/A | — |
| **Array** | Wrapped as single-element array | Wrapped | Wrapped | Wrapped |
| **Collection** | Validation error | Validation error | Validation error | Validation error |

---

## General Functions

[Live docs](https://help.make.com/general-functions.md)

| Function | Signature | Returns | Description |
|----------|-----------|---------|-------------|
| `get` | `get(object_or_array; path)` | any | Access value at path. Array indices are 1-based. Dot notation for nesting: `get(obj; "a.b.c")` |
| `if` | `if(expression; value1; value2)` | any | Returns `value1` if true, `value2` if false |
| `ifempty` | `ifempty(value1; value2)` | any | Returns `value1` if not empty, otherwise `value2` |
| `switch` | `switch(expr; val1; result1; [val2; result2; ...]; [else])` | any | Match `expr` against values, return corresponding result. Optional else as last arg |
| `omit` | `omit(collection; key1; [key2; ...])` | collection | Returns collection without the specified keys |
| `pick` | `pick(collection; key1; [key2; ...])` | collection | Returns collection with only the specified keys |

---

## Math Functions

[Live docs](https://help.make.com/math-functions.md)

| Function | Signature | Returns | Description |
|----------|-----------|---------|-------------|
| `abs` | `abs(number)` | number | Absolute value |
| `average` | `average([array])` or `average(val1; val2; ...)` | number | Arithmetic mean |
| `ceil` | `ceil(number)` | integer | Round up to nearest integer |
| `floor` | `floor(number)` | integer | Round down to nearest integer |
| `formatNumber` | `formatNumber(number; decimals; [decSep]; [thousandsSep])` | text | Format with separators. Default: `,` decimal, `.` thousands |
| `max` | `max([array])` or `max(val1; val2; ...)` | number | Largest value |
| `median` | `median([array])` or `median(val1; val2; ...)` | number | Middle value |
| `min` | `min([array])` or `min(val1; val2; ...)` | number | Smallest value |
| `parseNumber` | `parseNumber(number; decimalSeparator)` | number | Parse string to number with custom decimal separator |
| `round` | `round(number)` | integer | Round to nearest integer |
| `stdevP` | `stdevP([array])` or `stdevP(val1; val2; ...)` | number | Population standard deviation |
| `stdevS` | `stdevS([array])` or `stdevS(val1; val2; ...)` | number | Sample standard deviation |
| `sum` | `sum([array])` or `sum(val1; val2; ...)` | number | Sum of all values |
| `trunc` | `trunc(number; [decimalPlaces])` | number | Truncate fractional part. Negative places truncate left of decimal |

### Math Variable

| Variable | Description |
|----------|-------------|
| `random` | Pseudo-random float in `[0, 1)`. For integer range: `{{floor(random * (max - min + 1)) + min}}` |
| `pi` | The constant π (3.14159...) |

---

## Text & Binary Functions

[Live docs](https://help.make.com/text-and-binary-functions.md)

| Function | Signature | Returns | Description |
|----------|-----------|---------|-------------|
| `ascii` | `ascii(text; [removeDiacritics])` | text | Remove non-ASCII characters |
| `base64` | `base64(text)` | text | Encode text to base64 |
| `capitalize` | `capitalize(text)` | text | Capitalize first character |
| `contains` | `contains(text; searchString)` | boolean | Check if text contains search string |
| `decodeURL` | `decodeURL(text)` | text | Decode URL-encoded characters |
| `encodeURL` | `encodeURL(text)` | text | Encode special characters for URL |
| `escapeHTML` | `escapeHTML(text)` | text | Escape HTML tags |
| `indexOf` | `indexOf(string; value; [start])` | integer | Position of first occurrence. Returns `-1` if not found |
| `length` | `length(text_or_buffer)` | integer | Character count (text) or byte size (buffer) |
| `lower` | `lower(text)` | text | Convert to lowercase |
| `md5` | `md5(text)` | text | MD5 hash |
| `replace` | `replace(text; searchString; replacement)` | text | Replace occurrences. Supports regex: `replace(text; "/pattern/g"; emptystring)`. **Note:** To replace with nothing, use the keyword `emptystring` — an empty string `""` does NOT work as replacement |
| `replaceEmojiCharacters` | `replaceEmojiCharacters(text)` | text | Replace emoji characters |
| `sha1` | `sha1(text; [encoding]; [key])` | text | SHA-1 hash. Encoding: hex, base64, latin1 |
| `sha256` | `sha256(text; [encoding]; [key]; [keyEncoding])` | text | SHA-256 hash |
| `sha512` | `sha512(text; [encoding]; [key]; [keyEncoding])` | text | SHA-512 hash |
| `split` | `split(text; separator)` | array | Split string into array |
| `startcase` | `startcase(text)` | text | Capitalize first letter of every word, lowercase rest |
| `stripHTML` | `stripHTML(text)` | text | Remove all HTML tags |
| `substring` | `substring(text; start; end)` | text | Extract portion between start and end positions |
| `toBinary` | `toBinary(value; [encoding])` | binary | Convert to binary. Encoding: hex, base64 |
| `toString` | `toString(value)` | text | Convert any value to string |
| `trim` | `trim(text)` | text | Remove leading/trailing whitespace |
| `upper` | `upper(text)` | text | Convert to uppercase |

---

## Date & Time Functions

[Live docs](https://help.make.com/date-and-time-functions.md)

| Function | Signature | Returns | Description |
|----------|-----------|---------|-------------|
| `formatDate` | `formatDate(date; format; [timezone])` | text | Format date to text. Uses org timezone if omitted |
| `parseDate` | `parseDate(text; format; [timezone])` | date | Parse text to date |
| `addDays` | `addDays(date; number)` | date | Add days (negative to subtract) |
| `addHours` | `addHours(date; number)` | date | Add hours |
| `addMinutes` | `addMinutes(date; number)` | date | Add minutes |
| `addMonths` | `addMonths(date; number)` | date | Add months |
| `addSeconds` | `addSeconds(date; number)` | date | Add seconds |
| `addYears` | `addYears(date; number)` | date | Add years |
| `setSecond` | `setSecond(date; number)` | date | Set seconds (0–59). Out-of-range adjusts minutes |
| `setMinute` | `setMinute(date; number)` | date | Set minutes (0–59). Out-of-range adjusts hours |
| `setHour` | `setHour(date; number)` | date | Set hour (0–23). Out-of-range adjusts days |
| `setDay` | `setDay(date; number_or_name)` | date | Set day of week. 1=Sunday, 7=Saturday. Accepts English names |
| `setDate` | `setDate(date; number)` | date | Set day of month (1–31). Out-of-range adjusts months |
| `setMonth` | `setMonth(date; number_or_name)` | date | Set month (1–12). Accepts English names |
| `setYear` | `setYear(date; number)` | date | Set the year |

### Date Variables

| Variable | Description |
|----------|-------------|
| `now` | Current date and time (no parentheses) |
| `timestamp` | Current Unix timestamp in seconds (no parentheses) |

### Global Variables

These variables are available anywhere in expressions (no parentheses):

| Variable | Description |
|----------|-------------|
| `newline` | Literal line break character. Use in `replace()` to swap line breaks: `replace(text; newline; "<br />")` |
| `emptystring` | Truly empty output — not `""`, not `null`. Use to make values disappear entirely. |

### Useful Date Formulas

- **Days between dates:** `{{round((date2 - date1) / 1000 / 60 / 60 / 24)}}`
- **Seconds to HH:MM:SS:** `{{floor(secs / 3600)}}:{{floor((secs % 3600) / 60)}}:{{(secs % 3600) % 60}}`

---

## Date/Time Formatting Tokens

[Live docs](https://help.make.com/tokens-for-datetime-formatting.md)

Used with `formatDate()`. Based on Moment.js token syntax.

### Year, Month, Day

| Token | Output | Description |
|-------|--------|-------------|
| `YY` | `14` | 2-digit year |
| `YYYY` | `2014` | 4-digit year |
| `Y` | `-25`, `2014` | Year with any digits and sign |
| `Q` | `1`–`4` | Quarter |
| `Qo` | `1st`–`4th` | Quarter with ordinal |
| `M` | `1`–`12` | Month number |
| `Mo` | `1st`–`12th` | Month with ordinal |
| `MM` | `01`–`12` | Month with leading zero |
| `MMM` | `Jan`–`Dec` | Month abbreviation |
| `MMMM` | `January`–`December` | Full month name |
| `D` | `1`–`31` | Day of month |
| `Do` | `1st`–`31st` | Day with ordinal |
| `DD` | `01`–`31` | Day with leading zero |
| `DDD` | `1`–`365` | Day of year |
| `DDDo` | `1st`–`365th` | Day of year with ordinal |
| `DDDD` | `001`–`365` | Day of year with leading zeros |

### Week & Weekday

| Token | Output | Description |
|-------|--------|-------------|
| `d` | `0`–`6` | Day of week (0=Sunday) |
| `do` | `0th`–`6th` | Day of week with ordinal |
| `dd` | `Su`–`Sa` | 2-letter day abbreviation |
| `ddd` | `Sun`–`Sat` | 3-letter day abbreviation |
| `dddd` | `Sunday`–`Saturday` | Full day name |
| `E` | `1`–`7` | ISO day of week (1=Monday) |
| `w` / `ww` | `1`–`53` | Week of year (with/without leading zero) |
| `W` / `WW` | `1`–`53` | ISO week of year |
| `gg` / `gggg` | `70`–`30` / `1970`–`2030` | Week year |
| `GG` / `GGGG` | `70`–`30` / `1970`–`2030` | ISO week year |

### Time & Offset

| Token | Output | Description |
|-------|--------|-------------|
| `H` / `HH` | `0`–`23` | 24-hour time (with/without leading zero) |
| `h` / `hh` | `1`–`12` | 12-hour time |
| `k` / `kk` | `1`–`24` | 24-hour time (1-based) |
| `A` / `a` | `AM`/`PM` or `am`/`pm` | Meridiem |
| `m` / `mm` | `0`–`59` | Minutes |
| `s` / `ss` | `0`–`59` | Seconds |
| `S` / `SS` / `SSS` | `0`–`999` | Fractional seconds (1–3 digits) |
| `Z` | `+07:00` | Timezone offset with colon |
| `ZZ` | `+0700` | Timezone offset without colon |
| `X` | `1360013296` | Unix timestamp (seconds) |
| `x` | `1360013296123` | Unix timestamp (milliseconds) |

---

## Date/Time Parsing Tokens

[Live docs](https://help.make.com/tokens-for-datetime-parsing.md)

Used with `parseDate()`. Subset of formatting tokens.

| Token | Example | Description |
|-------|---------|-------------|
| `YYYY` / `YY` | `2014` / `14` | 4 or 2 digit year |
| `Y` | `-25` | Year with any digits and sign |
| `Q` | `1`–`4` | Quarter |
| `M` / `MM` | `1`–`12` | Month number |
| `MMM` / `MMMM` | `Jan` / `January` | Month name |
| `D` / `DD` | `1`–`31` | Day of month |
| `Do` | `1st`–`31st` | Day with ordinal |
| `DDD` / `DDDD` | `1`–`365` | Day of year |
| `X` | `1410715640.579` | Unix timestamp |
| `x` | `1410715640579` | Unix ms timestamp |
| `GGGG` / `GG` | `2014` / `14` | ISO week year |
| `W` / `WW` | `1`–`53` | ISO week of year |
| `E` | `1`–`7` | ISO day of week |
| `ddd` / `dddd` | `Mon` / `Monday` | Day name |
| `H` / `HH` | `0`–`23` | 24-hour time |
| `h` / `hh` | `1`–`12` | 12-hour time |
| `k` / `kk` | `1`–`24` | 24-hour (1-based) |
| `a` / `A` | `am` / `PM` | Meridiem |
| `m` / `mm` | `0`–`59` | Minutes |
| `s` / `ss` | `0`–`59` | Seconds |
| `S` / `SS` / `SSS` | `0`–`999` | Fractional seconds |
| `Z` / `ZZ` | `+12:00` / `+1200` | UTC offset |

---

## Array Functions

[Live docs](https://help.make.com/array-functions.md)

| Function | Signature | Returns | Description |
|----------|-----------|---------|-------------|
| `add` | `add(array; value1; value2; ...)` | array | Add values to array |
| `contains` | `contains(array; value)` | boolean | Check if array contains value |
| `deduplicate` | `deduplicate(array)` | array | Remove duplicate values |
| `distinct` | `distinct(array; [key])` | array | Remove duplicates. Optional `key` for complex objects |
| `first` | `first(array)` | any | First element |
| `flatten` | `flatten(array)` | array | Flatten nested arrays recursively |
| `join` | `join(array; separator)` | text | Concatenate elements with separator |
| `keys` | `keys(object)` | array | Get all keys from object or array |
| `last` | `last(array)` | any | Last element |
| `length` | `length(array)` | number | Number of items |
| `map` | `map(array; key; [filterKey]; [filterValues])` | array | Extract values by key. Optional filtering (see below) |
| `merge` | `merge(array1; array2; ...)` | array | Merge arrays into one |
| `remove` | `remove(array; value1; value2; ...)` | array | Remove values (primitive arrays only) |
| `reverse` | `reverse(array)` | array | Reverse element order |
| `shuffle` | `shuffle(array)` | array | Randomly reorder elements |
| `slice` | `slice(array; start; [end])` | array | Extract portion. **0-based** indexing |
| `sort` | `sort(array; [order]; [key])` | array | Sort values. Order: `asc` (default), `desc`, `asc ci`, `desc ci` |
| `toArray` | `toArray(collection)` | array | Convert collection to array of key-value pairs |
| `toCollection` | `toCollection(array; key; value)` | collection | Convert array of objects to collection |

### The `map` function in detail

`map()` is one of the most important functions for working with complex arrays. It extracts a single field from each element:

```
map(Emails[]; email)
→ ["john@example.com", "jane@example.com"]
```

**With filtering** — only extract values where another field matches:
```
map(Emails[]; email; label; work)
→ ["john@work.com"]  (only emails where label = "work")

map(Emails[]; email; label; work,home)
→ ["john@work.com", "jane@home.com"]  (label = "work" OR "home")
```

Parameters:
1. `array` — the complex array to iterate
2. `key` — the field to extract from each element
3. `filterKey` (optional) — field to filter on
4. `filterValues` (optional) — comma-separated values to match

---

## Custom Functions

[Live docs](https://help.make.com/custom-functions.md)

**Enterprise only.** Write JavaScript ES6 functions for custom data transformation.

### Limitations
- **300ms** max execution time
- **5,000 characters** max code size
- Synchronous only — no async/await
- No HTTP requests
- No recursion or inter-function calls
- No browser APIs (runs on server)

### Structure
```javascript
function myFunction(param1, param2) {
  // Use iml.* to access Make built-in functions
  // e.g., iml.length(text)
  return result;
}
```

### Access
- Team Admins can create/edit
- Team Members can view/use
- Deleting a function used in active scenarios causes runtime errors

---

## Filter Operators

[Live docs](https://help.make.com/filtering.md)

Filters are placed between modules to control data flow. Each condition has: operand(s) + operator.

### Text Operators
| Operator | Code | Description |
|----------|------|-------------|
| Equal to | `text:equal` | Exact match |
| Not equal to | `text:notEqual` | Not exact match |
| Contains | `text:contain` | Substring match |
| Does not contain | `text:notContain` | No substring match |
| Starts with | `text:startsWith` | Prefix match |
| Does not start with | `text:notStartsWith` | No prefix match |
| Ends with | `text:endsWith` | Suffix match |
| Does not end with | `text:notEndsWith` | No suffix match |
| Matches pattern (regex) | `text:matches` | Regular expression match |
| Does not match pattern | `text:notMatches` | No regex match |

**Case-insensitive variants:** Append `:ci` to any text operator for case-insensitive matching. Examples: `text:equal:ci`, `text:contain:ci`, `text:startsWith:ci`, `text:notContain:ci`. Works with all text operators above.

### Numeric Operators
| Operator | Code | Description |
|----------|------|-------------|
| Equal to | `numeric:equal` | Exact numeric match |
| Not equal to | `numeric:notEqual` | Not equal |
| Greater than | `numeric:greater` | `>` |
| Greater than or equal | `numeric:greaterOrEqual` | `>=` |
| Less than | `numeric:less` | `<` |
| Less than or equal | `numeric:lessOrEqual` | `<=` |

### Existence Operators
| Operator | Code | Description |
|----------|------|-------------|
| Exists | `boolean:exist` | Field has a value |
| Does not exist | `boolean:notExist` | Field is empty |

### Boolean/Other
| Operator | Code | Description |
|----------|------|-------------|
| Equal to (boolean) | `boolean:equal` | Boolean match |

---

## Help Center Navigation

For deeper reference, append `.md` to these URLs:

| Topic | URL |
|-------|-----|
| Get Started | `https://help.make.com/get-started.md` |
| Functions overview | `https://help.make.com/functions.md` |
| General functions | `https://help.make.com/general-functions.md` |
| Math functions | `https://help.make.com/math-functions.md` |
| Text & binary functions | `https://help.make.com/text-and-binary-functions.md` |
| Date & time functions | `https://help.make.com/date-and-time-functions.md` |
| Formatting tokens | `https://help.make.com/tokens-for-datetime-formatting.md` |
| Parsing tokens | `https://help.make.com/tokens-for-datetime-parsing.md` |
| Array functions | `https://help.make.com/array-functions.md` |
| Custom functions | `https://help.make.com/custom-functions.md` |
| Data types | `https://help.make.com/item-data-types.md` |
| Type coercion | `https://help.make.com/type-coercion.md` |
| Mapping | `https://help.make.com/mapping.md` |
| Filtering | `https://help.make.com/filtering.md` |
| Module types | `https://help.make.com/types-of-modules.md` |
| Error handlers | `https://help.make.com/error-handlers.md` |
| Scenarios | `https://help.make.com/scenarios.md` |
| Variables | `https://help.make.com/variables.md` |
| Data stores | `https://help.make.com/data-stores.md` |
| Tools (Iterator/Aggregator/Router) | `https://help.make.com/tools.md` |
| Make AI Agents | `https://help.make.com/make-ai-agents-new.md` |
