# Contributing to burnwatch

Thanks for your interest in contributing. burnwatch is better when the community adds services, fixes pricing data, and improves detection.

## Adding a New Service

burnwatch uses a **registry-driven architecture**. Adding a new service ranges from "JSON-only" (5 minutes) to "TypeScript connector" (30 minutes) depending on what tracking tier you want.

### Tier 1: CALC/BLIND — Registry Entry Only (no code)

Most services can be added with just a JSON entry in `registry.json`. This gets you:
- Auto-detection in projects (via package.json, env vars, imports)
- CALC spend projection (prorated monthly plan cost)
- Budget alerts and brief integration

**Add your service to `registry.json` under `"services"`:**

```json
"my-service": {
  "id": "my-service",
  "name": "My Service",
  "packageNames": ["my-service-sdk"],
  "envPatterns": ["MY_SERVICE_API_KEY"],
  "importPatterns": ["my-service-sdk"],
  "mentionKeywords": ["my-service"],
  "billingModel": "per_unit",
  "scalingShape": "linear",
  "apiTier": "calc",
  "pricing": {
    "formula": "units * rate",
    "unitRate": 0.001,
    "unitName": "request"
  },
  "plans": [
    { "name": "Free", "type": "flat", "monthlyBase": 0, "default": true },
    { "name": "Pro ($20/mo)", "type": "flat", "monthlyBase": 20 },
    { "name": "Don't track for this project", "type": "exclude" }
  ],
  "gotchas": ["Important cost consideration"],
  "alternatives": ["alternative-1", "alternative-2"],
  "docsUrl": "https://example.com/pricing",
  "lastVerified": "2026-03-25"
}
```

**Key fields explained:**
- `packageNames` — npm packages that indicate this service (checked in `package.json`)
- `envPatterns` — environment variable names (checked in `.env*` files and `process.env`)
- `importPatterns` — import/require patterns scanned in source files
- `mentionKeywords` — words that trigger spend card injection when mentioned in prompts
- `apiTier` — set to `"calc"` for fixed-cost plans, `"blind"` if no cost data available, `"live"` only if you also add a connector
- `billingModel` — how the service charges: `token_usage`, `credit_pool`, `per_unit`, `tiered`, `compute`, `percentage`
- `scalingShape` — how cost scales: `linear`, `tiered_jump`, `linear_burndown`, `fixed`, `percentage`
- `plans[]` — plan tiers shown during the interview; each needs `name`, `type` (`flat`/`usage`/`exclude`), and `monthlyBase` for flat plans

**Optionally** add SDK call patterns to `src/cost-impact.ts` for cost-impact analysis:

```typescript
"my-service": [
  /myService\.doThing\s*\(/g,
  /client\.send\s*\(/g,
],
```

This enables burnwatch to detect API calls in code and estimate monthly cost impact.

### Tier 2: LIVE — Add a Billing Connector

For services with billing APIs, add a connector that fetches real spend data.

1. Create `src/services/my-service.ts`:

```typescript
import type { BillingConnector, BillingResult } from "./base.js";
import { fetchJson } from "./base.js";

export const myServiceConnector: BillingConnector = {
  serviceId: "my-service",
  async fetchSpend(apiKey: string): Promise<BillingResult> {
    const result = await fetchJson<{ spend: number }>(
      "https://api.myservice.com/billing/usage",
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );

    if (!result.ok || !result.data) {
      return {
        serviceId: "my-service",
        spend: 0,
        isEstimate: true,
        tier: "blind",
        error: result.error ?? "Failed to fetch billing data",
      };
    }

    return {
      serviceId: "my-service",
      spend: result.data.spend,
      isEstimate: false,
      tier: "live",
    };
  },
};
```

2. Register it in `src/services/index.ts`:
```typescript
import { myServiceConnector } from "./my-service.js";
// Add to the connectors Map:
["my-service", myServiceConnector],
```

3. Update `registry.json` to set `"apiTier": "live"`.

4. Add tests in `src/__tests__/connectors.test.ts` with mocked `fetchJson`.

### Tier 3: Probe — Plan Auto-Detection

Probes run during the interview to auto-detect the user's plan tier from their API key. Add a probe function in `src/probes.ts` and register it in the `PROBES` map.

See existing probes (Scrapfly, Vercel, Supabase) for examples of high-confidence plan detection.

### Project-Local Custom Services

Users can add custom services **without modifying burnwatch** by creating `.burnwatch/registry.json` in their project. Entries merge with (and override) the bundled registry.

```json
{
  "version": "0.1.0",
  "lastUpdated": "2026-03-25",
  "services": {
    "my-internal-api": {
      "id": "my-internal-api",
      "name": "Internal API Gateway",
      "packageNames": [],
      "envPatterns": ["INTERNAL_API_KEY"],
      "importPatterns": [],
      "mentionKeywords": ["internal api"],
      "billingModel": "compute",
      "scalingShape": "linear",
      "apiTier": "calc",
      "plans": [
        { "name": "Internal ($500/mo)", "type": "flat", "monthlyBase": 500, "default": true }
      ]
    }
  }
}
```

This is useful for:
- Internal services not in the public registry
- Overriding pricing or plan data for a specific service
- Testing new service entries before submitting a PR

## How to decide `apiTier`

| Tier | When to use | What the user gets |
|------|-------------|-------------------|
| **live** | Service has a billing API **and** you've added a connector | Real spend data, auto-refreshed |
| **calc** | Fixed monthly cost, user picks a plan | Prorated daily spend projection |
| **est** | Usage-based but no billing API | Estimated from SDK call patterns in code |
| **blind** | Detected only, no way to track cost | Detection alerts, budget safety net |

**Important:** Set `apiTier` to match what burnwatch *actually delivers*, not what the vendor theoretically offers. If a service has a billing API but burnwatch doesn't have a connector for it, set it to `calc`, not `live`.

## Development

```bash
git clone https://github.com/RaleighSF/burnwatch.git
cd burnwatch
npm install
npm run build
npm test
```

### Project structure

```
registry.json          — Service definitions (JSON, no code)
src/detection/         — Auto-detection (package.json, env vars, imports)
src/services/          — Billing connectors (LIVE tier)
src/probes.ts          — Plan auto-detection (interview)
src/cost-impact.ts     — SDK call analysis (EST tier)
src/core/brief.ts      — Spend brief formatting
src/core/config.ts     — Config management (global + project)
src/core/ledger.ts     — Spend history and snapshots
src/hooks/             — Claude Code hook integration
src/cli.ts             — CLI commands
src/mcp-server.ts      — MCP server for LLM tool access
skills/                — Claude Code skills (interview, setup, spend)
```

### Running tests

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run lint          # Type-check
```

### Code style

- TypeScript strict mode, ESM only
- No external runtime dependencies (Node 18+ built-ins only, plus `@modelcontextprotocol/sdk` and `zod`)
- Hooks must complete in < 5 seconds (prompt/file hooks) or < 15 seconds (session hooks)

## Reporting Issues

- **Incorrect pricing data**: Open an issue with the service name, correct pricing, and a link to the pricing page
- **Missing service**: Open a PR adding it to `registry.json`, or an issue if you'd like someone else to add it
- **Bugs**: Open an issue with steps to reproduce and your Node.js version

## Code of Conduct

Be respectful. Be constructive. Focus on making the tool better for everyone.
