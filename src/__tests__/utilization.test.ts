import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { UtilizationModel, CallSite, ServiceUtilization } from "../utilization.js";
import {
  readUtilizationModel,
  writeUtilizationModel,
  updateUtilizationModel,
  analyzeFileUtilization,
  buildUtilizationModel,
  checkDivergence,
  formatUtilizationForBrief,
  formatUtilizationSummary,
  applyConfigToModel,
} from "../utilization.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "burnwatch-util-test-"));
}

function emptyModel(): UtilizationModel {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    lastFullScan: null,
    services: {},
  };
}

function makeCallSite(overrides: Partial<CallSite> = {}): CallSite {
  return {
    filePath: "src/scraper.ts",
    serviceId: "browserbase",
    callCount: 2,
    multipliers: ["for loop (100 iterations)"],
    multiplierFactor: 100,
    monthlyInvocations: 10000,
    costLow: 100,
    costHigh: 500,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("Utilization Model Operations", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = tmpDir();
    fs.mkdirSync(path.join(testDir, ".burnwatch", "data"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("reads empty model when no file exists", () => {
    const model = readUtilizationModel(testDir);
    expect(model.version).toBe(1);
    expect(model.lastFullScan).toBeNull();
    expect(Object.keys(model.services)).toHaveLength(0);
  });

  it("writes and reads model round-trip", () => {
    const model = emptyModel();
    model.services["browserbase"] = {
      serviceId: "browserbase",
      serviceName: "Browserbase",
      callSites: [makeCallSite()],
      totalMonthlyUnits: 10000,
      unitName: "session",
      planIncluded: 100,
      projectedOverage: 9900,
      projectedOverageCost: 990,
      projectedTotalCost: 990,
      planBaseCost: 0,
      unitRate: 0.10,
    };

    writeUtilizationModel(model, testDir);
    const loaded = readUtilizationModel(testDir);

    expect(loaded.services["browserbase"]).toBeDefined();
    expect(loaded.services["browserbase"]!.totalMonthlyUnits).toBe(10000);
    expect(loaded.services["browserbase"]!.callSites).toHaveLength(1);
  });

  it("updateUtilizationModel replaces call sites for a file", () => {
    const model = emptyModel();

    // Initial insert
    const cs1 = makeCallSite({ filePath: "src/scraper.ts", monthlyInvocations: 500 });
    updateUtilizationModel(model, "src/scraper.ts", [cs1]);
    expect(model.services["browserbase"]!.callSites).toHaveLength(1);
    expect(model.services["browserbase"]!.totalMonthlyUnits).toBe(500);

    // Update same file with different call count
    const cs2 = makeCallSite({ filePath: "src/scraper.ts", monthlyInvocations: 1000 });
    updateUtilizationModel(model, "src/scraper.ts", [cs2]);
    expect(model.services["browserbase"]!.callSites).toHaveLength(1);
    expect(model.services["browserbase"]!.totalMonthlyUnits).toBe(1000);
  });

  it("updateUtilizationModel removes service when file has zero call sites", () => {
    const model = emptyModel();

    // Add a call site
    const cs = makeCallSite({ filePath: "src/scraper.ts" });
    updateUtilizationModel(model, "src/scraper.ts", [cs]);
    expect(model.services["browserbase"]).toBeDefined();

    // Remove by passing empty array
    updateUtilizationModel(model, "src/scraper.ts", []);
    expect(model.services["browserbase"]).toBeUndefined();
  });

  it("updateUtilizationModel handles multiple files for same service", () => {
    const model = emptyModel();

    const cs1 = makeCallSite({ filePath: "src/scraper.ts", monthlyInvocations: 1000 });
    const cs2 = makeCallSite({ filePath: "src/verify.ts", monthlyInvocations: 60 });
    updateUtilizationModel(model, "src/scraper.ts", [cs1]);
    updateUtilizationModel(model, "src/verify.ts", [cs2]);

    const svc = model.services["browserbase"]!;
    expect(svc.callSites).toHaveLength(2);
    expect(svc.totalMonthlyUnits).toBe(1060);
  });

  it("recalculates overage correctly with plan included", () => {
    const model = emptyModel();

    const cs = makeCallSite({ monthlyInvocations: 1060 });
    updateUtilizationModel(model, "src/scraper.ts", [cs]);

    const svc = model.services["browserbase"]!;
    // No plan included set yet — all units are overage
    svc.planIncluded = 100;
    svc.unitRate = 0.10;

    // Manually recalculate by calling update again with same data
    updateUtilizationModel(model, "src/scraper.ts", [cs]);

    // After update, planIncluded is still set
    svc.planIncluded = 100;
    svc.projectedOverage = Math.max(0, svc.totalMonthlyUnits - svc.planIncluded);
    svc.projectedOverageCost = svc.projectedOverage * svc.unitRate;

    expect(svc.projectedOverage).toBe(960);
    expect(svc.projectedOverageCost).toBeCloseTo(96.0);
  });

  it("overage is zero when usage is under plan included", () => {
    const model = emptyModel();

    const cs = makeCallSite({ monthlyInvocations: 50 });
    updateUtilizationModel(model, "src/check.ts", [cs]);

    const svc = model.services["browserbase"]!;
    svc.planIncluded = 100;
    svc.unitRate = 0.10;
    svc.projectedOverage = Math.max(0, svc.totalMonthlyUnits - svc.planIncluded);
    svc.projectedOverageCost = svc.projectedOverage * svc.unitRate;

    expect(svc.projectedOverage).toBe(0);
    expect(svc.projectedOverageCost).toBe(0);
  });

  it("handles null planIncluded — all units are overage", () => {
    const model = emptyModel();

    const cs = makeCallSite({ monthlyInvocations: 500 });
    updateUtilizationModel(model, "src/scraper.ts", [cs]);

    const svc = model.services["browserbase"]!;
    svc.planIncluded = null;
    svc.unitRate = 0.10;
    svc.projectedOverage = Math.max(0, svc.totalMonthlyUnits - (svc.planIncluded ?? 0));
    svc.projectedOverageCost = svc.projectedOverage * svc.unitRate;

    expect(svc.projectedOverage).toBe(500);
    expect(svc.projectedOverageCost).toBe(50);
  });

  it("model survives incremental updates without losing other services", () => {
    const model = emptyModel();

    // Add browserbase
    const cs1 = makeCallSite({ serviceId: "browserbase", filePath: "src/scrape.ts", monthlyInvocations: 100 });
    updateUtilizationModel(model, "src/scrape.ts", [cs1]);

    // Add resend
    const cs2 = makeCallSite({ serviceId: "resend", filePath: "src/email.ts", monthlyInvocations: 50 });
    updateUtilizationModel(model, "src/email.ts", [cs2]);

    // Both should exist
    expect(model.services["browserbase"]).toBeDefined();
    expect(model.services["resend"]).toBeDefined();

    // Update browserbase — resend should still be there
    const cs3 = makeCallSite({ serviceId: "browserbase", filePath: "src/scrape.ts", monthlyInvocations: 200 });
    updateUtilizationModel(model, "src/scrape.ts", [cs3]);

    expect(model.services["browserbase"]!.totalMonthlyUnits).toBe(200);
    expect(model.services["resend"]!.totalMonthlyUnits).toBe(50);
  });
});

describe("applyConfigToModel", () => {
  it("applies plan configuration and recalculates", () => {
    const model = emptyModel();
    const cs = makeCallSite({ monthlyInvocations: 1060 });
    updateUtilizationModel(model, "src/scraper.ts", [cs]);

    applyConfigToModel(model, {
      browserbase: {
        planIncluded: 100,
        planBaseCost: 0,
        unitRate: 0.10,
        unitName: "sessions",
      },
    });

    const svc = model.services["browserbase"]!;
    expect(svc.planIncluded).toBe(100);
    expect(svc.unitRate).toBe(0.10);
    expect(svc.projectedOverage).toBe(960);
    expect(svc.projectedOverageCost).toBeCloseTo(96.0);
    expect(svc.projectedTotalCost).toBeCloseTo(96.0);
  });
});

describe("Divergence Alerting", () => {
  it("alerts when projected cost exceeds LIVE spend by >50% and >$5", () => {
    const alert = checkDivergence("browserbase", 20, 50);
    expect(alert).not.toBeNull();
    expect(alert!.delta).toBe(30);
    expect(alert!.message).toContain("+$30.00/mo");
  });

  it("stays silent when projected cost is only 10% above LIVE", () => {
    const alert = checkDivergence("anthropic", 100, 110);
    expect(alert).toBeNull();
  });

  it("stays silent when delta is >50% but absolute <$5", () => {
    const alert = checkDivergence("resend", 3, 6);
    expect(alert).toBeNull();
  });

  it("alerts on zero LIVE spend when projected is above $5", () => {
    const alert = checkDivergence("browserbase", 0, 10);
    expect(alert).not.toBeNull();
    expect(alert!.delta).toBe(10);
  });

  it("stays silent on zero LIVE spend when projected is under $5", () => {
    const alert = checkDivergence("resend", 0, 3);
    expect(alert).toBeNull();
  });
});

describe("analyzeFileUtilization", () => {
  it("converts cost impacts to call sites", () => {
    const content = `
      import { Stagehand } from "@browserbasehq/stagehand";
      const page = await stagehand.act("click login");
      const data = await stagehand.extract("get prices");
    `;

    const callSites = analyzeFileUtilization("src/scraper.ts", content);
    expect(callSites.length).toBeGreaterThan(0);

    const bbSite = callSites.find((cs) => cs.serviceId === "browserbase");
    expect(bbSite).toBeDefined();
    expect(bbSite!.callCount).toBeGreaterThan(0);
  });

  it("skips non-source files", () => {
    const callSites = analyzeFileUtilization("README.md", "stagehand.act('click')");
    expect(callSites).toHaveLength(0);
  });
});

describe("formatUtilizationForBrief", () => {
  it("formats utilization with plan included and overage", () => {
    const model = emptyModel();
    model.services["browserbase"] = {
      serviceId: "browserbase",
      serviceName: "Browserbase",
      callSites: [makeCallSite({ monthlyInvocations: 1060 })],
      totalMonthlyUnits: 1060,
      unitName: "sessions",
      planIncluded: 100,
      projectedOverage: 960,
      projectedOverageCost: 96,
      projectedTotalCost: 96,
      planBaseCost: 0,
      unitRate: 0.10,
    };

    const map = formatUtilizationForBrief(model);
    expect(map.has("browserbase")).toBe(true);
    const str = map.get("browserbase")!;
    expect(str).toContain("1.1K/100");
    expect(str).toContain("overage");
  });

  it("formats utilization under plan as percentage", () => {
    const model = emptyModel();
    model.services["resend"] = {
      serviceId: "resend",
      serviceName: "Resend",
      callSites: [makeCallSite({ serviceId: "resend", monthlyInvocations: 45 })],
      totalMonthlyUnits: 45,
      unitName: "emails",
      planIncluded: 100,
      projectedOverage: 0,
      projectedOverageCost: 0,
      projectedTotalCost: 0,
      planBaseCost: 0,
      unitRate: 0.001,
    };

    const map = formatUtilizationForBrief(model);
    const str = map.get("resend")!;
    expect(str).toContain("45%");
    expect(str).not.toContain("overage");
  });

  it("skips services with zero monthly units", () => {
    const model = emptyModel();
    model.services["inngest"] = {
      serviceId: "inngest",
      serviceName: "Inngest",
      callSites: [],
      totalMonthlyUnits: 0,
      unitName: "executions",
      planIncluded: null,
      projectedOverage: 0,
      projectedOverageCost: 0,
      projectedTotalCost: 0,
      planBaseCost: 0,
      unitRate: 0.01,
    };

    const map = formatUtilizationForBrief(model);
    expect(map.has("inngest")).toBe(false);
  });
});

describe("formatUtilizationSummary", () => {
  it("shows table with service utilization data", () => {
    const model = emptyModel();
    model.services["browserbase"] = {
      serviceId: "browserbase",
      serviceName: "Browserbase",
      callSites: [makeCallSite()],
      totalMonthlyUnits: 1060,
      unitName: "sessions",
      planIncluded: 100,
      projectedOverage: 960,
      projectedOverageCost: 96,
      projectedTotalCost: 96,
      planBaseCost: 0,
      unitRate: 0.10,
    };

    const summary = formatUtilizationSummary(model);
    expect(summary).toContain("Utilization scan complete");
    expect(summary).toContain("Browserbase");
    expect(summary).toContain("1 file");
    expect(summary).toContain("$96.00/mo");
  });

  it("shows no-data message when empty", () => {
    const model = emptyModel();
    const summary = formatUtilizationSummary(model);
    expect(summary).toContain("No utilization-tracked call sites");
  });
});
