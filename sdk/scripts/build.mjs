import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

function run(project) {
  const result = spawnSync(process.execPath, [tsc, "-p", project], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("tsconfig.esm.json");
run("tsconfig.cjs.json");
writeFileSync(join(root, "dist", "cjs", "package.json"), "{\"type\":\"commonjs\"}\n");
