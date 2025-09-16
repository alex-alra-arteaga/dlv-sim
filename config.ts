import { VaultParams } from "./src/charm/types";
import { LookUpPeriod } from "./src/enums";

export const configLookUpPeriod = LookUpPeriod.FOUR_HOURLY; // Wouldn't recommend changing it, unless your machine is powerful enough

// WBTC-NECT 0.3% current params
/// @dev Important to have ticks (thresholds) being divisible by the tick spacing (10 for 5bp, 60 for 30bp, 200 for 1%)
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