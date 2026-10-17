/** Stdio MCP server using the official SDK. Read and simulation tools only. */

import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { GuardSession } from "../../../sdk/src/guards.ts";
import { READ_SIM_TOOLS } from "./index.ts";
import { fetchInfoTransport, InfoClient, resolveInfoUrl, type FetchLike } from "./info.ts";
import { DESCRIPTIONS, handleMessage } from "./mcp.ts";
import { TokenBucket } from "./rateLimit.ts";

export interface ServeOptions {
  client?: InfoClient;
  session?: GuardSession;
  nowMs?: () => number;
}

export function createLiveClient(fetchImpl?: FetchLike): InfoClient {
  const transport = fetchInfoTransport(
    fetchImpl ??
      (async (url, init) => {
        const response = await globalThis.fetch(url, init);
        return { json: () => response.json() as Promise<unknown> };
      }),
  );
  return new InfoClient(transport, new TokenBucket(), resolveInfoUrl());
}

export function createMcpServer(options: ServeOptions = {}): McpServer {
  const session = options.session ?? GuardSession.fromConfig();
  const client = options.client ?? createLiveClient();
  const nowMs = options.nowMs ?? (() => Date.now());

  const server = new McpServer(
    { name: "perpbrain", version: "0.1.0-rc1" },
    { capabilities: { tools: {} } },
  );

  for (const name of READ_SIM_TOOLS) {
    server.registerTool(
      name,
      {
        description: DESCRIPTIONS[name],
        inputSchema: z.object({}).passthrough(),
      },
      async (args) => {
        const response = await handleMessage(
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          },
          { client, session, nowMs: nowMs() },
        );
        if (response.error !== undefined) {
          return {
            content: [{ type: "text", text: response.error.message }],
            isError: true,
          };
        }
        const result = response.result as { content: Array<{ type: "text"; text: string }>; isError: boolean };
        return {
          content: result.content,
          isError: result.isError,
        };
      },
    );
  }

  return server;
}

export async function serveStdio(options: ServeOptions = {}): Promise<void> {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  serveStdio().catch((caught) => {
    const message = caught instanceof Error ? caught.message : "mcp server failed";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
