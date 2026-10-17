# PERPBRAIN MCP — install guide for AI coding assistants

This document is written so an AI coding assistant (for example Cline) can install and wire up the PERPBRAIN MCP server using only this file and [README.md](README.md). No API keys, wallets, or other secrets are required.

## What you are installing

- A **stdio** MCP server (`perpbrain-mcp`) that exposes **12 read and simulation tools** only.
- Live market data comes from the **public** Hyperliquid `/info` endpoint (keyless).
- Simulation output is labelled `SIMULATED`. Receipt checks are **verified and reproducible**.
- Owner limits are **limits you set; losses are still possible**. There is no mainnet order path.

## Prerequisites

1. **Node.js 22 or newer** (`node --version` must be ≥ 22).
2. **git** and **npm**.
3. Network access to `https://github.com` and Hyperliquid public info hosts.

Do **not** ask the user for exchange keys, seed phrases, or private API tokens. Nothing in this setup needs them.

## Step 1 — Clone the repository

```bash
git clone https://github.com/PERPBRAIN/perpbrain-sdk.git
```

Choose an install directory; below we call it `REPO_ROOT` (the folder that contains `bin/`, `ts/`, and `README.md`).

```bash
cd REPO_ROOT
```

## Step 2 — Install MCP server dependencies

Only the MCP package needs `npm ci` for day-to-day MCP use:

```bash
cd ts/mcp-server
npm ci
cd ../..
```

Confirm `ts/mcp-server/node_modules` exists.

## Step 3 — Smoke-test the server (optional but recommended)

From `REPO_ROOT`:

```bash
node bin/perpbrain-mcp.mjs
```

The process should stay running and read JSON-RPC from stdin. For a quick manual check, send one line (then Ctrl+C):

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"install-check","version":"0"}}}
```

You should get a JSON response on stdout. Do not paste secrets into the process.

## Step 4 — Note optional environment

| Variable | Values | Required |
| --- | --- | --- |
| `PERPBRAIN_HL_NETWORK` | `mainnet` (default) or `testnet` | No |

Only public `/info` traffic is used. No secret values.

## Step 5 — Register in the user’s MCP client

Use **absolute paths** on the user’s machine. Replace `REPO_ROOT` below.

### Claude Desktop

Edit the Claude Desktop MCP config (platform-specific path). Add:

```json
{
  "mcpServers": {
    "perpbrain": {
      "command": "node",
      "args": ["REPO_ROOT/bin/perpbrain-mcp.mjs"],
      "env": {
        "PERPBRAIN_HL_NETWORK": "mainnet"
      }
    }
  }
}
```

### Cursor

In Cursor **Settings → MCP**, add the same block under `mcpServers` (stdio transport).

Restart the editor after saving.

### Cline

Open Cline's **MCP Servers → Installed → Configure MCP Servers** (this edits `cline_mcp_settings.json`) and add:

```json
{
  "mcpServers": {
    "perpbrain": {
      "command": "node",
      "args": ["REPO_ROOT/bin/perpbrain-mcp.mjs"],
      "env": {
        "PERPBRAIN_HL_NETWORK": "mainnet"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

The path must be absolute; the server works from any working directory. On Windows use forward slashes or escaped backslashes in the path. Cline reloads the server when the file is saved.

## Step 6 — Verify tools in the client

After the server connects, the client should list **exactly these 12 tools** (names only):

1. `markets`
2. `order_book`
3. `funding`
4. `positions`
5. `fees`
6. `simulate`
7. `funding_extremes`
8. `book_imbalance`
9. `get_limits`
10. `trigger_kill_switch`
11. `get_cost_breakdown`
12. `verify_receipt`

If the list differs, confirm `npm ci` was run in `ts/mcp-server` and that `args` points to `REPO_ROOT/bin/perpbrain-mcp.mjs`.

## Step 7 — Safe usage reminders for the assistant

- Never call or emulate `submit_order`, `order`, or `submit-order`; they are refused by design.
- Treat simulation and cost breakdown results as `SIMULATED`, not live execution.
- Do not store or request the user’s exchange credentials in env files, prompts, or repo commits.

## SDK build (only if the user edits `sdk/`)

MCP-only installs do **not** need this. If the user develops the SDK package:

```bash
cd sdk && npm ci && npm run build
```

## Registry metadata

`server.json` at the repository root describes the MCP Registry entry `io.github.PERPBRAIN/perpbrain-sdk`. Logo assets for registry listings are described in [docs/assets.md](docs/assets.md).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `Cannot find module` under `ts/mcp-server` | Run `npm ci` inside `ts/mcp-server`. |
| Node version error | Install Node 22+. |
| Server exits immediately | Run from `REPO_ROOT`; use `node bin/perpbrain-mcp.mjs`, not a relative path from another cwd without adjusting paths. |
| Empty or stale market data | Confirm network; try `PERPBRAIN_HL_NETWORK=testnet` if the user works on testnet. |

## Reference

- Human-oriented overview: [README.md](README.md)
- Owner limits detail: [docs/guards.md](docs/guards.md)
- Receipt verification: [docs/verify.md](docs/verify.md)
