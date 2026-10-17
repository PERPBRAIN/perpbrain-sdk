# PERPBRAIN SDK

[![PERPBRAIN/perpbrain-sdk MCP server](https://glama.ai/mcp/servers/PERPBRAIN/perpbrain-sdk/badges/score.svg)](https://glama.ai/mcp/servers/PERPBRAIN/perpbrain-sdk)

TypeScript SDK, MCP handler, examples, and receipt verifier for [PERPBRAIN](https://perpbrain.com): read-only Hyperliquid data, a book simulator, and owner limits for AI agents. Simulation receipts are verified and reproducible: anyone can re-derive a receipt from its inputs and get the same hashes.

This repository has no mainnet order path, no exchange keys, and no publish workflow. Simulation output is labelled `SIMULATED`. It is not advice.

The PERPBRAIN hosted service and engine are not in this repository. This repository is the public client surface.

## What is here

| Path | Role |
| --- | --- |
| `sdk/` | `@perpbrain/sdk`: public info-endpoint reads, the book simulator, owner limits (`conservative`, `standard`, `pro`), the kill-switch latch, execution-cost breakdown, receipt verifier, and the SVG results card. |
| `ts/mcp-server/` | MCP JSON-RPC handler and stdio MCP server (`perpbrain-mcp`) for the read and simulation tools. It does not accept an order tool. |
| `server.json` | MCP Registry metadata for `io.github.PERPBRAIN/perpbrain-sdk` (npm, stdio, no secrets). Optional logo path: [docs/assets.md](docs/assets.md). |
| `glama.json` | Glama listing maintainer file (claim ownership of the [Glama listing](https://glama.ai/mcp/servers/PERPBRAIN/perpbrain-sdk)). |
| `Dockerfile` | Slim Node image for Glama and other hosts; stdio entrypoint, non-root user. |
| `examples/` | Runnable TypeScript examples on recorded public data. |
| `verify/web/` | Browser receipt checker (WebCrypto SHA-256), the same check as the PERPBRAIN verify page. |
| `fixtures/` | Recorded public info responses and good and tampered receipt fixtures. No keys, no accounts. |

## Requirements

**Node 22+** is required (check with `node -v`). On Node 20 or older the examples and tests stop with `node: bad option: --experimental-strip-types`; upgrade Node to fix it. On Node 22 a harmless `ExperimentalWarning: Type Stripping` line is printed. No API key or other secret is needed for anything in this repository.

## Install the MCP server

From a fresh clone:

```bash
git clone https://github.com/PERPBRAIN/perpbrain-sdk.git
cd perpbrain-sdk/ts/mcp-server && npm ci
cd ../..
node bin/perpbrain-mcp.mjs
```

To smoke-test it, pipe an `initialize` request followed by `tools/list` into the launcher; it should list the 12 tools below.

The launcher starts the stdio MCP server. Live reads use the public Hyperliquid `/info` endpoint (mainnet by default). Optional: set `PERPBRAIN_HL_NETWORK=testnet` for testnet.

Equivalent from the repository root after `npm ci` in `ts/mcp-server/`:

```bash
node bin/perpbrain-sdk.mjs mcp
```

To work on the TypeScript SDK itself (not required for MCP-only use):

```bash
(cd sdk && npm ci && npm run build)
```

`@perpbrain/sdk` is `0.1.0-rc1` and marked `private` in `package.json`, so it is not on npm yet. `npm run build` writes ESM and CommonJS builds to `sdk/dist`.

## Examples

Each example runs offline on the files in `fixtures/`.

Check a receipt. `VERIFIED` means every hash re-derived from the inputs matches. A tampered fixture prints `MISMATCH` and names the field.

```bash
node --experimental-strip-types examples/verify-receipt.ts fixtures/receipts/good
node --experimental-strip-types examples/verify-receipt.ts fixtures/receipts/tampered-result
```

Simulate under the Standard preset, then see a looser leverage blocked before a fill is recorded:

```bash
node --experimental-strip-types examples/guarded-simulate.ts
```

Drive the MCP handler with recorded public data. The tool list is read and simulation only, and `submit_order` is refused:

```bash
node --experimental-strip-types examples/mcp-fixtures.ts
```

## MCP server (stdio)

The standalone MCP server uses the official `@modelcontextprotocol/sdk` over stdio. It is keyless: live reads use the public Hyperliquid `/info` endpoint only. Simulation uses the vendored book simulator. `submit_order` and other order tools are refused.

Simulation receipts are **verified and reproducible**. Owner limits are **limits you set; losses are still possible**.

Registry metadata lives in `server.json` (`io.github.PERPBRAIN/perpbrain-sdk`). For a step-by-step guide aimed at AI coding assistants (for example Cline), see [llms-install.md](llms-install.md).

### MCP tools (12)

Registered tool names, in list order:

| Tool | Purpose |
| --- | --- |
| `markets` | List perpetual markets from the public info endpoint. |
| `order_book` | Read a capped order book and its data age. |
| `funding` | Read funding, mark, and open interest for one coin. |
| `positions` | Read positions for one address. |
| `fees` | Read the address fee rates and their data age. |
| `simulate` | Simulate a closed-bar decision on a supplied book. Result is SIMULATED. |
| `funding_extremes` | Z-score of the public hourly funding rate against a trailing window. |
| `book_imbalance` | Bid depth divided by ask depth inside a public-book band. |
| `get_limits` | Read the owner limits and the remaining headroom. |
| `trigger_kill_switch` | Latch the kill switch. A tool call cannot clear it. |
| `get_cost_breakdown` | Recompute the execution-cost breakdown from a simulation receipt. The result is SIMULATED. |
| `verify_receipt` | Check a simulation receipt against manifest and inputs bytes. The check is verified and reproducible. |

### Claude Desktop

Add a server block (no API keys). Use absolute paths on your machine:

```json
{
  "mcpServers": {
    "perpbrain": {
      "command": "node",
      "args": ["/absolute/path/to/perpbrain-sdk/bin/perpbrain-mcp.mjs"],
      "env": {
        "PERPBRAIN_HL_NETWORK": "mainnet"
      }
    }
  }
}
```

### Cursor

In **Cursor Settings → MCP**, add a server with the same shape (stdio, no secrets):

```json
{
  "mcpServers": {
    "perpbrain": {
      "command": "node",
      "args": ["/absolute/path/to/perpbrain-sdk/bin/perpbrain-mcp.mjs"],
      "env": {
        "PERPBRAIN_HL_NETWORK": "mainnet"
      }
    }
  }
}
```

Replace `/absolute/path/to/perpbrain-sdk` with your clone path. Run `cd ts/mcp-server && npm ci` once before first use.

## Receipt checker (browser)

Serve `verify/web/` with any static server and drop the three receipt files on the page.

## Using the SDK

```ts
import { GuardSession, guardedSimulate, verifyReceipt } from "@perpbrain/sdk";

const session = GuardSession.fromConfig("standard");
// guardedSimulate(...) records a fill only after the owner limits accept it.
// verifyReceipt(receipt, manifestBytes, inputsBytes) returns { status: "VERIFIED" | "MISMATCH", mismatches }.
```

The read client only talks to the public `/info` endpoint, with an allowlist of request types. It refuses `/exchange`.

## Owner limits

These are limits you set; losses are still possible. The owner picks a preset when a session starts. Standard is the default. Inside a session a caller can tighten a limit. A looser value is rejected. An MCP tool cannot set, raise, or clear a limit. Reducing or closing a position is never blocked. Details are in [docs/guards.md](docs/guards.md).

| Limit | Conservative | Standard (default) | Pro |
| --- | --- | --- | --- |
| Max leverage, before the per-coin rule | 3x | 5x | 10x |
| Per-order cap | Lesser of $10k and 20% of depth | Lesser of $25k and 20% of depth | Lesser of $250k and 20% of depth |
| Daily stop | 3% | 5% | 10% |
| Open positions | 3 | 5 | 15 |
| Max slippage | 25 bps | 50 bps | 100 bps |
| Order rate | 2/s | 5/s | 10/s |

Custom limits are capped at a 25% daily stop, 300 bps slippage, and 50 open positions.

Do not put exchange keys, wallets, or seed phrases in the environment, the repository, or a prompt. Nothing here reads them.

## Checks

```bash
(cd ts/mcp-server && npm run lint && npm run typecheck && npm test)
(cd sdk && npm run typecheck && npm run build)
ts/mcp-server/node_modules/.bin/tsc -p examples/tsconfig.json
```

CI runs the same checks plus a pinned gitleaks scan. CI uses no secrets.

## Security and contributing

Report a vulnerability as described in [SECURITY.md](SECURITY.md). Contribution rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).

Simulation only. Not advice. No live trading.
