/**
 * Simulate one closed-bar decision under the Standard preset, then the same decision at 9x leverage.
 *
 *   node --experimental-strip-types examples/guarded-simulate.ts
 *
 * Output is labelled SIMULATED. Standard allows 5x, so the second run is blocked before a fill is recorded.
 * These are limits you set; losses are still possible.
 */

import { GuardBlocked, GuardSession } from "../sdk/src/guards.ts";
import { guardedSimulate } from "../sdk/src/guarded.ts";
import type { Bar, Book, Decision } from "../sdk/src/vendor/simulate.ts";

const bars = [
  { open: "1", high: "1", low: "1", close: "1" },
  { open: "10", high: "11", low: "9", close: "10" },
] as unknown as Bar[];
const book = { bids: [], asks: [{ px: "10", sz: "100" }] } as unknown as Book;
const decision = { barIndex: 0, side: "long", size: "1", stop: null, target: null } as unknown as Decision;

const session = GuardSession.fromConfig("standard");
const accepted = guardedSimulate("BTC", decision, bars, book, null, null, "standard", session);
process.stdout.write(`${JSON.stringify({ case: "standard 1x", label: accepted.label, violations: accepted.guardViolations })}\n`);

try {
  guardedSimulate("BTC", decision, bars, book, null, { leverage: "9" }, "standard", session);
  process.stdout.write("unexpected: 9x was accepted\n");
  process.exit(1);
} catch (caught) {
  if (!(caught instanceof GuardBlocked)) {
    throw caught;
  }
  process.stdout.write(`${JSON.stringify({ case: "standard 9x", blocked: caught.message })}\n`);
}
