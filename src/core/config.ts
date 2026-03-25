import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { TrackedService } from "./types.js";

/**
 * Paths for burnwatch configuration and data.
 *
 * Hybrid model:
 * - Global config (API keys, service credentials): ~/.config/burnwatch/
 * - Project config (budgets, tracked services): .burnwatch/
 * - Project data (ledger, events, cache): .burnwatch/data/
 */

/** Global config directory — stores API keys, never in project dirs. */
export function globalConfigDir(): string {
  const xdgConfig = process.env["XDG_CONFIG_HOME"];
  if (xdgConfig) return path.join(xdgConfig, "burnwatch");
  return path.join(os.homedir(), ".config", "burnwatch");
}

/** Project config directory — stores budgets, tracked services. */
export function projectConfigDir(projectRoot?: string): string {
  const root = projectRoot ?? process.cwd();
  return path.join(root, ".burnwatch");
}

/** Project data directory — stores ledger, events, cache. */
export function projectDataDir(projectRoot?: string): string {
  return path.join(projectConfigDir(projectRoot), "data");
}

// --- Global config (API keys) ---

export interface GlobalConfig {
  services: Record<
    string,
    {
      apiKey?: string;
      token?: string;
      orgId?: string;
    }
  >;
}

export function readGlobalConfig(): GlobalConfig {
  const configPath = path.join(globalConfigDir(), "config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as GlobalConfig;
  } catch {
    return { services: {} };
  }
}

export function writeGlobalConfig(config: GlobalConfig): void {
  const dir = globalConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  // Restrict permissions — this file contains API keys
  fs.chmodSync(configPath, 0o600);
}

// --- Project config (budgets, tracked services) ---

export interface ProjectConfig {
  projectName: string;
  services: Record<string, TrackedService>;
  createdAt: string;
  updatedAt: string;
}

export function readProjectConfig(projectRoot?: string): ProjectConfig | null {
  const configPath = path.join(projectConfigDir(projectRoot), "config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as ProjectConfig;
  } catch {
    return null;
  }
}

export function writeProjectConfig(
  config: ProjectConfig,
  projectRoot?: string,
): void {
  const dir = projectConfigDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  config.updatedAt = new Date().toISOString();
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/** Ensure all project directories exist. */
export function ensureProjectDirs(projectRoot?: string): void {
  const dirs = [
    projectConfigDir(projectRoot),
    projectDataDir(projectRoot),
    path.join(projectDataDir(projectRoot), "cache"),
    path.join(projectDataDir(projectRoot), "snapshots"),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Check if burnwatch is initialized in the given project. */
export function isInitialized(projectRoot?: string): boolean {
  return readProjectConfig(projectRoot) !== null;
}
