/**
 * Predictive cost impact analysis.
 *
 * Scans file content for SDK call sites, detects multipliers (loops, .map(), etc.),
 * and projects monthly cost using registry pricing data.
 */

import type {
  CostImpact,
  ServiceDefinition,
} from "./core/types.js";
import { loadRegistry } from "./core/registry.js";

/** SDK call patterns per service — maps serviceId to regex patterns for call sites */
const SERVICE_CALL_PATTERNS: Record<string, RegExp[]> = {
  anthropic: [
    /\.messages\.create\s*\(/g,
    /\.completions\.create\s*\(/g,
    /anthropic\.\w+\.create\s*\(/g,
  ],
  openai: [
    /\.chat\.completions\.create\s*\(/g,
    /\.completions\.create\s*\(/g,
    /\.images\.generate\s*\(/g,
    /\.embeddings\.create\s*\(/g,
    /openai\.\w+\.create\s*\(/g,
  ],
  "google-gemini": [
    /\.generateContent\s*\(/g,
    /\.generateContentStream\s*\(/g,
    /model\.generate\w*\s*\(/g,
  ],
  "voyage-ai": [
    /\.embed\s*\(/g,
    /voyageai\.embed\s*\(/g,
  ],
  scrapfly: [
    /\.scrape\s*\(/g,
    /scrapfly\.scrape\s*\(/g,
    /\.async_scrape\s*\(/g,
    /ScrapeConfig\s*\(/g,
  ],
  browserbase: [
    /\.createSession\s*\(/g,
    /\.sessions\.create\s*\(/g,
    /stagehand\.act\s*\(/g,
    /stagehand\.extract\s*\(/g,
  ],
  upstash: [
    /redis\.\w+\s*\(/g,
    /\.set\s*\(/g,
    /\.get\s*\(/g,
    /\.incr\s*\(/g,
    /\.hset\s*\(/g,
  ],
  resend: [
    /resend\.emails\.send\s*\(/g,
    /\.emails\.send\s*\(/g,
  ],
  stripe: [
    /stripe\.charges\.create\s*\(/g,
    /stripe\.paymentIntents\.create\s*\(/g,
    /stripe\.checkout\.sessions\.create\s*\(/g,
  ],
  supabase: [
    /supabase\.from\s*\(/g,
    /\.rpc\s*\(/g,
    /supabase\.storage/g,
  ],
  inngest: [
    /inngest\.send\s*\(/g,
    /\.createFunction\s*\(/g,
  ],
  posthog: [
    /posthog\.capture\s*\(/g,
    /\.capture\s*\(/g,
  ],
  aws: [
    /\.send\s*\(new\s+\w+Command/g,
    /s3Client\.send\s*\(/g,
    /lambdaClient\.send\s*\(/g,
  ],
};

/** Multiplier patterns — things that make calls happen more than once */
interface MultiplierMatch {
  label: string;
  factor: number;
}

function detectMultipliers(content: string): MultiplierMatch[] {
  const multipliers: MultiplierMatch[] = [];

  // for loops — assume 10x as conservative estimate
  if (/for\s*\(.*;\s*\w+\s*<\s*(\w+)/g.test(content)) {
    // Try to extract the loop bound
    const loopMatch = content.match(/for\s*\(.*;\s*\w+\s*<\s*(\d+)/);
    if (loopMatch) {
      const bound = parseInt(loopMatch[1]!);
      if (bound > 1) {
        multipliers.push({ label: `for loop (${bound} iterations)`, factor: bound });
      }
    } else {
      multipliers.push({ label: "for loop (variable bound)", factor: 10 });
    }
  }

  // .map() calls
  if (/\.\s*map\s*\(\s*(async\s*)?\(/g.test(content)) {
    multipliers.push({ label: ".map() iteration", factor: 10 });
  }

  // .forEach() calls
  if (/\.\s*forEach\s*\(\s*(async\s*)?\(/g.test(content)) {
    multipliers.push({ label: ".forEach() iteration", factor: 10 });
  }

  // for...of / for...in
  if (/for\s*\(\s*(const|let|var)\s+\w+\s+(of|in)\s+/g.test(content)) {
    multipliers.push({ label: "for...of/in loop", factor: 10 });
  }

  // Promise.all with array
  if (/Promise\.all\s*\(/g.test(content)) {
    multipliers.push({ label: "Promise.all (parallel batch)", factor: 10 });
  }

  // Cron patterns in comments or configuration
  if (/cron|schedule|interval|setInterval|every\s+\d+\s*(min|hour|day|sec)/gi.test(content)) {
    // Estimate: if hourly = 720/mo, daily = 30/mo, every 5 min = 8640/mo
    if (/every\s+5\s*min/gi.test(content) || /\*\/5\s+\*\s+\*/g.test(content)) {
      multipliers.push({ label: "cron: every 5 minutes", factor: 8640 });
    } else if (/every\s+1?\s*hour/gi.test(content) || /0\s+\*\s+\*\s+\*/g.test(content)) {
      multipliers.push({ label: "cron: hourly", factor: 720 });
    } else if (/every\s+1?\s*day/gi.test(content) || /0\s+0\s+\*\s+\*/g.test(content)) {
      multipliers.push({ label: "cron: daily", factor: 30 });
    } else {
      multipliers.push({ label: "scheduled execution", factor: 30 });
    }
  }

  // Batch size hints
  const batchMatch = content.match(/batch[_\s]?size\s*[=:]\s*(\d+)/i);
  if (batchMatch) {
    const batchSize = parseInt(batchMatch[1]!);
    if (batchSize > 1) {
      multipliers.push({ label: `batch size: ${batchSize}`, factor: batchSize });
    }
  }

  return multipliers;
}

/** Gotcha-based cost multipliers per service */
const GOTCHA_MULTIPLIERS: Record<string, { low: number; high: number; explanation: string }> = {
  scrapfly: {
    low: 1,
    high: 25,
    explanation: "anti-bot bypass consumes 5-25x base credits",
  },
  browserbase: {
    low: 1,
    high: 5,
    explanation: "session duration affects cost — long sessions burn more",
  },
  anthropic: {
    low: 1,
    high: 60,
    explanation: "Haiku ~$0.25/MTok vs Opus ~$15/MTok (60x range)",
  },
  openai: {
    low: 1,
    high: 30,
    explanation: "GPT-4 mini vs GPT-5 (30x cost range)",
  },
  stripe: {
    low: 1,
    high: 1.5,
    explanation: "international cards add 1-1.5% extra",
  },
};

/**
 * Analyze a file's content for cost-impacting SDK calls.
 * Returns cost impact estimates for each detected service.
 */
export function analyzeCostImpact(
  filePath: string,
  content: string,
  projectRoot?: string,
): CostImpact[] {
  // Only analyze source files
  if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) {
    return [];
  }

  const registry = loadRegistry(projectRoot);
  const impacts: CostImpact[] = [];
  const multipliers = detectMultipliers(content);

  for (const [serviceId, patterns] of Object.entries(SERVICE_CALL_PATTERNS)) {
    let totalCalls = 0;

    for (const pattern of patterns) {
      // Reset lastIndex for global regexes
      pattern.lastIndex = 0;
      const matches = content.match(pattern);
      if (matches) {
        totalCalls += matches.length;
      }
    }

    if (totalCalls === 0) continue;

    const service = registry.get(serviceId);
    if (!service) continue;

    // Calculate effective multiplier
    const multiplierFactor = multipliers.length > 0
      ? multipliers.reduce((max, m) => Math.max(max, m.factor), 1)
      : 1;

    // Assume ~30 working days, ~8 dev hours/day as baseline for monthly projections
    // If no cron detected, assume the code runs during dev sessions: ~50 times/month
    const baseMonthlyRuns = multipliers.some((m) => m.label.startsWith("cron"))
      ? 1 // cron multiplier already encodes frequency
      : 50; // ~2 dev runs per working day

    const monthlyInvocations = totalCalls * multiplierFactor * baseMonthlyRuns;

    // Get cost estimates
    const gotcha = GOTCHA_MULTIPLIERS[serviceId];
    const unitRate = service.pricing?.unitRate ?? 0;

    let costLow: number;
    let costHigh: number;

    if (unitRate > 0) {
      costLow = monthlyInvocations * unitRate * (gotcha?.low ?? 1);
      costHigh = monthlyInvocations * unitRate * (gotcha?.high ?? 1);
    } else if (service.pricing?.monthlyBase !== undefined) {
      // Flat-rate services — cost is the plan, not per-invocation
      costLow = 0;
      costHigh = 0;
    } else {
      // Estimate based on typical per-call costs
      const typicalCallCosts: Record<string, number> = {
        anthropic: 0.003, // ~$3/MTok * ~1K tokens average
        openai: 0.002,
        "google-gemini": 0.001,
        scrapfly: 0.00015,
        browserbase: 0.01,
        resend: 0.001,
        stripe: 0.30,
      };
      const perCall = typicalCallCosts[serviceId] ?? 0.001;
      costLow = monthlyInvocations * perCall * (gotcha?.low ?? 1);
      costHigh = monthlyInvocations * perCall * (gotcha?.high ?? 1);
    }

    // Skip if no meaningful cost
    if (costLow === 0 && costHigh === 0) continue;

    impacts.push({
      serviceId,
      serviceName: service.name,
      filePath,
      callCount: totalCalls,
      multipliers: multipliers.map((m) => m.label),
      multiplierFactor,
      monthlyInvocations,
      costLow,
      costHigh,
      rangeExplanation: gotcha?.explanation,
    });
  }

  return impacts;
}

/**
 * Format a cost impact card for injection into Claude's context.
 */
export function formatCostImpactCard(
  impacts: CostImpact[],
  currentBudgets: Record<string, { spend: number; budget?: number }>,
): string {
  const fileName = impacts[0]?.filePath.split("/").pop() ?? "unknown";
  const lines: string[] = [];

  lines.push(`[BURNWATCH] ⚠️ Cost impact estimate for ${fileName}`);

  for (const impact of impacts) {
    const lowStr = impact.costLow < 1
      ? `$${impact.costLow.toFixed(2)}`
      : `$${impact.costLow.toFixed(0)}`;
    const highStr = impact.costHigh < 1
      ? `$${impact.costHigh.toFixed(2)}`
      : `$${impact.costHigh.toFixed(0)}`;

    const rangeStr = impact.costLow === impact.costHigh
      ? lowStr
      : `${lowStr}-${highStr}`;

    lines.push(
      `  ${impact.serviceName}: ~${impact.monthlyInvocations.toLocaleString()} calls/mo → ${rangeStr}/mo` +
        (impact.rangeExplanation ? ` (${impact.rangeExplanation})` : ""),
    );

    // Show current budget status if available
    const current = currentBudgets[impact.serviceId];
    if (current) {
      const budgetStr = current.budget
        ? `$${current.spend.toFixed(0)}/$${current.budget} budget`
        : `$${current.spend.toFixed(0)} (no budget set)`;
      const pctStr = current.budget && current.budget > 0
        ? ` (${((current.spend / current.budget) * 100).toFixed(0)}%)`
        : "";
      lines.push(`  Current: ${budgetStr}${pctStr}`);
    }

    // Suggest alternatives from registry
    const registry = loadRegistry();
    const service = registry.get(impact.serviceId);
    if (service?.alternatives && service.alternatives.length > 0 && impact.costHigh > 10) {
      const freeAlts = service.alternatives.filter(
        (a) => a.includes("free") || a.includes("cheerio") || a.includes("playwright") || a.includes("self-hosted"),
      );
      if (freeAlts.length > 0) {
        lines.push(`  Consider: ${freeAlts.join(", ")} for lower-cost alternative`);
      }
    }
  }

  return lines.join("\n");
}
