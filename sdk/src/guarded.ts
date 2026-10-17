/** Book simulation that records a fill only after the owner limits accept it. */

import { GuardBlocked, GuardSession, wireCode, type DepthBook, type PresetName, type SimIntent } from "./guards.ts";
import {
  HL_FUNDING_INTERVAL_MS,
  simulate,
  type Bar,
  type Book,
  type Decision,
  type FillGuard,
  type FundingSample,
  type GuardContext,
  type SimulateResult,
} from "./vendor/simulate.ts";

export interface GuardedSimulateResult extends SimulateResult {
  guardPreset: string;
  limits: Record<string, unknown>;
  effectiveLimitsPerCoin: Record<string, unknown>;
  loosened: boolean;
  limitsHash: string;
  marketSnapshotId: string;
}

export function guardedSimulate(
  market: string,
  decision: Decision,
  bars: Bar[],
  book: Book,
  feeVersion: string | null = null,
  guardContext: GuardContext | null = null,
  preset: PresetName = "standard",
  session: GuardSession | null = null,
  funding: FundingSample[] | null = null,
  fundingIntervalMs: number = HL_FUNDING_INTERVAL_MS,
): GuardedSimulateResult {
  const active = session ?? GuardSession.fromConfig(preset);
  const seen: ReturnType<GuardSession["check"]>[] = [];
  const guard: FillGuard = (intent) => {
    const checked: SimIntent = {
      coin: intent.coin,
      notionalUsd: intent.notionalUsd,
      leverage: intent.leverage,
      openPositions: intent.openPositions,
      slippageBps: intent.slippageBps,
      ageMs: intent.ageMs,
      dailyLossPct: intent.dailyLossPct,
      opening: intent.opening,
      orderSide: intent.orderSide,
      nowMs: intent.nowMs,
    };
    const result = active.check(checked, { book: book as DepthBook });
    seen.push(result);
    return { ok: result.ok, violations: result.violations.map((item) => item.code) };
  };
  const simulated = simulate(
    market,
    decision,
    bars,
    book,
    feeVersion,
    guard,
    guardContext,
    funding,
    fundingIntervalMs,
  );
  const receipt = active.limits.receipt();
  const body: GuardedSimulateResult = {
    ...simulated,
    guardPreset: String(receipt.guardPreset),
    limits: receipt.limits as Record<string, unknown>,
    effectiveLimitsPerCoin: receipt.effectiveLimitsPerCoin as Record<string, unknown>,
    loosened: receipt.loosened === true,
    limitsHash: String(receipt.limitsHash),
    marketSnapshotId: String(receipt.marketSnapshotId),
  };
  const last = seen.at(-1);
  if (last !== undefined && !last.ok) {
    body.guardViolations = last.violations.map((item) => item.code);
    const violation = last.violations[0];
    if (violation === undefined) {
      throw new Error("blocked result is missing a violation");
    }
    throw new GuardBlocked(last.violations, last.headroom, {
      ...body,
      error: wireCode(violation.code),
      headroom: last.headroom,
    });
  }
  return body;
}
