import type {
  SpendBrief,
  SpendSnapshot,
  SpendAlert,
  ConfidenceTier,
} from "./types.js";
import { CONFIDENCE_BADGES } from "./types.js";

/**
 * Format a spend brief as a markdown table — clean rendering in agent/IDE contexts.
 */
export function formatBriefMarkdown(brief: SpendBrief): string {
  const lines: string[] = [];
  lines.push(`**BURNWATCH** — ${brief.projectName} — ${brief.period}\n`);
  lines.push("| Service | Spend | Conf | Budget | Left |");
  lines.push("|---------|-------|------|--------|------|");

  for (const svc of brief.services.filter(s => s.tier !== "excluded")) {
    const spendStr = formatSpendValue(svc);
    const badge = CONFIDENCE_BADGES[svc.tier];
    const budgetStr = svc.budget ? `$${svc.budget}` : "—";
    const leftStr = formatLeft(svc);
    lines.push(`| ${svc.serviceId} | ${spendStr} | ${badge} | ${budgetStr} | ${leftStr} |`);

    if (svc.allowance) {
      const usedStr = formatCompact(svc.allowance.used);
      const totalStr = formatCompact(svc.allowance.included);
      const pctStr = svc.allowance.percent.toFixed(0);
      const warn = svc.allowance.percent >= 75 ? " ⚠️" : "";
      lines.push(`| | ↳ ${usedStr}/${totalStr} ${svc.allowance.unitName} (${pctStr}%)${warn} | | | |`);
    }
  }

  lines.push("");
  lines.push(formatTotalLine(brief));

  for (const alert of brief.alerts) {
    const icon = alert.severity === "critical" ? "🚨" : "⚠️";
    lines.push(`${icon} ${alert.message}`);
  }

  return lines.join("\n");
}

/**
 * Format a spend brief as a text block for injection into Claude's context.
 * Uses a left-edge-only box: ║ on the left, no right border.
 * This avoids emoji-width alignment issues across terminals, IDEs, and agent contexts.
 */
export function formatBrief(brief: SpendBrief): string {
  const lines: string[] = [];
  const hr = "═".repeat(62);
  const hrThin = "─".repeat(58);

  lines.push(`╔${hr}`);
  lines.push(`║  BURNWATCH — ${brief.projectName} — ${brief.period}`);
  lines.push(`╠${hr}`);

  // Header
  lines.push(formatRow("Service", "Spend", "Conf", "Budget", "Left"));
  lines.push(`║  ${hrThin}`);

  // Service rows (skip excluded services)
  for (const svc of brief.services.filter(s => s.tier !== "excluded")) {
    const spendStr = formatSpendValue(svc);
    const badge = CONFIDENCE_BADGES[svc.tier];
    const budgetStr = svc.budget ? `$${svc.budget}` : "—";
    const leftStr = formatLeft(svc);

    lines.push(formatRow(svc.serviceId, spendStr, badge, budgetStr, leftStr));

    if (svc.allowance) {
      const usedStr = formatCompact(svc.allowance.used);
      const totalStr = formatCompact(svc.allowance.included);
      const pctStr = svc.allowance.percent.toFixed(0);
      const warn = svc.allowance.percent >= 75 ? " ⚠️" : "";
      lines.push(`║    ↳ ${usedStr}/${totalStr} ${svc.allowance.unitName} (${pctStr}%)${warn}`);
    }
  }

  // Footer
  lines.push(`╠${hr}`);

  // Split total into live spend vs plan costs
  const parts: string[] = [];
  if (brief.liveSpend > 0) {
    parts.push(`Spend: $${brief.liveSpend.toFixed(2)}`);
  }
  if (brief.planCostTotal > 0) {
    parts.push(`Plans: $${brief.planCostTotal.toFixed(0)}/mo`);
  }
  if (parts.length === 0) {
    parts.push(`$${brief.totalSpend.toFixed(2)}`);
  }

  const marginStr = brief.estimateMargin > 0
    ? `  Est margin: ±$${brief.estimateMargin.toFixed(0)}`
    : "";
  const untrackedStr =
    brief.untrackedCount > 0
      ? `No billing data: ${brief.untrackedCount} ⚠️`
      : `All tracked ✅`;

  lines.push(`║  ${parts.join("  |  ")}   ${untrackedStr}${marginStr}`);

  for (const alert of brief.alerts) {
    const icon = alert.severity === "critical" ? "🚨" : "⚠️";
    lines.push(`║  ${icon}  ${alert.message}`);
  }

  lines.push(`╚${hr}`);

  return lines.join("\n");
}

/**
 * Format a single-service spend card for injection on mention.
 */
export function formatSpendCard(snapshot: SpendSnapshot): string {
  const badge = CONFIDENCE_BADGES[snapshot.tier];
  const spendStr = formatSpendValue(snapshot);
  const spendLabel = snapshot.isPlanCost ? "Plan cost" : "Spend";
  const budgetStr = snapshot.budget
    ? `Budget: $${snapshot.budget}`
    : "No budget set";
  const statusStr = snapshot.statusLabel;

  const lines = [
    `[BURNWATCH] ${snapshot.serviceId} — current period`,
    `  ${spendLabel}: ${spendStr}  |  ${budgetStr}  |  ${statusStr}`,
    `  Confidence: ${badge}`,
  ];

  if (snapshot.status === "over" && snapshot.budgetPercent) {
    lines.push(
      `  ⚠️ ${snapshot.budgetPercent.toFixed(0)}% of budget consumed`,
    );
  }

  return lines.join("\n");
}

/**
 * Build a SpendBrief from snapshots and project config.
 */
export function buildBrief(
  projectName: string,
  snapshots: SpendSnapshot[],
  blindCount: number,
): SpendBrief {
  const now = new Date();
  const period = now.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  let totalSpend = 0;
  let liveSpend = 0;
  let planCostTotal = 0;
  let hasEstimates = false;
  let estimateMargin = 0;
  const alerts: SpendAlert[] = [];

  for (const snap of snapshots) {
    totalSpend += snap.spend;
    if (snap.isPlanCost) {
      planCostTotal += snap.spend;
    } else if (snap.tier === "live") {
      liveSpend += snap.spend;
    }
    if (snap.isEstimate) {
      hasEstimates = true;
      estimateMargin += snap.spend * 0.15; // ±15% margin on estimates
    }

    if (snap.status === "over") {
      alerts.push({
        serviceId: snap.serviceId,
        type: "over_budget",
        message: `${snap.serviceId.toUpperCase()} ${snap.budgetPercent?.toFixed(0) ?? "?"}% OVER BUDGET — review before use`,
        severity: "critical",
      });
    } else if (snap.status === "caution" && snap.budgetPercent && snap.budgetPercent >= 80) {
      // Don't warn for flat-fee services at exactly their plan cost — that's expected
      if (!(snap.isFlatPlan && snap.budgetPercent >= 99.5 && snap.budgetPercent <= 100.5)) {
        alerts.push({
          serviceId: snap.serviceId,
          type: "near_budget",
          message: `${snap.serviceId} at ${snap.budgetPercent.toFixed(0)}% of budget`,
          severity: "warning",
        });
      }
    }
  }

  if (blindCount > 0) {
    alerts.push({
      serviceId: "_blind",
      type: "blind_service",
      message: `${blindCount} service${blindCount > 1 ? "s" : ""} have no billing data — add API keys for live tracking`,
      severity: "warning",
    });
  }

  return {
    projectName,
    generatedAt: now.toISOString(),
    period,
    services: snapshots,
    totalSpend,
    liveSpend,
    planCostTotal,
    totalIsEstimate: hasEstimates,
    estimateMargin,
    untrackedCount: blindCount,
    alerts,
  };
}

// --- Helpers ---

function formatRow(
  service: string,
  spend: string,
  conf: string,
  budget: string,
  left: string,
): string {
  return `║  ${service.padEnd(14)} ${spend.padEnd(11)} ${conf.padEnd(9)} ${budget.padEnd(7)} ${left}`;
}

/**
 * Format the spend value for a service row.
 * LIVE: exact spend. CALC flat: "$XX/mo" to make clear it's plan cost.
 * EST: "~$XX". BLIND: "—".
 */
function formatSpendValue(svc: SpendSnapshot): string {
  if (svc.tier === "blind" && svc.spend === 0) return "—";
  if (svc.isPlanCost) return `$${svc.spend.toFixed(0)}/mo`;
  if (svc.isEstimate) return `~$${svc.spend.toFixed(2)}`;
  return `$${svc.spend.toFixed(2)}`;
}

/**
 * Format the total line for markdown brief.
 * Splits live spend from plan cost commitments.
 */
function formatTotalLine(brief: SpendBrief): string {
  const parts: string[] = [];
  if (brief.liveSpend > 0) {
    parts.push(`**Spend: $${brief.liveSpend.toFixed(2)}**`);
  }
  if (brief.planCostTotal > 0) {
    parts.push(`**Plans: $${brief.planCostTotal.toFixed(0)}/mo**`);
  }
  if (parts.length === 0) {
    parts.push(`**Total: $${brief.totalSpend.toFixed(2)}**`);
  }
  const marginStr = brief.estimateMargin > 0
    ? ` (±$${brief.estimateMargin.toFixed(0)})`
    : "";
  const blindStr = brief.untrackedCount > 0
    ? ` | No billing data: ${brief.untrackedCount}`
    : "";
  return `${parts.join("  |  ")}${marginStr}${blindStr}`;
}

function formatLeft(snap: SpendSnapshot): string {
  if (!snap.budget) return "—";
  if (snap.status === "over") return "⚠️ OVER";
  if (snap.budgetPercent !== undefined) {
    const remaining = 100 - snap.budgetPercent;
    return `${remaining.toFixed(0)}%`;
  }
  return "—";
}

/**
 * Build a SpendSnapshot from tracked service data.
 */
export function buildSnapshot(
  serviceId: string,
  tier: ConfidenceTier,
  spend: number,
  budget?: number,
  allowanceData?: { used: number; included: number; unitName: string },
  isEstimateOverride?: boolean,
  isFlatPlan?: boolean,
): SpendSnapshot {
  // Guard against NaN — one bad connector should never poison the whole brief
  if (isNaN(spend) || !isFinite(spend)) spend = 0;
  if (budget !== undefined && (isNaN(budget) || !isFinite(budget))) budget = undefined;

  const isEstimate = isEstimateOverride ?? (tier === "est" || tier === "calc");
  const isPlanCost = tier === "calc" && isFlatPlan === true;
  const budgetPercent = budget && budget > 0 ? (spend / budget) * 100 : undefined;

  let status: SpendSnapshot["status"] = "unknown";
  let statusLabel = tier === "blind" ? "needs API key" : "no budget";

  if (budget) {
    if (budgetPercent! > 100) {
      status = "over";
      statusLabel = `${budgetPercent!.toFixed(0)}% over`;
    } else if (isFlatPlan && budgetPercent! >= 99.5) {
      // Flat-fee service at exactly budget — this is expected, not a warning
      status = "healthy";
      statusLabel = "flat — on plan";
    } else if (budgetPercent! >= 75) {
      status = "caution";
      statusLabel = `${(100 - budgetPercent!).toFixed(0)}% — caution`;
    } else {
      status = "healthy";
      statusLabel = `${(100 - budgetPercent!).toFixed(0)}% — healthy`;
    }
  }

  // For credit-pool services, allowance consumption drives the status
  let allowance: SpendSnapshot["allowance"] | undefined;
  if (allowanceData && allowanceData.included > 0) {
    const percent = (allowanceData.used / allowanceData.included) * 100;
    allowance = { ...allowanceData, percent };

    // Override status based on allowance consumption
    if (percent > 100) {
      status = "over";
      statusLabel = `⚠️ ${percent.toFixed(0)}% of ${formatCompact(allowanceData.included)} ${allowanceData.unitName} used`;
    } else if (percent >= 75) {
      status = "caution";
      statusLabel = `${formatCompact(allowanceData.included - allowanceData.used)} ${allowanceData.unitName} left — caution`;
    } else {
      status = "healthy";
      statusLabel = `${formatCompact(allowanceData.included - allowanceData.used)} ${allowanceData.unitName} left`;
    }
  } else if (tier === "calc" && budget) {
    statusLabel = `flat — on plan`;
    status = "healthy";
  }

  return {
    serviceId,
    spend,
    isEstimate,
    isPlanCost,
    tier,
    budget,
    budgetPercent,
    status,
    statusLabel,
    isFlatPlan,
    timestamp: new Date().toISOString(),
    allowance,
  };
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return String(n);
}
