import type { BillingConnector, BillingResult } from "./base.js";
import { fetchJson } from "./base.js";

/**
 * Vercel billing connector.
 * Uses the Vercel billing API.
 * Requires a Vercel token (personal or team-scoped).
 */
export const vercelConnector: BillingConnector = {
  serviceId: "vercel",

  async fetchSpend(
    token: string,
    options?: Record<string, string>,
  ): Promise<BillingResult> {
    const teamId = options?.["teamId"] ?? "";
    const teamParam = teamId ? `?teamId=${teamId}` : "";

    // Fetch current billing period usage
    const url = `https://api.vercel.com/v2/usage${teamParam}`;

    const result = await fetchJson<{
      usage?: {
        total?: number;
        bandwidth?: { total?: number };
        serverlessFunctionExecution?: { total?: number };
        edgeFunctionExecution?: { total?: number };
        imageOptimization?: { total?: number };
      };
      billing?: {
        plan?: string;
        period?: { start?: string; end?: string };
        invoiceItems?: Array<{ amount?: number }>;
      };
    }>(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!result.ok || !result.data) {
      return {
        serviceId: "vercel",
        spend: 0,
        isEstimate: true,
        tier: "est",
        error: result.error ?? "Failed to fetch Vercel usage",
      };
    }

    // Sum up usage costs
    let totalSpend = 0;
    if (result.data.usage?.total !== undefined) {
      totalSpend = result.data.usage.total;
    } else if (result.data.billing?.invoiceItems) {
      totalSpend = result.data.billing.invoiceItems.reduce(
        (sum, item) => sum + (item.amount ?? 0),
        0,
      );
    }

    return {
      serviceId: "vercel",
      spend: totalSpend,
      isEstimate: false,
      tier: "live",
      raw: result.data as unknown as Record<string, unknown>,
    };
  },
};
