#!/usr/bin/env node

/**
 * SessionStart hook — fires when Claude Code starts or resumes a session.
 *
 * 1. Reads cached brief (instant — no latency)
 * 2. Injects brief into context via additionalContext
 * 3. Kicks off async refresh of spend data for next time
 */

import * as fs from "node:fs";
import type { HookInput, HookOutput } from "../core/types.js";
import { readProjectConfig, projectConfigDir, isInitialized } from "../core/config.js";
import { readLatestSnapshot } from "../core/ledger.js";
import { formatBrief, formatBriefMarkdown, buildBrief, buildSnapshot } from "../core/brief.js";
import { readUtilizationModel, formatUtilizationForBrief, checkDivergence } from "../utilization.js";
import { detectServices } from "../detection/detector.js";
import { pollAllServices } from "../services/index.js";
import { logEvent, saveSnapshot, writeLedger } from "../core/ledger.js";

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

  // Check if burnwatch is initialized in this project
  if (!isInitialized(projectRoot)) {
    process.exit(0);
    return;
  }

  const config = readProjectConfig(projectRoot)!;

  // Step 1: Try to serve from cache (instant, no latency)
  const cachedBrief = readLatestSnapshot(projectRoot);
  let briefText: string;

  if (cachedBrief) {
    briefText = formatBriefMarkdown(cachedBrief);
  } else {
    // No cache — build a brief from config with projected CALC spend
    const detected = detectServices(projectRoot);
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dayOfMonth = now.getDate();

    const snapshots = Object.values(config.services)
      .filter((tracked) => !tracked.excluded)
      .map((tracked) => {
        const allowanceData = tracked.allowance
          ? { used: 0, included: tracked.allowance.included, unitName: tracked.allowance.unitName }
          : undefined;

        // For CALC services, project spend based on plan cost and day of month
        let spend = 0;
        let tier: "live" | "calc" | "est" | "blind" | "excluded" = "blind";

        if (tracked.hasApiKey) {
          tier = "live";
          // No spend data without polling — will be updated in background
        } else if (tracked.planCost !== undefined && tracked.planCost > 0) {
          tier = "calc";
          spend = (tracked.planCost / daysInMonth) * dayOfMonth;
        }

        return buildSnapshot(
          tracked.serviceId,
          tier,
          spend,
          tracked.budget,
          allowanceData,
        );
      });

    // Add any newly detected services not yet in config
    for (const det of detected) {
      if (!config.services[det.service.id]) {
        snapshots.push(
          buildSnapshot(det.service.id, "blind", 0, undefined),
        );
      }
    }

    const blindCount = snapshots.filter((s) => s.tier === "blind").length;
    const brief = buildBrief(config.projectName, snapshots, blindCount);
    briefText = formatBriefMarkdown(brief);
  }

  // Step 2: Append utilization data if available
  try {
    const model = readUtilizationModel(projectRoot);
    const utilizationMap = formatUtilizationForBrief(model);
    if (utilizationMap.size > 0) {
      const utilLines: string[] = ["\n**Utilization (code-projected):**"];
      for (const [serviceId, utilStr] of utilizationMap) {
        utilLines.push(`  ${serviceId}: ${utilStr}`);
      }

      // Check for divergence alerts on LIVE services
      if (cachedBrief) {
        for (const svc of cachedBrief.services) {
          if (svc.tier === "live" && model.services[svc.serviceId]) {
            const alert = checkDivergence(
              svc.serviceId,
              svc.spend,
              model.services[svc.serviceId]!.projectedTotalCost,
            );
            if (alert) {
              utilLines.push(`  ⚠️ ${alert.message}`);
            }
          }
        }
      }

      briefText += "\n" + utilLines.join("\n");
    }
  } catch {
    // Utilization data is supplemental — don't block the brief
  }

  // Step 2b: Output the brief for Claude Code to inject
  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: briefText,
    },
  };

  process.stdout.write(JSON.stringify(output));

  // Step 3: Log the session start event
  logEvent(
    {
      timestamp: new Date().toISOString(),
      sessionId: input.session_id,
      type: "session_start",
      data: { source: input.source },
    },
    projectRoot,
  );

  // Step 4: Async refresh — poll billing APIs in the background
  // and save a fresh snapshot for next time.
  // This runs AFTER we've already written output, so no latency impact.
  try {
    const trackedServices = Object.values(config.services);
    if (trackedServices.length > 0) {
      const results = await pollAllServices(trackedServices);
      const snapshots = results.map((r) => {
        const tracked = config.services[r.serviceId];
        const allowanceData = r.unitsUsed !== undefined && r.unitsTotal !== undefined && r.unitName
          ? { used: r.unitsUsed, included: r.unitsTotal, unitName: r.unitName }
          : tracked?.allowance
            ? { used: 0, included: tracked.allowance.included, unitName: tracked.allowance.unitName }
            : undefined;
        return buildSnapshot(r.serviceId, r.tier, r.spend, tracked?.budget, allowanceData, r.isEstimate, r.isFlatPlan);
      });
      const blindCount = snapshots.filter((s) => s.tier === "blind").length;
      const brief = buildBrief(config.projectName, snapshots, blindCount);
      saveSnapshot(brief, projectRoot);
      writeLedger(brief, projectRoot);
    }
  } catch {
    // Background refresh failed — not critical, we already served cached brief
  }
}

main().catch(() => process.exit(0));
