/** Websocket frames plus the order-book stream. Tests inject the socket and transport. */

import { createHash, randomBytes } from "node:crypto";

import { TokenBucket } from "./rateLimit.ts";
import { MAX_BOOK_LEVELS, STALE_AFTER_MS, makeAge, parseL2Levels, type BookResult } from "./queries.ts";

export const WS_URL = "wss://api.hyperliquid.xyz/ws";
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface SocketLike {
  send(data: Buffer): void;
  recv(size: number): Buffer;
  close(): void;
}

export function acceptValue(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

export function encodeClientFrame(opcode: number, payload: Buffer, mask: Buffer): Buffer {
  if (mask.length !== 4) {
    throw new Error("mask must be 4 bytes");
  }
  if (opcode < 0 || opcode > 15) {
    throw new Error("opcode is out of range");
  }
  const header = [0x80 | opcode];
  if (payload.length < 126) {
    header.push(0x80 | payload.length);
  } else if (payload.length < 65536) {
    header.push(0x80 | 126, payload.length >> 8, payload.length & 0xff);
  } else {
    header.push(0x80 | 127);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(payload.length));
    header.push(...length);
  }
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
  return Buffer.concat([Buffer.from(header), mask, masked]);
}

export function decodeServerFrame(buf: Buffer): { opcode: number; payload: Buffer; consumed: number } | null {
  if (buf.length < 2) {
    return null;
  }
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let length = buf[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buf.length < 4) {
      return null;
    }
    length = buf.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buf.length < 10) {
      return null;
    }
    length = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  if (masked) {
    throw new Error("masked server frame");
  }
  const end = offset + length;
  if (buf.length < end) {
    return null;
  }
  return { opcode, payload: buf.subarray(offset, end), consumed: end };
}

export function handshakeRequest(host: string, path: string, key: string): Buffer {
  return Buffer.from(
    [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"),
    "ascii",
  );
}

export function checkHandshakeResponse(raw: Buffer, key: string): void {
  const text = raw.toString("ascii");
  const status = text.split("\r\n", 1)[0] ?? "";
  if (!` ${status} `.includes(" 101 ")) {
    throw new Error("websocket upgrade rejected");
  }
  const expected = acceptValue(key);
  for (const line of text.split("\r\n")) {
    const splitAt = line.indexOf(":");
    if (splitAt < 0) {
      continue;
    }
    const name = line.slice(0, splitAt).trim().toLowerCase();
    if (name === "sec-websocket-accept") {
      if (line.slice(splitAt + 1).trim() === expected) {
        return;
      }
      throw new Error("websocket accept mismatch");
    }
  }
  throw new Error("websocket accept mismatch");
}

export function parseWsUrl(url: string): { host: string; port: number; path: string; useTls: boolean } {
  if (url.includes("/exchange")) {
    throw new Error("websocket url must not be the exchange endpoint");
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") {
    throw new Error("websocket url required");
  }
  const useTls = parsed.protocol === "wss:";
  const port = parsed.port === "" ? (useTls ? 443 : 80) : Number(parsed.port);
  const path = `${parsed.pathname}${parsed.search}`;
  return { host: parsed.hostname, port, path, useTls };
}

export class FrameBuffer {
  private buf = Buffer.alloc(0);

  feed(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
  }

  pop(): { opcode: number; payload: Buffer } | null {
    const decoded = decodeServerFrame(this.buf);
    if (decoded === null) {
      return null;
    }
    this.buf = this.buf.subarray(decoded.consumed);
    return { opcode: decoded.opcode, payload: decoded.payload };
  }
}

export class SocketWs {
  private readonly frames = new FrameBuffer();
  private readonly sock: SocketLike;
  private readonly maskFactory: () => Buffer;
  private readonly onSend: () => void;

  constructor(sock: SocketLike, maskFactory: () => Buffer, onSend: () => void = () => undefined) {
    this.sock = sock;
    this.maskFactory = maskFactory;
    this.onSend = onSend;
  }

  sendText(text: string): void {
    this.send(0x1, Buffer.from(text, "utf8"));
  }

  recvText(): string {
    for (;;) {
      const popped = this.frames.pop();
      if (popped === null) {
        const chunk = this.sock.recv(4096);
        if (chunk.length === 0) {
          throw new Error("socket closed");
        }
        this.frames.feed(chunk);
        continue;
      }
      if (popped.opcode === 0x1) {
        return popped.payload.toString("utf8");
      }
      if (popped.opcode === 0x8) {
        throw new Error("websocket closed");
      }
      if (popped.opcode === 0x9) {
        this.send(0xa, popped.payload);
        continue;
      }
      if (popped.opcode === 0xa) {
        continue;
      }
      throw new Error(`unsupported opcode ${popped.opcode}`);
    }
  }

  close(): void {
    this.sock.close();
  }

  prime(chunk: Buffer): void {
    if (chunk.length > 0) {
      this.frames.feed(chunk);
    }
  }

  private send(opcode: number, payload: Buffer): void {
    this.onSend();
    this.sock.send(encodeClientFrame(opcode, payload, this.maskFactory()));
  }
}

function readHeaders(sock: SocketLike): { headers: Buffer; leftover: Buffer } {
  let buf = Buffer.alloc(0);
  while (!buf.includes("\r\n\r\n")) {
    const chunk = sock.recv(4096);
    if (chunk.length === 0) {
      throw new Error("socket closed during handshake");
    }
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > 65536) {
      throw new Error("handshake response is too large");
    }
  }
  const end = buf.indexOf("\r\n\r\n") + 4;
  return { headers: buf.subarray(0, end), leftover: buf.subarray(end) };
}

export function openWebsocket(
  url = WS_URL,
  options: {
    socketFactory?: (host: string, port: number, useTls: boolean) => SocketLike;
    key?: string;
    maskFactory?: () => Buffer;
    onSend?: () => void;
  } = {},
): SocketWs {
  const { host, port, path, useTls } = parseWsUrl(url);
  const factory = options.socketFactory;
  if (factory === undefined) {
    throw new Error("socket factory is required");
  }
  const sock = factory(host, port, useTls);
  const key = options.key ?? randomBytes(16).toString("base64");
  sock.send(handshakeRequest(host, path, key));
  const { headers, leftover } = readHeaders(sock);
  checkHandshakeResponse(headers, key);
  const session = new SocketWs(sock, options.maskFactory ?? (() => randomBytes(4)), options.onSend);
  session.prime(leftover);
  return session;
}

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "error",
    handler: (event: { data: unknown }) => void,
  ): void;
}

export function fromWebSocket(url: string, factory: (target: string) => WebSocketLike): TextTransport {
  let socket: WebSocketLike | null = null;
  const queue: string[] = [];
  let opened = false;
  return {
    connect() {
      socket = factory(url);
      socket.addEventListener("open", () => {
        opened = true;
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          queue.push(event.data);
        }
      });
    },
    send(text: string) {
      if (socket === null) {
        throw new Error("websocket is not connected");
      }
      socket.send(text);
    },
    recv() {
      if (!opened) {
        return null;
      }
      return queue.shift() ?? null;
    },
    close() {
      socket?.close();
    },
  };
}

export interface TextTransport {
  connect(): void;
  send(text: string): void;
  recv(): string | null;
  close(): void;
}

type ChannelKind = "l2Book" | "subscriptionResponse" | "pong" | "ping" | "other";

function channelKind(channel: unknown, method: unknown): ChannelKind {
  if (channel === "l2Book") {
    return "l2Book";
  }
  if (channel === "subscriptionResponse" || channel === "pong" || channel === "ping") {
    return channel;
  }
  if (method === "ping") {
    return "ping";
  }
  return "other";
}

export class BookStream {
  private readonly depth: number;
  private readonly coin: string;
  private readonly transport: TextTransport;
  private readonly limiter: TokenBucket;
  private readonly clockMs: () => number;
  private bids: BookResult["bids"] = [];
  private asks: BookResult["asks"] = [];
  private asOfMs: number | null = null;
  private silenceAnchor: number | null = null;
  private started = false;
  reconnects = 0;

  constructor(
    coin: string,
    transport: TextTransport,
    limiter: TokenBucket,
    clockMs: () => number,
    depth = MAX_BOOK_LEVELS,
  ) {
    if (coin === "") {
      throw new Error("market is required");
    }
    if (depth < 1) {
      throw new Error("depth must be at least 1");
    }
    this.coin = coin;
    this.transport = transport;
    this.limiter = limiter;
    this.clockMs = clockMs;
    this.depth = Math.min(depth, MAX_BOOK_LEVELS);
  }

  start(): void {
    this.transport.connect();
    this.send(JSON.stringify({ method: "subscribe", subscription: { type: "l2Book", coin: this.coin } }));
    this.silenceAnchor = this.clockMs();
    this.started = true;
  }

  poll(): BookResult | null {
    if (!this.started || this.silenceAnchor === null) {
      throw new Error("stream is not started");
    }
    for (;;) {
      const frame = this.transport.recv();
      if (frame === null) {
        break;
      }
      this.handle(frame);
    }
    if (this.clockMs() - this.silenceAnchor >= STALE_AFTER_MS) {
      this.reconnect();
    }
    return this.view();
  }

  view(): BookResult | null {
    if (this.asOfMs === null) {
      return null;
    }
    return {
      coin: this.coin,
      bids: [...this.bids],
      asks: [...this.asks],
      ...makeAge(this.asOfMs, this.clockMs()),
    };
  }

  private reconnect(): void {
    this.transport.close();
    this.transport.connect();
    this.send(JSON.stringify({ method: "subscribe", subscription: { type: "l2Book", coin: this.coin } }));
    this.silenceAnchor = this.clockMs();
    this.reconnects += 1;
  }

  private handle(frame: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame) as unknown;
    } catch {
      throw new Error("websocket message must be json");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("websocket message must be an object");
    }
    const body = parsed as Record<string, unknown>;
    const kind = channelKind(body.channel, body.method);
    switch (kind) {
      case "l2Book":
        this.applyBook(body.data);
        return;
      case "subscriptionResponse":
      case "pong":
      case "other":
        return;
      case "ping":
        this.send('{"method":"pong"}');
        return;
      default: {
        const unexpected: never = kind;
        throw new Error(`unexpected channel ${String(unexpected)}`);
      }
    }
  }

  private applyBook(data: unknown): void {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error("l2 book must be an object");
    }
    const body = data as Record<string, unknown>;
    if (body.coin !== this.coin) {
      return;
    }
    if (typeof body.time !== "number" || !Number.isInteger(body.time)) {
      throw new Error("l2 book is missing time");
    }
    const levels = parseL2Levels(body.levels, this.depth);
    this.bids = levels.bids;
    this.asks = levels.asks;
    this.asOfMs = body.time;
    this.silenceAnchor = this.clockMs();
  }

  private send(text: string): void {
    this.limiter.acquire();
    this.transport.send(text);
  }
}
