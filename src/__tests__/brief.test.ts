import { describe, it, expect } from "vitest";
import { formatBrief, buildBrief, buildSnapshot, formatSpendCard } from "../core/brief.js";

describe("buildSnapshot", () => {
  it("marks live tier as not an estimate", () => {
    const snap = buildSnapshot("anthropic", "live", 47.2, 100);
    expect(snap.isEstimate).toBe(false);
    expect(snap.tier).toBe("live");
    expect(snap.status).toBe("healthy");
  });

  it("marks est tier as an estimate", () => {
    const snap = buildSnapshot("browserbase", "est", 63, 75);
    expect(snap.isEstimate).toBe(true);
    expect(snap.tier).toBe("est");
  });

  it("calculates budget percentage correctly", () => {
    const snap = buildSnapshot("scrapfly", "live", 127, 50);
    expect(snap.budgetPercent).toBeCloseTo(254);
    expect(snap.status).toBe("over");
  });

  it("shows caution when 75-100% of budget", () => {
    const snap = buildSnapshot("browserbase", "est", 63, 75);
    expect(snap.status).toBe("caution");
  });

  it("handles no budget gracefully", () => {
    const snap = buildSnapshot("firebase", "blind", 0);
    expect(snap.budget).toBeUndefined();
    expect(snap.status).toBe("unknown");
  });
});

describe("buildBrief", () => {
  it("sums total spend correctly", () => {
    const snapshots = [
      buildSnapshot("anthropic", "live", 47.2, 100),
      buildSnapshot("vercel", "live", 23, 50),
      buildSnapshot("scrapfly", "live", 127, 50),
    ];
    const brief = buildBrief("test-project", snapshots, 0);
    expect(brief.totalSpend).toBeCloseTo(197.2);
  });

  it("generates over-budget alerts", () => {
    const snapshots = [
      buildSnapshot("scrapfly", "live", 127, 50),
    ];
    const brief = buildBrief("test-project", snapshots, 0);
    expect(brief.alerts.length).toBeGreaterThan(0);
    expect(brief.alerts[0]!.type).toBe("over_budget");
    expect(brief.alerts[0]!.severity).toBe("critical");
  });

  it("generates blind service alerts", () => {
    const snapshots = [
      buildSnapshot("firebase", "blind", 0),
    ];
    const brief = buildBrief("test-project", snapshots, 1);
    const blindAlert = brief.alerts.find((a) => a.type === "blind_service");
    expect(blindAlert).toBeDefined();
  });

  it("calculates estimate margin for EST services", () => {
    const snapshots = [
      buildSnapshot("browserbase", "est", 63, 75),
    ];
    const brief = buildBrief("test-project", snapshots, 0);
    expect(brief.totalIsEstimate).toBe(true);
    expect(brief.estimateMargin).toBeGreaterThan(0);
  });
});

describe("formatBrief", () => {
  it("produces readable output with box drawing", () => {
    const snapshots = [
      buildSnapshot("anthropic", "live", 47.2, 100),
      buildSnapshot("scrapfly", "live", 127, 50),
    ];
    const brief = buildBrief("HullScore", snapshots, 0);
    const output = formatBrief(brief);

    expect(output).toContain("BURNWATCH");
    expect(output).toContain("HullScore");
    expect(output).toContain("anthropic");
    expect(output).toContain("$47.20");
    expect(output).toContain("LIVE");
    expect(output).toContain("SCRAPFLY");
    expect(output).toContain("OVER BUDGET");
  });
});

describe("formatSpendCard", () => {
  it("produces a single-service spend card", () => {
    const snap = buildSnapshot("scrapfly", "live", 127, 50);
    const card = formatSpendCard(snap);

    expect(card).toContain("[BURNWATCH]");
    expect(card).toContain("scrapfly");
    expect(card).toContain("$127.00");
    expect(card).toContain("Budget: $50");
  });
});
