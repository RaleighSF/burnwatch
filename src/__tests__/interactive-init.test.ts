import { describe, it, expect, beforeEach } from "vitest";
import { clearRegistryCache, getService } from "../core/registry.js";

describe("plan tiers in registry", () => {
  beforeEach(() => {
    clearRegistryCache();
  });

  it("all 14 services have plan tiers defined", () => {
    const serviceIds = [
      "anthropic",
      "openai",
      "google-gemini",
      "voyage-ai",
      "vercel",
      "supabase",
      "stripe",
      "scrapfly",
      "browserbase",
      "upstash",
      "resend",
      "inngest",
      "posthog",
      "aws",
    ];

    for (const id of serviceIds) {
      const service = getService(id);
      expect(service, `Service ${id} should exist`).toBeDefined();
      expect(
        service!.plans,
        `Service ${id} should have plans`,
      ).toBeDefined();
      expect(
        service!.plans!.length,
        `Service ${id} should have at least 2 plans`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("every service has a 'Don't track' exclude option", () => {
    const serviceIds = [
      "anthropic",
      "openai",
      "google-gemini",
      "voyage-ai",
      "vercel",
      "supabase",
      "stripe",
      "scrapfly",
      "browserbase",
      "upstash",
      "resend",
      "inngest",
      "posthog",
      "aws",
    ];

    for (const id of serviceIds) {
      const service = getService(id);
      const excludePlan = service!.plans!.find((p) => p.type === "exclude");
      expect(
        excludePlan,
        `Service ${id} should have an exclude plan`,
      ).toBeDefined();
    }
  });

  it("LLM services have usage plans that require keys", () => {
    const llmIds = ["anthropic", "openai"];

    for (const id of llmIds) {
      const service = getService(id);
      const usagePlan = service!.plans!.find(
        (p) => p.type === "usage" && p.requiresKey,
      );
      expect(
        usagePlan,
        `LLM service ${id} should have a usage plan requiring a key`,
      ).toBeDefined();
    }
  });

  it("flat plans have monthlyBase defined", () => {
    const serviceIds = [
      "anthropic",
      "openai",
      "vercel",
      "supabase",
      "scrapfly",
      "browserbase",
      "resend",
      "inngest",
    ];

    for (const id of serviceIds) {
      const service = getService(id);
      const flatPlans = service!.plans!.filter((p) => p.type === "flat");
      for (const plan of flatPlans) {
        expect(
          plan.monthlyBase,
          `Plan "${plan.name}" for ${id} should have monthlyBase`,
        ).toBeDefined();
      }
    }
  });

  it("at most one plan is marked as default per service", () => {
    const serviceIds = [
      "anthropic",
      "openai",
      "google-gemini",
      "voyage-ai",
      "vercel",
      "supabase",
      "stripe",
      "scrapfly",
      "browserbase",
      "upstash",
      "resend",
      "inngest",
      "posthog",
      "aws",
    ];

    for (const id of serviceIds) {
      const service = getService(id);
      const defaults = service!.plans!.filter((p) => p.default);
      expect(
        defaults.length,
        `Service ${id} should have at most one default plan`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it("scrapfly has autoDetectPlan flag", () => {
    const scrapfly = getService("scrapfly");
    expect(scrapfly!.autoDetectPlan).toBe(true);
  });
});

describe("excluded tier", () => {
  it("CONFIDENCE_BADGES includes excluded tier", async () => {
    const { CONFIDENCE_BADGES } = await import("../core/types.js");
    expect(CONFIDENCE_BADGES.excluded).toBeDefined();
    expect(CONFIDENCE_BADGES.excluded).toContain("SKIP");
  });
});
