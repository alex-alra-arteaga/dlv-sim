import { VaultParams } from "./src/charm/types";
import { LookUpPeriod } from "./src/enums";
import { dateUtc } from "./src/utils";

export const configLookUpPeriod = LookUpPeriod.FOUR_HOURLY;

// WBTC-NECT 0.3% current params
export const charmConfig: VaultParams = {
  managerFee: 0,
  wideRangeWeight: 100000, // 10%
  wideThreshold: 12000,
  baseThreshold: 1020,
  limitThreshold: 2400,
  period: 28800, // 8 hours, actual period between rebalances, not min enforced period, has to be divisible by seconds of lookUpPeriod
  // "deviationThreshold": 0.05, // 5%
  minTickMove: 0,
};

// Leave either period or deviationThreshold undefined to disable that condition
// If both are defined, rebalances will be triggered when either condition is met
export const dlvConfig = {
  period: undefined, // 2 days, TODO if set very often it may be possible for rebalanceDebt::deposit to revert because of one of the amounts being 0
  deviationThreshold: 0.2, // 20%
  debtToVolatileSwapFee: 0.0015, // 0.15%
};

export const startDate = dateUtc(2021, 5, 6);
export const endDate = dateUtc(2024, 12, 18); // TODO

export const BORROW_RATE = undefined; // TODO
