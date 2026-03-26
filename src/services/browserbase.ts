import type { BillingConnector, BillingResult } from "./base.js";
import { fetchJson } from "./base.js";

/**
 * Browserbase billing connector.
 * Uses the /v1/projects endpoint to get usage data.
 * Requires an API key (X-BB-API-Key header).
 */
export const browserbaseConnector: BillingConnector = {
  serviceId: "browserbase",

  async fetchSpend(apiKey: string): Promise<BillingResult> {
    // Step 1: List projects to get the project ID
    const projectsResult = await fetchJson<
      Array<{
        id?: string;
        name?: string;
      }>
    >("https://api.browserbase.com/v1/projects", {
      headers: {
        "X-BB-API-Key": apiKey,
      },
    });

    if (!projectsResult.ok || !projectsResult.data) {
      return {
        serviceId: "browserbase",
        spend: 0,
        isEstimate: true,
        tier: "est",
        error: projectsResult.error ?? "Failed to fetch Browserbase projects",
      };
    }

    const project = projectsResult.data[0];
    if (!project?.id) {
      return {
        serviceId: "browserbase",
        spend: 0,
        isEstimate: true,
        tier: "est",
        error: "No Browserbase project found",
      };
    }

    // Step 2: Get usage for the project
    const usageResult = await fetchJson<{
      total_sessions?: number;
      total_minutes?: number;
      total_hours?: number;
      usage?: {
        sessions?: number;
        minutes?: number;
        hours?: number;
      };
    }>(`https://api.browserbase.com/v1/projects/${project.id}/usage`, {
      headers: {
        "X-BB-API-Key": apiKey,
      },
    });

    if (!usageResult.ok || !usageResult.data) {
      return {
        serviceId: "browserbase",
        spend: 0,
        isEstimate: true,
        tier: "est",
        error: "Projects found but usage endpoint failed",
      };
    }

    // Calculate spend from browser minutes
    // Browserbase charges ~$0.10/min on Developer plan
    const minutes = usageResult.data.total_minutes
      ?? usageResult.data.usage?.minutes
      ?? (usageResult.data.total_hours ?? usageResult.data.usage?.hours ?? 0) * 60;
    const sessionCount = usageResult.data.total_sessions ?? usageResult.data.usage?.sessions ?? 0;

    const minuteRate = 0.10; // $0.10/min on Developer plan
    const spend = minutes * minuteRate;

    return {
      serviceId: "browserbase",
      spend,
      isEstimate: false,
      tier: "live",
      unitsUsed: sessionCount,
      unitName: "sessions",
      raw: {
        minutes,
        sessions: sessionCount,
        minute_rate: minuteRate,
        ...(usageResult.data as unknown as Record<string, unknown>),
      },
    };
  },
};
