import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { INFO_URL, InfoClient, assertInfoUrl, fetchInfoTransport } from "./info.ts";
import { RATE_PER_SEC, BURST, TokenBucket } from "./rateLimit.ts";
import { fees, fractionToBps, funding, markets, orderBook, positions } from "./queries.ts";
import {
  WS_URL,
  BookStream,
  SocketWs,
  acceptValue,
  checkHandshakeResponse,
  decodeServerFrame,
  encodeClientFrame,
  fromWebSocket,
  handshakeRequest,
  openWebsocket,
  parseWsUrl,
  type SocketLike,
  type TextTransport,
} from "./wsClient.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "info");
const BOOK_TIME = 1792159472349;
const EMPTY = `0x${"00".repeat(20)}`;
const SAMPLE_KEY = Buffer.from("the sample nonce").toString("base64");
const SAMPLE_ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as unknown;
}

class ManualClock {
  now = 0;
  slept: number[] = [];

  clock = (): number => this.now;

  sleep = (durationMs: number): void => {
    this.slept.push(durationMs);
    this.now += durationMs;
  };
}

function fixtureClient(): InfoClient {
  return new InfoClient((url, body) => {
    assert.equal(url, INFO_URL);
    const kind = body.type;
    if (kind === "meta") return load("meta.json");
    if (kind === "metaAndAssetCtxs") return load("asset_ctxs.json");
    if (kind === "l2Book") return load("l2_book_btc.json");
    if (kind === "userFees") return load("user_fees.json");
    if (kind === "clearinghouseState") return load("clearinghouse_empty.json");
    throw new Error(`unexpected ${String(kind)}`);
  }, new TokenBucket());
}

test("burst is free and the next call waits one token", () => {
  assert.equal(RATE_PER_SEC, 8);
  assert.equal(BURST, 10);
  const clock = new ManualClock();
  const bucket = new TokenBucket(RATE_PER_SEC, BURST, clock.clock, clock.sleep);
  for (let index = 0; index < 10; index += 1) {
    assert.equal(bucket.acquire(), 0);
  }
  assert.equal(bucket.acquire(), 125);
  assert.deepEqual(clock.slept, [125]);
  const refill = new ManualClock();
  const refilled = new TokenBucket(RATE_PER_SEC, BURST, refill.clock, refill.sleep);
  for (let index = 0; index < 10; index += 1) {
    refilled.acquire();
  }
  refill.now = 1000;
  for (let index = 0; index < 8; index += 1) {
    assert.equal(refilled.acquire(), 0);
  }
  assert.throws(() => bucket.acquire(0), /token count/);
  assert.throws(() => new TokenBucket(0, 1, clock.clock, clock.sleep), /positive/);
});

test("recorded reads carry data age and the published base fees", () => {
  const info = fixtureClient();
  const listed = markets(info, 50, 40);
  assert.deepEqual(
    listed.markets.map((row) => row.name),
    ["BTC", "ETH"],
  );
  assert.equal(listed.markets[0]?.szDecimals, 5);
  assert.equal(listed.ageMs, 10);
  assert.equal(listed.stale, false);
  const book = orderBook(info, "BTC", BOOK_TIME + 1000, 2);
  assert.equal(book.ageMs, 1000);
  assert.equal(book.stale, false);
  assert.equal(book.asOfMs, BOOK_TIME);
  assert.equal(book.bids[0]?.px, "81944.0");
  assert.equal(book.bids.length, 2);
  const stale = orderBook(info, "BTC", BOOK_TIME + 20_000);
  assert.equal(stale.stale, true);
  const eth = funding(info, "ETH", 80);
  assert.equal(eth.funding, "0.0000125");
  assert.equal(eth.markPx, "2457.2");
  assert.equal(eth.openInterest, "1088724.0126");
  const quoted = fees(info, EMPTY, 500, 100);
  assert.equal(quoted.takerBps, "4.5");
  assert.equal(quoted.makerBps, "1.5");
  assert.equal(fractionToBps("0.00045"), "4.5");
  assert.equal(quoted.ageMs, 400);
  const held = positions(info, EMPTY, BOOK_TIME);
  assert.deepEqual(held.positions, []);
  assert.equal(held.asOfMs, 1792159472954);
  assert.equal(INFO_URL.endsWith("/info"), true);
  assert.equal(INFO_URL.includes("/exchange"), false);
  const domain = "hyperliquid" + ".xyz";
  assert.throws(() => assertInfoUrl(`https://api.${domain}/exchange`), /info url/);
  assert.throws(() => info.post({ type: "order" }), /not allowed/);
  assert.throws(() => orderBook(info, "", 1), /market/);
  assert.throws(() => funding(info, "SOL", 1), /universe/);
});

test("fetch transport posts json through the injected fetch", async () => {
  let seen = "";
  const transport = fetchInfoTransport(async (url, init) => {
    seen = `${url} ${init.method} ${init.body}`;
    return { json: () => Promise.resolve({ ok: true }) };
  });
  assert.deepEqual(await transport(INFO_URL, { type: "meta" }), { ok: true });
  assert.equal(seen, `${INFO_URL} POST {"type":"meta"}`);
});

class Scripted implements TextTransport {
  frames: Array<string | null> = [];
  sent: string[] = [];
  connects = 0;
  closes = 0;

  connect(): void {
    this.connects += 1;
  }

  send(text: string): void {
    this.sent.push(text);
  }

  recv(): string | null {
    return this.frames.shift() ?? null;
  }

  close(): void {
    this.closes += 1;
  }
}

function bookFrame(timeMs: number, count = 2): string {
  const bids = Array.from({ length: count }, (_, index) => ({ px: String(100 - index), sz: "1", n: 1 }));
  const asks = Array.from({ length: count }, (_, index) => ({ px: String(101 + index), sz: "1", n: 1 }));
  return JSON.stringify({ channel: "l2Book", data: { coin: "BTC", time: timeMs, levels: [bids, asks] } });
}

test("websocket age follows the last real book and silence reconnects", () => {
  const clock = new ManualClock();
  clock.now = 1_000_000;
  const transport = new Scripted();
  const stream = new BookStream("BTC", transport, new TokenBucket(8, 10, clock.clock, clock.sleep), clock.clock);
  assert.throws(() => stream.poll(), /not started/);
  stream.start();
  transport.frames.push(JSON.stringify({ channel: "subscriptionResponse" }));
  transport.frames.push(bookFrame(clock.now - 500));
  const view = stream.poll();
  assert.ok(view);
  assert.equal(view.asOfMs, clock.now - 500);
  assert.equal(view.ageMs, 500);
  assert.equal(view.stale, false);
  assert.equal(stream.reconnects, 0);
  clock.now += 20_000;
  transport.frames.push(JSON.stringify({ channel: "ping" }));
  const aged = stream.poll();
  assert.equal(stream.reconnects, 1);
  assert.equal(transport.closes, 1);
  assert.ok(aged);
  assert.equal(aged.asOfMs, 999_500);
  assert.equal(aged.stale, true);
  assert.equal(transport.sent.includes('{"method":"pong"}'), true);
  clock.now += 19_999;
  stream.poll();
  assert.equal(stream.reconnects, 1);
});

test("a frame at the silence deadline prevents reconnect and depth is capped", () => {
  const clock = new ManualClock();
  clock.now = 5_000;
  const transport = new Scripted();
  const stream = new BookStream("BTC", transport, new TokenBucket(8, 10, clock.clock, clock.sleep), clock.clock, 25);
  stream.start();
  clock.now += 20_000;
  transport.frames.push(bookFrame(5_000, 21));
  const view = stream.poll();
  assert.equal(stream.reconnects, 0);
  assert.ok(view);
  assert.equal(view.bids.length, 20);
  assert.equal(view.asOfMs, 5_000);
  transport.frames.push(JSON.stringify({ channel: "l2Book", data: { coin: "ETH", time: clock.now, levels: [[], []] } }));
  const same = stream.poll();
  assert.ok(same);
  assert.equal(same.coin, "BTC");
  assert.throws(() => new BookStream("", transport, new TokenBucket(), clock.clock), /market/);
});

test("old exchange time stays stale while frames keep the socket up", () => {
  const clock = new ManualClock();
  clock.now = 1_000;
  const transport = new Scripted();
  const stream = new BookStream("BTC", transport, new TokenBucket(8, 10, clock.clock, clock.sleep), clock.clock);
  stream.start();
  clock.now = 30_000;
  transport.frames.push(bookFrame(1));
  const view = stream.poll();
  assert.ok(view);
  assert.equal(view.stale, true);
  clock.now = 31_000;
  transport.frames.push(bookFrame(1));
  stream.poll();
  assert.equal(stream.reconnects, 0);
});

function serverFrame(opcode: number, payload: Buffer): Buffer {
  const header = [0x80 | opcode];
  if (payload.length < 126) {
    header.push(payload.length);
  } else {
    header.push(126, payload.length >> 8, payload.length & 0xff);
  }
  return Buffer.concat([Buffer.from(header), payload]);
}

class FakeSocket implements SocketLike {
  sent: Buffer[] = [];
  closed = false;
  private chunks: Buffer[];

  constructor(chunks: Buffer[]) {
    this.chunks = chunks;
  }

  send(data: Buffer): void {
    this.sent.push(data);
  }

  recv(size: number): Buffer {
    const next = this.chunks[0];
    if (next === undefined) {
      return Buffer.alloc(0);
    }
    if (next.length <= size) {
      this.chunks.shift();
      return next;
    }
    this.chunks[0] = next.subarray(size);
    return next.subarray(0, size);
  }

  close(): void {
    this.closed = true;
  }
}

test("handshake, masked frames, and protocol ping use the injected socket", () => {
  assert.equal(acceptValue(SAMPLE_KEY), SAMPLE_ACCEPT);
  const masked = encodeClientFrame(0x1, Buffer.from("hello"), Buffer.from([1, 2, 3, 4]));
  assert.equal(masked[0], 0x81);
  assert.equal((masked[1] ?? 0) & 0x80, 0x80);
  const upgrade = Buffer.concat([
    Buffer.from(
      `HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ${SAMPLE_ACCEPT}\r\n\r\n`,
      "ascii",
    ),
    serverFrame(0x1, Buffer.from("ready")),
  ]);
  const sock = new FakeSocket([upgrade]);
  const session = openWebsocket(WS_URL, {
    socketFactory: () => sock,
    key: SAMPLE_KEY,
    maskFactory: () => Buffer.from([0, 0, 0, 0]),
  });
  assert.equal(session.recvText(), "ready");
  const parsed = parseWsUrl(WS_URL);
  assert.equal(parsed.path, "/ws");
  assert.equal(parsed.useTls, true);
  assert.equal(parsed.port, 443);
  assert.ok(handshakeRequest(parsed.host, parsed.path, SAMPLE_KEY).includes(SAMPLE_KEY));
  const ping = new SocketWs(new FakeSocket([serverFrame(0x9, Buffer.from("ping"))]), () => Buffer.from([0, 0, 0, 0]));
  assert.throws(() => ping.recvText(), /socket closed/);
  assert.equal(decodeServerFrame(Buffer.from([0x81])) , null);
  const domain = "hyperliquid" + ".xyz";
  assert.throws(() => parseWsUrl(`wss://api.${domain}/exchange`), /exchange/);
  assert.throws(() => checkHandshakeResponse(Buffer.from("HTTP/1.1 400 No\r\n\r\n"), SAMPLE_KEY), /upgrade/);
});

test("a websocket-shaped socket becomes the text transport", () => {
  const listeners = new Map<string, (event: { data: unknown }) => void>();
  const sent: string[] = [];
  const transport = fromWebSocket(WS_URL, (url) => {
    assert.equal(url, WS_URL);
    return {
      send(data: string) {
        sent.push(data);
      },
      close() {
        sent.push("closed");
      },
      addEventListener(
        type: "open" | "message" | "error",
        handler: (event: { data: unknown }) => void,
      ) {
        listeners.set(type, handler);
        if (type === "open") {
          handler({ data: "" });
        }
      },
    };
  });
  transport.connect();
  listeners.get("message")?.({ data: bookFrame(10) });
  assert.equal(transport.recv(), bookFrame(10));
  transport.send("hi");
  transport.close();
  assert.deepEqual(sent, ["hi", "closed"]);
  assert.throws(() => fromWebSocket(WS_URL, () => {
    throw new Error("unused");
  }).send("x"), /not connected/);
});

test("candleSnapshot is a public read", () => {
  const seen: string[] = [];
  const client = new InfoClient((url, body) => {
    assert.equal(url, INFO_URL);
    assert.equal(typeof body.type, "string");
    seen.push(String(body.type));
    return [];
  }, new TokenBucket());
  assert.deepEqual(client.post({ type: "candleSnapshot", req: { coin: "BTC", interval: "1m" } }), []);
  assert.deepEqual(seen, ["candleSnapshot"]);
});
