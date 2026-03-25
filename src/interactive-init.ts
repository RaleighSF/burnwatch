/**
 * Interactive init flow for burnwatch.
 *
 * Groups detected services by risk category, presents plan tiers,
 * and collects user choices via Node readline.
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
  llm: "🤖 LLM / AI Services (highest variable cost)",
  usage: "📊 Usage-Based Services",
  infra: "🏗️  Infrastructure & Compute",
  flat: "📦 Flat-Rate / Free Tier Services",
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

export interface InteractiveInitResult {
  services: Record<string, TrackedService>;
}

/**
 * Run the interactive init flow.
 * Shows detected services grouped by risk, lets user pick plans.
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
    "\n📋 Let's configure each detected service. Services are grouped by cost risk.\n",
  );

  for (const category of RISK_ORDER) {
    const group = groups.get(category)!;
    if (group.length === 0) continue;

    console.log(`\n${RISK_LABELS[category]}`);
    console.log("─".repeat(50));

    for (const det of group) {
      const service = det.service;
      const plans = service.plans;

      console.log(`\n  ${service.name}`);
      console.log(`  Detected via: ${det.details.join(", ")}`);

      if (!plans || plans.length === 0) {
        // No plans defined — fall back to basic tracking
        services[service.id] = {
          serviceId: service.id,
          detectedVia: det.sources,
          hasApiKey: false,
          firstDetected: new Date().toISOString(),
        };
        console.log("  → Auto-configured (no plan tiers available)");
        continue;
      }

      // Show plan options
      const defaultIndex = plans.findIndex((p) => p.default);
      console.log("");
      for (let i = 0; i < plans.length; i++) {
        const plan = plans[i]!;
        const marker = i === defaultIndex ? " (recommended)" : "";
        const costStr =
          plan.type === "exclude"
            ? ""
            : plan.monthlyBase !== undefined
              ? ` — $${plan.monthlyBase}/mo`
              : " — variable";
        console.log(`    ${i + 1}) ${plan.name}${costStr}${marker}`);
      }

      const defaultChoice =
        defaultIndex >= 0 ? String(defaultIndex + 1) : "1";
      const answer = await ask(
        rl,
        `  Choose [${defaultChoice}]: `,
      );

      const choiceIndex = (answer === "" ? parseInt(defaultChoice) : parseInt(answer)) - 1;
      const chosen =
        plans[choiceIndex] ?? plans[defaultIndex >= 0 ? defaultIndex : 0]!;

      if (chosen.type === "exclude") {
        // Explicitly excluded
        services[service.id] = {
          serviceId: service.id,
          detectedVia: det.sources,
          hasApiKey: false,
          firstDetected: new Date().toISOString(),
          excluded: true,
          planName: chosen.name,
        };
        console.log(`  → ${service.name}: excluded from tracking`);
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
        // Auto-set budget to plan cost for paid flat plans
        if (chosen.monthlyBase > 0) {
          tracked.budget = chosen.monthlyBase;
        }
      }

      // If the service has a billing API, offer to provide a key
      if (service.apiTier === "live" || chosen.requiresKey) {
        // Check if we already have a key in global config
        const existingKey = globalConfig.services[service.id]?.apiKey;
        if (existingKey) {
          console.log(`  🔐 Using existing API key from global config`);
          tracked.hasApiKey = true;

          // Auto-detect plan for Scrapfly
          if (service.autoDetectPlan && service.id === "scrapfly") {
            console.log("  🔍 Auto-detecting plan from API...");
            const planName = await autoDetectScrapflyPlan(existingKey);
            if (planName) {
              console.log(`  → Detected plan: ${planName}`);
              tracked.planName = planName;
            }
          }
        } else if (chosen.requiresKey) {
          const keyAnswer = await ask(
            rl,
            `  Enter API key (or press Enter to skip): `,
          );
          if (keyAnswer) {
            tracked.hasApiKey = true;
            if (!globalConfig.services[service.id]) {
              globalConfig.services[service.id] = {};
            }
            globalConfig.services[service.id]!.apiKey = keyAnswer;

            // Auto-detect plan for Scrapfly
            if (service.autoDetectPlan && service.id === "scrapfly") {
              console.log("  🔍 Auto-detecting plan from API...");
              const planName = await autoDetectScrapflyPlan(keyAnswer);
              if (planName) {
                console.log(`  → Detected plan: ${planName}`);
                tracked.planName = planName;
              }
            }
          }
        }
      }

      // Always ask for budget if not already set to a meaningful value
      if (tracked.budget === undefined || tracked.budget === 0) {
        const suggestion = chosen.monthlyBase && chosen.monthlyBase > 0
          ? ` [${chosen.monthlyBase}]`
          : "";
        const budgetAnswer = await ask(
          rl,
          `  Monthly budget in USD${suggestion} (or press Enter to skip): $`,
        );
        if (budgetAnswer) {
          const budget = parseFloat(budgetAnswer);
          if (!isNaN(budget)) {
            tracked.budget = budget;
          }
        }
      }

      services[service.id] = tracked;

      const tierLabel = tracked.hasApiKey
        ? "✅ LIVE"
        : tracked.planCost !== undefined
          ? "🟡 CALC"
          : "🔴 BLIND";
      const budgetStr = tracked.budget !== undefined ? ` | Budget: $${tracked.budget}/mo` : "";
      console.log(
        `  → ${service.name}: ${chosen.name} (${tierLabel}${budgetStr})`,
      );
    }
  }

  // Save any collected API keys
  writeGlobalConfig(globalConfig);

  rl.close();

  return { services };
}
