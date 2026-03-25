#!/usr/bin/env node

/**
 * UserPromptSubmit hook — fires when the user submits a prompt.
 *
 * Scans the prompt text for service mentions and injects a spend card
 * for any tracked service that's mentioned.
 */

import * as fs from "node:fs";
import type { HookInput, HookOutput } from "../core/types.js";
import { readProjectConfig, isInitialized } from "../core/config.js";
import { detectMentions } from "../detection/detector.js";
import { readLatestSnapshot } from "../core/ledger.js";
import { formatSpendCard } from "../core/brief.js";
import { logEvent } from "../core/ledger.js";

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
  const prompt = input.prompt;

  // Guard: not initialized or no prompt
  if (!isInitialized(projectRoot) || !prompt) {
    process.exit(0);
    return;
  }

  const config = readProjectConfig(projectRoot)!;

  // Detect service mentions in the prompt
  const mentions = detectMentions(prompt, projectRoot);
  if (mentions.length === 0) {
    process.exit(0);
    return;
  }

  // Get the latest snapshot for spend data
  const snapshot = readLatestSnapshot(projectRoot);

  // Build spend cards for mentioned services
  const cards: string[] = [];

  for (const mention of mentions) {
    const serviceId = mention.service.id;
    const trackedService = config.services[serviceId];

    // Find this service's snapshot data
    const serviceSnapshot = snapshot?.services.find(
      (s) => s.serviceId === serviceId,
    );

    if (serviceSnapshot) {
      cards.push(formatSpendCard(serviceSnapshot));
    } else if (trackedService) {
      // Service is tracked but no snapshot data — show what we know
      cards.push(
        `[BURNWATCH] ${serviceId} — tracked, no spend data yet. Budget: ${trackedService.budget ? `$${trackedService.budget}` : "not set"}`,
      );
    } else {
      // Service detected but not tracked — flag it
      cards.push(
        `[BURNWATCH] ${serviceId} — detected in project but NOT tracked. Run 'burnwatch add ${serviceId}' to configure.`,
      );
    }

    // Log the mention
    logEvent(
      {
        timestamp: new Date().toISOString(),
        sessionId: input.session_id,
        type: "service_mentioned",
        data: { serviceId, prompt: prompt.slice(0, 200) },
      },
      projectRoot,
    );
  }

  if (cards.length === 0) {
    process.exit(0);
    return;
  }

  // Output spend cards for injection into context
  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: cards.join("\n\n"),
    },
  };

  process.stdout.write(JSON.stringify(output));
}

main();
