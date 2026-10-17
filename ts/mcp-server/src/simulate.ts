/** Honest simulator. Decisions use a closed bar. Fills use the next bar and the book. */

import { executionCost, type CostBreakdown } from "./costs.ts";
import { feeAmount, feeSchedule, formatDecimal, parseDecimal } from "./fees.ts";

export const NOT_MODELLED = "NOT_MODELLED" as const;
export const HL_FUNDING_INTERVAL_MS = 3_600_000;
export type OrderSide = "buy" | "sell";
export type PositionSide = "long" | "short";
export type Liquidity = "taker" | "maker";

export interface Bar {
  open: string;
  high: string;
  low: string;
  close: string;
  timeMs?: number;
}

export interface Decision {
  barIndex: number;
  side: PositionSide;
  size: string;
  stop: string | null;
  target: string | null;
  liquidity?: Liquidity;
}

export interface FundingSample {
  timeMs: number;
  ratePerHour: string;
  oraclePxUsd: string;
}

export interface FundingPayment {
  time_ms: number;
  rate_per_hour: string;
  oracle_px_usd: string;
  payment_usd: string;
  size_coin: string;
  queue_position: "NOT_MODELLED";
  liquidation: "NOT_MODELLED";
}

export interface Level {
  px: string;
  sz: string;
}

export interface Book {
  bids: Level[];
  asks: Level[];
}

export interface Leg {
  size: string;
  price: string;
}

export interface Fill {
  kind: "entry" | "exit";
  side: OrderSide;
  size: string;
  price: string;
  fee: string;
  slippage: string;
  reason: string;
  legs: Leg[];
  liquidity: Liquidity;
  queue_position: "NOT_MODELLED";
  liquidation: "NOT_MODELLED";
}

export interface Receipt {
  fills: Fill[];
  funding_payments: FundingPayment[];
  queue_position: "NOT_MODELLED";
  liquidation: "NOT_MODELLED";
  cost_breakdown: CostBreakdown;
}

export interface SimulateResult {
  label: "SIMULATED";
  market: string;
  fills: Fill[];
  fillSource: "exchange";
  feeVersion: string;
  takerBps: string;
  makerBps: string;
  fundingIntervalMs: number;
  fundingPayments: FundingPayment[];
  unfilledEntry: string;
  openSize: string;
  queue_position: "NOT_MODELLED";
  liquidation: "NOT_MODELLED";
  cost_breakdown: CostBreakdown;
  receipt: Receipt;
  guardViolations?: string[];
}

export interface FillGuardIntent {
  coin: string;
  notionalUsd: string;
  leverage: string;
  openPositions: number;
  dailyLossUsd: string;
  slippageBps: string;
  ageMs: number;
  opening: boolean;
  orderSide: "buy" | "sell";
  dailyLossPct: string;
  nowMs: number;
}

export interface FillGuardVerdict {
  ok: boolean;
  violations: string[];
}

export type FillGuard = (intent: FillGuardIntent) => FillGuardVerdict;

export interface GuardContext {
  leverage?: string;
  openPositions?: number;
  dailyLossUsd?: string;
  dailyLossPct?: string;
  ageMs?: number;
  nowMs?: number;
}

type ExitHit = { reason: "stopped" | "target"; anchor: bigint };
type ExitPlan = ExitHit & { index: number };

export function simulate(
  market: string,
  decision: Decision,
  bars: Bar[],
  book: Book,
  feeVersion: string | null = null,
  guard: FillGuard | null = null,
  guardContext: GuardContext | null = null,
  funding: FundingSample[] | null = null,
  fundingIntervalMs: number = HL_FUNDING_INTERVAL_MS,
): SimulateResult {
  if (market === "") {
    throw new Error("market is required");
  }
  const interval = fundingInterval(fundingIntervalMs);
  const schedule = feeSchedule(feeVersion);
  const size = positive(decision.size, "size");
  if (decision.barIndex < 0 || decision.barIndex >= bars.length) {
    throw new Error("decision bar is out of range");
  }
  checkSide(decision.side);
  const requested = liquidityOf(decision);
  const entryIndex = decision.barIndex + 1;
  const result = emptyResult(
    market,
    schedule.version,
    schedule.takerBps,
    schedule.makerBps,
    size,
    interval,
  );
  if (entryIndex >= bars.length) {
    return finish(result, book);
  }
  const entrySide = orderSide(decision.side, false);
  const anchor = decimal(bars[entryIndex]?.open ?? "", "open");
  const walked = entryLegs(requested, entrySide, size, anchor, book);
  const filled = size - walked.unfilled;
  result.unfilledEntry = formatDecimal(walked.unfilled);
  if (filled <= 0n) {
    return finish(result, book);
  }
  const entry = fill("entry", entrySide, "next_bar", anchor, walked.legs, scheduleBps(schedule, walked.liquidity), walked.liquidity);
  const entryBlocked = blocked(market, entry, guard, guardContext, true);
  if (entryBlocked !== null) {
    result.unfilledEntry = formatDecimal(size);
    result.guardViolations = entryBlocked;
    return finish(result, book);
  }
  if (guard !== null) {
    result.guardViolations = [];
  }
  result.fills.push(entry);
  const exitPlan = findExit(decision, bars, entryIndex);
  if (exitPlan === null) {
    result.openSize = formatDecimal(filled);
    chargeFunding(result, decision.side, filled, null, 0n, bars, entryIndex, funding, interval);
    return finish(result, book);
  }
  const exitSide = orderSide(decision.side, true);
  const exitWalk = entryLegs(requested, exitSide, filled, exitPlan.anchor, book);
  const exited = filled - exitWalk.unfilled;
  if (exited <= 0n) {
    result.openSize = formatDecimal(filled);
    chargeFunding(result, decision.side, filled, null, 0n, bars, entryIndex, funding, interval);
    return finish(result, book);
  }
  const exitFill = fill(
    "exit",
    exitSide,
    exitPlan.reason,
    exitPlan.anchor,
    exitWalk.legs,
    scheduleBps(schedule, exitWalk.liquidity),
    exitWalk.liquidity,
  );
  const exitBlocked = blocked(market, exitFill, guard, guardContext, false);
  if (exitBlocked !== null) {
    result.openSize = formatDecimal(filled);
    result.guardViolations = exitBlocked;
    chargeFunding(result, decision.side, filled, null, 0n, bars, entryIndex, funding, interval);
    return finish(result, book);
  }
  result.fills.push(exitFill);
  result.openSize = formatDecimal(exitWalk.unfilled);
  chargeFunding(
    result,
    decision.side,
    filled,
    exitPlan.index,
    exitWalk.unfilled,
    bars,
    entryIndex,
    funding,
    interval,
  );
  return finish(result, book);
}

function blocked(
  market: string,
  order: Fill,
  guard: FillGuard | null,
  context: GuardContext | null,
  opening: boolean,
): string[] | null {
  if (guard === null) {
    return null;
  }
  const notional = notionalOf(order);
  const intent: FillGuardIntent = {
    coin: market,
    notionalUsd: notional,
    leverage: context?.leverage ?? "1",
    openPositions: context?.openPositions ?? (opening ? 1 : 0),
    dailyLossUsd: context?.dailyLossUsd ?? "0",
    slippageBps: slippageBps(order.slippage, notional),
    ageMs: context?.ageMs ?? 0,
    opening,
    orderSide: order.side,
    dailyLossPct: context?.dailyLossPct ?? "0",
    nowMs: context?.nowMs ?? 0,
  };
  const verdict = guard(intent);
  if (verdict.ok) {
    return null;
  }
  return [...verdict.violations];
}

function notionalOf(order: Fill): string {
  let total = 0n;
  const scale = 10n ** 18n;
  for (const leg of order.legs) {
    total += (parseDecimal(leg.size) * parseDecimal(leg.price)) / scale;
  }
  return formatDecimal(total);
}

function slippageBps(slippage: string, notional: string): string {
  const notion = parseDecimal(notional);
  if (notion === 0n) {
    return "0";
  }
  const scale = 10n ** 18n;
  return formatDecimal((parseDecimal(slippage) * 10000n * scale) / notion);
}

function emptyResult(
  market: string,
  version: string,
  takerBps: string,
  makerBps: string,
  size: bigint,
  interval: number,
): SimulateResult {
  return {
    label: "SIMULATED",
    market,
    fills: [],
    fillSource: "exchange",
    feeVersion: version,
    takerBps,
    makerBps,
    fundingIntervalMs: interval,
    fundingPayments: [],
    unfilledEntry: formatDecimal(size),
    openSize: "0",
    queue_position: NOT_MODELLED,
    liquidation: NOT_MODELLED,
    cost_breakdown: executionCost({ fills: [], fundingPayments: [] }, { bids: [], asks: [] }),
    receipt: {
      fills: [],
      funding_payments: [],
      queue_position: NOT_MODELLED,
      liquidation: NOT_MODELLED,
      cost_breakdown: executionCost({ fills: [], fundingPayments: [] }, { bids: [], asks: [] }),
    },
  };
}

function finish(result: SimulateResult, book: Book): SimulateResult {
  result.queue_position = NOT_MODELLED;
  result.liquidation = NOT_MODELLED;
  const breakdown = executionCost(result, book);
  result.cost_breakdown = breakdown;
  result.receipt = {
    fills: [...result.fills],
    funding_payments: [...result.fundingPayments],
    queue_position: NOT_MODELLED,
    liquidation: NOT_MODELLED,
    cost_breakdown: breakdown,
  };
  return result;
}

function scheduleBps(schedule: { takerBps: string; makerBps: string }, liquidity: Liquidity): string {
  return liquidity === "maker" ? schedule.makerBps : schedule.takerBps;
}

function fill(
  kind: "entry" | "exit",
  side: OrderSide,
  reason: string,
  anchor: bigint,
  legs: Array<{ qty: bigint; px: bigint }>,
  bps: string,
  liquidity: Liquidity,
): Fill {
  let filled = 0n;
  let notional = 0n;
  let slippage = 0n;
  const scale = 10n ** 18n;
  for (const leg of legs) {
    filled += leg.qty;
    notional += (leg.qty * leg.px) / scale;
    slippage += side === "buy" ? ((leg.px - anchor) * leg.qty) / scale : ((anchor - leg.px) * leg.qty) / scale;
  }
  const price = filled === 0n ? 0n : (notional * scale) / filled;
  return {
    kind,
    side,
    size: formatDecimal(filled),
    price: formatDecimal(price),
    fee: formatDecimal(feeAmount(notional, bps)),
    slippage: formatDecimal(slippage),
    reason,
    legs: legs.map((leg) => ({ size: formatDecimal(leg.qty), price: formatDecimal(leg.px) })),
    liquidity,
    queue_position: NOT_MODELLED,
    liquidation: NOT_MODELLED,
  };
}

function walk(
  side: OrderSide,
  size: bigint,
  anchor: bigint,
  levels: Level[],
): { legs: Array<{ qty: bigint; px: bigint }>; unfilled: bigint } {
  let remaining = size;
  const legs: Array<{ qty: bigint; px: bigint }> = [];
  for (const level of levels) {
    if (remaining <= 0n) {
      break;
    }
    const available = decimal(level.sz, "level size");
    if (available < 0n) {
      throw new Error("level size must be positive");
    }
    if (available === 0n) {
      continue;
    }
    const qty = remaining < available ? remaining : available;
    const levelPx = decimal(level.px, "level price");
    const px = side === "buy" ? max(levelPx, anchor) : min(levelPx, anchor);
    legs.push({ qty, px });
    remaining -= qty;
  }
  return { legs, unfilled: remaining };
}

function findExit(decision: Decision, bars: Bar[], start: number): ExitPlan | null {
  const stop = decision.stop === null ? null : decimal(decision.stop, "stop");
  const target = decision.target === null ? null : decimal(decision.target, "target");
  for (let index = start; index < bars.length; index += 1) {
    const bar = bars[index];
    if (bar === undefined) {
      continue;
    }
    const plan = barExit(
      decision.side,
      decimal(bar.open, "open"),
      decimal(bar.high, "high"),
      decimal(bar.low, "low"),
      stop,
      target,
    );
    if (plan !== null) {
      return { ...plan, index };
    }
  }
  return null;
}

function barExit(
  side: PositionSide,
  opened: bigint,
  high: bigint,
  low: bigint,
  stop: bigint | null,
  target: bigint | null,
): ExitHit | null {
  switch (side) {
    case "long": {
      if (stop !== null && low <= stop) {
        return { reason: "stopped", anchor: opened <= stop ? opened : stop };
      }
      if (target !== null && high >= target) {
        return { reason: "target", anchor: opened >= target ? opened : target };
      }
      return null;
    }
    case "short": {
      if (stop !== null && high >= stop) {
        return { reason: "stopped", anchor: opened >= stop ? opened : stop };
      }
      if (target !== null && low <= target) {
        return { reason: "target", anchor: opened <= target ? opened : target };
      }
      return null;
    }
    default: {
      const unexpected: never = side;
      throw new Error(`unexpected side ${String(unexpected)}`);
    }
  }
}

function orderSide(side: PositionSide, closing: boolean): OrderSide {
  switch (side) {
    case "long":
      return closing ? "sell" : "buy";
    case "short":
      return closing ? "buy" : "sell";
    default: {
      const unexpected: never = side;
      throw new Error(`unexpected side ${String(unexpected)}`);
    }
  }
}

function bookSide(book: Book, side: OrderSide): Level[] {
  switch (side) {
    case "buy":
      return book.asks;
    case "sell":
      return book.bids;
    default: {
      const unexpected: never = side;
      throw new Error(`unexpected side ${String(unexpected)}`);
    }
  }
}

function checkSide(side: string): void {
  if (side !== "long" && side !== "short") {
    throw new Error("side must be long or short");
  }
}

function decimal(value: string, label: string): bigint {
  try {
    return parseDecimal(value);
  } catch {
    throw new Error(`${label} must be a decimal`);
  }
}

function positive(value: string, label: string): bigint {
  const parsed = decimal(value, label);
  if (parsed <= 0n) {
    throw new Error(`${label} must be positive`);
  }
  return parsed;
}

function max(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function min(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function liquidityOf(decision: Decision): Liquidity {
  const raw = decision.liquidity ?? "taker";
  if (raw === "taker" || raw === "maker") {
    return raw;
  }
  throw new Error("liquidity must be taker or maker");
}

function entryLegs(
  requested: Liquidity,
  side: OrderSide,
  size: bigint,
  anchor: bigint,
  book: Book,
): { legs: Array<{ qty: bigint; px: bigint }>; unfilled: bigint; liquidity: Liquidity } {
  if (requested === "maker" && !crosses(side, anchor, book)) {
    const passive = side === "buy" ? book.bids : book.asks;
    const rested = rest(size, anchor, passive);
    return { ...rested, liquidity: "maker" };
  }
  const taken = walk(side, size, anchor, bookSide(book, side));
  return { ...taken, liquidity: "taker" };
}

function crosses(side: OrderSide, anchor: bigint, book: Book): boolean {
  const opposite = bookSide(book, side);
  if (opposite.length === 0) {
    return false;
  }
  const prices = opposite.map((level) => decimal(level.px, "level price"));
  if (side === "buy") {
    return anchor >= prices.reduce((best, price) => min(best, price));
  }
  return anchor <= prices.reduce((best, price) => max(best, price));
}

function rest(
  size: bigint,
  anchor: bigint,
  levels: Level[],
): { legs: Array<{ qty: bigint; px: bigint }>; unfilled: bigint } {
  let remaining = size;
  const legs: Array<{ qty: bigint; px: bigint }> = [];
  for (const level of levels) {
    if (remaining <= 0n) {
      break;
    }
    const available = decimal(level.sz, "level size");
    if (available < 0n) {
      throw new Error("level size must be positive");
    }
    const levelPx = decimal(level.px, "level price");
    if (levelPx !== anchor || available === 0n) {
      continue;
    }
    const qty = remaining < available ? remaining : available;
    legs.push({ qty, px: levelPx });
    remaining -= qty;
  }
  return { legs, unfilled: remaining };
}

function fundingInterval(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("funding_interval_ms must be a positive integer");
  }
  return value;
}

function chargeFunding(
  result: SimulateResult,
  side: PositionSide,
  filled: bigint,
  exitIndex: number | null,
  exitLeft: bigint,
  bars: Bar[],
  entryIndex: number,
  funding: FundingSample[] | null,
  interval: number,
): void {
  if (funding === null || funding.length === 0) {
    return;
  }
  const entryTime = timeMs(bars[entryIndex]);
  const last = bars[bars.length - 1];
  if (last === undefined) {
    return;
  }
  const lastTime = timeMs(last);
  const segments: Array<{ start: number; end: number; size: bigint }> = [];
  if (exitIndex === null) {
    segments.push({ start: entryTime, end: lastTime, size: filled });
  } else {
    const exitTime = timeMs(bars[exitIndex]);
    segments.push({ start: entryTime, end: exitTime, size: filled });
    if (exitLeft > 0n && lastTime > exitTime) {
      segments.push({ start: exitTime, end: lastTime, size: exitLeft });
    }
  }
  result.fundingPayments = payments(side, segments, funding, interval);
}

function payments(
  side: PositionSide,
  segments: Array<{ start: number; end: number; size: bigint }>,
  funding: FundingSample[],
  interval: number,
): FundingPayment[] {
  const sign = side === "long" ? -1n : 1n;
  const seen = new Set<number>();
  const rows: FundingPayment[] = [];
  const ordered = [...funding].sort((left, right) => left.timeMs - right.timeMs);
  const scale = 10n ** 18n;
  for (const sample of ordered) {
    if (!Number.isInteger(sample.timeMs) || sample.timeMs < 0) {
      throw new Error("funding time_ms must be a positive integer");
    }
    if (sample.timeMs % interval !== 0) {
      continue;
    }
    if (seen.has(sample.timeMs)) {
      throw new Error("duplicate funding time");
    }
    seen.add(sample.timeMs);
    const size = sizeAt(segments, sample.timeMs);
    if (size <= 0n) {
      continue;
    }
    const rate = decimal(sample.ratePerHour, "rate_per_hour");
    const oracle = positive(sample.oraclePxUsd, "oracle_px_usd");
    const notion = (size * oracle) / scale;
    const payment = (sign * notion * rate) / scale;
    rows.push({
      time_ms: sample.timeMs,
      rate_per_hour: formatDecimal(rate),
      oracle_px_usd: formatDecimal(oracle),
      payment_usd: formatDecimal(payment),
      size_coin: formatDecimal(size),
      queue_position: NOT_MODELLED,
      liquidation: NOT_MODELLED,
    });
  }
  return rows;
}

function sizeAt(segments: Array<{ start: number; end: number; size: bigint }>, stamp: number): bigint {
  for (const segment of segments) {
    if (segment.start < stamp && stamp <= segment.end && segment.size > 0n) {
      return segment.size;
    }
  }
  return 0n;
}

function timeMs(bar: Bar | undefined): number {
  if (bar === undefined || bar.timeMs === undefined || !Number.isInteger(bar.timeMs) || bar.timeMs < 0) {
    throw new Error("bar time_ms is required when funding is set");
  }
  return bar.timeMs;
}
