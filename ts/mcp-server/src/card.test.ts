import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { renderReceiptCard } from "../../../sdk/src/card.ts";

const root = new URL("../../../fixtures/receipts/", import.meta.url);

function load(name: string): { receipt: unknown; manifest: Uint8Array; inputs: Uint8Array } {
  const dir = new URL(`${name}/`, root);
  return {
    receipt: JSON.parse(readFileSync(new URL("receipt.json", dir), "utf8")) as unknown,
    manifest: readFileSync(new URL("manifest.json", dir)),
    inputs: readFileSync(new URL("inputs.json", dir)),
  };
}

test("verified receipt renders a simulated card", () => {
  const files = load("good");
  const svg = renderReceiptCard(files.receipt, files.manifest, files.inputs);
  assert.match(svg, /SIMULATED/);
  assert.match(svg, /Simulated\. Limits you set; losses are still possible\./);
  assert.match(svg, /standard · not loosened/);
  assert.match(svg, /queue_position, liquidation/);
  assert.doesNotMatch(svg, /\b(profit|return|pnl|roi)\b/i);
  assert.match(svg, /fees 0\.00045 · vs mid 0 · paid 0 · received 0/);
  assert.match(svg, /queue_position/);
  assert.match(svg, /liquidation/);
});

test("a mismatch does not render a card", () => {
  const files = load("tampered-result");
  assert.throws(
    () => renderReceiptCard(files.receipt, files.manifest, files.inputs),
    /result_sha256 mismatch/,
  );
});

test("optional receipt fields are drawn when the receipt still verifies", () => {
  const files = load("good");
  const receipt = files.receipt as Record<string, unknown>;
  receipt.strategy = "funding & watcher";
  receipt.tape_verification = "VERIFIED";
  receipt.overfit = {
    in_sample_ratio: "0.7",
    in_sample: { count: 7 },
    out_of_sample: { count: 3 },
    warnings: [{ code: "too_good_to_be_true", reason: "in_sample_exceeds_out_of_sample" }],
  };
  const svg = renderReceiptCard(receipt, files.manifest, files.inputs);
  assert.match(svg, /FUNDING &amp; WATCHER/);
  assert.match(svg, />VERIFIED</);
  assert.match(svg, /0\.7 · 7 in-sample · 3 out-of-sample/);
  assert.match(svg, /too_good_to_be_true · in_sample_exceeds_out_of_sample/);
});
