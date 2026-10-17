import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const NAMES = ["costs.ts", "fees.ts", "info.ts", "queries.ts", "rateLimit.ts", "simulate.ts"];

test("sdk vendor matches the read and sim sources", () => {
  for (const name of NAMES) {
    const source = readFileSync(join(HERE, name));
    const vendor = readFileSync(join(HERE, "..", "..", "..", "sdk", "src", "vendor", name));
    assert.equal(source.equals(vendor), true, name);
  }
});
