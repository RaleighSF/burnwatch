import type { BillingConnector, BillingResult } from "./base.js";
import { fetchJson } from "./base.js";

/**
 * Supabase billing connector.
 * Uses the Management API to detect plan tier and project usage.
 * Requires a Personal Access Token (PAT), not the service_role key.
 */
export const supabaseConnector: BillingConnector = {
  serviceId: "supabase",

  async fetchSpend(token: string): Promise<BillingResult> {
    // Supabase Management API requires a PAT (sbp_*), not service_role key (eyJ*)
    if (token.startsWith("eyJ")) {
      return {
        serviceId: "supabase",
        spend: 0,
        isEstimate: true,
        tier: "est",
        error: "Key is a service_role JWT — needs a Personal Access Token (sbp_*) from supabase.com/dashboard → Account → Access Tokens",
      };
    }

    // Step 1: Get organizations to find plan tier
    const orgsResult = await fetchJson<
      Array<{
        id?: string;
        name?: string;
        billing?: {
          plan?: string;
          current_period_start?: string;
          current_period_end?: string;
        };
        subscription_id?: string;
      }>
    >("https://api.supabase.com/v1/organizations", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!orgsResult.ok || !orgsResult.data) {
      return {
        serviceId: "supabase",
        spend: 0,
        isEstimate: true,
        tier: "est",
        error: orgsResult.error ?? "Failed to fetch Supabase orgs — is this a PAT (not service_role key)?",
      };
    }

    const org = orgsResult.data[0];
    if (!org?.id) {
      return {
        serviceId: "supabase",
        spend: 0,
        isEstimate: true,
        tier: "est",
        error: "No Supabase organization found",
      };
    }

    // Step 2: Try to get billing/usage for the org
    const planName = org.billing?.plan ?? "unknown";

    // Map plan to monthly cost
    const planCosts: Record<string, number> = {
      free: 0,
      pro: 25,
      team: 599,
      enterprise: 0, // custom pricing
    };

    const baseCost = planCosts[planName.toLowerCase()] ?? 0;

    // Step 3: Try to get usage data for overage detection
    let totalSpend = baseCost;
    const usageResult = await fetchJson<{
      total_usage?: number;
      usage?: Array<{ metric?: string; usage?: number; cost?: number }>;
    }>(`https://api.supabase.com/v1/organizations/${org.id}/usage`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (usageResult.ok && usageResult.data) {
      // If we get usage data with costs, sum them up
      if (usageResult.data.usage) {
        const overageCost = usageResult.data.usage.reduce(
          (sum, item) => sum + (item.cost ?? 0),
          0,
        );
        if (overageCost > 0) totalSpend = baseCost + overageCost;
      } else if (usageResult.data.total_usage !== undefined) {
        totalSpend = usageResult.data.total_usage;
      }
    }

    return {
      serviceId: "supabase",
      spend: totalSpend,
      isEstimate: false,
      tier: "live",
      raw: {
        plan: planName,
        base_cost: baseCost,
        org_id: org.id,
        org_name: org.name,
        ...(usageResult.data as unknown as Record<string, unknown> ?? {}),
      },
    };
  },
};
