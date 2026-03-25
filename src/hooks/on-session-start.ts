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
import { formatBrief, buildBrief, buildSnapshot } from "../core/brief.js";
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
    briefText = formatBrief(cachedBrief);
  } else {
    // No cache — build a brief from detection only (no API calls yet)
    const detected = detectServices(projectRoot);
    const snapshots = Object.values(config.services).map((tracked) => {
      return buildSnapshot(
        tracked.serviceId,
        tracked.hasApiKey ? "live" : "blind",
        tracked.planCost ?? 0,
        tracked.budget,
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
    briefText = formatBrief(brief);
  }

  // Step 2: Output the brief for Claude Code to inject
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
      const snapshots = results.map((r) =>
        buildSnapshot(r.serviceId, r.tier, r.spend, config.services[r.serviceId]?.budget),
      );
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
