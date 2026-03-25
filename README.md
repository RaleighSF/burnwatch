<p align="center">
  <h1 align="center">burnwatch</h1>
  <p align="center">Passive cost memory for vibe coding.</p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/burnwatch"><img src="https://img.shields.io/npm/v/burnwatch.svg?style=flat&colorA=18181B&colorB=28CF8D" alt="Version"></a>
  <a href="https://www.npmjs.com/package/burnwatch"><img src="https://img.shields.io/npm/dm/burnwatch.svg?style=flat&colorA=18181B&colorB=28CF8D" alt="Downloads"></a>
  <a href="https://github.com/RaleighSF/burnwatch/blob/main/LICENSE"><img src="https://img.shields.io/github/license/RaleighSF/burnwatch?style=flat&colorA=18181B&colorB=28CF8D" alt="License"></a>
  <a href="https://github.com/RaleighSF/burnwatch"><img src="https://img.shields.io/badge/dependencies-0-28CF8D?style=flat&colorA=18181B" alt="Zero Dependencies"></a>
</p>

<br>

burnwatch detects every paid service in your project, tracks what you're spending, and injects budget context directly into your AI coding sessions — so the agent knows what things cost before it recommends burning more money.

```
╔══════════════════════════════════════════════════════════════╗
║  BURNWATCH — hullscore — March 2026                          ║
╠══════════════════════════════════════════════════════════════╣
║  Service        Spend       Conf    Budget  Left             ║
║  ──────────────────────────────────────────────────────────  ║
║  Anthropic      $47.20      ✅ LIVE  $100    53%             ║
║  Vercel         $23.00      ✅ LIVE  $50     54%             ║
║  Scrapfly       $127.00     ✅ LIVE  $50     ⚠️ OVR          ║
║  Browserbase    ~$63.00     🟠 EST   $75     16%             ║
║  Supabase       $25.00      ✅ LIVE  $100    75%             ║
║  PostHog        ~$49.00     🟡 CALC  $49     0%              ║
╠══════════════════════════════════════════════════════════════╣
║  TOTAL: ~$334.20   Untracked: 0 ✅   Est margin: ±$20       ║
║  🚨  SCRAPFLY 254% OVER BUDGET — review before use          ║
╚══════════════════════════════════════════════════════════════╝
```

This brief appears automatically at the start of every [Claude Code](https://claude.ai/code) session. You don't open a dashboard. You don't remember to check anything. You just see what you're spending.

<br>

## Why

Agentic development lets you ship 10x faster. It also lets you burn through $400 in Scrapfly credits, rack up unexpected Browserbase bills, and discover PostHog overages three weeks after the code that caused them was written — by an agent, in a session you barely remember.

**78% of IT leaders experienced unexpected charges** tied to consumption-based or AI pricing in the past 12 months ([Zylo 2026 SaaS Management Index](https://zylo.com/research/saas-management-index/)).

Existing tools either cover one service (ccusage tracks Claude tokens), require enterprise pricing (CloudZero, Vantage), or demand you already know what you're spending on. Nobody watches how services enter your stack and tracks them from the moment of introduction.

burnwatch does.

<br>

## Install

```bash
npx burnwatch init
```

That's it. burnwatch scans your project, detects paid services, creates a `.burnwatch/` directory, and registers Claude Code hooks. Next time you start a session, you see your spend.

> **Requirements:** Node.js 18+ &mdash; Zero dependencies &mdash; Works with or without Claude Code

<br>

## Quick Start

### 1. Initialize

```bash
cd your-project
npx burnwatch init
```

```
🔍 Scanning project for paid services...

   Found 11 paid services:

   • Anthropic (Claude) (✅ LIVE API available)
     Detected via: package.json, env vars, imports
   • Vercel (✅ LIVE API available)
     Detected via: package.json
   • Scrapfly (✅ LIVE API available)
     Detected via: env vars
   • Supabase (✅ LIVE API available)
     Detected via: package.json, imports
   ...

🔗 Registering Claude Code hooks...
✅ burnwatch initialized!
```

### 2. Add API keys and budgets

```bash
# LIVE tracking — real billing API data
burnwatch add anthropic --key $ANTHROPIC_ADMIN_KEY --budget 100
burnwatch add scrapfly --key $SCRAPFLY_KEY --budget 50
burnwatch add vercel --token $VERCEL_TOKEN --budget 50

# CALC tracking — flat-rate services
burnwatch add posthog --plan-cost 0 --budget 0
burnwatch add inngest --plan-cost 25 --budget 25

# Just set a budget (tracking stays at detected tier)
burnwatch add browserbase --budget 75
```

API keys are stored in `~/.config/burnwatch/` (global, `chmod 600`). They **never** touch your project directory. They never end up in git.

### 3. Check your spend

```bash
burnwatch status
```

### 4. Start coding

Start a Claude Code session. The spend brief appears automatically. When you mention a tracked service in a prompt, a spend card is injected:

```
You: "Use Scrapfly to scrape the competitor pricing pages"

[BURNWATCH] scrapfly — current period
  Spend: $127.00  |  Budget: $50  |  ⚠️ 254% over
  Confidence: ✅ LIVE
  ⚠️ 254% of budget consumed
```

Claude factors this into its response — it might suggest Cheerio instead, or warn you before proceeding.

When a new paid service enters your project (new dependency, new env var, new import), burnwatch alerts immediately:

```
[BURNWATCH] 🆕 New paid service detected: resend
  Run 'burnwatch add resend' to configure budget and tracking.
```

<br>

## How It Works

burnwatch runs as [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) — background scripts that fire on session lifecycle events. It never proxies your traffic. It never intercepts API calls. It watches the exhaust of your sessions silently, completely, and without interrupting the work.

### Four Detection Surfaces

| Surface | What it catches | When |
|---------|----------------|------|
| **Package manifest** | `@anthropic-ai/sdk` in dependencies | `init`, `reconcile`, file change |
| **Environment variables** | `SCRAPFLY_KEY` in process.env | Every session start |
| **Import statements** | `import { Resend } from "resend"` | `init`, file change |
| **Prompt mentions** | "use Browserbase to..." | Every prompt |

### Confidence Badges

Every spend figure carries an honest confidence badge:

| Badge | Meaning | Source |
|-------|---------|--------|
| ✅ **LIVE** | Real billing API data | Polls service API with your key |
| 🟡 **CALC** | Fixed monthly cost | You enter your plan cost; burnwatch projects daily burn |
| 🟠 **EST** | Instrumented estimate | Usage signals + pricing formula from registry |
| 🔴 **BLIND** | Detected, not tracked | Service is in your project but no key or cost configured |

If burnwatch can't track a service accurately, it says so. The ledger always shows the untracked count. You never get a clean dashboard hiding a surprise bill.

### Three Outputs

| Output | Trigger | What it does |
|--------|---------|-------------|
| **Session brief** | Every session start | Full spend table with alerts and untracked count |
| **Spend cards** | Service mentioned in prompt | Current spend, budget status, confidence for that service |
| **New service alerts** | File change introduces a paid service | Flags it immediately, prompts you to configure |

### The Ledger

burnwatch writes `.burnwatch/spend-ledger.md` at the end of every session — human-readable, git-committable, designed to be read in 10 seconds:

```markdown
# Burnwatch Ledger — hullscore
Last updated: 2026-03-24T14:32:11Z

## This Month (March 2026)
| Service | Spend | Conf | Budget | Status |
|---------|-------|------|--------|--------|
| Anthropic | $47.20 | ✅ LIVE | $100 | 53% — healthy |
| Scrapfly | $127.00 | ✅ LIVE | $50 | ⚠️ 254% over |
| Vercel | $23.00 | ✅ LIVE | $50 | 54% — healthy |

## TOTAL: ~$209.70 (±$2 estimated margin)
## Untracked services: 0
```

<br>

## Supported Services

14 services out of the box. [Add more via PR](#contributing).

| Service | Tier | Billing Model | Notes |
|---------|------|--------------|-------|
| Anthropic | ✅ LIVE | Per-token | Requires admin API key |
| OpenAI | ✅ LIVE | Per-token | Requires org API key |
| Vercel | ✅ LIVE | Compute + overages | Requires Vercel token |
| Scrapfly | ✅ LIVE | Credit pool | Standard API key works |
| Stripe | ✅ LIVE | % of transaction | Tracks processing fees |
| Supabase | ✅ LIVE | Tiered + overages | Management API |
| Browserbase | 🟠 EST | Per-session | Estimated from usage |
| Upstash | 🟠 EST | Per-command | Estimated from usage |
| Resend | 🟠 EST | Per-email | Estimated from sends |
| Inngest | 🟡 CALC | Tiered | User-entered plan cost |
| PostHog | 🟡 CALC | Tiered | User-entered plan cost |
| Google Gemini | 🟡 CALC | Per-token | User-entered budget |
| Voyage AI | 🟡 CALC | Per-token | User-entered budget |
| AWS | 🔴 BLIND | Varies | Detected, complex billing |

<br>

## How the Agent Changes Behavior

The real power isn't showing _you_ what you spent — it's telling _the agent_ what everything costs, in context, so cost becomes a factor in every recommendation.

When Claude sees `Scrapfly: $127 / $50 budget, 254% over` in its context, it:

- Suggests free alternatives (Cheerio, Playwright) before reaching for Scrapfly
- Warns before generating code that would make more API calls
- Factors cost into architecture decisions
- Acknowledges budget constraints without you having to mention them

This feedback loop doesn't exist anywhere else today. The agent has cost memory.

<br>

## CLI Reference

```
burnwatch init                              Initialize in current project
burnwatch setup                             Init + auto-configure all detected services
burnwatch add <service> [options]           Register a service for tracking
burnwatch status                            Show current spend brief
burnwatch services                          List all services in registry
burnwatch reconcile                         Scan for untracked services
burnwatch help                              Show help
burnwatch version                           Show version
```

### `burnwatch add` options

| Flag | Description |
|------|-------------|
| `--key <KEY>` | API key for LIVE tracking (saved to `~/.config/burnwatch/`) |
| `--token <TOKEN>` | Alias for `--key` |
| `--budget <N>` | Monthly budget in USD |
| `--plan-cost <N>` | Monthly plan cost for CALC tracking |

<br>

## Config Model

Sensitive credentials never live in your project directory.

```
~/.config/burnwatch/
  config.json              API keys, tokens (chmod 600, never in git)

your-project/.burnwatch/
  config.json              Tracked services, budgets, detection history
  spend-ledger.md          Human-readable spend report (git-committable)
  .gitignore               Ignores cache/snapshots, keeps ledger and config
  data/
    events.jsonl           Append-only event log
    cache/                 Billing API response cache
    snapshots/             Point-in-time spend snapshots
```

<br>

## Reconciliation

burnwatch doesn't need to run in every session. It takes snapshots when present and computes deltas between them.

```bash
burnwatch reconcile
```

Re-scans your project for services introduced in sessions where burnwatch wasn't active. For billing APIs that expose cumulative usage (like Scrapfly's credit counter), it computes the delta between snapshots — attributing spend across the gap.

<br>

## The Registry

`registry.json` is the community knowledge base. Each service entry includes detection patterns, pricing formulas, gotchas, and alternatives:

```json
{
  "scrapfly": {
    "packageNames": ["scrapfly-sdk"],
    "envPatterns": ["SCRAPFLY_KEY"],
    "billingModel": "credit_pool",
    "scalingShape": "linear_burndown",
    "apiTier": "live",
    "pricing": { "unitRate": 0.00015, "unitName": "credit" },
    "gotchas": ["Anti-bot bypass consumes 5-25x base credits"],
    "alternatives": ["cheerio", "playwright", "firecrawl"]
  }
}
```

The `gotchas` and `alternatives` fields aren't just metadata — the agent reads them and uses them to make better recommendations. Every PR that adds a service makes burnwatch smarter for every user.

<br>

## Contributing

Contributions are welcome. The easiest way to contribute is adding a new service to `registry.json`:

1. Fork the repo
2. Add your service entry to `registry.json` following the existing schema
3. Include: `packageNames`, `envPatterns`, `billingModel`, `apiTier`, `pricing`, and ideally `gotchas` + `alternatives`
4. Open a PR

See [CONTRIBUTING.md](CONTRIBUTING.md) for full guidelines.

<br>

## License

[MIT](LICENSE)
