import { defineConfig } from "tsdown";

// The build for npm: ES modules in build/, with their declarations. cli/job-started.js is the check program of a
// machine, with the shebang of the source. The workspace runs the source (main is src/index.ts).
export default defineConfig({
  entry: ["src/index.ts", "src/github.ts", "src/proxmox.ts", "src/proxmox-client.ts", "src/testing.ts", "src/cli/job-started.ts"],
  outDir: "build",
  format: "esm",
  platform: "node",
  fixedExtension: false,
  sourcemap: true,
  dts: true,
  publint: true,
});
