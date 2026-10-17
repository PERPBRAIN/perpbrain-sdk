# Owner limits

Simulation limits live in `sdk/src/guards.ts`. These are limits you set; losses are still possible.

The owner picks a preset when the session starts. Standard is the default. A looser override at that moment needs `acknowledgeLoosenedLimits`. Inside a session the only change is `tighten`. There is no `loosen`, no setter, and no environment override. An MCP tool cannot set, raise, or clear a limit.

The book simulator checks the limits before it records a fill. The MCP handler and `guardedSimulate` pass the check in.

A blocked simulated order raises `GuardBlocked`. The code is `GUARD_BLOCKED:<CODE>`, with the headroom that is left. Equal to a numeric cap is allowed. The daily stop latches at the threshold and above.

## Presets

| Limit | Conservative | Standard (default) | Pro | Hard ceiling |
| --- | --- | --- | --- | --- |
| Max leverage, before the per-coin rule | 3x | 5x | 10x | The listed per-coin max |
| Per-order cap | Lesser of $10k and 20% of depth | Lesser of $25k and 20% of depth | Lesser of $250k and 20% of depth | 20% of depth |
| Daily stop, then reduce-only until 00:00 UTC | 3% | 5% | 10% | 25% |
| Open positions | 3 | 5 | 15 | 50 |
| Aggregate notional | $10k | $25k | $250k | No dollar ceiling when the per-order dollar amount is cleared |
| Max slippage | 25 bps | 50 bps | 100 bps | 300 bps |
| Order rate | 2/s | 5/s | 10/s | 10/s |
| Stale data | Block a new open after 2s. Halt a new open after 5s. A reduce or a close stays allowed. | Same | Same | Fixed rail |

`fromConfig(preset = "standard", overrides, acknowledgeLoosenedLimits = false)` builds the owner value, and `GuardSession.fromConfig(...)` starts a session with it. Tightening an override is always accepted. Loosening past the preset without the acknowledgement raises `GuardLoosenError`. Anything past a hard ceiling raises `GuardConfigError`.

## Depth, leverage, and the coin list

The per-order cap is the lesser of the preset dollar amount and 20% of visible book depth inside the slippage cap. Custom config with no dollar amount uses the depth share alone. An empty book blocks the order. A close is not subject to the cap.

The session keeps the open book. Aggregate notional is the sum of open coins, and the cap is the same preset dollar amount. A new coin counts as one position. Adding to a coin that is already open does not. A new open is blocked when the resulting count would pass the position cap, or when the sum would pass the dollar cap. Equal to either cap is allowed. Clearing the dollar amount removes the aggregate dollar cap and needs `acknowledgeLoosenedLimits`; the position ceiling stays 50. A reduce lowers that coin. A close removes it. A blocked open leaves the book unchanged. Reading headroom does not change the book. A restart starts an empty book. The kill-switch latch still follows the owner config hash.

Visible depth for a buy is the ask notional at or below the best ask widened by the slippage cap. For a sell it is the bid notional at or above the best bid tightened by that cap.

Effective leverage is the lesser of the preset and the cached per-coin max. A coin outside the top 20 by open interest is halved. The cache is the recorded public meta and open-interest sample, and its id is on the receipt. The coin list is that sample. A superset raises `GuardConfigError`. A subset is a tighter list.

## Stale data, the daily stop, and the kill switch

Data older than 2 seconds blocks a new open (`stale_data`). Data older than 5 seconds halts a new open (`stale_halt`). A reduce or a close is allowed at any age.

Once the day's loss reaches the stop, new opens stay blocked until the next 00:00 UTC (`daily_stop_reduce_only`). The order that reaches the stop is included. A reduce or a close is still allowed.

The kill switch latches (`kill_switch`). A tool call can engage it and cannot clear it. It clears only when the owner config changes and the session restarts. A restart with the same owner config keeps the latch. A reduce or a close is still allowed while it is engaged.

## Codes

`coin_not_allowed`, `notional_exceeded`, `aggregate_notional`, `depth_cap`, `leverage_exceeded`, `open_positions_exceeded`, `daily_stop_reduce_only`, `slippage_exceeded`, `order_rate`, `stale_data`, `stale_halt`, `kill_switch`.

## Receipt and the 30-day report

A simulated run records `guard_preset`, `limits`, `effective_limits_per_coin`, `loosened`, `limits_hash`, and `market_snapshot_id` on the receipt. `loosened` is true when an acknowledged override is looser than the named preset. There is no leaderboard and no list of accounts.

`survivalReport` aggregates 30 days by preset. The share is the accounts that did not reach a daily stop and did not engage the kill switch. The report names no account.

