/** JSON-RPC for the read and sim tools. No order tool. */

import { GuardBlocked, GuardSession } from "../../../sdk/src/guards.ts";
import { costBreakdownFromReceipt, verifyReceipt } from "../../../sdk/src/receipt.ts";
import { guardedSimulate } from "./guardSim.ts";
import { InfoClient } from "./info.ts";
import { READ_SIM_TOOLS } from "./index.ts";
import { fees, funding, markets, orderBook, positions } from "./queries.ts";
import { bookImbalance, fundingExtremes } from "./signals.ts";
import {
  HL_FUNDING_INTERVAL_MS,
  type Bar,
  type Book,
  type Decision,
  type FundingSample,
  type GuardContext,
  type Liquidity,
  type PositionSide,
} from "./simulate.ts";

const ORDER_TOOLS = new Set(["order", "submit_order", "submit-order"]);

const DESCRIPTIONS: Record<(typeof READ_SIM_TOOLS)[number], string> = {
  markets: "List perpetual markets from the public info endpoint.",
  order_book: "Read a capped order book and its data age.",
  funding: "Read funding, mark, and open interest for one coin.",
  positions: "Read positions for one address.",
  fees: "Read the address fee rates and their data age.",
  simulate: "Simulate a closed-bar decision on a supplied book. Result is SIMULATED.",
  funding_extremes: "Z-score of the public hourly funding rate against a trailing window.",
  book_imbalance: "Bid depth divided by ask depth inside a public-book band.",
  get_limits: "Read the owner limits and the remaining headroom.",
  trigger_kill_switch: "Latch the kill switch. A tool call cannot clear it.",
  get_cost_breakdown: "Recompute the execution-cost breakdown from a simulation receipt. The result is SIMULATED.",
  verify_receipt:
    "Check a simulation receipt against manifest and inputs bytes. The check is verified and reproducible.",
};

export { DESCRIPTIONS };

export interface JsonRpc {
  jsonrpc: "2.0";
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export async function handleMessage(
  message: unknown,
  options: { client?: InfoClient; nowMs?: number; session?: GuardSession } = {},
): Promise<JsonRpc> {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return error(null, -32600, "request must be an object");
  }
  const request = message as Record<string, unknown>;
  const requestId = request.id ?? null;
  if (typeof request.method !== "string") {
    return error(requestId, -32600, "method is required");
  }
  const params = paramsOf(request.params);
  if (params === null) {
    return error(requestId, -32602, "params must be an object");
  }
  try {
    return { jsonrpc: "2.0", id: requestId, result: await dispatch(request.method, params, options) };
  } catch (caught) {
    const text = caught instanceof Error ? caught.message : "request failed";
    return error(requestId, -32602, text);
  }
}

export async function handleLines(
  lines: readonly string[],
  options: { client?: InfoClient; nowMs?: number; session?: GuardSession } = {},
): Promise<string[]> {
  const shared = options.session ?? GuardSession.fromConfig();
  const responses: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    try {
      responses.push(
        JSON.stringify(await handleMessage(JSON.parse(line) as unknown, { ...options, session: shared })),
      );
    } catch {
      responses.push(JSON.stringify(error(null, -32700, "parse error")));
    }
  }
  return responses;
}

async function dispatch(
  method: string,
  params: Record<string, unknown>,
  options: { client?: InfoClient; nowMs?: number; session?: GuardSession },
): Promise<unknown> {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "perpbrain", version: "0.0.0" },
      };
    case "tools/list":
      return {
        tools: READ_SIM_TOOLS.map((name) => ({
          name,
          description: DESCRIPTIONS[name],
          inputSchema: { type: "object" },
        })),
      };
    case "tools/call":
      return await callTool(params, options);
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

async function callTool(
  params: Record<string, unknown>,
  options: { client?: InfoClient; nowMs?: number; session?: GuardSession },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError: boolean }> {
  if (typeof params.name !== "string") {
    throw new Error("tool name is required");
  }
  if (ORDER_TOOLS.has(params.name)) {
    throw new Error("Phase 1 has no mainnet order path");
  }
  if (!isTool(params.name)) {
    throw new Error("unknown tool");
  }
  const args = objectOf(params.arguments ?? {}, "arguments");
  try {
    const text = JSON.stringify(await invoke(params.name, args, options));
    return { content: [{ type: "text", text }], isError: false };
  } catch (caught) {
    if (caught instanceof GuardBlocked) {
      return { content: [{ type: "text", text: JSON.stringify(caught.result) }], isError: true };
    }
    throw caught;
  }
}

async function invoke(
  name: (typeof READ_SIM_TOOLS)[number],
  args: Record<string, unknown>,
  options: { client?: InfoClient; nowMs?: number; session?: GuardSession },
): Promise<unknown> {
  const nowMs = typeof args.nowMs === "number" ? args.nowMs : (options.nowMs ?? 0);
  const session = options.session ?? GuardSession.fromConfig();
  switch (name) {
    case "markets":
      return await markets(requireClient(options.client), nowMs);
    case "order_book":
      return await orderBook(
        requireClient(options.client),
        requiredString(args, "coin"),
        nowMs,
        typeof args.depth === "number" ? args.depth : 20,
      );
    case "funding":
      return await funding(requireClient(options.client), requiredString(args, "coin"), nowMs);
    case "positions":
      return await positions(requireClient(options.client), requiredString(args, "address"), nowMs);
    case "fees":
      return await fees(requireClient(options.client), requiredString(args, "address"), nowMs);
    case "get_limits":
      return limitsPayload(session, nowMs);
    case "trigger_kill_switch":
      return engage(session, args);
    case "simulate":
      rejectOwnerFields(args);
      return guardedSimulate(
        requiredString(args, "market"),
        decisionOf(args.decision),
        barsOf(args.bars),
        bookOf(args.book),
        typeof args.feeVersion === "string" ? args.feeVersion : null,
        guardContext(args),
        "standard",
        session,
        fundingOf(args.funding),
        intervalOf(args.fundingIntervalMs),
      );
    case "funding_extremes":
      return await fundingExtremes(
        requireClient(options.client),
        requiredString(args, "coin"),
        nowMs,
        integerOf(args.windowHours ?? 24, "windowHours"),
      );
    case "book_imbalance":
      return await bookImbalance(
        requireClient(options.client),
        requiredString(args, "coin"),
        nowMs,
        integerOf(args.bandBps ?? 10, "bandBps"),
      );
    case "get_cost_breakdown":
      return costBreakdownFromReceipt(args.receipt);
    case "verify_receipt":
      return verifyReceipt(
        args.receipt,
        bytesOf(args.manifest, "manifest"),
        bytesOf(args.inputs, "inputs"),
      );
    default: {
      const unexpected: never = name;
      throw new Error(`unknown tool ${String(unexpected)}`);
    }
  }
}

function guardContext(args: Record<string, unknown>): GuardContext {
  const context: GuardContext = {};
  if (args.leverage !== undefined) {
    context.leverage = stringOf(args.leverage, "leverage");
  }
  if (args.openPositions !== undefined) {
    if (typeof args.openPositions !== "number" || !Number.isInteger(args.openPositions)) {
      throw new Error("openPositions must be an integer");
    }
    context.openPositions = args.openPositions;
  }
  if (args.dailyLossUsd !== undefined) {
    context.dailyLossUsd = stringOf(args.dailyLossUsd, "dailyLossUsd");
  }
  if (args.ageMs !== undefined) {
    if (typeof args.ageMs !== "number" || !Number.isInteger(args.ageMs)) {
      throw new Error("ageMs must be an integer");
    }
    context.ageMs = args.ageMs;
  }
  if (args.dailyLossPct !== undefined) {
    context.dailyLossPct = stringOf(args.dailyLossPct, "dailyLossPct");
  }
  if (typeof args.nowMs === "number" && Number.isInteger(args.nowMs)) {
    context.nowMs = args.nowMs;
  }
  return context;
}

function limitsPayload(session: GuardSession, nowMs: number): Record<string, unknown> {
  const body = session.limits.receipt();
  body.headroom = session.headroom(nowMs);
  body.killSwitch = session.killSwitch;
  body.reduceOnly = session.reduceOnly(nowMs);
  const book = session.portfolio();
  body.openPositionCount = book.openPositionCount;
  body.aggregateNotionalUsd = book.aggregateNotionalUsd;
  return body;
}

function engage(session: GuardSession, args: Record<string, unknown>): Record<string, unknown> {
  if (args.clear === true || args.resume === true) {
    throw new Error("the kill switch cannot be cleared from a tool call");
  }
  if (args.engage === false) {
    throw new Error("the kill switch engages only");
  }
  session.engageKillSwitch();
  return { killSwitch: true, cleared: false };
}

function rejectOwnerFields(args: Record<string, unknown>): void {
  const blocked = ["preset", "overrides", "acknowledgeLoosenedLimits", "limits"];
  if (blocked.some((key) => args[key] !== undefined)) {
    throw new Error("limits are owner config and cannot be set from a tool call");
  }
}

function isTool(name: string): name is (typeof READ_SIM_TOOLS)[number] {
  return READ_SIM_TOOLS.some((tool) => tool === name);
}

function requireClient(client: InfoClient | undefined): InfoClient {
  if (client === undefined) {
    throw new Error("read client is not configured");
  }
  return client;
}

function decisionOf(value: unknown): Decision {
  const body = objectOf(value, "decision");
  const side = sideOf(body.side);
  if (typeof body.barIndex !== "number" || !Number.isInteger(body.barIndex)) {
    throw new Error("barIndex must be an integer");
  }
  const decision: Decision = {
    barIndex: body.barIndex,
    side,
    size: requiredString(body, "size"),
    stop: optionalString(body.stop, "stop"),
    target: optionalString(body.target, "target"),
  };
  if (body.liquidity !== undefined && body.liquidity !== null) {
    decision.liquidity = liquidityOf(body.liquidity);
  }
  return decision;
}

function sideOf(value: unknown): PositionSide {
  if (value === "long" || value === "short") {
    return value;
  }
  throw new Error("side must be long or short");
}

function barsOf(value: unknown): Bar[] {
  return listOf(value, "bars").map((item) => {
    const body = objectOf(item, "bar");
    const row: Bar = {
      open: stringOf(body.open, "open"),
      high: stringOf(body.high, "high"),
      low: stringOf(body.low, "low"),
      close: stringOf(body.close, "close"),
    };
    if (body.timeMs !== undefined) {
      row.timeMs = integerOf(body.timeMs, "timeMs");
    }
    return row;
  });
}

function bookOf(value: unknown): Book {
  const body = objectOf(value, "book");
  return { bids: levelsOf(body.bids), asks: levelsOf(body.asks) };
}

function levelsOf(value: unknown): Book["bids"] {
  return listOf(value, "levels").map((item) => {
    const body = objectOf(item, "level");
    return { px: stringOf(body.px, "px"), sz: stringOf(body.sz, "sz") };
  });
}

function paramsOf(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function objectOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function listOf(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a list`);
  }
  return value;
}

function stringOf(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${key} is required`);
  }
  return value;
}

function liquidityOf(value: unknown): Liquidity {
  if (value === "taker" || value === "maker") {
    return value;
  }
  throw new Error("liquidity must be taker or maker");
}

function intervalOf(value: unknown): number {
  if (value === undefined || value === null) {
    return HL_FUNDING_INTERVAL_MS;
  }
  return integerOf(value, "fundingIntervalMs");
}

function fundingOf(value: unknown): FundingSample[] | null {
  if (value === undefined || value === null) {
    return null;
  }
  return listOf(value, "funding").map((item) => {
    const body = objectOf(item, "funding");
    return {
      timeMs: integerOf(body.timeMs, "timeMs"),
      ratePerHour: stringOf(body.ratePerHour, "ratePerHour"),
      oraclePxUsd: stringOf(body.oraclePxUsd, "oraclePxUsd"),
    };
  });
}

function integerOf(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

function bytesOf(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === "string") {
    return Buffer.from(value, "base64");
  }
  throw new Error(`${label} must be base64 text or bytes`);
}

function optionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return stringOf(value, label);
}

function error(id: unknown, code: number, message: string): JsonRpc {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
