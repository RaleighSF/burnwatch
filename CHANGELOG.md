# Changelog

All notable changes to burnwatch will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-03-24

### Added

- **Interactive init with plan tiers**: `burnwatch init` now walks through each detected service interactively, grouped by cost risk (LLMs first, then usage-based, infra, flat-rate). Users pick from known plan tiers per service (e.g., Anthropic API Usage, Max $100/mo, Pro $20/mo, or "Don't track").
- **Plan tiers for all 14 services**: Registry now includes plan options for Anthropic, OpenAI, Google Gemini, Voyage AI, Vercel, Supabase, Stripe, Scrapfly, Browserbase, Upstash, Resend, Inngest, PostHog, and AWS.
- **Smart defaults**: Each service has a recommended default plan. Flat plans auto-set the budget to the plan cost. API Usage plans prompt for keys and budgets.
- **Exclude option**: "Don't track for this project" explicitly excludes a service (shows as "excluded", not BLIND).
- **Auto-detect plan**: Scrapfly plan can be auto-detected from API key via the /account endpoint.
- **Non-interactive fallback**: `burnwatch init --non-interactive` preserves the original auto-detect behavior for CI/scripted use.
- **Predictive cost impact analysis**: PostToolUse hook now analyzes file writes for SDK call sites, detects multipliers (loops, .map(), Promise.all, cron schedules, batch sizes), and projects monthly cost ranges using registry pricing data and gotcha-based multipliers.
- **Cost impact cards**: When a file write contains tracked service SDK calls, a cost impact card is injected into Claude's context with estimated monthly cost, current budget status, and cheaper alternatives.
- **Cumulative session cost tracking**: Session cost impacts are accumulated across file changes and reported in the Stop hook.
- **Projected impact in ledger**: The spend ledger now includes a "projected impact" row showing session cost estimates.
- **New `excluded` confidence tier**: Services explicitly excluded by the user show ⬚ SKIP instead of 🔴 BLIND.

### Changed

- Registry version bumped to 0.2.0 with plan tier data.
- CLI now parses `--non-interactive` and `--ni` flags.
- PostToolUse hook expanded from detection-only to detection + cost impact analysis.
- Stop hook now reads and reports cumulative session cost impacts.

## [0.1.0] - 2026-03-24

### Added

- Four-surface service detection: package.json, environment variables, import statements, prompt mentions
- 14-service registry: Anthropic, OpenAI, Vercel, Supabase, Stripe, Scrapfly, Browserbase, Upstash, Resend, Inngest, PostHog, Google Gemini, Voyage AI, AWS
- Confidence badges: LIVE (real API data), CALC (flat-rate), EST (estimated), BLIND (detected only)
- Claude Code hooks: SessionStart (spend brief), UserPromptSubmit (spend cards), PostToolUse (new service alerts), Stop (ledger update)
- CLI commands: `init`, `setup`, `add`, `status`, `services`, `reconcile`
- Billing API connectors for Anthropic, OpenAI, Vercel, and Scrapfly
- Hybrid config model: API keys in `~/.config/burnwatch/` (global), budgets in `.burnwatch/` (project)
- Markdown ledger: human-readable, git-committable spend report
- Snapshot system for delta computation across sessions
- Claude Code skills: `/spend` (on-demand brief), `/setup-burnwatch` (guided onboarding)

[0.4.0]: https://github.com/RaleighSF/burnwatch/compare/v0.1.0...v0.4.0
[0.1.0]: https://github.com/RaleighSF/burnwatch/releases/tag/v0.1.0
