import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DOCS_URL, DEFAULT_FEE_VERSION, feeSchedule } from "./fees.ts";
import {
  simulate,
  type Bar,
  type Book,
  type Decision,
  type FillGuardIntent,
  type FillGuardVerdict,
  type PositionSide,
} from "./simulate.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "info");

function book(bids: Array<[string, string]>, asks: Array<[string, string]>): Book {
  return {
    bids: bids.map(([px, sz]) => ({ px, sz })),
    asks: asks.map(([px, sz]) => ({ px, sz })),
  };
}

function bar(open: string, high: string, low: string, close = "0"): Bar {
  return { open, high, low, close };
}

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    barIndex: 0,
    side: "long",
    size: "1",
    stop: "90",
    target: "120",
    ...overrides,
  };
}

const deep = book(
  [
    ["100", "10"],
    ["99", "10"],
  ],
  [
    ["10", "2"],
    ["11", "5"],
  ],
);

test("tier 0 base fees match the docs", () => {
  const schedule = feeSchedule();
  assert.equal(schedule.version, "hl-perp-tier0-base-2026-10-16");
  assert.equal(schedule.version, DEFAULT_FEE_VERSION);
  assert.equal(schedule.takerBps, "4.5");
  assert.equal(schedule.makerBps, "1.5");
  assert.equal(schedule.docsUrl, DOCS_URL);
  assert.equal(feeSchedule(DEFAULT_FEE_VERSION).version, schedule.version);
  assert.throws(() => feeSchedule("not-a-schedule"), /unknown fee schedule/);
});

test("entry is the next bar and walks the book", () => {
  const result = simulate(
    "BTC",
    decision({ stop: null, target: null, size: "3" }),
    [bar("1", "1", "1"), bar("10", "11", "9")],
    deep,
  );
  assert.equal(result.label, "SIMULATED");
  assert.equal(result.fillSource, "exchange");
  assert.equal(result.takerBps, "4.5");
  assert.equal(result.makerBps, "1.5");
  assert.equal("pnl" in result, false);
  assert.equal("returnPct" in result, false);
  const entry = result.fills[0];
  assert.ok(entry);
  assert.equal(entry.reason, "next_bar");
  assert.deepEqual(entry.legs, [
    { size: "2", price: "10" },
    { size: "1", price: "11" },
  ]);
  assert.equal(entry.slippage, "1");
  assert.equal(entry.fee, "0.01395");
  assert.equal(result.fills.length, 1);
  assert.equal(result.openSize, "3");
  assert.equal(result.queue_position, "NOT_MODELLED");
  assert.equal(result.liquidation, "NOT_MODELLED");
  assert.equal(result.receipt.queue_position, "NOT_MODELLED");
  assert.equal(result.receipt.liquidation, "NOT_MODELLED");
  assert.equal(result.fills[0]?.queue_position, "NOT_MODELLED");
});

test("same-bar stop wins and gaps fill at the open", () => {
  const liquid = book([["100", "5"]], [["100", "5"]]);
  const stopped = simulate("ETH", decision(), [bar("1", "1", "1"), bar("100", "130", "80")], liquid);
  assert.deepEqual(
    stopped.fills.map((fill) => fill.reason),
    ["next_bar", "stopped"],
  );
  assert.equal(stopped.fills[1]?.price, "90");
  assert.equal(stopped.fills[1]?.side, "sell");
  const gapped = simulate("ETH", decision(), [bar("1", "1", "1"), bar("80", "130", "70")], deep);
  assert.equal(gapped.fills[1]?.price, "80");
  const targeted = simulate(
    "ETH",
    decision(),
    [bar("1", "1", "1"), bar("100", "130", "95")],
    book([["130", "5"]], [["100", "5"]]),
  );
  assert.equal(targeted.fills[1]?.reason, "target");
  assert.equal(targeted.fills[1]?.price, "120");
  const gapTarget = simulate(
    "ETH",
    decision(),
    [bar("1", "1", "1"), bar("130", "140", "120")],
    book([["140", "5"]], [["140", "5"]]),
  );
  assert.equal(gapTarget.fills[1]?.price, "130");
});

test("shorts, later bars, partial depth, and the recorded book", () => {
  const shortBook = book([["100", "4"]], [["105", "4"]]);
  const stopped = simulate(
    "BTC",
    decision({ side: "short", stop: "110", target: "90" }),
    [bar("50", "50", "50"), bar("100", "111", "99")],
    shortBook,
  );
  assert.equal(stopped.fills[0]?.side, "sell");
  assert.equal(stopped.fills[1]?.price, "110");
  const gapped = simulate(
    "BTC",
    decision({ side: "short", stop: "110", target: "90" }),
    [bar("50", "50", "50"), bar("115", "116", "114")],
    shortBook,
  );
  assert.equal(gapped.fills[1]?.price, "115");
  const partial = simulate(
    "BTC",
    decision({ stop: null, target: null, size: "10" }),
    [bar("1", "1", "1"), bar("10", "11", "9")],
    deep,
  );
  assert.equal(partial.unfilledEntry, "3");
  assert.equal(partial.fills[0]?.size, "7");
  const raw: unknown = JSON.parse(readFileSync(join(FIXTURES, "l2_book_btc.json"), "utf8"));
  const payload = raw as { levels: Array<Array<{ px: string; sz: string }>> };
  const recorded = book(
    payload.levels[0]?.map((level) => [level.px, level.sz] as [string, string]) ?? [],
    payload.levels[1]?.map((level) => [level.px, level.sz] as [string, string]) ?? [],
  );
  const bought = simulate(
    "BTC",
    decision({ size: "1", stop: null, target: null }),
    [bar("1", "1", "1"), bar("81940", "81950", "81930")],
    recorded,
  );
  assert.equal(bought.fills[0]?.price, "81945");
  assert.equal(bought.fills[0]?.slippage, "5");
  assert.equal(bought.fills[0]?.fee, "36.87525");
});

test("missing bars and bad input do not invent fills", () => {
  const noneNext = simulate("BTC", decision(), [bar("1", "1", "1")], deep);
  assert.deepEqual(noneNext.fills, []);
  assert.equal(noneNext.label, "SIMULATED");
  const empty = simulate("BTC", decision(), [bar("1", "1", "1"), bar("100", "130", "80")], book([], []));
  assert.deepEqual(empty.fills, []);
  assert.throws(() => simulate("", decision(), [bar("1", "1", "1")], deep), /market/);
  assert.throws(() => simulate("BTC", decision({ size: "0" }), [bar("1", "1", "1")], deep), /size/);
  const flat = decision();
  flat.side = "flat" as PositionSide;
  assert.throws(() => simulate("BTC", flat, [bar("1", "1", "1"), bar("10", "11", "9")], deep), /side/);
  assert.throws(() => simulate("BTC", decision(), [bar("1", "1", "1")], deep, "nope"), /unknown fee schedule/);
  assert.equal("guardViolations" in noneNext, false);
});

test("a guard rejects a fill before it is recorded", () => {
  const seen: string[] = [];
  const reject = (intent: FillGuardIntent): FillGuardVerdict => {
    seen.push(intent.slippageBps);
    return { ok: false, violations: ["notional_exceeded"] };
  };
  const result = simulate(
    "BTC",
    decision({ stop: null, target: null, size: "1" }),
    [bar("1", "1", "1"), bar("10", "11", "9")],
    book([["10", "5"]], [["10", "5"]]),
    null,
    reject,
  );
  assert.deepEqual(result.fills, []);
  assert.equal(result.openSize, "0");
  assert.equal(result.unfilledEntry, "1");
  assert.deepEqual(result.guardViolations, ["notional_exceeded"]);
  assert.deepEqual(seen, ["0"]);
});

test("a guard can allow the entry and block the exit", () => {
  let calls = 0;
  const guard = (intent: FillGuardIntent): FillGuardVerdict => {
    calls += 1;
    assert.equal(intent.coin, "ETH");
    assert.equal(intent.leverage, "2");
    if (calls === 1) {
      assert.equal(intent.openPositions, 1);
      return { ok: true, violations: [] };
    }
    return { ok: false, violations: ["slippage_exceeded"] };
  };
  const result = simulate(
    "ETH",
    decision(),
    [bar("1", "1", "1"), bar("100", "130", "80")],
    book([["100", "5"]], [["100", "5"]]),
    null,
    guard,
    { leverage: "2", dailyLossUsd: "0", ageMs: 0 },
  );
  assert.deepEqual(
    result.fills.map((fill) => fill.kind),
    ["entry"],
  );
  assert.equal(result.openSize, "1");
  assert.deepEqual(result.guardViolations, ["slippage_exceeded"]);
});

test("a zero price book is checked and can be accepted", () => {
  const allow = (intent: FillGuardIntent): FillGuardVerdict => {
    assert.equal(intent.notionalUsd, "0");
    assert.equal(intent.slippageBps, "0");
    assert.equal(intent.openPositions, 4);
    return { ok: true, violations: [] };
  };
  const result = simulate(
    "BTC",
    decision({ stop: null, target: null, size: "1" }),
    [bar("0", "0", "0"), bar("0", "0", "0")],
    book([["0", "1"]], [["0", "1"]]),
    null,
    allow,
    { openPositions: 4 },
  );
  assert.deepEqual(result.guardViolations, []);
  assert.equal(result.fills[0]?.price, "0");
});

test("execution cost splits fees, slippage versus mid, and not modelled items", () => {
  const result = simulate(
    "BTC",
    decision({ stop: null, target: null, size: "3" }),
    [bar("1", "1", "1"), bar("10", "11", "9")],
    book(
      [
        ["100", "10"],
        ["99", "10"],
      ],
      [
        ["10", "2"],
        ["11", "5"],
      ],
    ),
  );
  assert.equal(result.cost_breakdown.schema_version, 1);
  assert.equal(result.cost_breakdown.label, "SIMULATED");
  assert.equal(result.cost_breakdown.fees_usd, "0.01395");
  assert.equal(result.cost_breakdown.slippage_vs_mid_usd, "-134");
  assert.equal(result.cost_breakdown.mid_usd, "55");
  assert.equal(result.cost_breakdown.funding_paid_usd, "0");
  assert.equal(result.cost_breakdown.funding_received_usd, "0");
  assert.deepEqual(result.cost_breakdown.not_modelled, [
    { item: "queue_position", status: "NOT_MODELLED" },
    { item: "liquidation", status: "NOT_MODELLED" },
  ]);
  assert.equal(result.receipt.cost_breakdown, result.cost_breakdown);
  const encoded = JSON.stringify(result.cost_breakdown).toLowerCase();
  assert.equal(encoded.includes("pnl"), false);
  assert.equal(encoded.includes("profit"), false);
});
