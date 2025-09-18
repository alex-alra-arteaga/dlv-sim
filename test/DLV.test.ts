import JSBI from "jsbi";
import {
  CorePoolView,
  EventDBManager,
  getDate,
  mul10pow,
  get10pow,
  toJSBI,
} from "@bella-defintech/uniswap-v3-simulator";
import { mul, safeToBN } from "../src/utils";
import { BigNumber as BN } from "ethers";
import { buildStrategy, CommonVariables, Phase, Rebalance } from "../src/strategy.ts";
import { Engine } from "../src/engine.ts";
import { MaxUint128, TARGET_CR, ZERO } from "../src/internal_constants.ts";
import { LogDBManager } from "./LogDBManager.ts";
import { charmConfig, dlvConfig, configLookUpPeriod } from "../config.ts";
import { AlphaProVault } from "../src/charm/alpha-pro-vault.ts";

export interface RebalanceLog {
  wide0: number;
  wide1: number;
  base0: number;
  base1: number;
  limit0: number;
  limit1: number;
  total0: BN;
  total1: BN;
  nonVolatileAssetPrice: BN;
  prevTotalPoolValue: BN;
  afterTotalPoolValue: BN;
  lpRatio: BN;
  swapFeeUSDC: BN;
  prevCollateralRatio: BN;
  afterCollateralRatio: BN;
  accumulatedSwapFees0: BN;
  accumulatedSwapFees1: BN;
  // IL tracking fields
  btcHoldValueUSDC: BN; // Value of individual holdings at next period's price
  realizedIL: BN; // IL as percentage (scaled by 10000 for precision)
  swapFeesGainedThisPeriod: BN; // Swap fees gained between periods
  date: Date;
}

describe("DLV Strategy", function () {
  const eventDBManagerPath =
    "data/WBTC-USDC_0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35.db";
  const rebalanceLogDBManagerPath = "rebalance_log_usdc_wbtc_3000.db";
  let logDB: LogDBManager;

  beforeEach(async function () {
    logDB = new LogDBManager(rebalanceLogDBManagerPath);
    await logDB.initTables();
    await logDB.clearRebalanceLog(); // Clear previous run data
  });

  afterEach(async function () {
    await logDB.close();
  });

  it("can run backtest", async function () {
    const TICK_COUNT = "tickCount";
    const DLV_CALLS  = "dlvCalls";
    const ALM_CALLS  = "almCalls";
    
    // IL tracking variables - track values between consecutive periods
    let previousAfterTotalPoolValue: JSBI | null = null; // <-- GAV at end of previous interval
    let previousTotalAmounts: { total0: JSBI; total1: JSBI } | null = null;
    let previousAccumulatedSwapFees: { fees0: JSBI; fees1: JSBI } | null = null;
    
    // set priceWindow for strategy
    if (charmConfig.period % configLookUpPeriod !== 0) {
      throw new Error(
        "charmConfig.period has to be divisible by configLookUpPeriod"
      );
    }
    if (dlvConfig.period !== undefined && dlvConfig.period % configLookUpPeriod !== 0) {
      throw new Error(
        "dlvConfig.period has to be divisible by configLookUpPeriod"
      );
    }
    let charmRebalancePeriod = charmConfig.period / configLookUpPeriod;
    let dlvRebalancePeriod = dlvConfig.period ? dlvConfig.period / configLookUpPeriod : Number(MaxUint128);

    // Low amount to not vary too much the historical price of the pool
    // represent amounts as integers before scaling to avoid BigNumber.from decimal underflow
    // 0.01 WBTC with 8 decimals => 0.01 * 10^8 = 1_000_000
    let initialBTCAmount: JSBI = toJSBI(mul10pow(BN.from(1), 6)); // 8 decimals, $572.14, at 4th May 2021, WBTC-USDC pool deployment
    // 572.14 USDC with 6 decimals => 572.14 * 10^6 = 572_140_000
    // let initialUSDCAmount: JSBI = toJSBI(mul10pow(BN.from(57214), 4)); // 6 decimals

    let startDate = getDate(2021, 5, 6);
    let endDate = getDate(2024, 12, 15);

    let trigger = async function (
      phase: Phase,
      rebalance: Rebalance,
      _corePoolView: CorePoolView,
      vault: AlphaProVault,
      variable: Map<string, any>
    ) {
      switch (phase) {
        case Phase.AFTER_NEW_TIME_PERIOD: {
          const count = (variable.get(TICK_COUNT) as number) ?? 0;

          if (rebalance === Rebalance.ALM) {
            return count % charmRebalancePeriod === 0;
          }

          if (rebalance === Rebalance.DLV) {
            if (count % dlvRebalancePeriod === 0) return true;
            return !(await isWithinCrDeviationThreshold(vault));
          }

          return false;
        }
        case Phase.AFTER_EVENT_APPLIED:
          return false;
      }
    };

    let cache = function (
      phase: Phase,
      corePoolView: CorePoolView,
      variable: Map<string, any>
    ) {
      switch (phase) {
        case Phase.AFTER_NEW_TIME_PERIOD:
          const prev = (variable.get(TICK_COUNT) as number) ?? 0;
          variable.set(TICK_COUNT, prev + 1);
          break;
        case Phase.AFTER_EVENT_APPLIED:
          break;
      }
    };


// --- helpers (unchanged) ---
const BPS_SCALE = JSBI.BigInt(10_000);
const ZERO = JSBI.BigInt(0);
const isPos = (x: JSBI) => JSBI.greaterThan(x, ZERO);
// round-half-up
function divRound(n: JSBI, d: JSBI): JSBI {
  if (!isPos(d)) return ZERO;
  const half = JSBI.divide(d, JSBI.BigInt(2));
  return JSBI.divide(JSBI.add(n, half), d);
}

const act = async function (
  phase: Phase,
  rebalance: Rebalance,
  engine: Engine,
  _corePoolView: CorePoolView,
  vault: AlphaProVault,
  variable: Map<string, any>
): Promise<void> {
  switch (phase) {
    case Phase.AFTER_NEW_TIME_PERIOD: {
      const currPrice = vault.poolPrice(vault.pool.sqrtPriceX96);
      const startAmounts = await vault.getTotalAmounts(); // gross token balances now
      const wbtcUSDC_now = vault.btcRawToUsdcRaw(startAmounts.total0, currPrice);
      const gavStart = JSBI.add(startAmounts.total1, wbtcUSDC_now); // for logging only

      // NAV source of truth
      const prevTotalPoolValue = await vault.totalPoolValue(); // NAV_t_start
      const debtNow = vault.virtualDebt; // constant between rebalances

      console.log("[START] price:", currPrice.toString());
      console.log("[START] amounts.total0 (WBTC raw):", startAmounts.total0.toString());
      console.log("[START] amounts.total1 (USDC raw):", startAmounts.total1.toString());
      console.log("[START] GAV:", gavStart.toString());
      console.log("[START] NAV (totalPoolValue):", prevTotalPoolValue.toString());
      console.log("[START] virtualDebt:", debtNow.toString());

      const prevCollateralRatioNum = await vault.collateralRatio();
      const prevCollateralRatio = Number.isFinite(prevCollateralRatioNum)
        ? safeToBN(Math.round(prevCollateralRatioNum * 100))
        : safeToBN(0);

      const feesSnapStart = vault.getTotalSwapFeesRaw(); // Use total fees (collected + uncollected)
      console.log("[START] feesSnapStart.fees0 (WBTC):", feesSnapStart.fees0.toString());
      console.log("[START] feesSnapStart.fees1 (USDC):", feesSnapStart.fees1.toString());

      // ---------- IL compute (t-1 → t), NAV-consistent ----------
      let realizedIL_bps_inclFees = ZERO;
      let realizedIL_bps_exFees = ZERO;
      let feesDeltaUSDC = ZERO;
      let hodlNowUSDC = ZERO;     // HODL GAV
      let hodlNowNAV_USDC = ZERO; // HODL NAV

      if (
        previousAfterTotalPoolValue !== null &&
        previousTotalAmounts !== null &&
        previousAccumulatedSwapFees !== null
      ) {
        const denomNAV = previousAfterTotalPoolValue; // NAV_{t-1} (post-prev-rebalance)
        console.log("[PREV] NAV_{t-1}:", denomNAV.toString());
        console.log("[PREV] amounts.total0:", previousTotalAmounts.total0.toString());
        console.log("[PREV] amounts.total1:", previousTotalAmounts.total1.toString());
        console.log("[PREV] feesSnapEnd.fees0:", previousAccumulatedSwapFees.fees0.toString());
        console.log("[PREV] feesSnapEnd.fees1:", previousAccumulatedSwapFees.fees1.toString());

        // fees Δ during (t-1, t] at current price, BEFORE any collection at t
        const dFees0 = JSBI.subtract(feesSnapStart.fees0, previousAccumulatedSwapFees.fees0);
        const dFees1 = JSBI.subtract(feesSnapStart.fees1, previousAccumulatedSwapFees.fees1);
        const dFees0_USDC = vault.btcRawToUsdcRaw(dFees0, currPrice);
        feesDeltaUSDC = JSBI.add(dFees1, dFees0_USDC);

        console.log("[ΔFEES] dFees0 (WBTC):", dFees0.toString());
        console.log("[ΔFEES] dFees1 (USDC):", dFees1.toString());
        console.log("[ΔFEES] dFees0_USDC:", dFees0_USDC.toString());
        console.log("[ΔFEES] feesDeltaUSDC:", feesDeltaUSDC.toString());

        // HODL baseline @ t (reprice prev amounts)
        const wbtcPrevNow_USDC = vault.btcRawToUsdcRaw(previousTotalAmounts.total0, currPrice);
        hodlNowUSDC = JSBI.add(wbtcPrevNow_USDC, previousTotalAmounts.total1);
        hodlNowNAV_USDC = JSBI.greaterThan(hodlNowUSDC, debtNow)
          ? JSBI.subtract(hodlNowUSDC, debtNow)
          : ZERO; // clamp

        console.log("[HODL] hodlNowUSDC (GAV):", hodlNowUSDC.toString());
        console.log("[HODL] hodlNowNAV_USDC (NAV):", hodlNowNAV_USDC.toString());

        // IL including fees: (NAV_lp_t − NAV_hodl_t) / NAV_{t-1}
        const numIncl = JSBI.subtract(prevTotalPoolValue, hodlNowNAV_USDC);
        realizedIL_bps_inclFees = isPos(denomNAV)
          ? divRound(JSBI.multiply(numIncl, BPS_SCALE), denomNAV)
          : ZERO;

        // IL excluding fees: (NAV_lp_t − feesΔ − NAV_hodl_t) / NAV_{t-1}
        const lpExFees = JSBI.subtract(prevTotalPoolValue, feesDeltaUSDC);
        const numEx = JSBI.subtract(lpExFees, hodlNowNAV_USDC);
        realizedIL_bps_exFees = isPos(denomNAV)
          ? divRound(JSBI.multiply(numEx, BPS_SCALE), denomNAV)
          : ZERO;

        console.log("[IL] numIncl:", numIncl.toString());
        console.log("[IL] numEx:", numEx.toString());
        console.log("[IL] IL_bps_inclFees:", realizedIL_bps_inclFees.toString());
        console.log("[IL] IL_bps_exFees:", realizedIL_bps_exFees.toString());
      } else {
        console.log("[INIT] No previous snapshots yet; IL not computed this tick.");
      }

      // ---------- REBALANCE / OPS ----------
      const willRebalance = rebalance === Rebalance.ALM || rebalance === Rebalance.DLV;
      console.log("[REB] willRebalance:", willRebalance);

      let swapFeeUSDC = JSBI.BigInt(0);
      if (rebalance === Rebalance.ALM) {
        await vault.rebalance(engine);
        variable.set(ALM_CALLS, ((variable.get(ALM_CALLS) as number) ?? 0) + 1);
      } else if (rebalance === Rebalance.DLV) {
        swapFeeUSDC = await vault.rebalanceDebt(engine);
        variable.set(DLV_CALLS, ((variable.get(DLV_CALLS) as number) ?? 0) + 1);
      }

      // ---------- END (after ops) ----------
      const positions = await vault.getPositions();
      const totalAmounts = await vault.getTotalAmounts();
      const afterCollateralRatioNum = await vault.collateralRatio();
      const afterCollateralRatio = Number.isFinite(afterCollateralRatioNum)
        ? safeToBN(Math.round(afterCollateralRatioNum * 100))
        : safeToBN(0);

      const accumulatedSwapFeesRaw = vault.getAccumulatedSwapFeesRaw();
      const currentTotalValueUSDC = await vault.totalPoolValue(); // NAV_t_end
      const date = variable.get(CommonVariables.DATE) as Date;

      console.log("[END] accumulatedSwapFeesRaw.fees0:", accumulatedSwapFeesRaw.fees0.toString());
      console.log("[END] accumulatedSwapFeesRaw.fees1:", accumulatedSwapFeesRaw.fees1.toString());
      console.log("[END] NAV_t_end:", currentTotalValueUSDC.toString());

      // ---------- LOG (unchanged schema/fields) ----------
      const newLog: RebalanceLog = {
        wide0: positions[0][0],
        wide1: positions[0][1],
        base0: positions[1][0],
        base1: positions[1][1],
        limit0: positions[2][0],
        limit1: positions[2][1],
        total0: safeToBN(totalAmounts.total0),
        total1: safeToBN(totalAmounts.total1),
        nonVolatileAssetPrice: safeToBN(currPrice),
        prevTotalPoolValue: safeToBN(prevTotalPoolValue),       // NAV_t_start
        afterTotalPoolValue: safeToBN(currentTotalValueUSDC),   // NAV_t_end
        lpRatio: safeToBN(await vault.lpRatio(true)),
        swapFeeUSDC: safeToBN(swapFeeUSDC),
        prevCollateralRatio,
        afterCollateralRatio,
        accumulatedSwapFees0: safeToBN(accumulatedSwapFeesRaw.fees0),
        accumulatedSwapFees1: safeToBN(accumulatedSwapFeesRaw.fees1),
        btcHoldValueUSDC: safeToBN(hodlNowUSDC),
        // realizedIL = bps EX-FEES (NAV-based)
        realizedIL: safeToBN(realizedIL_bps_exFees),
        swapFeesGainedThisPeriod: safeToBN(feesDeltaUSDC),
        date,
      };

      await logDB.persistRebalanceLog(newLog);

      // ---------- UPDATE SNAPSHOTS FOR NEXT PERIOD ----------
      previousAfterTotalPoolValue = currentTotalValueUSDC; // NAV end-of-period
      previousTotalAmounts = totalAmounts;                 // amounts end-of-period
      previousAccumulatedSwapFees = accumulatedSwapFeesRaw; // fees snapshot end-of-period

      break;
    }
    case Phase.AFTER_EVENT_APPLIED:
      break;
  }
};




    let evaluate = async function (
      corePoolView: CorePoolView,
      variable: Map<string, any>,
      vault: AlphaProVault
    ) {
      console.log("success!");
      console.log("periods processed:", (variable.get(TICK_COUNT) as number) ?? 0);
      console.log("ALM calls:", (variable.get(ALM_CALLS) as number) ?? 0);
      console.log("DLV calls:", (variable.get(DLV_CALLS) as number) ?? 0);
    
      const poolValue = await vault.totalPoolValue();
      console.log("position USDC value:", poolValue.toString());
    
      const lpRatio = await vault.lpRatio(true);
      console.log("lpRatio (WAD):", lpRatio.toString());
    
      const cr = await vault.collateralRatio();
      console.log("collateral ratio (%):", Number.isFinite(cr) ? cr : "infinite");
    
      const totalAmounts = await vault.getTotalAmounts();
      console.log(`total amounts: ${totalAmounts.total0.toString()} WBTC, ${totalAmounts.total1.toString()} USDC`);
    
      const price = vault.poolPrice(vault.pool.sqrtPriceX96);
      console.log("current price (USDC per WBTC, WAD):", price.toString());
    
      const virtualDebt = vault.virtualDebt;
      console.log("virtual debt (USDC):", virtualDebt.toString());
    };

    // Make sure the DB has been initialized, and see scripts/EventsDownloaders
    // if you want to update the events.
    let eventDB = await EventDBManager.buildInstance(eventDBManagerPath);
    let strategy = await buildStrategy(
      eventDB,
      trigger,
      cache,
      act,
      evaluate
    );

  await strategy.backtest(startDate, endDate, configLookUpPeriod, initialBTCAmount, toJSBI(0));

    await strategy.shutdown();
  });
});


async function isWithinCrDeviationThreshold(vault: AlphaProVault): Promise<boolean> {
  const crPercent = await vault.collateralRatio(); // returns percent, e.g. ~200
  const thresholdAbove = dlvConfig.deviationThresholdAbove ?? 0;
  const thresholdBelow = dlvConfig.deviationThresholdBelow ?? 0;

  if (thresholdAbove === 0 && thresholdBelow === 0) return true;
  // if infinite collateral ratio (no debt), consider it within threshold
  if (!Number.isFinite(crPercent)) return true;

  // TARGET_CR is WAD (e.g., 2e18); convert to percent (e.g., 200)
  const TARGET_CR_PERCENT = Number(TARGET_CR) / 1e16;

  if (crPercent > TARGET_CR_PERCENT) {
    if (thresholdAbove === 0) return true;
    const deviation = (crPercent - TARGET_CR_PERCENT) / TARGET_CR_PERCENT;
    return deviation < thresholdAbove;
  } else if (crPercent < TARGET_CR_PERCENT) {
    if (thresholdBelow === 0) return true;
    const deviation = (TARGET_CR_PERCENT - crPercent) / TARGET_CR_PERCENT;
    return deviation < thresholdBelow;
  } else {
    return true; // exactly at target
  }
}