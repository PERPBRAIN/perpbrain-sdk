/** Owner presets and a tighten-only runtime. Losses are still possible. */

import { createHash } from "node:crypto";

const SCALE = 18;
const SCALE_FACTOR = 10n ** BigInt(SCALE);
const DAY_MS = 86_400_000;

export const STALE_BLOCK_MS = 2_000;
export const STALE_HALT_MS = 5_000;
export const TOP_OI_COUNT = 20;
export const HARD_MAX_DAILY_LOSS_PCT = "25";
export const HARD_MAX_SLIPPAGE_BPS = "300";
export const HARD_MAX_OPEN_POSITIONS = 50;
export const HARD_MAX_ORDER_RATE = 10;

export const CODES = [
  "coin_not_allowed",
  "notional_exceeded",
  "aggregate_notional",
  "depth_cap",
  "leverage_exceeded",
  "open_positions_exceeded",
  "daily_stop_reduce_only",
  "slippage_exceeded",
  "order_rate",
  "stale_data",
  "stale_halt",
  "kill_switch",
] as const;

export type GuardCode = (typeof CODES)[number];
export type PresetName = "conservative" | "standard" | "pro";
export type IntentKind = "open" | "reduce" | "close";

const LIMIT_NAMES = [
  "maxNotionalUsd",
  "maxLeverage",
  "maxOpenPositions",
  "dailyLossPct",
  "maxSlippageBps",
  "orderRatePerSec",
  "allowedCoins",
] as const;

type LimitName = (typeof LIMIT_NAMES)[number];

export class GuardLoosenError extends Error {
  override readonly name = "GuardLoosenError";
}

export class GuardConfigError extends Error {
  override readonly name = "GuardConfigError";
}

export class GuardBlocked extends Error {
  override readonly name = "GuardBlocked";
  readonly violations: readonly Violation[];
  readonly headroom: Readonly<Record<string, string>>;
  readonly result: Readonly<Record<string, unknown>>;

  constructor(
    violations: readonly Violation[],
    headroom: Readonly<Record<string, string>>,
    result: Readonly<Record<string, unknown>>,
  ) {
    if (violations.length === 0) {
      throw new Error("GuardBlocked requires a violation");
    }
    const code = wireCode(violations[0]?.code ?? "kill_switch");
    super(code);
    this.violations = violations;
    this.headroom = headroom;
    this.result = result;
  }

  get code(): string {
    return this.message;
  }
}

export interface Violation {
  readonly code: GuardCode;
  readonly limit: string;
  readonly actual: string;
}

export interface GuardResult {
  readonly ok: boolean;
  readonly violations: readonly Violation[];
  readonly headroom: Readonly<Record<string, string>>;
}

export interface SimIntent {
  readonly coin: string;
  readonly notionalUsd: string;
  readonly leverage: string;
  readonly openPositions: number;
  readonly slippageBps: string;
  readonly ageMs: number;
  readonly dailyLossUsd?: string;
  readonly dailyLossPct?: string;
  readonly opening?: boolean;
  readonly orderSide?: "buy" | "sell";
  readonly intentKind?: IntentKind;
  readonly nowMs?: number;
}

export interface DepthLevel {
  readonly px: string;
  readonly sz: string;
}

export interface DepthBook {
  readonly bids: readonly DepthLevel[];
  readonly asks: readonly DepthLevel[];
}

export interface GuardOverrides {
  readonly maxNotionalUsd?: unknown;
  readonly maxLeverage?: unknown;
  readonly maxOpenPositions?: unknown;
  readonly dailyLossPct?: unknown;
  readonly maxSlippageBps?: unknown;
  readonly orderRatePerSec?: unknown;
  readonly allowedCoins?: unknown;
}

export interface GuardLimits {
  readonly preset: PresetName;
  readonly maxLeverage: string;
  readonly maxNotionalUsd: string | null;
  readonly dailyLossPct: string;
  readonly maxOpenPositions: number;
  readonly maxSlippageBps: string;
  readonly orderRatePerSec: number;
  readonly allowedCoins: readonly string[];
}

export interface Guards extends GuardLimits {
  readonly loosened: boolean;
  readonly limitsHash: string;
  tighten(overrides?: GuardOverrides): Guards;
  check(intent: SimIntent, options?: CheckOptions): GuardResult;
  receipt(snapshot?: MarketSnapshot): Record<string, unknown>;
  effectiveLimits(snapshot?: MarketSnapshot): Record<string, unknown>;
}

export interface CheckOptions {
  readonly book?: DepthBook | null;
  readonly snapshot?: MarketSnapshot | null;
  readonly nowMs?: number;
  readonly killSwitch?: boolean;
  readonly reduceOnly?: boolean;
  readonly recentOrders?: number;
  readonly portfolioNotionalUsd?: string;
  readonly portfolioPositions?: number;
  readonly portfolioCoinNotionalUsd?: string;
  readonly record?: boolean;
}

interface Preset {
  readonly maxLeverage: string;
  readonly maxNotionalUsd: string;
  readonly dailyLossPct: string;
  readonly maxOpenPositions: number;
  readonly maxSlippageBps: string;
  readonly orderRatePerSec: number;
}

export const PRESETS: Readonly<Record<PresetName, Preset>> = Object.freeze({
  conservative: Object.freeze({
    maxLeverage: "3",
    maxNotionalUsd: "10000",
    dailyLossPct: "3",
    maxOpenPositions: 3,
    maxSlippageBps: "25",
    orderRatePerSec: 2,
  }),
  standard: Object.freeze({
    maxLeverage: "5",
    maxNotionalUsd: "25000",
    dailyLossPct: "5",
    maxOpenPositions: 5,
    maxSlippageBps: "50",
    orderRatePerSec: 5,
  }),
  pro: Object.freeze({
    maxLeverage: "10",
    maxNotionalUsd: "250000",
    dailyLossPct: "10",
    maxOpenPositions: 15,
    maxSlippageBps: "100",
    orderRatePerSec: 10,
  }),
});

export interface CoinMeta {
  readonly name: string;
  readonly maxLeverage: number;
  readonly openInterest: string;
}

export interface MarketSnapshot {
  readonly snapshotId: string;
  readonly coins: readonly CoinMeta[];
}

const RECORDED: readonly CoinMeta[] = Object.freeze([
  Object.freeze({ name: "BTC", maxLeverage: 40, openInterest: "42321.38294" }),
  Object.freeze({ name: "ETH", maxLeverage: 25, openInterest: "1088724.0126" }),
]);

let cachedSnapshot: MarketSnapshot | null = null;

export function defaultSnapshot(): MarketSnapshot {
  cachedSnapshot ??= snapshotFromCoins(RECORDED);
  return cachedSnapshot;
}

export function snapshotFromCoins(coins: readonly CoinMeta[]): MarketSnapshot {
  const ordered = [...coins].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const payload = ordered.map((coin) => ({
    max_leverage: coin.maxLeverage,
    name: coin.name,
    open_interest: plain(parseDecimal(coin.openInterest)),
  }));
  const snapshotId = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return Object.freeze({ snapshotId, coins: Object.freeze(ordered.map((coin) => Object.freeze({ ...coin }))) });
}

export function wireCode(code: string): string {
  return `GUARD_BLOCKED:${code.toUpperCase()}`;
}

export function nextUtcMidnightMs(nowMs: number): number {
  if (!Number.isInteger(nowMs) || nowMs < 0) {
    throw new Error("nowMs must be >= 0");
  }
  return (Math.floor(nowMs / DAY_MS) + 1) * DAY_MS;
}

export function defaultGuards(): Guards {
  return fromConfig("standard");
}

export function fromConfig(
  preset: PresetName = "standard",
  overrides: GuardOverrides | null = null,
  acknowledgeLoosenedLimits = false,
  snapshot: MarketSnapshot | null = null,
): Guards {
  if (!isPreset(preset)) {
    throw new GuardConfigError("unknown preset");
  }
  const chosen = snapshot ?? defaultSnapshot();
  const base = PRESETS[preset];
  const values: Record<string, unknown> = {
    maxLeverage: base.maxLeverage,
    maxNotionalUsd: base.maxNotionalUsd,
    dailyLossPct: base.dailyLossPct,
    maxOpenPositions: base.maxOpenPositions,
    maxSlippageBps: base.maxSlippageBps,
    orderRatePerSec: base.orderRatePerSec,
    allowedCoins: namesOf(chosen),
  };
  const supplied = overrides ?? {};
  if (typeof supplied !== "object" || supplied === null || Array.isArray(supplied)) {
    throw new TypeError("overrides must be an object");
  }
  const unknown = Object.keys(supplied)
    .filter((key) => !LIMIT_NAMES.includes(key as LimitName))
    .sort();
  if (unknown.length > 0) {
    throw new TypeError(`unknown limit: ${unknown.join(", ")}`);
  }
  for (const name of LIMIT_NAMES) {
    if (supplied[name] !== undefined) {
      values[name] = applyOverride(name, values[name], supplied[name], acknowledgeLoosenedLimits, chosen);
    }
  }
  return create({
    preset,
    maxLeverage: String(values.maxLeverage),
    maxNotionalUsd: values.maxNotionalUsd === null ? null : String(values.maxNotionalUsd),
    dailyLossPct: String(values.dailyLossPct),
    maxOpenPositions: Number(values.maxOpenPositions),
    maxSlippageBps: String(values.maxSlippageBps),
    orderRatePerSec: Number(values.orderRatePerSec),
    allowedCoins: values.allowedCoins as readonly string[],
  }, chosen);
}

export class GuardSession {
  limits: Guards;
  owner: Guards;
  killSwitch = false;
  reduceOnlyUntilMs: number | null = null;
  private orderTimesMs: number[] = [];
  private positions = new Map<string, bigint>();

  constructor(limits: Guards, owner: Guards | null = null, killSwitch = false) {
    this.limits = limits;
    this.owner = owner ?? limits;
    this.killSwitch = killSwitch;
  }

  static fromConfig(
    preset: PresetName = "standard",
    overrides: GuardOverrides | null = null,
    acknowledgeLoosenedLimits = false,
    snapshot: MarketSnapshot | null = null,
  ): GuardSession {
    return new GuardSession(fromConfig(preset, overrides, acknowledgeLoosenedLimits, snapshot));
  }

  tighten(overrides: GuardOverrides = {}): Guards {
    this.limits = this.limits.tighten(overrides);
    return this.limits;
  }

  engageKillSwitch(): void {
    this.killSwitch = true;
  }

  restart(
    preset: PresetName = "standard",
    overrides: GuardOverrides | null = null,
    acknowledgeLoosenedLimits = false,
    snapshot: MarketSnapshot | null = null,
  ): GuardSession {
    const owner = fromConfig(preset, overrides, acknowledgeLoosenedLimits, snapshot);
    const keep = this.killSwitch && owner.limitsHash === this.owner.limitsHash;
    return new GuardSession(owner, owner, keep);
  }

  reduceOnly(nowMs: number): boolean {
    return this.reduceOnlyUntilMs !== null && nowMs < this.reduceOnlyUntilMs;
  }

  openPositionCount(): number {
    return this.positions.size;
  }

  aggregateNotionalUsd(): string {
    return plain(this.aggregateNotional());
  }

  coinNotional(coin: string): string {
    return plain(this.positions.get(coin) ?? 0n);
  }

  portfolio(): { openPositionCount: number; aggregateNotionalUsd: string } {
    return {
      openPositionCount: this.openPositionCount(),
      aggregateNotionalUsd: this.aggregateNotionalUsd(),
    };
  }

  check(intent: SimIntent, options: CheckOptions = {}): GuardResult {
    const { record: shouldRecord = true, ...rest } = options;
    const clock = rest.nowMs ?? intent.nowMs ?? 0;
    const loss = decimalText(intent.dailyLossPct ?? "0", "dailyLossPct");
    if (compare(loss, this.limits.dailyLossPct) >= 0) {
      this.reduceOnlyUntilMs = nextUtcMidnightMs(clock);
    }
    const recent = this.orderTimesMs.filter((stamp) => clock - stamp < 1000 && clock >= stamp);
    const result = this.limits.check(intent, {
      ...rest,
      nowMs: clock,
      killSwitch: this.killSwitch,
      reduceOnly: this.reduceOnly(clock),
      recentOrders: recent.length,
      portfolioNotionalUsd: this.aggregateNotionalUsd(),
      portfolioPositions: this.openPositionCount(),
      portfolioCoinNotionalUsd: this.coinNotional(intent.coin),
    });
    if (shouldRecord && result.ok) {
      this.remember(intent);
      if (kindOf(intent) === "open") {
        this.orderTimesMs.push(clock);
      }
    }
    return result;
  }

  private aggregateNotional(): bigint {
    let total = 0n;
    for (const value of this.positions.values()) {
      total += value;
    }
    return total;
  }

  private remember(intent: SimIntent): void {
    const kind = kindOf(intent);
    const coin = intent.coin;
    const notional = parseDecimal(decimalText(intent.notionalUsd, "notionalUsd"));
    const held = this.positions.get(coin) ?? 0n;
    switch (kind) {
      case "open":
        if (notional === 0n) {
          return;
        }
        this.positions.set(coin, held + notional);
        return;
      case "reduce": {
        const left = held - notional;
        if (left <= 0n) {
          this.positions.delete(coin);
          return;
        }
        this.positions.set(coin, left);
        return;
      }
      case "close":
        this.positions.delete(coin);
        return;
      default: {
        const unexpected: never = kind;
        throw new Error(`unexpected intent kind: ${String(unexpected)}`);
      }
    }
  }

  headroom(nowMs = 0, snapshot: MarketSnapshot | null = null): Readonly<Record<string, string>> {
    const coin = this.limits.allowedCoins[0] ?? "BTC";
    return this.check(
      {
        coin,
        notionalUsd: "0",
        leverage: "0",
        openPositions: 0,
        dailyLossPct: "0",
        slippageBps: "0",
        ageMs: 0,
        opening: false,
        intentKind: "close",
        orderSide: "sell",
      },
      { snapshot, nowMs, record: false },
    ).headroom;
  }
}

export interface SurvivalDay {
  readonly account: string;
  readonly preset: string;
  readonly lossPct: string;
  readonly killSwitch: boolean;
}

export function survivalReport(days: readonly SurvivalDay[]): Record<string, unknown> {
  const grouped = new Map<string, SurvivalDay[]>();
  for (const day of days) {
    const rows = grouped.get(day.account) ?? [];
    rows.push(day);
    grouped.set(day.account, rows);
  }
  const counts = new Map<PresetName, { accounts: number; survived: number }>();
  for (const name of Object.keys(PRESETS) as PresetName[]) {
    counts.set(name, { accounts: 0, survived: 0 });
  }
  for (const rows of grouped.values()) {
    if (rows.length !== 30) {
      throw new Error("each account needs 30 days");
    }
    const preset = rows[0]?.preset;
    if (!isPreset(preset)) {
      throw new Error("unknown preset");
    }
    if (rows.some((day) => day.preset !== preset)) {
      throw new Error("an account stays on one preset");
    }
    const tally = counts.get(preset);
    if (tally === undefined) {
      throw new Error("unknown preset");
    }
    tally.accounts += 1;
    if (survived(preset, rows)) {
      tally.survived += 1;
    }
  }
  const byPreset: Record<string, unknown> = {};
  for (const [name, tally] of counts) {
    const share = tally.accounts === 0 ? "0" : plain((BigInt(tally.survived) * SCALE_FACTOR) / BigInt(tally.accounts));
    byPreset[name] = { accounts: tally.accounts, survived: tally.survived, share };
  }
  return { windowDays: 30, byPreset };
}

function survived(preset: PresetName, days: readonly SurvivalDay[]): boolean {
  const stop = PRESETS[preset].dailyLossPct;
  return days.every((day) => !day.killSwitch && compare(decimalText(day.lossPct, "lossPct"), stop) < 0);
}

function create(values: GuardLimits, snapshot: MarketSnapshot = defaultSnapshot()): Guards {
  assertAbsolute(values);
  assertSnapshotCeiling(values, snapshot);
  const stored = Object.freeze({
    ...values,
    maxLeverage: decimalText(values.maxLeverage, "maxLeverage"),
    maxNotionalUsd: values.maxNotionalUsd === null ? null : decimalText(values.maxNotionalUsd, "maxNotionalUsd"),
    dailyLossPct: decimalText(values.dailyLossPct, "dailyLossPct"),
    maxOpenPositions: whole(values.maxOpenPositions, "maxOpenPositions"),
    maxSlippageBps: decimalText(values.maxSlippageBps, "maxSlippageBps"),
    orderRatePerSec: whole(values.orderRatePerSec, "orderRatePerSec"),
    allowedCoins: Object.freeze(coins(values.allowedCoins)),
  });
  const guards: Guards = {
    ...stored,
    get loosened() {
      return isLoosened(stored);
    },
    get limitsHash() {
      return hashLimits(stored, isLoosened(stored));
    },
    tighten(overrides: GuardOverrides = {}) {
      return create(applyTighten(stored, overrides), snapshot);
    },
    check(intent: SimIntent, options: CheckOptions = {}) {
      return evaluate(stored, intent, options, snapshot);
    },
    receipt(market: MarketSnapshot = snapshot) {
      return receiptOf(stored, market);
    },
    effectiveLimits(market: MarketSnapshot = snapshot) {
      return effectiveOf(stored, market);
    },
  };
  return Object.freeze(guards);
}

function isLoosened(limits: GuardLimits): boolean {
  const base = PRESETS[limits.preset];
  if (compare(limits.maxLeverage, base.maxLeverage) > 0) {
    return true;
  }
  if (limits.maxNotionalUsd === null || compare(limits.maxNotionalUsd, base.maxNotionalUsd) > 0) {
    return true;
  }
  if (compare(limits.dailyLossPct, base.dailyLossPct) > 0) {
    return true;
  }
  if (limits.maxOpenPositions > base.maxOpenPositions) {
    return true;
  }
  if (compare(limits.maxSlippageBps, base.maxSlippageBps) > 0) {
    return true;
  }
  return limits.orderRatePerSec > base.orderRatePerSec;
}

function hashLimits(limits: GuardLimits, loosened: boolean): string {
  const payload = {
    allowed_coins: [...limits.allowedCoins],
    daily_loss_pct: limits.dailyLossPct,
    loosened,
    max_leverage: limits.maxLeverage,
    max_notional_usd: limits.maxNotionalUsd,
    max_open_positions: limits.maxOpenPositions,
    max_slippage_bps: limits.maxSlippageBps,
    order_rate_per_sec: limits.orderRatePerSec,
    preset: limits.preset,
  };
  return createHash("sha256").update(canonical(payload)).digest("hex");
}

function receiptOf(limits: GuardLimits, snapshot: MarketSnapshot): Record<string, unknown> {
  return {
    guardPreset: limits.preset,
    limits: publicLimits(limits),
    effectiveLimitsPerCoin: effectiveOf(limits, snapshot),
    loosened: isLoosened(limits),
    limitsHash: hashLimits(limits, isLoosened(limits)),
    marketSnapshotId: snapshot.snapshotId,
  };
}

function publicLimits(limits: GuardLimits): Record<string, unknown> {
  return {
    preset: limits.preset,
    maxLeverage: limits.maxLeverage,
    maxNotionalUsd: limits.maxNotionalUsd,
    dailyLossPct: limits.dailyLossPct,
    maxOpenPositions: limits.maxOpenPositions,
    maxSlippageBps: limits.maxSlippageBps,
    orderRatePerSec: limits.orderRatePerSec,
    allowedCoins: [...limits.allowedCoins],
    staleBlockMs: STALE_BLOCK_MS,
    staleHaltMs: STALE_HALT_MS,
  };
}

function effectiveOf(limits: GuardLimits, snapshot: MarketSnapshot): Record<string, unknown> {
  const rendered: Record<string, unknown> = {};
  for (const name of limits.allowedCoins) {
    const meta = coinOf(snapshot, name);
    rendered[name] = {
      maxLeverage: plain(effectiveLeverage(limits, name, snapshot)),
      hlMaxLeverage: meta === null ? null : String(meta.maxLeverage),
      oiRank: oiRank(snapshot, name),
      maxNotionalUsd: limits.maxNotionalUsd,
    };
  }
  return rendered;
}

function evaluate(
  limits: GuardLimits,
  intent: SimIntent,
  options: CheckOptions,
  fallback: MarketSnapshot,
): GuardResult {
  if (typeof intent !== "object" || intent === null) {
    throw new Error("intent must be an object");
  }
  const kind = kindOf(intent);
  const coin = requiredString(intent.coin, "coin");
  const notional = parseDecimal(decimalText(intent.notionalUsd, "notionalUsd"));
  const leverage = parseDecimal(decimalText(intent.leverage, "leverage"));
  const openPositions = whole(intent.openPositions, "openPositions");
  const slippage = parseDecimal(decimalText(intent.slippageBps, "slippageBps"));
  const ageMs = whole(intent.ageMs, "ageMs");
  const side = intent.orderSide ?? "buy";
  if (side !== "buy" && side !== "sell") {
    throw new Error("orderSide must be buy or sell");
  }
  const snapshot = options.snapshot ?? fallback;
  const depth = visibleDepth(options.book ?? null, side, parseDecimal(limits.maxSlippageBps));
  const share = (depth * 20n) / 100n;
  const allowed = effectiveLeverage(limits, coin, snapshot);
  const found: Violation[] = [];
  if (kind !== "close") {
    if (!limits.allowedCoins.includes(coin) || coinOf(snapshot, coin) === null) {
      found.push({ code: "coin_not_allowed", limit: limits.allowedCoins.join(","), actual: coin });
    }
    if (limits.maxNotionalUsd !== null && notional > parseDecimal(limits.maxNotionalUsd)) {
      found.push({ code: "notional_exceeded", limit: limits.maxNotionalUsd, actual: plain(notional) });
    }
    if (kind === "open" && options.portfolioNotionalUsd !== undefined && limits.maxNotionalUsd !== null) {
      const used = parseDecimal(decimalText(options.portfolioNotionalUsd, "portfolioNotionalUsd"));
      const projectedNotional = used + notional;
      const cap = parseDecimal(limits.maxNotionalUsd);
      if (projectedNotional > cap) {
        found.push({
          code: "aggregate_notional",
          limit: limits.maxNotionalUsd,
          actual: plain(projectedNotional),
        });
      }
    }
    if (depth === 0n || notional > share) {
      found.push({ code: "depth_cap", limit: plain(share), actual: plain(notional) });
    }
    if (coinOf(snapshot, coin) !== null && leverage > allowed) {
      found.push({ code: "leverage_exceeded", limit: plain(allowed), actual: plain(leverage) });
    }
    if (kind === "open") {
      let projected = openPositions;
      if (options.portfolioPositions !== undefined) {
        const held = parseDecimal(
          decimalText(options.portfolioCoinNotionalUsd ?? "0", "portfolioCoinNotionalUsd"),
        );
        const extra = notional > 0n && held === 0n ? 1 : 0;
        projected = Math.max(openPositions, whole(options.portfolioPositions, "portfolioPositions") + extra);
      }
      if (projected > limits.maxOpenPositions) {
        found.push({
          code: "open_positions_exceeded",
          limit: String(limits.maxOpenPositions),
          actual: String(projected),
        });
      }
    }
    const loss = parseDecimal(decimalText(intent.dailyLossPct ?? "0", "dailyLossPct"));
    if (kind === "open" && (options.reduceOnly === true || loss >= parseDecimal(limits.dailyLossPct))) {
      found.push({ code: "daily_stop_reduce_only", limit: limits.dailyLossPct, actual: plain(loss) });
    }
    if (slippage > parseDecimal(limits.maxSlippageBps)) {
      found.push({ code: "slippage_exceeded", limit: limits.maxSlippageBps, actual: plain(slippage) });
    }
    const recent = options.recentOrders ?? 0;
    if (kind === "open" && recent >= limits.orderRatePerSec) {
      found.push({ code: "order_rate", limit: String(limits.orderRatePerSec), actual: String(recent + 1) });
    }
    if (kind === "open" && ageMs > STALE_HALT_MS) {
      found.push({ code: "stale_halt", limit: String(STALE_HALT_MS), actual: String(ageMs) });
    } else if (kind === "open" && ageMs > STALE_BLOCK_MS) {
      found.push({ code: "stale_data", limit: String(STALE_BLOCK_MS), actual: String(ageMs) });
    }
    if (kind === "open" && options.killSwitch === true) {
      found.push({ code: "kill_switch", limit: "latched", actual: "engaged" });
    }
  }
  const ordered = [...found].sort((left, right) => CODES.indexOf(left.code) - CODES.indexOf(right.code));
  const dollar = limits.maxNotionalUsd === null ? share : minBig(parseDecimal(limits.maxNotionalUsd), share);
  const counted = options.portfolioPositions ?? openPositions;
  const aggregateNotionalUsd =
    limits.maxNotionalUsd === null
      ? "none"
      : plain(
          room(
            parseDecimal(limits.maxNotionalUsd),
            options.portfolioNotionalUsd === undefined
              ? 0n
              : parseDecimal(decimalText(options.portfolioNotionalUsd, "portfolioNotionalUsd")),
          ),
        );
  const headroom = Object.freeze({
    notionalUsd: plain(room(dollar, notional)),
    aggregateNotionalUsd,
    depthCapUsd: plain(share),
    leverage: plain(room(allowed, leverage)),
    openPositions: String(Math.max(0, limits.maxOpenPositions - counted)),
    dailyLossPct: plain(room(parseDecimal(limits.dailyLossPct), parseDecimal(decimalText(intent.dailyLossPct ?? "0", "dailyLossPct")))),
    slippageBps: plain(room(parseDecimal(limits.maxSlippageBps), slippage)),
    orderRatePerSec: String(Math.max(0, limits.orderRatePerSec - (options.recentOrders ?? 0))),
    staleBlockMsRemaining: String(Math.max(0, STALE_BLOCK_MS - ageMs)),
    staleHaltMsRemaining: String(Math.max(0, STALE_HALT_MS - ageMs)),
  });
  return Object.freeze({ ok: ordered.length === 0, violations: Object.freeze(ordered), headroom });
}

function visibleDepth(book: DepthBook | null, side: "buy" | "sell", slippage: bigint): bigint {
  const levels = book === null ? [] : side === "buy" ? book.asks : book.bids;
  if (levels.length === 0) {
    return 0n;
  }
  const parsed = levels.map((level) => ({
    price: parseDecimal(decimalText(level.px, "px")),
    size: parseDecimal(decimalText(level.sz, "sz")),
  }));
  const best = side === "buy" ? parsed.reduce((min, level) => (level.price < min ? level.price : min), parsed[0]?.price ?? 0n) : parsed.reduce((max, level) => (level.price > max ? level.price : max), parsed[0]?.price ?? 0n);
  const band = (best * slippage) / (10000n * SCALE_FACTOR);
  const limit = side === "buy" ? best + band : best - band;
  return parsed
    .filter((level) => (side === "buy" ? level.price <= limit : level.price >= limit))
    .reduce((total, level) => total + (level.price * level.size) / SCALE_FACTOR, 0n);
}

function effectiveLeverage(limits: GuardLimits, coin: string, snapshot: MarketSnapshot): bigint {
  const meta = coinOf(snapshot, coin);
  if (meta === null) {
    return 0n;
  }
  const cap = minBig(parseDecimal(limits.maxLeverage), parseDecimal(String(meta.maxLeverage)));
  const rank = oiRank(snapshot, coin);
  if (rank !== null && rank > TOP_OI_COUNT) {
    return cap / 2n;
  }
  return cap;
}

function applyTighten(current: GuardLimits, overrides: GuardOverrides): GuardLimits {
  if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) {
    throw new TypeError("overrides must be an object");
  }
  const unknown = Object.keys(overrides)
    .filter((key) => !LIMIT_NAMES.includes(key as LimitName))
    .sort();
  if (unknown.length > 0) {
    throw new TypeError(`unknown limit: ${unknown.join(", ")}`);
  }
  return {
    preset: current.preset,
    maxLeverage: tighterDecimal("maxLeverage", current.maxLeverage, overrides.maxLeverage),
    maxNotionalUsd: tighterNotional(current.maxNotionalUsd, overrides.maxNotionalUsd),
    dailyLossPct: tighterDecimal("dailyLossPct", current.dailyLossPct, overrides.dailyLossPct),
    maxOpenPositions: tighterInt("maxOpenPositions", current.maxOpenPositions, overrides.maxOpenPositions),
    maxSlippageBps: tighterDecimal("maxSlippageBps", current.maxSlippageBps, overrides.maxSlippageBps),
    orderRatePerSec: tighterInt("orderRatePerSec", current.orderRatePerSec, overrides.orderRatePerSec),
    allowedCoins: tighterCoins(current.allowedCoins, overrides.allowedCoins),
  };
}

function applyOverride(
  name: LimitName,
  current: unknown,
  raw: unknown,
  acknowledge: boolean,
  snapshot: MarketSnapshot,
): unknown {
  if (name === "allowedCoins") {
    const parsed = coins(raw);
    if (parsed.some((coin) => !namesOf(snapshot).includes(coin))) {
      throw new GuardConfigError("allowedCoins is past the listed perps");
    }
    const currentCoins = coins(current);
    if (parsed.some((coin) => !currentCoins.includes(coin)) && !acknowledge) {
      throw new GuardLoosenError("allowedCoins cannot be loosened");
    }
    return parsed;
  }
  if (name === "maxNotionalUsd") {
    return overrideNotional(current, raw, acknowledge);
  }
  if (name === "maxOpenPositions" || name === "orderRatePerSec") {
    const parsed = whole(raw, name);
    const baseline = whole(current, name);
    if (parsed > baseline && !acknowledge) {
      throw new GuardLoosenError(`${name} cannot be loosened`);
    }
    if (name === "maxOpenPositions" && parsed > HARD_MAX_OPEN_POSITIONS) {
      throw new GuardConfigError("maxOpenPositions is past the hard ceiling");
    }
    if (name === "orderRatePerSec" && parsed > HARD_MAX_ORDER_RATE) {
      throw new GuardConfigError("orderRatePerSec is past the hard ceiling");
    }
    return parsed;
  }
  const parsed = decimalText(raw, name);
  const baseline = decimalText(current, name);
  if (compare(parsed, baseline) > 0 && !acknowledge) {
    throw new GuardLoosenError(`${name} cannot be loosened`);
  }
  if (name === "maxLeverage" && compare(parsed, highestLeverage(snapshot)) > 0) {
    throw new GuardConfigError("maxLeverage is past the hard ceiling");
  }
  if (name === "dailyLossPct" && compare(parsed, HARD_MAX_DAILY_LOSS_PCT) > 0) {
    throw new GuardConfigError("dailyLossPct is past the hard ceiling");
  }
  if (name === "maxSlippageBps" && compare(parsed, HARD_MAX_SLIPPAGE_BPS) > 0) {
    throw new GuardConfigError("maxSlippageBps is past the hard ceiling");
  }
  return parsed;
}

function overrideNotional(current: unknown, raw: unknown, acknowledge: boolean): string | null {
  if (raw === null) {
    if (current !== null && !acknowledge) {
      throw new GuardLoosenError("maxNotionalUsd cannot be loosened");
    }
    return null;
  }
  const parsed = decimalText(raw, "maxNotionalUsd");
  if (current === null) {
    return parsed;
  }
  if (compare(parsed, decimalText(current, "maxNotionalUsd")) > 0 && !acknowledge) {
    throw new GuardLoosenError("maxNotionalUsd cannot be loosened");
  }
  return parsed;
}

function tighterDecimal(name: string, current: string, value: unknown): string {
  if (value === undefined) {
    return current;
  }
  const parsed = decimalText(value, name);
  if (compare(parsed, current) > 0) {
    throw new GuardLoosenError(`${name} cannot be loosened`);
  }
  return parsed;
}

function tighterNotional(current: string | null, value: unknown): string | null {
  if (value === undefined) {
    return current;
  }
  if (value === null) {
    if (current !== null) {
      throw new GuardLoosenError("maxNotionalUsd cannot be loosened");
    }
    return null;
  }
  const parsed = decimalText(value, "maxNotionalUsd");
  if (current === null || compare(parsed, current) <= 0) {
    return parsed;
  }
  throw new GuardLoosenError("maxNotionalUsd cannot be loosened");
}

function tighterInt(name: string, current: number, value: unknown): number {
  if (value === undefined) {
    return current;
  }
  const parsed = whole(value, name);
  if (parsed > current) {
    throw new GuardLoosenError(`${name} cannot be loosened`);
  }
  return parsed;
}

function tighterCoins(current: readonly string[], value: unknown): readonly string[] {
  if (value === undefined) {
    return current;
  }
  const parsed = coins(value);
  if (parsed.some((coin) => !current.includes(coin))) {
    throw new GuardLoosenError("allowedCoins cannot be loosened");
  }
  return parsed;
}

function assertAbsolute(values: GuardLimits): void {
  if (!isPreset(values.preset)) {
    throw new GuardConfigError("unknown preset");
  }
  if (compare(decimalText(values.dailyLossPct, "dailyLossPct"), HARD_MAX_DAILY_LOSS_PCT) > 0) {
    throw new GuardConfigError("dailyLossPct is past the hard ceiling");
  }
  if (whole(values.maxOpenPositions, "maxOpenPositions") > HARD_MAX_OPEN_POSITIONS) {
    throw new GuardConfigError("maxOpenPositions is past the hard ceiling");
  }
  if (compare(decimalText(values.maxSlippageBps, "maxSlippageBps"), HARD_MAX_SLIPPAGE_BPS) > 0) {
    throw new GuardConfigError("maxSlippageBps is past the hard ceiling");
  }
  if (whole(values.orderRatePerSec, "orderRatePerSec") > HARD_MAX_ORDER_RATE) {
    throw new GuardConfigError("orderRatePerSec is past the hard ceiling");
  }
}

function assertSnapshotCeiling(values: GuardLimits, snapshot: MarketSnapshot): void {
  if (compare(decimalText(values.maxLeverage, "maxLeverage"), highestLeverage(snapshot)) > 0) {
    throw new GuardConfigError("maxLeverage is past the hard ceiling");
  }
  if (coins(values.allowedCoins).some((coin) => !namesOf(snapshot).includes(coin))) {
    throw new GuardConfigError("allowedCoins is past the listed perps");
  }
}

function kindOf(intent: SimIntent): IntentKind {
  if (intent.intentKind === "open" || intent.intentKind === "reduce" || intent.intentKind === "close") {
    return intent.intentKind;
  }
  return intent.opening === false ? "close" : "open";
}

function namesOf(snapshot: MarketSnapshot): readonly string[] {
  return [...snapshot.coins.map((coin) => coin.name)].sort();
}

function coinOf(snapshot: MarketSnapshot, name: string): CoinMeta | null {
  return snapshot.coins.find((coin) => coin.name === name) ?? null;
}

function oiRank(snapshot: MarketSnapshot, name: string): number | null {
  const ordered = [...snapshot.coins].sort((left, right) => {
    const interest = compare(right.openInterest, left.openInterest);
    if (interest !== 0) {
      return interest;
    }
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  const index = ordered.findIndex((coin) => coin.name === name);
  return index < 0 ? null : index + 1;
}

function highestLeverage(snapshot: MarketSnapshot): string {
  return snapshot.coins.reduce((max, coin) => {
    const text = String(coin.maxLeverage);
    return compare(text, max) > 0 ? text : max;
  }, "0");
}

function isPreset(value: unknown): value is PresetName {
  return value === "conservative" || value === "standard" || value === "pro";
}

function room(limit: bigint, actual: bigint): bigint {
  return actual >= limit ? 0n : limit - actual;
}

function minBig(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function canonical(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return Object.fromEntries(entries.map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function decimalText(value: unknown, label: string): string {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`${label} must be a decimal`);
    }
    return decimalText(String(value), label);
  }
  if (typeof value === "bigint") {
    return plain(value);
  }
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`${label} must be a decimal`);
  }
  return plain(parseDecimal(value));
}

function whole(value: unknown, label: string): number {
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return whole(Number(value), label);
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  if (value < 0) {
    throw new Error(`${label} must be >= 0`);
  }
  return value;
}

function coins(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error("allowedCoins must be a list of coins");
  }
  const found: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item === "") {
      throw new Error("allowedCoins must be a list of coins");
    }
    if (!found.includes(item)) {
      found.push(item);
    }
  }
  found.sort();
  return Object.freeze(found);
}

function compare(left: string, right: string): number {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  if (a > b) {
    return 1;
  }
  if (a < b) {
    return -1;
  }
  return 0;
}

function parseDecimal(text: string): bigint {
  const [wholePart, frac = ""] = text.split(".");
  if (frac.length > SCALE) {
    throw new Error("decimal scale exceeded");
  }
  const padded = frac + "0".repeat(SCALE - frac.length);
  return BigInt(wholePart ?? "0") * SCALE_FACTOR + BigInt(padded);
}

function plain(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const wholePart = absolute / SCALE_FACTOR;
  const frac = (absolute % SCALE_FACTOR).toString().padStart(SCALE, "0").replace(/0+$/, "");
  const text = frac.length === 0 ? wholePart.toString() : `${wholePart.toString()}.${frac}`;
  return negative ? `-${text}` : text;
}
