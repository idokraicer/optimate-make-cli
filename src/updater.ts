import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_INTERVAL_HOURS = 4;
export const DEFAULT_INTERVAL_MS = DEFAULT_INTERVAL_HOURS * 3600_000;

const REPO_SPEC = "git+https://github.com/idokraicer/optimate-make-cli.git";
const REMOTE_PKG_URL =
  "https://raw.githubusercontent.com/idokraicer/optimate-make-cli/master/package.json";
const FETCH_TIMEOUT_MS = 2000;

const GLOBAL_CONFIG_DIR = join(homedir(), ".make-fixer");
const STATE_PATH = join(GLOBAL_CONFIG_DIR, ".update-check.json");

/** Package root: this file lives at <pkgRoot>/src/updater.ts. */
const PKG_ROOT = dirname(import.meta.dir);

/**
 * Compare two `major.minor.patch` version strings numerically.
 * Missing components are treated as 0. Pre-release/build suffixes are ignored.
 * Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/, "")
      .split(/[.+-]/)
      .slice(0, 3)
      .map((p) => parseInt(p, 10) || 0);

  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Throttle gate. Returns true when a check should run: either it has never run
 * (lastCheckMs is null) or at least `intervalMs` has elapsed since the last check.
 */
export function shouldCheck(
  lastCheckMs: number | null,
  nowMs: number,
  intervalMs: number,
): boolean {
  if (lastCheckMs == null) return true;
  return nowMs - lastCheckMs >= intervalMs;
}

/**
 * Resolve the throttle interval (ms) from the environment.
 * `MAKE_FIXER_UPDATE_INTERVAL` is read as a number of hours (fractional allowed).
 * Non-numeric, zero, or negative values fall back to the default.
 */
export function resolveIntervalMs(env: Record<string, string | undefined>): number {
  const raw = env.MAKE_FIXER_UPDATE_INTERVAL;
  if (raw == null) return DEFAULT_INTERVAL_MS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_INTERVAL_MS;
  return hours * 3600_000;
}

/**
 * True when the given package root is a git working tree (a `.git` entry exists).
 * Used to detect a linked/dev checkout where auto-update must be disabled so the
 * developer's setup is never clobbered by a global reinstall.
 */
export async function isDevCheckout(pkgRoot: string): Promise<boolean> {
  const fs = await import("node:fs/promises");
  try {
    await fs.stat(join(pkgRoot, ".git"));
    return true;
  } catch {
    return false;
  }
}

// --- IO (thin wrappers around the pure functions above) ---

async function readLastCheck(): Promise<number | null> {
  try {
    const file = Bun.file(STATE_PATH);
    if (!(await file.exists())) return null;
    const json = await file.json();
    return typeof json?.lastCheckMs === "number" ? json.lastCheckMs : null;
  } catch {
    return null;
  }
}

async function stampLastCheck(ms: number): Promise<void> {
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(GLOBAL_CONFIG_DIR, { recursive: true });
    await Bun.write(STATE_PATH, JSON.stringify({ lastCheckMs: ms }));
  } catch {
    // best-effort: a missing timestamp just means we check again next run
  }
}

/** Fetch the published version from the remote package.json, or null on any failure. */
async function fetchRemoteVersion(): Promise<string | null> {
  try {
    const res = await fetch(REMOTE_PKG_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    return typeof json?.version === "string" ? json.version : null;
  } catch {
    return null;
  }
}

/** Run the global reinstall. Returns true on success. Output kept off stdout (JSON-safe). */
async function runInstall(): Promise<boolean> {
  try {
    // process.execPath is the absolute path to the running bun binary — robust on
    // Windows/macOS/Linux without depending on `bun` being resolvable on PATH.
    const proc = Bun.spawn([process.execPath, "install", "-g", REPO_SPEC], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      if (err.trim()) process.stderr.write(err);
    }
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Injectable IO boundaries for {@link checkForUpdate}. Every field defaults to the
 * real implementation; tests override them to exercise the decision logic without
 * touching the network, the filesystem, or the global install.
 */
export interface CheckDeps {
  now?: () => number;
  env?: Record<string, string | undefined>;
  isDev?: () => Promise<boolean>;
  readLastCheck?: () => Promise<number | null>;
  stampLastCheck?: (ms: number) => Promise<void>;
  fetchRemoteVersion?: () => Promise<string | null>;
  runInstall?: () => Promise<boolean>;
  log?: (msg: string) => void;
}

/**
 * Best-effort startup check. Never throws and never writes to stdout, so it is safe
 * to call before any command (including `--json` commands piped to `jq`).
 *
 * Skips entirely when: opted out via MAKE_FIXER_NO_UPDATE, running from a dev
 * checkout (.git present), or still inside the throttle window. On a found update it
 * reinstalls inline and the caller continues on the new version.
 */
export async function checkForUpdate(localVersion: string, deps: CheckDeps = {}): Promise<void> {
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const isDev = deps.isDev ?? (() => isDevCheckout(PKG_ROOT));
  const readLast = deps.readLastCheck ?? readLastCheck;
  const stamp = deps.stampLastCheck ?? stampLastCheck;
  const fetchRemote = deps.fetchRemoteVersion ?? fetchRemoteVersion;
  const install = deps.runInstall ?? runInstall;
  const log = deps.log ?? ((msg: string) => void process.stderr.write(msg));

  try {
    if (env.MAKE_FIXER_NO_UPDATE) return;
    if (await isDev()) return;

    const intervalMs = resolveIntervalMs(env);
    if (!shouldCheck(await readLast(), now(), intervalMs)) return;

    const remote = await fetchRemote();
    await stamp(now()); // stamp every attempt so offline machines aren't re-probed

    if (!remote || compareSemver(remote, localVersion) <= 0) return;

    log(`↻ Updating make-fixer ${localVersion} → ${remote}…\n`);
    const ok = await install();
    log(
      ok
        ? `↻ Updated to ${remote}.\n`
        : `⚠ make-fixer auto-update failed; continuing on ${localVersion}.\n`,
    );
  } catch {
    // best-effort: an update check must never block the actual command
  }
}

/** Forced update for `make-fixer update` — ignores the throttle, still respects dev checkouts. */
export async function forceUpdate(localVersion: string): Promise<void> {
  if (await isDevCheckout(PKG_ROOT)) {
    process.stderr.write(
      "Running from a dev checkout (.git present); skipping global reinstall. Use `git pull` instead.\n",
    );
    return;
  }

  const remote = await fetchRemoteVersion();
  if (!remote) {
    process.stderr.write("Could not reach GitHub to check for the latest version.\n");
    return;
  }

  if (compareSemver(remote, localVersion) <= 0) {
    process.stderr.write(`Already up to date (${localVersion}).\n`);
    await stampLastCheck(Date.now());
    return;
  }

  process.stderr.write(`↻ Updating make-fixer ${localVersion} → ${remote}…\n`);
  const ok = await runInstall();
  if (ok) {
    process.stderr.write(`↻ Updated to ${remote}.\n`);
    await stampLastCheck(Date.now());
  } else {
    process.stderr.write(`⚠ Update failed; still on ${localVersion}.\n`);
  }
}
