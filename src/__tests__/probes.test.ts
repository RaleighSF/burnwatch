import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetchJson before importing probes
vi.mock("../services/base.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/base.js")>();
  return {
    ...orig,
    fetchJson: vi.fn(),
  };
});

import { fetchJson } from "../services/base.js";
import { probeService, hasProbe } from "../probes.js";
import type { PlanTier } from "../core/types.js";

const mockFetchJson = vi.mocked(fetchJson);

beforeEach(() => {
  vi.clearAllMocks();
});

const scrapflyPlans: PlanTier[] = [
  { name: "Discovery ($30/mo, 200K credits)", type: "flat", monthlyBase: 30 },
  { name: "Pro ($100/mo, 1M credits)", type: "flat", monthlyBase: 100, default: true },
  { name: "Don't track for this project", type: "exclude" },
];

const vercelPlans: PlanTier[] = [
  { name: "Hobby (Free)", type: "flat", monthlyBase: 0, default: true },
  { name: "Pro ($20/mo)", type: "flat", monthlyBase: 20 },
  { name: "Don't track for this project", type: "exclude" },
];

const supabasePlans: PlanTier[] = [
  { name: "Free", type: "flat", monthlyBase: 0, default: true },
  { name: "Pro ($25/mo)", type: "flat", monthlyBase: 25 },
  { name: "Don't track for this project", type: "exclude" },
];

describe("hasProbe", () => {
  it("returns true for services with probes", () => {
    expect(hasProbe("scrapfly")).toBe(true);
    expect(hasProbe("anthropic")).toBe(true);
    expect(hasProbe("openai")).toBe(true);
    expect(hasProbe("vercel")).toBe(true);
    expect(hasProbe("supabase")).toBe(true);
    expect(hasProbe("browserbase")).toBe(true);
    expect(hasProbe("upstash")).toBe(true);
    expect(hasProbe("posthog")).toBe(true);
  });

  it("returns false for services without probes", () => {
    expect(hasProbe("inngest")).toBe(false);
    expect(hasProbe("resend")).toBe(false);
    expect(hasProbe("google-gemini")).toBe(false);
    expect(hasProbe("unknown-service")).toBe(false);
  });
});

describe("probeService — scrapfly", () => {
  it("detects plan and usage with high confidence", async () => {
    mockFetchJson.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        subscription: {
          plan: { name: "Pro" },
          usage: { scrape: { used: 250000, allowed: 1000000 } },
        },
      },
    });

    const result = await probeService("scrapfly", "test-key", scrapflyPlans);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("high");
    expect(result!.matchedPlan).toBeDefined();
    expect(result!.matchedPlan!.monthlyBase).toBe(100);
    expect(result!.usage?.unitsUsed).toBe(250000);
    expect(result!.usage?.unitsTotal).toBe(1000000);
  });

  it("returns null on API failure", async () => {
    mockFetchJson.mockResolvedValueOnce({
      ok: false,
      status: 401,
      error: "Unauthorized",
    });

    const result = await probeService("scrapfly", "bad-key", scrapflyPlans);
    expect(result).toBeNull();
  });
});

describe("probeService — anthropic", () => {
  it("returns spend data with medium confidence", async () => {
    mockFetchJson.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        data: [
          { amount: "4723", cost_type: "inference" },
        ],
      },
    });

    const result = await probeService("anthropic", "sk-ant-admin-test", []);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("medium");
    expect(result!.usage?.spend).toBeCloseTo(47.23);
  });
});

describe("probeService — openai", () => {
  it("returns token usage with medium confidence", async () => {
    mockFetchJson.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        data: [
          { results: [{ amount: { value: 50000 } }] },
        ],
      },
    });

    const result = await probeService("openai", "sk-admin-test", []);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("medium");
    expect(result!.usage?.unitsUsed).toBe(50000);
  });
});

describe("probeService — vercel", () => {
  it("detects team plan with high confidence", async () => {
    mockFetchJson.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        teams: [
          { id: "team_123", name: "My Team", billing: { plan: "pro" } },
        ],
      },
    });

    const result = await probeService("vercel", "token-test", vercelPlans);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("high");
    expect(result!.matchedPlan).toBeDefined();
    expect(result!.matchedPlan!.monthlyBase).toBe(20);
  });

  it("falls back to user endpoint for hobby plan", async () => {
    // First call: /v2/teams — no teams
    mockFetchJson.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { teams: [] },
    });
    // Second call: /v2/user
    mockFetchJson.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        user: { name: "Dev", billing: { plan: "hobby" } },
      },
    });

    const result = await probeService("vercel", "token-test", vercelPlans);
    expect(result).not.toBeNull();
    expect(result!.planName).toBe("hobby");
  });
});

describe("probeService — supabase", () => {
  it("detects org plan", async () => {
    mockFetchJson.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: [
        { id: "org_123", name: "My Org", billing: { plan: "pro" } },
      ],
    });

    const result = await probeService("supabase", "sbp_test", supabasePlans);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("high");
    expect(result!.matchedPlan!.monthlyBase).toBe(25);
  });
});

describe("probeService — unknown service", () => {
  it("returns null for services without probes", async () => {
    const result = await probeService("inngest", "some-key", []);
    expect(result).toBeNull();
  });
});
