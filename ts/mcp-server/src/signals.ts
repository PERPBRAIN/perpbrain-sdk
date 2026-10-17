/** Public-book signals. Inputs are the info endpoint only. */

import { formatDecimal, parseDecimal } from "./fees.ts";
import { type InfoClient, postJson } from "./info.ts";
import { orderBook } from "./queries.ts";
import { HL_FUNDING_INTERVAL_MS } from "./simulate.ts";

const SCALE = 10n ** 18n;

export interface FundingExtremes {
  coin: string;
  funding_rate_per_hour: string;
  funding_mean_per_hour: string;
  funding_stddev_per_hour: string;
  funding_zscore_unitless: string;
  trailing_window_hours: number;
  sample_count: number;
  source: string;
  ts: number;
  stale: boolean;
}

export interface BookImbalance {
  coin: string;
  band_bps: number;
  bid_depth_coin: string;
  ask_depth_coin: string;
  bid_depth_usd: string;
  ask_depth_usd: string;
  bid_over_ask_depth_ratio: string | null;
  mid_px_usd: string;
  source: string;
  ts: number;
  stale: boolean;
}

export async function fundingExtremes(
  client: InfoClient,
  coin: string,
  nowMs: number,
  windowHours = 24,
  fundingIntervalMs = HL_FUNDING_INTERVAL_MS,
): Promise<FundingExtremes> {
  if (coin === "") {
    throw new Error("market is required");
  }
  const window = windowOf(windowHours);
  const interval = intervalOf(fundingIntervalMs);
  const start = Math.max(0, nowMs - (window + 2) * interval);
  const payload = await postJson(client, { type: "fundingHistory", coin, startTime: start });
  const prints = printsOf(payload, coin);
  if (prints.length < 3) {
    throw new Error("funding window needs at least 2 prints before the latest");
  }
  const current = prints[prints.length - 1];
  if (current === undefined) {
    throw new Error("funding window needs at least 2 prints before the latest");
  }
  const history = prints.slice(0, -1).slice(-window);
  if (history.length < 2) {
    throw new Error("funding window needs at least 2 prints before the latest");
  }
  const rates = history.map((item) => item.rate);
  const mean = rates.reduce((sum, rate) => sum + rate, 0n) / BigInt(rates.length);
  const square = rates.reduce((sum, rate) => sum + (rate - mean) ** 2n, 0n);
  const variance = square / (SCALE * BigInt(rates.length - 1));
  if (variance === 0n) {
    throw new Error("funding dispersion is zero");
  }
  const stdev = isqrt(variance * SCALE);
  const score = ((current.rate - mean) * SCALE) / stdev;
  const age = Math.max(0, nowMs - current.time);
  return {
    coin,
    funding_rate_per_hour: formatDecimal(current.rate),
    funding_mean_per_hour: formatDecimal(mean),
    funding_stddev_per_hour: formatDecimal(stdev),
    funding_zscore_unitless: formatDecimal(score),
    trailing_window_hours: window,
    sample_count: history.length,
    source: client.url,
    ts: current.time,
    stale: age > interval,
  };
}

export async function bookImbalance(
  client: InfoClient,
  coin: string,
  nowMs: number,
  bandBps = 10,
): Promise<BookImbalance> {
  if (coin === "") {
    throw new Error("market is required");
  }
  const band = bandOf(bandBps);
  const book = await orderBook(client, coin, nowMs, 20);
  const bids = book.bids.map((level) => ({ px: parseDecimal(level.px), sz: parseDecimal(level.sz) }));
  const asks = book.asks.map((level) => ({ px: parseDecimal(level.px), sz: parseDecimal(level.sz) }));
  if (bids.length === 0 || asks.length === 0) {
    throw new Error("book side is empty");
  }
  const bestBid = bids.reduce((best, level) => (level.px > best ? level.px : best), bids[0]?.px ?? 0n);
  const bestAsk = asks.reduce((best, level) => (level.px < best ? level.px : best), asks[0]?.px ?? 0n);
  if (bestBid >= bestAsk) {
    throw new Error("book is crossed");
  }
  const mid = (bestBid + bestAsk) / 2n;
  const bidFloor = (mid * BigInt(10_000 - band)) / 10_000n;
  const askCeil = (mid * BigInt(10_000 + band)) / 10_000n;
  const bidLevels = bids.filter((level) => level.px >= bidFloor);
  const askLevels = asks.filter((level) => level.px <= askCeil);
  const bidCoin = bidLevels.reduce((sum, level) => sum + level.sz, 0n);
  const askCoin = askLevels.reduce((sum, level) => sum + level.sz, 0n);
  const bidUsd = bidLevels.reduce((sum, level) => sum + (level.px * level.sz) / SCALE, 0n);
  const askUsd = askLevels.reduce((sum, level) => sum + (level.px * level.sz) / SCALE, 0n);
  return {
    coin,
    band_bps: band,
    bid_depth_coin: formatDecimal(bidCoin),
    ask_depth_coin: formatDecimal(askCoin),
    bid_depth_usd: formatDecimal(bidUsd),
    ask_depth_usd: formatDecimal(askUsd),
    bid_over_ask_depth_ratio: askCoin === 0n ? null : formatDecimal((bidCoin * SCALE) / askCoin),
    mid_px_usd: formatDecimal(mid),
    source: client.url,
    ts: book.asOfMs,
    stale: book.stale,
  };
}

function printsOf(payload: unknown, coin: string): Array<{ time: number; rate: bigint }> {
  if (!Array.isArray(payload)) {
    throw new Error("fundingHistory must be a list");
  }
  const rows = payload.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new Error("funding must be an object");
    }
    const body = item as Record<string, unknown>;
    if (body.coin !== coin) {
      throw new Error("funding coin does not match the request");
    }
    if (typeof body.time !== "number" || !Number.isInteger(body.time)) {
      throw new Error("funding time must be an integer");
    }
    if (typeof body.fundingRate !== "string") {
      throw new Error("fundingRate must be a string");
    }
    return { time: body.time, rate: parseDecimal(body.fundingRate) };
  });
  rows.sort((left, right) => left.time - right.time);
  return rows;
}

function isqrt(value: bigint): bigint {
  if (value < 0n) {
    throw new Error("sqrt of a negative");
  }
  if (value < 2n) {
    return value;
  }
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

function windowOf(value: number): number {
  if (!Number.isInteger(value) || value < 2) {
    throw new Error("window_hours must be an integer >= 2");
  }
  return value;
}

function bandOf(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 10_000) {
    throw new Error("band_bps must be an integer from 1 to 10000");
  }
  return value;
}

function intervalOf(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("funding_interval_ms must be a positive integer");
  }
  return value;
}
