import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CODES,
  GuardBlocked,
  GuardConfigError,
  GuardLoosenError,
  GuardSession,
  PRESETS,
  STALE_BLOCK_MS,
  STALE_HALT_MS,
  defaultGuards,
  defaultSnapshot,
  fromConfig,
  nextUtcMidnightMs,
  snapshotFromCoins,
  survivalReport,
  type GuardOverrides,
  type Guards,
  type SimIntent,
} from "../../../sdk/src/guards.ts";
import { guardedSimulate } from "../../../sdk/src/guarded.ts";

function book(size = "100", price = "100") {
  return { bids: [{ px: price, sz: size }], asks: [{ px: price, sz: size }] };
}

function intent(overrides: Partial<SimIntent> = {}): SimIntent {
  return {
    coin: "BTC",
    notionalUsd: "10",
    leverage: "1",
    openPositions: 1,
    dailyLossPct: "0",
    slippageBps: "0",
    ageMs: 0,
    opening: true,
    orderSide: "buy",
    intentKind: "open",
    ...overrides,
  };
}

test("standard is the default and positions are 5", () => {
  process.env.PERPBRAIN_MAX_LEVERAGE = "100";
  const limits = defaultGuards();
  assert.equal(limits.preset, "standard");
  assert.equal(limits.maxLeverage, "5");
  assert.equal(limits.maxNotionalUsd, "25000");
  assert.equal(limits.maxOpenPositions, 5);
  assert.equal(limits.dailyLossPct, "5");
  assert.equal(limits.maxSlippageBps, "50");
  assert.equal(limits.orderRatePerSec, 5);
  assert.deepEqual([...limits.allowedCoins], ["BTC", "ETH"]);
  assert.equal(limits.loosened, false);
  assert.equal(CODES.includes("depth_cap"), true);
  assert.equal("loosen" in limits, false);
  assert.equal(PRESETS.conservative.maxOpenPositions, 3);
  assert.equal(PRESETS.pro.maxLeverage, "10");
  delete process.env.PERPBRAIN_MAX_LEVERAGE;
});

test("loosening needs acknowledgement and stops at the ceiling", () => {
  assert.throws(() => fromConfig("standard", { maxLeverage: "10" }), GuardLoosenError);
  const loosened = fromConfig("standard", { maxLeverage: "10", dailyLossPct: "25" }, true);
  assert.equal(loosened.loosened, true);
  assert.throws(() => fromConfig("standard", { maxLeverage: "41" }, true), GuardConfigError);
  assert.throws(() => fromConfig("standard", { dailyLossPct: "26" }, true), GuardConfigError);
  assert.throws(() => fromConfig("standard", { maxOpenPositions: 51 }, true), GuardConfigError);
  assert.throws(() => fromConfig("standard", { maxSlippageBps: "301" }, true), GuardConfigError);
  assert.throws(() => fromConfig("standard", { orderRatePerSec: 11 }, true), GuardConfigError);
  assert.throws(() => fromConfig("standard", { allowedCoins: ["BTC", "SOL"] }, true), GuardConfigError);
  assert.throws(() => fromConfig("standard", { fee: "1" } as GuardOverrides), /unknown limit/);
  assert.throws(() => fromConfig("custom" as "standard"), GuardConfigError);
  const tighter = fromConfig("standard", { maxLeverage: "2", allowedCoins: ["ETH"] });
  assert.equal(tighter.loosened, false);
  assert.throws(() => tighter.tighten({ maxLeverage: "6" }), GuardLoosenError);
  assert.throws(() => tighter.tighten({ maxNotionalUsd: null }), GuardLoosenError);
  const again = tighter.tighten();
  assert.notEqual(again, tighter);
  assert.equal(again.limitsHash, tighter.limitsHash);
});

test("depth cap blocks a thin book and an empty book", () => {
  const limits = defaultGuards();
  const thin = limits.check(intent({ notionalUsd: "25" }), {
    book: { bids: [], asks: [{ px: "100", sz: "1" }] },
  });
  assert.deepEqual(thin.violations.map((item) => item.code), ["depth_cap"]);
  const empty = limits.check(intent(), { book: { bids: [], asks: [] } });
  assert.deepEqual(empty.violations.map((item) => item.code), ["depth_cap"]);
  assert.equal(limits.check(intent(), { book: book() }).ok, true);
});

test("leverage follows the snapshot and halves outside the top 20", () => {
  const coins = [{ name: "BTC", maxLeverage: 40, openInterest: "1000" }];
  for (let index = 0; index < 20; index += 1) {
    coins.push({ name: `C${String(index).padStart(2, "0")}`, maxLeverage: 10, openInterest: String(20 - index) });
  }
  const snapshot = snapshotFromCoins(coins);
  const limits = fromConfig("pro", null, false, snapshot);
  assert.equal(limits.check(intent({ leverage: "10" }), { book: book(), snapshot }).ok, true);
  const minor = limits.check(intent({ coin: "C19", leverage: "6" }), { book: book(), snapshot });
  assert.deepEqual(minor.violations.map((item) => item.code), ["leverage_exceeded"]);
  assert.equal(limits.check(intent({ coin: "C19", leverage: "5" }), { book: book(), snapshot }).ok, true);
  assert.equal(defaultSnapshot().snapshotId.length, 64);
});

test("stale data blocks new risk, halts at five seconds, and allows a close", () => {
  const limits = defaultGuards();
  const depth = book();
  assert.equal(limits.check(intent({ ageMs: STALE_BLOCK_MS }), { book: depth }).ok, true);
  const stale = limits.check(intent({ ageMs: STALE_BLOCK_MS + 1 }), { book: depth });
  assert.deepEqual(stale.violations.map((item) => item.code), ["stale_data"]);
  const halted = limits.check(intent({ ageMs: STALE_HALT_MS + 1 }), { book: depth });
  assert.deepEqual(halted.violations.map((item) => item.code), ["stale_halt"]);
  assert.equal(limits.check(intent({ ageMs: STALE_BLOCK_MS + 1, intentKind: "reduce" }), { book: depth }).ok, true);
  assert.equal(
    limits.check(intent({ ageMs: STALE_HALT_MS + 1, intentKind: "reduce", dailyLossPct: "40" }), {
      book: depth,
      killSwitch: true,
      reduceOnly: true,
    }).ok,
    true,
  );
  assert.equal(
    limits.check(intent({ ageMs: STALE_HALT_MS + 1, intentKind: "close", opening: false }), { book: depth }).ok,
    true,
  );
});

test("daily stop is reduce-only until the next UTC midnight", () => {
  const session = GuardSession.fromConfig();
  const now = 1_700_000_123_000;
  const blocked = session.check(intent({ dailyLossPct: "5" }), { book: book(), nowMs: now });
  assert.deepEqual(blocked.violations.map((item) => item.code), ["daily_stop_reduce_only"]);
  const later = session.check(intent({ dailyLossPct: "0" }), { book: book(), nowMs: now + 1000 });
  assert.deepEqual(later.violations.map((item) => item.code), ["daily_stop_reduce_only"]);
  assert.equal(session.check(intent({ intentKind: "close", opening: false }), { book: book(), nowMs: now }).ok, true);
  assert.equal(
    session.check(intent({ intentKind: "reduce", dailyLossPct: "9" }), { book: book(), nowMs: now }).ok,
    true,
  );
  assert.equal(session.check(intent(), { book: book(), nowMs: nextUtcMidnightMs(now) }).ok, true);
});

test("portfolio book blocks a new open past either cap", () => {
  const session = GuardSession.fromConfig("conservative");
  session.tighten({ maxNotionalUsd: "100", maxOpenPositions: 2 });
  const depth = book("100000000", "1");
  assert.equal(session.check(intent({ notionalUsd: "100" }), { book: depth, nowMs: 1000 }).ok, true);
  assert.equal(session.aggregateNotionalUsd(), "100");
  assert.equal(session.openPositionCount(), 1);
  const blocked = session.check(intent({ coin: "ETH", notionalUsd: "1" }), { book: depth, nowMs: 2000 });
  assert.deepEqual(
    blocked.violations.map((item) => item.code),
    ["aggregate_notional"],
  );
  assert.equal(session.headroom().aggregateNotionalUsd, "0");
  assert.equal(session.aggregateNotionalUsd(), "100");
  assert.equal(
    session.check(intent({ intentKind: "close", opening: false }), { book: depth, nowMs: 3000 }).ok,
    true,
  );
  assert.equal(session.openPositionCount(), 0);
  assert.equal(session.check(intent({ notionalUsd: "40" }), { book: depth, nowMs: 4000 }).ok, true);
  assert.equal(
    session.check(intent({ coin: "ETH", notionalUsd: "40" }), { book: depth, nowMs: 5000 }).ok,
    true,
  );
  const added = session.check(intent({ coin: "ETH", notionalUsd: "10" }), { book: depth, nowMs: 6000 });
  assert.equal(added.ok, true);
  assert.equal(session.openPositionCount(), 2);
  assert.equal(session.coinNotional("ETH"), "50");
  const depthOnly = GuardSession.fromConfig("pro", { maxNotionalUsd: null }, true);
  assert.equal(depthOnly.limits.loosened, true);
  assert.equal(
    depthOnly.check(intent({ notionalUsd: "1000000" }), { book: depth, nowMs: 7000 }).ok,
    true,
  );
  assert.equal(depthOnly.headroom().aggregateNotionalUsd, "none");
});

test("kill switch latches until owner config changes on restart", () => {
  const session = GuardSession.fromConfig();
  session.engageKillSwitch();
  const blocked = session.check(intent(), { book: book() });
  assert.deepEqual(blocked.violations.map((item) => item.code), ["kill_switch"]);
  assert.equal(session.check(intent({ intentKind: "close", opening: false }), { book: book() }).ok, true);
  assert.equal(session.check(intent({ intentKind: "reduce" }), { book: book() }).ok, true);
  assert.equal(session.restart().killSwitch, true);
  assert.equal(session.restart("standard", { maxLeverage: "4" }).killSwitch, false);
  assert.equal("loosen" in session, false);
});

test("order rate, receipt, and survival report", () => {
  const session = GuardSession.fromConfig("conservative");
  const depth = book();
  assert.equal(session.check(intent(), { book: depth, nowMs: 5000 }).ok, true);
  assert.equal(session.check(intent(), { book: depth, nowMs: 5000 }).ok, true);
  const blocked = session.check(intent(), { book: depth, nowMs: 5000 });
  assert.deepEqual(blocked.violations.map((item) => item.code), ["order_rate"]);
  assert.equal(session.check(intent(), { book: depth, nowMs: 6000 }).ok, true);
  const receipt = session.limits.receipt();
  assert.equal(receipt.guardPreset, "conservative");
  assert.equal(receipt.loosened, false);
  assert.equal(typeof receipt.limitsHash, "string");
  const quiet = Array.from({ length: 30 }, () => ({
    account: "a",
    preset: "standard",
    lossPct: "0",
    killSwitch: false,
  }));
  const stopped = quiet.map((day, index) =>
    index === 3 ? { ...day, account: "b", lossPct: "5" } : { ...day, account: "b" },
  );
  const report = survivalReport([...quiet, ...stopped]);
  const byPreset = report.byPreset as { standard: { accounts: number; survived: number; share: string } };
  assert.deepEqual(byPreset.standard, { accounts: 2, survived: 1, share: "0.5" });
  assert.equal("a" in report, false);
  assert.throws(() => survivalReport(quiet.slice(0, 2)), /30 days/);
});

test("guarded simulate raises GuardBlocked and records a receipt", () => {
  const limits = defaultGuards().tighten({ maxNotionalUsd: "1" });
  const session = new GuardSession(limits);
  assert.throws(
    () =>
      guardedSimulate(
        "BTC",
        { barIndex: 0, side: "long", size: "1", stop: null, target: null },
        [
          { open: "10", high: "10", low: "10", close: "10" },
          { open: "10", high: "10", low: "10", close: "10" },
        ],
        { bids: [{ px: "10", sz: "5" }], asks: [{ px: "10", sz: "5" }] },
        null,
        null,
        "standard",
        session,
      ),
    (error: unknown) => {
      assert.ok(error instanceof GuardBlocked);
      assert.equal(error.code, "GUARD_BLOCKED:NOTIONAL_EXCEEDED");
      assert.deepEqual(error.result.fills, []);
      return true;
    },
  );
  const result = guardedSimulate(
    "ETH",
    { barIndex: 0, side: "short", size: "0.01", stop: null, target: null },
    [
      { open: "100", high: "100", low: "100", close: "100" },
      { open: "100", high: "100", low: "100", close: "100" },
    ],
    { bids: [{ px: "100", sz: "10" }], asks: [{ px: "100", sz: "10" }] },
    null,
    null,
    "pro",
  );
  assert.equal(result.label, "SIMULATED");
  assert.equal(result.guardPreset, "pro");
  assert.deepEqual(result.guardViolations, []);
});

test("parser edges and each loosened field are explicit", () => {
  assert.throws(() => new GuardBlocked([], {}, {}), /violation/);
  assert.throws(() => nextUtcMidnightMs(-1), /nowMs/);
  assert.throws(() => nextUtcMidnightMs(1.5), /nowMs/);
  assert.throws(() => fromConfig("standard", [] as unknown as GuardOverrides), /overrides/);
  assert.throws(() => fromConfig("nope" as "standard"), /unknown preset/);

  assert.equal(fromConfig("standard", { maxNotionalUsd: null }, true).loosened, true);
  assert.equal(fromConfig("standard", { maxNotionalUsd: "25001" }, true).loosened, true);
  assert.equal(fromConfig("standard", { dailyLossPct: "6" }, true).loosened, true);
  assert.equal(fromConfig("standard", { maxOpenPositions: 6 }, true).loosened, true);
  assert.equal(fromConfig("standard", { maxSlippageBps: "51" }, true).loosened, true);
  assert.equal(fromConfig("standard", { orderRatePerSec: 6 }, true).loosened, true);
  assert.throws(() => fromConfig("standard", { maxNotionalUsd: null }), /maxNotionalUsd/);
  assert.throws(() => fromConfig("standard", { maxNotionalUsd: "25001" }), /maxNotionalUsd/);
  assert.equal(fromConfig("standard", { maxNotionalUsd: "10" }).maxNotionalUsd, "10");
  const depthOnly = fromConfig("pro", { maxNotionalUsd: null }, true);
  assert.equal(depthOnly.tighten({ maxNotionalUsd: null }).maxNotionalUsd, null);
  assert.equal(depthOnly.tighten({ maxNotionalUsd: "10" }).maxNotionalUsd, "10");
  assert.throws(() => fromConfig("standard", null, false, snapshotFromCoins([])), /maxLeverage/);

  const limits = defaultGuards();
  const depth = book();
  const tightened = limits.tighten({
    dailyLossPct: "4",
    maxSlippageBps: "40",
    orderRatePerSec: 4,
    maxOpenPositions: 4,
    allowedCoins: ["BTC", "BTC"],
    maxLeverage: "5",
  });
  assert.deepEqual(tightened.allowedCoins, ["BTC"]);
  assert.throws(() => limits.tighten({ maxOpenPositions: 6 }), /maxOpenPositions/);
  assert.throws(() => limits.tighten({ maxNotionalUsd: "25001" }), /maxNotionalUsd/);
  assert.throws(() => limits.tighten({ allowedCoins: ["BTC", "SOL"] }), /allowedCoins/);
  assert.throws(() => limits.tighten({ fee: "1" } as GuardOverrides), /unknown limit/);
  assert.throws(() => limits.tighten([] as unknown as GuardOverrides), /overrides/);
  assert.throws(() => limits.tighten({ allowedCoins: "BTC" }), /allowedCoins/);
  assert.throws(() => limits.tighten({ allowedCoins: [""] }), /allowedCoins/);
  assert.throws(() => limits.tighten({ maxLeverage: 1.5 }), /maxLeverage/);
  assert.equal(limits.tighten({ maxOpenPositions: "4" }).maxOpenPositions, 4);
  assert.throws(() => limits.tighten({ maxOpenPositions: true }), /maxOpenPositions/);

  const blockedCoin = limits.check(intent({ coin: "SOL" }), { book: depth });
  assert.deepEqual(blockedCoin.violations.map((item) => item.code), ["coin_not_allowed"]);
  const crowded = limits.check(intent({ openPositions: 6 }), { book: depth });
  assert.equal(crowded.violations.some((item) => item.code === "open_positions_exceeded"), true);
  const slipped = limits.check(intent({ slippageBps: "51" }), { book: depth });
  assert.equal(slipped.violations.some((item) => item.code === "slippage_exceeded"), true);
  assert.throws(() => limits.check(intent({ orderSide: "flat" as "buy" }), { book: depth }), /orderSide/);
  assert.throws(() => limits.check(null as unknown as SimIntent), /intent/);
  assert.throws(() => limits.check(intent({ coin: 1 as unknown as string }), { book: depth }), /coin/);
  assert.throws(() => limits.check(intent({ notionalUsd: "nope" }), { book: depth }), /notionalUsd/);
  assert.throws(() => limits.check(intent({ leverage: 1.5 as unknown as string }), { book: depth }), /leverage/);
  assert.equal(limits.check(intent({ notionalUsd: 10 as unknown as string }), { book: depth }).ok, true);
  assert.equal(limits.check(intent({ openPositions: "1" as unknown as number }), { book: depth }).ok, true);
  assert.throws(() => limits.check(intent({ ageMs: -1 }), { book: depth }), /ageMs/);
  assert.throws(() => limits.check(intent({ ageMs: 1.5 }), { book: depth }), /ageMs/);
  assert.throws(
    () => limits.check(intent({ notionalUsd: `1.${"1".repeat(19)}` }), { book: depth }),
    /scale/,
  );
  const closing: SimIntent = {
    coin: "BTC",
    notionalUsd: "10",
    leverage: "1",
    openPositions: 1,
    slippageBps: "0",
    ageMs: 0,
    opening: false,
    orderSide: "buy",
  };
  assert.equal(limits.check(closing, { book: { bids: [], asks: [] } }).ok, true);
  assert.equal(
    limits.check(intent({ orderSide: "sell" }), {
      book: {
        bids: [
          { px: "90", sz: "10" },
          { px: "100", sz: "10" },
        ],
        asks: [],
      },
    }).ok,
    true,
  );
  assert.equal(
    limits.check(intent(), { book: depth, recentOrders: 5 }).violations[0]?.code,
    "order_rate",
  );
  assert.equal(
    limits.check(intent(), { book: depth, reduceOnly: true }).violations[0]?.code,
    "daily_stop_reduce_only",
  );
  const perCoin = limits.effectiveLimits(defaultSnapshot());
  assert.equal(typeof perCoin.BTC, "object");
  const session = new GuardSession(limits);
  assert.equal(session.reduceOnly(0), false);
  assert.equal(typeof session.headroom().notionalUsd, "string");
  assert.equal(session.check(intent(), { book: depth, nowMs: 5000 }).ok, true);
  assert.equal(session.check(intent(), { book: depth, nowMs: 4500 }).ok, true);

  const quiet = Array.from({ length: 30 }, () => ({
    account: "e",
    preset: "pro",
    lossPct: "0",
    killSwitch: false,
  }));
  const mixed = quiet.map((day, index) => (index === 0 ? { ...day, preset: "standard" } : day));
  assert.throws(() => survivalReport(mixed), /one preset/);
  assert.throws(
    () => survivalReport(quiet.map((day) => ({ ...day, preset: "custom" }))),
    /unknown preset/,
  );
  assert.throws(
    () => survivalReport(quiet.map((day) => ({ ...day, lossPct: "nope" }))),
    /lossPct/,
  );
});

function draw(rng: () => number, max: number): number {
  return Math.floor(rng() * (max + 1));
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function step(rng: () => number): GuardOverrides {
  return {
    maxLeverage: String(draw(rng, 40)),
    maxNotionalUsd: String(draw(rng, 250000)),
    dailyLossPct: String(draw(rng, 25)),
    maxOpenPositions: draw(rng, 50),
    maxSlippageBps: String(draw(rng, 300)),
    orderRatePerSec: draw(rng, 10),
  };
}

function assertNotRaised(left: Guards, right: Guards): void {
  assert.ok(Number(left.maxLeverage) <= Number(right.maxLeverage));
  if (right.maxNotionalUsd !== null) {
    assert.ok(left.maxNotionalUsd !== null);
    assert.ok(Number(left.maxNotionalUsd) <= Number(right.maxNotionalUsd));
  }
  assert.ok(Number(left.dailyLossPct) <= Number(right.dailyLossPct));
  assert.ok(left.maxOpenPositions <= right.maxOpenPositions);
  assert.ok(Number(left.maxSlippageBps) <= Number(right.maxSlippageBps));
  assert.ok(left.orderRatePerSec <= right.orderRatePerSec);
  assert.ok(left.allowedCoins.every((coin) => right.allowedCoins.includes(coin)));
}

const EXIT_GATES = new Set(["stale_data", "stale_halt", "daily_stop_reduce_only", "kill_switch"]);

function openGateCodes(ageMs: number, loss: string, kill: boolean): string[] {
  const codes: string[] = [];
  if (Number(loss) >= 5) {
    codes.push("daily_stop_reduce_only");
  }
  if (ageMs > STALE_HALT_MS) {
    codes.push("stale_halt");
  } else if (ageMs > STALE_BLOCK_MS) {
    codes.push("stale_data");
  }
  if (kill) {
    codes.push("kill_switch");
  }
  return codes;
}

function assertExitIgnoresStaleDailyStopAndKill(
  ageMs: number,
  loss: string,
  kill: boolean,
  reduceOnly: boolean,
  kind: "reduce" | "close",
): void {
  const limits = defaultGuards();
  const hostile = limits.check(
    intent({
      coin: "SOL",
      notionalUsd: "100000000",
      leverage: "100",
      slippageBps: "1000",
      ageMs,
      dailyLossPct: loss,
      intentKind: kind,
      opening: false,
      openPositions: 50,
    }),
    { book: { bids: [], asks: [] }, killSwitch: kill, reduceOnly },
  );
  assert.equal(
    hostile.violations.some((item) => EXIT_GATES.has(item.code)),
    false,
  );
  if (kind === "close") {
    assert.equal(hostile.ok, true);
    assert.equal(hostile.violations.length, 0);
  }
  const session = GuardSession.fromConfig();
  if (kill) {
    session.engageKillSwitch();
  }
  const allowed = session.check(
    intent({ intentKind: kind, opening: false, ageMs, dailyLossPct: loss }),
    { book: book() },
  );
  assert.equal(allowed.ok, true);
  if (Number(loss) >= 5) {
    const later = session.check(intent({ ageMs: 0, dailyLossPct: "0" }), { book: book(), nowMs: 1 });
    assert.equal(later.ok, false);
    assert.equal(
      later.violations.some((item) => item.code === "daily_stop_reduce_only"),
      true,
    );
    const again = session.check(
      intent({ intentKind: kind, opening: false, ageMs, dailyLossPct: loss }),
      { book: book(), nowMs: 1 },
    );
    assert.equal(again.ok, true);
  }
  const opened = GuardSession.fromConfig();
  if (kill) {
    opened.engageKillSwitch();
  }
  const openedResult = opened.check(intent({ ageMs, dailyLossPct: loss }), { book: book() });
  assert.deepEqual(openedResult.violations.map((item) => item.code), openGateCodes(ageMs, loss, kill));
}

test("reduce and close ignore stale data, the daily stop, and the kill switch", () => {
  const ages = [0, STALE_BLOCK_MS, STALE_BLOCK_MS + 1, STALE_HALT_MS, STALE_HALT_MS + 1, 60_000];
  const losses = ["0", "4.9", "5", "5.1", "40"];
  for (const ageMs of ages) {
    for (const loss of losses) {
      for (const kill of [false, true]) {
        for (const reduceOnly of [false, true]) {
          for (const kind of ["reduce", "close"] as const) {
            assertExitIgnoresStaleDailyStopAndKill(ageMs, loss, kill, reduceOnly, kind);
          }
        }
      }
    }
  }
  const rng = mulberry32(0x5042_7b12);
  for (let sample = 0; sample < 40; sample += 1) {
    const ageMs = draw(rng, 60_000);
    const loss = (draw(rng, 400) / 10).toFixed(1);
    const kill = draw(rng, 1) === 1;
    const reduceOnly = draw(rng, 1) === 1;
    const kind = draw(rng, 1) === 1 ? "reduce" : "close";
    assertExitIgnoresStaleDailyStopAndKill(ageMs, loss, kill, reduceOnly, kind);
  }
});

test("no runtime sequence can raise a limit", () => {
  const rng = mulberry32(0x5042_7a22);
  for (let sample = 0; sample < 25; sample += 1) {
    const session = GuardSession.fromConfig();
    let previous = session.limits;
    const count = draw(rng, 6);
    for (let index = 0; index < count; index += 1) {
      try {
        session.tighten(step(rng));
      } catch (error) {
        assert.ok(error instanceof GuardLoosenError || error instanceof GuardConfigError || error instanceof Error);
      }
      assertNotRaised(session.limits, previous);
      previous = session.limits;
    }
  }
});
