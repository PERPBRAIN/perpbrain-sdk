/** Read-only and simulation-only SDK surface. */

export {
  CODES,
  HARD_MAX_DAILY_LOSS_PCT,
  HARD_MAX_OPEN_POSITIONS,
  HARD_MAX_ORDER_RATE,
  HARD_MAX_SLIPPAGE_BPS,
  PRESETS,
  STALE_BLOCK_MS,
  STALE_HALT_MS,
  GuardBlocked,
  GuardConfigError,
  GuardLoosenError,
  GuardSession,
  defaultGuards,
  defaultSnapshot,
  fromConfig,
  survivalReport,
  wireCode,
} from "./guards.ts";
export type {
  GuardCode,
  GuardLimits,
  GuardOverrides,
  GuardResult,
  Guards,
  MarketSnapshot,
  PresetName,
  SimIntent,
  SurvivalDay,
  Violation,
} from "./guards.ts";
export { guardedSimulate } from "./guarded.ts";
export type { GuardedSimulateResult } from "./guarded.ts";
export { renderReceiptCard } from "./card.ts";
export { costBreakdownFromReceipt, RECEIPT_KIND, RECEIPT_STATEMENT, canonical, sha256Json, verifyReceipt } from "./receipt.ts";
export { executionCost } from "./vendor/costs.ts";
export type { CostBreakdown } from "./vendor/costs.ts";
export type { VerifyReport } from "./receipt.ts";
export { InfoClient } from "./vendor/info.ts";
export { fees, funding, markets, orderBook, positions } from "./vendor/queries.ts";
export { simulate } from "./vendor/simulate.ts";
export type {
  Bar,
  Book,
  Decision,
  Fill,
  FillGuard,
  GuardContext,
  SimulateResult,
} from "./vendor/simulate.ts";

export const READ_AND_SIM_TOOLS = [
  "markets",
  "order_book",
  "funding",
  "positions",
  "fees",
  "simulate",
  "get_limits",
  "trigger_kill_switch",
  "get_cost_breakdown",
] as const;
