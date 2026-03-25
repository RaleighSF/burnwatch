import type {
  SpendBrief,
  SpendSnapshot,
  SpendAlert,
  ConfidenceTier,
} from "./types.js";
import { CONFIDENCE_BADGES } from "./types.js";

/**
 * Format a spend brief as a text block for injection into Claude's context.
 */
export function formatBrief(brief: SpendBrief): string {
  const lines: string[] = [];
  const width = 62;
  const hrDouble = "═".repeat(width);
  const hrSingle = "─".repeat(width - 4);

  lines.push(`╔${hrDouble}╗`);
  lines.push(
    `║  BURNWATCH — ${brief.projectName} — ${brief.period}`.padEnd(
      width + 1,
    ) + "║",
  );
  lines.push(`╠${hrDouble}╣`);

  // Header
  lines.push(
    formatRow("Service", "Spend", "Conf", "Budget", "Left", width),
  );
  lines.push(`║  ${hrSingle}  ║`);

  // Service rows
  for (const svc of brief.services) {
    const spendStr = svc.isEstimate
      ? `~$${svc.spend.toFixed(2)}`
      : `$${svc.spend.toFixed(2)}`;
    const badge = CONFIDENCE_BADGES[svc.tier];
    const budgetStr = svc.budget ? `$${svc.budget}` : "—";
    const leftStr = formatLeft(svc);

    lines.push(formatRow(svc.serviceId, spendStr, badge, budgetStr, leftStr, width));
  }

  // Footer
  lines.push(`╠${hrDouble}╣`);
  const totalStr = brief.totalIsEstimate
    ? `~$${brief.totalSpend.toFixed(2)}`
    : `$${brief.totalSpend.toFixed(2)}`;
  const marginStr = brief.estimateMargin > 0
    ? `  Est margin: ±$${brief.estimateMargin.toFixed(0)}`
    : "";
  const untrackedStr =
    brief.untrackedCount > 0
      ? `Untracked: ${brief.untrackedCount} ⚠️`
      : `Untracked: 0 ✅`;

  lines.push(
    `║  TOTAL: ${totalStr}   ${untrackedStr}${marginStr}`.padEnd(
      width + 1,
    ) + "║",
  );

  // Alerts
  for (const alert of brief.alerts) {
    const icon = alert.severity === "critical" ? "🚨" : "⚠️";
    lines.push(
      `║  ${icon}  ${alert.message}`.padEnd(width + 1) + "║",
    );
  }

  lines.push(`╚${hrDouble}╝`);

  return lines.join("\n");
}

/**
 * Format a single-service spend card for injection on mention.
 */
export function formatSpendCard(snapshot: SpendSnapshot): string {
  const badge = CONFIDENCE_BADGES[snapshot.tier];
  const spendStr = snapshot.isEstimate
    ? `~$${snapshot.spend.toFixed(2)}`
    : `$${snapshot.spend.toFixed(2)}`;
  const budgetStr = snapshot.budget
    ? `Budget: $${snapshot.budget}`
    : "No budget set";
  const statusStr = snapshot.statusLabel;

  const lines = [
    `[BURNWATCH] ${snapshot.serviceId} — current period`,
    `  Spend: ${spendStr}  |  ${budgetStr}  |  ${statusStr}`,
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
  let hasEstimates = false;
  let estimateMargin = 0;
  const alerts: SpendAlert[] = [];

  for (const snap of snapshots) {
    totalSpend += snap.spend;
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
      alerts.push({
        serviceId: snap.serviceId,
        type: "near_budget",
        message: `${snap.serviceId} at ${snap.budgetPercent.toFixed(0)}% of budget`,
        severity: "warning",
      });
    }
  }

  if (blindCount > 0) {
    alerts.push({
      serviceId: "_blind",
      type: "blind_service",
      message: `${blindCount} service${blindCount > 1 ? "s" : ""} detected but untracked - run 'burnwatch init' to configure`,
      severity: "warning",
    });
  }

  return {
    projectName,
    generatedAt: now.toISOString(),
    period,
    services: snapshots,
    totalSpend,
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
  width: number,
): string {
  const row = `  ${service.padEnd(14)} ${spend.padEnd(11)} ${conf.padEnd(7)} ${budget.padEnd(7)} ${left}`;
  return `║${row}`.padEnd(width + 1) + "║";
}

function formatLeft(snap: SpendSnapshot): string {
  if (!snap.budget) return "—";
  if (snap.status === "over") return "⚠️ OVR";
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
): SpendSnapshot {
  const isEstimate = tier === "est" || tier === "calc";
  const budgetPercent = budget ? (spend / budget) * 100 : undefined;

  let status: SpendSnapshot["status"] = "unknown";
  let statusLabel = "no budget";

  if (budget) {
    if (budgetPercent! > 100) {
      status = "over";
      statusLabel = `⚠️ ${budgetPercent!.toFixed(0)}% over`;
    } else if (budgetPercent! >= 75) {
      status = "caution";
      statusLabel = `${(100 - budgetPercent!).toFixed(0)}% — caution`;
    } else {
      status = "healthy";
      statusLabel = `${(100 - budgetPercent!).toFixed(0)}% — healthy`;
    }
  }

  if (tier === "calc" && budget) {
    statusLabel = `flat — on plan`;
    status = "healthy";
  }

  return {
    serviceId,
    spend,
    isEstimate,
    tier,
    budget,
    budgetPercent,
    status,
    statusLabel,
    timestamp: new Date().toISOString(),
  };
}
