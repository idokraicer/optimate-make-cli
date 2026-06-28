# Startup auto-update check — Design

**Date:** 2026-06-28
**Status:** Approved (pending spec review)

## Goal

When a user runs any `make-fixer` command, the CLI should check whether a newer
version has been published and, if so, transparently update itself before
continuing — without adding meaningful latency to everyday use and without ever
blocking real work when the network or the update fails.

## Context

- **Distribution:** installed globally via
  `bun install -g git+https://github.com/idokraicer/optimate-make-cli.git`.
  Not published to npm. Bun runs `src/cli.ts` directly — there is **no build step**.
- **Version today:** hardcoded `"0.1.0"` in `src/cli.ts`; `package.json` has **no**
  `version` field.
- **End-user installs have no local `.git`** (bun extracts a tarball), so comparing
  local vs. remote commit SHAs is not viable for end users.
- **The maintainer's machine is a special case:** the global install is a *symlink*
  to the dev checkout (`~/Developer/make-fixer`), which **does** have `.git`.
  Reinstalling there would clobber the linked dev setup.

## Decisions (locked)

| Aspect | Decision |
|---|---|
| Cadence | Throttled — check at most once per interval. |
| Default interval | **4 hours**, overridable via `MAKE_FIXER_UPDATE_INTERVAL` (hours). |
| Detection | Compare local `package.json` `version` to the remote `master` `package.json` `version`. |
| Update execution | **Inline** — reinstall, then continue the command on the new version. |
| Update mechanism | `bun install -g git+https://github.com/idokraicer/optimate-make-cli.git`. |
| Release signal | Bumping `version` in `package.json` is the explicit "this is a release" trigger. |

## Architecture

### New module — `src/updater.ts`

Thin IO wrapped around pure, unit-testable decision functions.

- `compareSemver(a: string, b: string): number`
  Numeric `major.minor.patch` comparison, no dependencies. Returns `>0` if `a > b`.
  Pre-release/build suffixes are ignored (YAGNI). *Pure — unit-tested.*
- `shouldCheck(lastCheckMs: number | null, nowMs: number, intervalMs: number): boolean`
  Throttle gate: `true` when never checked or when `nowMs - lastCheckMs >= intervalMs`.
  *Pure — unit-tested.*
- `isDevCheckout(pkgRoot: string): Promise<boolean>`
  `true` when `<pkgRoot>/.git` exists. *Unit-tested.*
- `resolveIntervalMs(env): number`
  Reads `MAKE_FIXER_UPDATE_INTERVAL` (hours, float ok); defaults to **4h**. Invalid
  values fall back to the default. *Pure — unit-tested.*
- `checkForUpdate(): Promise<void>`
  Orchestrator (the only side-effecting export). Sequence below. Always resolves;
  never throws.

### Wiring in `src/cli.ts`

- Add `"version": "0.2.0"` to `package.json`.
- `import pkg from "../package.json"` and pass `pkg.version` to `.version(...)`,
  removing the hardcoded `"0.1.0"` (single source of truth).
- Wrap the entry point in an async `main()`:
  ```ts
  async function main() {
    await checkForUpdate();      // best-effort; never throws
    await program.parseAsync();
  }
  main();
  ```

### New command — `make-fixer update`

Forces a check immediately, **ignoring the throttle** (useful right after a release
is pushed). Respects dev-checkout detection: on a dev checkout it warns and refuses
(suggests `git pull`) rather than clobbering the symlink.

## Data flow — `checkForUpdate()`

1. **Opt-out / dev guards (cheapest first):**
   - If `MAKE_FIXER_NO_UPDATE` is set → return immediately.
   - If `isDevCheckout(pkgRoot)` → return immediately (protects the linked dev setup).
2. **Throttle gate:** read `~/.make-fixer/.update-check.json` → `{ lastCheckMs }`.
   If `!shouldCheck(...)` → return (zero network, zero latency).
3. **Remote read:** `fetch` `https://raw.githubusercontent.com/idokraicer/optimate-make-cli/master/package.json`
   with a **~2s timeout** (`AbortSignal.timeout(2000)`).
4. **Stamp timestamp:** write `lastCheckMs = now` on **every attempt** (success *or*
   failure) so offline machines aren't re-probed on every command.
5. **Compare & act:** if `compareSemver(remote, local) > 0`:
   - Print `↻ Updating <old> → <new>…` to **stderr**.
   - Run `bun install -g git+https://github.com/idokraicer/optimate-make-cli.git`.
   - On success: print `done` to stderr; the command then runs on the new version.

## Guardrails

- **Dev-machine protection:** a `.git` at the package root disables auto-update
  entirely. The `update` command warns and refuses there too.
- **JSON-safe:** every notice goes to **stderr** — never stdout — so `--json` output
  piped to `jq` is never corrupted.
- **Best-effort:** any failure (offline, GitHub down/rate-limited, `bun install`
  non-zero exit) → warn to stderr and continue the command on the current version.
  The check must never block real work.
- **Bounded latency:** the network read is capped at ~2s; throttling means most
  commands do no network at all.
- **Opt-out:** `MAKE_FIXER_NO_UPDATE=1` skips the check (CI / scripts).

## Configuration / state summary

| Item | Location / name |
|---|---|
| Throttle state | `~/.make-fixer/.update-check.json` → `{ lastCheckMs: number }` |
| Interval override | env `MAKE_FIXER_UPDATE_INTERVAL` (hours) |
| Disable | env `MAKE_FIXER_NO_UPDATE` |
| Remote version source | `raw.githubusercontent.com/idokraicer/optimate-make-cli/master/package.json` |
| Update command | `bun install -g git+https://github.com/idokraicer/optimate-make-cli.git` |

## Testing — `src/updater.test.ts`

Pure functions covered directly:
- `compareSemver`: `0.2.0 > 0.1.0`, equal versions, `0.10.0 > 0.9.0`, `1.0.0 > 0.99.99`.
- `shouldCheck`: never-checked (`null`), inside window (skip), outside window (check),
  exactly at boundary.
- `resolveIntervalMs`: default when unset, valid override, invalid override → default.
- `isDevCheckout`: temp dir with and without `.git`.

IO (`fetch`, `bun install` spawn, file read/write) is kept thin around these so the
decision logic is fully testable without network or global installs.

## Out of scope (YAGNI)

- GitHub releases/tags and SHA-stamping (more ceremony than a HEAD-installed tool needs).
- Pre-release/semver-range handling beyond `major.minor.patch`.
- Auto-rollback on a bad update.
