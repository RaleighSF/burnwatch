# burnwatch

**Passive cost memory for vibe coding.**

burnwatch detects every paid service in your project, tracks what you're spending, and injects budget context directly into your AI coding sessions — so the agent knows what things cost before it recommends burning more money.

```
╔══════════════════════════════════════════════════════════════╗
║  BURNWATCH — hullscore-app — March 2026                      ║
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

This brief appears automatically at the start of every Claude Code session. You don't open a dashboard. You don't remember to check anything. You just see what you're spending.

---

## Why

Agentic development lets you ship 10x faster. It also lets you burn through $400 in Scrapfly credits, rack up unexpected Browserbase bills, and discover PostHog overages three weeks after the code that caused them was written — by an agent, in a session you barely remember.

**78% of IT leaders experienced unexpected charges** tied to consumption-based or AI pricing in the past 12 months ([Zylo 2026 SaaS Management Index](https://zylo.com/research/saas-management-index/)).

Existing tools either cover one service (ccusage tracks Claude tokens), require enterprise pricing (CloudZero, Vantage), or demand you already know what you're spending on. Nobody watches how services enter your stack and tracks them from the moment of introduction.

burnwatch does.

---

## Install

```bash
# In any project
npx burnwatch init
```

That's it. burnwatch scans your project, detects paid services, creates a `.burnwatch/` directory, and registers Claude Code hooks. Next time you start a session, you see your spend.

---

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
     Detected via: package.json: @anthropic-ai/sdk, env vars: ANTHROPIC_API_KEY
   • Vercel (✅ LIVE API available)
     Detected via: package.json: @vercel/analytics, @vercel/functions
   • Scrapfly (✅ LIVE API available)
     Detected via: env vars: SCRAPFLY_KEY
   • Supabase (✅ LIVE API available)
     Detected via: package.json: @supabase/supabase-js
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

API keys are stored in `~/.config/burnwatch/` (global, chmod 600). They never touch your project directory. They never end up in git.

### 3. Check your spend

```bash
burnwatch status
```

```
📊 Polling services...

╔══════════════════════════════════════════════════════════════╗
║  BURNWATCH — hullscore-app — March 2026                      ║
╠══════════════════════════════════════════════════════════════╣
║  Service        Spend       Conf    Budget  Left             ║
║  ──────────────────────────────────────────────────────────  ║
║  Anthropic      $47.20      ✅ LIVE  $100    53%             ║
║  Scrapfly       $127.00     ✅ LIVE  $50     ⚠️ OVR          ║
║  Vercel         $23.00      ✅ LIVE  $50     54%             ║
║  Supabase       $25.00      ✅ LIVE  $100    75%             ║
║  PostHog        ~$12.50     🟡 CALC  $49     flat — on plan  ║
║  Browserbase    ~$63.00     🟠 EST   $75     16% — caution   ║
╠══════════════════════════════════════════════════════════════╣
║  TOTAL: ~$297.70   Untracked: 0 ✅   Est margin: ±$11       ║
║  🚨  SCRAPFLY 254% OVER BUDGET — review before use          ║
╚══════════════════════════════════════════════════════════════╝
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

Claude now factors this into its response. It might suggest using Cheerio instead, or warn you about the cost before proceeding.

When a new paid service enters your project (new dependency, new env var, new import), burnwatch alerts immediately:

```
[BURNWATCH] 🆕 New paid service detected: resend
  Run 'burnwatch add resend' to configure budget and tracking.
```

---

## How It Works

burnwatch runs as Claude Code hooks — background scripts that fire on session events. It never proxies your traffic. It never intercepts API calls. It watches the exhaust of your sessions the same way a court reporter watches a deposition: silently, completely, and without interrupting the work.

### Four Detection Surfaces

| Surface | What it catches | When it runs |
|---------|----------------|-------------|
| **Package manifest** | `@anthropic-ai/sdk` in dependencies | `init`, `reconcile`, file change |
| **Environment variables** | `SCRAPFLY_KEY` in process.env | Every session start |
| **Import statements** | `import { Resend } from "resend"` | `init`, file change |
| **Prompt mentions** | "use Browserbase to..." | Every prompt |

### Confidence Badges

Every spend figure carries an honest confidence badge:

| Badge | Meaning | How it works |
|-------|---------|-------------|
| ✅ **LIVE** | Real billing API data | Polls service API with your key |
| 🟡 **CALC** | Fixed monthly cost | You tell burnwatch your plan cost, it projects daily burn |
| 🟠 **EST** | Instrumented estimate | Usage signals + pricing formula from registry |
| 🔴 **BLIND** | Detected, not tracked | Service is in your project but no key or cost configured |

If burnwatch can't track a service accurately, it says so. The ledger always shows untracked count. You never get a clean dashboard hiding a surprise bill.

### Three Outputs

1. **Session brief** — injected at every session start. Full spend table, alerts, untracked count.
2. **Spend cards** — injected when you mention a tracked service. Current spend, budget status, confidence.
3. **New service alerts** — injected when a file change introduces a paid service you haven't configured.

### The Ledger

burnwatch writes `.burnwatch/spend-ledger.md` at the end of every session — human-readable, git-committable, designed to be read in 10 seconds:

```markdown
# Burnwatch Ledger — hullscore-app
Last updated: 2026-03-24T14:32:11Z

## This Month (March 2026)
| Service | Spend | Conf | Budget | Status |
|---------|-------|------|--------|--------|
| Anthropic | $47.20 | ✅ LIVE | $100 | 53% — healthy |
| Scrapfly | $127.00 | ✅ LIVE | $50 | ⚠️ 254% over |
| Vercel | $23.00 | ✅ LIVE | $50 | 54% — healthy |
| PostHog | ~$12.50 | 🟡 CALC | $49 | flat — on plan |

## TOTAL: ~$209.70 (±$2 estimated margin)
## Untracked services: 0
```

---

## Supported Services (v0.1)

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

**Adding a new service?** Edit `registry.json` and open a PR. No release cycle required.

---

## Config Model

burnwatch uses a hybrid config model. Sensitive credentials never live in your project directory.

```
~/.config/burnwatch/
  config.json          ← API keys, tokens (chmod 600, never in git)

your-project/.burnwatch/
  config.json          ← Tracked services, budgets, detection history
  spend-ledger.md      ← Human-readable spend report (git-committable)
  .gitignore           ← Ignores cache/snapshots, keeps ledger and config
  data/
    events.jsonl       ← Append-only event log
    cache/             ← Billing API response cache
    snapshots/         ← Point-in-time spend snapshots (for delta computation)
```

---

## CLI Reference

```bash
burnwatch init                              # Initialize in current project
burnwatch add <service> [options]           # Register a service
burnwatch status                            # Show current spend brief
burnwatch services                          # List all services in registry
burnwatch reconcile                         # Scan for untracked services
burnwatch help                              # Show help
burnwatch version                           # Show version
```

### `burnwatch add` options

```bash
--key <API_KEY>        # API key for LIVE tracking
--token <TOKEN>        # Alias for --key
--budget <AMOUNT>      # Monthly budget in USD
--plan-cost <AMOUNT>   # Monthly plan cost (for CALC tracking)
```

---

## How the Agent Changes Behavior

The real power isn't showing you what you spent — it's telling the agent what everything costs, in context, so cost becomes a factor in every recommendation.

When Claude sees `Scrapfly: $127 / $50 budget, 254% over` in its context, it:

- Suggests free alternatives (Cheerio, Playwright) before reaching for Scrapfly
- Warns before generating code that would make more Scrapfly API calls
- Factors cost into architecture decisions ("this approach would require ~200 more scrape calls")
- Acknowledges the budget constraint without you having to mention it

This feedback loop doesn't exist anywhere else today. The agent has cost memory.

---

## Reconciliation (Sessions Without burnwatch)

burnwatch doesn't need to be running in every session. It takes snapshots when it runs and computes deltas between them.

```bash
burnwatch reconcile
```

This re-scans your project for services that may have been introduced in sessions where burnwatch wasn't active (via git diffs, new packages, new env vars). Services get flagged and added to tracking.

For billing APIs that expose cumulative usage (like Scrapfly's credit counter), burnwatch computes the delta between its last snapshot and the current state — attributing spend across the gap even if it wasn't present for those sessions.

---

## The Registry

`registry.json` is the community knowledge base. Each service entry includes:

```json
{
  "scrapfly": {
    "id": "scrapfly",
    "name": "Scrapfly",
    "packageNames": ["scrapfly-sdk", "scrapfly"],
    "envPatterns": ["SCRAPFLY_KEY", "SCRAPFLY_API_KEY"],
    "importPatterns": ["scrapfly"],
    "mentionKeywords": ["scrapfly"],
    "billingModel": "credit_pool",
    "scalingShape": "linear_burndown",
    "apiTier": "live",
    "pricing": {
      "formula": "credits_used * credit_usd_rate",
      "unitRate": 0.00015,
      "unitName": "credit"
    },
    "gotchas": [
      "Anti-bot bypass options consume 5-25x base credits per request"
    ],
    "alternatives": ["cheerio", "playwright", "firecrawl"],
    "docsUrl": "https://scrapfly.io/docs/scrape-api/billing",
    "lastVerified": "2026-03-24"
  }
}
```

The `gotchas`, `alternatives`, and `scalingShape` fields aren't just metadata — the agent reads them and uses them to make better recommendations. Every PR that adds a service makes burnwatch smarter for every user.

---

## Requirements

- Node.js 18+
- Claude Code (for hooks integration)
- Works without Claude Code too — `burnwatch status` is a standalone CLI

---

## License

MIT
