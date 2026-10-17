import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { GuardSession } from "../../../sdk/src/guards.ts";
import { InfoClient } from "./info.ts";
import { TokenBucket } from "./rateLimit.ts";
import { handleLines, handleMessage } from "./mcp.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "info");
const EMPTY = `0x${"00".repeat(20)}`;

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as unknown;
}

function client(): InfoClient {
  return new InfoClient((_url, body) => {
    switch (body.type) {
      case "meta":
        return load("meta.json");
      case "metaAndAssetCtxs":
        return load("asset_ctxs.json");
      case "l2Book":
        return load("l2_book_btc.json");
      case "fundingHistory":
        return load("funding_history_btc.json");
      case "userFees":
        return load("user_fees.json");
      case "clearinghouseState":
        return load("clearinghouse_empty.json");
      default:
        throw new Error(`unexpected ${String(body.type)}`);
    }
  }, new TokenBucket());
}

function call(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const response = handleMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    { client: client(), nowMs: 50 },
  );
  const result = response.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

test("tool list is read and sim only", () => {
  const listed = handleMessage({ jsonrpc: "2.0", id: 7, method: "tools/list" });
  const result = listed.result as { tools: Array<{ name: string }> };
  const names = result.tools.map((tool) => tool.name);
  assert.equal(names.includes("funding"), true);
  assert.equal(names.includes("simulate"), true);
  assert.equal(names.includes("order"), false);
  assert.equal(names.includes("submit_order"), false);
  const started = handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize" });
  const info = started.result as { serverInfo: { name: string } };
  assert.equal(info.serverInfo.name, "perpbrain");
});

test("read and sim tools use recorded fixtures", () => {
  const listed = call("markets", {});
  const markets = listed.markets as Array<{ name: string }>;
  assert.equal(markets[0]?.name, "BTC");
  assert.equal(listed.ageMs, 0);
  const funded = call("funding", { coin: "ETH" });
  assert.equal(funded.funding, "0.0000125");
  const quoted = call("fees", { address: EMPTY });
  assert.equal(quoted.takerBps, "4.5");
  assert.equal(quoted.makerBps, "1.5");
  const simulated = call("simulate", {
    market: "BTC",
    decision: { barIndex: 0, side: "long", size: "1", stop: null, target: null },
    bars: [
      { open: "1", high: "1", low: "1", close: "1" },
      { open: "10", high: "11", low: "9", close: "10" },
    ],
    book: { bids: [], asks: [{ px: "10", sz: "100" }] },
  });
  assert.equal(simulated.label, "SIMULATED");
  assert.equal(simulated.fillSource, "exchange");
  assert.deepEqual(simulated.guardViolations, []);
  assert.equal(simulated.queue_position, "NOT_MODELLED");
  assert.equal(simulated.liquidation, "NOT_MODELLED");
  assert.equal("pnl" in simulated, false);
  const extremes = call("funding_extremes", { coin: "BTC", windowHours: 3, nowMs: 3_610_801_000 });
  assert.equal(extremes.funding_zscore_unitless, "8");
  assert.equal(String(extremes.source).endsWith("/info"), true);
  assert.equal(extremes.stale, false);
  const imbalance = call("book_imbalance", { coin: "BTC", bandBps: 10, nowMs: 1_792_159_472_349 });
  assert.equal(imbalance.band_bps, 10);
  assert.equal(imbalance.stale, false);
  assert.equal(typeof imbalance.bid_over_ask_depth_ratio, "string");
  const blocked = call("simulate", {
    market: "BTC",
    leverage: "9",
    decision: { barIndex: 0, side: "long", size: "1", stop: null, target: null },
    bars: [
      { open: "1", high: "1", low: "1", close: "1" },
      { open: "10", high: "11", low: "9", close: "10" },
    ],
    book: { bids: [], asks: [{ px: "10", sz: "100" }] },
  });
  assert.equal(blocked.label, "SIMULATED");
  assert.deepEqual(blocked.fills, []);
  assert.deepEqual(blocked.guardViolations, ["leverage_exceeded"]);
  assert.equal(blocked.error, "GUARD_BLOCKED:LEVERAGE_EXCEEDED");
  assert.equal("headroom" in blocked, true);
  const refused = handleMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "submit_order", arguments: {} },
  });
  assert.match(refused.error?.message ?? "", /no mainnet order path/);
  const lines = handleLines(['{"jsonrpc":"2.0","id":4,"method":"tools/list"}', "not-json"]);
  assert.equal(JSON.parse(lines[0] ?? "{}").id, 4);
  assert.equal(JSON.parse(lines[1] ?? "{}").error.code, -32700);
});

test("get_cost_breakdown recomputes fees and slippage from the receipt", () => {
  const receipt = {
    inputs: {
      market: "ETH",
      decision: { bar_index: 0, side: "long", size: "0.01", stop: null, target: null },
      bars: [
        { open: "100", high: "100", low: "100", close: "100" },
        { open: "100", high: "100", low: "100", close: "100" },
      ],
      book: { bids: [{ px: "100", sz: "5" }], asks: [{ px: "100", sz: "5" }] },
      fee_version: null,
      funding: [],
      funding_interval_ms: 3600000,
      guard_context: { leverage: "1", open_positions: 1, daily_loss_usd: "0", age_ms: 0 },
    },
  };
  const response = handleMessage({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "get_cost_breakdown", arguments: { receipt } },
  });
  const result = response.result as { content: Array<{ text: string }> };
  const body = JSON.parse(result.content[0]?.text ?? "{}") as {
    fees_usd: string;
    slippage_vs_mid_usd: string;
    not_modelled: Array<{ item: string; status: string }>;
  };
  assert.equal(body.fees_usd, "0.00045");
  assert.equal(body.slippage_vs_mid_usd, "0");
  assert.equal(body.not_modelled[0]?.item, "queue_position");
  assert.equal(body.not_modelled[0]?.status, "NOT_MODELLED");
  assert.equal(body.not_modelled[1]?.item, "liquidation");
});

test("get_limits is read only and the kill switch only engages", () => {
  const session = GuardSession.fromConfig();
  const listed = callWith(session, "get_limits", {});
  assert.equal(listed.guardPreset, "standard");
  assert.equal(listed.killSwitch, false);
  assert.equal(listed.openPositionCount, 0);
  assert.equal(listed.aggregateNotionalUsd, "0");
  const limits = listed.limits as { maxOpenPositions: number };
  assert.equal(limits.maxOpenPositions, 5);
  const engaged = callWith(session, "trigger_kill_switch", {});
  assert.deepEqual(engaged, { killSwitch: true, cleared: false });
  const cleared = handleMessage(
    {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "trigger_kill_switch", arguments: { clear: true } },
    },
    { client: client(), session },
  );
  assert.match(cleared.error?.message ?? "", /cannot be cleared/);
  const preset = handleMessage(
    {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "simulate", arguments: { preset: "pro", market: "BTC" } },
    },
    { client: client(), session },
  );
  assert.match(preset.error?.message ?? "", /owner config/);
  const blocked = callWith(session, "simulate", {
    market: "BTC",
    decision: { barIndex: 0, side: "long", size: "0.01", stop: null, target: null },
    bars: [
      { open: "100", high: "100", low: "100", close: "100" },
      { open: "100", high: "100", low: "100", close: "100" },
    ],
    book: { bids: [{ px: "100", sz: "10" }], asks: [{ px: "100", sz: "10" }] },
  });
  assert.equal(blocked.error, "GUARD_BLOCKED:KILL_SWITCH");
});

function callWith(session: GuardSession, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const response = handleMessage(
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } },
    { client: client(), session },
  );
  const result = response.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}
