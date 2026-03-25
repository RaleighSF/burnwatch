#!/usr/bin/env node

/**
 * Stop hook — fires when Claude Code finishes a response.
 *
 * Updates the ledger and saves a fresh snapshot.
 * Runs async to avoid blocking the session end.
 */

import * as fs from "node:fs";
import type { HookInput } from "../core/types.js";
import { readProjectConfig, isInitialized } from "../core/config.js";
import { pollAllServices } from "../services/index.js";
import { buildSnapshot, buildBrief } from "../core/brief.js";
import { writeLedger, saveSnapshot, logEvent } from "../core/ledger.js";

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
  const trackedServices = Object.values(config.services);

  if (trackedServices.length === 0) {
    process.exit(0);
    return;
  }

  try {
    // Poll all services for current spend
    const results = await pollAllServices(trackedServices);

    // Build snapshots
    const snapshots = results.map((r) =>
      buildSnapshot(
        r.serviceId,
        r.tier,
        r.spend,
        config.services[r.serviceId]?.budget,
      ),
    );

    const blindCount = snapshots.filter((s) => s.tier === "blind").length;
    const brief = buildBrief(config.projectName, snapshots, blindCount);

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
