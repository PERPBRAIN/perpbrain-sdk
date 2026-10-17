/** Versioned perp fee table. Tier-0 base rates from the public fee docs. */

export const DOCS_URL = "https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees";
export const DEFAULT_FEE_VERSION = "hl-perp-tier0-base-2026-10-16";
export const TIER1_FEE_VERSION = "hl-perp-tier1-base-2026-10-16";

export interface FeeSchedule {
  version: string;
  takerBps: string;
  makerBps: string;
  docsUrl: string;
}

const SCHEDULES: readonly FeeSchedule[] = [
  {
    version: DEFAULT_FEE_VERSION,
    takerBps: "4.5",
    makerBps: "1.5",
    docsUrl: DOCS_URL,
  },
  {
    version: TIER1_FEE_VERSION,
    takerBps: "4",
    makerBps: "1.2",
    docsUrl: DOCS_URL,
  },
];

export function feeSchedule(version: string | null = null): FeeSchedule {
  const chosen = version ?? DEFAULT_FEE_VERSION;
  const found = SCHEDULES.find((item) => item.version === chosen);
  if (found === undefined) {
    throw new Error("unknown fee schedule version");
  }
  return found;
}

const SCALE = 18n;
const SCALE_FACTOR = 10n ** SCALE;

export function parseDecimal(text: string): bigint {
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new Error("decimal required");
  }
  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;
  const [whole, frac = ""] = body.split(".");
  if (frac.length > Number(SCALE)) {
    throw new Error("decimal scale exceeded");
  }
  const padded = frac + "0".repeat(Number(SCALE) - frac.length);
  const value = BigInt(whole) * SCALE_FACTOR + BigInt(padded);
  return negative ? -value : value;
}

export function formatDecimal(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / SCALE_FACTOR;
  const frac = (abs % SCALE_FACTOR).toString().padStart(Number(SCALE), "0").replace(/0+$/, "");
  const text = frac.length === 0 ? whole.toString() : `${whole.toString()}.${frac}`;
  return negative ? `-${text}` : text;
}

export function feeAmount(notional: bigint, bps: string): bigint {
  const rate = parseDecimal(bps);
  return (notional * rate) / (SCALE_FACTOR * 10000n);
}
