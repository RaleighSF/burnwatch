# CLAUDE.md — burnwatch

## What This Is
burnwatch is a passive cost-awareness layer for agentic development. It detects paid services as they enter a project, tracks spend across AI-native tools, and injects budget context into Claude Code sessions so the agent can factor cost into its decisions.

## Architecture
- **src/core/** — Types, config management, registry loader, brief formatter, ledger writer
- **src/detection/** — Four-surface service detection (package.json, env vars, imports, prompt mentions)
- **src/services/** — Billing API connectors for LIVE-tier services (Anthropic, OpenAI, Vercel, Scrapfly)
- **src/hooks/** — Claude Code hook scripts (SessionStart, UserPromptSubmit, PostToolUse, Stop)
- **src/cli.ts** — CLI commands (init, add, status, services, reconcile)
- **registry.json** — Community-maintained service definitions (14 services)

## Key Design Decisions
- **Hybrid config model**: API keys in `~/.config/burnwatch/` (global, chmod 600), budgets/ledger in `.burnwatch/` (project-local, git-committable)
- **Confidence badges**: Every spend figure has a tier — LIVE (real API), CALC (flat-rate), EST (estimated), BLIND (detected, untracked). Never show false confidence.
- **Cache-first hooks**: SessionStart serves cached brief instantly, then refreshes async in background. No latency penalty.
- **No proxy**: burnwatch never intercepts API calls. It polls billing APIs and scans project files. Passive observation only.

## Commands
```bash
npm run build    # Build with tsup
npm run test     # Run vitest
npm run lint     # Type-check with tsc
npm run dev      # Build in watch mode
```

## Testing
```bash
npx vitest run           # All tests
npx vitest run detection # Detection tests only
npx vitest run brief     # Brief formatting tests only
```

## Adding a New Service to the Registry
Edit `registry.json` and add a new entry following the existing schema. Required fields:
- `id`, `name`, `packageNames`, `envPatterns`, `importPatterns`, `mentionKeywords`
- `billingModel`, `scalingShape`, `apiTier`
- `pricing` (at minimum a `formula` string)

## Convention
- All source in TypeScript, strict mode
- ESM only (`"type": "module"`)
- No external runtime dependencies — Node 18+ built-ins only
- Hooks must exit fast (< 5s for prompt/file hooks, < 15s for session hooks)
