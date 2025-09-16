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
  });

  afterEach(async function () {
    await logDB.close();
  });

  it("can run backtest", async function () {
    const TICK_COUNT = "tickCount";
    const DLV_CALLS  = "dlvCalls";
    const ALM_CALLS  = "almCalls";
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

    let startDate = getDate(2021, 5, 6); // really is day 5
    let endDate = getDate(2024, 12, 18);

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

    let act = async function (
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
          let swapFeeUSDC = JSBI.BigInt(0);
          const prevTotalPoolValue = await vault.totalPoolValue();
          const prevCollateralRatioNum = await vault.collateralRatio();

          // scale ratio by 1e6 to store as integer in BigNumber (avoid decimals)
          const RATIO_SCALE = 1e6;
          const prevCollateralRatio = Number.isFinite(prevCollateralRatioNum)
            ? safeToBN(Math.round(prevCollateralRatioNum * RATIO_SCALE))
            : safeToBN(0);

          if (rebalance === Rebalance.ALM) {
            await vault.rebalance(engine);
            variable.set(ALM_CALLS, ((variable.get(ALM_CALLS) as number) ?? 0) + 1);
          } else if (rebalance === Rebalance.DLV) {
            swapFeeUSDC = await vault.rebalanceDebt(engine);
            variable.set(DLV_CALLS, ((variable.get(DLV_CALLS) as number) ?? 0) + 1);
          }

          const positions = await vault.getPositions();
          const totalAmounts = await vault.getTotalAmounts();
          const afterCollateralRatioNum = await vault.collateralRatio();
          const afterCollateralRatio = Number.isFinite(afterCollateralRatioNum)
            ? safeToBN(Math.round(afterCollateralRatioNum * RATIO_SCALE))
            : safeToBN(0);

          const date = variable.get(CommonVariables.DATE) as Date;
          console.log(currPrice.toString() + " CurrPrice (USDC per BTC)");
          const newLog: RebalanceLog = {
            wide0: positions[0][0],
            wide1: positions[0][1],
            base0: positions[1][0],
            base1: positions[1][1],
            limit0: positions[2][0],
            limit1: positions[2][1],
            total0: safeToBN(totalAmounts.total0),
            total1: safeToBN(totalAmounts.total1),
            nonVolatileAssetPrice: safeToBN(currPrice), // scale by 100 to avoid decimals
            prevTotalPoolValue: safeToBN(prevTotalPoolValue),
            afterTotalPoolValue: safeToBN(await vault.totalPoolValue()),
            lpRatio: safeToBN(await vault.lpRatio(true)),
            swapFeeUSDC: safeToBN(swapFeeUSDC),
            prevCollateralRatio,
            afterCollateralRatio,
            date
          };
          console.log("Rebalance log:", newLog);

          await logDB.persistRebalanceLog(newLog);
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

function sqrtPriceToView(sqrtPriceX96: BN): BN {
  return get10pow(12).div(sqrtPriceX96.pow(2).shr(96 * 2));
}

async function isWithinCrDeviationThreshold(vault: AlphaProVault): Promise<boolean> {
  const crPercent = await vault.collateralRatio(); // returns percent, e.g. ~200
  const maxDeviationThreshold = dlvConfig.deviationThreshold ?? 0;

  if (maxDeviationThreshold === 0) return true;
  // if infinite collateral ratio (no debt), consider it within threshold
  if (!Number.isFinite(crPercent)) return true;

  // TARGET_CR is WAD (e.g., 2e18); convert to percent (e.g., 200)
  const TARGET_CR_PERCENT = Number(TARGET_CR) / 1e16;

  const deviation = Math.abs((crPercent - TARGET_CR_PERCENT) / TARGET_CR_PERCENT);
  // console.log(`Current CR: ${crPercent.toFixed(2)}%, deviation: ${(deviation * 100).toFixed(2)}%`, 'max allowed:', (maxDeviationThreshold * 100).toFixed(2) + '%');
  return deviation < maxDeviationThreshold;
}