// Only mutable methods (besides setters/getters): deposit, withdraw, rebalance.
// No TWAP logic. No manager/governance/delegates. No factory/vault/pool addr fields.
// No protocol fee or pendingManagerFee. No maxTotalSupply.

import { CorePoolView, TickMath, FullMath } from "@bella-defintech/uniswap-v3-simulator";
import {SqrtPriceMath} from "@bella-defintech/uniswap-v3-simulator/dist/util/SqrtPriceMath";
import { Big, VaultParams, JSBI } from "./types";
import { Engine } from "../engine";
import { MANAGER, Q96, TARGET_CR, ALLOWED_DUST0, ALLOWED_DUST1 } from "../internal_constants";
import { dlvConfig } from "../../config";
import { PoolConfigManager, getCurrentPoolConfig } from "../pool-config";
import {
  ensure,
  toBig,
  ZERO,
  MINIMUM_LIQUIDITY,
  HUNDRED_PERCENT,
  MAX_UINT128,
  LOCKED_HOLDER,
  add,
  sub,
  mul,
  div,
  lt,
  gt,
  eq,
  mulDiv,
  ceilDiv,
  toU128,
  nowSeconds,
  WAD,
  FEE_DEN,
  minJSBI,
  minOutPpm
} from "../utils";

/** ---------- Vault ---------- */
export class AlphaProVault {
  pool: CorePoolView;
  private vaultAddress!: string; // for pool calls
  private poolConfig: PoolConfigManager;

  /** derived from pool */
  private tickSpacing!: number;
  private maxTick!: number;

  /** policy */
  managerFee: Big; // kept
  wideRangeWeight: Big;
  wideThreshold: number;
  baseThreshold: number;
  limitThreshold: number;
  period: number;
  minTickMove: number;

  /** supply & balances */
  totalSupply: Big = ZERO;
  private balances: Map<string, Big> = new Map();
  private idle0: Big = ZERO; // vault-held token0 (outside positions)
  private idle1: Big = ZERO; // vault-held token1 (outside positions)

  /** fee accrual (only manager fee remains) */
  accruedManagerFees0: Big = ZERO;
  accruedManagerFees1: Big = ZERO;

  /** accumulated swap fees from collected positions */
  accumulatedSwapFees0: Big = ZERO; // volatile token swap fees collected
  accumulatedSwapFees1: Big = ZERO; // stable token swap fees collected

  /** ranges */
  wideLower = 0;
  wideUpper = 0;
  baseLower = 0;
  baseUpper = 0;
  limitLower = 0;
  limitUpper = 0;

  /** rebalance cadence */
  lastTick = 0;
  lastTimestamp = 0;

  /** virtual debt from CDP */
  virtualDebt: Big = ZERO;

  constructor(p: VaultParams, pool: CorePoolView, vaultAddress: `0x${string}` ) {
    this.pool = pool;
    this.vaultAddress = vaultAddress;
    this.poolConfig = getCurrentPoolConfig();

    // keep managerFee; protocol fee removed
    if (p.managerFee > 1_000_000) throw new Error("APV_ManagerFee");
    this.managerFee = toBig(p.managerFee);

    if (p.wideRangeWeight > 1_000_000) throw new Error("APV_WideRangeWeight");
    this.wideRangeWeight = toBig(p.wideRangeWeight);

    if (p.minTickMove < 0) throw new Error("APV_MinTickMove");

    this.wideThreshold = p.wideThreshold;
    this.baseThreshold = p.baseThreshold;
    this.limitThreshold = p.limitThreshold;
    if (p.wideThreshold === p.baseThreshold) throw new Error("APV_ThresholdsCannotBeSame");

    this.period = p.period;
    this.minTickMove = p.minTickMove;
  }

  /** async init to read pool spacing/maxTick */
  async init(): Promise<void> {
    this.tickSpacing = this.pool.tickSpacing;
    this.maxTick = TickMath.MAX_TICK / this.tickSpacing * this.tickSpacing;
    this._checkThreshold(this.baseThreshold, this.tickSpacing);
    this._checkThreshold(this.limitThreshold, this.tickSpacing);
    this._checkThreshold(this.wideThreshold, this.tickSpacing);
  }

  /** ---------- Getters ---------- */
  balanceOf(owner: string): Big {
    return this.balances.get(owner) ?? ZERO;
  }
  getBalance0(): Big {
    // exclude manager fees (owed out)
    return sub(this.idle0, this.accruedManagerFees0);
  }
  getBalance1(): Big {
    return sub(this.idle1, this.accruedManagerFees1);
  }

  async getPositions(): Promise<[number, number][]> {
    return [
      [this.wideLower, this.wideUpper],
      [this.baseLower, this.baseUpper],
      [this.limitLower, this.limitUpper],
    ];
  }

  async getTotalAmounts(roundUp = false): Promise<{ total0: Big; total1: Big }> {
    const [w0, w1] = await this._positionAmounts(this.vaultAddress, this.wideLower, this.wideUpper, roundUp);
    const [b0, b1] = await this._positionAmounts(this.vaultAddress, this.baseLower, this.baseUpper, roundUp);
    const [l0, l1] = await this._positionAmounts(this.vaultAddress, this.limitLower, this.limitUpper, roundUp);
    return {
      total0: add(this.getBalance0(), add(add(w0, b0), l0)),
      total1: add(this.getBalance1(), add(add(w1, b1), l1)),
    };
  }

  /** position amounts incl. owed fees less manager fee; excludes fees since last poke */
  private async _positionAmounts(
    owner: string,
    tickLower: number,
    tickUpper: number,
    roundUp: boolean
  ): Promise<[Big, Big]> {
    const pos = this.pool.getPosition(owner, tickLower, tickUpper);

    const { amount0, amount1 } = amountsForLiquidity(
      this.pool,
      tickLower,
      tickUpper,
      pos.liquidity,
      roundUp
    );

    // manager fee only
    const mf = this.managerFee;
    const mgr0 = div(mul(pos.tokensOwed0, mf), HUNDRED_PERCENT);
    const mgr1 = div(mul(pos.tokensOwed1, mf), HUNDRED_PERCENT);

    return [add(amount0, sub(pos.tokensOwed0, mgr0)), add(amount1, sub(pos.tokensOwed1, mgr1))];
  }

  /** ---------- Mutations ---------- */

  /** Deposit proportional amounts */
  async deposit(engine: Engine, params: {
    // who provides tokens and receives shares
    sender: string;
    to: string;
    // desired/min
    amount0Desired: Big;
    amount1Desired: Big;
    amount0Min: Big;
    amount1Min: Big;
  }): Promise<void> {
    const { to } = params;
    if (!to) throw new Error("APV_InvalidRecipient");
    if (eq(params.amount0Desired, ZERO) && eq(params.amount1Desired, ZERO)) throw new Error("APV_ZeroDepositAmount");

    const ranges: Array<[number, number]> = [
      [this.wideLower, this.wideUpper],
      [this.baseLower, this.baseUpper],
      [this.limitLower, this.limitUpper],
    ];
    for (const [lo, hi] of ranges) {
      const pos = this.pool.getPosition(this.vaultAddress, lo, hi);
      if (!eq(pos.liquidity, ZERO)) await engine.burn(this.vaultAddress, lo, hi, ZERO); // poke
    }

    // compute proportional shares/amounts
    const { shares, amount0, amount1 } = await this._calcSharesAndAmounts(
      params.amount0Desired,
      params.amount1Desired
    );
    if (eq(shares, ZERO)) throw new Error("APV_ZeroShares");
    if (lt(amount0, params.amount0Min)) {
        console.error("APV_Amount0Min, got " + amount0.toString() + ", min " + params.amount0Min.toString());
        throw new Error("APV_Amount0Min");
    }
    if (lt(amount1, params.amount1Min)) {
        console.error("APV_Amount1Min, got " + amount1.toString() + ", min " + params.amount1Min.toString());
        throw new Error("APV_Amount1Min");
    }

    // first deposit: lock MINIMUM_LIQUIDITY to sink (no factory)
    if (eq(this.totalSupply, ZERO)) this._mintShares(LOCKED_HOLDER, MINIMUM_LIQUIDITY);

    // pull into idle balances (simulated)
    this.idle0 = add(this.idle0, amount0);
    this.idle1 = add(this.idle1, amount1);

    // mint proportional liquidity into current ranges
    const sqrtPriceX96 = this.pool.sqrtPriceX96;

    let rem0 = amount0;
    let rem1 = amount1;
    const ts = this.totalSupply;

    for (const [lo, hi] of ranges) {
      const pos = this.pool.getPosition(this.vaultAddress, lo, hi);
      if (eq(pos.liquidity, ZERO)) continue;

      let liqToMint = mulDiv(pos.liquidity, shares, ts);
      const liqFromAmts = liquidityForAmounts(lo, hi, rem0, rem1, sqrtPriceX96);
      if (gt(liqToMint, liqFromAmts)) liqToMint = liqFromAmts;

      const { amount0: mint0, amount1: mint1 } =
        await engine.mint(this.vaultAddress, lo, hi, toU128(liqToMint));

      rem0 = sub(rem0, mint0);
      rem1 = sub(rem1, mint1);
      this.idle0 = sub(this.idle0, mint0);
      this.idle1 = sub(this.idle1, mint1);
    }

    // mint shares to recipient
    this._mintShares(to, shares);
  }

  /** Withdraw proportional amounts */
  async withdraw(engine: Engine, params: {
    sender: string;
    to: string;
    shares: Big;
    amount0Min: Big;
    amount1Min: Big;
  }): Promise<void> {
    const { sender, to } = params;
    if (!to) throw new Error("APV_InvalidRecipient");
    if (eq(params.shares, ZERO)) throw new Error("APV_ZeroShares");
    if (lt(this.balanceOf(sender), params.shares)) throw new Error("INSUFFICIENT_SHARES");

    const ts = this.totalSupply;

    // burn shares
    this._burnShares(sender, params.shares);

    // pro-rata idles
    let out0 = mulDiv(this.getBalance0(), params.shares, ts);
    let out1 = mulDiv(this.getBalance1(), params.shares, ts);

    // withdraw share of each position
    const ranges: Array<[number, number]> = [
      [this.wideLower, this.wideUpper],
      [this.baseLower, this.baseUpper],
      [this.limitLower, this.limitUpper],
    ];

    for (const [lo, hi] of ranges) {
      const pos = this.pool.getPosition(this.vaultAddress, lo, hi);
      if (eq(pos.liquidity, ZERO)) continue;

      // 1) compute target liquidity to burn
      const liqShare = toU128(mulDiv(pos.liquidity, params.shares, ts));
      if (eq(liqShare, ZERO)) continue;

      // 2) get principal to be burned (prefer actual from burn; fallback to amountsForLiquidity)
      const { amount0: burned0, amount1: burned1 } = await engine.burn(this.vaultAddress, lo, hi, liqShare);
      // 3) collect ALL owed (principal + full fees)
      const { amount0: coll0, amount1: coll1 } =
        await engine.collect(this.vaultAddress, lo, hi, MAX_UINT128, MAX_UINT128);

      // 4) total fees collected for this position (all shareholders)
      const feesAll0 = sub(coll0, burned0);
      const feesAll1 = sub(coll1, burned1);

      // 5) manager fee on ALL fees
      const mAll0 = div(mul(feesAll0, this.managerFee), HUNDRED_PERCENT);
      const mAll1 = div(mul(feesAll1, this.managerFee), HUNDRED_PERCENT);
      this.accruedManagerFees0 = add(this.accruedManagerFees0, mAll0);
      this.accruedManagerFees1 = add(this.accruedManagerFees1, mAll1);

      // 6) credit vault idle with principal + net fees (everything that stays)
      const netAll0 = sub(feesAll0, mAll0);
      const netAll1 = sub(feesAll1, mAll1);
      this.idle0 = add(this.idle0, add(burned0, netAll0));
      this.idle1 = add(this.idle1, add(burned1, netAll1));

      // 7) withdrawing user gets: their principal + their pro-rata share of NET fees
      const v0 = mulDiv(netAll0, params.shares, ts);
      const v1 = mulDiv(netAll1, params.shares, ts);

      out0 = add(out0, add(burned0, v0));
      out1 = add(out1, add(burned1, v1));

      // 8) track swap fees withdrawn (net)
      this.accumulatedSwapFees0 = add(this.accumulatedSwapFees0, v0);
      this.accumulatedSwapFees1 = add(this.accumulatedSwapFees1, v1);
    }

    if (lt(out0, params.amount0Min)) {
        console.error("APV_Amount0Min, got " + out0.toString() + ", min " + params.amount0Min.toString());
        throw new Error("APV_Amount0Min");
    }
    if (lt(out1, params.amount1Min)) {
        console.error("APV_Amount1Min, got " + out1.toString() + ", min " + params.amount1Min.toString());
        throw new Error("APV_Amount1Min");
    }

    // simulate transfer to 'to'
    this.idle0 = sub(this.idle0, out0);
    this.idle1 = sub(this.idle1, out1);
  }

  /** Rebalance: full withdraw, set new ranges, redeploy */
  // === rebalance() ==============================================================
  async rebalance(engine: Engine): Promise<void> {
    await this._assertCanRebalance();
    
    // Check the pool config for debugging
    const poolConfig = getCurrentPoolConfig();
    console.log(`[REBALANCE START] Pool: ${poolConfig.getDisplayName()}`);
    console.log(`[REBALANCE START] Idle0: ${this.idle0.toString()}, Idle1: ${this.idle1.toString()}`);
    console.log(`[REBALANCE START] Pool tick: ${this.pool.tickCurrent}, sqrtPrice: ${this.pool.sqrtPriceX96.toString()}`);
  
    // -------------------- withdraw everything --------------------
    const ranges: Array<[number, number]> = [
      [this.wideLower, this.wideUpper],
      [this.baseLower, this.baseUpper],
      [this.limitLower, this.limitUpper],
    ];
  
    // Burn & collect all, accounting only manager fee on FEES (not principal)
    for (const [lo, hi] of ranges) {
      const pos = this.pool.getPosition(this.vaultAddress, lo, hi);
      if (eq(pos.liquidity, ZERO)) continue;
        const { amount0: burned0, amount1: burned1 } = await engine.burn(this.vaultAddress, lo, hi, pos.liquidity);
        const { amount0: coll0, amount1: coll1 } =
          await engine.collect(this.vaultAddress, lo, hi, MAX_UINT128, MAX_UINT128);

        // assert collect covers principal
        ensure(JSBI.greaterThanOrEqual(coll0, burned0) && JSBI.greaterThanOrEqual(coll1, burned1),
          "collect < burned (fees can't be negative)", { coll0: coll0.toString(), burned0: burned0.toString(), coll1: coll1.toString(), burned1: burned1.toString() }
        );

        // split fees and accrue manager
        const feesAll0 = sub(coll0, burned0);
        const feesAll1 = sub(coll1, burned1);
        const m0 = div(mul(feesAll0, this.managerFee), HUNDRED_PERCENT);
        const m1 = div(mul(feesAll1, this.managerFee), HUNDRED_PERCENT);
        this.accruedManagerFees0 = add(this.accruedManagerFees0, m0);
        this.accruedManagerFees1 = add(this.accruedManagerFees1, m1);

        // net fees
        const net0 = sub(feesAll0, m0);
        const net1 = sub(feesAll1, m1);

        // update fee trackers with ACTUAL net fees
        this.accumulatedSwapFees0 = add(this.accumulatedSwapFees0, net0);
        this.accumulatedSwapFees1 = add(this.accumulatedSwapFees1, net1);

        // move everything to idle (principal + net fees)
        this.idle0 = add(this.idle0, add(burned0, net0));
        this.idle1 = add(this.idle1, add(burned1, net1));
    }
  
    // === Ground-truth snapshot (no per-range rounding) =========================
    // Everything is now in idle balances; these raw numbers are the invariant.
    const idle0Before = this.getBalance0();
    const idle1Before = this.getBalance1();
    const sqrtBefore  = this.pool.sqrtPriceX96;
    const lpBefore    = this._lpRatioFromRaw(idle0Before, idle1Before, sqrtBefore);
  
    // -------------------- compute new ranges -----------------------------------
    const tick = this.pool.tickCurrent;
    const tickFloor = this._floor(tick);
    const tickCeil  = tickFloor + this.tickSpacing;
  
    this.wideLower = this._boundTick(tickFloor - this.wideThreshold, this.maxTick);
    this.wideUpper = this._boundTick(tickCeil   + this.wideThreshold, this.maxTick);
    this.baseLower = tickFloor - this.baseThreshold;
    this.baseUpper = tickCeil   + this.baseThreshold;
  
    const bidLower = tickFloor - this.limitThreshold;
    const bidUpper = tickFloor;
    const askLower = tickCeil;
    const askUpper = tickCeil   + this.limitThreshold;
  
    // One-time local working balances (start from idle snapshot)
    let balance0 = idle0Before;
    let balance1 = idle1Before;
  
    // Accumulate EXACT amounts consumed by mint calls (ground truth post-deploy)
    let minted0Total = ZERO;
    let minted1Total = ZERO;
  
    const sqrtPriceX96 = this.pool.sqrtPriceX96;
  
    const mintWithExact = async (lo: number, hi: number, liqRaw: JSBI) => {
      const liq = toU128(liqRaw);
      if (eq(liq, ZERO)) return;
      
      // Get the amounts needed before minting
      const { amount0: mint0, amount1: mint1 } = await engine.mint(this.vaultAddress, lo, hi, liq);
      
      // Check if we have enough idle balance before subtracting
      if (lt(this.idle0, mint0)) {
        console.error(`UNDERFLOW WARNING: Insufficient idle0 balance. Have: ${this.idle0.toString()}, Need: ${mint0.toString()}`);
        console.error(`Position: [${lo}, ${hi}], Liquidity: ${liq.toString()}`);
        throw new Error("APV_InsufficientIdle0Balance");
      }
      if (lt(this.idle1, mint1)) {
        console.error(`UNDERFLOW WARNING: Insufficient idle1 balance. Have: ${this.idle1.toString()}, Need: ${mint1.toString()}`);
        console.error(`Position: [${lo}, ${hi}], Liquidity: ${liq.toString()}`);
        throw new Error("APV_InsufficientIdle1Balance");
      }
      
      // Update vault and running totals with ACTUAL amounts the pool took
      this.idle0 = sub(this.idle0, mint0);
      this.idle1 = sub(this.idle1, mint1);
      balance0   = sub(balance0, mint0);
      balance1   = sub(balance1, mint1);
      minted0Total = add(minted0Total, mint0);
      minted1Total = add(minted1Total, mint1);
    };
  
    // -------------------- place wide -------------------------------------------
    if (gt(this.wideRangeWeight, ZERO)) {
      const wideAll = liquidityForAmounts(this.wideLower, this.wideUpper, balance0, balance1, sqrtPriceX96);
      const wideWeighted = div(mul(wideAll, this.wideRangeWeight), HUNDRED_PERCENT);
      await mintWithExact(this.wideLower, this.wideUpper, wideWeighted);
    }
  
    // -------------------- place base -------------------------------------------
    {
      const baseAll = liquidityForAmounts(this.baseLower, this.baseUpper, balance0, balance1, sqrtPriceX96);
      await mintWithExact(this.baseLower, this.baseUpper, baseAll);
    }
  
    // -------------------- place limit (side that fits more) --------------------
    {
      const bidAll = liquidityForAmounts(bidLower, bidUpper, balance0, balance1, sqrtPriceX96);
      const askAll = liquidityForAmounts(askLower, askUpper, balance0, balance1, sqrtPriceX96);
      const bid128 = toU128(bidAll);
      const ask128 = toU128(askAll);
  
      if (gt(bid128, ask128)) {
        await mintWithExact(bidLower, bidUpper, bid128);
        this.limitLower = bidLower; this.limitUpper = bidUpper;
      } else {
        await mintWithExact(askLower, askUpper, ask128);
        this.limitLower = askLower; this.limitUpper = askUpper;
      }
    }
  
    // -------------------- invariants & parity checks ---------------------------
    // 1) Token conservation: what we minted MUST equal what we had in idle
    const rem0 = balance0; // volatile token left idle
    const rem1 = balance1; // stable token left idle
  
    // Check minted + remaining == before, within tiny dust
    const cons0 = add(minted0Total, rem0);
    const cons1 = add(minted1Total, rem1);
    
    const diff0 = JSBI.lessThan(cons0, idle0Before) ? sub(idle0Before, cons0) : sub(cons0, idle0Before);
    const diff1 = JSBI.lessThan(cons1, idle1Before) ? sub(idle1Before, cons1) : sub(cons1, idle1Before);
    
    ensure(JSBI.lessThanOrEqual(diff0, ALLOWED_DUST0) && JSBI.lessThanOrEqual(diff1, ALLOWED_DUST1),
    "Token conservation failed during rebalance", {
      idle0Before: idle0Before.toString(),
      idle1Before: idle1Before.toString(),
      minted0Total: minted0Total.toString(),
      minted1Total: minted1Total.toString(),
      rem0: rem0.toString(),
      rem1: rem1.toString(),
      diff0: diff0.toString(),
      diff1: diff1.toString(),
      allowedDust0: ALLOWED_DUST0.toString(),
      allowedDust1: ALLOWED_DUST1.toString(),
    });

    // 2) LP ratio parity (valuation parity). Use round-down totals to avoid
    //    optimistic round-up drift, and compare within a small relative tolerance.
    const { total0: newTotal0, total1: newTotal1 } = await this.getTotalAmounts(false); // roundDown
    const lpAfter  = this._lpRatioFromRaw(newTotal0, newTotal1, this.pool.sqrtPriceX96);

    // relative tolerance = 0.10% (adjust if you still see legit red/green shuffle)
    const absDiff = JSBI.lessThan(lpAfter, lpBefore) ? JSBI.subtract(lpBefore, lpAfter) : JSBI.subtract(lpAfter, lpBefore);
    const tolAbs  = FullMath.mulDiv(lpBefore, JSBI.BigInt(10), JSBI.BigInt(10_000)); // 10 / 10_000 = 0.10%
    ensure(JSBI.lessThanOrEqual(absDiff, tolAbs), "LP ratio shouldn't change after rebalance", {
      prevLpRatio: lpBefore.toString(),
      newLpRatio : lpAfter.toString(),
      absDiff    : absDiff.toString(),
      tolAbs     : tolAbs.toString(),
      prevTotal0 : idle0Before.toString(),
      prevTotal1 : idle1Before.toString(),
      newTotal0  : newTotal0.toString(),
      newTotal1  : newTotal1.toString(),
    });
  
    // -------------------- bookkeeping -----------------------------------------
    this.lastTimestamp = nowSeconds();
    this.lastTick = tick;
  }


  async rebalanceDebt(engine: Engine): Promise<Big> {
    const rebalanceBorrowedAmount = await this.rebalanceBorrowedAmount();

    if (rebalanceBorrowedAmount.mode === "noop") return ZERO;

    const priceSnap = this.poolPrice(this.pool.sqrtPriceX96);
    const debt0 = this.virtualDebt;
    const A0 = await this.getTotalAmounts(false);
    
    if (rebalanceBorrowedAmount.mode === "leverage") {
      const SLIPPAGE_PPM = 10; // == 1/100000
      const amount0Desired = rebalanceBorrowedAmount.volatileReceived;
      const stableDeposit  = sub(rebalanceBorrowedAmount.borrowStable, rebalanceBorrowedAmount.swapStableToVolatile);

      ensure(
        JSBI.lessThanOrEqual(rebalanceBorrowedAmount.swapStableToVolatile, rebalanceBorrowedAmount.borrowStable),
        "swapStableToVolatile > borrowStable (would make stable deposit negative)",
        {
          borrowStable: rebalanceBorrowedAmount.borrowStable.toString(),
          swapStableToVolatile: rebalanceBorrowedAmount.swapStableToVolatile.toString()
        }
      );

      let amount0Min = minOutPpm(amount0Desired, SLIPPAGE_PPM, JSBI.BigInt(50));       // ~$0.05 in volatile units
      let amount1Min = minOutPpm(stableDeposit, SLIPPAGE_PPM, JSBI.BigInt(400_000));  // ~$0.40 in stable units

      if (!(eq(rebalanceBorrowedAmount.volatileReceived, ZERO) && eq(stableDeposit, ZERO))) {
        await this.deposit(engine, {
          sender: MANAGER,
          to: MANAGER,
          amount0Desired: rebalanceBorrowedAmount.volatileReceived,
          amount1Desired: stableDeposit,
          amount0Min,
          amount1Min
        });
      }
      this.virtualDebt = add(this.virtualDebt, rebalanceBorrowedAmount.borrowStable);
    } else if (rebalanceBorrowedAmount.mode === "deleverage") {
      // If no shares to burn, skip withdraw to avoid APV_ZeroShares.
      let amount0Min = sub(sub(rebalanceBorrowedAmount.withdrawVolatile, div(rebalanceBorrowedAmount.withdrawVolatile, JSBI.BigInt(100000))), JSBI.BigInt(5)); // ~$0.005
      if (JSBI.lessThan(amount0Min, ZERO)) amount0Min = ZERO;
      let amount1Min = sub(sub(rebalanceBorrowedAmount.withdrawStable, div(rebalanceBorrowedAmount.withdrawStable, JSBI.BigInt(100000))), JSBI.BigInt(5000)); // ~$0.005
      if (JSBI.lessThan(amount1Min, ZERO)) amount1Min = ZERO;

      if (!JSBI.equal(rebalanceBorrowedAmount.sharesToBurn, ZERO)) {
        await this.withdraw(engine, {
          sender: MANAGER,
          to: MANAGER,
          shares: rebalanceBorrowedAmount.sharesToBurn,
          amount0Min,
          amount1Min
        });
      }
      const repay = rebalanceBorrowedAmount.repayStable;
      console.log("Rebalance debt: repaying " + repay.toString() + " stable tokens of " + this.virtualDebt.toString() + " virtual debt");
      this.virtualDebt = sub(this.virtualDebt, rebalanceBorrowedAmount.repayStable);
    }
    const A1 = await this.getTotalAmounts(false);

    const pv = (totals: {total0:JSBI,total1:JSBI}, debt: JSBI) => {
      const volatileValueInStable = this.volatileToStableValue(totals.total0, priceSnap);
      return sub(add(totals.total1, volatileValueInStable), debt);
    };
    const pv0 = pv(A0, debt0);
    const pv1 = pv(A1, this.virtualDebt);

    ensure(JSBI.greaterThanOrEqual(this.virtualDebt, ZERO), "Virtual debt cannot be negative", {
      virtualDebt: this.virtualDebt.toString()
    });
    ensure(JSBI.lessThan(this.virtualDebt, MAX_UINT128), "Virtual debt overflow", {
      virtualDebt: this.virtualDebt.toString(),
      maxUint128: MAX_UINT128.toString()
    });
    const crWad       = await this._collateralRatioWad(false);
    const targetCrWad = JSBI.BigInt(TARGET_CR);      // e.g. 2e18 for 200%
    const diffWad     = JSBI.greaterThan(crWad, targetCrWad)
      ? sub(crWad, targetCrWad)
      : sub(targetCrWad, crWad);

    const CR_TOL_WAD  = JSBI.BigInt("100000000000000000"); // 10e16 ≈ 10%
    ensure(
      JSBI.lessThanOrEqual(diffWad, CR_TOL_WAD),
      "Incorrect collateral ratio after debt rebalance",
      {
        expectedTARGET_CR_percent: Number(TARGET_CR) / 1e16,
        actualTARGET_CR_percent: (Number(crWad.toString()) / 1e18) * 100,
      }
    );

    if (rebalanceBorrowedAmount.mode === "leverage") {
      const ZERO = JSBI.BigInt(0);
      const NEG1 = JSBI.BigInt(-1);

      const neg  = (x: JSBI) => JSBI.multiply(x, NEG1);
      const isNeg = (x: JSBI) => JSBI.lessThan(x, ZERO);
      const abs  = (x: JSBI) => (isNeg(x) ? neg(x) : x);
          
      // ---- actual deltas
      const dStable = JSBI.subtract(A1.total1, A0.total1);
      const dVolatile = JSBI.subtract(A1.total0, A0.total0);

      // ---- plan deltas
      const dStable_plan = JSBI.subtract(rebalanceBorrowedAmount.borrowStable, rebalanceBorrowedAmount.swapStableToVolatile);        // B − X
      const dVolatile_plan = rebalanceBorrowedAmount.volatileReceived;                 // +volatileReceived
        
      // ---- signed "extras" (can be negative or positive)
      const extraStable_s = JSBI.subtract(dStable, dStable_plan);   // may be < 0
      const extraVolatile_s = JSBI.subtract(dVolatile, dVolatile_plan);    // may be < 0
          
      // convert volatile extras to stable at the snap price using ABS, then reapply sign
      const extraVolatileValueAbs = this.volatileToStableValue(abs(extraVolatile_s), priceSnap);
      const extraVolatileValueSigned = isNeg(extraVolatile_s) ? neg(extraVolatileValueAbs) : extraVolatileValueAbs;
          
      // sum of signed extras in stable
      const extrasStableValueSigned = JSBI.add(extraStable_s, extraVolatileValueSigned);
          
      // adjust PV by removing any extras (positive extras reduce PV1; negative extras increase PV1)
      const pv1_adj = JSBI.subtract(pv1, extrasStableValueSigned);
  
      // expected PV drop is just the external swap fee
      const expected = JSBI.subtract(pv0, rebalanceBorrowedAmount.swapFeeStable);
  
      // tolerance check (use JSBI for signed diff)
      const diff = JSBI.subtract(expected, pv1_adj);
      const absDiff = isNeg(diff) ? neg(diff) : diff;
      const DUST = JSBI.BigInt(2000);
          
      ensure(
        JSBI.lessThanOrEqual(absDiff, DUST),
        "PV should drop by swap fee (price-locked, extras stripped, signed-safe)",
        {
          fee: rebalanceBorrowedAmount.swapFeeStable.toString(),
          extraStable_s: extraStable_s.toString(),
          extraVolatile_s: extraVolatile_s.toString(),
          extraVolatileValueSigned: extraVolatileValueSigned.toString(),
          pv0: pv0.toString(),
          pv1Adj: pv1_adj.toString(),
          absDiff: absDiff.toString(),
        }
      );
    }

    return rebalanceBorrowedAmount.swapFeeStable;
  }

  /// Below functions work with pool-agnostic conversion ///

  // Convert volatile token amount to stable token amount using price
  volatileToStable(volatileAmount: JSBI, priceWad: JSBI): JSBI {
    return this.poolConfig.volatileToStable(volatileAmount, priceWad);
  }
  
  // Convert stable token amount to volatile token amount using price  
  stableToVolatile(stableAmount: JSBI, priceWad: JSBI): JSBI {
    return this.poolConfig.stableToVolatile(stableAmount, priceWad);
  }

  // Legacy methods for backwards compatibility
  // Stable token raw from volatile token raw using RAW ratio price (token1Raw per token0Raw)
  volatileToStableValue(volatileRaw: JSBI, priceWadRaw: JSBI): JSBI {
    // Generic: volatile token = token0, stable token = token1
    return this.volatileToStable(volatileRaw, priceWadRaw);
  }
  
  // Legacy method name for backwards compatibility
  btcRawToUsdcRaw(btcRaw: JSBI, priceWadRaw: JSBI): JSBI {
    return this.volatileToStableValue(btcRaw, priceWadRaw);
  }
  
  // Volatile token raw from stable token raw using RAW ratio price (token1Raw per token0Raw)
  stableToVolatileValue(stableRaw: JSBI, priceWadRaw: JSBI): JSBI {
    // Generic: stable token = token1, volatile token = token0
    return this.stableToVolatile(stableRaw, priceWadRaw);
  }
  
  // Legacy method name for backwards compatibility
  usdcRawToBtcRaw(usdcRaw: JSBI, priceWadRaw: JSBI): JSBI {
    return this.stableToVolatileValue(usdcRaw, priceWadRaw);
  }

  async totalPoolValue(): Promise<JSBI> {
    const { total0, total1 } = await this.getTotalAmounts();
    const priceWad = this.poolPrice(this.pool.sqrtPriceX96);
    const volatileValueInStable = this.volatileToStableValue(total0, priceWad);
    return sub(add(total1, volatileValueInStable), this.virtualDebt);
  }

  // price in WAD (stable per volatile token), no float loss; identical to (sqrtP^2 / Q96^2) * 1e18
  poolPrice(sqrtPriceX96: JSBI): JSBI {
    const priceX192 = JSBI.multiply(sqrtPriceX96, sqrtPriceX96);
    // priceWad = priceX192 / 2^192 * 1e18  ==  mulDiv(priceX192, WAD, Q96*Q96)
    return FullMath.mulDiv(priceX192, WAD, JSBI.multiply(Q96, Q96)); // Price with token decimal adjustment
  }

  private _lpRatioFromRaw(total0: JSBI, total1: JSBI, sqrtPriceX96: JSBI): JSBI {
    const priceWad = this.poolPrice(sqrtPriceX96);         // token1 per token0 in 1e18
    const volatileValueInStable = this.volatileToStableValue(total0, priceWad);
    if (eq(volatileValueInStable, ZERO)) return JSBI.BigInt(Number.MAX_SAFE_INTEGER.toString());
    return FullMath.mulDiv(total1, WAD, volatileValueInStable);      // (stable value / volatile value) in WAD
  }

  // Keep lpRatio() but default to pool-style round-down for parity checks
  // LP ratio = (stable value) / (volatile value) in WAD (1.0e18 == 1.0)
  // volatileValueInStable = total0 * priceWad / 1e18
  async lpRatio(roundUp = false): Promise<JSBI> {
    const { total0, total1 } = await this.getTotalAmounts(roundUp);
    return this._lpRatioFromRaw(total0, total1, this.pool.sqrtPriceX96);
  }

  // To comply with AlphaProVault ratio enforcement on deposit/withdraw
  async stableAmountForVolatileAmount(volatileAmount: JSBI): Promise<JSBI> {
    if (eq(volatileAmount, ZERO)) return ZERO;

    const { total0, total1 } = await this.getTotalAmounts(true);

    // Empty vault → base on current pool price (stable per volatile, in WAD)
    if (eq(total0, ZERO) && eq(total1, ZERO)) {
      const priceWad = this.poolPrice(this.pool.sqrtPriceX96); // stable per volatile in 1e18
      return FullMath.mulDivRoundingUp(volatileAmount, priceWad, WAD);
    }

    // Existing vault → keep proportions: amount1 = ceil(volatileAmount * total1 / total0)
    if (eq(total0, ZERO)) throw new Error("Vault expects only stable token (total0==0)");
    if (eq(total1, ZERO)) return ZERO;

    const cross = mul(volatileAmount, total1);
    return ceilDiv(cross, total0);
  }
  
  // Legacy method name for backwards compatibility
  async usdcAmountForBtcAmount(btcAmount: JSBI): Promise<JSBI> {
    return this.stableAmountForVolatileAmount(btcAmount);
  }

  private async _collateralRatioWad(roundUp = false): Promise<JSBI> {
    const { total0, total1 } = await this.getTotalAmounts(roundUp);
    const priceWad = this.poolPrice(this.pool.sqrtPriceX96);
    const debt = this.virtualDebt;
    if (eq(debt, ZERO)) return JSBI.BigInt(Number.MAX_SAFE_INTEGER.toString());
    const volatileValueInStable = this.volatileToStableValue(total0, priceWad);
    const totalInStable = add(total1, volatileValueInStable);
    return FullMath.mulDiv(totalInStable, WAD, debt);
  }

  async collateralRatio(): Promise<number> {
    const crWad = await this._collateralRatioWad(false); // <— force roundDown
    return (Number(crWad.toString()) / 1e18) * 100;
  }

  /** ---------- Price helpers ---------- */
// stable per volatile at a given tick (WAD, 1e18)
priceAtTickWad(tick: number): JSBI {
  const sqrtAtTick = TickMath.getSqrtRatioAtTick(tick);
  return this.poolPrice(sqrtAtTick);
}

// Optional convenience: convert WAD => number
private _wadToNum(x: JSBI): number {
  return Number(x.toString()) / 1e18;
}

// Humanized stable per volatile (WAD) - applies decimal scaling
priceStablePerVolatileWad(sqrtPriceX96: JSBI): JSBI {
  // poolPrice already returns the correct price in WAD format
  return this.poolPrice(sqrtPriceX96);
}

// Humanized volatile per stable (WAD)
priceVolatilePerStableWad(sqrtPriceX96: JSBI): JSBI {
  const stablePerVolatileWad = this.priceStablePerVolatileWad(sqrtPriceX96);
  // (1e18 / stablePerVolatileWad) with WAD safety
  return FullMath.mulDiv(WAD, WAD, stablePerVolatileWad);
}

// Legacy method names for backward compatibility
priceUsdcPerBtcWad(sqrtPriceX96: JSBI): JSBI {
  return this.priceStablePerVolatileWad(sqrtPriceX96);
}

priceBtcPerUsdcWad(sqrtPriceX96: JSBI): JSBI {
  return this.priceVolatilePerStableWad(sqrtPriceX96);
}

// Report ranges in desired units
async getPositionPriceRanges() {
  const mk = (lo: number, hi: number) => {
    const loW = this.priceStablePerVolatileWad(TickMath.getSqrtRatioAtTick(lo));
    const hiW = this.priceStablePerVolatileWad(TickMath.getSqrtRatioAtTick(hi));
    return {
      lowerTick: lo, upperTick: hi,
      lowerPriceWad: loW, upperPriceWad: hiW,
      lower: Number(loW.toString()) / 1e18,
      upper: Number(hiW.toString()) / 1e18,
    };
  };
  return {
    wide:  mk(this.wideLower,  this.wideUpper),
    base:  mk(this.baseLower,  this.baseUpper),
    limit: mk(this.limitLower, this.limitUpper),
    spot:  {
      tick: this.pool.tickCurrent,
      priceWad: this.priceStablePerVolatileWad(this.pool.sqrtPriceX96),
      price: Number(this.priceStablePerVolatileWad(this.pool.sqrtPriceX96).toString()) / 1e18
    }
  };
}

  /**
   * Decide how much stable token to borrow and how much to swap (stable<->volatile) to hit:
   * - target LP ratio = 1.0 (50/50) and
   * - target collateral ratio = 200%.
   *
   * Uses fee as a fraction of input (Uniswap V3-style): effective in = in * (1 - fee).
   * Returns stable/volatile *amounts* (on-chain native units). All math in integers.
   */
  async rebalanceBorrowedAmount(): Promise<
    | {
        mode: "leverage";
        borrowStable: JSBI;
        swapStableToVolatile: JSBI; // input amount
        volatileReceived: JSBI;     // post-fee volatile tokens
        swapFeeStable: JSBI;        // fee on stable->volatile swap (in stable)
        postCR: number;
      }
    | {
        mode: "deleverage";
        sharesToBurn: JSBI;
        withdrawStable: JSBI;
        withdrawVolatile: JSBI;    // input to volatile->stable swap
        repayStable: JSBI;         // stable after swap (post-fee) + withdrawn stable
        swapFeeStable: JSBI;       // fee on volatile->stable swap, expressed in stable
        postCR: number;
      }
    | { mode: "noop" }
  > {
    const { total0: volatile0, total1: stable0 } = await this.getTotalAmounts(false);
    const D0 = this.virtualDebt; // stable token units
    const priceWad = this.poolPrice(this.pool.sqrtPriceX96);
    const volatileValStable = this.volatileToStableValue(volatile0, priceWad);
    const V0 = add(stable0, volatileValStable);
  
    const feeFloat = dlvConfig?.debtToVolatileSwapFee ?? 0.003;
    const feeNum = JSBI.BigInt(Math.floor(feeFloat * 1_000_000)); // 1e6 scale
    const oneMinusFeeNum = JSBI.subtract(FEE_DEN, feeNum);
    const fWAD = FullMath.mulDiv(WAD, feeNum, FEE_DEN);
  
    const Rw = await this.lpRatio(true);          // stable value / volatile value (WAD)
    const Rplus1WAD = add(Rw, WAD);
    const twoD0 = JSBI.multiply(D0, JSBI.BigInt(2));
  
    if (JSBI.greaterThan(V0, twoD0)) {
      // ===== Leverage: borrow to reach CR=200%, then swap some stable -> volatile to match current LP mix.
      const termR_1_minus_f_WAD = FullMath.mulDiv(Rw, oneMinusFeeNum, FEE_DEN); // R*(1-f) in WAD
      const denomWAD       = add(WAD, termR_1_minus_f_WAD);                     // 1 + R*(1-f)
      const denomPlusFeeWAD= add(denomWAD, fWAD);                               // 1 + R*(1-f) + f
      const surplus        = sub(V0, twoD0);
    
      // Closed-form base solution (integer floor)
      let B = FullMath.mulDiv(surplus, denomWAD, denomPlusFeeWAD);
      if (eq(B, ZERO)) return { mode: "noop" };
    
      // Helper to simulate integer post-CR given B
      const TARGET_CR_WAD = JSBI.BigInt(TARGET_CR); // e.g. 2e18
      const sim = (Btest: JSBI) => {
        const X            = FullMath.mulDiv(Btest, WAD, denomWAD);        // USDC in to swap
        const swapFeeUSDC  = FullMath.mulDiv(X, feeNum, FEE_DEN);          // fee on input
        const V1           = add(V0, sub(Btest, swapFeeUSDC));             // value after fee
        const D1           = add(D0, Btest);                                // debt after borrow
        const crWad        = FullMath.mulDiv(V1, WAD, D1);                 // WAD ratio (not %)
        return { X, swapFeeUSDC, V1, D1, crWad };
      };
    
      // Nudge B upward by a few raw units if we still overshoot the target due to discreteness
      let { X, swapFeeUSDC, crWad } = sim(B);
      const MAX_STEPS = 2000; // tiny (~$0.002 in stable) max adjustments on small positions
      let steps = 0;
      if (JSBI.greaterThan(crWad, TARGET_CR_WAD)) {
        // borrow a touch more until crWad <= TARGET (or we hit MAX_STEPS)
        while (steps++ < MAX_STEPS) {
          B = JSBI.add(B, JSBI.BigInt(1));
          const res = sim(B);
          crWad = res.crWad; X = res.X; swapFeeUSDC = res.swapFeeUSDC;
          if (!JSBI.greaterThan(crWad, TARGET_CR_WAD)) break;
        }
      } else {
        // if we undershot, try to reduce by a hair but don't cross over
        while (steps++ < MAX_STEPS) {
          if (JSBI.lessThanOrEqual(B, JSBI.BigInt(1))) break;
          const Btry = JSBI.subtract(B, JSBI.BigInt(1));
          const res  = sim(Btry);
          if (JSBI.lessThanOrEqual(res.crWad, TARGET_CR_WAD)) {
            B = Btry; crWad = res.crWad; X = res.X; swapFeeUSDC = res.swapFeeUSDC;
          } else break;
        }
      }
    
      // Final amounts with nudged B
      const xEffStable    = sub(X, swapFeeUSDC);
      const volatileReceived = this.stableToVolatileValue(xEffStable, priceWad);
      const postCR      = (Number(crWad.toString()) / 1e18) * 100;
    
      return {
        mode: "leverage",
        borrowStable: B,
        swapStableToVolatile: X,
        volatileReceived: volatileReceived,
        swapFeeStable: swapFeeUSDC,
        postCR
      };
} else if (JSBI.lessThan(V0, twoD0)) {
  // ===== Deleverage =====
  const two_fWAD = JSBI.multiply(fWAD, JSBI.BigInt(2));
  // denomDelWAD = 1 - 2f/(R+1)
  const denomDelWAD = sub(WAD, FullMath.mulDiv(two_fWAD, WAD, Rplus1WAD));
  const deficit = sub(twoD0, V0);

  // --- infeasible or degenerate? withdraw-all fallback
  if (JSBI.lessThanOrEqual(denomDelWAD, ZERO)) {
    // withdraw-all fallback
    const sharesAll = this.totalSupply;
    const stableOutAll = stable0;
    const volatileOutAll = volatile0;
    const volatileValAllStable = this.volatileToStableValue(volatileOutAll, priceWad);
    const swapFeeStable = FullMath.mulDiv(volatileValAllStable, feeNum, FEE_DEN);
    const stableFromVolatile = sub(volatileValAllStable, swapFeeStable);
    const repay = add(stableOutAll, stableFromVolatile);
    const repayClamped = JSBI.lessThan(repay, D0) ? repay : D0;

    const V1 = ZERO;
    const D1 = sub(D0, repayClamped);
    const postCR = eq(D1, ZERO) ? Number.POSITIVE_INFINITY : (JSBI.toNumber(V1) / JSBI.toNumber(D1)) * 100;

    return {
      mode: "deleverage",
      sharesToBurn: sharesAll,
      withdrawStable: stableOutAll,
      withdrawVolatile: volatileOutAll,
      repayStable: repayClamped,
      swapFeeStable: swapFeeStable,
      postCR
    };
  }

  // closed-form target W (value to withdraw)
  const W = ceilDiv(FullMath.mulDiv(deficit, WAD, JSBI.BigInt(1)), denomDelWAD); // = deficit / (1 - 2f/(R+1))

  // can we actually hit target? (W ≤ V0)
  const canHitTarget =
    JSBI.lessThanOrEqual(W, V0) // equivalent to deficit ≤ V0 * denomDelWAD / WAD
    // (robust version avoids recomputation):
    || JSBI.lessThanOrEqual(deficit, FullMath.mulDiv(V0, denomDelWAD, WAD));

  // ---- CAP to feasible amounts
  const Wcap = JSBI.lessThanOrEqual(W, V0) ? W : V0;

  // composition at current mix
  const stableOut = FullMath.mulDiv(Wcap, Rw, Rplus1WAD);
  const volatileValOut = sub(Wcap, stableOut);
  const swapFeeStable = FullMath.mulDiv(volatileValOut, feeNum, FEE_DEN);
  const stableFromVolatile = sub(volatileValOut, swapFeeStable);

  const repay = add(stableOut, stableFromVolatile);
  const repayClamped = JSBI.lessThan(repay, D0) ? repay : D0;

  const volatileOut = this.stableToVolatileValue(volatileValOut, priceWad);

  // cap shares to totalSupply (avoid >100% burn)
  const sharesToBurnRaw = eq(V0, ZERO) ? ZERO : FullMath.mulDiv(this.totalSupply, Wcap, V0);
  const sharesToBurn = JSBI.lessThanOrEqual(sharesToBurnRaw, this.totalSupply)
    ? sharesToBurnRaw : this.totalSupply;

  const V1 = sub(V0, Wcap);
  const D1 = sub(D0, repayClamped);
  const postCR = eq(D1, ZERO) ? Number.POSITIVE_INFINITY : (JSBI.toNumber(V1) / JSBI.toNumber(D1)) * 100;

  return {
    mode: "deleverage",
    sharesToBurn,
    withdrawStable: stableOut,
    withdrawVolatile: volatileOut,
    repayStable: repayClamped,
    swapFeeStable: swapFeeStable,
    postCR
  };
    } else {
      return { mode: "noop" };
    }
  }

  /** ---------- Setters (no auth) ---------- */
  setManagerFee(fee1e6: number) {
    if (fee1e6 > 1_000_000) throw new Error("APV_ManagerFee");
    this.managerFee = toBig(fee1e6);
  }
  setWideRangeWeight(w1e6: number) {
    if (w1e6 > 1_000_000) throw new Error("APV_WideRangeWeight");
    this.wideRangeWeight = toBig(w1e6);
  }
  setBaseThreshold(t: number) {
    if (t === this.wideThreshold) throw new Error("APV_ThresholdsCannotBeSame");
    this._checkThreshold(t, this.tickSpacing);
    this.baseThreshold = t;
  }
  setLimitThreshold(t: number) {
    this._checkThreshold(t, this.tickSpacing);
    this.limitThreshold = t;
  }
  setWideThreshold(t: number) {
    if (t === this.baseThreshold) throw new Error("APV_ThresholdsCannotBeSame");
    this._checkThreshold(t, this.tickSpacing);
    this.wideThreshold = t;
  }
  setPeriod(s: number) {
    this.period = s;
  }
  setMinTickMove(t: number) {
    if (t < 0) throw new Error("APV_MinTickMove");
    this.minTickMove = t;
  }

  /** ---------- Internals ---------- */
  private _mintShares(to: string, amt: Big) {
    this.balances.set(to, add(this.balances.get(to) ?? ZERO, amt));
    this.totalSupply = add(this.totalSupply, amt);
  }
  private _burnShares(from: string, amt: Big) {
    const prev = this.balances.get(from) ?? ZERO;
    if (lt(prev, amt)) throw new Error("INSUFFICIENT_SHARES");
    this.balances.set(from, sub(prev, amt));
    this.totalSupply = sub(this.totalSupply, amt);
  }

  private async _calcSharesAndAmounts(
    amount0Desired: Big,
    amount1Desired: Big
  ): Promise<{ shares: Big; amount0: Big; amount1: Big }> {
    const ts = this.totalSupply;
    const { total0, total1 } = await this.getTotalAmounts(true);

    if (eq(ts, ZERO)) {
      const amt0 = amount0Desired;
      const amt1 = amount1Desired;
      const maxAmt = gt(amt0, amt1) ? amt0 : amt1;
      const shares = sub(maxAmt, MINIMUM_LIQUIDITY);
      return { shares, amount0: amt0, amount1: amt1 };
    } else if (eq(total0, ZERO)) {
      const amount1 = amount1Desired;
      const shares = mulDiv(amount1, ts, total1);
      return { shares, amount0: ZERO, amount1 };
    } else if (eq(total1, ZERO)) {
      const amount0 = amount0Desired;
      const shares = mulDiv(amount0, ts, total0);
      return { shares, amount0, amount1: ZERO };
    } else {
      const cross0 = mul(amount0Desired, total1);
      const cross1 = mul(amount1Desired, total0);
      const cross = lt(cross0, cross1) ? cross0 : cross1;
      if (eq(cross, ZERO)) throw new Error("APV_ZeroCross");
      const amount0 = ceilDiv(cross, total1);
      const amount1 = ceilDiv(cross, total0);
      const shares = div(mul(cross, ts), mul(total0, total1));
      return { shares, amount0, amount1 };
    }
  }

  private async _assertCanRebalance() {
    /*
    const last = this.lastTimestamp;
    const t = nowSeconds();
    if (t < last + this.period) throw new Error("APV_PeriodNotElapsed");

    const tick = this.pool.tickCurrent;
    const move = Math.abs(tick - this.lastTick);
    if (last !== 0 && move < this.minTickMove) throw new Error("APV_TickNotMoved");

    const maxTh = Math.max(this.baseThreshold, this.limitThreshold);
    const edge = this.maxTick;
    if (!(tick >= -edge + maxTh + this.tickSpacing && tick <= edge - maxTh - this.tickSpacing)) {
      throw new Error("APV_PriceOutOfBounds");
    }
    */
  }

  private _checkThreshold(th: number, spacing: number) {
    if (th <= 0) throw new Error("APV_ThresholdNotPositive");
    if (th % spacing !== 0) throw new Error("APV_ThresholdNotMultipleOfTickSpacing");
  }
  private _floor(tick: number): number {
    const ts = this.tickSpacing;
    let compressed = (tick / ts) | 0;
    if (tick < 0 && tick % ts !== 0) compressed--;
    return compressed * ts;
  }
  private _boundTick(t: number, maxT: number): number {
    if (t < -maxT) return -maxT;
    if (t > maxT) return maxT;
    return t;
  }

  /** Get accumulated swap fees in stable token value using current price */
  async getAccumulatedSwapFeesStableValue(): Promise<JSBI> {
    const priceWad = this.poolPrice(this.pool.sqrtPriceX96); // stable per volatile in WAD
    const volatileFeesValueInStable = this.volatileToStableValue(this.accumulatedSwapFees0, priceWad);
    return add(this.accumulatedSwapFees1, volatileFeesValueInStable);
  }

  /** Legacy method name for backward compatibility */
  async getAccumulatedSwapFeesUsdValue(): Promise<JSBI> {
    return this.getAccumulatedSwapFeesStableValue();
  }

  /** Get accumulated swap fees as percentage of total position value */
  async getAccumulatedSwapFeesPercentage(): Promise<number> {
    const totalValue = await this.totalPoolValue();
    const feesValue = await this.getAccumulatedSwapFeesStableValue();
    
    if (eq(totalValue, ZERO)) return 0;
    
    // Return percentage: (feesValue / totalValue) * 100
    const percentageWad = FullMath.mulDiv(feesValue, WAD, totalValue);
    return (Number(percentageWad.toString()) / 1e18) * 100;
  }

  /** Get raw accumulated swap fees for external tracking */
  getAccumulatedSwapFeesRaw(): { fees0: Big; fees1: Big } {
    return {
      fees0: this.accumulatedSwapFees0,
      fees1: this.accumulatedSwapFees1
    };
  }

  /** Get total swap fees (collected + uncollected from active positions) */
  getTotalSwapFeesRaw(): { fees0: Big; fees1: Big } {
    // Start with already collected fees
    let totalFees0 = this.accumulatedSwapFees0;
    let totalFees1 = this.accumulatedSwapFees1;

    // Add uncollected fees from all active positions
    const ranges: Array<[number, number]> = [
      [this.wideLower, this.wideUpper],
      [this.baseLower, this.baseUpper], 
      [this.limitLower, this.limitUpper]
    ];

    for (const [lo, hi] of ranges) {
      const pos = this.pool.getPosition(this.vaultAddress, lo, hi);
      if (eq(pos.liquidity, ZERO)) continue;

      // Net fees after manager fee
      const mf = this.managerFee;
      const mgr0 = div(mul(pos.tokensOwed0, mf), HUNDRED_PERCENT);
      const mgr1 = div(mul(pos.tokensOwed1, mf), HUNDRED_PERCENT);
      
      const netFee0 = sub(pos.tokensOwed0, mgr0);
      const netFee1 = sub(pos.tokensOwed1, mgr1);

      totalFees0 = add(totalFees0, netFee0);
      totalFees1 = add(totalFees1, netFee1);
    }

    return {
      fees0: totalFees0,
      fees1: totalFees1
    };
  }
}

export function amountsForLiquidity(
  pool: CorePoolView,
  tickLower: number,
  tickUpper: number,
  liquidity: Big,
  roundUp: boolean
): { amount0: Big; amount1: Big } {
  const sqrtPriceX96 = pool.sqrtPriceX96;
  return amountsForLiquidityGivenPrice(sqrtPriceX96, tickLower, tickUpper, liquidity, roundUp);
}

/** price passed in */
export function amountsForLiquidityGivenPrice(
  sqrtPriceX96: Big,
  tickLower: number,
  tickUpper: number,
  liquidity: Big,
  roundUp: boolean
): { amount0: Big; amount1: Big } {
  let sqrtRatioAX96 = TickMath.getSqrtRatioAtTick(tickLower);
  let sqrtRatioBX96 = TickMath.getSqrtRatioAtTick(tickUpper);

  // if (sqrtRatioAX96 > sqrtRatioBX96) swap
  if (JSBI.greaterThan(sqrtRatioAX96, sqrtRatioBX96)) {
    const tmp = sqrtRatioAX96;
    sqrtRatioAX96 = sqrtRatioBX96;
    sqrtRatioBX96 = tmp;
  }

  let amount0 = JSBI.BigInt(0);
  let amount1 = JSBI.BigInt(0);

  // if (sqrtRatioX96 <= sqrtRatioAX96)
  if (JSBI.lessThanOrEqual(sqrtPriceX96, sqrtRatioAX96)) {
    amount0 = SqrtPriceMath.getAmount0DeltaWithRoundUp(
      sqrtRatioAX96, sqrtRatioBX96, liquidity, roundUp
    );
  }
  // else if (sqrtRatioX96 < sqrtRatioBX96)
  else if (JSBI.lessThan(sqrtPriceX96, sqrtRatioBX96)) {
    amount0 = SqrtPriceMath.getAmount0DeltaWithRoundUp(
      sqrtPriceX96, sqrtRatioBX96, liquidity, roundUp
    );
    amount1 = SqrtPriceMath.getAmount1DeltaWithRoundUp(
      sqrtRatioAX96, sqrtPriceX96, liquidity, roundUp
    );
  }
  // else
  else {
    amount1 = SqrtPriceMath.getAmount1DeltaWithRoundUp(
      sqrtRatioAX96, sqrtRatioBX96, liquidity, roundUp
    );
  }

  return { amount0, amount1 };
}

function getLiquidityForAmount0(
  sqrtRatioAX96: Big,
  sqrtRatioBX96: Big,
  amount0: Big
): Big {
  if (JSBI.greaterThan(sqrtRatioAX96, sqrtRatioBX96)) {
    const t = sqrtRatioAX96; sqrtRatioAX96 = sqrtRatioBX96; sqrtRatioBX96 = t;
  }
  // intermediate = (sqrtA * sqrtB) / Q96
  const intermediate = FullMath.mulDiv(sqrtRatioAX96, sqrtRatioBX96, Q96);
  // liquidity = amount0 * intermediate / (sqrtB - sqrtA)
  return FullMath.mulDiv(
    amount0,
    intermediate,
    JSBI.subtract(sqrtRatioBX96, sqrtRatioAX96)
  );
}

function getLiquidityForAmount1(
  sqrtRatioAX96: Big,
  sqrtRatioBX96: Big,
  amount1: Big
): Big {
  if (JSBI.greaterThan(sqrtRatioAX96, sqrtRatioBX96)) {
    const t = sqrtRatioAX96; sqrtRatioAX96 = sqrtRatioBX96; sqrtRatioBX96 = t;
  }
  // liquidity = amount1 * Q96 / (sqrtB - sqrtA)
  return FullMath.mulDiv(
    amount1,
    Q96,
    JSBI.subtract(sqrtRatioBX96, sqrtRatioAX96)
  );
}

function liquidityForAmounts(
  tickLower: number,
  tickUpper: number,
  amount0: Big,
  amount1: Big,
  sqrtRatioX96: Big
): Big {
  let sqrtRatioAX96 = TickMath.getSqrtRatioAtTick(tickLower);
  let sqrtRatioBX96 = TickMath.getSqrtRatioAtTick(tickUpper);

  if (JSBI.greaterThan(sqrtRatioAX96, sqrtRatioBX96)) {
    const tmp = sqrtRatioAX96; sqrtRatioAX96 = sqrtRatioBX96; sqrtRatioBX96 = tmp;
  }

  // if price below range: all amount0 -> liquidity
  if (JSBI.lessThanOrEqual(sqrtRatioX96, sqrtRatioAX96)) {
    return getLiquidityForAmount0(sqrtRatioAX96, sqrtRatioBX96, amount0);
  }
  // if price within range: min(liq from amount0, liq from amount1)
  if (JSBI.lessThan(sqrtRatioX96, sqrtRatioBX96)) {
    const liq0 = getLiquidityForAmount0(sqrtRatioX96, sqrtRatioBX96, amount0);
    const liq1 = getLiquidityForAmount1(sqrtRatioAX96, sqrtRatioX96, amount1);
    return JSBI.lessThan(liq0, liq1) ? liq0 : liq1;
  }
  // price above range: all amount1 -> liquidity
  return getLiquidityForAmount1(sqrtRatioAX96, sqrtRatioBX96, amount1);
}