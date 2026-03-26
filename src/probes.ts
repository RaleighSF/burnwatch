/**
 * Service probes — auto-detect plan, usage, and billing data from APIs.
 *
 * Each probe tries to discover as much as possible from a service's API:
 *   1. Plan tier (best case — "You're on Pro")
 *   2. Usage/spend data (good — "You've used 850K credits")
 *   3. Key validation (minimum — "Your key works")
 *
 * Probes are extensible: add a new entry to PROBES to support a new service.
 * The interview flow calls `probeService()` which looks up the right probe.
 */

import type { PlanTier } from "./core/types.js";
import { fetchJson } from "./services/base.js";

/** Result from probing a service API */
export interface ProbeResult {
  /** Detected plan name (should match a registry PlanTier.name prefix) */
  planName?: string;
  /** Matched PlanTier from the registry */
  matchedPlan?: PlanTier;
  /** Usage/spend data discovered */
  usage?: {
    unitsUsed?: number;
    unitsTotal?: number;
    unitName?: string;
    spend?: number;
    currency?: string;
  };
  /** Human-readable summary of what was found */
  summary: string;
  /**
   * Discovery confidence:
   *   high   — plan tier identified (can skip plan selection)
   *   medium — usage data found but plan unclear (show data, still ask plan)
   *   low    — key validates but no plan/usage info
   */
  confidence: "high" | "medium" | "low";
}

/** A probe function: given an API key and registry plans, discover what we can */
type ProbeFn = (
  apiKey: string,
  plans: PlanTier[],
) => Promise<ProbeResult | null>;

// ---------------------------------------------------------------------------
// Service-specific probes
// ---------------------------------------------------------------------------

/** Match a detected plan name against registry plans, disambiguating by $ amount if needed */
function matchPlan(
  detected: string,
  plans: PlanTier[],
): PlanTier | undefined {
  const lower = detected.toLowerCase();
  const candidates = plans.filter(
    (p) =>
      p.type !== "exclude" &&
      p.name.toLowerCase().includes(lower),
  );
  if (candidates.length <= 1) return candidates[0];

  // Try to disambiguate by $ amount in the detected string
  const dollarMatch = detected.match(/\$(\d+)/);
  if (dollarMatch) {
    const amount = parseInt(dollarMatch[1]!, 10);
    const byAmount = candidates.find((p) => p.monthlyBase === amount);
    if (byAmount) return byAmount;
  }

  // Default to first match
  return candidates[0];
}

/** Match by checking if the detected name appears as the first word of any plan, disambiguating by $ amount */
function matchPlanByPrefix(
  detected: string,
  plans: PlanTier[],
): PlanTier | undefined {
  const lower = detected.toLowerCase();
  const candidates = plans.filter((p) => {
    if (p.type === "exclude") return false;
    const firstWord = p.name.split(/[\s(]/)[0]!.toLowerCase();
    return lower.includes(firstWord) || firstWord.includes(lower);
  });
  if (candidates.length <= 1) return candidates[0];

  // Try to disambiguate by $ amount in the detected string
  const dollarMatch = detected.match(/\$(\d+)/);
  if (dollarMatch) {
    const amount = parseInt(dollarMatch[1]!, 10);
    const byAmount = candidates.find((p) => p.monthlyBase === amount);
    if (byAmount) return byAmount;
  }

  // Default to first match
  return candidates[0];
}

// --- Scrapfly ---
const probeScrapfly: ProbeFn = async (apiKey, plans) => {
  const result = await fetchJson<{
    subscription?: {
      plan?: { name?: string };
      usage?: { scrape?: { used?: number; allowed?: number } };
    };
    account?: { credits_used?: number; credits_total?: number };
  }>(`https://api.scrapfly.io/account?key=${apiKey}`);

  if (!result.ok || !result.data) return null;

  const planName = result.data.subscription?.plan?.name;
  let unitsUsed = 0;
  let unitsTotal = 0;

  if (result.data.subscription?.usage?.scrape) {
    unitsUsed = result.data.subscription.usage.scrape.used ?? 0;
    unitsTotal = result.data.subscription.usage.scrape.allowed ?? 0;
  } else if (result.data.account) {
    unitsUsed = result.data.account.credits_used ?? 0;
    unitsTotal = result.data.account.credits_total ?? 0;
  }

  const matched = planName ? matchPlanByPrefix(planName, plans) : undefined;

  return {
    planName: planName ?? undefined,
    matchedPlan: matched,
    usage: {
      unitsUsed,
      unitsTotal,
      unitName: "credits",
    },
    summary: matched
      ? `${matched.name} — ${formatK(unitsUsed)}/${formatK(unitsTotal)} credits used`
      : `${formatK(unitsUsed)}/${formatK(unitsTotal)} credits used`,
    confidence: matched ? "high" : "medium",
  };
};

// --- Anthropic ---
const probeAnthropic: ProbeFn = async (apiKey, _plans) => {
  // Anthropic Admin API: GET /v1/organizations/cost_report
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const params = new URLSearchParams({
    start_date: startOfMonth.toISOString().split("T")[0]!,
    end_date: now.toISOString().split("T")[0]!,
  });

  const result = await fetchJson<{
    data?: Array<{ amount?: string; cost_type?: string }>;
  }>(`https://api.anthropic.com/v1/organizations/cost_report?${params}`, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });

  if (!result.ok || !result.data?.data) return null;

  // Sum costs (returned in cents as strings)
  let totalCents = 0;
  for (const entry of result.data.data) {
    totalCents += parseFloat(entry.amount ?? "0");
  }
  const spend = totalCents / 100;

  return {
    usage: { spend, currency: "USD" },
    summary: `$${spend.toFixed(2)} spent this billing period`,
    confidence: "medium",
  };
};

// --- OpenAI ---
const probeOpenAI: ProbeFn = async (apiKey, _plans) => {
  // OpenAI Admin API: GET /v1/organization/usage/completions
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const params = new URLSearchParams({
    start_time: String(Math.floor(startOfMonth.getTime() / 1000)),
    end_time: String(Math.floor(now.getTime() / 1000)),
  });

  const result = await fetchJson<{
    data?: Array<{ results?: Array<{ amount?: { value?: number } }> }>;
  }>(`https://api.openai.com/v1/organization/usage/completions?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!result.ok || !result.data?.data) return null;

  // Sum usage values
  let totalTokens = 0;
  for (const bucket of result.data.data) {
    for (const r of bucket.results ?? []) {
      totalTokens += r.amount?.value ?? 0;
    }
  }

  return {
    usage: { unitsUsed: totalTokens, unitName: "tokens" },
    summary: `${formatK(totalTokens)} tokens used this period`,
    confidence: "medium",
  };
};

// --- Vercel ---
const probeVercel: ProbeFn = async (apiKey, plans) => {
  // Try to get team info first
  const teamsResult = await fetchJson<{
    teams?: Array<{ id?: string; name?: string; billing?: { plan?: string } }>;
  }>("https://api.vercel.com/v2/teams", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (teamsResult.ok && teamsResult.data?.teams?.[0]) {
    const team = teamsResult.data.teams[0];
    const planName = team.billing?.plan;
    if (planName) {
      const matched = matchPlanByPrefix(planName, plans);
      return {
        planName,
        matchedPlan: matched,
        summary: `Team "${team.name}" on ${planName} plan`,
        confidence: matched ? "high" : "medium",
      };
    }
  }

  // Fallback: try user endpoint for hobby plan detection
  const userResult = await fetchJson<{
    user?: { billing?: { plan?: string }; name?: string };
  }>("https://api.vercel.com/v2/user", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (userResult.ok && userResult.data?.user) {
    const plan = userResult.data.user.billing?.plan ?? "hobby";
    const matched = matchPlanByPrefix(plan, plans);
    return {
      planName: plan,
      matchedPlan: matched,
      summary: `Personal account on ${plan} plan`,
      confidence: matched ? "high" : "low",
    };
  }

  return null;
};

// --- Supabase ---
const probeSupabase: ProbeFn = async (apiKey, plans) => {
  // Supabase Management API requires a PAT (sbp_*), not service_role key (eyJ*)
  // Detect wrong key type early to avoid a confusing null result
  if (apiKey.startsWith("eyJ")) {
    return {
      summary: "Key is a service_role JWT — Supabase Management API requires a Personal Access Token (sbp_*) from supabase.com/dashboard → Account → Access Tokens",
      confidence: "low",
    };
  }

  const orgsResult = await fetchJson<
    Array<{ id?: string; name?: string; billing?: { plan?: string }; subscription_id?: string }>
  >("https://api.supabase.com/v1/organizations", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!orgsResult.ok || !orgsResult.data || !Array.isArray(orgsResult.data)) {
    return {
      summary: "Supabase API call failed — ensure key is a Personal Access Token (sbp_*), not a service_role key",
      confidence: "low",
    };
  }

  const org = orgsResult.data[0];
  if (!org) return null;

  const planName = org.billing?.plan;
  if (planName) {
    const matched = matchPlanByPrefix(planName, plans);
    return {
      planName,
      matchedPlan: matched,
      summary: `Org "${org.name}" on ${planName} plan`,
      confidence: matched ? "high" : "medium",
    };
  }

  return {
    summary: `Org "${org.name}" found (plan not detected)`,
    confidence: "low",
  };
};

// --- Browserbase ---
const probeBrowserbase: ProbeFn = async (apiKey, _plans) => {
  // Browserbase: GET /v1/projects (to get project ID), then usage
  const projResult = await fetchJson<
    Array<{ id?: string; name?: string }>
  >("https://api.browserbase.com/v1/projects", {
    headers: { "X-BB-API-Key": apiKey },
  });

  if (!projResult.ok || !projResult.data?.[0]?.id) return null;

  const projectId = projResult.data[0].id;
  const usageResult = await fetchJson<{
    sessions_count?: number;
    browser_hours?: number;
  }>(`https://api.browserbase.com/v1/projects/${projectId}/usage`, {
    headers: { "X-BB-API-Key": apiKey },
  });

  if (!usageResult.ok || !usageResult.data) {
    return {
      summary: `Project "${projResult.data[0].name}" found`,
      confidence: "low",
    };
  }

  const sessions = usageResult.data.sessions_count ?? 0;
  const hours = usageResult.data.browser_hours ?? 0;

  return {
    usage: { unitsUsed: sessions, unitName: "sessions" },
    summary: `${sessions} sessions, ${hours.toFixed(1)} browser hours this period`,
    confidence: "medium",
  };
};

// --- Upstash ---
const probeUpstash: ProbeFn = async (apiKey, _plans) => {
  // Upstash uses email:api_key basic auth for the management API
  // The key from env is typically the Redis REST token, not management key
  // Try the databases list endpoint
  const result = await fetchJson<
    Array<{ database_id?: string; database_name?: string; region?: string }>
  >("https://api.upstash.com/v2/redis/databases", {
    headers: {
      Authorization: `Basic ${Buffer.from(apiKey).toString("base64")}`,
    },
  });

  if (!result.ok) return null;

  const dbCount = Array.isArray(result.data) ? result.data.length : 0;
  return {
    summary: `${dbCount} Redis database${dbCount !== 1 ? "s" : ""} found`,
    confidence: "low",
  };
};

// --- PostHog ---
const probePostHog: ProbeFn = async (apiKey, _plans) => {
  const result = await fetchJson<{
    results?: Array<{ id?: string; name?: string }>;
  }>("https://us.posthog.com/api/organizations/@current", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!result.ok || !result.data) return null;

  return {
    summary: "Organization found",
    confidence: "low",
  };
};

// ---------------------------------------------------------------------------
// Probe registry — maps service IDs to their probe function
// ---------------------------------------------------------------------------

const PROBES: Map<string, ProbeFn> = new Map([
  ["scrapfly", probeScrapfly],
  ["anthropic", probeAnthropic],
  ["openai", probeOpenAI],
  ["vercel", probeVercel],
  ["supabase", probeSupabase],
  ["browserbase", probeBrowserbase],
  ["upstash", probeUpstash],
  ["posthog", probePostHog],
]);

/**
 * Probe a service using its API key.
 * Returns null if no probe exists for the service or the probe fails.
 */
export async function probeService(
  serviceId: string,
  apiKey: string,
  plans: PlanTier[],
): Promise<ProbeResult | null> {
  const probe = PROBES.get(serviceId);
  if (!probe) return null;

  try {
    return await probe(apiKey, plans);
  } catch {
    return null;
  }
}

/** Check if a service has a probe available */
export function hasProbe(serviceId: string): boolean {
  return PROBES.has(serviceId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return String(n);
}
