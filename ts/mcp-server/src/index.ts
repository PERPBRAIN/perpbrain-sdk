import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const READ_SIM_TOOLS = [
  "markets",
  "order_book",
  "funding",
  "positions",
  "fees",
  "simulate",
  "funding_extremes",
  "book_imbalance",
  "get_limits",
  "trigger_kill_switch",
  "get_cost_breakdown",
  "verify_receipt",
] as const;

export type Command = "tools" | "simulate";

export interface PackageJson {
  name: string;
}

export interface SimResult {
  label: "SIMULATED";
  fills: readonly [];
  fillSource: "exchange";
  queue_position: "NOT_MODELLED";
  liquidation: "NOT_MODELLED";
}

export function distributionName(packageJsonPath?: string): string {
  const path =
    packageJsonPath ??
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isPackageJson(parsed)) {
    throw new Error("package.json is missing a name");
  }
  return parsed.name;
}

export function simulate(market: string): SimResult {
  if (market === "") {
    throw new Error("market is required");
  }
  return {
    label: "SIMULATED",
    fills: [],
    fillSource: "exchange",
    queue_position: "NOT_MODELLED",
    liquidation: "NOT_MODELLED",
  };
}

export function rejectOrderCommand(command: string): void {
  if (command === "order" || command === "submit-order" || command === "submit_order") {
    throw new Error("Phase 1 has no mainnet order path");
  }
}

export function run(command: string, market = "BTC"): string {
  rejectOrderCommand(command);
  if (!isCommand(command)) {
    throw new Error(`unknown command: ${command}`);
  }
  switch (command) {
    case "tools":
      return READ_SIM_TOOLS.join(",");
    case "simulate":
      return simulate(market).label;
    default: {
      const unexpected: never = command;
      return unexpected;
    }
  }
}

function isCommand(command: string): command is Command {
  return command === "tools" || command === "simulate";
}

function isPackageJson(value: unknown): value is PackageJson {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return typeof (value as { name?: unknown }).name === "string";
}
