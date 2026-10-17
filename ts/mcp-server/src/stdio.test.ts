import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { READ_SIM_TOOLS } from "./index.ts";
import { fetchInfoTransport, INFO_URL, InfoClient } from "./info.ts";
import { TokenBucket } from "./rateLimit.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "info");

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as unknown;
}

function fixtureClient(): InfoClient {
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

test("createLiveClient uses async fetch against the public info endpoint", async () => {
  let seen = "";
  const client = new InfoClient(
    fetchInfoTransport(async (url, init) => {
      seen = `${url} ${init.method}`;
      return { json: async () => ({ ok: true }) };
    }),
    new TokenBucket(),
    INFO_URL,
  );
  assert.equal(client.url, INFO_URL);
  assert.deepEqual(await client.post({ type: "meta" }), { ok: true });
  assert.equal(seen.startsWith(`${INFO_URL} POST`), true);
});

test("stdio entry shares the read and sim tool list", () => {
  const names = READ_SIM_TOOLS as readonly string[];
  assert.equal(names.includes("verify_receipt"), true);
  assert.equal(names.includes("get_limits"), true);
  assert.equal(names.includes("order"), false);
  assert.equal(names.includes("submit_order"), false);
  assert.ok(fixtureClient());
});
