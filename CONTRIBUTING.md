# Contributing to burnwatch

Thanks for your interest in contributing. burnwatch is better when the community adds services, fixes pricing data, and improves detection.

## Adding a Service to the Registry

The highest-impact contribution is adding a new service to `registry.json`. This requires no code changes — just data.

### Required fields

```json
{
  "your-service": {
    "id": "your-service",
    "name": "Your Service",
    "packageNames": ["your-service-sdk"],
    "envPatterns": ["YOUR_SERVICE_API_KEY"],
    "importPatterns": ["your-service-sdk"],
    "mentionKeywords": ["your-service"],
    "billingModel": "token_usage | credit_pool | per_unit | percentage | flat_monthly | tiered | compute",
    "scalingShape": "linear | linear_burndown | tiered_jump | percentage | fixed",
    "apiTier": "live | calc | est | blind",
    "pricing": {
      "formula": "Human-readable pricing formula",
      "unitRate": 0.001,
      "unitName": "token"
    },
    "docsUrl": "https://your-service.com/pricing",
    "lastVerified": "2026-03-24"
  }
}
```

### Recommended fields

```json
{
  "gotchas": ["The one thing that causes surprise bills"],
  "alternatives": ["free-alternative", "cheaper-alternative"],
  "pricingNotes": "Recent changes worth noting"
}
```

### How to decide `apiTier`

- **live**: The service has a billing/usage API that returns spend data. You've confirmed the endpoint works.
- **calc**: Fixed monthly cost. User enters their plan price, burnwatch projects daily burn.
- **est**: Usage-based but no billing API. burnwatch can estimate from SDK call patterns + pricing formula.
- **blind**: Detected only. No way to track spend automatically.

## Adding a Billing Connector

If a service has a billing API (tier: `live`), you can add a connector in `src/services/`:

1. Create `src/services/your-service.ts` implementing the `BillingConnector` interface
2. Register it in `src/services/index.ts`
3. Add tests
4. Open a PR

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
src/
  core/          Types, config, registry, brief formatter, ledger
  detection/     Four-surface service detection engine
  services/      Billing API connectors (one file per LIVE service)
  hooks/         Claude Code hook scripts
  __tests__/     Vitest tests
  cli.ts         CLI entry point
  index.ts       Library exports
```

### Running tests

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run lint          # Type-check
```

### Code style

- TypeScript strict mode, ESM only
- No external runtime dependencies (Node 18+ built-ins only)
- Hooks must complete in < 5 seconds (prompt/file hooks) or < 15 seconds (session hooks)

## Reporting Issues

- **Incorrect pricing data**: Open an issue with the service name, correct pricing, and a link to the pricing page
- **Missing service**: Open a PR adding it to `registry.json`, or an issue if you'd like someone else to add it
- **Bugs**: Open an issue with steps to reproduce and your Node.js version

## Code of Conduct

Be respectful. Be constructive. Focus on making the tool better for everyone.
