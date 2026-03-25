# Changelog

All notable changes to burnwatch will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/RaleighSF/burnwatch/releases/tag/v0.1.0
