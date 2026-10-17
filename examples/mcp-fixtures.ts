/**
 * Drive the MCP JSON-RPC handler with recorded public data. No network, no keys.
 *
 *   node --experimental-strip-types examples/mcp-fixtures.ts
 *
 * The server lists read and simulation tools only. An order tool is refused.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { InfoClient } from "../ts/mcp-server/src/info.ts";
import { handleMessage } from "../ts/mcp-server/src/mcp.ts";
import { TokenBucket } from "../ts/mcp-server/src/rateLimit.ts";

const FIXTURES = "fixtures/info";
const FILES: Record<string, string> = {
  meta: "meta.json",
  metaAndAssetCtxs: "asset_ctxs.json",
  l2Book: "l2_book_btc.json",
  fundingHistory: "funding_history_btc.json",
  userFees: "user_fees.json",
  clearinghouseState: "clearinghouse_empty.json",
};

const client = new InfoClient((_url, body) => {
  const file = FILES[String(body.type)];
  if (file === undefined) {
    throw new Error(`no fixture for ${String(body.type)}`);
  }
  return JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as unknown;
}, new TokenBucket());

async function rpc(id: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return handleMessage({ jsonrpc: "2.0", id, method, params }, { client, nowMs: 50 });
}

const listed = (await rpc(1, "tools/list")) as { result: { tools: Array<{ name: string }> } };
process.stdout.write(`${JSON.stringify({ tools: listed.result.tools.map((tool) => tool.name) })}\n`);
process.stdout.write(`${JSON.stringify(await rpc(2, "tools/call", { name: "funding", arguments: { coin: "ETH" } }))}\n`);
process.stdout.write(`${JSON.stringify(await rpc(3, "tools/call", { name: "submit_order", arguments: {} }))}\n`);
