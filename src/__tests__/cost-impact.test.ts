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
    expect(scrapfly!.rangeExplanation).toBeDefined();
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

  it("resolves variable loop bounds from const assignments", () => {
    const content = `
      const TOTAL_PAGES = 1000;
      for (let i = 0; i < TOTAL_PAGES; i++) {
        const session = await bb.sessions.create({ projectId });
      }
    `;

    const impacts = analyzeCostImpact("/project/src/scraper.ts", content);
    const bb = impacts.find((i) => i.serviceId === "browserbase");
    expect(bb).toBeDefined();
    expect(bb!.multiplierFactor).toBe(1000);
    expect(bb!.multipliers.some((m) => m.includes("1000"))).toBe(true);
  });

  it("resolves .map() size from known array", () => {
    const content = `
      const urls = Array(500);
      const results = urls.map(async (url) => {
        return client.scrape(new ScrapeConfig({ url }));
      });
    `;

    const impacts = analyzeCostImpact("/project/src/parallel.ts", content);
    const scrapfly = impacts.find((i) => i.serviceId === "scrapfly");
    expect(scrapfly).toBeDefined();
    expect(scrapfly!.multiplierFactor).toBe(500);
    expect(scrapfly!.multipliers.some((m) => m.includes("500"))).toBe(true);
  });

  it("resolves for...of over known-size array", () => {
    const content = `
      const pages = Array(200);
      for (const page of pages) {
        const session = await bb.sessions.create({ projectId });
      }
    `;

    const impacts = analyzeCostImpact("/project/src/crawler.ts", content);
    const bb = impacts.find((i) => i.serviceId === "browserbase");
    expect(bb).toBeDefined();
    expect(bb!.multiplierFactor).toBe(200);
  });

  it("detects every-other-day cron schedule", () => {
    const content = `
      // Runs every other day
      export async function handler() {
        const result = await client.scrape(config);
      }
    `;

    const impacts = analyzeCostImpact("/project/src/cron.ts", content);
    const scrapfly = impacts.find((i) => i.serviceId === "scrapfly");
    expect(scrapfly).toBeDefined();
    expect(scrapfly!.multipliers.some((m) => m.includes("every other day") || m.includes("every 2 day"))).toBe(true);
  });

  it("detects named count constants as multiplier hints", () => {
    const content = `
      const NUM_REQUESTS = 5000;
      await resend.emails.send({ to: "user@example.com" });
    `;

    const impacts = analyzeCostImpact("/project/src/mailer.ts", content);
    const resend = impacts.find((i) => i.serviceId === "resend");
    expect(resend).toBeDefined();
    expect(resend!.multiplierFactor).toBe(5000);
  });

  it("does not double-count Promise.all wrapping .map()", () => {
    const content = `
      const urls = Array(100);
      const results = await Promise.all(
        urls.map(async (url) => {
          return client.scrape(new ScrapeConfig({ url }));
        })
      );
    `;

    const impacts = analyzeCostImpact("/project/src/batch.ts", content);
    const scrapfly = impacts.find((i) => i.serviceId === "scrapfly");
    expect(scrapfly).toBeDefined();
    // Should detect .map() with 100 items, NOT also add Promise.all as a separate 10x
    expect(scrapfly!.multiplierFactor).toBe(100);
    expect(scrapfly!.multipliers.filter((m) => m.includes("Promise.all"))).toHaveLength(0);
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
