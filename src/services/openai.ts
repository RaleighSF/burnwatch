import type { BillingConnector, BillingResult } from "./base.js";
import { fetchJson } from "./base.js";

/**
 * OpenAI billing connector.
 * Uses the /v1/organization/costs endpoint.
 * Requires an organization-level API key.
 */
export const openaiConnector: BillingConnector = {
  serviceId: "openai",

  async fetchSpend(apiKey: string): Promise<BillingResult> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    // OpenAI uses Unix timestamps
    const startTime = Math.floor(startOfMonth.getTime() / 1000);

    const url = `https://api.openai.com/v1/organization/costs?start_time=${startTime}`;

    const result = await fetchJson<{
      data?: Array<{
        results?: Array<{
          amount?: { value?: number };
        }>;
      }>;
      object?: string;
    }>(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!result.ok || !result.data) {
      return {
        serviceId: "openai",
        spend: 0,
        isEstimate: true,
        tier: "est",
        error: result.error ?? "Failed to fetch OpenAI usage",
      };
    }

    // Sum all cost buckets
    let totalSpend = 0;
    if (result.data.data) {
      for (const bucket of result.data.data) {
        if (bucket.results) {
          for (const r of bucket.results) {
            totalSpend += r.amount?.value ?? 0;
          }
        }
      }
    }

    // OpenAI returns costs in cents, convert to dollars
    totalSpend = totalSpend / 100;

    return {
      serviceId: "openai",
      spend: totalSpend,
      isEstimate: false,
      tier: "live",
      raw: result.data as unknown as Record<string, unknown>,
    };
  },
};
