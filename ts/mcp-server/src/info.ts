/** Public info endpoint client. POST types are an allowlist. No order endpoint. */

import { TokenBucket } from "./rateLimit.ts";

export const INFO_URL = "https://api.hyperliquid.xyz/info";
export const READ_TYPES = [
  "meta",
  "metaAndAssetCtxs",
  "l2Book",
  "candleSnapshot",
  "clearinghouseState",
  "userFees",
  "fundingHistory",
] as const;

export type ReadType = (typeof READ_TYPES)[number];
export type Transport = (url: string, body: Readonly<Record<string, unknown>>) => unknown;

export function assertInfoUrl(url: string): void {
  if (!url.endsWith("/info") || url.includes("/exchange")) {
    throw new Error("info url must be the public /info endpoint");
  }
}

function isReadType(value: unknown): value is ReadType {
  return READ_TYPES.some((kind) => kind === value);
}

export class InfoClient {
  readonly limiter: TokenBucket;
  readonly url: string;
  private readonly transport: Transport;

  constructor(transport: Transport, limiter?: TokenBucket, url = INFO_URL) {
    assertInfoUrl(url);
    this.transport = transport;
    this.limiter = limiter ?? new TokenBucket();
    this.url = url;
  }

  post(body: Readonly<Record<string, unknown>>): unknown {
    if (!isReadType(body.type)) {
      throw new Error("info type is not allowed");
    }
    assertInfoUrl(this.url);
    this.limiter.acquire();
    return this.transport(this.url, body);
  }
}

export interface FetchLike {
  (url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{
    json(): Promise<unknown>;
  }>;
}

export function fetchInfoTransport(fetchImpl: FetchLike): (url: string, body: Readonly<Record<string, unknown>>) => Promise<unknown> {
  return async (url, body) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.json();
  };
}
