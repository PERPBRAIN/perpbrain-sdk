#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args[0] !== "mcp") {
  process.stderr.write("usage: perpbrain-sdk mcp\n");
  process.exit(args.length === 0 ? 0 : 1);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const launcher = join(root, "bin", "perpbrain-mcp.mjs");
const result = spawnSync(process.execPath, [launcher], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
