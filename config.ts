import { VaultParams } from "./src/charm/types";
import { LookUpPeriod } from "./src/enums";
import { setCurrentPoolConfig, ETH_USDT_CONFIG, WBTC_USDC_CONFIG } from "./src/pool-config";

// Initialize the pool configuration (this will be used throughout the application)
// To use a different pool, change this line to import and set a different configuration
setCurrentPoolConfig(WBTC_USDC_CONFIG);

export const configLookUpPeriod = LookUpPeriod.FOUR_HOURLY; // Wouldn't recommend changing it, unless your machine is powerful enough

// Pool-agnostic vault configuration
// These parameters work for any pool but can be adjusted per pool if needed
export const charmConfig: VaultParams = {
  managerFee: 0,
  wideRangeWeight: 100000, // 10%
  wideThreshold: 12000,
  baseThreshold: 3600,
  limitThreshold: 1200,
  period: 86400, // 3 days, actual period between rebalances, not min enforced period, has to be divisible by seconds of lookUpPeriod
  // "deviationThreshold": 0.05, // 5%
  minTickMove: 0 // wouldn't change it
};

// Leave either period or deviationThresholds undefined to disable that condition
// If both are defined, rebalances will be triggered when either condition is met
export const dlvConfig = {
  period: undefined, // TODO if set very often it may be possible for rebalanceDebt::deposit to revert because of one of the amounts being 0
  deviationThresholdAbove: 0.2, // 0.2 -> 20% above 200%
  deviationThresholdBelow: 0.05, // 0.05 -> 5% below 200%
  debtToVolatileSwapFee: 0.0015, // 0.15%
};

export const BORROW_RATE = undefined; // TODO