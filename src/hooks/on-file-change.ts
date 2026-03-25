#!/usr/bin/env node

/**
 * PostToolUse hook (Edit|Write) — fires when files are changed.
 *
 * Scans changed files for new service introductions:
 * - New dependencies in package.json
 * - New env vars in .env files
 * - New import statements in source files
 */

import * as fs from "node:fs";
import type { HookInput, HookOutput } from "../core/types.js";
import {
  readProjectConfig,
  writeProjectConfig,
  isInitialized,
} from "../core/config.js";
import { detectInFileChange } from "../detection/detector.js";
import { logEvent } from "../core/ledger.js";
import type { TrackedService } from "../core/types.js";

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

  // Detect new services in this file change
  const detected = detectInFileChange(filePath, content, projectRoot);
  if (detected.length === 0) {
    process.exit(0);
    return;
  }

  const config = readProjectConfig(projectRoot)!;
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

    const output: HookOutput = {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: alerts.join("\n\n"),
      },
    };

    process.stdout.write(JSON.stringify(output));
  }
}

main();
