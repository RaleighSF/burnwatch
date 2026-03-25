/**
 * Interactive init flow for burnwatch.
 *
 * Conducts a per-service interview: detects what it can automatically
 * (existing API keys, env vars), asks for plan selection, collects
 * API keys for LIVE tracking, and ensures every service exits with
 * a budget. No skipping.
 */

import * as readline from "node:readline";
import type {
  ServiceDefinition,
  PlanTier,
  TrackedService,
  ServiceRiskCategory,
} from "./core/types.js";
import type { DetectionResult } from "./detection/detector.js";
import { readGlobalConfig, writeGlobalConfig } from "./core/config.js";
import { fetchJson } from "./services/base.js";

/** Risk categories in display order: LLMs first, then usage-based, infra, flat-rate */
const RISK_ORDER: ServiceRiskCategory[] = ["llm", "usage", "infra", "flat"];

const RISK_LABELS: Record<ServiceRiskCategory, string> = {
  llm: "LLM / AI Services (highest variable cost)",
  usage: "Usage-Based Services",
  infra: "Infrastructure & Compute",
  flat: "Flat-Rate / Free Tier Services",
};

/** Where to find API keys for LIVE-capable services */
const API_KEY_HINTS: Record<string, string> = {
  anthropic: "Admin key: console.anthropic.com -> Settings -> Admin API Keys",
  openai: "Org key: platform.openai.com -> Settings -> API Keys",
  vercel: "Token: vercel.com/account/tokens",
  supabase: "Service role key: supabase.com/dashboard -> Settings -> API",
  stripe: "Secret key: dashboard.stripe.com -> Developers -> API Keys",
  scrapfly: "API key: scrapfly.io/dashboard",
};

/** Map service IDs to risk categories */
function classifyRisk(service: ServiceDefinition): ServiceRiskCategory {
  if (service.billingModel === "token_usage") return "llm";
  if (
    service.billingModel === "credit_pool" ||
    service.billingModel === "percentage" ||
    service.billingModel === "per_unit"
  )
    return "usage";
  if (service.billingModel === "compute") return "infra";
  return "flat";
}

/** Group detection results by risk category */
function groupByRisk(
  detected: DetectionResult[],
): Map<ServiceRiskCategory, DetectionResult[]> {
  const groups = new Map<ServiceRiskCategory, DetectionResult[]>();
  for (const cat of RISK_ORDER) {
    groups.set(cat, []);
  }

  for (const det of detected) {
    const cat = classifyRisk(det.service);
    groups.get(cat)!.push(det);
  }

  return groups;
}

/** Prompt the user with a question and return their answer */
function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

/** Try to auto-detect plan from Scrapfly API */
async function autoDetectScrapflyPlan(
  apiKey: string,
): Promise<string | null> {
  try {
    const result = await fetchJson<{
      subscription?: { plan?: { name?: string } };
    }>(`https://api.scrapfly.io/account?key=${apiKey}`);

    if (result.ok && result.data?.subscription?.plan?.name) {
      return result.data.subscription.plan.name;
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/** Scan environment for API keys matching service env patterns */
function findEnvKey(service: ServiceDefinition): string | undefined {
  for (const pattern of service.envPatterns) {
    const val = process.env[pattern];
    if (val && val.length > 0) return val;
  }
  return undefined;
}

export interface InteractiveInitResult {
  services: Record<string, TrackedService>;
}

/**
 * Auto-configure all services without prompts.
 *
 * Applies the same logic as the interactive interview but picks
 * defaults automatically: default plan, env var keys, budget = plan cost.
 * Used when stdin is not a TTY (e.g., Claude Code, piped input).
 */
export function autoConfigureServices(
  detected: DetectionResult[],
): InteractiveInitResult {
  const services: Record<string, TrackedService> = {};
  const groups = groupByRisk(detected);
  const globalConfig = readGlobalConfig();

  console.log(
    `\n  Found ${detected.length} paid service${detected.length !== 1 ? "s" : ""}. Auto-configuring with defaults.\n`,
  );
  console.log("  Run 'burnwatch init' from your terminal for interactive setup.\n");

  for (const category of RISK_ORDER) {
    const group = groups.get(category)!;
    if (group.length === 0) continue;

    console.log(`  ${RISK_LABELS[category]}`);

    for (const det of group) {
      const service = det.service;
      const plans = service.plans ?? [];
      const defaultPlan = plans.find((p) => p.default) ?? plans[0];

      const tracked: TrackedService = {
        serviceId: service.id,
        detectedVia: det.sources,
        hasApiKey: false,
        firstDetected: new Date().toISOString(),
        budget: 0,
      };

      if (defaultPlan && defaultPlan.type !== "exclude") {
        tracked.planName = defaultPlan.name;

        if (defaultPlan.type === "flat" && defaultPlan.monthlyBase !== undefined) {
          tracked.planCost = defaultPlan.monthlyBase;
          tracked.budget = defaultPlan.monthlyBase;
        } else if (defaultPlan.suggestedBudget !== undefined) {
          tracked.budget = defaultPlan.suggestedBudget;
        }
      }

      // Check for existing API key in global config or environment
      const existingKey = globalConfig.services[service.id]?.apiKey;
      const envKey = findEnvKey(service);
      let keySource = "";

      if (existingKey) {
        tracked.hasApiKey = true;
        keySource = " (key: global config)";
      } else if (envKey) {
        tracked.hasApiKey = true;
        if (!globalConfig.services[service.id]) {
          globalConfig.services[service.id] = {};
        }
        globalConfig.services[service.id]!.apiKey = envKey;
        keySource = ` (key: ${service.envPatterns[0]})`;
      }

      const tierLabel = tracked.hasApiKey
        ? "LIVE"
        : tracked.planCost !== undefined
          ? "CALC"
          : "BLIND";
      const planStr = tracked.planName ? ` ${tracked.planName}` : "";
      console.log(
        `    ${service.name}:${planStr} | ${tierLabel} | $${tracked.budget}/mo${keySource}`,
      );

      services[service.id] = tracked;
    }
    console.log("");
  }

  // Summary
  const trackedList = Object.values(services);
  const liveCount = trackedList.filter((s) => s.hasApiKey).length;
  const totalBudget = trackedList.reduce((sum, s) => sum + (s.budget ?? 0), 0);

  console.log("  " + "-".repeat(48));
  console.log(`  ${trackedList.length} services configured | Total budget: $${totalBudget}/mo`);
  if (liveCount > 0) console.log(`  ${liveCount} with real-time billing (LIVE)`);
  console.log("");

  // Save discovered keys
  writeGlobalConfig(globalConfig);

  return { services };
}

/**
 * Run the interactive init flow.
 *
 * For each detected service:
 * 1. Ask which plan they're on
 * 2. If LIVE-capable, check for existing key or ask for one
 * 3. Set budget (defaults to plan cost, $0 for free - never skipped)
 */
export async function runInteractiveInit(
  detected: DetectionResult[],
): Promise<InteractiveInitResult> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const services: Record<string, TrackedService> = {};
  const groups = groupByRisk(detected);
  const globalConfig = readGlobalConfig();

  console.log(
    `\n  Found ${detected.length} paid service${detected.length !== 1 ? "s" : ""}. Let's configure each one.\n`,
  );

  for (const category of RISK_ORDER) {
    const group = groups.get(category)!;
    if (group.length === 0) continue;

    console.log(`\n  ${RISK_LABELS[category]}`);
    console.log("  " + "-".repeat(48));

    for (const det of group) {
      const service = det.service;
      const plans = service.plans;

      console.log(`\n  ${service.name}`);
      console.log(`  Detected via: ${det.details.join(", ")}`);

      if (!plans || plans.length === 0) {
        // No plans defined - basic tracking with $0 budget
        services[service.id] = {
          serviceId: service.id,
          detectedVia: det.sources,
          hasApiKey: false,
          firstDetected: new Date().toISOString(),
          budget: 0,
        };
        console.log("  -> Configured (no plan tiers in registry, budget: $0)");
        continue;
      }

      // --- Plan selection ---
      const defaultIndex = plans.findIndex((p) => p.default);
      console.log("");
      for (let i = 0; i < plans.length; i++) {
        const plan = plans[i]!;
        const marker = i === defaultIndex ? " *" : "";
        const costStr =
          plan.type === "exclude"
            ? ""
            : plan.monthlyBase !== undefined
              ? ` - $${plan.monthlyBase}/mo`
              : " - variable";
        console.log(`    ${i + 1}) ${plan.name}${costStr}${marker}`);
      }

      const defaultChoice =
        defaultIndex >= 0 ? String(defaultIndex + 1) : "1";
      const answer = await ask(
        rl,
        `  Which plan? [${defaultChoice}]: `,
      );

      const choiceIndex = (answer === "" ? parseInt(defaultChoice) : parseInt(answer)) - 1;
      const chosen =
        plans[choiceIndex] ?? plans[defaultIndex >= 0 ? defaultIndex : 0]!;

      if (chosen.type === "exclude") {
        services[service.id] = {
          serviceId: service.id,
          detectedVia: det.sources,
          hasApiKey: false,
          firstDetected: new Date().toISOString(),
          excluded: true,
          planName: chosen.name,
        };
        console.log(`  -> ${service.name}: excluded`);
        continue;
      }

      const tracked: TrackedService = {
        serviceId: service.id,
        detectedVia: det.sources,
        hasApiKey: false,
        firstDetected: new Date().toISOString(),
        planName: chosen.name,
      };

      if (chosen.type === "flat" && chosen.monthlyBase !== undefined) {
        tracked.planCost = chosen.monthlyBase;
      }

      // --- API key (LIVE-capable services) ---
      if (service.apiTier === "live") {
        const existingKey = globalConfig.services[service.id]?.apiKey;
        const envKey = findEnvKey(service);

        if (existingKey) {
          console.log(`  API key: found in global config`);
          tracked.hasApiKey = true;
        } else if (envKey) {
          console.log(`  API key: found in environment (${service.envPatterns[0]})`);
          tracked.hasApiKey = true;
          if (!globalConfig.services[service.id]) {
            globalConfig.services[service.id] = {};
          }
          globalConfig.services[service.id]!.apiKey = envKey;
        } else {
          const hint = API_KEY_HINTS[service.id];
          if (hint) console.log(`  ${hint}`);
          const keyAnswer = await ask(
            rl,
            `  API key for real-time tracking (Enter to skip): `,
          );
          if (keyAnswer) {
            tracked.hasApiKey = true;
            if (!globalConfig.services[service.id]) {
              globalConfig.services[service.id] = {};
            }
            globalConfig.services[service.id]!.apiKey = keyAnswer;
          }
        }

        // Auto-detect plan for Scrapfly
        if (service.autoDetectPlan && service.id === "scrapfly" && tracked.hasApiKey) {
          const key = globalConfig.services[service.id]?.apiKey;
          if (key) {
            console.log("  Detecting plan from API...");
            const planName = await autoDetectScrapflyPlan(key);
            if (planName) {
              console.log(`  -> Detected plan: ${planName}`);
              tracked.planName = planName;
            }
          }
        }
      }

      // --- Budget (always set, never skip) ---
      const defaultBudget = chosen.monthlyBase ?? chosen.suggestedBudget ?? 0;

      const budgetAnswer = await ask(
        rl,
        `  Monthly budget [$${defaultBudget}]: $`,
      );
      if (budgetAnswer) {
        const parsed = parseFloat(budgetAnswer);
        tracked.budget = !isNaN(parsed) ? parsed : defaultBudget;
      } else {
        tracked.budget = defaultBudget;
      }

      services[service.id] = tracked;

      const tierLabel = tracked.hasApiKey
        ? "LIVE"
        : tracked.planCost !== undefined
          ? "CALC"
          : "BLIND";
      console.log(
        `  -> ${service.name}: ${tracked.planName} | ${tierLabel} | $${tracked.budget}/mo`,
      );
    }
  }

  // --- Summary ---
  const tracked = Object.values(services).filter((s) => !s.excluded);
  const excluded = Object.values(services).filter((s) => s.excluded);
  const liveCount = tracked.filter((s) => s.hasApiKey).length;
  const totalBudget = tracked.reduce((sum, s) => sum + (s.budget ?? 0), 0);

  console.log("\n  " + "=".repeat(48));
  console.log(`  ${tracked.length} services configured`);
  if (liveCount > 0) console.log(`    ${liveCount} with real-time billing (LIVE)`);
  if (tracked.length - liveCount > 0) console.log(`    ${tracked.length - liveCount} estimated/calculated`);
  if (excluded.length > 0) console.log(`    ${excluded.length} excluded`);
  console.log(`  Total monthly budget: $${totalBudget}`);
  console.log("  " + "=".repeat(48));

  // Save any collected API keys
  writeGlobalConfig(globalConfig);

  rl.close();

  return { services };
}
