import type { ConfidenceTier } from "../core/types.js";

/** Result from polling a billing API. */
export interface BillingResult {
  serviceId: string;
  spend: number;
  isEstimate: boolean;
  tier: ConfidenceTier;
  raw?: Record<string, unknown>;
  error?: string;
  /** For credit-pool services: units consumed this period */
  unitsUsed?: number;
  /** For credit-pool services: total units in plan allowance */
  unitsTotal?: number;
  /** For credit-pool services: unit name (e.g., "credits") */
  unitName?: string;
  /** Whether this service is on a flat-fee plan (spend == budget is expected) */
  isFlatPlan?: boolean;
}

/**
 * Base interface for service billing connectors.
 * Each LIVE service implements this to fetch real spend data.
 */
export interface BillingConnector {
  serviceId: string;
  /** Fetch current period spend. */
  fetchSpend(apiKey: string, options?: Record<string, string>): Promise<BillingResult>;
}

/**
 * Make an HTTP request and return JSON.
 * Uses native fetch (Node 18+). No external dependencies.
 */
export async function fetchJson<T>(
  url: string,
  options: {
    headers?: Record<string, string>;
    method?: string;
    body?: string;
    timeout?: number;
  } = {},
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      options.timeout ?? 10_000,
    );

    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = (await response.json()) as T;
    return { ok: true, status: response.status, data };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
