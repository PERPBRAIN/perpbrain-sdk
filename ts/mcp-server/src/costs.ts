/** Execution-cost breakdown. Fees, book-walk slippage versus mid, and funding paid or received. */

import type { Book, Fill, FundingPayment, Level } from "./simulate.ts";

export const COST_SCHEMA_VERSION = 1;
export const NOT_RECORDED = "not recorded";

const SCALE = 36n;
const FACTOR = 10n ** SCALE;

export interface NotModelledItem {
  item: "queue_position" | "liquidation";
  status: "NOT_MODELLED";
}

export interface TradeCost {
  index: number;
  kind: string;
  side: string;
  liquidity: string;
  fee_version: string;
  taker_bps: string;
  maker_bps: string;
  fee_usd: string;
  taker_fee_usd: string;
  maker_fee_usd: string;
  slippage_vs_mid_usd: string | null;
}

export interface TierFee {
  fee_version: string;
  taker_bps: string;
  maker_bps: string;
  taker_usd: string;
  maker_usd: string;
  fee_usd: string;
}

export interface FundingCost {
  time_ms: number;
  payment_usd: string;
  paid_usd: string;
  received_usd: string;
}

export interface CostBreakdown {
  schema_version: number;
  label: "SIMULATED";
  trades: TradeCost[];
  fees_by_tier: TierFee[];
  fees_usd: string;
  mid_usd: string | null;
  slippage_vs_mid_usd: string | null;
  funding_payments: FundingCost[];
  funding_paid_usd: string;
  funding_received_usd: string;
  not_modelled: NotModelledItem[];
}

interface CostSource {
  fills?: readonly Fill[];
  feeVersion?: string;
  fee_version?: string;
  takerBps?: string;
  taker_bps?: string;
  makerBps?: string;
  maker_bps?: string;
  fundingPayments?: readonly FundingPayment[];
  funding_payments?: readonly FundingPayment[];
}

export function notModelledItems(): NotModelledItem[] {
  return [
    { item: "queue_position", status: "NOT_MODELLED" },
    { item: "liquidation", status: "NOT_MODELLED" },
  ];
}

export function executionCost(result: CostSource, book: Book): CostBreakdown {
  const mid = bookMid(book);
  const trades = tradesOf(result, mid);
  const tiers = tiersOf(trades, result);
  const funding = fundingOf(result.funding_payments ?? result.fundingPayments);
  const paid = funding.reduce((sum, row) => add(sum, parseDecimal(row.paid_usd)), 0n);
  const received = funding.reduce((sum, row) => add(sum, parseDecimal(row.received_usd)), 0n);
  const fees = trades.reduce((sum, trade) => add(sum, parseDecimal(trade.fee_usd)), 0n);
  return {
    schema_version: COST_SCHEMA_VERSION,
    label: "SIMULATED",
    trades,
    fees_by_tier: tiers,
    fees_usd: formatDecimal(fees),
    mid_usd: mid === null ? null : formatDecimal(mid),
    slippage_vs_mid_usd: aggregateSlippage(trades),
    funding_payments: funding,
    funding_paid_usd: formatDecimal(paid),
    funding_received_usd: formatDecimal(received),
    not_modelled: notModelledItems(),
  };
}

export function costsText(breakdown: CostBreakdown): string {
  const slip = breakdown.slippage_vs_mid_usd === null ? NOT_RECORDED : breakdown.slippage_vs_mid_usd;
  return `fees ${breakdown.fees_usd} · vs mid ${slip} · paid ${breakdown.funding_paid_usd} · received ${breakdown.funding_received_usd}`;
}

export function tierText(breakdown: CostBreakdown): string {
  if (breakdown.fees_by_tier.length === 0) {
    return NOT_RECORDED;
  }
  return breakdown.fees_by_tier
    .map((row) => `${row.fee_version} · taker ${row.taker_usd} · maker ${row.maker_usd}`)
    .join(" | ");
}

function tradesOf(result: CostSource, mid: bigint | null): TradeCost[] {
  const fills = result.fills ?? [];
  return fills.map((fill, index) => {
    const schedule = scheduleOf(fill, result);
    const fee = parseDecimal(fill.fee);
    const takerFee = fill.liquidity === "taker" ? fee : 0n;
    const makerFee = fill.liquidity === "maker" ? fee : 0n;
    if (fill.liquidity !== "taker" && fill.liquidity !== "maker") {
      throw new Error("liquidity must be taker or maker");
    }
    const slip = slippageOf(fill, mid);
    return {
      index,
      kind: fill.kind,
      side: fill.side,
      liquidity: fill.liquidity,
      fee_version: schedule.version,
      taker_bps: schedule.takerBps,
      maker_bps: schedule.makerBps,
      fee_usd: formatDecimal(fee),
      taker_fee_usd: formatDecimal(takerFee),
      maker_fee_usd: formatDecimal(makerFee),
      slippage_vs_mid_usd: slip === null ? null : formatDecimal(slip),
    };
  });
}

function tiersOf(trades: TradeCost[], result: CostSource): TierFee[] {
  const groups = new Map<string, TierFee>();
  const order: string[] = [];
  for (const trade of trades) {
    const version = trade.fee_version;
    let row = groups.get(version);
    if (row === undefined) {
      row = {
        fee_version: version,
        taker_bps: trade.taker_bps,
        maker_bps: trade.maker_bps,
        taker_usd: "0",
        maker_usd: "0",
        fee_usd: "0",
      };
      groups.set(version, row);
      order.push(version);
    }
    row.taker_usd = formatDecimal(add(parseDecimal(row.taker_usd), parseDecimal(trade.taker_fee_usd)));
    row.maker_usd = formatDecimal(add(parseDecimal(row.maker_usd), parseDecimal(trade.maker_fee_usd)));
    row.fee_usd = formatDecimal(add(parseDecimal(row.fee_usd), parseDecimal(trade.fee_usd)));
  }
  if (order.length > 0) {
    return order.map((version) => {
      const row = groups.get(version);
      if (row === undefined) {
        throw new Error("fee tier missing");
      }
      return row;
    });
  }
  const version = textOf(result.fee_version ?? result.feeVersion);
  if (version === "") {
    return [];
  }
  return [
    {
      fee_version: version,
      taker_bps: textOf(result.taker_bps ?? result.takerBps),
      maker_bps: textOf(result.maker_bps ?? result.makerBps),
      taker_usd: "0",
      maker_usd: "0",
      fee_usd: "0",
    },
  ];
}

function fundingOf(value: readonly FundingPayment[] | undefined): FundingCost[] {
  if (value === undefined) {
    return [];
  }
  return value.map((item) => {
    const payment = parseDecimal(item.payment_usd);
    const paid = payment < 0n ? -payment : 0n;
    const received = payment > 0n ? payment : 0n;
    return {
      time_ms: item.time_ms,
      payment_usd: formatDecimal(payment),
      paid_usd: formatDecimal(paid),
      received_usd: formatDecimal(received),
    };
  });
}

function aggregateSlippage(trades: TradeCost[]): string | null {
  if (trades.length === 0) {
    return "0";
  }
  let total = 0n;
  for (const trade of trades) {
    if (trade.slippage_vs_mid_usd === null) {
      return null;
    }
    total = add(total, parseDecimal(trade.slippage_vs_mid_usd));
  }
  return formatDecimal(total);
}

function slippageOf(fill: Fill, mid: bigint | null): bigint | null {
  if (mid === null) {
    return null;
  }
  let total = 0n;
  for (const leg of fill.legs) {
    const qty = parseDecimal(leg.size);
    const px = parseDecimal(leg.price);
    if (fill.side === "buy") {
      total = add(total, mul(sub(px, mid), qty));
    } else if (fill.side === "sell") {
      total = add(total, mul(sub(mid, px), qty));
    } else {
      throw new Error("side must be buy or sell");
    }
  }
  return total;
}

function bookMid(book: Book): bigint | null {
  const bid = touch(book.bids, true);
  const ask = touch(book.asks, false);
  if (bid === null || ask === null) {
    return null;
  }
  return div2(add(bid, ask));
}

function touch(levels: Level[] | undefined, highest: boolean): bigint | null {
  if (levels === undefined || levels.length === 0) {
    return null;
  }
  let chosen: bigint | null = null;
  for (const level of levels) {
    const px = parseDecimal(level.px);
    if (chosen === null || (highest ? px > chosen : px < chosen)) {
      chosen = px;
    }
  }
  return chosen;
}

function scheduleOf(fill: Fill & { fee_version?: string; taker_bps?: string; maker_bps?: string }, result: CostSource): {
  version: string;
  takerBps: string;
  makerBps: string;
} {
  return {
    version: fallback(fill.fee_version, result.fee_version ?? result.feeVersion),
    takerBps: fallback(fill.taker_bps, result.taker_bps ?? result.takerBps),
    makerBps: fallback(fill.maker_bps, result.maker_bps ?? result.makerBps),
  };
}

function fallback(primary: string | undefined, secondary: string | undefined): string {
  if (primary !== undefined && primary !== "") {
    return primary;
  }
  return secondary ?? "";
}

function textOf(value: string | undefined): string {
  return value ?? "";
}

function parseDecimal(text: string): bigint {
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new Error("decimal required");
  }
  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;
  const [whole, frac = ""] = body.split(".");
  if (frac.length > Number(SCALE)) {
    throw new Error("decimal scale exceeded");
  }
  const padded = frac + "0".repeat(Number(SCALE) - frac.length);
  const value = BigInt(whole) * FACTOR + BigInt(padded);
  return negative ? -value : value;
}

function formatDecimal(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / FACTOR;
  const frac = (abs % FACTOR).toString().padStart(Number(SCALE), "0").replace(/0+$/, "");
  const text = frac.length === 0 ? whole.toString() : `${whole.toString()}.${frac}`;
  return negative ? `-${text}` : text;
}

function add(left: bigint, right: bigint): bigint {
  return left + right;
}

function sub(left: bigint, right: bigint): bigint {
  return left - right;
}

function mul(left: bigint, right: bigint): bigint {
  return (left * right) / FACTOR;
}

function div2(value: bigint): bigint {
  if (value % 2n !== 0n) {
    throw new Error("decimal scale exceeded");
  }
  return value / 2n;
}
