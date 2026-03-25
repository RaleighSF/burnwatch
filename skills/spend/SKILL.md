---
name: spend
description: Show current burnwatch spend brief for this project. Use when the user asks about costs, spend, budget, or says /spend.
user-invocable: true
allowed-tools: Read, Bash, Glob
argument-hint: "[service]"
---

# /spend — Show Current Spend Brief

Run the burnwatch status command and present the results to the user.

## Instructions

1. Check if burnwatch is initialized by looking for `.burnwatch/config.json` in the project root
2. If not initialized, tell the user: "burnwatch isn't set up yet. Want me to run `/setup-burnwatch` to get started?"
3. If initialized, run: `node <path-to-burnwatch>/dist/cli.js status`
4. Present the brief output directly — it's already formatted for terminal display
5. If the user passed a service name as $ARGUMENTS, also read the registry entry for that service and show its gotchas, alternatives, and pricing details

If the user asks about a specific service (e.g., `/spend scrapfly`), also include:
- Current spend and budget status
- The service's gotchas from the registry
- Known alternatives
- Pricing model and scaling shape
