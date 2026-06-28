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
| `update` | Update make-fixer to the latest version |

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
