<p align="center">
  <h1 align="center">burnwatch</h1>
  <p align="center"><strong>You're coding 10x. You might also be spending 10x.</strong></p>
  <p align="center">Passive cost memory for AI-assisted development.</p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/burnwatch"><img src="https://img.shields.io/npm/v/burnwatch.svg?style=flat&colorA=18181B&colorB=28CF8D" alt="Version"></a>
  <a href="https://www.npmjs.com/package/burnwatch"><img src="https://img.shields.io/npm/dm/burnwatch.svg?style=flat&colorA=18181B&colorB=28CF8D" alt="Downloads"></a>
  <a href="https://github.com/RaleighSF/burnwatch/blob/main/LICENSE"><img src="https://img.shields.io/github/license/RaleighSF/burnwatch?style=flat&colorA=18181B&colorB=28CF8D" alt="License"></a>
  <a href="https://github.com/RaleighSF/burnwatch"><img src="https://img.shields.io/badge/dependencies-0_runtime-28CF8D?style=flat&colorA=18181B" alt="Zero Runtime Dependencies"></a>
</p>

<br>

```
╔══════════════════════════════════════════════════════════════
║  BURNWATCH — your-app — March 2026
╠══════════════════════════════════════════════════════════════
║  Service        Spend       Conf      Budget  Left
║  ──────────────────────────────────────────────────────────
║  anthropic      $47.20      ✅ LIVE    $100    53%
║  vercel         $20.00      🟡 CALC    $20     flat — on plan
║  scrapfly       $127.00     ✅ LIVE    $100    ⚠️ OVER
║  browserbase    ~$12.40     ✅ LIVE    $99     87%
║  supabase       $25.00      🟡 CALC    $25     flat — on plan
║  posthog        $0.00       🟡 CALC    $0      —
║    ↳ 234K/1M events (23%)
╠══════════════════════════════════════════════════════════════
║  TOTAL: ~$231.60   Untracked: 0 ✅   Est margin: ±$12
║  🚨  scrapfly 127% OVER BUDGET - review before use
╚══════════════════════════════════════════════════════════════
```

This shows up automatically. Every session. No dashboards to check. No tabs to remember. Just quiet awareness right where you're already working.

<br>

## The Problem

Here's how it usually goes.

You're deep in a flow state. Claude is writing features, you're approving them, the codebase is growing, and everything feels amazing. Tuesday you add a Scrapfly key for web scraping. Wednesday you wire up Browserbase for browser automation. By Friday your agent has built a cron job that scrapes 1,000 competitor pages every other day. The code works perfectly.

Three weeks later the bill shows up. Turns out "works perfectly" costs $340/month and you signed up for the $99 plan.

This is the new normal with AI-assisted development. The services that charge you are getting wired in by an agent that has zero concept of what they cost. It doesn't know that Scrapfly's anti-bot bypass burns 25x your base credits. It doesn't know that Anthropic Opus costs 15x more per token than Haiku. It doesn't know you're on the free tier with a hard cap at 1,000 API calls.

And the sneaky part? Most of these services look cheap when you sign up. $20/month. $99/month. Flat fee, no worries. But then there's the overage rate buried on page three of the pricing docs. You leave the signup page feeling good about $20 and come back to a monthly bill in the hundreds because you blew past the included usage and nobody told you.

**78% of IT leaders experienced unexpected charges** tied to consumption-based or AI pricing in the past 12 months ([Zylo 2026 SaaS Management Index](https://zylo.com/research/saas-management-index/)).

burnwatch sits between your agent and your wallet. It watches every file save, knows every billing model, and speaks up before the damage is done.

<br>

## Install

```bash
npx burnwatch init
```

That's it. burnwatch scans your project, detects paid services, and registers hooks. Next session, you see your spend.

> **Requirements:** Node.js 18+ · Works with Claude Code, MCP, or standalone CLI

<br>

## How It Works

### 1. Detection

You run `npx burnwatch init` and burnwatch immediately scans four surfaces:

| What it checks | Example | When |
|----------------|---------|------|
| **package.json** | `"@anthropic-ai/sdk"` in dependencies | Init, file change |
| **Environment variables** | `SCRAPFLY_KEY` in `.env` | Every session start |
| **Import statements** | `import { Resend } from "resend"` | Init, file change |
| **Prompt mentions** | *"use Browserbase to scrape..."* | Every prompt |

```
🔍 Scanning project for paid services...

   Found 6 paid services:

   ● Anthropic (Claude)        ✅ LIVE API available
     Detected via: package.json, env vars, imports
   ● Scrapfly                  ✅ LIVE API available
     Detected via: env vars, imports
   ● Browserbase               ✅ LIVE API available
     Detected via: package.json, imports
   ● Supabase                  ✅ LIVE API available
     Detected via: package.json, env vars
   ● Vercel                    🟡 Flat plan
     Detected via: package.json
   ● PostHog                   🟡 Free tier
     Detected via: package.json, imports

🔗 Registering hooks...
✅ burnwatch initialized!
```

### 2. The Interview

No CLI flags. No YAML config files. You just talk to your agent:

```
You: "Let's set up burnwatch for this project"
```

Your agent runs a conversational interview, walking through each service by risk category (LLMs first, then usage-based, then flat infrastructure):

```
Agent: I found 6 services. Let me walk through each one.

       Anthropic — I probed your API key. You're on API Usage,
       $47.23 spent this billing period. Default budget: $100/mo.
       Does that feel right?

You:   Yeah that's fine.

Agent: ✅ Anthropic set to $100/mo budget.

       Scrapfly — Probe detected Pro plan (1M credits).
       You've used 742K/1M credits. Budget: $100/mo.

You:   Keep it.

Agent: ✅ Scrapfly set to Pro, $100/mo.

       Vercel — You're on Pro ($20/mo flat).
       PostHog — Free tier.
       I'll set these as flat plans with matching budgets.
       Skip?

You:   Yep.

Agent: ✅ Vercel $20, PostHog $0 — all set.
```

Each answer is written back immediately. The whole thing takes about 90 seconds.

### 3. Billing Manifests

This is where it gets interesting. Every tracked service has a **billing manifest**, a community-maintained JSON file that encodes the complete pricing model:

```json
{
  "serviceId": "browserbase",
  "billingDimensions": [
    {
      "id": "browser_hours",
      "name": "Browser hours",
      "unit": "hour",
      "ratePerUnit": 0.10,
      "ratePer": 1,
      "variants": [
        { "id": "standard", "ratePerUnit": 0.10, "codePatterns": ["createSession"] }
      ]
    },
    {
      "id": "proxy_bandwidth",
      "name": "Proxy bandwidth",
      "unit": "GB",
      "ratePerUnit": 10.00,
      "ratePer": 1
    }
  ],
  "plans": [
    { "id": "startup", "monthlyBase": 99, "included": { "browser_hours": 500 } }
  ],
  "costMultipliers": [
    { "id": "long_session", "factor": 10, "codePatterns": ["keepAlive", "waitForTimeout"] }
  ]
}
```

This is not guesswork. burnwatch knows that Browserbase charges per browser-hour (not per session), that the Startup plan includes 500 hours, that overages are $0.10/hr, and that long-running sessions with `keepAlive` can multiply cost by 10x. It knows that Anthropic Opus costs 5x more than Sonnet. It knows that Scrapfly's anti-bot bypass burns 5-25x base credits.

12 services ship with production-verified manifests. Adding a new one is a single JSON file.

### 4. Passive Monitoring

You code. burnwatch watches. Every time a file is saved, three things happen silently:

**Cost impact analysis** scans the changed file for SDK call sites, detects multipliers (loops, `.map()`, `Promise.all`, cron schedules), resolves variable loop bounds, matches model variants in the code, and projects monthly cost:

```
[BURNWATCH] ⚠️ Cost impact estimate for scraper.ts
  Browserbase: ~15,000 calls/mo → $37-$375/mo (Long-running sessions)
  Current: $12/$99 budget (12%)
```

**Utilization tracking** updates incrementally, tracking every call site across the project and projecting overage:

```
[BURNWATCH] ⚠️ Browserbase utilization: ~750 browser-hours/mo
  (plan includes 500) → ~$25.00/mo overage
```

**New service detection** fires if a file change introduces something burnwatch hasn't seen before:

```
[BURNWATCH] 🆕 New paid service detected: twilio
  Run 'burnwatch add twilio' to configure budget and tracking.
```

### 5. Intervention (The Part That Actually Saves You Money)

Here's the scenario that matters. You're five sessions and 4,000 lines deep. You tell Claude to build a web scraper:

```
You: "Create a scraper that uses Browserbase to scrape 1000 competitor
      pages every other day on a cron job"
```

Claude writes the code. The moment the file is saved, burnwatch fires:

```
[BURNWATCH] ⚠️ Cost impact estimate for scraper.ts
  Browserbase: ~15,000 sessions/mo → $37-$375/mo (Long-running sessions)
  Current: $12/$99 budget (12%)

[BURNWATCH] ⚠️ Browserbase utilization: ~750 browser-hours/mo
  (plan includes 500) → ~$25.00/mo overage
```

Claude sees this **in its own context**, injected as a system message. It doesn't wait for you to ask about cost. It responds proactively:

```
Agent: I built the scraper, but heads up — burnwatch flagged this:

       At 1,000 pages every other day, you're looking at ~750
       browser-hours/month. Your Startup plan includes 500 hours,
       so you'd hit ~$25/mo in overage on top of the $99 base.

       A few options:
       1. Reduce to 500 pages per run (stays within plan)
       2. Use Playwright locally for non-JS pages (free)
       3. Batch into fewer longer sessions to reduce overhead

       Want me to adjust?
```

**That conversation does not happen without burnwatch.** Without it, Claude writes the scraper, you ship it, and you find out about the overage three weeks later when the bill shows up. By then the cron job has been happily running the whole time.

<br>

## Multiplier Detection

burnwatch doesn't just count API calls. It reads the code structure around them.

| Pattern | Example | Detection |
|---------|---------|-----------|
| **Literal loop bounds** | `for (let i = 0; i < 1000; i++)` | Factor: 1000 |
| **Variable loop bounds** | `const PAGES = 1000; for (i < PAGES)` | Resolves `PAGES` to 1000 |
| **Array iteration** | `urls.map(async (u) => scrape(u))` where `urls = Array(500)` | Factor: 500 |
| **for...of** | `for (const page of pages)` where `pages` has known size | Resolved size |
| **Promise.all** | `Promise.all(urls.map(...))` | No double-count with `.map()` |
| **Named constants** | `const NUM_REQUESTS = 5000` | Detected as multiplier hint |
| **Cron: every 5 min** | `// every 5 minutes` or `*/5 * * *` | Factor: 8640/mo |
| **Cron: every other day** | `// every other day` or `*/2` | Factor: 15/mo |
| **Cron: weekly** | `// every week` or `0 0 * * 0` | Factor: 4/mo |
| **Batch size** | `const batch_size = 50` | Factor: 50 |

When a billing manifest has **cost multipliers** with code patterns (like Scrapfly's `asp.*true` for anti-bot bypass), those get detected too, giving you a cost range instead of a single number.

<br>

## Confidence Tiers

Every spend figure carries a confidence badge. burnwatch never pretends to know more than it does.

| Badge | Meaning | Source |
|-------|---------|--------|
| ✅ **LIVE** | Real billing API data | Polls service API with your key |
| 🟡 **CALC** | Fixed monthly cost | You enter your plan cost |
| 🟠 **EST** | Instrumented estimate | Usage signals + pricing formula |
| 🔴 **BLIND** | Detected, not tracked | Service exists but no config |

The brief always shows the untracked count. You never get a clean-looking dashboard hiding a surprise.

<br>

## Supported Services

| Service | Tier | Billing Model | The Thing That Gets You |
|---------|------|--------------|------------------------|
| Anthropic | ✅ LIVE | Per-token | Opus is 15x more per token than Haiku. Your agent picks models. |
| OpenAI | ✅ LIVE | Per-token | GPT-4o-mini is 66x cheaper than o1. Model choice matters a lot. |
| Scrapfly | ✅ LIVE | Credit pool | Anti-bot bypass burns 5-25x base credits. Silently. |
| Browserbase | ✅ LIVE | Per browser-hour | Charged by time, not sessions. Long sessions cost more. |
| Vercel | ✅ LIVE | Compute + overages | Function GB-hours is the #1 surprise on Vercel bills. |
| Supabase | ✅ LIVE | Tiered + overages | Database size grows fast with vector embeddings. |
| Google Gemini | 🟡 CALC | Per-token | Generous free tier, but Flash 2.0 is so cheap people forget to check. |
| Voyage AI | 🟡 CALC | Per-token | Embedding-only. Cost scales with corpus size, not query count. |
| Upstash | 🟠 EST | Per-command | $0.20/100K commands. Free tier: 10K/day. Easy to forget it's metered. |
| Resend | 🟠 EST | Per-email | $0.90/1K emails overage on Pro. Fine until your app goes viral. |
| Inngest | 🟡 CALC | Per-execution | Runs AND steps both count. A 5-step function is 6 executions. |
| PostHog | 🟡 CALC | Per-event | 1M events/mo free. That sounds like a lot until it isn't. |

<br>

## Billing Manifests

The `billing/` directory contains one JSON file per service. Each manifest encodes:

- **Billing dimensions**: every axis the service charges on (tokens, sessions, bandwidth, etc.)
- **Variants**: per-model rates with regex code patterns for auto-detection (Haiku vs Sonnet vs Opus)
- **Plans**: what's included, overage rates, hard caps
- **Cost multipliers**: feature flags that multiply cost (anti-bot bypass, JS rendering, stealth mode)
- **Typical dev usage**: realistic usage patterns for smarter projections

### Adding a new service

Drop a JSON file in `billing/`:

```json
{
  "$schema": "./billing.schema.json",
  "serviceId": "my-service",
  "name": "My Service",
  "lastVerified": "2026-03-25",
  "pricingUrl": "https://my-service.com/pricing",
  "billingDimensions": [
    {
      "id": "api_calls",
      "name": "API calls",
      "unit": "call",
      "ratePerUnit": 1.00,
      "ratePer": 1000
    }
  ],
  "plans": [
    {
      "id": "pro",
      "name": "Pro ($29/mo)",
      "monthlyBase": 29,
      "included": { "api_calls": 50000 },
      "overageRates": { "api_calls": 1.00 }
    }
  ]
}
```

No code changes needed. The cost engine picks it up automatically.

<br>

## MCP Server

burnwatch ships an MCP server for use with any MCP-enabled LLM:

```bash
claude mcp add burnwatch -- node ./node_modules/burnwatch/dist/mcp-server.js
```

**Tools exposed:**

| Tool | Purpose |
|------|---------|
| `get_spend_brief` | Full spend table with alerts |
| `get_service_spend` | Detailed info for one service |
| `analyze_cost_impact` | Analyze a file for cost-impacting SDK calls |
| `get_utilization` | Project-wide utilization and overage projections |
| `get_billing_manifest` | Raw billing manifest for any service |
| `detect_paid_services` | Scan for paid services in a project |
| `list_registry_services` | All services in the registry |

<br>

## Claude Code Integration

burnwatch runs as [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks), background scripts that fire on session lifecycle events:

| Hook | Event | What it does |
|------|-------|-------------|
| **Session start** | New or resumed session | Polls billing APIs, renders the spend brief |
| **Prompt submit** | You type a prompt | Detects service mentions, injects spend cards |
| **File change** | Code is written/edited | Cost impact analysis, new service detection, utilization update |
| **Session stop** | Session ends | Writes the spend ledger to disk |

burnwatch also installs three **agent skills**:

- `/setup-burnwatch`: Guided onboarding
- `/burnwatch-interview`: Conversational service-by-service configuration
- `/spend`: Quick spend check (or `/spend scrapfly` for one service)

<br>

## CLI Reference

```
burnwatch init                              Initialize in current project
burnwatch setup                             Init + auto-configure all detected services
burnwatch add <service> [options]           Register a service for tracking
burnwatch configure [options]               Update service config (plan, budget, key)
burnwatch interview --json                  Export current state as JSON (for agent use)
burnwatch status                            Show current spend brief
burnwatch scan                              Full project utilization scan
burnwatch services                          List all services in registry
burnwatch reconcile                         Scan for untracked services
burnwatch version                           Show version
```

<br>

## Config & Security

Credentials never live in your project directory.

```
~/.config/burnwatch/
  config.json              API keys, tokens (chmod 600, never in git)

your-project/.burnwatch/
  config.json              Services, budgets, detection history
  spend-ledger.md          Human-readable spend report (git-committable)
  data/
    utilization.json       Code-derived usage projections
    events.jsonl           Append-only event log
    cache/                 Billing API response cache
    snapshots/             Point-in-time spend snapshots
```

<br>

## Contributing

The fastest way to contribute: add a billing manifest.

1. Fork the repo
2. Create `billing/<service-id>.json` following `billing/billing.schema.json`
3. Include billing dimensions, plans, and ideally cost multipliers
4. Verify rates against the service's pricing page
5. Open a PR

You can also add services to `registry.json` with detection patterns, or improve the cost-impact multiplier detection.

<br>

## License

[MIT](LICENSE)
