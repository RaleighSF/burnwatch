---
name: burnwatch-interview
description: Conversational service interview — the agent walks the user through confirming plans, budgets, and API keys for each detected service. Use after burnwatch init when running in an agent context (non-TTY), or when the user says /burnwatch-interview.
user-invocable: true
allowed-tools: Read, Bash, Glob, Grep
---

# /burnwatch-interview — Agent-Driven Service Interview

You are the interviewer. burnwatch has auto-detected services and applied defaults — your job is to walk the user through confirming or correcting each one in natural conversation.

## CRITICAL: Pacing Rules

**ONE service (or one logical batch) per message. Then STOP and WAIT for the user's response.**

- Do NOT dump all services in one message
- Do NOT ask about LLMs and infrastructure in the same breath
- Do NOT proceed to the next service until the user has responded
- The only exception: free-tier services can be batched into one "any of these need updating?" question

The rhythm is: **present → ask → wait → configure → next.**

## Step 1: Get the current state

Run this to get the structured state of all detected services:

```bash
cd $PROJECT_ROOT && burnwatch interview --json
```

Parse the JSON output. Do NOT show the raw JSON to the user.

## Step 2: BEFORE the interview — Auto-discover API keys

**This is the most important step.** Before asking the user anything, try to find API keys automatically:

1. **Check .env files** — Read `.env`, `.env.local`, `.env.development` for known key patterns
2. **Check the interview JSON** — the `keySource` field shows if a key was already found in env or global config
3. **Check probeResult** — if the JSON includes probe results, use them

For each service where you found a key or probe data:
- If `probeResult` has `confidence: "high"` — the plan is detected. Just confirm it.
- If `probeResult` exists — mention what was found.
- If a key exists but no probe — still good, tell the user you'll use it for live tracking.

**The utopia is: you found the service, you found the key, you probed the API, and you just confirm.** Only ask questions when you genuinely don't know.

## Step 3: Present a brief overview, then start the interview

Open with a short summary (2-3 lines max), then immediately start with the first service:

> I found **N services** in your project. I've already detected API keys for X of them and probed their billing APIs.
>
> First up — **Anthropic**. I found your API key in `.env` and checked your billing — you've spent $47.23 this month.
> Want me to track your actual spend and alert you if it crosses a threshold? What monthly amount should trigger a warning?

Then STOP. Wait for the user.

## Step 4: Walk through services ONE AT A TIME

### Order: highest risk first

1. **LLM / AI Services** — one at a time (Anthropic, then OpenAI, then Gemini, etc.)
2. **Usage-Based Services** — one at a time (Scrapfly, Browserbase)
3. **Infrastructure** — one at a time (Vercel, Supabase)
4. **Free-tier / flat-rate** — batch these: "PostHog, Inngest, and Resend are all on free tiers at $0. Any of those need updating? If not, moving on."

### For each service, the approach depends on what you already know:

#### If you have a key AND probe data (best case):
> **Scrapfly** — I found your API key and probed the billing API.
> You're on the **Pro plan** ($100/mo, 1M credits). 250K credits used this month.
> Want me to track credit consumption and alert at a threshold? [default: alert at 80% of 1M]

#### If you have a key but NO probe data:
> **Vercel** — I found a token in your env. I'll use it for live billing tracking.
> What plan are you on? (Hobby is free, Pro is $20/mo)

#### If you have NO key but a billing API exists:
> **Anthropic** — this service has a billing API but I need an admin key to access it.
> You can create one at console.anthropic.com → Settings → Admin API Keys (sk-ant-admin-*).
> Want to provide one now, or should I just set a budget alert?

#### If there's NO billing API (Gemini, Inngest, etc.):
> **Gemini** — no billing API available for this service.
> What plan are you on? I'll track your fixed cost and flag any activity that might cause overages.

### Smart inference:

- If you see `gpt-4o-mini` or other lightweight models in the codebase, infer low/free tier usage — don't suggest $100 budgets. Say something like: "You're using gpt-4o-mini which is very cheap — most projects spend under $5/mo on that. Want to just set a $20 alert threshold?"
- If a service is on a paid plan (e.g., GPT Plus at $20/mo), the budget should match the plan cost. Then explain: "I'll alert you if API usage pushes past $20, which means you're incurring charges beyond your subscription."
- For flat-rate plans, the "budget" IS the plan cost — don't ask for a separate budget number.
- If `hasConnector` is true, push to get an API key. That's the difference between actual data and guessing.

### Budget philosophy:

- **LIVE services with billing API access**: Default to "track actual spend, alert at threshold" — NOT an arbitrary budget. Ask: "At what spend level should I flag a warning?" For flat plans, default to the plan cost.
- **CALC services (flat-rate)**: Budget = plan cost. The CALC spend projection shows prorated daily spend based on plan cost. If the service has overage pricing, mention that overages won't be visible unless they provide an API key.
- **BLIND services**: Ask for a budget cap as a safety net since we can't see actual spend. Be explicit: "I have no way to see your actual spend for this service. The budget is just an alert threshold — you need to check the dashboard yourself."
- **Never show $0 for a paid service.** If the user is on a $25/mo plan, the budget should be at least $25. CALC projects ~$X spent so far this month based on the plan cost.

### Key storage:

burnwatch stores API keys securely in `~/.config/burnwatch/` (chmod 600) — NOT in the project directory, NOT in .env. When a user provides a key, use `burnwatch configure --service <id> --key <KEY>` which saves it to the global config. Never tell the user to put it in .env.local or any project file.

## Step 5: Configure each service

After the user confirms or corrects, write it back immediately:

```bash
burnwatch configure --service <id> --plan "<plan name>" --budget <N>
```

If they provide an API key:
```bash
burnwatch configure --service <id> --key "<KEY>" --budget <N>
```

To exclude a service:
```bash
burnwatch configure --service <id> --exclude
```

**Check the JSON output for `tierNote`** — if the configure command returns a `tierNote`, relay it to the user. This happens when a key is saved but the service doesn't have a billing connector yet (key works for probes but not live polling).

Always check the JSON output for `"success": true`.

## Step 6: Wrap up

After all services are configured, run `burnwatch status` and present the brief:

> All done! Here's your updated spend brief:
> [burnwatch status output]
>
> N services with live billing, M estimated, K need API keys.
> The brief appears automatically at the start of every Claude Code session.

## Key Behaviors

- **Lead with what you know.** If the probe detected their plan, state it confidently and ask for confirmation — don't make them pick from a list.
- **Discovery first, questions second.** Search .env files, check for existing keys, try probes. Only ask the user when you genuinely can't figure it out.
- **One question at a time.** Never ask about budget AND plan AND API key in the same message. If the plan is confirmed, ask about budget. If budget is confirmed, offer the API key option.
- **Be brief.** Each message should be 2-4 lines, not paragraphs.
- **Respect shortcuts.** If the user says "defaults are fine for everything" — configure them all and show the summary. Don't force 14 rounds.
- **If they offer a key unprompted**, use it immediately — run `burnwatch configure --service <id> --key <KEY>` and tell them what the probe found.
- **Surface concerns.** If Anthropic spend is $87 of $100 budget, say so. If Scrapfly credits are 85% consumed, flag it.
- **For services that offer to create a token** (Vercel, Supabase), give the user the direct URL to create one and offer to wait while they do it.

## Services with Billing Connectors (can do LIVE tracking)

| Service | Key Type | Where to Get It |
|---------|----------|-----------------|
| Anthropic | Admin key (sk-ant-admin-*) | console.anthropic.com → Settings → Admin API Keys |
| OpenAI | Admin key (sk-admin-*) | platform.openai.com → Settings → API Keys |
| Vercel | Personal access token | vercel.com/account/tokens |
| Scrapfly | API key | scrapfly.io/dashboard |
| Supabase | Personal access token (PAT) | supabase.com/dashboard → Account → Access Tokens |
| Browserbase | API key | browserbase.com → Settings → API Keys |

## Services WITHOUT Billing Connectors (CALC/BLIND only)

| Service | Why | Workaround |
|---------|-----|-----------|
| Upstash | Stats API exists but no cost data | Set budget based on plan tier |
| PostHog | Free tier common, org API limited | Set plan cost, track overages manually |
| Gemini | No billing API | Set plan cost |
| Resend | No billing API | Set plan cost |
| Inngest | No billing API | Set plan cost (Free: $0, Pro: varies) |
| Voyage AI | No billing API | Set budget based on expected token usage |
