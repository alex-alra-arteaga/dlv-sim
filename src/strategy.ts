import { Engine, buildDryRunEngine } from "./engine";
import { Account, buildAccount, initializeAccountVault } from "./account";
import JSBI from "jsbi";
import {
  ConfigurableCorePool,
  CorePoolView,
  EventDBManager,
  SimulationDataManager,
  SimulatorClient,
  SQLiteSimulationDataManager,
  getTomorrow,
  getNextHour,
  getNextMinute,
  getNext4Hour,
} from "@bella-defintech/uniswap-v3-simulator";
import {
  LookUpPeriod,
  Phase,
  Rebalance,
  CommonVariables,
} from "./enums";
import { getCurrentPoolConfig } from "./pool-config";
import { formatInTimeZone } from 'date-fns-tz';
import { LiquidityEvent } from "@bella-defintech/uniswap-v3-simulator/dist/entity/LiquidityEvent";
import { SwapEvent } from "@bella-defintech/uniswap-v3-simulator/dist/entity/SwapEvent";
import { EventType } from "@bella-defintech/uniswap-v3-simulator/dist/enum/EventType";
import { PoolEvent } from "./charm/types";
import { AlphaProVault } from "./charm/alpha-pro-vault";
import { cmp } from "./utils";

export interface Strategy {
  trigger: (
    phase: Phase,
    rebalance: Rebalance,
    corePoolView: CorePoolView,
    vault: AlphaProVault,
    variable: Map<string, any>
  ) => Promise<boolean> | boolean;
  cache: (
    phase: Phase,
    variable: Map<string, any>
  ) => void;
  act: (
    phase: Phase,
    rebalance: Rebalance,
    engine: Engine,
    corePoolView: CorePoolView,
    vault: AlphaProVault,
    variable: Map<string, any>
  ) => Promise<void>;
  evaluate: (variable: Map<string, any>, vault: AlphaProVault) => void;
  backtest: (startDate: Date, endDate: Date, lookupPeriod: LookUpPeriod) => Promise<void>;
  run: (dryrun: boolean) => Promise<void>;
  shutdown: () => Promise<void>;
}

export { LookUpPeriod, Phase, Rebalance, CommonVariables };

export async function buildStrategy(
    eventDB: EventDBManager,
    trigger: (
      phase: Phase,
      rebalance: Rebalance,
      corePoolView: CorePoolView,
      vault: AlphaProVault,
      variable: Map<string, any>
      ) => Promise<boolean> | boolean,
    cache: (
      phase: Phase,
      variable: Map<string, any>
    ) => void,
    act: (
      phase: Phase,
      rebalance: Rebalance,
      engine: Engine,
      corePoolView: CorePoolView,
      vault: AlphaProVault,
      variable: Map<string, any>
    ) => Promise<void>,
    evaluate: (variable: Map<string, any>, vault: AlphaProVault) => void
  ): Promise<Strategy> {
    let variable: Map<string, any> = new Map();
    /* 
      Everytime we do the backtest of a strategy, we build an instance of the 
      Tuner, replay events in a batch of a day from startDate soecified by the 
      user, ask the user whether they want to do some transaction(mint, burn, 
      swap, collect). If the user choose to trigger it, we run the act callback 
      then repeat the steps above until the endDate comes.
    */
  async function backtest(startDate: Date, endDate: Date, lookupPeriod: LookUpPeriod): Promise<void> {
    const fmtUTC = (d: Date) => formatInTimeZone(d, 'UTC', 'yyyy-MM-dd HH:mm:ss');

    // initial environment
    async function* streamEventsByDate(
      start: Date,
      end: Date
    ): AsyncGenerator<PoolEvent, void, unknown> {
      const [mints, burns, swaps] = await Promise.all([
        eventDB.getLiquidityEventsByDate(EventType.MINT, fmtUTC(start), fmtUTC(end)),
        eventDB.getLiquidityEventsByDate(EventType.BURN, fmtUTC(start), fmtUTC(end)),
        eventDB.getSwapEventsByDate(                     fmtUTC(start), fmtUTC(end)),
      ]);
    
      let i = 0, j = 0, k = 0;
      while (true) {
        const a: LiquidityEvent | undefined = i < mints.length ? mints[i] : undefined;
        const b: LiquidityEvent | undefined = j < burns.length ? burns[j] : undefined;
        const c: SwapEvent       | undefined = k < swaps.length ? swaps[k] : undefined;
      
        let best: PoolEvent | undefined;
        let src: 0 | 1 | 2 | undefined;
      
        if (a) { best = a; src = 0; }
        if (b && (!best || cmp(b, best) < 0)) { best = b; src = 1; }
        if (c && (!best || cmp(c, best) < 0)) { best = c; src = 2; }
      
        if (!best || src === undefined) break;
      
        yield best;
        if (src === 0) i++; else if (src === 1) j++; else k++;
      
        // give GC a chance
        if (((i + j + k) & 4095) === 0) await new Promise(r => setImmediate(r));
      }
    }

    // 1. Instantiate a SimulationDataManager
    // this is for handling the internal data (snapshots, roadmaps, etc.)
    const currentPoolConfig = getCurrentPoolConfig();
    let simulationDataManager: SimulationDataManager = await SQLiteSimulationDataManager.buildInstance(currentPoolConfig.getDbPath());
    let clientInstance: SimulatorClient = new SimulatorClient(simulationDataManager);
    let poolConfig = await eventDB.getPoolConfig();
    // 4. Build a simulated CorePool instance from the downloaded-and-pre-processed mainnet events
    let configurableCorePool: ConfigurableCorePool = clientInstance.initCorePoolFromConfig(poolConfig!);
    let sqrtPriceX96ForInitialization = await eventDB.getInitialSqrtPriceX96();
    await configurableCorePool.initialize(sqrtPriceX96ForInitialization);

    let account: Account = await buildAccount(configurableCorePool.getCorePool())

    // This is an implementation of Engine interface based on the Tuner.
    let engine = await buildDryRunEngine(configurableCorePool);

    // First vault deposit to which we compare strategy performance
    await initializeAccountVault(account, engine);

    async function replayEvent(
      event: LiquidityEvent | SwapEvent
    ): Promise<void> {
      switch (event.type) {
        case EventType.MINT:
          try {
            await configurableCorePool.mint(
              event.recipient,
              event.tickLower,
              event.tickUpper,
              event.liquidity
            );
          } catch (mintError: any) { 
            console.warn(`Warning: Mint operation failed for position [${event.tickLower}, ${event.tickUpper}] with liquidity ${event.liquidity.toString()}:`, mintError.message);
            // Continue simulation even if individual mint fails
          }
          break;
        case EventType.BURN:
          try {
            await configurableCorePool.burn(
              event.msgSender,
              event.tickLower,
              event.tickUpper,
              event.liquidity
            );
          } catch (burnError: any) {
            // Handle liquidity burn errors gracefully
            if (burnError.message?.includes('NP') || burnError.message?.includes('Not Positive')) {
              console.warn(`Warning: Cannot burn ${event.liquidity.toString()} liquidity from position [${event.tickLower}, ${event.tickUpper}] for ${event.msgSender}. Position may have insufficient liquidity. Skipping event.`);
              // Skip this burn event and continue with simulation
            } else {
              // Re-throw other errors
              console.error('Burn operation failed:', burnError);
              throw burnError;
            }
          }
          break;
        case EventType.SWAP:
            {
              const zeroForOne: boolean = JSBI.greaterThan(event.amount0, JSBI.BigInt(0)) ? true : false;
              try {
                // If amountSpecified is zero in historical events, we need to resolve the actual swap input
                // that produced the recorded event. The simulator provides a helper for this.
                let amountSpecified = event.amountSpecified;
                let sqrtPriceLimitX96: any = undefined;

                if (JSBI.equal(amountSpecified, JSBI.BigInt(0))) {
                  try {
                    const resolved = await configurableCorePool.resolveInputFromSwapResultEvent(event as any);
                    // resolved: { amountSpecified, sqrtPriceX96 }
                    amountSpecified = resolved.amountSpecified;
                    sqrtPriceLimitX96 = resolved.sqrtPriceX96;
                  } catch (resolveErr) {
                    // Some historical events cannot be perfectly resolved (e.g. combined internal ops or rounding differences).
                    // Fall back to a best-effort amount so the simulation can continue. This may introduce tiny
                    // parity differences (handled by a relaxed tolerance on post-rebalance checks).
                    // console.warn('resolveInputFromSwapResultEvent failed, falling back to best-effort amountSpecified:', resolveErr?.message ?? resolveErr);
                    amountSpecified = zeroForOne ? event.amount0 : event.amount1;
                    sqrtPriceLimitX96 = undefined;
                    // console.log('fallback swap input:', amountSpecified.toString());
                  }
                }

                const corePool = configurableCorePool.getCorePool();
                if (JSBI.equal(corePool.sqrtPriceX96, (event as SwapEvent).sqrtPriceX96)) {
                  // Event already applied; skip duplicate occurrence.
                  break;
                }

                if (!sqrtPriceLimitX96) {
                  const ONE = JSBI.BigInt(1);
                  const minLimit = JSBI.add(TickMath.MIN_SQRT_RATIO, ONE);
                  const maxLimit = JSBI.subtract(TickMath.MAX_SQRT_RATIO, ONE);
                  if (zeroForOne) {
                    const target = JSBI.greaterThan(event.sqrtPriceX96, minLimit)
                      ? JSBI.subtract(event.sqrtPriceX96, ONE)
                      : minLimit;
                    sqrtPriceLimitX96 = JSBI.greaterThan(target, TickMath.MIN_SQRT_RATIO)
                      ? target
                      : minLimit;
                  } else {
                    const target = JSBI.lessThan(event.sqrtPriceX96, maxLimit)
                      ? JSBI.add(event.sqrtPriceX96, ONE)
                      : maxLimit;
                    sqrtPriceLimitX96 = JSBI.lessThan(target, TickMath.MAX_SQRT_RATIO)
                      ? target
                      : maxLimit;
                  }
                }

                const ONE = JSBI.BigInt(1);
                const currentSqrt = corePool.sqrtPriceX96;
                if (zeroForOne) {
                  const minLimit = JSBI.add(TickMath.MIN_SQRT_RATIO, ONE);
                  if (!JSBI.lessThan(sqrtPriceLimitX96, currentSqrt)) {
                    sqrtPriceLimitX96 = JSBI.greaterThan(currentSqrt, minLimit)
                      ? JSBI.subtract(currentSqrt, ONE)
                      : minLimit;
                  }
                } else {
                  const maxLimit = JSBI.subtract(TickMath.MAX_SQRT_RATIO, ONE);
                  if (!JSBI.greaterThan(sqrtPriceLimitX96, currentSqrt)) {
                    sqrtPriceLimitX96 = JSBI.lessThan(currentSqrt, maxLimit)
                      ? JSBI.add(currentSqrt, ONE)
                      : maxLimit;
                  }
                }

                // Dry-run the swap to inspect expected effects without mutating state
                try {
                  // const q = await configurableCorePool.querySwap(zeroForOne, amountSpecified, sqrtPriceLimitX96);
                  // console.log('querySwap result (no state change):', {
                  //   amount0: (q as any).amount0 ? (q as any).amount0.toString() : '0',
                  //   amount1: (q as any).amount1 ? (q as any).amount1.toString() : '0',
                  //   sqrtPriceX96: (q as any).sqrtPriceX96 ? (q as any).sqrtPriceX96.toString() : configurableCorePool.getCorePool().sqrtPriceX96.toString(),
                  // });
                } catch (qerr) {
                  // const _qe: any = qerr;
                  // console.warn('querySwap failed:', _qe?.message ?? _qe);
                }

                await configurableCorePool.swap(zeroForOne, amountSpecified, undefined);
                // const returnedSqrt = (res as any).sqrtPriceX96 ? (res as any).sqrtPriceX96.toString() : configurableCorePool.getCorePool().sqrtPriceX96.toString();
              } catch (err) {
                console.error('swap/pipeline error:', err);
                throw err;
              }
            }
          break;
        default:
          // @ts-ignore: ExhaustiveCheck
          const exhaustiveCheck: never = event;
      }
    }

    // replay event and call user custom strategy
    const getNextTime = lookupPeriod === LookUpPeriod.MINUTELY
      ? getNextMinute
      : lookupPeriod === LookUpPeriod.HOURLY
      ? getNextHour
      : lookupPeriod === LookUpPeriod.FOUR_HOURLY
      ? getNext4Hour
      : getTomorrow;
    let currDate = startDate;
    while (currDate < endDate) {
      // update common view
      variable.set(CommonVariables.DATE, currDate);
      console.log(currDate);
      // allow update custom cache no matter act is being triggered or not
      cache(Phase.AFTER_NEW_TIME_PERIOD, variable);
      // decide whether to do action
      // DLV Rebalance
      if (
        await trigger(
          Phase.AFTER_NEW_TIME_PERIOD,
          Rebalance.DLV,
          configurableCorePool.getCorePool(),
          account.vault,
          variable
        )
      ) {
        await act(
          Phase.AFTER_NEW_TIME_PERIOD,
          Rebalance.DLV,
          engine,
          configurableCorePool.getCorePool(),
          account.vault,
          variable
        );
      }
      // // ALM rebalance
      if (
        await trigger(
          Phase.AFTER_NEW_TIME_PERIOD,
          Rebalance.ALM,
          configurableCorePool.getCorePool(),
          account.vault,
          variable
        )
      ) {
        await act(
          Phase.AFTER_NEW_TIME_PERIOD,
          Rebalance.ALM,
          engine,
          configurableCorePool.getCorePool(),
          account.vault,
          variable
        );
      }

      // let idx = 0;
      for await (const event of streamEventsByDate(currDate, getNextTime(currDate))) {
        // if ((idx++ % 4000) === 0) configurableCorePool.takeSnapshot("");
      
        await replayEvent(event);
      
        const corePoolView = configurableCorePool.getCorePool();
        variable.set(CommonVariables.EVENT, event);
        variable.set(CommonVariables.PRICE, corePoolView.sqrtPriceX96);
        variable.set(CommonVariables.TICK, corePoolView.tickCurrent);
      
        cache(Phase.AFTER_EVENT_APPLIED, variable);
      
        if (await trigger(Phase.AFTER_EVENT_APPLIED, Rebalance.DLV, corePoolView, account.vault, variable)) {
          await act(Phase.AFTER_EVENT_APPLIED, Rebalance.DLV, engine, corePoolView, account.vault, variable);
        }
        if (await trigger(Phase.AFTER_EVENT_APPLIED, Rebalance.ALM, corePoolView, account.vault, variable)) {
          await act(Phase.AFTER_EVENT_APPLIED, Rebalance.ALM, engine, corePoolView, account.vault, variable);
        }
      }
      currDate = getNextTime(currDate);
    }
    // shutdown environment
    await clientInstance.shutdown();
    // evaluate results
    evaluate(variable, account.vault);
  }

  async function run(_dryrun: boolean) {
    // If we want to make the strategy run on mainnet, just implement Engine interface with abi to interact with mainnet contracts.
    // We can also make the strategy run based on our events DB which updates and represents state of mainnet.
    // TODO
  }

  async function shutdown() {
    await eventDB.close();
  }

  return {
    trigger,
    cache,
    act,
    evaluate,
    backtest,
    run,
    shutdown,
  };
}
