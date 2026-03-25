import { describe, it, expect, beforeEach } from "vitest";
import { analyzeCostImpact, formatCostImpactCard } from "../cost-impact.js";
import { clearRegistryCache } from "../core/registry.js";

describe("analyzeCostImpact", () => {
  beforeEach(() => {
    clearRegistryCache();
  });

  it("detects Scrapfly scrape calls", () => {
    const content = `
      import ScrapflyClient from "scrapfly";
      const client = new ScrapflyClient({ key: "xxx" });
      const result = await client.scrape(config);
    `;

    const impacts = analyzeCostImpact("/project/src/crawler.ts", content);
    const scrapfly = impacts.find((i) => i.serviceId === "scrapfly");
    expect(scrapfly).toBeDefined();
    expect(scrapfly!.callCount).toBe(1);
  });

  it("detects Anthropic API calls", () => {
    const content = `
      import Anthropic from "@anthropic-ai/sdk";
      const client = new Anthropic();
      const msg = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hello" }],
      });
    `;

    const impacts = analyzeCostImpact("/project/src/ai.ts", content);
    const anthropic = impacts.find((i) => i.serviceId === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.callCount).toBe(1);
  });

  it("detects multiple call sites in one file", () => {
    const content = `
      const r1 = await client.scrape(config1);
      const r2 = await client.scrape(config2);
      const r3 = await client.async_scrape(config3);
    `;

    const impacts = analyzeCostImpact("/project/src/scraper.ts", content);
    const scrapfly = impacts.find((i) => i.serviceId === "scrapfly");
    expect(scrapfly).toBeDefined();
    expect(scrapfly!.callCount).toBe(3);
  });

  it("detects loop multipliers", () => {
    const content = `
      for (let i = 0; i < 100; i++) {
        await client.scrape(config);
      }
    `;

    const impacts = analyzeCostImpact("/project/src/batch.ts", content);
    const scrapfly = impacts.find((i) => i.serviceId === "scrapfly");
    expect(scrapfly).toBeDefined();
    expect(scrapfly!.multiplierFactor).toBe(100);
    expect(scrapfly!.multipliers).toContain("for loop (100 iterations)");
  });

  it("detects .map() multiplier", () => {
    const content = `
      const results = await Promise.all(
        urls.map(async (url) => {
          return client.scrape(new ScrapeConfig({ url }));
        })
      );
    `;

    const impacts = analyzeCostImpact("/project/src/parallel.ts", content);
    const scrapfly = impacts.find((i) => i.serviceId === "scrapfly");
    expect(scrapfly).toBeDefined();
    // Should detect both .map() and Promise.all multipliers
    expect(scrapfly!.multipliers.length).toBeGreaterThan(0);
  });

  it("detects cron schedule multiplier", () => {
    const content = `
      // Runs every 5 minutes via cron
      export async function handler() {
        const result = await client.scrape(config);
        return result;
      }
    `;

    const impacts = analyzeCostImpact("/project/src/scheduled.ts", content);
    const scrapfly = impacts.find((i) => i.serviceId === "scrapfly");
    expect(scrapfly).toBeDefined();
    expect(
      scrapfly!.multipliers.some((m) => m.includes("cron") || m.includes("scheduled")),
    ).toBe(true);
  });

  it("produces cost range with gotcha multipliers for scrapfly", () => {
    const content = `
      const result = await client.scrape(new ScrapeConfig({ url }));
    `;

    const impacts = analyzeCostImpact("/project/src/simple.ts", content);
    const scrapfly = impacts.find((i) => i.serviceId === "scrapfly");
    expect(scrapfly).toBeDefined();
    // High should be greater than low due to anti-bot gotcha (25x)
    expect(scrapfly!.costHigh).toBeGreaterThan(scrapfly!.costLow);
    expect(scrapfly!.rangeExplanation).toContain("anti-bot");
  });

  it("ignores non-source files", () => {
    const impacts = analyzeCostImpact(
      "/project/README.md",
      "scrapfly.scrape() is great!",
    );
    expect(impacts).toHaveLength(0);
  });

  it("returns empty for files with no SDK calls", () => {
    const content = `
      export function add(a: number, b: number) {
        return a + b;
      }
    `;
    const impacts = analyzeCostImpact("/project/src/utils.ts", content);
    expect(impacts).toHaveLength(0);
  });

  it("detects batch_size hints", () => {
    const content = `
      const batch_size = 50;
      await client.scrape(config);
    `;

    const impacts = analyzeCostImpact("/project/src/batch.ts", content);
    const scrapfly = impacts.find((i) => i.serviceId === "scrapfly");
    expect(scrapfly).toBeDefined();
    expect(scrapfly!.multipliers).toContain("batch size: 50");
  });
});

describe("formatCostImpactCard", () => {
  beforeEach(() => {
    clearRegistryCache();
  });

  it("formats a single service impact card", () => {
    const impacts = [
      {
        serviceId: "scrapfly",
        serviceName: "Scrapfly",
        filePath: "/project/src/competitor-crawler.ts",
        callCount: 3,
        multipliers: [".map() iteration"],
        multiplierFactor: 10,
        monthlyInvocations: 1500,
        costLow: 0.23,
        costHigh: 225,
        rangeExplanation: "anti-bot bypass consumes 5-25x base credits",
      },
    ];

    const card = formatCostImpactCard(impacts, {
      scrapfly: { spend: 127, budget: 50 },
    });

    expect(card).toContain("[BURNWATCH]");
    expect(card).toContain("competitor-crawler.ts");
    expect(card).toContain("Scrapfly");
    expect(card).toContain("1,500 calls/mo");
    expect(card).toContain("$127/$50 budget");
  });

  it("shows alternatives for expensive services", () => {
    const impacts = [
      {
        serviceId: "scrapfly",
        serviceName: "Scrapfly",
        filePath: "/project/src/big-scraper.ts",
        callCount: 1,
        multipliers: [],
        multiplierFactor: 1,
        monthlyInvocations: 5000,
        costLow: 5,
        costHigh: 100,
      },
    ];

    const card = formatCostImpactCard(impacts, {});
    expect(card).toContain("cheerio");
  });
});
