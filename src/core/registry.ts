import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import type { ServiceDefinition } from "./types.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

interface RegistryFile {
  version: string;
  lastUpdated: string;
  services: Record<string, ServiceDefinition>;
}

let cachedRegistry: Map<string, ServiceDefinition> | null = null;

/**
 * Load the service registry.
 * Checks project-local override first, then falls back to bundled registry.
 */
export function loadRegistry(projectRoot?: string): Map<string, ServiceDefinition> {
  if (cachedRegistry) return cachedRegistry;

  const registry = new Map<string, ServiceDefinition>();

  // Load bundled registry (shipped with package)
  // Try multiple possible locations — depends on whether running from src/ or dist/
  const candidates = [
    path.resolve(__dirname, "../../registry.json"),  // from src/core/
    path.resolve(__dirname, "../registry.json"),      // from dist/
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      loadRegistryFile(candidate, registry);
      break;
    }
  }

  // Load project-local override (if exists)
  if (projectRoot) {
    const localPath = path.join(projectRoot, ".burnwatch", "registry.json");
    if (fs.existsSync(localPath)) {
      loadRegistryFile(localPath, registry);
    }
  }

  cachedRegistry = registry;
  return registry;
}

function loadRegistryFile(
  filePath: string,
  registry: Map<string, ServiceDefinition>,
): void {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as RegistryFile;
    for (const [id, service] of Object.entries(data.services)) {
      registry.set(id, { ...service, id });
    }
  } catch {
    // Silently skip missing or malformed registry files
  }
}

/** Clear the cached registry (for testing). */
export function clearRegistryCache(): void {
  cachedRegistry = null;
}

/** Get a single service definition by ID. */
export function getService(
  id: string,
  projectRoot?: string,
): ServiceDefinition | undefined {
  return loadRegistry(projectRoot).get(id);
}

/** Get all service definitions. */
export function getAllServices(
  projectRoot?: string,
): ServiceDefinition[] {
  return Array.from(loadRegistry(projectRoot).values());
}
