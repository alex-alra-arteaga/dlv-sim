import { VaultParams } from "./src/charm/types";
import { LookUpPeriod } from "./src/enums";
import { setCurrentPoolConfig, WBTC_USDC_CONFIG, ETH_USDT_CONFIG } from "./src/pool-config";

// Initialize the pool configuration (this will be used throughout the application)
// To use a different pool, change this line to import and set a different configuration
setCurrentPoolConfig(ETH_USDT_CONFIG);

export const configLookUpPeriod = LookUpPeriod.FOUR_HOURLY; // Wouldn't recommend changing it, unless your machine is powerful enough

// Pool-agnostic vault configuration
// These parameters work for any pool but can be adjusted per pool if needed
/// @param: wideRangeWeight - Portion of total range allocated to wide range (in WAD, e.g. 100000 = 10%)
/// @param: wideThreshold - Width of wide range from current price (in ticks, e.g. 12000 = 12000 ticks)
/// @param: baseThreshold - Width of base range from current price (in ticks, e.g. 4800 = 4800 ticks)
/// @param: limitThreshold - Width of limit range from current price (in ticks, e.g. 1200 = 1200 ticks)
/// @param: period - Minimum time between rebalances (in seconds, e.g. 86400 * 2 = 2 days)
/// @param: deviationThreshold - Minimum price deviation to trigger a rebalance (e.g. 60:40 ratio, 5000 -> 50% deviation) TODO
// Allow overriding via env to support parallel brute-force runs without file patching
function parseEnvJSON<T>(envKey: string): T | undefined {
  const raw = process.env[envKey];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    console.warn(`Failed to parse ${envKey}:`, e);
    return undefined;
  }
}

export const charmConfig: VaultParams = (() => {
  const override = parseEnvJSON<VaultParams>("BF_CHARM_JSON");
  if (override) return override;
  return {
    wideRangeWeight: 150000,
    wideThreshold: 7980,
    baseThreshold: 3600,
    limitThreshold: 900,
    period: 172800,
  } satisfies VaultParams;
})();

// Leave either period or deviationThresholds undefined to disable that condition
// If both are defined, rebalances will be triggered when either condition is met
/// @param: period - Minimum time between debt rebalances (in seconds, e.g. 86400 * 2 = 2 days)
/// @param: deviationThresholdAbove - Minimum deviation above target ratio to trigger a rebalance (e.g. 0.2 -> 20% above 200% (i.e. 240%))
/// @param: deviationThresholdBelow - Minimum deviation below target ratio to trigger a rebalance (e.g. 0.05 -> 5% below 200% (i.e. 190%))
/// @param: debtToVolatileSwapFee - Estimated swap fee when swapping stable to volatile to repay debt (e.g. 0.0015 -> 0.15%)
export type DLVConfig = {
  period?: number;
  deviationThresholdAbove?: number;
  deviationThresholdBelow?: number;
  debtToVolatileSwapFee: number;
};

export const dlvConfig: DLVConfig = (() => {
  const override = parseEnvJSON<DLVConfig>("BF_DLV_JSON");
  if (override) return override;
  return {
    period: undefined,
    deviationThresholdAbove: 0.2,
    deviationThresholdBelow: 0.2,
    debtToVolatileSwapFee: 0.0015,
  } satisfies DLVConfig;
})();

export const BORROW_RATE = undefined; // TODO
export const managerFee = 0; // Swap fees taken by the manager (e.g. 0.1 = 10%)