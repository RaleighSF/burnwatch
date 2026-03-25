#!/usr/bin/env node

/**
 * PostToolUse hook (Edit|Write) — fires when files are changed.
 *
 * 1. Scans changed files for new service introductions
 * 2. Analyzes cost impact of SDK calls (invocation sites, multipliers, projected cost)
 * 3. Injects cost impact cards into Claude's context
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { HookInput, HookOutput } from "../core/types.js";
import {
  readProjectConfig,
  writeProjectConfig,
  isInitialized,
  projectDataDir,
} from "../core/config.js";
import { detectInFileChange } from "../detection/detector.js";
import { logEvent } from "../core/ledger.js";
import { readLatestSnapshot } from "../core/ledger.js";
import type { TrackedService } from "../core/types.js";
import { analyzeCostImpact, formatCostImpactCard } from "../cost-impact.js";

/** Session cost impact accumulator file path */
function sessionImpactPath(projectRoot: string, sessionId: string): string {
  return path.join(projectDataDir(projectRoot), "cache", `session-impact-${sessionId}.json`);
}

/** Read accumulated session cost impacts */
function readSessionImpacts(
  projectRoot: string,
  sessionId: string,
): Record<string, { costLow: number; costHigh: number }> {
  try {
    const raw = fs.readFileSync(sessionImpactPath(projectRoot, sessionId), "utf-8");
    return JSON.parse(raw) as Record<string, { costLow: number; costHigh: number }>;
  } catch {
    return {};
  }
}

/** Write accumulated session cost impacts */
function writeSessionImpacts(
  projectRoot: string,
  sessionId: string,
  impacts: Record<string, { costLow: number; costHigh: number }>,
): void {
  const dir = path.join(projectDataDir(projectRoot), "cache");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    sessionImpactPath(projectRoot, sessionId),
    JSON.stringify(impacts, null, 2) + "\n",
    "utf-8",
  );
}

function main(): void {
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

  // Get file path and content from tool input
  const filePath = input.tool_input?.file_path;
  if (!filePath) {
    process.exit(0);
    return;
  }

  // Read the current file content
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    process.exit(0);
    return;
  }

  const config = readProjectConfig(projectRoot)!;
  const contextParts: string[] = [];

  // --- Part 1: Detect new services in this file change ---
  const detected = detectInFileChange(filePath, content, projectRoot);
  const newServices: string[] = [];

  for (const det of detected) {
    const serviceId = det.service.id;

    // Skip if already tracked
    if (config.services[serviceId]) continue;

    // Auto-register as a new tracked service (BLIND until configured)
    const tracked: TrackedService = {
      serviceId,
      detectedVia: det.sources,
      hasApiKey: false,
      firstDetected: new Date().toISOString(),
    };

    config.services[serviceId] = tracked;
    newServices.push(serviceId);

    // Log the detection
    logEvent(
      {
        timestamp: new Date().toISOString(),
        sessionId: input.session_id,
        type: "service_detected",
        data: {
          serviceId,
          sources: det.sources,
          details: det.details,
          file: filePath,
        },
      },
      projectRoot,
    );
  }

  // Save updated config
  if (newServices.length > 0) {
    writeProjectConfig(config, projectRoot);
  }

  // Alert about new services
  if (newServices.length > 0) {
    const alerts = newServices.map(
      (id) =>
        `[BURNWATCH] 🆕 New paid service detected: ${id}\n  Run 'burnwatch add ${id}' to configure budget and tracking.`,
    );
    contextParts.push(alerts.join("\n\n"));
  }

  // --- Part 2: Cost impact analysis ---
  const impacts = analyzeCostImpact(filePath, content, projectRoot);

  if (impacts.length > 0) {
    // Build current budget status from latest snapshot
    const snapshot = readLatestSnapshot(projectRoot);
    const currentBudgets: Record<string, { spend: number; budget?: number }> = {};

    if (snapshot) {
      for (const svc of snapshot.services) {
        currentBudgets[svc.serviceId] = {
          spend: svc.spend,
          budget: svc.budget,
        };
      }
    }

    // Format and add cost impact card
    const card = formatCostImpactCard(impacts, currentBudgets);
    contextParts.push(card);

    // Accumulate session cost impacts
    const sessionImpacts = readSessionImpacts(projectRoot, input.session_id);
    for (const impact of impacts) {
      const existing = sessionImpacts[impact.serviceId];
      if (existing) {
        existing.costLow += impact.costLow;
        existing.costHigh += impact.costHigh;
      } else {
        sessionImpacts[impact.serviceId] = {
          costLow: impact.costLow,
          costHigh: impact.costHigh,
        };
      }
    }
    writeSessionImpacts(projectRoot, input.session_id, sessionImpacts);

    // Log cost impact event
    logEvent(
      {
        timestamp: new Date().toISOString(),
        sessionId: input.session_id,
        type: "cost_impact",
        data: {
          file: filePath,
          impacts: impacts.map((i) => ({
            serviceId: i.serviceId,
            callCount: i.callCount,
            monthlyInvocations: i.monthlyInvocations,
            costLow: i.costLow,
            costHigh: i.costHigh,
          })),
        },
      },
      projectRoot,
    );
  }

  // --- Output ---
  if (contextParts.length > 0) {
    const output: HookOutput = {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: contextParts.join("\n\n"),
      },
    };

    process.stdout.write(JSON.stringify(output));
  }
}

main();
