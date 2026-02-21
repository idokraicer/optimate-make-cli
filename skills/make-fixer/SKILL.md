---
name: make-fixer
description: Edit Make.com scenario blueprints. Use when the user mentions Make.com scenarios, blueprints, modules, or automation editing.
user-invocable: true
---

# Make.com Scenario Editor

You can fetch, edit, validate, and push Make.com scenario blueprints using the `make-fixer` CLI.

## Workflow

1. **Fetch** the blueprint: `make-fixer fetch -s <SCENARIO_ID>`
   - Saves to `.make-fixer/<id>.json`
   - Prints module summary with IDs and types
2. **Read** the JSON file and understand the scenario
3. **Analyze** for issues: `make-fixer analyze -s <id> --local`
4. **Edit** the `.make-fixer/<id>.json` file directly using your Edit tool
5. **Validate** changes: `make-fixer validate -s <id>`
   - Shows diff vs remote (added/removed/modified modules, issue count)
6. **Push** when ready: `make-fixer push -s <id>`
   - Always ask the user for confirmation before pushing

## Blueprint Structure

A blueprint is a JSON object:

```json
{
  "name": "Scenario Name",
  "flow": [
    {
      "id": 1,
      "module": "gateway:CustomWebHook",
      "version": 1,
      "mapper": { ... },
      "metadata": {
        "designer": { "x": 0, "y": 0, "name": "Custom Name" }
      },
      "onerror": [
        { "id": 2, "module": "builtin:Break", "mapper": { "retry": true, "count": 3, "interval": 60 } }
      ],
      "routes": [
        { "flow": [ ... nested modules ... ] }
      ]
    }
  ]
}
```

### Key fields

- **id**: Unique integer. Never reuse. New modules must use the next available ID (shown by `fetch` and `validate` commands).
- **module**: Module type string like `gmail:sendEmail`, `powerlink:plquery`, `http:ActionSendData`
- **mapper**: Module configuration (API URLs, field mappings, query parameters)
- **metadata.designer.name**: Custom display name in the Make.com UI
- **onerror**: Error handler array. Standard break handler: `[{ "id": N, "module": "builtin:Break", "version": 1, "mapper": { "retry": true, "count": 3, "interval": 60 } }]`
- **routes**: Array of route objects, each containing a `flow` array (for router modules)
- **filter**: Filter condition between modules. Format: `{ "name": "Filter Name", "conditions": [[{ "a": "{{1.field}}", "b": "value", "o": "equal" }]] }`

### Module types

Excluded from checks (utility): `builtin:*`, `gateway:*`, `json:*`, `tools:*`, `util:*`, `flow:*`, `code:*`

Common types:
- Triggers: `gateway:CustomWebHook`, `google-sheets:watchRows`
- API calls: `http:ActionSendData`, `http:MakeRequest`
- CRM: `powerlink:plquery`, `powerlink:createObject`, `powerlink:updateObject`
- Communication: `gmail:sendEmail`, `slack:sendMessage`
- Routing: `flow:Router` (has `routes` array)

### Variable references

Modules reference other modules' output with `{{moduleId.fieldName}}`:
- `{{1.phone}}` — field `phone` from module #1
- `{{ifempty(1.phone; "")}}` — with fallback

## Rules

1. **Never reuse module IDs.** Check the "Next ID" shown by `fetch` or `validate`.
2. **Always validate before pushing.** Run `make-fixer validate -s <id>` to check your changes.
3. **Always ask the user before pushing.** Show them what changed and get explicit confirmation.
4. **Preserve the `idSequence` field** if present — it is server-managed.
5. **Error handlers need their own unique IDs** — they are separate modules in the `onerror` array.
6. **Position modules visually** using `metadata.designer.x` and `metadata.designer.y`. Increment `x` by ~300 for each subsequent module.

## Common Operations

### Add error handler to a module
Edit the module's `onerror` field:
```json
"onerror": [{ "id": NEXT_ID, "module": "builtin:Break", "version": 1, "mapper": { "retry": true, "count": 3, "interval": 60 } }]
```

### Rename a module
Set `metadata.designer.name`:
```json
"metadata": { "designer": { "x": 300, "y": 0, "name": "Descriptive Name" } }
```

### Add a new module to the flow
Insert into the `flow` array at the desired position with a unique ID.

### Add a route
Add an object with a `flow` array to a router module's `routes` array.

## $ARGUMENTS

If the user provides a scenario ID or description of what to do, start the workflow immediately.
