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

const server = new McpServer({
  name: "burnwatch",
  version: "0.1.2",
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
