import assert from "node:assert/strict";
import { test } from "node:test";

import { distributionName, rejectOrderCommand, run, simulate } from "./index.ts";

test("npm distribution name is perpbrain", () => {
  assert.equal(distributionName(), "perpbrain");
});

test("simulate is labelled and has no performance claim", () => {
  const result = simulate("BTC");
  assert.equal(result.label, "SIMULATED");
  assert.deepEqual(result.fills, []);
  assert.equal(result.fillSource, "exchange");
  assert.equal("pnl" in result, false);
});

test("simulate requires a market", () => {
  assert.throws(() => simulate(""), /market is required/);
});

test("order commands are refused", () => {
  assert.throws(() => rejectOrderCommand("submit_order"), /no mainnet order path/);
  assert.throws(() => run("order"), /no mainnet order path/);
});

test("launcher lists read and sim tools", () => {
  const tools = run("tools");
  assert.match(tools, /funding/);
  assert.match(tools, /simulate/);
  assert.equal(tools.includes("submit_order"), false);
  assert.equal(run("simulate"), "SIMULATED");
});

test("unknown commands fail", () => {
  assert.throws(() => run("nope"), /unknown command/);
});
