import type { BillingConnector, BillingResult } from "./base.js";
import { fetchJson } from "./base.js";

/**
 * Scrapfly billing connector.
 * Uses the /account endpoint which returns credits used/remaining.
 * Works with the standard API key — no special billing key needed.
 */
export const scrapflyConnector: BillingConnector = {
  serviceId: "scrapfly",

  async fetchSpend(apiKey: string): Promise<BillingResult> {
    const url = `https://api.scrapfly.io/account?key=${apiKey}`;

    const result = await fetchJson<{
      subscription?: {
        usage?: {
          scrape?: { used?: number; allowed?: number };
        };
      };
      account?: {
        credits_used?: number;
        credits_total?: number;
      };
    }>(url);

    if (!result.ok || !result.data) {
      return {
        serviceId: "scrapfly",
        spend: 0,
        isEstimate: true,
        tier: "est",
        error: result.error ?? "Failed to fetch Scrapfly account",
      };
    }

    // Extract credits used from the response
    let creditsUsed = 0;
    let creditsTotal = 0;

    if (result.data.subscription?.usage?.scrape) {
      creditsUsed = result.data.subscription.usage.scrape.used ?? 0;
      creditsTotal = result.data.subscription.usage.scrape.allowed ?? 0;
    } else if (result.data.account) {
      creditsUsed = result.data.account.credits_used ?? 0;
      creditsTotal = result.data.account.credits_total ?? 0;
    }

    // Convert credits to USD at registry rate
    const creditRate = 0.00015; // $0.00015 per credit
    const spend = creditsUsed * creditRate;

    return {
      serviceId: "scrapfly",
      spend,
      isEstimate: false,
      tier: "live",
      raw: {
        credits_used: creditsUsed,
        credits_total: creditsTotal,
        credit_rate: creditRate,
        ...(result.data as unknown as Record<string, unknown>),
      },
    };
  },
};
