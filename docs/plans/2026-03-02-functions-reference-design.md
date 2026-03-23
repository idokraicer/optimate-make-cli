# Make.com Functions & Data Reference — Design

**Date:** 2026-03-02
**Status:** Approved

## Goal

Enrich the make-fixer skill with a complete function reference, data types, type coercion rules, filter operators, and module types — sourced from help.make.com. Each section includes `.md` doc links for live updates.

## File Changes

### New: `FUNCTIONS_REFERENCE.md`
- Syntax rules (semicolons, nesting, variables vs functions)
- Complete function catalog (70+ functions) in table format per category
- Links to `help.make.com/<category>.md` for each section
- Non-existent functions warning
- Custom functions overview (Enterprise, JS ES6, limitations)

### Updated: `SKILL.md`
- Link to FUNCTIONS_REFERENCE.md in references section
- Keep existing Make.com Documentation section (`.md` endpoint trick)

### Updated: `BEST_PRACTICES.md`
- Data Types section (7 types)
- Type Coercion rules
- Module Types quick reference (Triggers, Searches, Actions, Universal)
- Filter Operators reference

## Sources

All data crawled from `help.make.com` using the `.md` endpoint pattern.
