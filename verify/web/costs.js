/** Execution-cost breakdown shared by the verify page and the results card. */

export const COST_SCHEMA_VERSION = 1;
const NOT_RECORDED = "not recorded";
const SCALE = 36n;
const FACTOR = 10n ** SCALE;

export function notModelledItems() {
  return [
    { item: "queue_position", status: "NOT_MODELLED" },
    { item: "liquidation", status: "NOT_MODELLED" },
  ];
}

export function executionCost(result, book) {
  const source = result && typeof result === "object" ? result : {};
  const levels = book && typeof book === "object" ? book : {};
  const mid = bookMid(levels);
  const trades = tradesOf(source, mid);
  const tiers = tiersOf(trades, source);
  const funding = fundingOf(source.funding_payments);
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

export function costsText(breakdown) {
  const slip = breakdown.slippage_vs_mid_usd === null ? NOT_RECORDED : breakdown.slippage_vs_mid_usd;
  return `fees ${breakdown.fees_usd} · vs mid ${slip} · paid ${breakdown.funding_paid_usd} · received ${breakdown.funding_received_usd}`;
}

export function tierText(breakdown) {
  if (!Array.isArray(breakdown.fees_by_tier) || breakdown.fees_by_tier.length === 0) {
    return NOT_RECORDED;
  }
  return breakdown.fees_by_tier
    .map((row) => `${row.fee_version} · taker ${row.taker_usd} · maker ${row.maker_usd}`)
    .join(" | ");
}

export function costRows(receipt) {
  const body = receipt && typeof receipt === "object" ? receipt : {};
  const inputs = body.inputs && typeof body.inputs === "object" ? body.inputs : {};
  let breakdown;
  try {
    breakdown = executionCost(body.result, inputs.book);
  } catch {
    return [{ label: "Execution cost", value: NOT_RECORDED }];
  }
  const rows = [
    ["Schema", String(breakdown.schema_version)],
    ["Fees", breakdown.fees_usd],
    ["Mid", breakdown.mid_usd === null ? NOT_RECORDED : breakdown.mid_usd],
    ["Slippage vs mid", breakdown.slippage_vs_mid_usd === null ? NOT_RECORDED : breakdown.slippage_vs_mid_usd],
    ["Funding paid", breakdown.funding_paid_usd],
    ["Funding received", breakdown.funding_received_usd],
  ];
  for (const tier of breakdown.fees_by_tier) {
    rows.push(["Tier", `${tier.fee_version} · taker ${tier.taker_usd} · maker ${tier.maker_usd}`]);
  }
  for (const trade of breakdown.trades) {
    const slip = trade.slippage_vs_mid_usd === null ? NOT_RECORDED : trade.slippage_vs_mid_usd;
    rows.push([
      `Trade ${trade.index}`,
      `${trade.kind} ${trade.liquidity} fee ${trade.fee_usd} · vs mid ${slip}`,
    ]);
  }
  for (const item of breakdown.not_modelled) {
    rows.push([item.item, item.status]);
  }
  return rows.map(([label, value]) => ({ label, value }));
}

function tradesOf(result, mid) {
  const fills = Array.isArray(result.fills) ? result.fills : [];
  return fills.map((fill, index) => {
    const schedule = scheduleOf(fill, result);
    const fee = parseDecimal(String(fill.fee));
    if (fill.liquidity !== "taker" && fill.liquidity !== "maker") {
      throw new Error("liquidity must be taker or maker");
    }
    const takerFee = fill.liquidity === "taker" ? fee : 0n;
    const makerFee = fill.liquidity === "maker" ? fee : 0n;
    const slip = slippageOf(fill, mid);
    return {
      index,
      kind: String(fill.kind),
      side: String(fill.side),
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

function tiersOf(trades, result) {
  const groups = new Map();
  const order = [];
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
  if (order.length > 0) return order.map((version) => groups.get(version));
  const version = typeof result.fee_version === "string" ? result.fee_version : "";
  if (version === "") return [];
  return [
    {
      fee_version: version,
      taker_bps: typeof result.taker_bps === "string" ? result.taker_bps : "",
      maker_bps: typeof result.maker_bps === "string" ? result.maker_bps : "",
      taker_usd: "0",
      maker_usd: "0",
      fee_usd: "0",
    },
  ];
}

function fundingOf(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const payment = parseDecimal(String(item.payment_usd));
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

function aggregateSlippage(trades) {
  if (trades.length === 0) return "0";
  let total = 0n;
  for (const trade of trades) {
    if (trade.slippage_vs_mid_usd === null) return null;
    total = add(total, parseDecimal(trade.slippage_vs_mid_usd));
  }
  return formatDecimal(total);
}

function slippageOf(fill, mid) {
  if (mid === null) return null;
  let total = 0n;
  const legs = Array.isArray(fill.legs) ? fill.legs : [];
  for (const leg of legs) {
    const qty = parseDecimal(String(leg.size));
    const px = parseDecimal(String(leg.price));
    if (fill.side === "buy") total = add(total, mul(sub(px, mid), qty));
    else if (fill.side === "sell") total = add(total, mul(sub(mid, px), qty));
    else throw new Error("side must be buy or sell");
  }
  return total;
}

function bookMid(book) {
  const bid = touch(book.bids, true);
  const ask = touch(book.asks, false);
  if (bid === null || ask === null) return null;
  return div2(add(bid, ask));
}

function touch(levels, highest) {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  let chosen = null;
  for (const level of levels) {
    const px = parseDecimal(String(level.px));
    if (chosen === null || (highest ? px > chosen : px < chosen)) chosen = px;
  }
  return chosen;
}

function scheduleOf(fill, result) {
  return {
    version: fallback(fill.fee_version, result.fee_version),
    takerBps: fallback(fill.taker_bps, result.taker_bps),
    makerBps: fallback(fill.maker_bps, result.maker_bps),
  };
}

function fallback(primary, secondary) {
  if (typeof primary === "string" && primary !== "") return primary;
  return typeof secondary === "string" ? secondary : "";
}

function parseDecimal(text) {
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error("decimal required");
  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;
  const [whole, frac = ""] = body.split(".");
  if (frac.length > Number(SCALE)) throw new Error("decimal scale exceeded");
  const padded = frac + "0".repeat(Number(SCALE) - frac.length);
  const value = BigInt(whole) * FACTOR + BigInt(padded);
  return negative ? -value : value;
}

function formatDecimal(value) {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / FACTOR;
  const frac = (abs % FACTOR).toString().padStart(Number(SCALE), "0").replace(/0+$/, "");
  const text = frac.length === 0 ? whole.toString() : `${whole.toString()}.${frac}`;
  return negative ? `-${text}` : text;
}

function add(left, right) {
  return left + right;
}

function sub(left, right) {
  return left - right;
}

function mul(left, right) {
  return (left * right) / FACTOR;
}

function div2(value) {
  if (value % 2n !== 0n) throw new Error("decimal scale exceeded");
  return value / 2n;
}
