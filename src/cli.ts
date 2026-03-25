#!/usr/bin/env node

/**
 * burnwatch CLI
 *
 * Usage:
 *   burnwatch init                          — Initialize in current project
 *   burnwatch add <service> [options]       — Register a service
 *   burnwatch status                        — Show current spend brief
 *   burnwatch reconcile                     — Scan for untracked sessions
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  ensureProjectDirs,
  readProjectConfig,
  writeProjectConfig,
  readGlobalConfig,
  writeGlobalConfig,
  projectConfigDir,
  isInitialized,
} from "./core/config.js";
import type { ProjectConfig } from "./core/config.js";
import type { TrackedService } from "./core/types.js";
import { detectServices } from "./detection/detector.js";
import { pollAllServices } from "./services/index.js";
import { buildSnapshot, buildBrief, formatBrief } from "./core/brief.js";
import { writeLedger, saveSnapshot } from "./core/ledger.js";
import { getService, getAllServices } from "./core/registry.js";
import { runInteractiveInit } from "./interactive-init.js";

const args = process.argv.slice(2);
const command = args[0];
const flags = new Set(args.slice(1));

async function main(): Promise<void> {
  switch (command) {
    case "init":
    case "setup":
      await cmdInit();
      break;
    case "add":
      await cmdAdd();
      break;
    case "status":
      await cmdStatus();
      break;
    case "services":
      cmdServices();
      break;
    case "reconcile":
      await cmdReconcile();
      break;
    case "help":
    case "--help":
    case "-h":
      cmdHelp();
      break;
    case "version":
    case "--version":
    case "-v":
      cmdVersion();
      break;
    default:
      if (command) {
        console.error(`Unknown command: ${command}`);
        console.error('Run "burnwatch help" for usage.');
        process.exit(1);
      }
      cmdHelp();
  }
}

// --- Commands ---

async function cmdInit(): Promise<void> {
  const projectRoot = process.cwd();
  const nonInteractive = flags.has("--non-interactive") || flags.has("--ni");

  if (isInitialized(projectRoot)) {
    console.log("✅ burnwatch is already initialized in this project.");
    console.log(`   Config: ${projectConfigDir(projectRoot)}/config.json`);
    return;
  }

  // Detect project name from package.json
  let projectName = path.basename(projectRoot);
  try {
    const pkgPath = path.join(projectRoot, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      name?: string;
    };
    if (pkg.name) projectName = pkg.name;
  } catch {
    // Use directory name
  }

  // Create directories
  ensureProjectDirs(projectRoot);

  // Run initial detection
  console.log("🔍 Scanning project for paid services...\n");
  const detected = detectServices(projectRoot);

  // Create project config
  const config: ProjectConfig = {
    projectName,
    services: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (!nonInteractive && detected.length > 0 && process.stdin.isTTY) {
    // Interactive mode — walk through each service with plan tiers
    const result = await runInteractiveInit(detected);
    config.services = result.services;
  } else {
    // Non-interactive mode — auto-register all detected services
    for (const det of detected) {
      const tracked: TrackedService = {
        serviceId: det.service.id,
        detectedVia: det.sources,
        hasApiKey: false,
        firstDetected: new Date().toISOString(),
      };
      config.services[det.service.id] = tracked;
    }

    // Report findings
    if (detected.length === 0) {
      console.log("   No paid services detected yet.");
      console.log('   Services will be detected as they enter your project.\n');
    } else {
      console.log(`   Found ${detected.length} paid service${detected.length > 1 ? "s" : ""}:\n`);
      for (const det of detected) {
        const tierBadge =
          det.service.apiTier === "live"
            ? "✅ LIVE API available"
            : det.service.apiTier === "calc"
              ? "🟡 Flat-rate tracking"
              : det.service.apiTier === "est"
                ? "🟠 Estimate tracking"
                : "🔴 Detection only";

        console.log(`   • ${det.service.name} (${tierBadge})`);
        console.log(`     Detected via: ${det.details.join(", ")}`);
      }
      console.log("");
    }
  }

  writeProjectConfig(config, projectRoot);

  // Write initial .gitignore for the .burnwatch directory
  const gitignorePath = path.join(projectConfigDir(projectRoot), ".gitignore");
  fs.writeFileSync(
    gitignorePath,
    [
      "# Burnwatch — ignore cache and snapshots, keep ledger and config",
      "data/cache/",
      "data/snapshots/",
      "data/events.jsonl",
      "",
    ].join("\n"),
    "utf-8",
  );

  // Register Claude Code hooks
  console.log("\n🔗 Registering Claude Code hooks...\n");
  registerHooks(projectRoot);

  // Summary of excluded services
  const excluded = Object.values(config.services).filter((s) => s.excluded);
  const tracked = Object.values(config.services).filter((s) => !s.excluded);

  console.log("✅ burnwatch initialized!\n");

  if (tracked.length > 0) {
    console.log(`   Tracking ${tracked.length} service${tracked.length > 1 ? "s" : ""}`);
    for (const svc of tracked) {
      const planStr = svc.planName ? ` (${svc.planName})` : "";
      const budgetStr = svc.budget !== undefined ? ` — $${svc.budget}/mo budget` : "";
      console.log(`   • ${svc.serviceId}${planStr}${budgetStr}`);
    }
  }

  if (excluded.length > 0) {
    console.log(`\n   Excluded ${excluded.length} service${excluded.length > 1 ? "s" : ""}:`);
    for (const svc of excluded) {
      console.log(`   • ${svc.serviceId}`);
    }
  }

  console.log("\nNext steps:");
  console.log("  burnwatch status     — Check your spend");
  console.log("  burnwatch add <svc>  — Configure additional services\n");
}

async function cmdAdd(): Promise<void> {
  const projectRoot = process.cwd();

  if (!isInitialized(projectRoot)) {
    console.error('❌ burnwatch not initialized. Run "burnwatch init" first.');
    process.exit(1);
  }

  const serviceId = args[1];
  if (!serviceId) {
    console.error("Usage: burnwatch add <service> [--key KEY] [--budget N]");
    process.exit(1);
  }

  // Parse options
  const options: Record<string, string> = {};
  for (let i = 2; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--") && i + 1 < args.length) {
      options[arg.slice(2)] = args[i + 1]!;
      i++;
    }
  }

  const apiKey = options["key"] ?? options["token"];
  const budget = options["budget"] ? parseFloat(options["budget"]) : undefined;
  const planCost = options["plan-cost"]
    ? parseFloat(options["plan-cost"])
    : undefined;

  // Check if service is in registry
  const definition = getService(serviceId, projectRoot);
  if (!definition) {
    console.error(
      `⚠️  "${serviceId}" not found in registry. Adding as custom service.`,
    );
  }

  // Update project config
  const config = readProjectConfig(projectRoot)!;
  const existing = config.services[serviceId];

  const tracked: TrackedService = {
    serviceId,
    detectedVia: existing?.detectedVia ?? ["manual"],
    budget: budget ?? existing?.budget,
    hasApiKey: !!apiKey || (existing?.hasApiKey ?? false),
    planCost: planCost ?? existing?.planCost,
    firstDetected: existing?.firstDetected ?? new Date().toISOString(),
  };

  config.services[serviceId] = tracked;
  writeProjectConfig(config, projectRoot);

  // Save API key to global config (never in project dir)
  if (apiKey) {
    const globalConfig = readGlobalConfig();
    if (!globalConfig.services[serviceId]) {
      globalConfig.services[serviceId] = {};
    }
    globalConfig.services[serviceId]!.apiKey = apiKey;
    writeGlobalConfig(globalConfig);
    console.log(`🔐 API key saved to global config (never stored in project)`);
  }

  let tierLabel: string;
  if (!definition) {
    tierLabel = "🔴 BLIND";
  } else if (apiKey) {
    tierLabel = "✅ LIVE";
  } else if (planCost !== undefined) {
    tierLabel = "🟡 CALC";
  } else if (definition.apiTier === "est") {
    tierLabel = "🟠 EST";
  } else if (definition.apiTier === "calc") {
    tierLabel = "🟡 CALC";
  } else if (definition.apiTier === "live" && !apiKey) {
    tierLabel = `🔴 BLIND (add --key for ✅ LIVE)`;
  } else {
    tierLabel = "🔴 BLIND";
  }

  console.log(`\n✅ ${serviceId} configured:`);
  console.log(`   Tier: ${tierLabel}`);
  if (budget) console.log(`   Budget: $${budget}/mo`);
  if (planCost) console.log(`   Plan cost: $${planCost}/mo`);
  console.log("");
}

async function cmdStatus(): Promise<void> {
  const projectRoot = process.cwd();

  if (!isInitialized(projectRoot)) {
    console.error('❌ burnwatch not initialized. Run "burnwatch init" first.');
    process.exit(1);
  }

  const config = readProjectConfig(projectRoot)!;
  const trackedServices = Object.values(config.services);

  if (trackedServices.length === 0) {
    console.log("No services tracked yet.");
    console.log('Run "burnwatch add <service>" to start tracking.');
    return;
  }

  console.log("📊 Polling services...\n");

  const results = await pollAllServices(trackedServices);
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

  // Save snapshot and update ledger
  saveSnapshot(brief, projectRoot);
  writeLedger(brief, projectRoot);

  // Display the brief
  console.log(formatBrief(brief));
  console.log("");

  if (blindCount > 0) {
    console.log(`⚠️  ${blindCount} service${blindCount > 1 ? "s" : ""} untracked:`);
    for (const snap of snapshots.filter((s) => s.tier === "blind")) {
      console.log(
        `   • ${snap.serviceId} — run 'burnwatch add ${snap.serviceId} --key YOUR_KEY --budget N'`,
      );
    }
    console.log("");
  }
}

async function cmdSetup(): Promise<void> {
  const projectRoot = process.cwd();

  // Step 1: Init if needed
  if (!isInitialized(projectRoot)) {
    await cmdInit();
  }

  const config = readProjectConfig(projectRoot)!;
  const detected = Object.values(config.services);

  if (detected.length === 0) {
    console.log("No paid services detected. You're all set!");
    return;
  }

  console.log("📋 Auto-configuring detected services...\n");

  // Step 2: Check global config for existing API keys
  const globalConfig = readGlobalConfig();

  // Step 3: Auto-configure each service based on registry tier + available keys
  const liveServices: string[] = [];
  const calcServices: string[] = [];
  const estServices: string[] = [];
  const blindServices: string[] = [];

  for (const tracked of detected) {
    const definition = getService(tracked.serviceId, projectRoot);
    if (!definition) continue;

    const hasKey = !!globalConfig.services[tracked.serviceId]?.apiKey;

    if (hasKey && definition.apiTier === "live") {
      tracked.hasApiKey = true;
      liveServices.push(`${definition.name}`);
    } else if (definition.apiTier === "calc") {
      calcServices.push(`${definition.name}`);
    } else if (definition.apiTier === "est") {
      estServices.push(`${definition.name}`);
    } else {
      blindServices.push(`${definition.name}`);
    }
  }

  writeProjectConfig(config, projectRoot);

  // Report
  if (liveServices.length > 0) {
    console.log(`  ✅ LIVE (real billing data): ${liveServices.join(", ")}`);
  }
  if (calcServices.length > 0) {
    console.log(`  🟡 CALC (flat-rate tracking): ${calcServices.join(", ")}`);
  }
  if (estServices.length > 0) {
    console.log(`  🟠 EST (estimated from usage): ${estServices.join(", ")}`);
  }
  if (blindServices.length > 0) {
    console.log(`  🔴 BLIND (detected, need API key): ${blindServices.join(", ")}`);
  }

  console.log("");

  if (blindServices.length > 0) {
    console.log("To upgrade BLIND services to LIVE, add API keys:");
    for (const tracked of detected) {
      const definition = getService(tracked.serviceId, projectRoot);
      if (definition?.apiTier === "live" && !tracked.hasApiKey) {
        const envHint = definition.envPatterns[0] ?? "YOUR_KEY";
        console.log(`  burnwatch add ${tracked.serviceId} --key $${envHint} --budget <N>`);
      }
    }
    console.log("");
  }

  console.log("To set budgets for any service:");
  console.log("  burnwatch add <service> --budget <monthly_amount>");
  console.log("");
  console.log("Or use /setup-burnwatch in Claude Code for guided setup with budget suggestions.\n");

  // Show brief
  await cmdStatus();
}

function cmdServices(): void {
  const services = getAllServices();
  console.log(`\n📋 Registry: ${services.length} services available\n`);

  for (const svc of services) {
    const tierBadge =
      svc.apiTier === "live"
        ? "✅ LIVE"
        : svc.apiTier === "calc"
          ? "🟡 CALC"
          : svc.apiTier === "est"
            ? "🟠 EST"
            : "🔴 BLIND";

    console.log(`  ${svc.name.padEnd(24)} ${tierBadge.padEnd(10)} ${svc.billingModel}`);
  }

  console.log("");
}

async function cmdReconcile(): Promise<void> {
  const projectRoot = process.cwd();

  if (!isInitialized(projectRoot)) {
    console.error('❌ burnwatch not initialized. Run "burnwatch init" first.');
    process.exit(1);
  }

  console.log("🔍 Scanning for untracked services and missed sessions...\n");

  // Re-run detection against current project state
  const detected = detectServices(projectRoot);
  const config = readProjectConfig(projectRoot)!;
  let newCount = 0;

  for (const det of detected) {
    if (!config.services[det.service.id]) {
      config.services[det.service.id] = {
        serviceId: det.service.id,
        detectedVia: det.sources,
        hasApiKey: false,
        firstDetected: new Date().toISOString(),
      };
      newCount++;
      console.log(`  🆕 ${det.service.name} — detected via ${det.details.join(", ")}`);
    }
  }

  if (newCount > 0) {
    writeProjectConfig(config, projectRoot);
    console.log(
      `\n✅ Found ${newCount} new service${newCount > 1 ? "s" : ""}. Run 'burnwatch status' to see updated brief.`,
    );
  } else {
    console.log("  ✅ No new services found. All services already tracked.");
  }

  console.log("");
}

function cmdHelp(): void {
  console.log(`
burnwatch — Passive cost memory for vibe coding

Usage:
  burnwatch init                              Interactive setup — pick plans per service
  burnwatch init --non-interactive            Auto-detect services, no prompts
  burnwatch setup                             Init + auto-configure all detected services
  burnwatch add <service> [options]           Register a service for tracking
  burnwatch status                            Show current spend brief
  burnwatch services                          List all services in registry
  burnwatch reconcile                         Scan for untracked services

Options for 'add':
  --key <API_KEY>        API key for LIVE tracking (saved to ~/.config/burnwatch/)
  --token <TOKEN>        Same as --key (alias)
  --budget <AMOUNT>      Monthly budget in USD
  --plan-cost <AMOUNT>   Monthly plan cost for CALC tracking

Examples:
  burnwatch init
  burnwatch init --non-interactive
  burnwatch add anthropic --key sk-ant-admin-xxx --budget 100
  burnwatch add scrapfly --key scp-xxx --budget 50
  burnwatch add posthog --plan-cost 0 --budget 0
  burnwatch status
`);
}

function cmdVersion(): void {
  try {
    const pkgPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../package.json",
    );
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      version: string;
    };
    console.log(`burnwatch v${pkg.version}`);
  } catch {
    console.log("burnwatch v0.1.0");
  }
}

// --- Hook Registration ---

function registerHooks(projectRoot: string): void {
  // Step 1: Copy hook scripts into .burnwatch/hooks/ for durability.
  // This avoids relying on ephemeral npx cache paths.
  const sourceHooksDir = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "hooks",
  );
  const localHooksDir = path.join(projectRoot, ".burnwatch", "hooks");
  fs.mkdirSync(localHooksDir, { recursive: true });

  const hookFiles = [
    "on-session-start.js",
    "on-prompt.js",
    "on-file-change.js",
    "on-stop.js",
  ];

  for (const file of hookFiles) {
    const src = path.join(sourceHooksDir, file);
    const dest = path.join(localHooksDir, file);
    try {
      fs.copyFileSync(src, dest);
      // Also copy sourcemaps if they exist
      const mapSrc = src + ".map";
      if (fs.existsSync(mapSrc)) {
        fs.copyFileSync(mapSrc, dest + ".map");
      }
    } catch (err) {
      console.error(`   Warning: Could not copy hook ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`   Hook scripts copied to ${localHooksDir}`);

  // Step 2: Find or create .claude/settings.json — MERGE, never overwrite
  const claudeDir = path.join(projectRoot, ".claude");
  const settingsPath = path.join(claudeDir, "settings.json");

  fs.mkdirSync(claudeDir, { recursive: true });

  // Read existing settings (preserve everything)
  let settings: Record<string, unknown> = {};
  try {
    const existing = fs.readFileSync(settingsPath, "utf-8");
    settings = JSON.parse(existing) as Record<string, unknown>;
    console.log(`   Merging into existing ${settingsPath}`);
  } catch {
    // No existing settings — start fresh
  }

  // Ensure hooks object exists, preserve all existing hooks
  if (!settings["hooks"] || typeof settings["hooks"] !== "object") {
    settings["hooks"] = {};
  }
  const hooks = settings["hooks"] as Record<string, unknown[]>;

  // Use the local .burnwatch/hooks/ paths (durable, not ephemeral)
  const hooksDir = localHooksDir;

  // SessionStart hook
  if (!hooks["SessionStart"]) hooks["SessionStart"] = [];
  addHookIfMissing(hooks["SessionStart"] as unknown[], "SessionStart", {
    matcher: "startup|resume",
    hooks: [
      {
        type: "command",
        command: `node "${path.join(hooksDir, "on-session-start.js")}"`,
        timeout: 15,
      },
    ],
  });

  // UserPromptSubmit hook
  if (!hooks["UserPromptSubmit"]) hooks["UserPromptSubmit"] = [];
  addHookIfMissing(
    hooks["UserPromptSubmit"] as unknown[],
    "UserPromptSubmit",
    {
      hooks: [
        {
          type: "command",
          command: `node "${path.join(hooksDir, "on-prompt.js")}"`,
          timeout: 5,
        },
      ],
    },
  );

  // PostToolUse hook (Edit|Write only)
  if (!hooks["PostToolUse"]) hooks["PostToolUse"] = [];
  addHookIfMissing(hooks["PostToolUse"] as unknown[], "PostToolUse", {
    matcher: "Edit|Write",
    hooks: [
      {
        type: "command",
        command: `node "${path.join(hooksDir, "on-file-change.js")}"`,
        timeout: 5,
      },
    ],
  });

  // Stop hook (async — don't block session end)
  if (!hooks["Stop"]) hooks["Stop"] = [];
  addHookIfMissing(hooks["Stop"] as unknown[], "Stop", {
    hooks: [
      {
        type: "command",
        command: `node "${path.join(hooksDir, "on-stop.js")}"`,
        timeout: 15,
        async: true,
      },
    ],
  });

  settings["hooks"] = hooks;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  console.log(`   Hooks registered in ${settingsPath}`);
}

function addHookIfMissing(
  hookArray: unknown[],
  _eventName: string,
  hookConfig: unknown,
): void {
  // Check if burnwatch hook is already registered
  const existing = hookArray.some((h) => {
    const hook = h as { hooks?: Array<{ command?: string }> };
    return hook.hooks?.some((inner) => inner.command?.includes("burnwatch"));
  });

  if (!existing) {
    hookArray.push(hookConfig);
  }
}

// --- Entry ---

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
