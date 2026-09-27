import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node22",
    platform: "node",
    clean: true,
    sourcemap: false,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    target: "node22",
    platform: "node",
    dts: true,
    sourcemap: false,
  },
]);
