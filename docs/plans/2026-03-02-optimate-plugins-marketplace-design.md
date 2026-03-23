# Optimate Plugins — Claude Code Marketplace

**Date:** 2026-03-02
**Status:** Approved

## Goal

Create a GitHub-hosted plugin marketplace at `idokraicer/optimate-plugins` to distribute the make-fixer skill as a Claude Code plugin. The marketplace can later host additional plugins.

## Marketplace Structure

```
optimate-plugins/
├── .claude-plugin/
│   └── marketplace.json
├── plugins/
│   └── make-fixer/
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── skills/
│       │   └── make-fixer/
│       │       ├── SKILL.md
│       │       ├── BEST_PRACTICES.md
│       │       └── FUNCTIONS_REFERENCE.md
│       └── README.md
└── README.md
```

## Key Files

### marketplace.json
- Name: `optimate-plugins`
- Owner: Ido Kraicer
- Plugin: make-fixer with relative path source

### plugin.json
- Name: `make-fixer`
- Version: `1.0.0`
- Description: Edit and build Make.com scenario blueprints
- Keywords: make.com, automation, scenarios, blueprints
- License: MIT

## Installation

```
/plugin marketplace add idokraicer/optimate-plugins
/plugin install make-fixer@optimate-plugins
```

## Implementation Steps

1. Create GitHub repo `idokraicer/optimate-plugins`
2. Set up directory structure
3. Create marketplace.json and plugin.json
4. Copy skill files (SKILL.md, BEST_PRACTICES.md, FUNCTIONS_REFERENCE.md)
5. Write README.md files
6. Push and test locally with `--plugin-dir`
7. Test with `/plugin marketplace add`
