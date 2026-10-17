/** Read-only info queries. Every result carries data age. No order path. */

import { InfoClient } from "./info.ts";

export const STALE_AFTER_MS = 20_000;
export const MAX_BOOK_LEVELS = 20;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface DataAge {
  ageMs: number;
  stale: boolean;
  asOfMs: number;
}

export interface Level {
  px: string;
  sz: string;
  n: number;
}

export interface Market {
  name: string;
  szDecimals: number;
  maxLeverage: number;
}

export interface MarketsResult extends DataAge {
  markets: Market[];
}

export interface BookResult extends DataAge {
  coin: string;
  bids: Level[];
  asks: Level[];
}

export interface FundingResult extends DataAge {
  coin: string;
  funding: string;
  openInterest: string;
  markPx: string;
  oraclePx: string;
  midPx: string;
}

export interface Position {
  coin: string;
  size: string;
  entryPx: string;
  liquidationPx: string | null;
  unrealizedPnl: string;
  leverageType: string;
  leverageValue: number;
}

export interface PositionsResult extends DataAge {
  address: string;
  positions: Position[];
}

export interface FeesResult extends DataAge {
  address: string;
  takerRate: string;
  makerRate: string;
  takerBps: string;
  makerBps: string;
}

export function fractionToBps(fraction: string): string {
  if (!/^\d+(\.\d+)?$/.test(fraction)) {
    throw new Error("rate must be a decimal string");
  }
  const [whole, frac = ""] = fraction.split(".");
  const digits = `${whole}${frac}`.replace(/^0+/, "") || "0";
  const shift = 4 - frac.length;
  let text: string;
  if (shift >= 0) {
    text = digits + "0".repeat(shift);
  } else {
    const index = digits.length + shift;
    text = index <= 0 ? `0.${"0".repeat(-index)}${digits}` : `${digits.slice(0, index)}.${digits.slice(index)}`;
  }
  if (!text.includes(".")) {
    return text;
  }
  const trimmed = text.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" ? "0" : trimmed;
}

export function requireAddress(address: string): string {
  if (!ADDRESS.test(address)) {
    throw new Error("address must be a 0x-prefixed 40 hex character string");
  }
  return address;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function expectList(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a list`);
  }
  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function expectInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

export function messageTime(payload: unknown): number | null {
  if (!isRecord(payload)) {
    return null;
  }
  const raw = payload.time;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return null;
  }
  return raw;
}

export function makeAge(asOfMs: number, nowMs: number): DataAge {
  const elapsed = Math.max(0, nowMs - asOfMs);
  return { ageMs: elapsed, stale: elapsed >= STALE_AFTER_MS, asOfMs };
}

function aged(payload: unknown, nowMs: number, receivedMs: number): DataAge {
  return makeAge(messageTime(payload) ?? receivedMs, nowMs);
}

export function clampDepth(depth: number): number {
  if (depth < 1) {
    throw new Error("depth must be at least 1");
  }
  return Math.min(depth, MAX_BOOK_LEVELS);
}

function parseLevel(value: unknown): Level {
  const body = expectRecord(value, "level");
  return {
    px: expectString(body.px, "px"),
    sz: expectString(body.sz, "sz"),
    n: expectInt(body.n, "n"),
  };
}

export function parseL2Levels(value: unknown, depth: number): { bids: Level[]; asks: Level[] } {
  const limit = clampDepth(depth);
  const sides = expectList(value, "levels");
  if (sides.length !== 2) {
    throw new Error("levels must have a bid side and an ask side");
  }
  const bids = expectList(sides[0], "bids").map(parseLevel).slice(0, limit);
  const asks = expectList(sides[1], "asks").map(parseLevel).slice(0, limit);
  return { bids, asks };
}

export function markets(client: InfoClient, nowMs: number, receivedMs = nowMs): MarketsResult {
  const payload = expectRecord(client.post({ type: "meta" }), "meta");
  const rows = expectList(payload.universe, "universe").map((item) => {
    const body = expectRecord(item, "market");
    return {
      name: expectString(body.name, "name"),
      szDecimals: expectInt(body.szDecimals, "szDecimals"),
      maxLeverage: expectInt(body.maxLeverage, "maxLeverage"),
    };
  });
  return { markets: rows, ...aged(payload, nowMs, receivedMs) };
}

export function orderBook(
  client: InfoClient,
  coin: string,
  nowMs: number,
  depth = 20,
  receivedMs = nowMs,
): BookResult {
  if (coin === "") {
    throw new Error("market is required");
  }
  const payload = expectRecord(client.post({ type: "l2Book", coin }), "l2 book");
  if (payload.coin !== coin) {
    throw new Error("order book coin does not match the request");
  }
  const levels = parseL2Levels(payload.levels, depth);
  return { coin, ...levels, ...aged(payload, nowMs, receivedMs) };
}

export function funding(
  client: InfoClient,
  coin: string,
  nowMs: number,
  receivedMs = nowMs,
): FundingResult {
  if (coin === "") {
    throw new Error("market is required");
  }
  const payload = client.post({ type: "metaAndAssetCtxs" });
  const sides = expectList(payload, "metaAndAssetCtxs");
  if (sides.length !== 2) {
    throw new Error("metaAndAssetCtxs must contain meta and contexts");
  }
  const meta = expectRecord(sides[0], "meta");
  const contexts = expectList(sides[1], "contexts");
  const universe = expectList(meta.universe, "universe");
  const index = universe.findIndex((item) => expectRecord(item, "market").name === coin);
  if (index < 0) {
    throw new Error("coin is not in the universe");
  }
  if (index >= contexts.length) {
    throw new Error("asset context is missing");
  }
  const ctx = expectRecord(contexts[index], "asset context");
  return {
    coin,
    funding: expectString(ctx.funding, "funding"),
    openInterest: expectString(ctx.openInterest, "openInterest"),
    markPx: expectString(ctx.markPx, "markPx"),
    oraclePx: expectString(ctx.oraclePx, "oraclePx"),
    midPx: expectString(ctx.midPx, "midPx"),
    ...aged(payload, nowMs, receivedMs),
  };
}

export function positions(
  client: InfoClient,
  address: string,
  nowMs: number,
  receivedMs = nowMs,
): PositionsResult {
  const user = requireAddress(address);
  const payload = expectRecord(
    client.post({ type: "clearinghouseState", user }),
    "clearinghouse state",
  );
  const rows = expectList(payload.assetPositions, "assetPositions").map(parsePosition);
  return { address: user, positions: rows, ...aged(payload, nowMs, receivedMs) };
}

export function fees(
  client: InfoClient,
  address: string,
  nowMs: number,
  receivedMs = nowMs,
): FeesResult {
  const user = requireAddress(address);
  const payload = expectRecord(client.post({ type: "userFees", user }), "user fees");
  const [takerRate, makerRate] = feeRates(payload);
  return {
    address: user,
    takerRate,
    makerRate,
    takerBps: fractionToBps(takerRate),
    makerBps: fractionToBps(makerRate),
    ...aged(payload, nowMs, receivedMs),
  };
}

function parsePosition(value: unknown): Position {
  const wrapper = expectRecord(value, "asset position");
  if (wrapper.type !== "oneWay") {
    throw new Error("only one-way positions are supported");
  }
  const body = expectRecord(wrapper.position, "position");
  const leverage = expectRecord(body.leverage, "leverage");
  const liquidation = body.liquidationPx;
  return {
    coin: expectString(body.coin, "coin"),
    size: expectString(body.szi, "szi"),
    entryPx: expectString(body.entryPx, "entryPx"),
    liquidationPx: liquidation === null ? null : expectString(liquidation, "liquidationPx"),
    unrealizedPnl: expectString(body.unrealizedPnl, "unrealizedPnl"),
    leverageType: expectString(leverage.type, "leverage type"),
    leverageValue: expectInt(leverage.value, "leverage value"),
  };
}

function feeRates(payload: Record<string, unknown>): [string, string] {
  if (typeof payload.userCrossRate === "string" && typeof payload.userAddRate === "string") {
    return [payload.userCrossRate, payload.userAddRate];
  }
  const schedule = expectRecord(payload.feeSchedule, "feeSchedule");
  return [expectString(schedule.cross, "cross"), expectString(schedule.add, "add")];
}
