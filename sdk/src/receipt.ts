/** Re-derive a simulation receipt. The check is verified and reproducible. */

import { createHash } from "node:crypto";

import { GuardBlocked, GuardSession, snapshotFromCoins, type PresetName } from "./guards.ts";
import { guardedSimulate } from "./guarded.ts";
import { type CostBreakdown } from "./vendor/costs.ts";
import {
  HL_FUNDING_INTERVAL_MS,
  simulate,
  type Bar,
  type Book,
  type Decision,
  type FundingSample,
  type GuardContext,
  type SimulateResult,
} from "./vendor/simulate.ts";

export const RECEIPT_STATEMENT = "verified and reproducible";
export const RECEIPT_KIND = "perpbrain.sim-receipt";
export const RECEIPT_VERSION = 2;

export interface VerifyReport {
  status: "VERIFIED" | "MISMATCH";
  mismatches: string[];
}

export function verifyReceipt(receipt: unknown, manifest: Uint8Array, inputs: Uint8Array): VerifyReport {
  const mismatches: string[] = [];
  const body = asObject(receipt);
  if (body === null) {
    return report(["receipt mismatch"]);
  }
  const version = checkIdentity(body, mismatches);
  const limits = body.limits;
  const limitsHash = digestField(body, "limits_hash", mismatches);
  if (isObject(limits)) {
    if (limitsHash !== null && sha256Json(limits) !== limitsHash) {
      mismatches.push("limits_hash mismatch");
    }
  } else {
    mismatches.push("limits mismatch");
  }
  const snapshot = body.market_snapshot;
  const snapshotId = digestField(body, "market_snapshot_id", mismatches);
  if (Array.isArray(snapshot)) {
    if (snapshotId !== null && sha256Json(snapshot) !== snapshotId) {
      mismatches.push("market_snapshot_id mismatch");
    }
  } else {
    mismatches.push("market_snapshot mismatch");
  }
  const claimedData = digestField(body, "data_snapshot_id", mismatches);
  const parsedInputs = parseInputs(inputs, claimedData, body.inputs, mismatches);
  const claimedManifest = digestField(body, "manifest_sha256", mismatches);
  const manifestBody = parseManifest(manifest, claimedManifest, mismatches);
  if (manifestBody !== null) {
    checkManifest(manifestBody, body, mismatches);
  }
  const claimedResult = digestField(body, "result_sha256", mismatches);
  if (claimedResult !== null && sha256Json(body.result) !== claimedResult) {
    mismatches.push("result_sha256 mismatch");
  }
  if (parsedInputs !== null) {
    checkSim(parsedInputs, body.result, mismatches, version);
    checkGuard(body, parsedInputs, mismatches);
  }
  return report(mismatches);
}

export function canonical(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function costBreakdownFromReceipt(receipt: unknown): CostBreakdown {
  const body = asObject(receipt);
  if (body === null) {
    throw new Error("receipt mismatch");
  }
  const inputs = asObject(body.inputs);
  if (inputs === null) {
    throw new Error("inputs must be an object");
  }
  return runSim(inputs).cost_breakdown;
}

function checkIdentity(receipt: Record<string, unknown>, mismatches: string[]): number | null {
  const version = receipt.version;
  if (typeof version !== "number" || !Number.isInteger(version) || (version !== 1 && version !== 2)) {
    mismatches.push("version mismatch");
  }
  if (receipt.kind !== RECEIPT_KIND) {
    mismatches.push("kind mismatch");
  }
  if (receipt.label !== "SIMULATED") {
    mismatches.push("label mismatch");
  }
  if (receipt.statement !== RECEIPT_STATEMENT) {
    mismatches.push("statement mismatch");
  }
  return version === 1 || version === 2 ? version : null;
}

function digestField(receipt: Record<string, unknown>, key: string, mismatches: string[]): string | null {
  const value = receipt[key];
  if (typeof value !== "string" || value === "") {
    mismatches.push(`${key} mismatch`);
    return null;
  }
  return value;
}

function parseInputs(
  inputs: Uint8Array,
  claimed: string | null,
  embedded: unknown,
  mismatches: string[],
): Record<string, unknown> | null {
  if (claimed !== null && sha256Bytes(inputs) !== claimed) {
    mismatches.push("data_snapshot_id mismatch");
  }
  if (inputs.byteLength === 0) {
    return null;
  }
  let loaded: unknown;
  try {
    loaded = JSON.parse(new TextDecoder().decode(inputs)) as unknown;
  } catch {
    mismatches.push("inputs json mismatch");
    return null;
  }
  if (!isObject(loaded)) {
    mismatches.push("inputs mismatch");
    return null;
  }
  if (!sameJson(embedded, loaded)) {
    mismatches.push("inputs mismatch");
  }
  return loaded;
}

function parseManifest(
  manifest: Uint8Array,
  claimed: string | null,
  mismatches: string[],
): Record<string, unknown> | null {
  if (manifest.byteLength === 0) {
    return null;
  }
  if (claimed !== null && sha256Bytes(manifest) !== claimed) {
    mismatches.push("manifest_sha256 mismatch");
  }
  let loaded: unknown;
  try {
    loaded = JSON.parse(new TextDecoder().decode(manifest)) as unknown;
  } catch {
    mismatches.push("manifest json mismatch");
    return null;
  }
  if (!isObject(loaded)) {
    mismatches.push("manifest mismatch");
    return null;
  }
  return loaded;
}

function checkManifest(
  manifest: Record<string, unknown>,
  receipt: Record<string, unknown>,
  mismatches: string[],
): void {
  for (const key of ["data_snapshot_id", "limits_hash", "market_snapshot_id", "result_sha256"]) {
    if (manifest[key] !== receipt[key]) {
      mismatches.push(`manifest ${key} mismatch`);
    }
  }
  const files = manifest.files;
  const rawRef = receipt.raw_ref;
  if (!Array.isArray(files)) {
    mismatches.push("manifest files mismatch");
    return;
  }
  let found = false;
  for (const item of files) {
    if (!isObject(item)) {
      mismatches.push("manifest files mismatch");
      continue;
    }
    if (item.file !== rawRef) {
      continue;
    }
    found = true;
    if (item.sha256 !== receipt.data_snapshot_id) {
      mismatches.push(`manifest file ${String(rawRef)} sha256 mismatch`);
    }
    if (item.rows !== 1) {
      mismatches.push(`manifest file ${String(rawRef)} rows mismatch`);
    }
  }
  if (!found) {
    mismatches.push("manifest files mismatch");
  }
}

function checkSim(
  inputs: Record<string, unknown>,
  result: unknown,
  mismatches: string[],
  version: number | null,
): void {
  let rerun: Record<string, unknown>;
  try {
    rerun = wireResult(runSim(inputs));
  } catch (error) {
    mismatches.push(`sim mismatch: ${messageOf(error)}`);
    return;
  }
  const compared = version === 1 ? withoutCost(rerun) : rerun;
  if (isObject(result)) {
    mismatches.push(...diff(result, compared, "result"));
  } else {
    mismatches.push("result mismatch");
  }
}

function withoutCost(result: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { ...result };
  delete body.cost_breakdown;
  if (isObject(body.receipt)) {
    const inner: Record<string, unknown> = { ...body.receipt };
    delete inner.cost_breakdown;
    body.receipt = inner;
  }
  return body;
}

function checkGuard(receipt: Record<string, unknown>, inputs: Record<string, unknown>, mismatches: string[]): void {
  try {
    const limits = asObject(receipt.limits);
    if (limits === null) {
      return;
    }
    const session = sessionFrom(limits, receipt.market_snapshot);
    if (session.limits.limitsHash !== sha256Json(limits)) {
      pushOnce(mismatches, "limits_hash mismatch");
    }
    guardedSimulate(
      requiredString(inputs.market, "market"),
      decisionOf(inputs.decision),
      barsOf(inputs.bars),
      bookOf(inputs.book),
      feeOf(inputs.fee_version),
      contextOf(inputs.guard_context),
      presetOf(limits.preset),
      session,
      fundingOf(inputs.funding),
      intervalOf(inputs.funding_interval_ms),
    );
  } catch (error) {
    if (error instanceof GuardBlocked) {
      const codes = error.violations.map((item) => item.code).join(",");
      mismatches.push(`guard mismatch: ${codes}`);
      return;
    }
    mismatches.push(`limits mismatch: ${messageOf(error)}`);
  }
}

function sessionFrom(limits: Record<string, unknown>, snapshot: unknown): GuardSession {
  const preset = presetOf(limits.preset);
  const rows = coinRows(snapshot);
  const market = snapshotFromCoins(
    rows.map((row) => ({
      name: requiredString(row.name, "name"),
      maxLeverage: whole(row.max_leverage, "max_leverage"),
      openInterest: requiredString(row.open_interest, "open_interest"),
    })),
  );
  return GuardSession.fromConfig(
    preset,
    {
      maxLeverage: limits.max_leverage,
      maxNotionalUsd: limits.max_notional_usd,
      dailyLossPct: limits.daily_loss_pct,
      maxOpenPositions: limits.max_open_positions,
      maxSlippageBps: limits.max_slippage_bps,
      orderRatePerSec: limits.order_rate_per_sec,
      allowedCoins: limits.allowed_coins,
    },
    limits.loosened === true,
    market,
  );
}

function runSim(inputs: Record<string, unknown>): SimulateResult {
  return simulate(
    requiredString(inputs.market, "market"),
    decisionOf(inputs.decision),
    barsOf(inputs.bars),
    bookOf(inputs.book),
    feeOf(inputs.fee_version),
    null,
    contextOf(inputs.guard_context),
    fundingOf(inputs.funding),
    intervalOf(inputs.funding_interval_ms),
  );
}

function wireResult(result: SimulateResult): Record<string, unknown> {
  return {
    label: result.label,
    market: result.market,
    fills: result.fills,
    fill_source: result.fillSource,
    fee_version: result.feeVersion,
    taker_bps: result.takerBps,
    maker_bps: result.makerBps,
    funding_interval_ms: result.fundingIntervalMs,
    funding_payments: result.fundingPayments,
    unfilled_entry: result.unfilledEntry,
    open_size: result.openSize,
    queue_position: result.queue_position,
    liquidation: result.liquidation,
    cost_breakdown: result.cost_breakdown,
    receipt: result.receipt,
  };
}

function decisionOf(value: unknown): Decision {
  const body = requiredObject(value, "decision");
  const side = body.side;
  if (side !== "long" && side !== "short") {
    throw new Error("side must be long or short");
  }
  const decision: Decision = {
    barIndex: whole(body.bar_index, "bar_index"),
    side,
    size: requiredString(body.size, "size"),
    stop: optionalString(body.stop, "stop"),
    target: optionalString(body.target, "target"),
  };
  const liquidity = body.liquidity ?? "taker";
  if (liquidity === "maker") {
    decision.liquidity = "maker";
  } else if (liquidity !== "taker") {
    throw new Error("liquidity must be taker or maker");
  }
  return decision;
}

function barsOf(value: unknown): Bar[] {
  if (!Array.isArray(value)) {
    throw new Error("bars must be a list");
  }
  return value.map((item) => {
    const body = requiredObject(item, "bar");
    const bar: Bar = {
      open: requiredString(body.open, "open"),
      high: requiredString(body.high, "high"),
      low: requiredString(body.low, "low"),
      close: requiredString(body.close, "close"),
    };
    if ("time_ms" in body) {
      bar.timeMs = whole(body.time_ms, "time_ms");
    }
    return bar;
  });
}

function bookOf(value: unknown): Book {
  const body = requiredObject(value, "book");
  return { bids: levelsOf(body.bids), asks: levelsOf(body.asks) };
}

function levelsOf(value: unknown): { px: string; sz: string }[] {
  if (!Array.isArray(value)) {
    throw new Error("levels must be a list");
  }
  return value.map((item) => {
    const body = requiredObject(item, "level");
    return { px: requiredString(body.px, "px"), sz: requiredString(body.sz, "sz") };
  });
}

function fundingOf(value: unknown): FundingSample[] | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new Error("funding must be a list");
  }
  if (value.length === 0) {
    return null;
  }
  return value.map((item) => {
    const body = requiredObject(item, "funding");
    return {
      timeMs: whole(body.time_ms, "time_ms"),
      ratePerHour: requiredString(body.rate_per_hour, "rate_per_hour"),
      oraclePxUsd: requiredString(body.oracle_px_usd, "oracle_px_usd"),
    };
  });
}

function contextOf(value: unknown): GuardContext | null {
  if (value === undefined || value === null) {
    return null;
  }
  const body = requiredObject(value, "guard_context");
  const context: GuardContext = {};
  if ("leverage" in body) {
    context.leverage = requiredString(body.leverage, "leverage");
  }
  if ("openPositions" in body || "open_positions" in body) {
    context.openPositions = whole(body.open_positions, "open_positions");
  }
  if ("dailyLossUsd" in body || "daily_loss_usd" in body) {
    context.dailyLossUsd = requiredString(body.daily_loss_usd, "daily_loss_usd");
  }
  if ("dailyLossPct" in body || "daily_loss_pct" in body) {
    context.dailyLossPct = requiredString(body.daily_loss_pct, "daily_loss_pct");
  }
  if ("ageMs" in body || "age_ms" in body) {
    context.ageMs = whole(body.age_ms, "age_ms");
  }
  if ("nowMs" in body || "now_ms" in body) {
    context.nowMs = whole(body.now_ms, "now_ms");
  }
  return context;
}

function feeOf(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("fee_version must be a string or null");
  }
  return value;
}

function intervalOf(value: unknown): number {
  if (value === undefined) {
    return HL_FUNDING_INTERVAL_MS;
  }
  return whole(value, "funding_interval_ms");
}

function presetOf(value: unknown): PresetName {
  if (value === "conservative" || value === "standard" || value === "pro") {
    return value;
  }
  throw new Error("preset must be a known preset");
}

function coinRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error("market snapshot must be a list");
  }
  return value.map((item) => requiredObject(item, "market snapshot"));
}

function diff(expected: unknown, actual: unknown, path: string): string[] {
  if (isObject(expected) && isObject(actual)) {
    const found: string[] = [];
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      const child = `${path}.${key}`;
      if (!(key in expected)) {
        found.push(`${child} missing`);
      } else if (!(key in actual)) {
        found.push(`${child} unexpected`);
      } else {
        found.push(...diff(expected[key], actual[key], child));
      }
    }
    return found;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const found: string[] = [];
    if (expected.length !== actual.length) {
      found.push(`${path} length mismatch`);
    }
    const count = Math.min(expected.length, actual.length);
    for (let index = 0; index < count; index += 1) {
      found.push(...diff(expected[index], actual[index], `${path}[${index}]`));
    }
    return found;
  }
  if (typeof expected !== typeof actual || expected !== actual) {
    return [`${path} mismatch`];
  }
  return [];
}

function report(mismatches: string[]): VerifyReport {
  const unique = dedupe(mismatches);
  if (unique.length > 0) {
    return { status: "MISMATCH", mismatches: unique };
  }
  return { status: "VERIFIED", mismatches: [] };
}

function dedupe(mismatches: string[]): string[] {
  const unique: string[] = [];
  for (const item of mismatches) {
    if (!unique.includes(item)) {
      unique.push(item);
    }
  }
  return unique;
}

function pushOnce(mismatches: string[], item: string): void {
  if (!mismatches.includes(item)) {
    mismatches.push(item);
  }
}

function sha256Bytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (isObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortValue(value[key]);
    }
    return sorted;
  }
  return value;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!isObject(value)) {
    return null;
  }
  return value;
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requiredString(value, label);
}

function whole(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "check failed";
}
