---
name: setup-burnwatch
description: Guided burnwatch setup — detects paid services in the project and walks through configuring budgets and API keys for each one. Use when the user wants to set up cost tracking, mentions burnwatch setup, or when burnwatch is not yet initialized.
user-invocable: true
allowed-tools: Read, Bash, Glob, Grep
---

# /setup-burnwatch — Guided Cost Tracking Setup

Walk the user through setting up burnwatch for their project. This is an interactive, conversational onboarding — not a dump of commands.

## Step 1: Initialize

Check if `.burnwatch/config.json` exists. If not, run:

```bash
node <path-to-burnwatch>/dist/cli.js init
```

Present the detected services to the user in a clean summary.

## Step 2: Guided Service Configuration

For each detected service, walk the user through configuration **one service at a time** or in logical groups. Use this priority order:

### High-priority (usage-based, likely to cause surprises):
1. **LLM providers** (Anthropic, OpenAI, Google Gemini) — these are usually the biggest spend
2. **Scraping/browser** (Scrapfly, Browserbase) — credit-based, easy to overspend
3. **Infrastructure** (Vercel, AWS, Supabase) — tiered with overages

### Medium-priority (transaction/event-based):
4. **Payments** (Stripe) — percentage-based, scales with revenue
5. **Email** (Resend) — per-email, usually small
6. **Cache/queue** (Upstash, Inngest) — per-command, usually small

### Low-priority (flat-rate or free tier):
7. **Analytics** (PostHog) — often on free tier
8. **Embeddings** (Voyage AI) — usually small volume

For each service, ask the user:

1. **"Do you have a billing/admin API key for [service]?"**
   - If yes: `burnwatch add <service> --key <KEY> --budget <N>`
   - If no: explain what tier they'll get (CALC/EST) and that's fine

2. **"What's your monthly budget for [service]?"**
   - Suggest a reasonable default based on the service type
   - For flat-rate: "What plan are you on? (e.g., PostHog free tier = $0/mo)"

3. **"Any notes?"** — skip this for most, but for complex services like AWS, acknowledge that burnwatch tracks it as BLIND and suggest they check their AWS console directly.

## Step 3: Show the Brief

After configuring all services, run `burnwatch status` and show the result. Celebrate what's tracked and be honest about what's still BLIND.

## Key Behaviors

- **Be concise.** Don't explain what burnwatch is — the user already chose to set it up.
- **Group services.** Don't ask 14 questions one at a time. Group similar services: "For your LLM providers (Anthropic, OpenAI) — do you have admin API keys? What monthly budget for each?"
- **Suggest defaults.** "Most projects budget $50-100/mo for Anthropic. Sound right?"
- **Skip what's obvious.** If PostHog is on free tier, just say "I'll set PostHog to $0/mo free tier" and move on.
- **Be honest about BLIND.** "AWS is too complex for automatic tracking — I'll flag it so you see it in the ledger, but check your AWS console for actual spend."
- **Show the payoff.** End with the brief so they see the value immediately.

## Example Conversation Flow

```
Agent: I found 11 paid services in your project. Let me walk you through
       setting up cost tracking for each one. This takes about 2 minutes.

       First, your LLM providers — Anthropic and OpenAI.
       Do you have admin API keys for either? And what monthly budget
       feels right? Most projects do $50-150/mo per provider.

User:  I have my anthropic admin key, it's sk-ant-admin-xxx. Budget $100.
       OpenAI I don't have an admin key. Budget $50.

Agent: Got it.
       ✅ Anthropic — LIVE tracking, $100/mo budget
       🔴 OpenAI — no admin key, setting $50 budget (will show as BLIND
          until you add a key)

       Next, your scraping services — Scrapfly and Browserbase.
       These are credit-based and the most common source of surprise bills.
       Do you have API keys? Budget thoughts?

[... continues through all services ...]

Agent: All set! Here's your spend brief:
       [shows burnwatch status output]

       You're tracking 8 services with real data, 3 are estimated,
       and AWS is flagged as BLIND. The brief will appear automatically
       at the start of every Claude Code session.
```
