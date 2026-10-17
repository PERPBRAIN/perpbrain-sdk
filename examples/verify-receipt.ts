/**
 * Check a simulation receipt directory (receipt.json, manifest.json, inputs.json).
 *
 *   node --experimental-strip-types examples/verify-receipt.ts fixtures/receipts/good
 *
 * Prints VERIFIED, or MISMATCH with the fields that do not match. Exit code 1 on MISMATCH.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { verifyReceipt } from "../sdk/src/receipt.ts";

const dir = process.argv[2] ?? "fixtures/receipts/good";
const receipt: unknown = JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8"));
const report = verifyReceipt(receipt, readFileSync(join(dir, "manifest.json")), readFileSync(join(dir, "inputs.json")));
process.stdout.write(`${JSON.stringify({ dir, ...report })}\n`);
process.exit(report.status === "VERIFIED" ? 0 : 1);
