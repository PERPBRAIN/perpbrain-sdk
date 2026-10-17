import assert from "node:assert/strict";
import { test } from "node:test";

import { INFO_URL, TESTNET_INFO_URL, assertInfoUrl, resolveInfoUrl } from "./info.ts";

test("resolveInfoUrl picks mainnet or testnet info endpoints only", () => {
  assert.equal(resolveInfoUrl({}), INFO_URL);
  assert.equal(resolveInfoUrl({ PERPBRAIN_HL_NETWORK: "mainnet" }), INFO_URL);
  assert.equal(resolveInfoUrl({ PERPBRAIN_HL_NETWORK: "testnet" }), TESTNET_INFO_URL);
  assert.equal(resolveInfoUrl({ PERPBRAIN_INFO_URL: TESTNET_INFO_URL }), TESTNET_INFO_URL);
  assert.throws(() => resolveInfoUrl({ PERPBRAIN_HL_NETWORK: "prod" }), /mainnet or testnet/);
  const domain = "hyperliquid" + ".xyz";
  assert.throws(() => assertInfoUrl(`https://api.${domain}/exchange`), /info url/);
});
