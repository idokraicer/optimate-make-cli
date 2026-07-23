# optimate-make-cli

A CLI tool to fetch, analyze, edit, build, and push [Make.com](https://make.com) scenario blueprints.

## Quick Install

Works on **Windows, macOS, and Linux**. Requires the [Bun](https://bun.sh) runtime
and [Git](https://git-scm.com) (Bun uses Git to install from this repo).

**1. Install Bun**

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash
```

```powershell
# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"
```

**2. Install make-fixer** (same command on every OS)

```bash
bun install -g git+https://github.com/idokraicer/optimate-make-cli.git
```

This links a `make-fixer` binary into Bun's bin directory (`~/.bun/bin` on
macOS/Linux, `%USERPROFILE%\.bun\bin` on Windows), which Bun's installer adds to
your `PATH`. Open a new terminal if `make-fixer` isn't found immediately.

**3. Authenticate with your Make.com API token**

```bash
make-fixer login --token <your-token>
```

### Claude Code Plugin (optional)

If you use [Claude Code](https://claude.ai/code), install the Make.com plugin for AI-assisted scenario editing:

```bash
# Add the Optimate marketplace
claude plugin marketplace add idokraicer/optimate-plugins

# Install the make-fixer plugin
claude plugin install make-fixer@optimate-plugins
```

## Usage

```bash
# Fetch a scenario blueprint
make-fixer fetch <scenario-id>

# Analyze a blueprint for issues
make-fixer analyze <scenario-id>

# Edit a blueprint with AI assistance
make-fixer edit <scenario-id> --prompt "Add error handling to all HTTP modules"

# Push changes back to Make.com
make-fixer push <scenario-id>

# List available modules for an app
make-fixer modules <app-name>

# View scenario notes
make-fixer notes <scenario-id>

# Fetch recent execution metadata in compact agent-friendly JSON
make-fixer executions -s <scenario-id> --since 2h --limit 20 --compact

# Save raw JSON and pipe the identical stdout payload to jq
make-fixer executions -s <scenario-id> --since 2h --json \
  --output artifacts/executions.json | jq '.[] | {imtId, status, timestamp}'

# Fetch executions between exact ISO 8601 timestamps
make-fixer executions -s <scenario-id> \
  --from 2026-07-15T09:00:00+03:00 \
  --to 2026-07-15T10:00:00+03:00 \
  --json

# Fetch one execution result
make-fixer executions -s <scenario-id> --id <execution-id>

# Include webhook request data when a matching retained webhook log is available
make-fixer executions -s <scenario-id> --id <execution-id> \
  --include-input --output artifacts/execution.json | jq '.input'
```

## Commands

| Command | Description |
|---------|-------------|
| `login` | Save your Make.com API token globally |
| `fetch` | Download a scenario blueprint |
| `analyze` | Run checks and report issues |
| `edit` | AI-powered blueprint editing |
| `build` | Validate and build a blueprint |
| `push` | Upload blueprint to Make.com |
| `diff` | Compare local vs remote blueprint |
| `modules` | List module types for an app |
| `notes` | List or create scenario notes |
| `resume` | Build a 429-retry resume module |
| `executions` | List/filter executions or fetch one execution result |
| `failures` | Scan a team or organization for failed executions |
| `update` | Update make-fixer to the latest version |

### Execution queries

`executions` supports `--limit`, `--failed`, `--status`, `--from`, `--to`,
`--since`, and `--output <file>`. `--from` and `--to` accept ISO 8601 values
with a timezone or epoch milliseconds. `--since` accepts compact durations
such as `30m`, `2h`, `7d`, and `1mo`.

Use `--json` when you need the untouched Make API rows. Use `--compact` for a
stable, token-efficient object containing the raw execution ID, numeric `imtId`,
status, timestamp, operations, duration, and run name. Then use
`--id <execution-id>` to retrieve
the public execution result for the run you want to inspect. That endpoint
normally contains status plus configured scenario outputs or an error, not all
module input/output bundles.

For webhook-triggered scenarios, add `--include-input` in single-execution mode.
The command uses only the Make API token to retrieve the retained webhook request
and parsed body. Because Make does not document an execution-ID link on webhook
logs, the JSON includes timestamp-match provenance. If the closest match is
ambiguous, missing, expired, or the scenario has no webhook, `input` is `null`
and `inputAvailability.reason` explains why. Make documents webhook log retention
as 3 days normally and 30 days on Enterprise plans.

`--output` creates parent directories and writes the same JSON payload emitted
on stdout. Combine it with `--json` or `--compact` to save an artifact while
continuing to pipe stdout through `jq` or another command.

## Staying up to date

make-fixer checks GitHub for a newer version on startup and, if one is found,
updates itself before running your command. The check is:

- **Throttled** — at most once every 4 hours (cached in `~/.make-fixer/.update-check.json`).
- **Best-effort** — it never blocks your command; if the network or the update
  fails, your command still runs on the current version.
- **Quiet** — all notices go to stderr, so `--json` output stays clean for `jq`.
- **Disabled on dev checkouts** — if you're running from a git clone, it won't
  touch your setup.

Update manually anytime with `make-fixer update`.

Environment variables:

```bash
MAKE_FIXER_UPDATE_INTERVAL=8   # hours between checks (default: 4)
MAKE_FIXER_NO_UPDATE=1         # disable the auto-update check entirely
```

## Configuration

Your API token is stored at `~/.make-fixer/.env`. No local `.env` file is needed.

```bash
# Custom base URL (default: https://eu1.make.com)
make-fixer login --token <token> --base-url https://us1.make.com
```

## License

MIT
