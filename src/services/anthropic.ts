import type { BillingConnector, BillingResult } from "./base.js";
import { fetchJson } from "./base.js";

/**
 * Anthropic billing connector.
 * Uses the /v1/organizations/usage endpoint.
 * Requires an admin API key.
 */
export const anthropicConnector: BillingConnector = {
  serviceId: "anthropic",

  async fetchSpend(apiKey: string): Promise<BillingResult> {
    // Get current month date range
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startDate = startOfMonth.toISOString().split("T")[0]!;
    const endDate = now.toISOString().split("T")[0]!;

    const url = `https://api.anthropic.com/v1/organizations/usage?start_date=${startDate}&end_date=${endDate}`;

    const result = await fetchJson<{
      data?: Array<{ total_cost_usd?: number; spend?: number }>;
      total_cost_usd?: number;
    }>(url, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });

    if (!result.ok || !result.data) {
      return {
        serviceId: "anthropic",
        spend: 0,
        isEstimate: true,
        tier: "est",
        error: result.error ?? "Failed to fetch Anthropic usage",
      };
    }

    // Sum up usage across the period
    let totalSpend = 0;
    if (result.data.total_cost_usd !== undefined) {
      totalSpend = result.data.total_cost_usd;
    } else if (result.data.data) {
      totalSpend = result.data.data.reduce(
        (sum, entry) => sum + (entry.total_cost_usd ?? entry.spend ?? 0),
        0,
      );
    }

    return {
      serviceId: "anthropic",
      spend: totalSpend,
      isEstimate: false,
      tier: "live",
      raw: result.data as unknown as Record<string, unknown>,
    };
  },
};
