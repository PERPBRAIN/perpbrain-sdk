/**
 * Run the receipt checker over every fixture directory and confirm the expected outcome:
 * `good` must be VERIFIED, and every `tampered-*` directory must be MISMATCH.
 *
 *   node --experimental-strip-types examples/verify-all-fixtures.ts [fixtures/receipts]
 *
 * Prints one JSON line per directory. Exit code 1 if any outcome is unexpected.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { verifyReceipt } from "../sdk/src/receipt.ts";

const root = process.argv[2] ?? "fixtures/receipts";
let unexpected = 0;

for (const name of readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()) {
  const dir = join(root, name);
  const receipt: unknown = JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8"));
  const report = verifyReceipt(receipt, readFileSync(join(dir, "manifest.json")), readFileSync(join(dir, "inputs.json")));
  const expected = name.startsWith("tampered-") ? "MISMATCH" : "VERIFIED";
  const ok = report.status === expected;
  if (!ok) unexpected += 1;
  process.stdout.write(`${JSON.stringify({ dir, expected, status: report.status, ok })}\n`);
}

process.stdout.write(`${JSON.stringify({ unexpected })}\n`);
process.exit(unexpected === 0 ? 0 : 1);
