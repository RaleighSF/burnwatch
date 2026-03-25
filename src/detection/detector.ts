import * as fs from "node:fs";
import * as path from "node:path";
import { loadRegistry } from "../core/registry.js";
import type { ServiceDefinition, DetectionSource } from "../core/types.js";

export interface DetectionResult {
  service: ServiceDefinition;
  sources: DetectionSource[];
  details: string[];
}

/**
 * Run all detection surfaces against the current project.
 * Returns services detected via any combination of:
 * - package.json dependencies
 * - environment variable patterns
 * - import statement scanning
 * - (prompt mention scanning is handled separately in hooks)
 */
export function detectServices(projectRoot: string): DetectionResult[] {
  const registry = loadRegistry(projectRoot);
  const results = new Map<string, DetectionResult>();

  // Surface 1: Package manifest scanning
  const pkgDeps = scanPackageJson(projectRoot);
  for (const [serviceId, service] of registry) {
    const matchedPkgs = service.packageNames.filter((pkg) =>
      pkgDeps.has(pkg),
    );
    if (matchedPkgs.length > 0) {
      getOrCreate(results, serviceId, service).sources.push("package_json");
      getOrCreate(results, serviceId, service).details.push(
        `package.json: ${matchedPkgs.join(", ")}`,
      );
    }
  }

  // Surface 2: Environment variable pattern matching
  const envVars = new Set(Object.keys(process.env));
  for (const [serviceId, service] of registry) {
    const matchedEnvs = service.envPatterns.filter((pattern) =>
      envVars.has(pattern),
    );
    if (matchedEnvs.length > 0) {
      getOrCreate(results, serviceId, service).sources.push("env_var");
      getOrCreate(results, serviceId, service).details.push(
        `env vars: ${matchedEnvs.join(", ")}`,
      );
    }
  }

  // Surface 3: Import statement analysis (lightweight — scan key files only)
  const importHits = scanImports(projectRoot);
  for (const [serviceId, service] of registry) {
    const matchedImports = service.importPatterns.filter((pattern) =>
      importHits.has(pattern),
    );
    if (matchedImports.length > 0) {
      if (
        !getOrCreate(results, serviceId, service).sources.includes(
          "import_scan",
        )
      ) {
        getOrCreate(results, serviceId, service).sources.push("import_scan");
        getOrCreate(results, serviceId, service).details.push(
          `imports: ${matchedImports.join(", ")}`,
        );
      }
    }
  }

  return Array.from(results.values());
}

/**
 * Detect services mentioned in a prompt string.
 * Used by the UserPromptSubmit hook.
 */
export function detectMentions(
  prompt: string,
  projectRoot?: string,
): DetectionResult[] {
  const registry = loadRegistry(projectRoot);
  const results: DetectionResult[] = [];
  const promptLower = prompt.toLowerCase();

  for (const [, service] of registry) {
    const matched = service.mentionKeywords.some((keyword) =>
      promptLower.includes(keyword.toLowerCase()),
    );
    if (matched) {
      results.push({
        service,
        sources: ["prompt_mention"],
        details: [`mentioned in prompt`],
      });
    }
  }

  return results;
}

/**
 * Detect new services introduced in a file change.
 * Used by the PostToolUse hook for Write/Edit events.
 */
export function detectInFileChange(
  filePath: string,
  content: string,
  projectRoot?: string,
): DetectionResult[] {
  const registry = loadRegistry(projectRoot);
  const results: DetectionResult[] = [];
  const fileName = path.basename(filePath);

  // Check if it's a package.json change
  if (fileName === "package.json") {
    try {
      const pkg = JSON.parse(content) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const allDeps = new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ]);

      for (const [, service] of registry) {
        const matched = service.packageNames.filter((p) => allDeps.has(p));
        if (matched.length > 0) {
          results.push({
            service,
            sources: ["package_json"],
            details: [`new dependency: ${matched.join(", ")}`],
          });
        }
      }
    } catch {
      // Not valid JSON, skip
    }
    return results;
  }

  // Check if it's an env file change
  if (fileName.startsWith(".env")) {
    const envKeys = content
      .split("\n")
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => line.split("=")[0]!.trim());

    for (const [, service] of registry) {
      const matched = service.envPatterns.filter((p) => envKeys.includes(p));
      if (matched.length > 0) {
        results.push({
          service,
          sources: ["env_var"],
          details: [`new env var: ${matched.join(", ")}`],
        });
      }
    }
    return results;
  }

  // Check for import statements in source files
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) {
    for (const [, service] of registry) {
      const matched = service.importPatterns.filter(
        (pattern) =>
          content.includes(`from "${pattern}`) ||
          content.includes(`from '${pattern}`) ||
          content.includes(`require("${pattern}`) ||
          content.includes(`require('${pattern}`),
      );
      if (matched.length > 0) {
        results.push({
          service,
          sources: ["import_scan"],
          details: [`import added: ${matched.join(", ")}`],
        });
      }
    }
  }

  return results;
}

// --- Helpers ---

function getOrCreate(
  map: Map<string, DetectionResult>,
  serviceId: string,
  service: ServiceDefinition,
): DetectionResult {
  let result = map.get(serviceId);
  if (!result) {
    result = { service, sources: [], details: [] };
    map.set(serviceId, result);
  }
  return result;
}

/** Scan package.json for all dependencies. */
function scanPackageJson(projectRoot: string): Set<string> {
  const deps = new Set<string>();
  const pkgPath = path.join(projectRoot, "package.json");

  try {
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const name of Object.keys(pkg.dependencies ?? {})) deps.add(name);
    for (const name of Object.keys(pkg.devDependencies ?? {})) deps.add(name);
  } catch {
    // No package.json or not valid JSON
  }

  return deps;
}

/**
 * Lightweight import scanning.
 * Scans src/ directory for import/require statements.
 * Does NOT do a full AST parse — just string matching.
 */
function scanImports(projectRoot: string): Set<string> {
  const imports = new Set<string>();
  const srcDir = path.join(projectRoot, "src");

  if (!fs.existsSync(srcDir)) return imports;

  const files = walkDir(srcDir, /\.(ts|tsx|js|jsx|mjs|cjs)$/);
  for (const file of files) {
    try {
      const content = fs.readFileSync(file, "utf-8");
      // Match: import ... from "package" or require("package")
      const importRegex =
        /(?:from\s+["']|require\s*\(\s*["'])([^./][^"']*?)(?:["'])/g;
      let match: RegExpExecArray | null;
      while ((match = importRegex.exec(content)) !== null) {
        const pkg = match[1];
        if (pkg) {
          // Normalize scoped packages: @scope/pkg/subpath -> @scope/pkg
          const parts = pkg.split("/");
          if (parts[0]?.startsWith("@") && parts.length >= 2) {
            imports.add(`${parts[0]}/${parts[1]}`);
          } else if (parts[0]) {
            imports.add(parts[0]);
          }
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return imports;
}

/** Recursively walk a directory, returning files matching the pattern. */
function walkDir(dir: string, pattern: RegExp, maxDepth = 5): string[] {
  const results: string[] = [];
  if (maxDepth <= 0) return results;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkDir(fullPath, pattern, maxDepth - 1));
      } else if (pattern.test(entry.name)) {
        results.push(fullPath);
      }
    }
  } catch {
    // Skip unreadable directories
  }

  return results;
}
