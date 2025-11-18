import JSBI from "jsbi";
import {
  EventDBManager,
  getDate
} from "@bella-defintech/uniswap-v3-simulator";
import { safeToBN, FEE_DEN, mulDiv } from "../src/utils";
import { BigNumber as BN } from "ethers";
import { buildStrategy, CommonVariables, Phase, Rebalance } from "../src/strategy";
import { Engine } from "../src/engine";
import { MaxUint128 } from "../src/internal_constants";
import { LogDBManager } from "./LogDBManager";
import { charmConfig, dlvConfig, configLookUpPeriod, isDebtNeuralRebalancing, isALMNeuralRebalancing, targetCR, setTargetCR, debtAgentConfig, almAgentConfig, activeRebalanceRatioDeviationBps, debtToVolatileSwapFee, activeRebalanceMode, ActiveRebalanceMode } from "../config";
import { AlphaProVault, ExternalRebalanceParams } from "../src/charm/alpha-pro-vault";
import { getCurrentPoolConfig, PoolConfigManager } from "../src/pool-config";
import { DebtNeuralAgent } from "../src/neural-agent/debt-neural-agent";
import { ALMNeuralAgent } from "../src/neural-agent/alm-neural-agent";

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
  swapFeeStable: BN;
  almSwapFeeStable?: BN;
  prevCollateralRatio: BN;
  afterCollateralRatio: BN;
  accumulatedSwapFees0: BN;
  accumulatedSwapFees1: BN;
  debt: BN;
  rebalanceType: "ALM" | "DLV";
  // IL tracking fields
  volatileHoldValueStable: BN; // Value of individual holdings at next period's price
  realizedIL: BN; // IL as percentage (scaled by 10000 for precision)
  swapFeesGainedThisPeriod: BN; // Swap fees gained between periods
  date: Date;
}

// APY calculation function
function calculateAPY(data: Array<{t: number, vaultValue: number, price: number}>) {
  if (!data.length || data.length < 2) return { vault: 0, hold: 0, diff: 0 };
  
  const first = data[0];
  const last = data[data.length - 1];
  const daysDiff = (last.t - first.t) / (1000 * 60 * 60 * 24);
  
  if (daysDiff <= 0) return { vault: 0, hold: 0, diff: 0 };
  
  // Calculate returns
  const vaultReturn = (last.vaultValue / first.vaultValue) - 1;
  const holdReturn = ((last.price * 0.01) / (first.price * 0.01)) - 1;
  
  // Annualize (compound)
  const vaultAPY = (Math.pow(1 + vaultReturn, 365 / daysDiff) - 1) * 100;
  const holdAPY = (Math.pow(1 + holdReturn, 365 / daysDiff) - 1) * 100;
  const diffAPY = vaultAPY - holdAPY;
  
  return { vault: vaultAPY, hold: holdAPY, diff: diffAPY };
}

describe("DLV Strategy", function () {
  let poolConfig: PoolConfigManager;
  let eventDBManagerPath: string;
  let rebalanceLogDBManagerPath: string;
  let logDB: LogDBManager;

  beforeEach(async function () {
    // Use pool configuration from config.ts (single source of truth)
    poolConfig = getCurrentPoolConfig();
    eventDBManagerPath = poolConfig.getDbPath();
    rebalanceLogDBManagerPath = poolConfig.getRebalanceLogDbPath();
    
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
    
    // Array to collect data points for APY calculation
    const rebalanceLog: Array<{t: number, vaultValue: number, price: number}> = [];
    const debtNeuralAgent = new DebtNeuralAgent(debtAgentConfig);
    const almNeuralAgent = new ALMNeuralAgent(almAgentConfig);
    
    // IL tracking variables - track values between consecutive periods
    let previousAfterTotalPoolValue: JSBI | null = null; // <-- GAV at end of previous interval
    let previousTotalAmounts: { total0: JSBI; total1: JSBI } | null = null;
    let previousTotalSwapFees: { fees0: JSBI; fees1: JSBI } | null = null;
    
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

    let startDate = getDate(2021, 5, 6);
    let endDate = getDate(2024, 12, 15);

    // // For brute-force testing, use shorter period to speed up execution
    // if (process.env.BRUTE_FORCE === 'true') {
    //   endDate = getDate(2021, 12, 6); // Use only ~3 months for brute-force
    // }

    let trigger = async function (
      phase: Phase,
      rebalance: Rebalance,
      vault: AlphaProVault,
      variable: Map<string, any>
    ) {
      switch (phase) {
        case Phase.AFTER_NEW_TIME_PERIOD: {
          const count = (variable.get(TICK_COUNT) as number) ?? 0;

          if (rebalance === Rebalance.ALM) {
            if (isALMNeuralRebalancing) {
              const decision = await almNeuralAgent.shouldRebalance({
                vault,
                metadata: variable as Map<string, unknown>,
              });
              console.log(`[ALM Neural Agent] Decision: ${decision ? "rebalance" : "skip"}`);
              return decision;
            }
            return count % charmRebalancePeriod === 0;
          }

          if (rebalance === Rebalance.DLV) {
            if (count % dlvRebalancePeriod === 0) return true;
            if (isDebtNeuralRebalancing) {
              const agentTarget = await debtNeuralAgent.recommendTargetCR({
                vault,
                metadata: variable as Map<string, unknown>,
              });
              console.log("Debt Neural Agent recommended target CR:", agentTarget ? (Number(agentTarget) / 1e16).toFixed(2) + "%" : "no change");
              if (!agentTarget) return false;
              setTargetCR(agentTarget);
            }
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


// --- helper constants and active rebalance plumbing ---
const BPS_SCALE = JSBI.BigInt(10_000);
const HALF_BPS = JSBI.BigInt(5_000);
const ZERO = JSBI.BigInt(0);
const ONE = JSBI.BigInt(1);
const TWO = JSBI.BigInt(2);
const parsedActiveRebalanceBps = Number(activeRebalanceRatioDeviationBps ?? 0);
const activeRebalanceThresholdNumeric = Number.isFinite(parsedActiveRebalanceBps)
  ? Math.max(0, Math.floor(parsedActiveRebalanceBps))
  : 0;
const ACTIVE_REBALANCE_THRESHOLD_BPS = JSBI.BigInt(activeRebalanceThresholdNumeric);
const feeDenNumeric = Number(FEE_DEN.toString());
const parsedSwapFee = Number(debtToVolatileSwapFee ?? 0);
const swapFeeClamped = Math.min(Math.max(Number.isFinite(parsedSwapFee) ? parsedSwapFee : 0, 0), 1);
const SWAP_FEE_NUM = JSBI.BigInt(Math.floor(swapFeeClamped * feeDenNumeric));
const ONE_MINUS_SWAP_FEE = JSBI.greaterThan(SWAP_FEE_NUM, ZERO)
  ? JSBI.subtract(FEE_DEN, SWAP_FEE_NUM)
  : FEE_DEN;
const ACTIVE_REBALANCE_VALUE_DIVISOR = JSBI.subtract(JSBI.multiply(FEE_DEN, TWO), SWAP_FEE_NUM);
const isPos = (x: JSBI) => JSBI.greaterThan(x, ZERO);
// round-half-up
function divRound(n: JSBI, d: JSBI): JSBI {
  if (!isPos(d)) return ZERO;
  const half = JSBI.divide(d, JSBI.BigInt(2));
  return JSBI.divide(JSBI.add(n, half), d);
}

function shareDeviationBpsFromValues(stableValue: JSBI, volatileValueInStable: JSBI): JSBI {
  const totalValue = JSBI.add(stableValue, volatileValueInStable);
  if (!isPos(totalValue)) return ZERO;
  const scaledStable = JSBI.multiply(stableValue, BPS_SCALE);
  const stableShareBps = divRound(scaledStable, totalValue);
  return JSBI.greaterThan(stableShareBps, HALF_BPS)
    ? JSBI.subtract(stableShareBps, HALF_BPS)
    : JSBI.subtract(HALF_BPS, stableShareBps);
}

function computeStableValueToSwap(diff: JSBI): JSBI {
  if (!isPos(diff)) return ZERO;
  if (!isPos(ACTIVE_REBALANCE_VALUE_DIVISOR)) return ZERO;
  const numerator = JSBI.multiply(diff, FEE_DEN);
  const value = divRound(numerator, ACTIVE_REBALANCE_VALUE_DIVISOR);
  return JSBI.greaterThan(value, ZERO) ? value : ONE;
}

function evaluateZeroForOneCandidate(
  vault: AlphaProVault,
  priceWad: JSBI,
  totals: { total0: JSBI; total1: JSBI },
  amount: JSBI
): { diff: JSBI; ratioTol: JSBI; comparison: number } | null {
  if (!isPos(amount) || JSBI.greaterThan(amount, totals.total0)) return null;
  const remainingVolatile = JSBI.subtract(totals.total0, amount);
  const stableGainRaw = vault.volatileToStableValue(amount, priceWad);
  const stableGain = mulDiv(stableGainRaw, ONE_MINUS_SWAP_FEE, FEE_DEN);
  const stableAfter = JSBI.add(totals.total1, stableGain);
  const volatileValueAfter = vault.volatileToStableValue(remainingVolatile, priceWad);
  const volatileGreater = JSBI.greaterThan(volatileValueAfter, stableAfter);
  const stableGreater = JSBI.greaterThan(stableAfter, volatileValueAfter);
  const diff = volatileGreater
    ? JSBI.subtract(volatileValueAfter, stableAfter)
    : JSBI.subtract(stableAfter, volatileValueAfter);
  const reference = volatileGreater ? volatileValueAfter : stableAfter;
  const ratioTol = JSBI.equal(reference, ZERO) ? ZERO : JSBI.divide(reference, BPS_SCALE);
  const comparison = volatileGreater ? 1 : stableGreater ? -1 : 0;
  return { diff, ratioTol, comparison };
}

function findZeroForOneSwapAmount(
  vault: AlphaProVault,
  priceWad: JSBI,
  totals: { total0: JSBI; total1: JSBI }
): JSBI | null {
  if (!isPos(totals.total0)) return null;
  let lo = ONE;
  let hi = totals.total0;
  let candidate: JSBI | null = null;

  while (JSBI.lessThanOrEqual(lo, hi)) {
    const mid = divRound(JSBI.add(lo, hi), TWO);
    if (!isPos(mid)) break;

    const evaluation = evaluateZeroForOneCandidate(vault, priceWad, totals, mid);
    if (!evaluation) break;

    const { diff, ratioTol, comparison } = evaluation;
    if (JSBI.lessThanOrEqual(diff, ratioTol)) {
      candidate = mid;
      if (JSBI.equal(mid, ONE)) break;
      hi = JSBI.subtract(mid, ONE);
    } else if (comparison > 0) {
      lo = JSBI.add(mid, ONE);
    } else if (comparison < 0) {
      if (JSBI.equal(mid, ONE)) break;
      hi = JSBI.subtract(mid, ONE);
    } else {
      if (JSBI.equal(mid, ONE)) break;
      hi = JSBI.subtract(mid, ONE);
    }
  }

  if (!candidate) return null;
  const finalEval = evaluateZeroForOneCandidate(vault, priceWad, totals, candidate);
  if (!finalEval) return null;
  return JSBI.lessThanOrEqual(finalEval.diff, finalEval.ratioTol) ? candidate : null;
}

async function maybeExecuteActiveRebalance(
  vault: AlphaProVault,
  engine: Engine,
  totals: { total0: JSBI; total1: JSBI },
  priceWad: JSBI
): Promise<JSBI | null> {
  if (!isPos(ACTIVE_REBALANCE_THRESHOLD_BPS)) return null;

  const stableValue = totals.total1;
  const volatileValueInStable = vault.volatileToStableValue(totals.total0, priceWad);
  const deviationBps = shareDeviationBpsFromValues(stableValue, volatileValueInStable);
  if (JSBI.lessThan(deviationBps, ACTIVE_REBALANCE_THRESHOLD_BPS)) return null;

  const isStableHeavy = JSBI.greaterThan(stableValue, volatileValueInStable);
  const diff = isStableHeavy
    ? JSBI.subtract(stableValue, volatileValueInStable)
    : JSBI.subtract(volatileValueInStable, stableValue);

  const stableValueToSwap = computeStableValueToSwap(diff);
  if (!isPos(stableValueToSwap)) return null;

  let params: ExternalRebalanceParams;
  if (isStableHeavy) {
    params = {
      isZeroForOne: false,
      sentAmount: stableValueToSwap,
      minRebalanceOut: ZERO,
    };
  } else {
    const sentVolatile = findZeroForOneSwapAmount(vault, priceWad, totals);
    if (sentVolatile === null || !isPos(sentVolatile)) return null;
    params = {
      isZeroForOne: true,
      sentAmount: sentVolatile,
      minRebalanceOut: ZERO,
    };
  }

  console.log("[ACTIVE REBALANCE] triggering with deviation (bps):", deviationBps.toString());
  return vault.activeRebalance(engine, params);
}

const act = async function (
  phase: Phase,
  rebalance: Rebalance,
  engine: Engine,
  vault: AlphaProVault,
  variable: Map<string, any>
): Promise<void> {
  switch (phase) {
    case Phase.AFTER_NEW_TIME_PERIOD: {
      const currPrice = vault.poolPrice(vault.pool.sqrtPriceX96);
      const startAmounts = await vault.getTotalAmounts(); // gross token balances now
      const volatileValueInStable = vault.volatileToStableValue(startAmounts.total0, currPrice);
      const gavStart = JSBI.add(startAmounts.total1, volatileValueInStable); // for logging only

      // NAV source of truth
      const prevTotalPoolValue = await vault.totalPoolValue(); // NAV_t_start
      const debtNow = vault.virtualDebt; // constant between rebalances

      console.log("[START] price:", currPrice.toString());
      console.log("[START] amounts.total0 (volatile raw):", startAmounts.total0.toString());
      console.log("[START] amounts.total1 (stable raw):", startAmounts.total1.toString());
      console.log("[START] GAV:", gavStart.toString());
      console.log("[START] NAV (totalPoolValue):", prevTotalPoolValue.toString());
      console.log("[START] virtualDebt:", debtNow.toString());

      const prevCollateralRatioNum = await vault.collateralRatio();
      const prevCollateralRatio = Number.isFinite(prevCollateralRatioNum)
        ? safeToBN(Math.round(prevCollateralRatioNum * 100))
        : safeToBN(0);

      const feesSnapStart = vault.getTotalSwapFeesRaw(); // Use total fees (collected + uncollected)
      const accumulatedSwapFeesRaw = vault.getAccumulatedSwapFeesRaw();
      console.log("[START] feesSnapStart.fees0 (volatile):", feesSnapStart.fees0.toString());
      console.log("[START] feesSnapStart.fees1 (stable):", feesSnapStart.fees1.toString());
      console.log("[START] accumulatedSwapFeesRaw.fees0 (volatile):", accumulatedSwapFeesRaw.fees0.toString());
      console.log("[START] accumulatedSwapFeesRaw.fees1 (stable):", accumulatedSwapFeesRaw.fees1.toString());

      // ---------- IL compute (t-1 → t), NAV-consistent ----------
      let realizedIL_bps_inclFees = ZERO;
      let realizedIL_bps_exFees = ZERO;
      let feesDeltaStable = ZERO;
      let hodlNowStable = ZERO;     // HODL GAV
      let hodlNowNAV_Stable = ZERO; // HODL NAV

      if (
        previousAfterTotalPoolValue !== null &&
        previousTotalAmounts !== null &&
        previousTotalSwapFees !== null
      ) {
        const denomNAV = previousAfterTotalPoolValue; // NAV_{t-1} (post-prev-rebalance)
        console.log("[PREV] NAV_{t-1}:", denomNAV.toString());
        console.log("[PREV] amounts.total0:", previousTotalAmounts.total0.toString());
        console.log("[PREV] amounts.total1:", previousTotalAmounts.total1.toString());
        console.log("[PREV] feesSnapEnd.fees0:", previousTotalSwapFees.fees0.toString());
        console.log("[PREV] feesSnapEnd.fees1:", previousTotalSwapFees.fees1.toString());

        // fees Δ during (t-1, t] at current price, BEFORE any collection at t
        const dFees0 = JSBI.subtract(feesSnapStart.fees0, previousTotalSwapFees.fees0);
        const dFees1 = JSBI.subtract(feesSnapStart.fees1, previousTotalSwapFees.fees1);
        const dFees0_InStable = vault.volatileToStableValue(dFees0, currPrice);
        feesDeltaStable = JSBI.add(dFees1, dFees0_InStable);

        console.log("[ΔFEES] dFees0 (volatile):", dFees0.toString());
        console.log("[ΔFEES] dFees1 (stable):", dFees1.toString());
        console.log("[ΔFEES] dFees0_InStable:", dFees0_InStable.toString());
        console.log("[ΔFEES] feesDeltaStable:", feesDeltaStable.toString());

        // HODL baseline @ t (reprice prev amounts)
        const volatilePrevNow_InStable = vault.volatileToStableValue(previousTotalAmounts.total0, currPrice);
        hodlNowStable = JSBI.add(volatilePrevNow_InStable, previousTotalAmounts.total1);
        hodlNowNAV_Stable = JSBI.greaterThan(hodlNowStable, debtNow)
          ? JSBI.subtract(hodlNowStable, debtNow)
          : ZERO; // clamp

        console.log("[HODL] hodlNowStable (GAV):", hodlNowStable.toString());
        console.log("[HODL] hodlNowNAV_Stable (NAV):", hodlNowNAV_Stable.toString());

        // IL including fees: (NAV_lp_t − NAV_hodl_t) / NAV_{t-1}
        const numIncl = JSBI.subtract(prevTotalPoolValue, hodlNowNAV_Stable);
        realizedIL_bps_inclFees = isPos(denomNAV)
          ? divRound(JSBI.multiply(numIncl, BPS_SCALE), denomNAV)
          : ZERO;

        // IL excluding fees: (NAV_lp_t − feesΔ − NAV_hodl_t) / NAV_{t-1}
        const lpExFees = JSBI.subtract(prevTotalPoolValue, feesDeltaStable);
        const numEx = JSBI.subtract(lpExFees, hodlNowNAV_Stable);
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
      let almSwapFeeUSDC = JSBI.BigInt(0);
      if (rebalance === Rebalance.ALM) {
        const allowActive = activeRebalanceMode !== ActiveRebalanceMode.PASSIVE;
        const totalsForActive = allowActive ? await vault.getTotalAmounts(true) : null;
        const activeRebalanceFee = allowActive && totalsForActive
          ? await maybeExecuteActiveRebalance(vault, engine, totalsForActive, currPrice)
          : null;
        const didActiveRebalance = activeRebalanceFee !== null;

        if (didActiveRebalance) {
          almSwapFeeUSDC = activeRebalanceFee!;
        }

        const shouldRunPassive =
          !didActiveRebalance && activeRebalanceMode !== ActiveRebalanceMode.ACTIVE;
        if (shouldRunPassive) {
          almSwapFeeUSDC = await vault.rebalance(engine);
        }

        variable.set(ALM_CALLS, ((variable.get(ALM_CALLS) as number) ?? 0) + 1);
      } else if (rebalance === Rebalance.DLV) {
        swapFeeUSDC = await vault.rebalanceDebt(engine); // consums internally global variable 'targetCR'
        variable.set(DLV_CALLS, ((variable.get(DLV_CALLS) as number) ?? 0) + 1);
      }

      // ---------- END (after ops) ----------
      const positions = await vault.getPositions();
      const totalAmounts = await vault.getTotalAmounts();
      const afterCollateralRatioNum = await vault.collateralRatio();
      const afterCollateralRatio = Number.isFinite(afterCollateralRatioNum)
        ? safeToBN(Math.round(afterCollateralRatioNum * 100))
        : safeToBN(0);

      const totalSwapFeesRaw = vault.getTotalSwapFeesRaw();
      const currentTotalValueUSDC = await vault.totalPoolValue(); // NAV_t_end
      const date = variable.get(CommonVariables.DATE) as Date;

      console.log("[END] accumulatedSwapFeesRaw.fees0:", accumulatedSwapFeesRaw.fees0.toString());
      console.log("[END] accumulatedSwapFeesRaw.fees1:", accumulatedSwapFeesRaw.fees1.toString());
      console.log("[END] NAV_t_end:", currentTotalValueUSDC.toString());

      console.log('Curr price:', currPrice.toString());
      const priceRanges = await vault.getPositionPriceRanges();
      console.log(`Price Ranges (Volatile per Stable): Wide [${priceRanges.wide.lower.toString()}, ${priceRanges.wide.upper.toString()}], Base [${priceRanges.base.lower.toString()}, ${priceRanges.base.upper.toString()}], Limit [${priceRanges.limit.lower.toString()}, ${priceRanges.limit.upper.toString()}]`);

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
        swapFeeStable: safeToBN(swapFeeUSDC),
        almSwapFeeStable: safeToBN(almSwapFeeUSDC),
        prevCollateralRatio,
        afterCollateralRatio,
        accumulatedSwapFees0: safeToBN(accumulatedSwapFeesRaw.fees0),
        accumulatedSwapFees1: safeToBN(accumulatedSwapFeesRaw.fees1),
        debt: safeToBN(debtNow),
        rebalanceType: rebalance === Rebalance.DLV ? "DLV" : "ALM",
        volatileHoldValueStable: safeToBN(hodlNowStable),
        // realizedIL = bps EX-FEES (NAV-based)
        realizedIL: safeToBN(realizedIL_bps_exFees),
        swapFeesGainedThisPeriod: safeToBN(feesDeltaStable),
        date,
      };

      await logDB.persistRebalanceLog(newLog);

      // Collect data point for APY calculation
      rebalanceLog.push({
        t: date.getTime(),
        vaultValue: Number(currentTotalValueUSDC.toString()) / 1e6, // Scale to match rebalance_plotting.ts
        price: Number(currPrice.toString()) / 1e18 // Scale to match rebalance_plotting.ts
      });

      // ---------- UPDATE SNAPSHOTS FOR NEXT PERIOD ----------
      previousAfterTotalPoolValue = currentTotalValueUSDC; // NAV end-of-period
      previousTotalAmounts = totalAmounts;                 // amounts end-of-period
      previousTotalSwapFees = totalSwapFeesRaw;            // fees snapshot end-of-period

      break;
    }
    case Phase.AFTER_EVENT_APPLIED:
      break;
  }
};

    let evaluate = async function (
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
      console.log("current price (Volatile, WAD):", price.toString());
    
      const virtualDebt = vault.virtualDebt;
      console.log("virtual debt (USDC):", virtualDebt.toString());

      // Calculate and print APY in format expected by brute-force.ts
      const apy = calculateAPY(rebalanceLog);
      console.log(`RESULT_JSON: ${JSON.stringify(apy)}`);
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

    try {
      try {
        await strategy.backtest(startDate, endDate, configLookUpPeriod);
      } catch (error) {
        console.error("[BACKTEST ERROR]", error);
        if (process.env.BRUTE_FORCE === 'true') {
          console.log("[BRUTE-FORCE] Backtest failed, calling evaluate with partial results");
          console.log(`RESULT_JSON: ${JSON.stringify({ vault: 0, hold: 0, diff: 0, error: true })}`);
          return;
        } else {
          throw error;
        }
      }
    } finally {
      await strategy.shutdown();
      await debtNeuralAgent.shutdown();
      await almNeuralAgent.shutdown();
    }
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
  const TARGET_CR_PERCENT = Number(targetCR) / 1e16;

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
