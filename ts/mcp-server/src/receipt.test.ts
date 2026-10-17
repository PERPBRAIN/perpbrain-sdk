import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { verifyReceipt } from "../../../sdk/src/receipt.ts";

const root = new URL("../../../fixtures/receipts/", import.meta.url);

function load(name: string): { receipt: unknown; manifest: Uint8Array; inputs: Uint8Array } {
  const dir = new URL(`${name}/`, root);
  return {
    receipt: JSON.parse(readFileSync(new URL("receipt.json", dir), "utf8")) as unknown,
    manifest: readFileSync(new URL("manifest.json", dir)),
    inputs: readFileSync(new URL("inputs.json", dir)),
  };
}

test("good fixture receipt is verified", () => {
  const files = load("good");
  const report = verifyReceipt(files.receipt, files.manifest, files.inputs);
  assert.deepEqual(report, { status: "VERIFIED", mismatches: [] });
});

test("tampered receipts name the mismatch", () => {
  const cases: [string, string][] = [
    ["tampered-limits-hash", "limits_hash mismatch"],
    ["tampered-snapshot-id", "market_snapshot_id mismatch"],
    ["tampered-result", "result_sha256 mismatch"],
    ["tampered-data", "data_snapshot_id mismatch"],
    ["tampered-manifest", "manifest_sha256 mismatch"],
  ];
  for (const [name, needle] of cases) {
    const files = load(name);
    const report = verifyReceipt(files.receipt, files.manifest, files.inputs);
    assert.equal(report.status, "MISMATCH");
    assert.ok(report.mismatches.includes(needle), report.mismatches.join("\n"));
  }
});
