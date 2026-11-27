# App Gotchas

Load before finalizing Google Sheets, Gmail, other Google app, or Fireberry (`powerlink:*`) modules. These mistakes save cleanly and only
fail, or silently misbehave, at run time. (Make AI Tools model slugs are in `references/ai.md`; monday.com is
covered by the `monday-make-modules` skill.)

## Google Sheets

- `valueInputOption` is required on add/update row and lives in **`mapper`**, not `parameters`. Use
  `"USER_ENTERED"`.
- On add row, also set `"insertDataOption": "INSERT_ROWS"`, or each run can overwrite the same fixed row.
- Row values are keyed by **zero-based column index**: `"values": {"0": "…", "1": "…"}`.
  - Column letters don't error; they write to the wrong place.
  - The app's own row-search filters *do* use letters. That's a different field, so don't apply one rule to
    the other.
- Read columns as ``{{1.`0`}}`` (A) and ``{{1.`1`}}`` (B).
  - Header-named fields exist with `includesHeaders`, but they break when a header is renamed.
  - Row metadata (`{{1.__ROW_NUMBER__}}`, `__SHEET__`, `__SPREADSHEET_ID__`) is how you write back to the
    row a trigger produced.
- Spreadsheet and sheet IDs are account data. Never guess an ID or assume `Sheet1`; take it from an existing
  blueprint or ask.

## Gmail vs other Google apps

Gmail (`google-email:*`) uses a **different connection type** from Sheets, Calendar and Drive. Being
connected to Google for Sheets does not cover Gmail. Some Gmail modules name the connection parameter
`account` instead of `__IMTCONN__`, so check an existing blueprint.

## Fireberry dropdowns

Fireberry (`powerlink:*`) modules output a dropdown's **value** in the field itself (`{{1.pcfStatus}}` → `4`)
and its **label** in a separate `<field>name` field (`{{1.pcfStatusname}}`).

- When writing a dropdown back, map the value field directly. Never build a label→value `switch()`; it only
  looks right while it falls through to its default.
- Don't infer the module's output from the raw Fireberry REST query, which returns labels. Check the
  module's `metadata.interface`.

## Dates

- There is no `startOfDay()`/`endOfDay()`. Build day boundaries as `{{formatDate(now; "YYYY-MM-DD")}}T00:00:00Z`
  and `…T23:59:59Z`.
- Pass `formatNumber` both separators explicitly. Its defaults are a comma decimal and a period thousands
  separator.
