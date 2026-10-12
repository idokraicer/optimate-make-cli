# Conventions — Naming, Testing, Cost Checklist, Versioning

Load when naming scenarios or modules, planning tests, running a pre-activation cost review, or setting up
backups and environments.

## Naming

- **Scenarios:** `[APP] | [ENV] | [DOMAIN] | [TRIGGER > OUTCOME]`, e.g. `CRM | PROD | Leads | Form Submit > Slack Alert`.
- **Modules:** `[Step#] [Verb] [System] [Object]`, e.g. `03 Get Airtable Lead Record`.
- **Subscenarios:** action names, e.g. `Format Customer Data`, `Validate Email Domain`.
- **Optional emoji tags:** 🔔 alerts, 📊 reporting, 🤖 AI, ⚡ reusable subscenario, 🪝 webhook.
- Notes and documentation go through `make-fixer notes`, never the blueprint.

## Safe testing

- Make sure the scenario is OFF (not scheduled) while testing. Use test accounts and records labelled
  `TEST – …`.
- Disable destructive or customer-facing steps until the scenario is stable.
- For Watch triggers, use "Choose where to start → manually" so tests don't advance the cursor.
- **Mock layer:** copy trigger fields into one `util:SetVariables` right after the trigger, and have
  downstream modules reference the variables. A dormant `json:ParseJSON` holding sample data can then stand
  in for the trigger.
- Cause each expected error on purpose (bad key, malformed data) and watch the handler fire.
- Polling, scheduled and on-demand scenarios can be run directly. A webhook only runs when a real request
  arrives, so have the user send one.

## Cost checklist (before activating)

- [ ] Filter immediately after the trigger, not after processing.
- [ ] Polling interval matches the real freshness need.
- [ ] No lookups inside an iterator that could move before it.
- [ ] No explicit Iterator after a search/list module (those already iterate).
- [ ] Bulk endpoints used instead of per-record writes; aggregate first.
- [ ] Multi-variable `util:SetVariables` instead of several `SetVariable2`; no Get Variable on the same path
  (map `{{setId.name}}`).
- [ ] If-else instead of a router when routes are mutually exclusive. If-else, Merge, Name a run and
  `CallSubscenario` cost no credits.
- [ ] `Limit` / max results set on every search and list module.

## Versioning and environments

- Make has no git-style history. A daily backup scenario can list scenarios, fetch each blueprint, and upload
  it to GitHub/Drive (needs the `organizations:read` and `scenarios:read` scopes). `make-fixer fetch` gives
  you local snapshots.
- Separate dev, staging and prod teams. Don't edit prod directly: clone, test, then replace.
