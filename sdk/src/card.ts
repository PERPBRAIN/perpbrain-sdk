/** SVG card for a verified simulation receipt. PNG is not produced. */

import { RECEIPT_KIND, RECEIPT_STATEMENT, sha256Json, verifyReceipt } from "./receipt.ts";
import { costsText, executionCost, tierText, type CostBreakdown } from "./vendor/costs.ts";
import type { Book, Fill, FundingPayment } from "./vendor/simulate.ts";

const FOOTER = "Simulated. Limits you set; losses are still possible.";
const ABSENT = "not recorded";
const KNOWN_NOT_MODELLED = ["queue_position", "liquidation"];

interface CardFields {
  strategy: string;
  market: string;
  period: string;
  tape_verification: string;
  receipt_hash: string;
  limits: string;
  not_modelled: string;
  out_of_sample: string;
  costs: string;
  tier: string;
  too_good: string | null;
}

export function renderReceiptCard(receipt: unknown, manifest: Uint8Array, inputs: Uint8Array): string {
  const report = verifyReceipt(receipt, manifest, inputs);
  if (report.status !== "VERIFIED") {
    throw new Error(report.mismatches.join("\n"));
  }
  return renderCardSvg(receipt);
}

function renderCardSvg(receipt: unknown): string {
  return svg(cardFields(receipt));
}

function cardFields(receipt: unknown): CardFields {
  if (!isObject(receipt)) {
    throw new Error("receipt mismatch");
  }
  requireReceipt(receipt);
  const inputs = mapping(receipt.inputs);
  const overfit = readOverfit(receipt.overfit);
  const costs = costsOf(receipt.result, inputs.book);
  return {
    strategy: strategyOf(receipt, inputs).toUpperCase(),
    market: marketOf(receipt, inputs),
    period: periodOf(receipt, inputs),
    tape_verification: tapeOf(receipt.tape_verification),
    receipt_hash: sha256Json(receipt),
    limits: limitsOf(receipt.limits),
    not_modelled: notModelled(receipt.result),
    out_of_sample: overfit.split,
    costs: costs.costs,
    tier: costs.tier,
    too_good: overfit.warning,
  };
}

function costsOf(result: unknown, book: unknown): { costs: string; tier: string } {
  try {
    const breakdown: CostBreakdown = executionCost(costSource(result), bookSource(book));
    return { costs: costsText(breakdown), tier: tierText(breakdown) };
  } catch {
    return { costs: ABSENT, tier: ABSENT };
  }
}

function costSource(value: unknown): {
  fills: Fill[];
  fee_version?: string;
  taker_bps?: string;
  maker_bps?: string;
  funding_payments: FundingPayment[];
} {
  const body = mapping(value);
  return {
    fills: Array.isArray(body.fills) ? (body.fills as Fill[]) : [],
    fee_version: typeof body.fee_version === "string" ? body.fee_version : undefined,
    taker_bps: typeof body.taker_bps === "string" ? body.taker_bps : undefined,
    maker_bps: typeof body.maker_bps === "string" ? body.maker_bps : undefined,
    funding_payments: Array.isArray(body.funding_payments) ? (body.funding_payments as FundingPayment[]) : [],
  };
}

function bookSource(value: unknown): Book {
  const body = mapping(value);
  const bids = Array.isArray(body.bids) ? (body.bids as Book["bids"]) : [];
  const asks = Array.isArray(body.asks) ? (body.asks as Book["asks"]) : [];
  return { bids, asks };
}

function requireReceipt(receipt: Record<string, unknown>): void {
  const version = receipt.version;
  if (typeof version !== "number" || !Number.isInteger(version) || (version !== 1 && version !== 2)) {
    throw new Error("version mismatch");
  }
  if (receipt.kind !== RECEIPT_KIND) {
    throw new Error("kind mismatch");
  }
  if (receipt.label !== "SIMULATED") {
    throw new Error("label mismatch");
  }
  if (receipt.statement !== RECEIPT_STATEMENT) {
    throw new Error("statement mismatch");
  }
}

function strategyOf(receipt: Record<string, unknown>, inputs: Record<string, unknown>): string {
  for (const source of [receipt, inputs]) {
    const text = nonempty(source.strategy);
    if (text !== null) {
      return text;
    }
  }
  return ABSENT;
}

function marketOf(receipt: Record<string, unknown>, inputs: Record<string, unknown>): string {
  const fromResult = nonempty(mapping(receipt.result).market);
  if (fromResult !== null) {
    return fromResult;
  }
  const fallback = nonempty(inputs.market);
  if (fallback !== null) {
    return fallback;
  }
  return ABSENT;
}

function periodOf(receipt: Record<string, unknown>, inputs: Record<string, unknown>): string {
  const explicit = nonempty(receipt.period);
  if (explicit !== null) {
    return explicit;
  }
  const stamps: number[] = [];
  const bars = inputs.bars;
  if (Array.isArray(bars)) {
    for (const bar of bars) {
      if (!isObject(bar)) {
        continue;
      }
      const stamp = bar.time_ms;
      if (typeof stamp === "number" && Number.isInteger(stamp)) {
        stamps.push(stamp);
      }
    }
  }
  if (stamps.length === 0) {
    return ABSENT;
  }
  const start = formatMs(Math.min(...stamps));
  const end = formatMs(Math.max(...stamps));
  if (start === end) {
    return start;
  }
  return `${start} \u2013 ${end}`;
}

function formatMs(stamp: number): string {
  const moment = new Date(stamp);
  const year = moment.getUTCFullYear().toString().padStart(4, "0");
  const month = (moment.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = moment.getUTCDate().toString().padStart(2, "0");
  const hour = moment.getUTCHours().toString().padStart(2, "0");
  const minute = moment.getUTCMinutes().toString().padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute} UTC`;
}

function tapeOf(value: unknown): string {
  return nonempty(value) ?? ABSENT;
}

function limitsOf(value: unknown): string {
  const limits = mapping(value);
  if (Object.keys(limits).length === 0) {
    return `${ABSENT} \u00b7 ${ABSENT}`;
  }
  const preset = nonempty(limits.preset) ?? ABSENT;
  let flag = ABSENT;
  if (limits.loosened === true) {
    flag = "loosened";
  } else if (limits.loosened === false) {
    flag = "not loosened";
  }
  return `${preset} \u00b7 ${flag}`;
}

function notModelled(result: unknown): string {
  const found: string[] = [];
  walkNotModelled(result, found);
  const ordered = KNOWN_NOT_MODELLED.filter((name) => found.includes(name));
  const extra = found.filter((name) => !KNOWN_NOT_MODELLED.includes(name)).sort();
  const names = [...ordered, ...extra];
  if (names.length === 0) {
    return "none";
  }
  return names.join(", ");
}

function walkNotModelled(value: unknown, found: string[]): void {
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (item === "NOT_MODELLED") {
        if (!found.includes(key)) {
          found.push(key);
        }
      } else {
        walkNotModelled(item, found);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walkNotModelled(item, found);
    }
  }
}

function readOverfit(value: unknown): { split: string; warning: string | null } {
  const body = mapping(value);
  if (Object.keys(body).length === 0) {
    return { split: ABSENT, warning: null };
  }
  const ratio = nonempty(body.in_sample_ratio);
  const inside = countOf(mapping(body.in_sample));
  const outside = countOf(mapping(body.out_of_sample));
  const split =
    ratio === null || inside === null || outside === null
      ? ABSENT
      : `${ratio} \u00b7 ${inside} in-sample \u00b7 ${outside} out-of-sample`;
  return { split, warning: warningOf(body.warnings) };
}

function countOf(body: Record<string, unknown>): number | null {
  const count = body.count;
  if (typeof count === "number" && Number.isInteger(count)) {
    return count;
  }
  return null;
}

function warningOf(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const reasons: string[] = [];
  for (const item of value) {
    if (!isObject(item) || item.code !== "too_good_to_be_true") {
      continue;
    }
    const reason = nonempty(item.reason);
    const text = reason === null ? "too_good_to_be_true" : reason;
    if (!reasons.includes(text)) {
      reasons.push(text);
    }
  }
  if (reasons.length === 0) {
    return null;
  }
  return `too_good_to_be_true \u00b7 ${reasons.join(", ")}`;
}

function svg(view: CardFields): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900" role="img" aria-labelledby="title desc">',
    `<title id="title">PERPBRAIN SIMULATED ${xml(view.strategy)}</title>`,
    `<desc id="desc">${xml(FOOTER)}</desc>`,
    "<style>",
    '@import url("https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&amp;family=Michroma&amp;display=swap");',
    "</style>",
    '<rect width="1200" height="900" fill="#10140f"/>',
    '<rect width="8" height="900" fill="#d6ff3f"/>',
    michroma(48, 76, 22, "#f3f1ea", "4", "PERPBRAIN"),
    michroma(1152, 76, 16, "#d6ff3f", "2", "SIMULATED", "end"),
    michroma(48, 156, 34, "#f3f1ea", "1", view.strategy),
    archivo(48, 204, 22, "#b7b3a8", `${view.market} \u00b7 ${view.period}`),
    '<line x1="48" y1="236" x2="1152" y2="236" stroke="#2a3128" stroke-width="1"/>',
  ];
  let y = 292;
  for (const [label, value, fill, size] of rows(view)) {
    lines.push(michroma(48, y, 13, "#8e8a80", "1.5", label));
    lines.push(archivo(300, y, size, fill, value));
    y += 56;
  }
  lines.push(archivo(48, 848, 16, "#8e8a80", FOOTER));
  lines.push("</svg>");
  return `${lines.join("\n")}\n`;
}

function rows(view: CardFields): [string, string, string, number][] {
  const body: [string, string, string, number][] = [
    ["TAPE", view.tape_verification, "#f3f1ea", 22],
    ["RECEIPT", view.receipt_hash, "#f3f1ea", 15],
    ["LIMITS", view.limits, "#f3f1ea", 22],
    ["NOT_MODELLED", view.not_modelled, "#f3f1ea", 22],
    ["OUT OF SAMPLE", view.out_of_sample, "#f3f1ea", 22],
    ["COSTS", view.costs, "#f3f1ea", 18],
    ["TIER", view.tier, "#f3f1ea", 16],
  ];
  if (view.too_good !== null) {
    body.push(["WARNING", view.too_good, "#d6ff3f", 22]);
  }
  return body;
}

function michroma(
  x: number,
  y: number,
  size: number,
  fill: string,
  spacing: string,
  text: string,
  anchor?: string,
): string {
  const anchorAttr = anchor === undefined ? "" : ` text-anchor="${anchor}"`;
  return (
    `<text font-family="Michroma, sans-serif" x="${x}" y="${y}" fill="${fill}" ` +
    `font-size="${size}" letter-spacing="${spacing}"${anchorAttr}>${xml(text)}</text>`
  );
}

function archivo(x: number, y: number, size: number, fill: string, text: string): string {
  return (
    `<text font-family="Archivo, sans-serif" x="${x}" y="${y}" fill="${fill}" ` +
    `font-size="${size}">${xml(text)}</text>`
  );
}

function mapping(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    return {};
  }
  return value;
}

function nonempty(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value
    .split(/\s+/)
    .filter((part) => part !== "")
    .join(" ");
  if (text === "") {
    return null;
  }
  return text;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
