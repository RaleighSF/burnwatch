import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    "hooks/on-session-start": "src/hooks/on-session-start.ts",
    "hooks/on-prompt": "src/hooks/on-prompt.ts",
    "hooks/on-file-change": "src/hooks/on-file-change.ts",
    "hooks/on-stop": "src/hooks/on-stop.ts",
  },
  format: ["esm"],
  target: "node18",
  platform: "node",
  dts: { only: false },
  clean: true,
  sourcemap: true,
  splitting: false,
});
