import { describe, it, expect, beforeEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { detectServices, detectMentions, detectInFileChange, parseEnvKeys, findEnvFiles } from "../detection/detector.js";
import { clearRegistryCache } from "../core/registry.js";

// Create a temp project dir for testing
function createTempProject(deps: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "burnwatch-test-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });

  // Write package.json
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "test-project",
      dependencies: deps,
    }),
  );

  return dir;
}

describe("detectServices", () => {
  beforeEach(() => {
    clearRegistryCache();
  });

  it("detects services from package.json dependencies", () => {
    const dir = createTempProject({
      "@anthropic-ai/sdk": "^0.78.0",
      "resend": "^6.0.0",
    });

    const results = detectServices(dir);

    const serviceIds = results.map((r) => r.service.id);
    expect(serviceIds).toContain("anthropic");
    expect(serviceIds).toContain("resend");
  });

  it("detects services from import statements in src/", () => {
    const dir = createTempProject({ "@supabase/supabase-js": "^2.0.0" });

    // Write a file with imports
    fs.writeFileSync(
      path.join(dir, "src", "db.ts"),
      `import { createClient } from "@supabase/supabase-js";\n`,
    );

    const results = detectServices(dir);
    const supabase = results.find((r) => r.service.id === "supabase");
    expect(supabase).toBeDefined();
    expect(supabase!.sources).toContain("package_json");
    expect(supabase!.sources).toContain("import_scan");
  });

  it("returns no package_json detections for project with no paid services", () => {
    const dir = createTempProject({ "lodash": "^4.0.0" });
    const results = detectServices(dir);
    // Only env_var detections should exist (from host env), not package_json
    const pkgDetections = results.filter((r) =>
      r.sources.includes("package_json"),
    );
    expect(pkgDetections).toHaveLength(0);
  });
});

describe("detectMentions", () => {
  beforeEach(() => {
    clearRegistryCache();
  });

  it("detects service mentions in prompt text", () => {
    const results = detectMentions(
      "Can you use Scrapfly to scrape this website?",
    );
    const serviceIds = results.map((r) => r.service.id);
    expect(serviceIds).toContain("scrapfly");
  });

  it("detects multiple services in one prompt", () => {
    const results = detectMentions(
      "Let's use Anthropic for the LLM and Supabase for the database",
    );
    const serviceIds = results.map((r) => r.service.id);
    expect(serviceIds).toContain("anthropic");
    expect(serviceIds).toContain("supabase");
  });

  it("is case-insensitive", () => {
    const results = detectMentions("use BROWSERBASE for scraping");
    const serviceIds = results.map((r) => r.service.id);
    expect(serviceIds).toContain("browserbase");
  });

  it("returns empty for prompts with no service mentions", () => {
    const results = detectMentions("Please fix the CSS on the homepage");
    expect(results).toHaveLength(0);
  });
});

describe("detectInFileChange", () => {
  beforeEach(() => {
    clearRegistryCache();
  });

  it("detects new dependencies in package.json changes", () => {
    const content = JSON.stringify({
      dependencies: {
        "posthog-js": "^1.0.0",
        "inngest": "^3.0.0",
      },
    });

    const results = detectInFileChange("/project/package.json", content);
    const serviceIds = results.map((r) => r.service.id);
    expect(serviceIds).toContain("posthog");
    expect(serviceIds).toContain("inngest");
  });

  it("detects new env vars in .env files", () => {
    const content = [
      "SCRAPFLY_KEY=scp-xxx",
      "BROWSERBASE_API_KEY=bb-xxx",
      "# Comment line",
      "NEXT_PUBLIC_APP_URL=https://example.com",
    ].join("\n");

    const results = detectInFileChange("/project/.env.local", content);
    const serviceIds = results.map((r) => r.service.id);
    expect(serviceIds).toContain("scrapfly");
    expect(serviceIds).toContain("browserbase");
  });

  it("detects new imports in source files", () => {
    const content = `
      import { Resend } from "resend";
      import { Inngest } from "inngest";
    `;

    const results = detectInFileChange("/project/src/api.ts", content);
    const serviceIds = results.map((r) => r.service.id);
    expect(serviceIds).toContain("resend");
    expect(serviceIds).toContain("inngest");
  });

  it("detects env vars with export prefix", () => {
    const content = [
      "export SCRAPFLY_KEY=scp-xxx",
      "export BROWSERBASE_API_KEY=bb-xxx",
    ].join("\n");

    const results = detectInFileChange("/project/.env", content);
    const serviceIds = results.map((r) => r.service.id);
    expect(serviceIds).toContain("scrapfly");
    expect(serviceIds).toContain("browserbase");
  });
});

describe("parseEnvKeys", () => {
  it("parses standard KEY=value format", () => {
    const keys = parseEnvKeys("ANTHROPIC_API_KEY=sk-ant-123\nOPENAI_API_KEY=sk-456");
    expect(keys.has("ANTHROPIC_API_KEY")).toBe(true);
    expect(keys.has("OPENAI_API_KEY")).toBe(true);
  });

  it("handles export prefix", () => {
    const keys = parseEnvKeys("export SCRAPFLY_KEY=scp-xxx\nexport BROWSERBASE_API_KEY=bb-xxx");
    expect(keys.has("SCRAPFLY_KEY")).toBe(true);
    expect(keys.has("BROWSERBASE_API_KEY")).toBe(true);
  });

  it("handles quoted values", () => {
    const keys = parseEnvKeys('SUPABASE_URL="https://xyz.supabase.co"\nSUPABASE_KEY=\'eyJabc\'');
    expect(keys.has("SUPABASE_URL")).toBe(true);
    expect(keys.has("SUPABASE_KEY")).toBe(true);
  });

  it("skips comments and empty lines", () => {
    const keys = parseEnvKeys("# This is a comment\n\nANTHROPIC_API_KEY=sk-123\n# Another comment");
    expect(keys.size).toBe(1);
    expect(keys.has("ANTHROPIC_API_KEY")).toBe(true);
  });

  it("handles spaces around equals sign", () => {
    const keys = parseEnvKeys("VERCEL_TOKEN = tok_xxx");
    expect(keys.has("VERCEL_TOKEN")).toBe(true);
  });

  it("handles Windows line endings (\\r\\n)", () => {
    const keys = parseEnvKeys("ANTHROPIC_API_KEY=sk-123\r\nOPENAI_API_KEY=sk-456\r\n");
    expect(keys.has("ANTHROPIC_API_KEY")).toBe(true);
    expect(keys.has("OPENAI_API_KEY")).toBe(true);
  });

  it("handles mixed export and non-export lines", () => {
    const keys = parseEnvKeys("CLERK_SECRET_KEY=sk_test_xxx\nexport NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_xxx");
    expect(keys.has("CLERK_SECRET_KEY")).toBe(true);
    expect(keys.has("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")).toBe(true);
  });
});

describe("findEnvFiles", () => {
  it("finds .env files in project root", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "burnwatch-env-test-"));
    fs.writeFileSync(path.join(dir, ".env"), "KEY=value");
    fs.writeFileSync(path.join(dir, ".env.local"), "KEY2=value2");
    fs.writeFileSync(path.join(dir, ".env.development"), "KEY3=value3");
    fs.writeFileSync(path.join(dir, "not-env.txt"), "ignored");

    const files = findEnvFiles(dir, 3);
    const names = files.map((f) => path.basename(f));
    expect(names).toContain(".env");
    expect(names).toContain(".env.local");
    expect(names).toContain(".env.development");
    expect(names).not.toContain("not-env.txt");
  });

  it("skips node_modules and .git", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "burnwatch-env-test-"));
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", ".env"), "SECRET=bad");
    fs.writeFileSync(path.join(dir, ".env"), "KEY=good");

    const files = findEnvFiles(dir, 3);
    expect(files).toHaveLength(1);
    expect(path.basename(files[0]!)).toBe(".env");
  });
});
