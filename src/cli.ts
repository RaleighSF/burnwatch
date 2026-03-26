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
import { detectServices, findEnvFiles, parseEnvKeys } from "./detection/detector.js";
import { pollAllServices } from "./services/index.js";
import { buildSnapshot, buildBrief, formatBrief } from "./core/brief.js";
import { writeLedger, saveSnapshot } from "./core/ledger.js";
import { getService, getAllServices } from "./core/registry.js";
import { runInteractiveInit, autoConfigureServices } from "./interactive-init.js";
import {
  buildUtilizationModel,
  writeUtilizationModel,
  readUtilizationModel,
  formatUtilizationSummary,
} from "./utilization.js";

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
    case "interview":
      await cmdInterview();
      break;
    case "configure":
      await cmdConfigure();
      break;
    case "scan":
      cmdScan();
      break;
    case "reset":
      cmdReset();
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
  const alreadyInitialized = isInitialized(projectRoot);

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

  // Create directories (idempotent)
  ensureProjectDirs(projectRoot);

  // Run detection
  console.log("🔍 Scanning project for paid services...\n");
  const detected = detectServices(projectRoot);

  // Load existing config or create new one
  const existingConfig = alreadyInitialized ? readProjectConfig(projectRoot) : null;
  const config: ProjectConfig = {
    projectName: existingConfig?.projectName ?? projectName,
    services: existingConfig?.services ?? {},
    createdAt: existingConfig?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (detected.length === 0) {
    console.log("   No paid services detected yet.");
    console.log("   Services will be detected as they enter your project.\n");
  } else if (nonInteractive) {
    // Explicit --non-interactive: minimal auto-register (CI/scripts)
    for (const det of detected) {
      if (!config.services[det.service.id]) {
        config.services[det.service.id] = {
          serviceId: det.service.id,
          detectedVia: det.sources,
          hasApiKey: false,
          firstDetected: new Date().toISOString(),
          budget: 0,
        };
      }
    }
    console.log(`   Registered ${detected.length} services (non-interactive).\n`);
  } else if (process.stdin.isTTY) {
    // TTY: full interactive interview with readline prompts
    const result = await runInteractiveInit(detected);
    config.services = result.services;
  } else {
    // No TTY (Claude Code, piped): auto-configure with smart defaults
    const result = await autoConfigureServices(detected);
    config.services = result.services;
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

  // Build initial utilization model
  console.log("📊 Scanning for utilization patterns...");
  try {
    const model = buildUtilizationModel(projectRoot);
    writeUtilizationModel(model, projectRoot);
    const serviceCount = Object.keys(model.services).length;
    if (serviceCount > 0) {
      console.log(`   Found call sites for ${serviceCount} service(s).\n`);
    } else {
      console.log("   No SDK call sites detected yet.\n");
    }
  } catch {
    console.log("   Utilization scan skipped.\n");
  }

  // Register Claude Code hooks
  console.log("🔗 Registering Claude Code hooks...\n");
  registerHooks(projectRoot);

  console.log("\nburnwatch initialized.\n");
  if (process.stdin.isTTY) {
    console.log("Next steps:");
    console.log("  burnwatch status        Show current spend");
    console.log("  burnwatch add <svc>     Update a service's budget or API key");
    console.log("  burnwatch init          Re-run this setup anytime\n");
  } else {
    console.log("Next steps:");
    console.log("  Ask your agent to run /burnwatch-interview for guided setup");
    console.log("  Or run 'burnwatch status' to see current spend\n");
  }
}

/**
 * burnwatch interview --json
 *
 * Exports the current project state as structured JSON for an AI agent
 * to conduct the interview conversationally. The agent reads this,
 * asks the user questions, then writes answers back via `burnwatch configure`.
 */
async function cmdInterview(): Promise<void> {
  const projectRoot = process.cwd();

  if (!isInitialized(projectRoot)) {
    // Auto-init first
    ensureProjectDirs(projectRoot);
    const detected = detectServices(projectRoot);
    let projectName = path.basename(projectRoot);
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"),
      ) as { name?: string };
      if (pkg.name) projectName = pkg.name;
    } catch {
      // Use directory name
    }

    const config: ProjectConfig = {
      projectName,
      services: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Auto-configure with defaults first
    const result = await autoConfigureServices(detected);
    config.services = result.services;
    writeProjectConfig(config, projectRoot);
  }

  const config = readProjectConfig(projectRoot)!;
  const globalConfig = readGlobalConfig();
  const allRegistryServices = getAllServices(projectRoot);

  // Services with billing connectors that support LIVE polling
  const connectorServices = ["anthropic", "openai", "vercel", "scrapfly", "supabase", "browserbase"];

  // Build structured export for each tracked service
  const serviceStates: Array<{
    serviceId: string;
    serviceName: string;
    currentPlan: string | null;
    currentBudget: number | null;
    hasApiKey: boolean;
    keySource: string | null;
    tier: string;
    excluded: boolean;
    hasProbe: boolean;
    hasConnector: boolean;
    canGoLive: boolean;
    envKeysFound: string[];
    suggestedAction: string;
    probeResult: import("./probes.js").ProbeResult | null;
    availablePlans: Array<{
      index: number;
      name: string;
      type: string;
      monthlyCost: number | null;
      includedUnits: number | null;
      unitName: string | null;
      suggestedBudget: number | null;
      isDefault: boolean;
    }>;
    riskCategory: string;
    billingModel: string;
    apiKeyHint: string | null;
    allowance: { included: number; unitName: string } | null;
  }> = [];

  for (const [serviceId, tracked] of Object.entries(config.services)) {
    const definition = allRegistryServices.find((s) => s.id === serviceId);
    if (!definition) continue;

    // Determine key source — check global config, then env vars, then .env files
    let keySource: string | null = null;
    const envKeysFound: string[] = [];
    const globalKey = globalConfig.services[serviceId]?.apiKey;

    // Always scan for env keys to report what's available
    // Check process.env
    for (const pattern of definition.envPatterns) {
      if (process.env[pattern]) {
        envKeysFound.push(pattern);
        if (!keySource && !globalKey) keySource = `env:${pattern}`;
      }
    }

    // Scan .env files on disk (agent context may not have them in process.env)
    // Use the same recursive finder as the detector to catch all .env* files
    const envFiles = findEnvFiles(projectRoot, 3);
    for (const envFilePath of envFiles) {
      try {
        const envContent = fs.readFileSync(envFilePath, "utf-8");
        const envKeys = parseEnvKeys(envContent);
        const envFileName = path.relative(projectRoot, envFilePath);
        for (const pattern of definition.envPatterns) {
          if (envKeys.has(pattern)) {
            const label = `${pattern} (in ${envFileName})`;
            if (!envKeysFound.some(k => k.startsWith(pattern))) {
              envKeysFound.push(label);
            }
            if (!keySource && !globalKey) keySource = `file:${envFileName}:${pattern}`;
          }
        }
      } catch {
        // File doesn't exist or unreadable, skip
      }
    }

    if (globalKey) keySource = "global_config";

    // Resolve the actual API key value
    let apiKey: string | undefined = globalKey;
    if (!apiKey && keySource?.startsWith("env:")) {
      apiKey = process.env[keySource.slice(4)];
    }
    if (!apiKey && keySource?.startsWith("file:")) {
      // Extract key from .env file: "file:.env.local:SCRAPFLY_KEY"
      const parts = keySource.split(":");
      const envFile = parts[1]!;
      const envVar = parts[2]!;
      try {
        const envContent = fs.readFileSync(path.join(projectRoot, envFile), "utf-8");
        // Handle: KEY=value, export KEY=value, KEY="value", KEY='value'
        const regex = new RegExp(`^(?:export\\s+)?${envVar}\\s*=\\s*(.+)$`, "m");
        const match = envContent.match(regex);
        if (match?.[1]) apiKey = match[1].trim().replace(/^["']|["']$/g, "");
      } catch {
        // skip
      }
    }

    // Try probing if we have a key
    let probeResult: import("./probes.js").ProbeResult | null = null;
    const { probeService: probe, hasProbe: checkProbe } = await import("./probes.js");
    if (apiKey && checkProbe(serviceId)) {
      probeResult = await probe(serviceId, apiKey, definition.plans ?? []);
    }

    // Determine tier
    let tier = "blind";
    if (tracked.excluded) tier = "excluded";
    else if (tracked.hasApiKey) tier = "live";
    else if (tracked.planCost !== undefined) tier = "calc";

    // Risk category
    let riskCategory = "flat";
    if (definition.billingModel === "token_usage") riskCategory = "llm";
    else if (["credit_pool", "percentage", "per_unit"].includes(definition.billingModel)) riskCategory = "usage";
    else if (definition.billingModel === "compute") riskCategory = "infra";

    const keyHints: Record<string, string> = {
      anthropic: "Admin key from console.anthropic.com → Settings → Admin API Keys (sk-ant-admin-*)",
      openai: "Admin key from platform.openai.com → Settings → API Keys (sk-admin-*)",
      vercel: "Token from vercel.com/account/tokens",
      supabase: "PAT from supabase.com/dashboard → Account → Access Tokens (not service_role key)",
      scrapfly: "API key from scrapfly.io/dashboard",
      browserbase: "API key from browserbase.com → Settings → API Keys",
      upstash: "email:api_key from console.upstash.com → Account → Management API",
      posthog: "Personal API key from posthog.com → Settings → Personal API Keys",
    };

    const hasConnector = connectorServices.includes(serviceId);
    const canGoLive = hasConnector && !tracked.hasApiKey && !apiKey;

    // Generate a suggested action for the agent
    let suggestedAction: string;
    if (tracked.excluded) {
      suggestedAction = "excluded — skip";
    } else if (probeResult && probeResult.confidence === "high") {
      suggestedAction = `confirm — probe detected ${probeResult.summary}`;
    } else if (apiKey && hasConnector) {
      suggestedAction = "configure with found key — LIVE tracking available";
    } else if (apiKey && !hasConnector) {
      suggestedAction = "key found but no billing connector — set plan cost for CALC tracking";
    } else if (canGoLive) {
      suggestedAction = `ask for API key — LIVE tracking possible (${keyHints[serviceId] ?? "check service dashboard"})`;
    } else if (!hasConnector) {
      suggestedAction = "no billing API — ask for plan tier and set budget as alert threshold";
    } else {
      suggestedAction = "ask user for plan details";
    }

    serviceStates.push({
      serviceId,
      serviceName: definition.name,
      currentPlan: tracked.planName ?? null,
      currentBudget: tracked.budget ?? null,
      hasApiKey: tracked.hasApiKey,
      keySource,
      tier,
      excluded: tracked.excluded ?? false,
      hasProbe: checkProbe(serviceId),
      hasConnector,
      canGoLive,
      envKeysFound,
      suggestedAction,
      probeResult,
      availablePlans: (definition.plans ?? []).map((p, i) => ({
        index: i + 1,
        name: p.name,
        type: p.type,
        monthlyCost: p.monthlyBase ?? null,
        includedUnits: p.includedUnits ?? null,
        unitName: p.unitName ?? null,
        suggestedBudget: p.suggestedBudget ?? null,
        isDefault: p.default ?? false,
      })),
      riskCategory,
      billingModel: definition.billingModel,
      apiKeyHint: keyHints[serviceId] ?? null,
      allowance: tracked.allowance ?? null,
    });
  }

  // Sort: llm first, then usage, infra, flat
  const riskOrder = ["llm", "usage", "infra", "flat"];
  serviceStates.sort(
    (a, b) => riskOrder.indexOf(a.riskCategory) - riskOrder.indexOf(b.riskCategory),
  );

  // Read utilization model for interview context
  const utilizationModel = readUtilizationModel(projectRoot);
  const utilizationSummary: Record<string, {
    totalMonthlyUnits: number;
    unitName: string;
    planIncluded: number | null;
    projectedOverageCost: number;
    topCallSites: string[];
  }> = {};

  for (const [serviceId, svc] of Object.entries(utilizationModel.services)) {
    if (svc.totalMonthlyUnits > 0) {
      utilizationSummary[serviceId] = {
        totalMonthlyUnits: svc.totalMonthlyUnits,
        unitName: svc.unitName,
        planIncluded: svc.planIncluded,
        projectedOverageCost: svc.projectedOverageCost,
        topCallSites: svc.callSites
          .sort((a, b) => b.monthlyInvocations - a.monthlyInvocations)
          .slice(0, 5)
          .map((cs) => `${cs.filePath} (${cs.monthlyInvocations})`),
      };
    }
  }

  const output = {
    projectName: config.projectName,
    serviceCount: serviceStates.length,
    totalBudget: serviceStates.reduce((sum, s) => sum + (s.currentBudget ?? 0), 0),
    liveCount: serviceStates.filter((s) => s.tier === "live").length,
    blindCount: serviceStates.filter((s) => s.tier === "blind").length,
    canGoLiveCount: serviceStates.filter((s) => s.canGoLive).length,
    keysFoundInEnv: serviceStates.filter((s) => s.envKeysFound.length > 0).length,
    utilization: utilizationSummary,
    services: serviceStates,
    instructions: {
      keyStorage: "burnwatch stores API keys in ~/.config/burnwatch/ (chmod 600) — never in the project directory. Use --key flag with configure to save keys securely.",
      liveTracking: "Services with hasConnector=true can do LIVE billing tracking when given an API key. Services without a connector can only do CALC (budget threshold alerts).",
      configureCommand: "burnwatch configure --service <id> [--plan <name>] [--budget <N>] [--key <KEY>] [--exclude]",
      utilizationNote: "The 'utilization' field shows code-projected usage from SDK call sites. Services with high projectedOverageCost may need plan upgrades or budget alerts.",
    },
  };

  if (flags.has("--json")) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    // Human-readable summary pointing to --json
    console.log(`\n📋 Interview state for ${config.projectName}\n`);
    console.log(`   ${serviceStates.length} services detected`);
    console.log(`   ${output.liveCount} with API keys (LIVE)`);
    console.log(`   ${output.blindCount} without tracking (BLIND)`);
    console.log(`   Total budget: $${output.totalBudget}/mo\n`);
    console.log(`   Use --json for machine-readable output.`);
    console.log(`   Use 'burnwatch configure' to update services.\n`);
  }
}

/**
 * burnwatch configure --service <id> [--plan <name>] [--budget <N>] [--key <KEY>] [--exclude]
 *
 * Agent-friendly command to write back interview answers for a single service.
 * Designed to be called by the AI agent after conversing with the user.
 */
async function cmdConfigure(): Promise<void> {
  const projectRoot = process.cwd();

  if (!isInitialized(projectRoot)) {
    console.error('❌ burnwatch not initialized. Run "burnwatch init" first.');
    process.exit(1);
  }

  // Parse named options
  const options: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--") && i + 1 < args.length) {
      options[arg.slice(2)] = args[i + 1]!;
      i++;
    } else if (arg === "--exclude") {
      options["exclude"] = "true";
    }
  }

  const serviceId = options["service"];
  if (!serviceId) {
    console.error("Usage: burnwatch configure --service <id> [--plan <name>] [--budget <N>] [--key <KEY>] [--exclude]");
    process.exit(1);
  }

  const config = readProjectConfig(projectRoot)!;
  const definition = getService(serviceId, projectRoot);
  const globalConfig = readGlobalConfig();

  // Get or create tracked service entry
  let tracked = config.services[serviceId];
  if (!tracked) {
    tracked = {
      serviceId,
      detectedVia: ["manual"],
      hasApiKey: false,
      firstDetected: new Date().toISOString(),
      budget: 0,
    };
  }

  // Handle --exclude
  if (options["exclude"] === "true") {
    tracked.excluded = true;
    tracked.planName = "Don't track for this project";
    delete tracked.budget;
    delete tracked.planCost;
    delete tracked.allowance;
    config.services[serviceId] = tracked;
    writeProjectConfig(config, projectRoot);
    console.log(JSON.stringify({ success: true, serviceId, action: "excluded" }));
    return;
  }

  // Handle --plan
  if (options["plan"]) {
    const planSearch = options["plan"].toLowerCase();
    const plans = definition?.plans ?? [];
    const budgetHint = options["budget"] !== undefined ? parseFloat(options["budget"]) : undefined;

    // Find all matching candidates (not just the first)
    let candidates = plans.filter(
      (p) =>
        p.name.toLowerCase().includes(planSearch) ||
        p.name.toLowerCase().split(/[\s(]/)[0] === planSearch,
    );

    // If no match, try with $ amounts stripped (shell eats $N vars)
    if (candidates.length === 0) {
      const stripped = planSearch.replace(/\(\s*\//, "(").replace(/\$\d+/g, "");
      candidates = plans.filter((p) => {
        const pStripped = p.name.toLowerCase().replace(/\$\d+/g, "").replace(/\(\s*\//, "(");
        return pStripped.includes(stripped) || stripped.includes(pStripped.split(/[\s(]/)[0]!);
      });
    }

    // Disambiguate when multiple candidates match (e.g., "Max $100" vs "Max $200")
    let matched = candidates[0];
    if (candidates.length > 1) {
      let disambiguated = false;

      // Try extracting $ amount from the plan string itself (e.g., "Max ($200/mo)")
      const dollarMatch = options["plan"].match(/\$(\d+)/);
      if (dollarMatch) {
        const amount = parseInt(dollarMatch[1]!, 10);
        const byAmount = candidates.find((p) => p.monthlyBase === amount);
        if (byAmount) { matched = byAmount; disambiguated = true; }
      }

      // If budget hint provided, use it to disambiguate (overrides $ extraction)
      if (budgetHint !== undefined && !isNaN(budgetHint)) {
        const byBudget = candidates.find((p) => p.monthlyBase === budgetHint);
        if (byBudget) { matched = byBudget; disambiguated = true; }
      }

      // If still ambiguous and plan string looks shell-mangled (no $ amount),
      // try to infer from the numeric part alone (e.g., "200" in the plan string)
      if (!disambiguated) {
        const numMatch = options["plan"].match(/(\d{2,})/);
        if (numMatch) {
          const amount = parseInt(numMatch[1]!, 10);
          const byAmount = candidates.find((p) => p.monthlyBase === amount);
          if (byAmount) matched = byAmount;
        }
      }
    }

    if (matched) {
      tracked.planName = matched.name;
      tracked.excluded = false;

      if (matched.type === "flat" && matched.monthlyBase !== undefined) {
        tracked.planCost = matched.monthlyBase;
        if (options["budget"] === undefined && (tracked.budget === undefined || tracked.budget === 0)) {
          tracked.budget = matched.monthlyBase;
        }
      } else if (matched.suggestedBudget !== undefined && options["budget"] === undefined) {
        if (tracked.budget === undefined || tracked.budget === 0) {
          tracked.budget = matched.suggestedBudget;
        }
      }

      if (matched.includedUnits !== undefined && matched.unitName) {
        tracked.allowance = { included: matched.includedUnits, unitName: matched.unitName };
      } else {
        delete tracked.allowance;
      }
    } else {
      // Truly no match — use as literal plan name
      tracked.planName = options["plan"];
    }
  }

  // Handle --budget
  if (options["budget"] !== undefined) {
    const parsed = parseFloat(options["budget"]);
    if (!isNaN(parsed)) {
      tracked.budget = parsed;
    }
  }

  // Handle --key
  if (options["key"]) {
    tracked.hasApiKey = true;
    if (!globalConfig.services[serviceId]) {
      globalConfig.services[serviceId] = {};
    }
    globalConfig.services[serviceId]!.apiKey = options["key"];
    writeGlobalConfig(globalConfig);

    // Probe with the new key if possible
    const { probeService: probe, hasProbe: checkProbe } = await import("./probes.js");
    if (checkProbe(serviceId) && definition?.plans) {
      const probeResult = await probe(serviceId, options["key"], definition.plans);
      if (probeResult?.matchedPlan && probeResult.confidence === "high" && !options["plan"]) {
        // Auto-apply detected plan
        const mp = probeResult.matchedPlan;
        tracked.planName = mp.name;
        if (mp.type === "flat" && mp.monthlyBase !== undefined) {
          tracked.planCost = mp.monthlyBase;
          if (options["budget"] === undefined) tracked.budget = mp.monthlyBase;
        }
        if (mp.includedUnits !== undefined && mp.unitName) {
          tracked.allowance = { included: mp.includedUnits, unitName: mp.unitName };
        }
      }
    }
  }

  config.services[serviceId] = tracked;
  writeProjectConfig(config, projectRoot);

  // Determine final tier — check if we actually have a billing connector
  const connectorServices = ["anthropic", "openai", "vercel", "scrapfly", "supabase", "browserbase"];
  const hasConnector = connectorServices.includes(serviceId);

  let tier = "blind";
  let tierNote: string | null = null;
  if (tracked.excluded) {
    tier = "excluded";
  } else if (tracked.hasApiKey && hasConnector) {
    tier = "live";
  } else if (tracked.hasApiKey && !hasConnector) {
    tier = "calc";
    tierNote = `Key saved but ${serviceId} has no billing connector yet — tracking as CALC. The key will be used for probing during interviews.`;
  } else if (tracked.planCost !== undefined) {
    tier = "calc";
  }

  const result = {
    success: true,
    serviceId,
    plan: tracked.planName ?? null,
    budget: tracked.budget ?? null,
    tier,
    tierNote,
    hasApiKey: tracked.hasApiKey,
    allowance: tracked.allowance ?? null,
  };

  console.log(JSON.stringify(result));
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
  const trackedServices = Object.values(config.services).filter(
    (s) => !s.excluded,
  );

  if (trackedServices.length === 0) {
    console.log("No services tracked yet.");
    console.log('Run "burnwatch add <service>" to start tracking.');
    return;
  }

  console.log("📊 Polling services...\n");

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

  // Save snapshot and update ledger
  saveSnapshot(brief, projectRoot);
  writeLedger(brief, projectRoot);

  // Display the brief
  console.log(formatBrief(brief));
  console.log("");

  if (blindCount > 0) {
    console.log(`⚠️  ${blindCount} service${blindCount > 1 ? "s" : ""} with no billing data:`);
    for (const snap of snapshots.filter((s) => s.tier === "blind")) {
      console.log(`   • ${snap.serviceId} — add an API key for live tracking`);
    }
    console.log(`\n   Run 'burnwatch configure --service <id> --key <KEY>' to enable live billing.\n`);
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

function cmdScan(): void {
  const projectRoot = process.cwd();

  if (!isInitialized(projectRoot)) {
    console.error("burnwatch is not initialized. Run 'burnwatch init' first.");
    process.exit(1);
    return;
  }

  console.log("📊 Scanning project for utilization patterns...\n");

  const model = buildUtilizationModel(projectRoot);

  // Apply plan data from config
  const config = readProjectConfig(projectRoot)!;
  for (const [serviceId, svc] of Object.entries(model.services)) {
    const tracked = config.services[serviceId];
    const definition = getService(serviceId, projectRoot);
    if (tracked?.allowance) {
      svc.planIncluded = tracked.allowance.included;
      svc.unitName = tracked.allowance.unitName;
    }
    if (definition?.pricing?.unitRate) {
      svc.unitRate = definition.pricing.unitRate;
    }
    if (tracked?.planCost !== undefined) {
      svc.planBaseCost = tracked.planCost;
    }
    // Recalculate with updated config
    svc.projectedOverage = Math.max(0, svc.totalMonthlyUnits - (svc.planIncluded ?? 0));
    svc.projectedOverageCost = svc.projectedOverage * svc.unitRate;
    svc.projectedTotalCost = svc.planBaseCost + svc.projectedOverageCost;
  }

  writeUtilizationModel(model, projectRoot);

  console.log(formatUtilizationSummary(model));

  if (flags.has("--verbose")) {
    console.log("\nDetailed call sites:\n");
    for (const svc of Object.values(model.services)) {
      if (svc.callSites.length === 0) continue;
      console.log(`  ${svc.serviceName}:`);
      for (const cs of svc.callSites) {
        console.log(
          `    ${cs.filePath} — ${cs.callCount} call(s) × ${cs.multiplierFactor}x → ~${cs.monthlyInvocations} invocations/mo`,
        );
        if (cs.multipliers.length > 0) {
          console.log(`      Multipliers: ${cs.multipliers.join(", ")}`);
        }
      }
      console.log("");
    }
  }
}

function cmdReset(): void {
  const projectRoot = process.cwd();
  const burnwatchDir = path.join(projectRoot, ".burnwatch");
  const claudeSkillsDir = path.join(projectRoot, ".claude", "skills");

  if (!fs.existsSync(burnwatchDir)) {
    console.log("burnwatch is not initialized in this project.");
    return;
  }

  // Remove .burnwatch directory
  fs.rmSync(burnwatchDir, { recursive: true, force: true });
  console.log(`🗑️  Removed ${burnwatchDir}`);

  // Remove burnwatch skills from .claude/skills/
  const skillNames = ["setup-burnwatch", "burnwatch-interview", "spend"];
  for (const skill of skillNames) {
    const skillDir = path.join(claudeSkillsDir, skill);
    if (fs.existsSync(skillDir)) {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }
  }
  console.log("🗑️  Removed burnwatch skills from .claude/skills/");

  // Remove burnwatch hooks from .claude/settings.json
  const settingsPath = path.join(projectRoot, ".claude", "settings.json");
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      const hooks = settings["hooks"] as Record<string, unknown[]> | undefined;
      if (hooks) {
        for (const [event, hookList] of Object.entries(hooks)) {
          hooks[event] = (hookList as Array<{ hooks?: Array<{ command?: string }> }>).filter(
            (h) => !h.hooks?.some((inner) => inner.command?.includes("burnwatch")),
          );
          if ((hooks[event] as unknown[]).length === 0) delete hooks[event];
        }
        if (Object.keys(hooks).length === 0) delete settings["hooks"];
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
        console.log("🗑️  Removed burnwatch hooks from .claude/settings.json");
      }
    } catch {
      console.log("⚠️  Could not clean .claude/settings.json — remove burnwatch hooks manually");
    }
  }

  console.log("\n✅ burnwatch fully reset. Global API keys in ~/.config/burnwatch/ were preserved.");
  console.log("   Run 'burnwatch init' to set up again.\n");
}

function cmdHelp(): void {
  console.log(`
burnwatch — Passive cost memory for AI-assisted development

Usage:
  burnwatch init                              Interactive setup — pick plans per service
  burnwatch init --non-interactive            Auto-detect services, no prompts
  burnwatch setup                             Init + auto-configure all detected services
  burnwatch add <service> [options]           Register a service for tracking
  burnwatch status                            Show current spend brief
  burnwatch services                          List all services in registry
  burnwatch reconcile                         Scan for untracked services
  burnwatch interview --json                  Export state for agent-driven interview
  burnwatch configure --service <id> [opts]   Agent writes back interview answers
  burnwatch scan [--verbose]                  Scan project for utilization patterns
  burnwatch reset                             Remove all burnwatch config from this project

Options for 'configure':
  --service <ID>         Service to configure (required)
  --plan <NAME>          Plan name (fuzzy matches against registry)
  --budget <AMOUNT>      Monthly budget in USD
  --key <API_KEY>        API key for LIVE tracking
  --exclude              Exclude this service from tracking

Options for 'add':
  --key <API_KEY>        API key for LIVE tracking (saved to ~/.config/burnwatch/)
  --token <TOKEN>        Same as --key (alias)
  --budget <AMOUNT>      Monthly budget in USD
  --plan-cost <AMOUNT>   Monthly plan cost for CALC tracking

Examples:
  burnwatch init
  burnwatch interview --json
  burnwatch configure --service anthropic --plan "API Usage" --budget 100
  burnwatch configure --service supabase --plan pro --budget 25 --key sbp_xxx
  burnwatch configure --service posthog --plan free --budget 0
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

  // Step 1b: Copy skills to .claude/skills/ so the agent can discover them.
  const sourceSkillsDir = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../skills",
  );
  const skillNames = ["setup-burnwatch", "burnwatch-interview", "spend"];
  const claudeSkillsDir = path.join(projectRoot, ".claude", "skills");

  for (const skillName of skillNames) {
    const srcSkill = path.join(sourceSkillsDir, skillName, "SKILL.md");
    const destDir = path.join(claudeSkillsDir, skillName);
    const destSkill = path.join(destDir, "SKILL.md");
    try {
      if (fs.existsSync(srcSkill)) {
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(srcSkill, destSkill);
      }
    } catch (err) {
      console.error(`   Warning: Could not copy skill ${skillName}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`   Skills installed to ${claudeSkillsDir}`);

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
