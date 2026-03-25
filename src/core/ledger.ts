import * as fs from "node:fs";
import * as path from "node:path";
import type { SpendBrief, SpendEvent } from "./types.js";
import { CONFIDENCE_BADGES } from "./types.js";
import { projectConfigDir, projectDataDir } from "./config.js";

/**
 * Write the spend ledger as a human-readable markdown file.
 * Designed to be git-committable and readable in 10 seconds.
 */
export function writeLedger(brief: SpendBrief, projectRoot?: string): void {
  const now = new Date();
  const lines: string[] = [];

  lines.push(`# Burnwatch Ledger — ${brief.projectName}`);
  lines.push(`Last updated: ${now.toISOString()}`);
  lines.push("");
  lines.push(`## This Month (${brief.period})`);
  lines.push("");
  lines.push("| Service | Spend | Conf | Budget | Status |");
  lines.push("|---------|-------|------|--------|--------|");

  for (const svc of brief.services) {
    const spendStr = svc.isEstimate
      ? `~$${svc.spend.toFixed(2)}`
      : `$${svc.spend.toFixed(2)}`;
    const badge = CONFIDENCE_BADGES[svc.tier];
    const budgetStr = svc.budget ? `$${svc.budget}` : "—";

    lines.push(
      `| ${svc.serviceId} | ${spendStr} | ${badge} | ${budgetStr} | ${svc.statusLabel} |`,
    );
  }

  lines.push("");
  const totalStr = brief.totalIsEstimate
    ? `~$${brief.totalSpend.toFixed(2)}`
    : `$${brief.totalSpend.toFixed(2)}`;
  const marginStr =
    brief.estimateMargin > 0
      ? ` (±$${brief.estimateMargin.toFixed(0)} estimated margin)`
      : "";
  lines.push(`## TOTAL: ${totalStr}${marginStr}`);
  lines.push(`## Untracked services: ${brief.untrackedCount}`);
  lines.push("");

  if (brief.alerts.length > 0) {
    lines.push("## Alerts");
    for (const alert of brief.alerts) {
      const icon = alert.severity === "critical" ? "🚨" : "⚠️";
      lines.push(`- ${icon} ${alert.message}`);
    }
    lines.push("");
  }

  const ledgerPath = path.join(
    projectConfigDir(projectRoot),
    "spend-ledger.md",
  );
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, lines.join("\n") + "\n", "utf-8");
}

/**
 * Append an event to the append-only event log.
 */
export function logEvent(event: SpendEvent, projectRoot?: string): void {
  const logPath = path.join(projectDataDir(projectRoot), "events.jsonl");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(event) + "\n", "utf-8");
}

/**
 * Read recent events from the event log.
 */
export function readRecentEvents(
  count: number,
  projectRoot?: string,
): SpendEvent[] {
  const logPath = path.join(projectDataDir(projectRoot), "events.jsonl");
  try {
    const raw = fs.readFileSync(logPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    return lines
      .slice(-count)
      .map((line) => JSON.parse(line) as SpendEvent);
  } catch {
    return [];
  }
}

/**
 * Save a spend snapshot to the snapshots directory.
 * Used for delta computation across sessions.
 */
export function saveSnapshot(brief: SpendBrief, projectRoot?: string): void {
  const snapshotDir = path.join(projectDataDir(projectRoot), "snapshots");
  fs.mkdirSync(snapshotDir, { recursive: true });
  const filename = `snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(
    path.join(snapshotDir, filename),
    JSON.stringify(brief, null, 2) + "\n",
    "utf-8",
  );
}

/**
 * Read the most recent snapshot, if any.
 */
export function readLatestSnapshot(
  projectRoot?: string,
): SpendBrief | null {
  const snapshotDir = path.join(projectDataDir(projectRoot), "snapshots");
  try {
    const files = fs
      .readdirSync(snapshotDir)
      .filter((f) => f.startsWith("snapshot-") && f.endsWith(".json"))
      .sort()
      .reverse();

    if (files.length === 0) return null;

    const raw = fs.readFileSync(
      path.join(snapshotDir, files[0]!),
      "utf-8",
    );
    return JSON.parse(raw) as SpendBrief;
  } catch {
    return null;
  }
}
