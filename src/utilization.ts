/**
 * Utilization Engine — persistent, code-derived cost projection.
 *
 * Tracks SDK call sites across the project, persists them to disk,
 * and projects monthly utilization and overage costs. This is the
 * forward-looking early warning system that complements billing API data.
 *
 * Key design decisions:
 * - File is the unit of replacement: when a file changes, all its old call sites are replaced
 * - Reuses analyzeCostImpact() patterns from cost-impact.ts — no duplication
 * - Flat-rate-only services (no unitRate, no call patterns) are excluded from utilization
 * - For LIVE services, utilization runs silently unless divergence is significant
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { analyzeCostImpact } from "./cost-impact.js";
import { loadRegistry } from "./core/registry.js";
import { projectDataDir } from "./core/config.js";

// ─── Types ───────────────────────────────────────────────────────────

/** A single SDK call site detected in a source file. */
export interface CallSite {
  /** Absolute or project-relative file path */
  filePath: string;
  /** Service this call site belongs to */
  serviceId: string;
  /** Number of distinct call patterns matched in this file */
  callCount: number;
  /** Detected multiplier labels (e.g., "for loop (100 iterations)", "cron: daily") */
  multipliers: string[];
  /** The effective multiplier factor applied */
  multiplierFactor: number;
  /** Projected monthly invocations from this call site */
  monthlyInvocations: number;
  /** Low cost estimate per month */
  costLow: number;
  /** High cost estimate per month */
  costHigh: number;
}

/** Per-service utilization summary. */
export interface ServiceUtilization {
  serviceId: string;
  serviceName: string;
  /** All call sites across the project for this service */
  callSites: CallSite[];
  /** Total projected monthly units (sum of all callSites' monthlyInvocations) */
  totalMonthlyUnits: number;
  /** Unit name (e.g., "sessions", "emails", "credits", "API calls") */
  unitName: string;
  /** Units included in the user's plan (null = all units are overage) */
  planIncluded: number | null;
  /** Monthly units exceeding plan inclusion */
  projectedOverage: number;
  /** Cost of overage at unitRate */
  projectedOverageCost: number;
  /** Total projected monthly cost (plan base + overage) */
  projectedTotalCost: number;
  /** Plan base cost (flat monthly fee) */
  planBaseCost: number;
  /** Per-unit rate used for overage calculation */
  unitRate: number;
}

/** The full utilization model, persisted to disk. */
export interface UtilizationModel {
  /** Schema version for forward compatibility */
  version: 1;
  /** When this model was last updated */
  updatedAt: string;
  /** When the last full scan was performed */
  lastFullScan: string | null;
  /** Per-service utilization data */
  services: Record<string, ServiceUtilization>;
}

// ─── Model persistence ───────────────────────────────────────────────

/** Path to the utilization model file. */
export function utilizationModelPath(projectRoot: string): string {
  return path.join(projectDataDir(projectRoot), "utilization.json");
}

/** Read the utilization model from disk. Returns empty model if not found. */
export function readUtilizationModel(projectRoot: string): UtilizationModel {
  try {
    const raw = fs.readFileSync(utilizationModelPath(projectRoot), "utf-8");
    return JSON.parse(raw) as UtilizationModel;
  } catch {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      lastFullScan: null,
      services: {},
    };
  }
}

/** Write the utilization model to disk. */
export function writeUtilizationModel(
  model: UtilizationModel,
  projectRoot: string,
): void {
  const dir = projectDataDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  model.updatedAt = new Date().toISOString();
  fs.writeFileSync(
    utilizationModelPath(projectRoot),
    JSON.stringify(model, null, 2) + "\n",
    "utf-8",
  );
}

// ─── File analysis ───────────────────────────────────────────────────

/**
 * Analyze a single file and return CallSite[] for each service detected.
 * Wraps analyzeCostImpact() and converts CostImpact[] → CallSite[].
 */
export function analyzeFileUtilization(
  filePath: string,
  content: string,
  projectRoot?: string,
): CallSite[] {
  const impacts = analyzeCostImpact(filePath, content, projectRoot);

  return impacts.map((impact) => ({
    filePath,
    serviceId: impact.serviceId,
    callCount: impact.callCount,
    multipliers: impact.multipliers,
    multiplierFactor: impact.multiplierFactor,
    monthlyInvocations: impact.monthlyInvocations,
    costLow: impact.costLow,
    costHigh: impact.costHigh,
  }));
}

// ─── Model updates ───────────────────────────────────────────────────

/**
 * Update the utilization model after a file changes.
 *
 * 1. Remove all existing call sites for this file path
 * 2. Insert new call sites
 * 3. Recalculate totals for affected services
 */
export function updateUtilizationModel(
  model: UtilizationModel,
  filePath: string,
  newCallSites: CallSite[],
  projectRoot?: string,
): void {
  const registry = loadRegistry(projectRoot);

  // Track which services were affected (had old sites OR have new sites)
  const affectedServices = new Set<string>();

  // Step 1: Remove all old call sites for this file from all services
  for (const [serviceId, svc] of Object.entries(model.services)) {
    const before = svc.callSites.length;
    svc.callSites = svc.callSites.filter((cs) => cs.filePath !== filePath);
    if (svc.callSites.length !== before) {
      affectedServices.add(serviceId);
    }
  }

  // Step 2: Insert new call sites
  for (const cs of newCallSites) {
    affectedServices.add(cs.serviceId);

    if (!model.services[cs.serviceId]) {
      const def = registry.get(cs.serviceId);
      model.services[cs.serviceId] = {
        serviceId: cs.serviceId,
        serviceName: def?.name ?? cs.serviceId,
        callSites: [],
        totalMonthlyUnits: 0,
        unitName: def?.pricing?.unitName ?? "API calls",
        planIncluded: null,
        projectedOverage: 0,
        projectedOverageCost: 0,
        projectedTotalCost: 0,
        planBaseCost: def?.pricing?.monthlyBase ?? 0,
        unitRate: def?.pricing?.unitRate ?? 0,
      };
    }

    model.services[cs.serviceId]!.callSites.push(cs);
  }

  // Step 3: Recalculate totals for affected services
  for (const serviceId of affectedServices) {
    recalculateServiceTotals(model, serviceId);
  }

  // Clean up services with no remaining call sites
  for (const serviceId of Object.keys(model.services)) {
    if (model.services[serviceId]!.callSites.length === 0) {
      delete model.services[serviceId];
    }
  }
}

/**
 * Recalculate projection totals for a single service.
 */
function recalculateServiceTotals(
  model: UtilizationModel,
  serviceId: string,
): void {
  const svc = model.services[serviceId];
  if (!svc) return;

  // Sum monthly invocations across all call sites
  svc.totalMonthlyUnits = svc.callSites.reduce(
    (sum, cs) => sum + cs.monthlyInvocations,
    0,
  );

  // Calculate overage
  const included = svc.planIncluded ?? 0;
  svc.projectedOverage = Math.max(0, svc.totalMonthlyUnits - included);

  // Calculate overage cost
  svc.projectedOverageCost = svc.projectedOverage * svc.unitRate;

  // Total = plan base + overage
  svc.projectedTotalCost = svc.planBaseCost + svc.projectedOverageCost;
}

/**
 * Apply user configuration (plan allowance, unit rate) to the model.
 * Called after reading project config to sync plan data into utilization.
 */
export function applyConfigToModel(
  model: UtilizationModel,
  serviceConfigs: Record<string, {
    planIncluded?: number | null;
    planBaseCost?: number;
    unitRate?: number;
    unitName?: string;
  }>,
): void {
  for (const [serviceId, config] of Object.entries(serviceConfigs)) {
    const svc = model.services[serviceId];
    if (!svc) continue;

    if (config.planIncluded !== undefined) svc.planIncluded = config.planIncluded;
    if (config.planBaseCost !== undefined) svc.planBaseCost = config.planBaseCost;
    if (config.unitRate !== undefined) svc.unitRate = config.unitRate;
    if (config.unitName !== undefined) svc.unitName = config.unitName;

    recalculateServiceTotals(model, serviceId);
  }
}

// ─── Full project scan ───────────────────────────────────────────────

/** Directories to scan for source files. */
const CODE_DIRS = ["src", "app", "lib", "pages", "components", "utils", "services", "hooks", "api", "functions"];

/**
 * Build a complete utilization model by scanning all source files.
 * Called by `burnwatch init` and `burnwatch scan`.
 */
export function buildUtilizationModel(projectRoot: string): UtilizationModel {
  const model: UtilizationModel = {
    version: 1,
    updatedAt: new Date().toISOString(),
    lastFullScan: new Date().toISOString(),
    services: {},
  };

  const files = findSourceFiles(projectRoot);

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, "utf-8");
      const callSites = analyzeFileUtilization(file, content, projectRoot);

      if (callSites.length > 0) {
        // Use relative paths in the model for portability
        const relPath = path.relative(projectRoot, file);
        const relativeSites = callSites.map((cs) => ({
          ...cs,
          filePath: relPath,
        }));
        updateUtilizationModel(model, relPath, relativeSites, projectRoot);
      }
    } catch {
      // Skip unreadable files
    }
  }

  return model;
}

/**
 * Find all source files in the project (same dirs as import scanner).
 */
function findSourceFiles(projectRoot: string): string[] {
  const files: string[] = [];
  const dirsToScan: string[] = [];

  for (const dir of CODE_DIRS) {
    const fullPath = path.join(projectRoot, dir);
    if (fs.existsSync(fullPath)) {
      dirsToScan.push(fullPath);
    }
  }

  // Monorepo support: check subdirectories with their own package.json
  try {
    const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name.startsWith(".")) continue;

      const subPkgPath = path.join(projectRoot, entry.name, "package.json");
      if (fs.existsSync(subPkgPath)) {
        for (const dir of CODE_DIRS) {
          const fullPath = path.join(projectRoot, entry.name, dir);
          if (fs.existsSync(fullPath)) {
            dirsToScan.push(fullPath);
          }
        }
      }
    }
  } catch {
    // Skip if root is unreadable
  }

  for (const dir of dirsToScan) {
    walkDir(dir, /\.(ts|tsx|js|jsx|mjs|cjs)$/, files);
  }

  return files;
}

/** Recursively walk a directory, collecting files matching the pattern. */
function walkDir(dir: string, pattern: RegExp, results: string[], maxDepth = 5): void {
  if (maxDepth <= 0) return;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath, pattern, results, maxDepth - 1);
      } else if (pattern.test(entry.name)) {
        results.push(fullPath);
      }
    }
  } catch {
    // Skip unreadable directories
  }
}

// ─── Divergence alerting ─────────────────────────────────────────────

export interface DivergenceAlert {
  serviceId: string;
  liveSpend: number;
  projectedTotalCost: number;
  delta: number;
  message: string;
}

/**
 * Check for divergence between LIVE billing data and code-projected costs.
 *
 * Only alerts when:
 * - Projected cost exceeds current LIVE spend by > 50% (relative threshold)
 * - AND the absolute difference is > $5 (absolute threshold)
 *
 * Both thresholds must be met to avoid noise.
 */
export function checkDivergence(
  serviceId: string,
  liveSpend: number,
  projectedTotalCost: number,
): DivergenceAlert | null {
  const delta = projectedTotalCost - liveSpend;

  // Both thresholds must be met
  const relativeThreshold = liveSpend > 0 ? delta > liveSpend * 0.5 : delta > 0;
  const absoluteThreshold = delta > 5;

  if (relativeThreshold && absoluteThreshold) {
    return {
      serviceId,
      liveSpend,
      projectedTotalCost,
      delta,
      message: `Code changes project +$${delta.toFixed(2)}/mo above current $${liveSpend.toFixed(2)}/mo spend`,
    };
  }

  return null;
}

// ─── Brief formatting ────────────────────────────────────────────────

/**
 * Format utilization data for the brief table.
 * Returns a map of serviceId → utilization string for the brief column.
 */
export function formatUtilizationForBrief(
  model: UtilizationModel,
): Map<string, string> {
  const result = new Map<string, string>();

  for (const [serviceId, svc] of Object.entries(model.services)) {
    if (svc.totalMonthlyUnits === 0) continue;

    const unitsStr = formatCompact(svc.totalMonthlyUnits);

    if (svc.planIncluded !== null && svc.planIncluded > 0) {
      const includedStr = formatCompact(svc.planIncluded);
      const pct = ((svc.totalMonthlyUnits / svc.planIncluded) * 100).toFixed(0);

      if (svc.projectedOverage > 0) {
        const overageStr = formatCompact(svc.projectedOverage);
        result.set(
          serviceId,
          `${unitsStr}/${includedStr} ${svc.unitName} (${overageStr} overage)`,
        );
      } else {
        result.set(
          serviceId,
          `${unitsStr}/${includedStr} ${svc.unitName} (${pct}%)`,
        );
      }
    } else {
      result.set(serviceId, `${unitsStr} ${svc.unitName}/mo`);
    }
  }

  return result;
}

/**
 * Format a full utilization scan summary for CLI output.
 */
export function formatUtilizationSummary(model: UtilizationModel): string {
  const services = Object.values(model.services).filter(
    (s) => s.totalMonthlyUnits > 0,
  );

  if (services.length === 0) {
    return "📊 No utilization-tracked call sites found in the project.";
  }

  const lines: string[] = [];
  lines.push("📊 Utilization scan complete\n");
  lines.push("| Service | Call Sites | Monthly Units | Plan Included | Overage Cost |");
  lines.push("|---------|-----------|---------------|---------------|-------------|");

  for (const svc of services) {
    const fileCount = new Set(svc.callSites.map((cs) => cs.filePath)).size;
    const filesStr = `${fileCount} file${fileCount > 1 ? "s" : ""}`;
    const unitsStr = `${formatCompact(svc.totalMonthlyUnits)} ${svc.unitName}`;
    const includedStr = svc.planIncluded !== null
      ? formatCompact(svc.planIncluded)
      : "—";
    const overageStr = svc.projectedOverageCost > 0
      ? `~$${svc.projectedOverageCost.toFixed(2)}/mo`
      : "$0";

    lines.push(
      `| ${svc.serviceName} | ${filesStr} | ${unitsStr} | ${includedStr} | ${overageStr} |`,
    );
  }

  return lines.join("\n");
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return String(Math.round(n));
}
