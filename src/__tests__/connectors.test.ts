import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetchJson before importing connectors
vi.mock("../services/base.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/base.js")>();
  return {
    ...orig,
    fetchJson: vi.fn(),
  };
});

import { fetchJson } from "../services/base.js";
import { anthropicConnector } from "../services/anthropic.js";
import { openaiConnector } from "../services/openai.js";
import { scrapflyConnector } from "../services/scrapfly.js";
import { vercelConnector } from "../services/vercel.js";
import { supabaseConnector } from "../services/supabase.js";
import { browserbaseConnector } from "../services/browserbase.js";

const mockFetchJson = vi.mocked(fetchJson);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("anthropicConnector", () => {
  it("returns LIVE spend from usage endpoint (total_cost_usd)", async () => {
    mockFetchJson.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        total_cost_usd: 47.23,
      },
    });

    const result = await anthropicConnector.fetchSpend("sk-ant-admin-test");
    expect(result.serviceId).toBe("anthropic");
    expect(result.spend).toBeCloseTo(47.23);
    expect(result.tier).toBe("live");
    expect(result.isEstimate).toBe(false);
  });

  it("returns LIVE spend from data array", async () => {
    mockFetchJson.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        data: [
          { total_cost_usd: 25.0 },
          { total_cost_usd: 12.5 },
        ],
      },
    });

    const result = await anthropicConnector.fetchSpend("sk-ant-admin-test");
    expect(result.spend).toBeCloseTo(37.5);
    expect(result.tier).toBe("live");
  });

  it("returns error on API failure", async () => {
    mockFetchJson.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: "HTTP 403: Forbidden",
    });

    const result = await anthropicConnector.fetchSpend("bad-key");
    expect(result.error).toBeDefined();
    expect(result.tier).toBe("est");
  });
});

describe("openaiConnector", () => {
  it("returns LIVE spend from usage endpoint", async () => {
    mockFetchJson.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        data: [
          {
            results: [
              { amount: { value: 1500 }, currency: "usd" },
            ],
          },
        ],
      },
    });

    const result = await openaiConnector.fetchSpend("sk-admin-test");
    expect(result.serviceId).toBe("openai");
    expect(result.tier).toBe("live");
    expect(result.isEstimate).toBe(false);
  });

  it("returns error on API failure", async () => {
    mockFetchJson.mockResolvedValueOnce({
      ok: false,
      status: 401,
      error: "HTTP 401: Unauthorized",
    });

    const result = await openaiConnector.fetchSpend("bad-key");
    expect(result.error).toBeDefined();
  });
});

describe("scrapflyConnector", () => {
  it("returns LIVE spend with credit consumption", async () => {
    mockFetchJson.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        subscription: {
          plan: { name: "Pro" },
          usage: {
            scrape: { used: 250000, allowed: 1000000 },
          },
          period: { start: "2026-03-01", end: "2026-03-31" },
        },
      },
    });

    const result = await scrapflyConnector.fetchSpend("test-key");
    expect(result.serviceId).toBe("scrapfly");
    expect(result.tier).toBe("live");
    expect(result.unitsUsed).toBe(250000);
    expect(result.unitsTotal).toBe(1000000);
    expect(result.unitName).toBe("credits");
  });
});

describe("vercelConnector", () => {
  it("returns spend from usage endpoint", async () => {
    mockFetchJson.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        usage: { total: 42.0 },
        billing: { plan: "pro" },
      },
    });

    const result = await vercelConnector.fetchSpend("token-test");
    expect(result.serviceId).toBe("vercel");
    expect(result.tier).toBe("live");
    expect(result.spend).toBeCloseTo(42.0);
  });
});

describe("supabaseConnector", () => {
  it("returns spend from org billing", async () => {
    // Step 1: orgs endpoint — returns array of orgs
    mockFetchJson.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: [
        {
          id: "org_123",
          name: "My Org",
          billing: { plan: "pro" },
        },
      ],
    });
    // Step 2: usage endpoint — no overage
    mockFetchJson.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {},
    });

    const result = await supabaseConnector.fetchSpend("sbp_test");
    expect(result.serviceId).toBe("supabase");
    expect(result.tier).toBe("live");
    expect(result.spend).toBe(25); // pro plan base cost
    expect(result.isEstimate).toBe(false);
  });

  it("returns est tier with error for bad API response", async () => {
    mockFetchJson.mockResolvedValueOnce({
      ok: false,
      status: 401,
      error: "HTTP 401: Unauthorized",
    });

    const result = await supabaseConnector.fetchSpend("bad-token");
    expect(result.tier).toBe("est");
    expect(result.spend).toBe(0);
  });
});

describe("browserbaseConnector", () => {
  it("returns spend with session count", async () => {
    // Step 1: projects endpoint
    mockFetchJson.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: [
        { id: "proj_123", name: "My Project" },
      ],
    });
    // Step 2: usage endpoint
    mockFetchJson.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        total_sessions: 45,
        total_minutes: 120,
      },
    });

    const result = await browserbaseConnector.fetchSpend("bb-key-test");
    expect(result.serviceId).toBe("browserbase");
    expect(result.tier).toBe("live"); // real data from API
    expect(result.spend).toBeCloseTo(12.0); // 120 min * $0.10/min
    expect(result.unitsUsed).toBe(45);
    expect(result.unitName).toBe("sessions");
  });
});
