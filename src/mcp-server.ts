#!/usr/bin/env node

/**
 * burnwatch MCP Server
 *
 * Exposes burnwatch spend data as MCP tools so any MCP-enabled
 * LLM can query project spend, service status, and budget alerts.
 *
 * Usage:
 *   node dist/mcp-server.js
 *
 * Claude Code config:
 *   claude mcp add burnwatch -- node /path/to/burnwatch/dist/mcp-server.js
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  readProjectConfig,
  isInitialized,
} from "./core/config.js";
import { readLatestSnapshot } from "./core/ledger.js";
import { pollAllServices } from "./services/index.js";
import {
  buildBrief,
  buildSnapshot,
  formatBrief,
  formatSpendCard,
} from "./core/brief.js";
import { getService, getAllServices } from "./core/registry.js";
import { detectServices } from "./detection/detector.js";
import { analyzeCostImpact, formatCostImpactCard } from "./cost-impact.js";
import {
  readUtilizationModel,
  formatUtilizationSummary,
} from "./utilization.js";
import * as fs from "node:fs";
import * as path from "node:path";

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const server = new McpServer({
  name: "burnwatch",
  version: pkg.version,
});

// --- Tool: get_spend_brief ---

server.tool(
  "get_spend_brief",
  "Get the current spend brief for this project. Shows all tracked services, their spend, confidence tier, budget status, and alerts. Use this when a developer asks about costs, spending, budget, or wants an overview of their SaaS expenses.",
  {
    project_path: z
      .string()
      .optional()
      .describe(
        "Path to the project root. Defaults to current working directory.",
      ),
  },
  async ({ project_path }) => {
    const projectRoot = project_path ?? process.cwd();

    if (!isInitialized(projectRoot)) {
      return {
        content: [
          {
            type: "text" as const,
            text: "burnwatch is not initialized in this project. Run `npx burnwatch init` to set up spend tracking.",
          },
        ],
      };
    }

    const config = readProjectConfig(projectRoot)!;
    const trackedServices = Object.values(config.services);

    if (trackedServices.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No services are being tracked yet. Run `burnwatch add <service>` to start tracking.",
          },
        ],
      };
    }

    // Try cache first, fall back to live poll
    const cached = readLatestSnapshot(projectRoot);
    if (cached) {
      return {
        content: [
          { type: "text" as const, text: formatBrief(cached) },
        ],
      };
    }

    const results = await pollAllServices(trackedServices);
    const snapshots = results.map((r) =>
      buildSnapshot(
        r.serviceId,
        r.tier,
        r.spend,
        config.services[r.serviceId]?.budget,
        undefined,
        r.isEstimate,
        r.isFlatPlan,
      ),
    );
    const blindCount = snapshots.filter((s) => s.tier === "blind").length;
    const brief = buildBrief(config.projectName, snapshots, blindCount);

    return {
      content: [{ type: "text" as const, text: formatBrief(brief) }],
    };
  },
);

// --- Tool: get_service_spend ---

server.tool(
  "get_service_spend",
  "Get detailed spend information for a specific service. Includes current spend, budget status, confidence tier, pricing model, gotchas, and cheaper alternatives. Use this when a developer mentions a specific paid service or asks about its cost.",
  {
    service_id: z
      .string()
      .describe(
        "The service identifier (e.g., 'anthropic', 'scrapfly', 'vercel', 'supabase')",
      ),
    project_path: z
      .string()
      .optional()
      .describe("Path to the project root. Defaults to cwd."),
  },
  async ({ service_id, project_path }) => {
    const projectRoot = project_path ?? process.cwd();
    const definition = getService(service_id, projectRoot);

    if (!definition) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Service "${service_id}" not found in the burnwatch registry. Run \`burnwatch services\` to see available services.`,
          },
        ],
      };
    }

    const lines: string[] = [];
    lines.push(`## ${definition.name}`);
    lines.push("");

    // Spend data if available
    if (isInitialized(projectRoot)) {
      const snapshot = readLatestSnapshot(projectRoot);
      const serviceSnap = snapshot?.services.find(
        (s) => s.serviceId === service_id,
      );
      if (serviceSnap) {
        lines.push(formatSpendCard(serviceSnap));
        lines.push("");
      }
    }

    // Registry info
    lines.push(`**Billing model:** ${definition.billingModel}`);
    lines.push(`**Scaling:** ${definition.scalingShape}`);
    lines.push(
      `**Tracking tier:** ${definition.apiTier.toUpperCase()}`,
    );

    if (definition.pricing?.formula) {
      lines.push(`**Pricing formula:** ${definition.pricing.formula}`);
    }

    if (definition.gotchas && definition.gotchas.length > 0) {
      lines.push("");
      lines.push("**Cost gotchas:**");
      for (const g of definition.gotchas) {
        lines.push(`- ${g}`);
      }
    }

    if (definition.alternatives && definition.alternatives.length > 0) {
      lines.push("");
      lines.push(
        `**Cheaper alternatives:** ${definition.alternatives.join(", ")}`,
      );
    }

    if (definition.docsUrl) {
      lines.push("");
      lines.push(`**Pricing docs:** ${definition.docsUrl}`);
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  },
);

// --- Tool: detect_paid_services ---

server.tool(
  "detect_paid_services",
  "Scan a project for paid services. Detects services via package.json dependencies, environment variables, and import statements. Use this when a developer wants to know what paid services are in their project, or before recommending a new paid tool.",
  {
    project_path: z
      .string()
      .optional()
      .describe("Path to the project root. Defaults to cwd."),
  },
  async ({ project_path }) => {
    const projectRoot = project_path ?? process.cwd();
    const detected = detectServices(projectRoot);

    if (detected.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No paid services detected in this project.",
          },
        ],
      };
    }

    const lines: string[] = [];
    lines.push(
      `Found ${detected.length} paid service${detected.length > 1 ? "s" : ""}:`,
    );
    lines.push("");

    for (const det of detected) {
      const tierLabel =
        det.service.apiTier === "live"
          ? "✅ LIVE"
          : det.service.apiTier === "calc"
            ? "🟡 CALC"
            : det.service.apiTier === "est"
              ? "🟠 EST"
              : "🔴 BLIND";

      lines.push(
        `- **${det.service.name}** (${tierLabel}) — ${det.details.join(", ")}`,
      );

      if (det.service.gotchas && det.service.gotchas.length > 0) {
        lines.push(`  ⚠️ ${det.service.gotchas[0]}`);
      }
    }

    lines.push("");
    lines.push(
      "Run `npx burnwatch init` to start tracking spend for all detected services.",
    );

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  },
);

// --- Tool: list_services ---

server.tool(
  "list_registry_services",
  "List all services in the burnwatch registry with their tracking tier and billing model. Use this to see what services burnwatch can track.",
  {},
  async () => {
    const services = getAllServices();
    const lines: string[] = [];
    lines.push(`burnwatch registry: ${services.length} services`);
    lines.push("");
    lines.push("| Service | Tier | Billing Model |");
    lines.push("|---------|------|--------------|");

    for (const svc of services) {
      const tier =
        svc.apiTier === "live"
          ? "✅ LIVE"
          : svc.apiTier === "calc"
            ? "🟡 CALC"
            : svc.apiTier === "est"
              ? "🟠 EST"
              : "🔴 BLIND";
      lines.push(`| ${svc.name} | ${tier} | ${svc.billingModel} |`);
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  },
);

// --- Tool: analyze_cost_impact ---

server.tool(
  "analyze_cost_impact",
  "Analyze a source file for cost-impacting SDK calls. Detects service call sites, loop/cron multipliers, and projects monthly cost using billing manifests with per-model variant detection. Use this before writing code that introduces new API calls, or to evaluate the cost of existing code.",
  {
    file_path: z
      .string()
      .describe("Absolute path to the source file to analyze."),
    file_content: z
      .string()
      .optional()
      .describe(
        "File content to analyze. If omitted, reads from file_path.",
      ),
    project_path: z
      .string()
      .optional()
      .describe("Path to the project root. Defaults to cwd."),
  },
  async ({ file_path, file_content, project_path }) => {
    const projectRoot = project_path ?? process.cwd();

    let content: string;
    if (file_content) {
      content = file_content;
    } else {
      try {
        content = fs.readFileSync(file_path, "utf-8");
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not read file: ${file_path}`,
            },
          ],
        };
      }
    }

    const impacts = analyzeCostImpact(file_path, content, projectRoot);

    if (impacts.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No cost-impacting SDK calls detected in ${file_path.split("/").pop()}.`,
          },
        ],
      };
    }

    // Build current budget context
    const snapshot = readLatestSnapshot(projectRoot);
    const currentBudgets: Record<string, { spend: number; budget?: number }> =
      {};
    if (snapshot) {
      for (const svc of snapshot.services) {
        currentBudgets[svc.serviceId] = {
          spend: svc.spend,
          budget: svc.budget,
        };
      }
    }

    const card = formatCostImpactCard(impacts, currentBudgets);

    return {
      content: [{ type: "text" as const, text: card }],
    };
  },
);

// --- Tool: get_utilization ---

server.tool(
  "get_utilization",
  "Get the project-wide utilization model showing all SDK call sites, projected monthly usage, plan inclusions, and overage costs. Use this to understand the project's total cost footprint across all services.",
  {
    project_path: z
      .string()
      .optional()
      .describe("Path to the project root. Defaults to cwd."),
  },
  async ({ project_path }) => {
    const projectRoot = project_path ?? process.cwd();
    const model = readUtilizationModel(projectRoot);

    if (Object.keys(model.services).length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No utilization data available. Run `burnwatch scan` or edit some source files to build the utilization model.",
          },
        ],
      };
    }

    return {
      content: [
        { type: "text" as const, text: formatUtilizationSummary(model) },
      ],
    };
  },
);

// --- Tool: get_billing_manifest ---

server.tool(
  "get_billing_manifest",
  "Get the detailed billing manifest for a service — shows every billing dimension, per-model/variant rates, plan inclusions, overage rates, and cost multipliers. Use this to understand exactly how a service charges before recommending it or estimating costs.",
  {
    service_id: z
      .string()
      .describe(
        "The service identifier (e.g., 'anthropic', 'browserbase', 'scrapfly')",
      ),
  },
  async ({ service_id }) => {
    // Find the manifest file
    const candidates = [
      path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        "../billing",
        `${service_id}.json`,
      ),
      path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        "../../billing",
        `${service_id}.json`,
      ),
    ];

    for (const candidate of candidates) {
      try {
        const raw = fs.readFileSync(candidate, "utf-8");
        const manifest = JSON.parse(raw) as Record<string, unknown>;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(manifest, null, 2),
            },
          ],
        };
      } catch {
        continue;
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `No billing manifest found for "${service_id}". Available manifests: anthropic, openai, google-gemini, voyage-ai, browserbase, scrapfly, vercel, supabase, upstash, resend, inngest, posthog.`,
        },
      ],
    };
  },
);

// --- Start server ---

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("burnwatch MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
