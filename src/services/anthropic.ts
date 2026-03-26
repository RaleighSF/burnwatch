import type { BillingConnector, BillingResult } from "./base.js";
import { fetchJson } from "./base.js";

/**
 * Anthropic billing connector.
 * Uses the Admin API cost_report endpoint for USD spend data.
 * Requires an Admin API key (sk-ant-admin-*).
 *
 * Docs: https://platform.claude.com/docs/en/build-with-claude/usage-cost-api
 */
export const anthropicConnector: BillingConnector = {
  serviceId: "anthropic",

  async fetchSpend(apiKey: string): Promise<BillingResult> {
    // Get current month date range in RFC 3339 format
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startingAt = startOfMonth.toISOString();
    const endingAt = now.toISOString();

    const url = `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${encodeURIComponent(startingAt)}&ending_at=${encodeURIComponent(endingAt)}&bucket_width=1m`;

    const result = await fetchJson<{
      data?: Array<{
        starting_at?: string;
        ending_at?: string;
        results?: Array<{
          cost_usd?: number;
          model?: string;
        }>;
      }>;
      has_more?: boolean;
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
        error: result.error ?? "Failed to fetch Anthropic cost report",
      };
    }

    // Sum cost_usd across all time buckets and models
    let totalSpend = 0;
    if (result.data.data) {
      for (const bucket of result.data.data) {
        if (bucket.results) {
          for (const entry of bucket.results) {
            totalSpend += entry.cost_usd ?? 0;
          }
        }
      }
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
