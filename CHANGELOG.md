# Changelog

All notable changes to burnwatch will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.13.2] - 2026-03-25

### Fixed

- **Flat fees now show full monthly cost**: Services on flat plans (Anthropic Max, Vercel Pro, Browserbase Startup, etc.) now display the full monthly plan cost instead of a prorated day-of-month estimate. Flat fees are already paid — prorating them understated the real expense. Usage-based plans continue to show prorated projections.
- **Plan matching disambiguation**: When multiple plans share a prefix (e.g., "Max ($100/mo)" vs "Max ($200/mo)"), burnwatch now disambiguates using the `--budget` hint or `$` amount in the plan name. Previously it always picked the first match.
- **Right border alignment in box rendering**: The status box now calculates visual width of emoji characters (✅, 🟡, 🔴, ⚠️, 🚨) correctly, so the right `║` border aligns consistently across all rows — including in non-terminal (agent/IDE) contexts where emoji widths differ.
- **Budgets default to plan costs**: Flat plan budgets now consistently default to `monthlyBase` across all configuration paths (CLI, auto-configure, probe auto-apply).

## [0.13.1] - 2026-03-25

### Fixed

- **OpenAI NaN spend / NaN% budget**: The OpenAI connector didn't guard against non-numeric `amount.value` responses. One NaN from OpenAI poisoned the entire brief total. Added type checking in the connector and a global NaN guard in `buildSnapshot()` — no single bad connector can ever corrupt the display again.
- **Excluded services still showing in status**: Stripe, AWS, and other excluded services appeared in `burnwatch status` with ~$0.00 CALC. Now filtered out before polling — excluded services never appear in the brief.
- **Anthropic shows BLIND despite having admin key stored**: The LIVE API call fails (endpoint/auth issue), and the CALC fallback requires `planCost` which was never set due to shell `$` variable expansion eating plan names like `"Max ($200/mo)"` → `"Max (/mo)"`. Three-part fix:
  1. **Shell-safe plan matching**: Configure command now strips `$` amounts before fuzzy matching, so `"Max (/mo)"` correctly matches `"Max ($200/mo)"`.
  2. **Registry plan fallback**: `pollService()` now resolves `planCost` from the registry plan's `monthlyBase` when `planCost` is missing but `planName` is set — so LIVE failures gracefully degrade to CALC instead of BLIND.
  3. **Prorated CALC spend on failure**: When LIVE fails and falls back to CALC, spend is now prorated to day-of-month instead of showing $0.
- **CALC services all showing $0 spend**: Flat-fee services (Vercel Pro, Browserbase Startup, etc.) had `planCost: 0` because the configure command's plan match failed silently. The shell-safe matching fix above prevents this for future configurations.

## [0.13.0] - 2026-03-25

### Added

- **Utilization Engine** — Code-derived cost projection system that tracks SDK call sites across the project, persists them to `.burnwatch/data/utilization.json`, and projects monthly utilization and overage costs. This is the forward-looking early warning system: it tells you what your code *will* cost before you ship it.
- **`burnwatch scan` command** — Full project scan for utilization patterns. Shows a table of services, call site counts, projected monthly units, plan inclusions, and overage costs. Use `--verbose` to see individual call sites per file.
- **Incremental utilization tracking in hooks** — The PostToolUse hook now updates the utilization model after every file change. Overage warnings are injected into Claude's context when projected overage exceeds $5/mo.
- **Utilization in session brief** — The SessionStart hook appends utilization data to the spend brief, showing projected usage alongside billing API data.
- **LIVE vs utilization divergence alerting** — For services with billing API data (LIVE tier), the utilization model runs silently unless projected cost exceeds current spend by >50% AND >$5 (both thresholds required to avoid noise).
- **Auto-scan on init** — `burnwatch init` now runs a full utilization scan after service detection. The utilization model is populated from day one.
- **Utilization in interview JSON** — `burnwatch interview --json` now includes a `utilization` field with projected monthly units, plan inclusions, overage costs, and top call sites per service. Enables agents to say "your code projects 1,060 sessions/month, 960 over your plan."
- **6 new `unitRate` values in registry** — Browserbase ($0.10/session), Resend ($0.001/email), Inngest ($0.01/fn run), SendGrid ($0.001/email), Replicate ($0.001/prediction). LLM services intentionally omitted (model variance too high for single rate).
- **22 new tests** (70 → 92): Model operations, overage math, divergence alerting, file analysis, brief formatting, round-trip persistence.

## [0.12.1] - 2026-03-25

### Fixed

- **`keysFoundInEnv` always 0 in interview JSON**: The env scanner in `burnwatch interview --json` used a fragile regex (`^KEY=(.+)$`) and hardcoded 3 file names. It failed on `export KEY=value` format, spaces around `=`, and missed `.env` files in subdirectories. Now uses the same recursive `findEnvFiles()` + `parseEnvKeys()` as the detector — proven to work since v0.1.0.
- **`autoConfigureServices` missed keys in `.env` files**: The `findEnvKey()` helper only checked `process.env`, which is empty in agent contexts. Now also scans `.env*` files on disk, finding keys the same way the detector does.

### Added

- **`parseEnvKeys()` utility**: Shared env file parser handles `export` prefix, quoted values, `\r\n` line endings, inline comments, and spaces around `=`. Used by both the detector and interview scanner.
- **10 new tests** (60 → 70): `parseEnvKeys` edge cases (7 tests), `findEnvFiles` behavior (2 tests), `detectInFileChange` with `export` prefix (1 test).

## [0.12.0] - 2026-03-25

### Added

- **10 new services in registry** (14 → 24): Firebase, Cloudflare, Neon Postgres, MongoDB Atlas, Twilio, SendGrid, Sentry, Clerk, DeepSeek, Replicate. All with plans, pricing, gotchas, detection patterns, and cost-impact SDK call patterns.
- **EST tier activated**: BLIND services with accumulated cost-impact data from file change analysis are now upgraded to EST tier in the spend brief. Uses the midpoint of projected cost range. The EST tier was defined since v0.1.0 but never produced — now it is.
- **Connector and probe tests**: 20 new tests with mocked HTTP covering all 6 billing connectors and 9 service probes. Total test count: 40 → 60.
- **Registry cache invalidation**: The registry cache now tracks file mtime and auto-invalidates when `registry.json` is modified. Prevents stale data in long-running processes (MCP server).
- **Community contribution guide**: Rewrote `CONTRIBUTING.md` with tiered contribution path — registry-only (5 min, JSON), billing connector (30 min, TypeScript), and probe (plan auto-detection). Documented `.burnwatch/registry.json` project-local override for custom services.

### Fixed

- **Registry `apiTier` reconciled with actual connectors**: `browserbase` changed from `"est"` to `"live"` (has a working connector). `stripe` changed from `"live"` to `"calc"` (no billing connector — only has a probe for balance checking, not Stripe's fees to you).
- **MCP server version**: Was hardcoded at `"0.1.2"` since initial release. Now reads dynamically from `package.json`.

### Changed

- Cost-impact SDK call patterns added for Firebase, Twilio, SendGrid, MongoDB, Clerk, and Replicate.

## [0.11.0] - 2026-03-25

### Fixed

- **CALC services showed ~$0.00 in session brief**: Session-start hook was passing raw `planCost` as spend instead of projecting based on day of month. Now correctly calculates `(planCost / daysInMonth) * dayOfMonth`.
- **envKeysFound always empty**: `.env` file scanning only ran conditionally. Now always scans `.env`, `.env.local`, `.env.development` on disk and populates `envKeysFound` regardless of global key status.
- **Box-drawing characters render poorly in agent/IDE contexts**: Added `formatBriefMarkdown()` using markdown tables. Session-start hook now uses markdown format.
- **Excluded services showing as BLIND in brief**: Added `filter(s => s.tier !== "excluded")` to brief display.
- **`configure --key` silent when LIVE not possible**: Now returns `tierNote` explaining why a key didn't enable LIVE tracking (e.g., no billing connector for that service).

### Added

- **`burnwatch reset` command**: Removes `.burnwatch/`, skills from `.claude/skills/`, and hooks from `.claude/settings.json`. Preserves global API keys in `~/.config/burnwatch/`.
- **Interview JSON enrichment**: `hasConnector`, `canGoLive`, `envKeysFound[]`, `suggestedAction`, and `instructions{}` fields guide agent behavior during the interview.

## [0.10.0] - 2026-03-25

### Added

- **Supabase billing connector**: Uses Management API via Personal Access Token (PAT). Detects plan tier (free/pro/team), maps to monthly cost, and checks usage endpoint for overages.
- **Browserbase billing connector**: Uses projects/usage API to track session count and browser minutes. Estimates spend from minutes × rate.

### Changed

- **Interview skill rewritten**: Complete rewrite of `/burnwatch-interview` SKILL.md. Now leads with API key discovery from `.env` files BEFORE asking questions. Enforces one-service-at-a-time pacing. Includes smart inference (e.g., `gpt-4o-mini` → low budget suggestion). Budget philosophy: LIVE → track actual + alert threshold; CALC → budget = plan cost; BLIND → safety net budget.
- **BLIND services no longer show $0.00**: Shows "—" instead of "$0.00" to avoid false confidence. Status label says "needs API key" instead of "no budget".
- **Brief footer says "No billing data: N"** instead of "Untracked: N" — because services ARE configured with budgets, they just lack billing API access.
- **`pollService` returns explicit error context** when LIVE fails instead of silently falling through to CALC/BLIND.

## [0.9.0] - 2026-03-25

### Added

- **Skill auto-installation during init**: `registerHooks()` now copies `/burnwatch-interview`, `/setup-burnwatch`, and `/spend` skills to `.claude/skills/` so agents can discover them.
- **Non-TTY init suggests `/burnwatch-interview`**: When running in an agent context, init output recommends the conversational interview skill instead of manual CLI commands.

### Changed

- **Terminology update**: All references to "vibe coding" changed to "AI-assisted development" across package description, README, llms.txt, and source files.

## [0.8.0] - 2026-03-25

### Added

- **Agent-driven interview** (`burnwatch interview --json`): Exports full project state as structured JSON — detected services, current plans, budgets, API key status, probe results, and available plan options. Designed for an AI agent to read, ask the user questions conversationally, and write answers back.
- **Agent configure command** (`burnwatch configure --service <id> [opts]`): Machine-friendly command for the agent to write back interview answers one service at a time. Supports `--plan` (fuzzy matches against registry), `--budget`, `--key`, and `--exclude`. Outputs JSON confirmation.
- **`/burnwatch-interview` skill**: Claude Code skill that orchestrates the conversational interview. The agent groups services by risk, leads with probe data, and asks natural questions instead of forcing a terminal readline flow.

### Changed

- **Interview bypasses readline entirely in agent context**: Instead of fighting non-TTY stdin, the agent IS the UI. `burnwatch init` still auto-configures with defaults, then `/burnwatch-interview` lets the user confirm/correct everything conversationally.

## [0.7.0] - 2026-03-25

### Added

- **Service probing system**: New extensible `probes.ts` module that auto-detects plan tiers, usage, and billing data from service APIs. Adding a new service probe is a single function — the system supports N services. Probes for 9 of 14 services:
  - **Scrapfly**: Plan name + credit usage (high confidence — skips plan selection)
  - **Vercel**: Plan tier from team/user API (high confidence)
  - **Supabase**: Plan tier from Management API (high confidence, requires PAT)
  - **Anthropic**: Current month USD spend from Admin API cost report (medium — shows spend, still asks plan)
  - **OpenAI**: Token usage from Admin API (medium)
  - **Stripe**: Balance and processing volume (medium)
  - **Browserbase**: Session count and browser hours (medium)
  - **Upstash**: Database discovery (low — validates key)
  - **PostHog**: Organization discovery (low — validates key)
- **Tiered discovery in interview**: Init now follows API → key → ask → hedge:
  1. Find API key (env vars, global config)
  2. If key found + probe exists → hit the API, show what we found
  3. High confidence → "Detected: Pro ($100/mo, 1M credits). Correct? [Y/n]"
  4. Medium confidence → show usage data, then ask plan
  5. No key → show plan list, ask for key after
  6. Budget always set
- **Auto-configure probing**: Non-TTY mode (Claude Code) also probes APIs when keys are available, auto-matching detected plans instead of always using defaults.

### Changed

- **Interview no longer requires `autoDetectPlan` in registry**: Any service with a probe in `PROBES` map is automatically probed when a key is available. Adding a service-specific probe is the only requirement.
- **Key detection runs before plan selection for all services**: Previously only LIVE-tier services checked for keys. Now any service with a probe gets key detection first.

## [0.6.0] - 2026-03-24

### Added

- **Allowance tracking for credit-pool services**: Services like Scrapfly that sell a fixed credit pool (e.g., Pro $100/mo = 1M credits) now track unit consumption against the plan allowance, not just dollar spend. The brief shows `↳ 850K/1M credits (85%) ⚠️` alongside the dollar line. This is the distinction between "budget" (what you pay) and "spend metric" (what you consume).
- **Allowance data in spend snapshots**: `SpendSnapshot.allowance` provides `used`, `included`, `unitName`, and `percent` for credit-pool services with LIVE connectors.
- **PlanTier `includedUnits` and `unitName`**: Registry plans can now declare how many units are included (e.g., `"includedUnits": 1000000, "unitName": "credits"`). Init automatically sets `TrackedService.allowance` from plan selection.

### Changed

- **Scrapfly registry updated to real pricing**: Discovery $30/200K, Pro $100/1M (default), Startup $250/2.5M, Enterprise $500/5.5M. Previously had incorrect plan names and prices.
- **Scrapfly connector returns unit data**: `BillingResult` now includes `unitsUsed`, `unitsTotal`, and `unitName` so the brief can show credit consumption alongside dollar spend.
- **Allowance-aware status labels**: Credit-pool services show "750K credits left" or "⚠️ 125% of 1M credits used" instead of generic budget percentages.

## [0.5.2] - 2026-03-24

### Changed

- **Zero manual commands after init**: Every detected service is now fully configured during init - plan, tier, and budget. No wall of `burnwatch add` commands. Registry now includes `suggestedBudget` for all usage-based plans (Anthropic $100, OpenAI $100, Stripe $50, Google Gemini $50, Voyage AI $20, AWS $50). Flat-rate services get budget = plan cost. Free tiers get $0.
- **Interactive interview uses suggested budgets as defaults**: Usage plans show `Monthly budget [$100]: $` instead of a blank prompt. Press Enter to accept.

## [0.5.1] - 2026-03-24

### Fixed

- **Init actually works now**: `process.stdin.isTTY` was `undefined` in Claude Code and many terminal environments, so the interactive interview never ran. Init now has three modes: (1) TTY detected = full interactive interview, (2) no TTY = smart auto-configure with defaults, (3) `--non-interactive` = minimal CI mode.

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

[0.12.1]: https://github.com/RaleighSF/burnwatch/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/RaleighSF/burnwatch/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/RaleighSF/burnwatch/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/RaleighSF/burnwatch/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/RaleighSF/burnwatch/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/RaleighSF/burnwatch/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/RaleighSF/burnwatch/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/RaleighSF/burnwatch/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/RaleighSF/burnwatch/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/RaleighSF/burnwatch/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/RaleighSF/burnwatch/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/RaleighSF/burnwatch/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/RaleighSF/burnwatch/compare/v0.4.0...v0.4.2
[0.4.0]: https://github.com/RaleighSF/burnwatch/compare/v0.1.0...v0.4.0
[0.1.0]: https://github.com/RaleighSF/burnwatch/releases/tag/v0.1.0
