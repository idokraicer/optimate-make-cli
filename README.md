# optimate-make-cli

A CLI tool to fetch, analyze, edit, build, and push [Make.com](https://make.com) scenario blueprints.

## Quick Install

Requires [Bun](https://bun.sh) runtime.

```bash
# Install globally
bun install -g git+https://github.com/idokraicer/optimate-make-cli.git

# Authenticate with your Make.com API token
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

## Configuration

Your API token is stored at `~/.make-fixer/.env`. No local `.env` file is needed.

```bash
# Custom base URL (default: https://eu1.make.com)
make-fixer login --token <token> --base-url https://us1.make.com
```

## License

MIT
