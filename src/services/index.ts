import type { BillingConnector, BillingResult } from "./base.js";
import { anthropicConnector } from "./anthropic.js";
import { openaiConnector } from "./openai.js";
import { vercelConnector } from "./vercel.js";
import { scrapflyConnector } from "./scrapfly.js";
import type { TrackedService, ConfidenceTier } from "../core/types.js";
import { readGlobalConfig } from "../core/config.js";
import { getService } from "../core/registry.js";

/** All available billing connectors, keyed by service ID. */
const connectors: Map<string, BillingConnector> = new Map([
  ["anthropic", anthropicConnector],
  ["openai", openaiConnector],
  ["vercel", vercelConnector],
  ["scrapfly", scrapflyConnector],
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

  // If we have a connector and an API key, try LIVE
  if (connector && serviceConfig?.apiKey) {
    try {
      const result = await connector.fetchSpend(
        serviceConfig.apiKey,
        serviceConfig as unknown as Record<string, string>,
      );
      if (!result.error) return result;
      // Fall through to lower tiers on error
    } catch {
      // Fall through
    }
  }

  // If user provided a plan cost, use CALC
  if (tracked.planCost !== undefined) {
    const now = new Date();
    const daysInMonth = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      0,
    ).getDate();
    const dayOfMonth = now.getDate();
    const projectedSpend = (tracked.planCost / daysInMonth) * dayOfMonth;

    return {
      serviceId: tracked.serviceId,
      spend: projectedSpend,
      isEstimate: true,
      tier: "calc",
    };
  }

  // If service is in registry but we have no key and no plan cost
  if (definition) {
    const tier: ConfidenceTier =
      tracked.tierOverride ?? definition.apiTier === "live"
        ? "blind" // Has a LIVE API but we don't have the key
        : definition.apiTier;

    return {
      serviceId: tracked.serviceId,
      spend: 0,
      isEstimate: true,
      tier,
      error: "No API key or plan cost configured",
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
