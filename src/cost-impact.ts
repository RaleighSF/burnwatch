/**
 * Predictive cost impact analysis.
 *
 * Scans file content for SDK call sites, detects multipliers (loops, .map(), etc.),
 * and projects monthly cost using billing manifest data when available,
 * falling back to registry pricing data.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import type {
  CostImpact,
  ServiceDefinition,
} from "./core/types.js";
import { loadRegistry } from "./core/registry.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// ── Billing manifest types ──────────────────────────────────────────

interface DimensionVariant {
  id: string;
  name: string;
  ratePerUnit: number;
  ratePer?: number;
  codePatterns?: string[];
  isDefault?: boolean;
}

interface BillingDimension {
  id: string;
  name: string;
  unit: string;
  ratePerUnit: number;
  ratePer?: number;
  variants?: DimensionVariant[];
}

interface CostMultiplier {
  id: string;
  name: string;
  factor: number;
  description: string;
  codePatterns?: string[];
}

interface BillingManifest {
  serviceId: string;
  name: string;
  billingDimensions: BillingDimension[];
  plans?: Array<{
    id: string;
    name: string;
    monthlyBase: number;
    included?: Record<string, number>;
    overageRates?: Record<string, number>;
    hardCap?: boolean;
    isDefault?: boolean;
  }>;
  costMultipliers?: CostMultiplier[];
  typicalDevUsage?: {
    callsPerDevHour: number;
    unitsPerCall: number;
    unitName: string;
  };
  notes?: string;
}

// ── Manifest loader (cached) ────────────────────────────────────────

let manifestCache: Map<string, BillingManifest> | null = null;

function loadBillingManifests(): Map<string, BillingManifest> {
  if (manifestCache) return manifestCache;

  manifestCache = new Map();

  // Try multiple possible locations for the billing/ directory
  const candidates = [
    path.resolve(__dirname, "../billing"),       // from src/ during dev
    path.resolve(__dirname, "../../billing"),     // from dist/
  ];

  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "billing.schema.json");
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), "utf-8");
        const manifest = JSON.parse(raw) as BillingManifest;
        if (manifest.serviceId) {
          manifestCache.set(manifest.serviceId, manifest);
        }
      } catch {
        // Skip malformed manifests
      }
    }
    break; // Use the first directory that exists
  }

  return manifestCache;
}

/** Clear manifest cache (for testing). */
export function clearManifestCache(): void {
  manifestCache = null;
}

// ── SDK call patterns per service ───────────────────────────────────

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
  firebase: [
    /firestore\.\w+\(\s*["']/g,
    /\.collection\s*\(/g,
    /\.doc\s*\(/g,
    /admin\.firestore\(\)/g,
  ],
  twilio: [
    /\.messages\.create\s*\(/g,
    /\.calls\.create\s*\(/g,
    /twilio\.messages/g,
  ],
  sendgrid: [
    /sgMail\.send\s*\(/g,
    /\.send\s*\(\s*msg/g,
  ],
  "mongodb-atlas": [
    /\.find\s*\(/g,
    /\.insertOne\s*\(/g,
    /\.insertMany\s*\(/g,
    /\.updateOne\s*\(/g,
    /\.aggregate\s*\(/g,
  ],
  clerk: [
    /clerkClient\.\w+/g,
    /auth\(\)/g,
  ],
  replicate: [
    /replicate\.run\s*\(/g,
    /replicate\.predictions\.create\s*\(/g,
  ],
  vercel: [
    /\.functions\./g,
    /edge\s+function/gi,
  ],
};

// ── Multiplier detection ────────────────────────────────────────────

interface MultiplierMatch {
  label: string;
  factor: number;
}

/**
 * Extract numeric constants and variable assignments from code.
 * Builds a map of variable name → numeric value for resolving loop bounds.
 *
 * Handles:
 *   const COUNT = 1000;
 *   let total = 500;
 *   const urls = Array(200)
 *   const items = [...]; // count commas
 *   const pages = new Array(50);
 */
function extractNumericContext(content: string): Map<string, number> {
  const ctx = new Map<string, number>();

  // const/let/var NAME = NUMBER
  const assignRegex = /(?:const|let|var)\s+(\w+)\s*=\s*(\d+)\s*[;,\n]/g;
  let m: RegExpExecArray | null;
  while ((m = assignRegex.exec(content)) !== null) {
    ctx.set(m[1]!, parseInt(m[2]!, 10));
  }

  // Array(N) or new Array(N)
  const arrayCtorRegex = /(?:const|let|var)\s+(\w+)\s*=\s*(?:new\s+)?Array\s*\(\s*(\d+)\s*\)/g;
  while ((m = arrayCtorRegex.exec(content)) !== null) {
    ctx.set(m[1]!, parseInt(m[2]!, 10));
  }

  // Array literals — count elements: const x = [a, b, c]
  const arrayLitRegex = /(?:const|let|var)\s+(\w+)\s*=\s*\[([^\]]*)\]/g;
  while ((m = arrayLitRegex.exec(content)) !== null) {
    const elements = m[2]!.split(",").filter((e) => e.trim().length > 0);
    if (elements.length > 1) {
      ctx.set(m[1]!, elements.length);
    }
  }

  return ctx;
}

/**
 * Try to resolve a variable name to a numeric value.
 * Checks: direct numeric literal, variable from context, .length property.
 */
function resolveLoopBound(
  varName: string,
  content: string,
  ctx: Map<string, number>,
): number | null {
  // Direct numeric literal
  const num = parseInt(varName, 10);
  if (!isNaN(num) && num > 0) return num;

  // Variable from extracted context
  if (ctx.has(varName)) return ctx.get(varName)!;

  // foo.length — try to resolve foo
  const lengthMatch = varName.match(/^(\w+)\.length$/);
  if (lengthMatch && ctx.has(lengthMatch[1]!)) {
    return ctx.get(lengthMatch[1]!)!;
  }

  return null;
}

/**
 * Detect iteration size from the iterable in for...of or .map()/.forEach().
 * Looks for the array variable and resolves its size from context.
 */
function resolveIterableSize(
  content: string,
  ctx: Map<string, number>,
): number | null {
  // for (const x of ARRAY) — extract ARRAY name
  const forOfMatch = content.match(/for\s*\(\s*(?:const|let|var)\s+\w+\s+of\s+(\w+)/);
  if (forOfMatch) {
    const resolved = ctx.get(forOfMatch[1]!);
    if (resolved) return resolved;
  }

  // ARRAY.map(...) or ARRAY.forEach(...)
  const iterMatch = content.match(/(\w+)\s*\.\s*(?:map|forEach)\s*\(/);
  if (iterMatch) {
    const resolved = ctx.get(iterMatch[1]!);
    if (resolved) return resolved;
  }

  return null;
}

function detectMultipliers(content: string): MultiplierMatch[] {
  const multipliers: MultiplierMatch[] = [];
  const ctx = extractNumericContext(content);

  // ── for (i = 0; i < BOUND; i++) loops ──
  const forLoopRegex = /for\s*\(.*;\s*\w+\s*(?:<|<=)\s*([\w.]+)/g;
  const forLoopMatch = forLoopRegex.exec(content);
  if (forLoopMatch) {
    const boundExpr = forLoopMatch[1]!;
    const resolved = resolveLoopBound(boundExpr, content, ctx);
    if (resolved && resolved > 1) {
      multipliers.push({ label: `for loop (${resolved} iterations)`, factor: resolved });
    } else {
      // Couldn't resolve — check if the bound var name hints at size
      const hintMatch = content.match(new RegExp(`(?:const|let|var)\\s+${boundExpr}\\s*=\\s*(\\w+)\\.length`));
      if (hintMatch) {
        const arrayName = hintMatch[1]!;
        const arraySize = ctx.get(arrayName);
        if (arraySize && arraySize > 1) {
          multipliers.push({ label: `for loop (${arraySize} iterations via ${arrayName}.length)`, factor: arraySize });
        } else {
          multipliers.push({ label: `for loop (${arrayName}.length — variable bound)`, factor: 10 });
        }
      } else {
        multipliers.push({ label: "for loop (variable bound)", factor: 10 });
      }
    }
  }

  // ── .map() / .forEach() ──
  if (/\.\s*map\s*\(\s*(async\s*)?\(/g.test(content)) {
    const size = resolveIterableSize(content, ctx);
    if (size && size > 1) {
      multipliers.push({ label: `.map() over ${size} items`, factor: size });
    } else {
      multipliers.push({ label: ".map() iteration", factor: 10 });
    }
  } else if (/\.\s*forEach\s*\(\s*(async\s*)?\(/g.test(content)) {
    const size = resolveIterableSize(content, ctx);
    if (size && size > 1) {
      multipliers.push({ label: `.forEach() over ${size} items`, factor: size });
    } else {
      multipliers.push({ label: ".forEach() iteration", factor: 10 });
    }
  }

  // ── for...of / for...in ──
  if (/for\s*\(\s*(const|let|var)\s+\w+\s+(of|in)\s+/g.test(content)) {
    const size = resolveIterableSize(content, ctx);
    if (size && size > 1) {
      multipliers.push({ label: `for...of over ${size} items`, factor: size });
    } else {
      multipliers.push({ label: "for...of/in loop", factor: 10 });
    }
  }

  // ── Promise.all ──
  if (/Promise\.all\s*\(/g.test(content)) {
    // Promise.all usually wraps a .map() — don't double-count if .map() was already detected
    const hasMap = multipliers.some((m) => m.label.includes(".map()"));
    if (!hasMap) {
      multipliers.push({ label: "Promise.all (parallel batch)", factor: 10 });
    }
  }

  // ── Cron patterns ──
  if (/cron|schedule|interval|setInterval|every\s+(?:\d+|other)\s*(min|hour|day|sec|week)/gi.test(content)) {
    if (/every\s+5\s*min/gi.test(content) || /\*\/5\s+\*\s+\*/g.test(content)) {
      multipliers.push({ label: "cron: every 5 minutes", factor: 8640 });
    } else if (/every\s+15\s*min/gi.test(content) || /\*\/15\s+\*\s+\*/g.test(content)) {
      multipliers.push({ label: "cron: every 15 minutes", factor: 2880 });
    } else if (/every\s+30\s*min/gi.test(content) || /\*\/30\s+\*\s+\*/g.test(content)) {
      multipliers.push({ label: "cron: every 30 minutes", factor: 1440 });
    } else if (/every\s+1?\s*hour/gi.test(content) || /0\s+\*\s+\*\s+\*/g.test(content)) {
      multipliers.push({ label: "cron: hourly", factor: 720 });
    } else if (/every\s+(\d+)\s*hours?/gi.test(content)) {
      const hoursMatch = content.match(/every\s+(\d+)\s*hours?/i);
      const hours = parseInt(hoursMatch![1]!, 10);
      const factor = Math.round(720 / hours);
      multipliers.push({ label: `cron: every ${hours} hours`, factor });
    } else if (/every\s+other\s+day|every\s+2\s*days?/gi.test(content) || /\*\/2\s+/g.test(content)) {
      multipliers.push({ label: "cron: every other day", factor: 15 });
    } else if (/every\s+(\d+)\s*days?/gi.test(content)) {
      const daysMatch = content.match(/every\s+(\d+)\s*days?/i);
      const days = parseInt(daysMatch![1]!, 10);
      const factor = Math.round(30 / days);
      multipliers.push({ label: `cron: every ${days} days`, factor });
    } else if (/every\s+1?\s*day/gi.test(content) || /0\s+0\s+\*\s+\*/g.test(content)) {
      multipliers.push({ label: "cron: daily", factor: 30 });
    } else if (/every\s+1?\s*week/gi.test(content) || /0\s+0\s+\*\s+\*\s+0/g.test(content)) {
      multipliers.push({ label: "cron: weekly", factor: 4 });
    } else {
      multipliers.push({ label: "scheduled execution", factor: 30 });
    }
  }

  // ── Batch size hints ──
  const batchMatch = content.match(/batch[_\s]?size\s*[=:]\s*(\d+)/i);
  if (batchMatch) {
    const batchSize = parseInt(batchMatch[1]!);
    if (batchSize > 1) {
      multipliers.push({ label: `batch size: ${batchSize}`, factor: batchSize });
    }
  }

  // ── Explicit count/total/limit constants ──
  // Catch patterns like: const TOTAL_PAGES = 1000, const NUM_REQUESTS = 500
  for (const [name, value] of ctx) {
    if (value >= 100 && /^(total|count|num|max|limit|size|pages|items|urls|batch)/i.test(name)) {
      // Only add if we didn't already detect this from a loop/map
      const alreadyCovered = multipliers.some((m) => m.factor === value);
      if (!alreadyCovered) {
        multipliers.push({ label: `${name} = ${value}`, factor: value });
      }
    }
  }

  return multipliers;
}

// ── Manifest-based cost computation ─────────────────────────────────

/**
 * Detect which variant of a billing dimension is being used in the code.
 * Returns the matching variant, or the default variant, or undefined.
 */
function detectVariant(
  dimension: BillingDimension,
  content: string,
): DimensionVariant | undefined {
  if (!dimension.variants || dimension.variants.length === 0) return undefined;

  // Try to match code patterns for each variant
  for (const variant of dimension.variants) {
    if (!variant.codePatterns) continue;
    for (const pattern of variant.codePatterns) {
      try {
        if (new RegExp(pattern, "i").test(content)) {
          return variant;
        }
      } catch {
        // Skip invalid regex
      }
    }
  }

  // Fall back to default variant
  return dimension.variants.find((v) => v.isDefault);
}

/**
 * Detect active cost multipliers from the manifest based on code patterns.
 * Returns { low, high, explanation } similar to the old GOTCHA_MULTIPLIERS.
 */
function detectManifestMultipliers(
  manifest: BillingManifest,
  content: string,
): { low: number; high: number; explanation: string } | undefined {
  if (!manifest.costMultipliers || manifest.costMultipliers.length === 0) {
    return undefined;
  }

  let maxFactor = 1;
  const activeNames: string[] = [];

  for (const cm of manifest.costMultipliers) {
    if (!cm.codePatterns) continue;
    for (const pattern of cm.codePatterns) {
      try {
        if (new RegExp(pattern, "i").test(content)) {
          maxFactor = Math.max(maxFactor, cm.factor);
          activeNames.push(cm.name);
          break; // One match per multiplier is enough
        }
      } catch {
        // Skip invalid regex
      }
    }
  }

  if (activeNames.length === 0) return undefined;

  return {
    low: 1,
    high: maxFactor,
    explanation: activeNames.join(", "),
  };
}

/**
 * Compute the per-call cost using billing manifest data.
 * Uses variant detection to pick the right rate from the manifest.
 */
function computeManifestPerCallCost(
  manifest: BillingManifest,
  content: string,
): { perCall: number; explanation: string } {
  // Sum across all billing dimensions (e.g., input_tokens + output_tokens)
  let totalPerCall = 0;
  const parts: string[] = [];

  const unitsPerCall = manifest.typicalDevUsage?.unitsPerCall ?? 1;

  for (const dim of manifest.billingDimensions) {
    const variant = detectVariant(dim, content);
    const ratePerUnit = variant?.ratePerUnit ?? dim.ratePerUnit;
    const ratePer = variant?.ratePer ?? dim.ratePer ?? 1;

    // cost = (units / ratePer) * ratePerUnit
    const dimCostPerCall = (unitsPerCall / ratePer) * ratePerUnit;

    if (dimCostPerCall > 0) {
      totalPerCall += dimCostPerCall;
      const variantLabel = variant?.name ?? dim.name;
      parts.push(variantLabel);
    }
  }

  return {
    perCall: totalPerCall,
    explanation: parts.length > 0 ? parts.join(" + ") : manifest.name,
  };
}

// ── Legacy fallback (services without manifests) ────────────────────

const LEGACY_GOTCHA_MULTIPLIERS: Record<string, { low: number; high: number; explanation: string }> = {};

const LEGACY_CALL_COSTS: Record<string, number> = {
  firebase: 0.0001,
  twilio: 0.01,
  sendgrid: 0.001,
  "mongodb-atlas": 0.0001,
  clerk: 0,
  replicate: 0.01,
};

// ── Main analysis function ──────────────────────────────────────────

/**
 * Analyze a file's content for cost-impacting SDK calls.
 * Uses billing manifests for precise per-model/per-variant pricing.
 * Falls back to registry pricing for services without manifests.
 */
export function analyzeCostImpact(
  filePath: string,
  content: string,
  projectRoot?: string,
): CostImpact[] {
  // Only analyze source files
  if (!/\.(ts|tsx|js|jsx|mjs|cjs|py)$/.test(filePath)) {
    return [];
  }

  const registry = loadRegistry(projectRoot);
  const manifests = loadBillingManifests();
  const impacts: CostImpact[] = [];
  const multipliers = detectMultipliers(content);

  for (const [serviceId, patterns] of Object.entries(SERVICE_CALL_PATTERNS)) {
    let totalCalls = 0;

    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      const matches = content.match(pattern);
      if (matches) {
        totalCalls += matches.length;
      }
    }

    if (totalCalls === 0) continue;

    const service = registry.get(serviceId);
    if (!service) continue;

    // Calculate effective multiplier from code structure (loops, map, cron, etc.)
    const multiplierFactor = multipliers.length > 0
      ? multipliers.reduce((max, m) => Math.max(max, m.factor), 1)
      : 1;

    const manifest = manifests.get(serviceId);

    // Smarter monthly run estimation:
    // - Cron: multiplier already encodes frequency, just 1 base run
    // - Manifest typicalDevUsage: use callsPerDevHour × 8h × 22 days
    // - Fallback: 50 runs/month (conservative)
    let baseMonthlyRuns: number;
    const isCron = multipliers.some((m) => m.label.startsWith("cron"));

    if (isCron) {
      baseMonthlyRuns = 1; // cron multiplier factor already encodes frequency
    } else if (manifest?.typicalDevUsage?.callsPerDevHour && manifest.typicalDevUsage.callsPerDevHour > 0) {
      // ~22 working days, ~6 active dev hours/day = 132 dev hours/month
      // But we're counting call sites, not dev hours, so normalize:
      // If the dev makes N calls/hour and we see K call sites, estimate K invocations per dev run
      baseMonthlyRuns = 132; // dev-hours per month
    } else {
      baseMonthlyRuns = 50; // fallback: ~2 runs per working day
    }

    const monthlyInvocations = totalCalls * multiplierFactor * baseMonthlyRuns;

    let costLow: number;
    let costHigh: number;
    let rangeExplanation: string | undefined;

    if (manifest) {
      // ── Manifest-based pricing ──
      const { perCall } = computeManifestPerCallCost(manifest, content);
      const gotcha = detectManifestMultipliers(manifest, content);

      costLow = monthlyInvocations * perCall * (gotcha?.low ?? 1);
      costHigh = monthlyInvocations * perCall * (gotcha?.high ?? 1);
      rangeExplanation = gotcha?.explanation;

      // If no cost multipliers detected but manifest has them, show the range
      if (!gotcha && manifest.costMultipliers && manifest.costMultipliers.length > 0) {
        const maxFactor = Math.max(...manifest.costMultipliers.map((m) => m.factor));
        if (maxFactor > 1) {
          costHigh = monthlyInvocations * perCall * maxFactor;
          rangeExplanation = manifest.costMultipliers.map((m) => m.description).join("; ");
        }
      }
    } else {
      // ── Legacy fallback (no manifest) ──
      const gotcha = LEGACY_GOTCHA_MULTIPLIERS[serviceId];
      const unitRate = service.pricing?.unitRate ?? 0;

      if (unitRate > 0) {
        costLow = monthlyInvocations * unitRate * (gotcha?.low ?? 1);
        costHigh = monthlyInvocations * unitRate * (gotcha?.high ?? 1);
      } else if (service.pricing?.monthlyBase !== undefined && service.pricing.monthlyBase > 0) {
        // Flat-rate services — cost is the plan, not per-invocation
        costLow = 0;
        costHigh = 0;
      } else {
        const perCall = LEGACY_CALL_COSTS[serviceId] ?? 0.001;
        costLow = monthlyInvocations * perCall * (gotcha?.low ?? 1);
        costHigh = monthlyInvocations * perCall * (gotcha?.high ?? 1);
      }

      rangeExplanation = gotcha?.explanation;
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
      rangeExplanation,
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
