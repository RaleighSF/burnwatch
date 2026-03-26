import type { BillingConnector, BillingResult } from "./base.js";
import { anthropicConnector } from "./anthropic.js";
import { openaiConnector } from "./openai.js";
import { vercelConnector } from "./vercel.js";
import { scrapflyConnector } from "./scrapfly.js";
import { supabaseConnector } from "./supabase.js";
import { browserbaseConnector } from "./browserbase.js";
import type { TrackedService, ConfidenceTier } from "../core/types.js";
import { readGlobalConfig } from "../core/config.js";
import { getService } from "../core/registry.js";

/** All available billing connectors, keyed by service ID. */
const connectors: Map<string, BillingConnector> = new Map([
  ["anthropic", anthropicConnector],
  ["openai", openaiConnector],
  ["vercel", vercelConnector],
  ["scrapfly", scrapflyConnector],
  ["supabase", supabaseConnector],
  ["browserbase", browserbaseConnector],
]);

/**
 * Poll spend for a single tracked service.
 * Returns the best available data based on connector availability and API keys.
 */
export async function pollService(
  tracked: TrackedService,
): Promise<BillingResult> {
  const globalConfig = readGlobalConfig();
  const serviceConfig = globalConfig.services[tracked.serviceId];
  const connector = connectors.get(tracked.serviceId);
  const definition = getService(tracked.serviceId);

  // Resolve effective plan cost — try tracked.planCost first,
  // then fall back to matching plan's monthlyBase from registry
  let effectivePlanCost = tracked.planCost;
  let isFlatPlan = false;
  if (tracked.planName && definition?.plans) {
    const matchedPlan = definition.plans.find(
      (p) => p.name === tracked.planName || p.name.toLowerCase().includes((tracked.planName ?? "").toLowerCase()),
    );
    if (matchedPlan) {
      isFlatPlan = matchedPlan.type === "flat";
      if (effectivePlanCost === undefined && matchedPlan.monthlyBase !== undefined) {
        effectivePlanCost = matchedPlan.monthlyBase;
      }
    }
  }

  // For flat plans, show the full monthly cost (already paid).
  // For usage plans, prorate to day-of-month as a projection.
  const calcSpend = (cost: number): number => {
    if (isFlatPlan) return cost;
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return (cost / daysInMonth) * now.getDate();
  };

  // If we have a connector and an API key, try LIVE
  if (connector && serviceConfig?.apiKey) {
    try {
      const result = await connector.fetchSpend(
        serviceConfig.apiKey,
        serviceConfig as unknown as Record<string, string>,
      );
      if (!result.error) {
        // For LIVE services on flat plans, ensure spend is at least the plan cost
        // (the flat fee is already paid regardless of API usage)
        if (isFlatPlan && effectivePlanCost !== undefined) {
          if (result.spend < effectivePlanCost) {
            result.spend = effectivePlanCost;
          }
          // Flat cost is exact, not an estimate
          result.isEstimate = false;
        }
        result.isFlatPlan = isFlatPlan;
        return result;
      }
      // API returned an error — fall through to CALC if we have plan cost
      const fallbackSpend = effectivePlanCost !== undefined ? calcSpend(effectivePlanCost) : 0;
      return {
        serviceId: tracked.serviceId,
        spend: fallbackSpend,
        isEstimate: isFlatPlan ? false : true,
        tier: effectivePlanCost !== undefined ? "calc" : "blind",
        isFlatPlan,
        error: `LIVE failed (${result.error}) — showing ${effectivePlanCost !== undefined ? "CALC" : "BLIND"} fallback`,
      };
    } catch (err) {
      // Connector threw — return with error context
      const fallbackSpend = effectivePlanCost !== undefined ? calcSpend(effectivePlanCost) : 0;
      return {
        serviceId: tracked.serviceId,
        spend: fallbackSpend,
        isEstimate: isFlatPlan ? false : true,
        tier: effectivePlanCost !== undefined ? "calc" : "blind",
        isFlatPlan,
        error: `LIVE failed (${err instanceof Error ? err.message : "unknown"}) — showing ${effectivePlanCost !== undefined ? "CALC" : "BLIND"} fallback`,
      };
    }
  }

  // If connector exists and hasApiKey but no key found in global config, explain
  if (connector && tracked.hasApiKey && !serviceConfig?.apiKey) {
    const projectedSpend = effectivePlanCost !== undefined ? calcSpend(effectivePlanCost) : 0;
    return {
      serviceId: tracked.serviceId,
      spend: projectedSpend,
      isEstimate: isFlatPlan ? false : true,
      tier: effectivePlanCost !== undefined ? "calc" : "blind",
      isFlatPlan,
      error: "API key marked as configured but not found in ~/.config/burnwatch/ — re-run configure with --key",
    };
  }

  // If user provided a plan cost (or we resolved it from registry), use CALC
  if (effectivePlanCost !== undefined) {
    return {
      serviceId: tracked.serviceId,
      spend: calcSpend(effectivePlanCost),
      isEstimate: !isFlatPlan,
      tier: "calc",
      isFlatPlan,
    };
  }

  // If service is in registry but we have no key and no plan cost
  if (definition) {
    let tier: ConfidenceTier;
    if (tracked.tierOverride) {
      tier = tracked.tierOverride;
    } else if (definition.apiTier === "live") {
      // Has a LIVE API but we don't have the key — mark as BLIND
      tier = "blind";
    } else {
      // EST, CALC, or BLIND — use the registry's declared tier
      tier = definition.apiTier;
    }

    return {
      serviceId: tracked.serviceId,
      spend: 0,
      isEstimate: tier !== "live",
      tier,
      error: tier === "blind" ? "No API key configured" : undefined,
    };
  }

  // Completely unknown service
  return {
    serviceId: tracked.serviceId,
    spend: 0,
    isEstimate: true,
    tier: "blind",
    error: "Unknown service — not in registry",
  };
}

/**
 * Poll all tracked services concurrently.
 * Returns results in the same order as input.
 */
export async function pollAllServices(
  services: TrackedService[],
): Promise<BillingResult[]> {
  return Promise.all(services.map(pollService));
}

export { type BillingConnector, type BillingResult } from "./base.js";
