# Changelog

All notable changes to burnwatch will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-03-24

### Changed

- **Interactive init rewritten as proper interview**: Each service gets a structured conversation - plan selection, API key collection with hints on where to find them, and budget. Budgets are never skipped - pressing Enter applies the plan cost (or $0 for free tiers) instead of leaving budget undefined. Summary table at the end shows total monthly budget across all services.
- **Env var auto-detection for API keys**: Init checks `process.env` for known key patterns (e.g., `ANTHROPIC_ADMIN_KEY`, `SCRAPFLY_KEY`) and auto-imports them to global config. No need to re-enter keys that are already in your environment.
- **API key prompts for all LIVE services**: Previously only fired when the chosen plan had `requiresKey: true`. Now any LIVE-capable service gets the key prompt regardless of plan, with a hint about where to find the key (e.g., "Admin key: console.anthropic.com -> Settings -> Admin API Keys").
- **Non-interactive init always sets budget**: Every service gets `budget: 0` at minimum (flat-rate services get budget = plan cost). No more undefined budgets showing as "-" in status output.
- **Non-interactive env var key detection**: Checks environment for API keys matching service patterns, auto-saves to global config for LIVE tracking.

### Fixed

- **13/14 services had no budget after init**: Root cause was budget prompt saying "press Enter to skip". Now pressing Enter applies the default budget instead of skipping.
- **Untracked message was circular**: Changed "run burnwatch status" to "run burnwatch init to configure".

## [0.4.2] - 2026-03-24

### Fixed

- **Init is re-runnable**: `burnwatch init` no longer early-returns on already-initialized projects. Re-running init re-detects services and walks through interactive setup again.
- **Budget prompt fires for all services**: Budget prompt was gated inside the `requiresKey` block - now every non-excluded service gets a budget prompt during interactive init.
- **Untracked message fix**: Same as 0.4.3 (first shipped here).

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

[0.5.0]: https://github.com/RaleighSF/burnwatch/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/RaleighSF/burnwatch/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/RaleighSF/burnwatch/compare/v0.4.0...v0.4.2
[0.4.0]: https://github.com/RaleighSF/burnwatch/compare/v0.1.0...v0.4.0
[0.1.0]: https://github.com/RaleighSF/burnwatch/releases/tag/v0.1.0
