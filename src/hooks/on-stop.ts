#!/usr/bin/env node

/**
 * Stop hook — fires when Claude Code finishes a response.
 *
 * Updates the ledger and saves a fresh snapshot.
 * Includes cumulative session cost impact from file changes.
 * Runs async to avoid blocking the session end.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { HookInput } from "../core/types.js";
import { readProjectConfig, isInitialized, projectDataDir } from "../core/config.js";
import { pollAllServices } from "../services/index.js";
import { buildSnapshot, buildBrief } from "../core/brief.js";
import { writeLedger, saveSnapshot, logEvent } from "../core/ledger.js";

/** Read accumulated session cost impacts */
function readSessionImpacts(
  projectRoot: string,
  sessionId: string,
): Record<string, { costLow: number; costHigh: number }> | null {
  try {
    const filePath = path.join(
      projectDataDir(projectRoot),
      "cache",
      `session-impact-${sessionId}.json`,
    );
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Record<string, { costLow: number; costHigh: number }>;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  // Read hook input from stdin
  let input: HookInput;
  try {
    const stdin = fs.readFileSync(0, "utf-8");
    input = JSON.parse(stdin) as HookInput;
  } catch {
    process.exit(0);
    return;
  }

  const projectRoot = input.cwd;

  // Guard: not initialized
  if (!isInitialized(projectRoot)) {
    process.exit(0);
    return;
  }

  const config = readProjectConfig(projectRoot)!;
  const trackedServices = Object.values(config.services).filter(
    (s) => !s.excluded,
  );

  if (trackedServices.length === 0) {
    process.exit(0);
    return;
  }

  try {
    // Poll all services for current spend
    const results = await pollAllServices(trackedServices);

    // Read session cost-impact data (accumulated from file changes)
    const sessionImpacts = readSessionImpacts(projectRoot, input.session_id);

    // Build snapshots — upgrade BLIND services to EST when we have cost-impact data
    const snapshots = results.map((r) => {
      const impact = sessionImpacts?.[r.serviceId];
      // If the service is BLIND but we have cost-impact estimates, upgrade to EST
      if (r.tier === "blind" && impact && impact.costHigh > 0) {
        const estSpend = (impact.costLow + impact.costHigh) / 2; // midpoint
        return buildSnapshot(
          r.serviceId,
          "est",
          estSpend,
          config.services[r.serviceId]?.budget,
        );
      }
      return buildSnapshot(
        r.serviceId,
        r.tier,
        r.spend,
        config.services[r.serviceId]?.budget,
        undefined,
        r.isEstimate,
      );
    });

    const blindCount = snapshots.filter((s) => s.tier === "blind").length;
    const brief = buildBrief(config.projectName, snapshots, blindCount);

    // Add session cost impact summary as an alert
    if (sessionImpacts && Object.keys(sessionImpacts).length > 0) {
      let totalImpactLow = 0;
      let totalImpactHigh = 0;

      for (const impact of Object.values(sessionImpacts)) {
        totalImpactLow += impact.costLow;
        totalImpactHigh += impact.costHigh;
      }

      if (totalImpactHigh > 0) {
        const rangeStr =
          totalImpactLow === totalImpactHigh
            ? `$${totalImpactLow.toFixed(2)}`
            : `$${totalImpactLow.toFixed(2)}-$${totalImpactHigh.toFixed(2)}`;

        brief.alerts.push({
          serviceId: "_session_impact",
          type: "near_budget",
          message: `Session projected cost impact: ${rangeStr}/mo across ${Object.keys(sessionImpacts).length} service(s)`,
          severity: "info",
        });
      }
    }

    // Write ledger and save snapshot
    writeLedger(brief, projectRoot);
    saveSnapshot(brief, projectRoot);

    // Log session end
    logEvent(
      {
        timestamp: new Date().toISOString(),
        sessionId: input.session_id,
        type: "session_end",
        data: {
          totalSpend: brief.totalSpend,
          serviceCount: snapshots.length,
          blindCount,
          sessionImpacts: sessionImpacts ?? undefined,
        },
      },
      projectRoot,
    );
  } catch {
    // Don't block on errors — ledger update is best-effort
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
