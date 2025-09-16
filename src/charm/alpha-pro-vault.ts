// Only mutable methods (besides setters/getters): deposit, withdraw, rebalance.
// No TWAP logic. No manager/governance/delegates. No factory/vault/pool addr fields.
// No protocol fee or pendingManagerFee. No maxTotalSupply.

import { CorePoolView, TickMath, FullMath } from "@bella-defintech/uniswap-v3-simulator";
import {SqrtPriceMath} from "@bella-defintech/uniswap-v3-simulator/dist/util/SqrtPriceMath";
import { Big, VaultParams, JSBI } from "./types";
import { Engine } from "../engine";
import { MANAGER, Q96, TARGET_CR, ALLOWED_DUST0, ALLOWED_DUST1 } from "../internal_constants";
import { dlvConfig } from "../../config";
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
  FEE_DEN
} from "../utils";

/** ---------- Vault ---------- */
export class AlphaProVault {
  pool: CorePoolView;
  private vaultAddress!: string; // for pool calls

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
    const ranges: Array<[number, number]> = [
      [this.wideLower, this.wideUpper],
      [this.baseLower, this.baseUpper],
      [this.limitLower, this.limitUpper],
    ];

    let rem0 = amount0;
    let rem1 = amount1;
    const ts = this.totalSupply;

    for (const [lo, hi] of ranges) {
      const pos = this.pool.getPosition(this.vaultAddress, lo, hi);
      if (eq(pos.liquidity, ZERO)) continue;

      let liqToMint = mulDiv(pos.liquidity, shares, ts);
      const liqFromAmts = liquidityForAmounts(lo, hi, rem0, rem1, sqrtPriceX96);
      if (gt(liqToMint, liqFromAmts)) liqToMint = liqFromAmts;
      if (eq(liqToMint, ZERO)) continue;

      const { amount0: need0, amount1: need1 } = amountsForLiquidity(this.pool, lo, hi, liqToMint, true);
      rem0 = sub(rem0, need0);
      rem1 = sub(rem1, need1);
      this.idle0 = sub(this.idle0, need0);
      this.idle1 = sub(this.idle1, need1);

      await engine.mint(this.vaultAddress, lo, hi, toU128(liqToMint));
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

      const liqShare = toU128(mulDiv(pos.liquidity, params.shares, ts));
      if (eq(liqShare, ZERO)) continue;

      // principal burned (approx)
      const { amount0: b0, amount1: b1 } = amountsForLiquidity(this.pool, lo, hi, liqShare, false);
      out0 = add(out0, b0);
      out1 = add(out1, b1);

      // fee share less manager fee
      const mf = this.managerFee;
      const fs0 = mulDiv(pos.tokensOwed0, params.shares, ts);
      const fs1 = mulDiv(pos.tokensOwed1, params.shares, ts);
      const m0 = div(mul(fs0, mf), HUNDRED_PERCENT);
      const m1 = div(mul(fs1, mf), HUNDRED_PERCENT);

      this.accruedManagerFees0 = add(this.accruedManagerFees0, m0);
      this.accruedManagerFees1 = add(this.accruedManagerFees1, m1);

      const v0 = sub(fs0, m0);
      const v1 = sub(fs1, m1);

      out0 = add(out0, v0);
      out1 = add(out1, v1);

      // reflect burned+fees into idle before user transfer
      this.idle0 = add(this.idle0, add(b0, v0));
      this.idle1 = add(this.idle1, add(b1, v1));

      await engine.burn(this.vaultAddress, lo, hi, liqShare);
      await engine.collect(this.vaultAddress, lo, hi, MAX_UINT128, MAX_UINT128);
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
  
      const fee0Before = pos.tokensOwed0;
      const fee1Before = pos.tokensOwed1;
  
      await engine.burn(this.vaultAddress, lo, hi, pos.liquidity);
      const { amount0: coll0, amount1: coll1 } =
        await engine.collect(this.vaultAddress, lo, hi, MAX_UINT128, MAX_UINT128);
  
      // Principal that was in-range at the time of burn:
      const principal0 = sub(coll0, fee0Before);
      const principal1 = sub(coll1, fee1Before);
  
      // Manager fees only on fees:
      const m0 = div(mul(fee0Before, this.managerFee), HUNDRED_PERCENT);
      const m1 = div(mul(fee1Before, this.managerFee), HUNDRED_PERCENT);
      this.accruedManagerFees0 = add(this.accruedManagerFees0, m0);
      this.accruedManagerFees1 = add(this.accruedManagerFees1, m1);
  
      const netFee0 = sub(fee0Before, m0);
      const netFee1 = sub(fee1Before, m1);
  
      // Move everything into idle balances (principal + net fees)
      this.idle0 = add(this.idle0, add(principal0, netFee0));
      this.idle1 = add(this.idle1, add(principal1, netFee1));
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
      const { amount0: mint0, amount1: mint1 } = await engine.mint(this.vaultAddress, lo, hi, liq);
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
    const rem0 = balance0; // WBTC left idle
    const rem1 = balance1; // USDC left idle
  
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
      const usdcDeposit = sub(rebalanceBorrowedAmount.borrowUSDC, rebalanceBorrowedAmount.swapUSDCtoWBTC);
      // If both sides are zero, skip deposit to avoid APV_ZeroDepositAmount
      let amount0Min = sub(sub(rebalanceBorrowedAmount.btcReceived, div(rebalanceBorrowedAmount.btcReceived, JSBI.BigInt(100000))), JSBI.BigInt(50)); // ~$0.05
      if (JSBI.lessThan(amount0Min, ZERO)) amount0Min = ZERO;
      let amount1Min = sub(sub(usdcDeposit, div(usdcDeposit, JSBI.BigInt(100000))), JSBI.BigInt(400000)); // ~$0.4
      if (JSBI.lessThan(amount1Min, ZERO)) amount1Min = ZERO;

      if (!(eq(rebalanceBorrowedAmount.btcReceived, ZERO) && eq(usdcDeposit, ZERO))) {
        console.log("Leverage deposit: " + rebalanceBorrowedAmount.btcReceived.toString() + " WBTC and " + usdcDeposit.toString() + " USDC");
        await this.deposit(engine, {
          sender: MANAGER,
          to: MANAGER,
          amount0Desired: rebalanceBorrowedAmount.btcReceived,
          amount1Desired: usdcDeposit,
          amount0Min,
          amount1Min
        });
      }
      this.virtualDebt = add(this.virtualDebt, rebalanceBorrowedAmount.borrowUSDC);
    } else if (rebalanceBorrowedAmount.mode === "deleverage") {
      console.log("Deleverage withdraw: " + rebalanceBorrowedAmount.withdrawWBTC.toString() + " WBTC and " + rebalanceBorrowedAmount.withdrawUSDC.toString() + " USDC to repay " + rebalanceBorrowedAmount.repayUSDC.toString() + " USDC");
      // If no shares to burn, skip withdraw to avoid APV_ZeroShares.
      let amount0Min = sub(sub(rebalanceBorrowedAmount.withdrawWBTC, div(rebalanceBorrowedAmount.withdrawWBTC, JSBI.BigInt(100000))), JSBI.BigInt(5)); // ~$0.005
      if (JSBI.lessThan(amount0Min, ZERO)) amount0Min = ZERO;
      let amount1Min = sub(sub(rebalanceBorrowedAmount.withdrawUSDC, div(rebalanceBorrowedAmount.withdrawUSDC, JSBI.BigInt(100000))), JSBI.BigInt(5000)); // ~$0.005
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
      this.virtualDebt = sub(this.virtualDebt, rebalanceBorrowedAmount.repayUSDC);
    }
    const A1 = await this.getTotalAmounts(false);

    const pv = (totals: {total0:JSBI,total1:JSBI}, debt: JSBI) => {
      const btcV = this.btcRawToUsdcRaw(totals.total0, priceSnap);
      return sub(add(totals.total1, btcV), debt);
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
    console.log("Current collateral ratio: " + crWad.toString());
    const targetCrWad = JSBI.BigInt(TARGET_CR);      // e.g. 2e18 for 200%
    const diffWad     = JSBI.greaterThan(crWad, targetCrWad)
      ? sub(crWad, targetCrWad)
      : sub(targetCrWad, crWad);

    const CR_TOL_WAD  = JSBI.BigInt("30000000000000000"); // 3e16 ≈ 3%
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
      const dUSDC = JSBI.subtract(A1.total1, A0.total1);
      const dBTC  = JSBI.subtract(A1.total0, A0.total0);

      // ---- plan deltas
      const dUSDC_plan = JSBI.subtract(rebalanceBorrowedAmount.borrowUSDC, rebalanceBorrowedAmount.swapUSDCtoWBTC);        // B − X
      const dBTC_plan  = rebalanceBorrowedAmount.btcReceived;                 // +btcReceived
        
      // ---- signed "extras" (can be negative or positive)
      const extraUSDC_s = JSBI.subtract(dUSDC, dUSDC_plan);   // may be < 0
      const extraBTC_s  = JSBI.subtract(dBTC,  dBTC_plan);    // may be < 0
          
      // convert BTC extras to USDC at the snap price using ABS, then reapply sign
      const extraBTCv_abs = this.btcRawToUsdcRaw(abs(extraBTC_s), priceSnap);
      const extraBTCv_s   = isNeg(extraBTC_s) ? neg(extraBTCv_abs) : extraBTCv_abs;
          
      // sum of signed extras in USDC
      const extrasUSDCv_s = JSBI.add(extraUSDC_s, extraBTCv_s);
          
      // adjust PV by removing any extras (positive extras reduce PV1; negative extras increase PV1)
      const pv1_adj = JSBI.subtract(pv1, extrasUSDCv_s);
  
      // expected PV drop is just the external swap fee
      const expected = JSBI.subtract(pv0, rebalanceBorrowedAmount.swapFeeUSDC);
  
      // tolerance check (use JSBI for signed diff)
      const diff = JSBI.subtract(expected, pv1_adj);
      const absDiff = isNeg(diff) ? neg(diff) : diff;
      const DUST = JSBI.BigInt(2000);
          
      ensure(
        JSBI.lessThanOrEqual(absDiff, DUST),
        "PV should drop by swap fee (price-locked, extras stripped, signed-safe)",
        {
          fee: rebalanceBorrowedAmount.swapFeeUSDC.toString(),
          extraUSDC_s: extraUSDC_s.toString(),
          extraBTC_s: extraBTC_s.toString(),
          extraBTCv_s: extraBTCv_s.toString(),
          pv0: pv0.toString(),
          pv1Adj: pv1_adj.toString(),
          absDiff: absDiff.toString(),
        }
      );
    }

    return rebalanceBorrowedAmount.swapFeeUSDC;
  }

  /// Below functions work on the assumption volatile asset is token0 ///

  // USDC raw (1e6) from BTC raw (1e8) using RAW ratio price (token1Raw per token0Raw)
  btcRawToUsdcRaw(btcRaw: JSBI, priceWadRaw: JSBI): JSBI {
    // usdcRaw = btcRaw * priceRaw
    return FullMath.mulDiv(btcRaw, priceWadRaw, WAD);
  }
  
  // BTC raw (1e8) from USDC raw (1e6) using RAW ratio price (token1Raw per token0Raw)
  private usdcRawToBtcRaw(usdcRaw: JSBI, priceWadRaw: JSBI): JSBI {
    // btcRaw = usdcRaw / priceRaw
    return FullMath.mulDiv(usdcRaw, WAD, priceWadRaw);
  }

  async totalPoolValue(): Promise<JSBI> {
    const { total0, total1 } = await this.getTotalAmounts();
    const priceWad = this.poolPrice(this.pool.sqrtPriceX96);
    console.log(div(priceWad, JSBI.BigInt(1e18)).toString() + " Price WAD (USDC per BTC)");
    const btcValueUSDC = this.btcRawToUsdcRaw(total0, priceWad); // << scale applied
    console.log(add(total1, btcValueUSDC).toString() + " Total pool value USDC");
    console.log(this.virtualDebt.toString() + " Virtual debt USDC");
    return sub(add(total1, btcValueUSDC), this.virtualDebt);
  }

  // price in WAD (USDC per BTC), no float loss; identical to (sqrtP^2 / Q96^2) * 1e18
  poolPrice(sqrtPriceX96: JSBI): JSBI {
    const priceX192 = JSBI.multiply(sqrtPriceX96, sqrtPriceX96);
    // priceWad = priceX192 / 2^192 * 1e18  ==  mulDiv(priceX192, WAD, Q96*Q96)
    return FullMath.mulDiv(priceX192, WAD, JSBI.multiply(Q96, Q96)); // Adjust for WBTC having 2 more decimals than USDC
  }

  private _lpRatioFromRaw(total0: JSBI, total1: JSBI, sqrtPriceX96: JSBI): JSBI {
    const priceWad = this.poolPrice(sqrtPriceX96);         // token1 per token0 in 1e18
    const btcValueUSDC = this.btcRawToUsdcRaw(total0, priceWad);
    if (eq(btcValueUSDC, ZERO)) return JSBI.BigInt(Number.MAX_SAFE_INTEGER.toString());
    return FullMath.mulDiv(total1, WAD, btcValueUSDC);      // (USDC value / BTC value) in WAD
  }

  // Keep lpRatio() but default to pool-style round-down for parity checks
  // LP ratio = (USDC value) / (BTC value) in WAD (1.0e18 == 1.0)
  // btcValueUSDC = total0 * priceWad / 1e18
  async lpRatio(roundUp = false): Promise<JSBI> {
    const { total0, total1 } = await this.getTotalAmounts(roundUp);
    return this._lpRatioFromRaw(total0, total1, this.pool.sqrtPriceX96);
  }

  // To comply with AlphaProVault ratio enforcment on deposit/withdraw
  async usdcAmountForBtcAmount(btcAmount: JSBI): Promise<JSBI> {
    if (eq(btcAmount, ZERO)) return ZERO;

    const { total0, total1 } = await this.getTotalAmounts(true);

    // Empty vault → base on current pool price (USDC per BTC, in WAD)
    if (eq(total0, ZERO) && eq(total1, ZERO)) {
      const priceWad = this.poolPrice(this.pool.sqrtPriceX96); // USDC per BTC in 1e18
      return FullMath.mulDivRoundingUp(btcAmount, priceWad, WAD);
    }

    // Existing vault → keep proportions: amount1 = ceil(btcAmount * total1 / total0)
    if (eq(total0, ZERO)) throw new Error("Vault expects only USDC (total0==0)");
    if (eq(total1, ZERO)) return ZERO;

    const cross = mul(btcAmount, total1);
    return ceilDiv(cross, total0);
  }

  // WAD-scaled CR = (totalValueUSDC * 1e18) / debt  (no *100 here)
  private async _collateralRatioWad(roundUp = false): Promise<JSBI> {
    const { total0, total1 } = await this.getTotalAmounts(roundUp);
    const priceWad = this.poolPrice(this.pool.sqrtPriceX96);
    const debt = this.virtualDebt;
    if (eq(debt, ZERO)) return JSBI.BigInt(Number.MAX_SAFE_INTEGER.toString());
    const btcValueUSDC = this.btcRawToUsdcRaw(total0, priceWad);
    const totalInUSDC  = add(total1, btcValueUSDC);
    return FullMath.mulDiv(totalInUSDC, WAD, debt);
  }

  async collateralRatio(): Promise<number> {
    const crWad = await this._collateralRatioWad(false); // <— force roundDown
    return (Number(crWad.toString()) / 1e18) * 100;
  }


  /**
   * Decide how much USDC to borrow and how much to swap (USDC<->WBTC) to hit:
   * - target LP ratio = 1.0 (50/50) and
   * - target collateral ratio = 200%.
   *
   * Uses fee as a fraction of input (Uniswap V3-style): effective in = in * (1 - fee).
   * Returns USDC/BTC *amounts* (on-chain native units). All math in integers.
   */
  async rebalanceBorrowedAmount(): Promise<
    | {
        mode: "leverage";
        borrowUSDC: JSBI;
        swapUSDCtoWBTC: JSBI; // input amount
        btcReceived: JSBI;     // post-fee BTC tokens
        swapFeeUSDC: JSBI;     // NEW: fee on USDC->WBTC swap (in USDC)
        postCR: number;
      }
    | {
        mode: "deleverage";
        sharesToBurn: JSBI;
        withdrawUSDC: JSBI;
        withdrawWBTC: JSBI;    // input to BTC->USDC swap
        repayUSDC: JSBI;       // USDC after swap (post-fee) + withdrawn USDC
        swapFeeUSDC: JSBI;     // NEW: fee on BTC->USDC swap, expressed in USDC
        postCR: number;
      }
    | { mode: "noop" }
  > {
    const { total0: BTC0, total1: USDC0 } = await this.getTotalAmounts(false);
    const D0 = this.virtualDebt; // USDC units
    const priceWad = this.poolPrice(this.pool.sqrtPriceX96);
    const btcValUSDC = this.btcRawToUsdcRaw(BTC0, priceWad);
    const V0 = add(USDC0, btcValUSDC);
  
    const feeFloat = dlvConfig?.debtToVolatileSwapFee ?? 0.003;
    const feeNum = JSBI.BigInt(Math.floor(feeFloat * 1_000_000)); // 1e6 scale
    const oneMinusFeeNum = JSBI.subtract(FEE_DEN, feeNum);
    const fWAD = FullMath.mulDiv(WAD, feeNum, FEE_DEN);
  
    const Rw = await this.lpRatio(true);          // USDC value / BTC value (WAD)
    const Rplus1WAD = add(Rw, WAD);
    const twoD0 = JSBI.multiply(D0, JSBI.BigInt(2));
  
    if (JSBI.greaterThan(V0, twoD0)) {
      // ===== Leverage: borrow to reach CR=200%, then swap some USDC -> BTC to match current LP mix.
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
      const MAX_STEPS = 2000; // tiny (~$0.002 in USDC) max adjustments on small positions
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
      const xEffUSDC    = sub(X, swapFeeUSDC);
      const btcReceived = this.usdcRawToBtcRaw(xEffUSDC, priceWad);
      const postCR      = (Number(crWad.toString()) / 1e18) * 100;
    
      return {
        mode: "leverage",
        borrowUSDC: B,
        swapUSDCtoWBTC: X,
        btcReceived,
        swapFeeUSDC,
        postCR
      };
    } else if (JSBI.lessThan(V0, twoD0)) {
      // ===== Deleverage: withdraw to repay; swap ALL withdrawn BTC -> USDC.
      // denomDelWAD = 1 - 2f/(R+1)  (in WAD)
      const two_fWAD = JSBI.multiply(fWAD, JSBI.BigInt(2));
      const denomSub = FullMath.mulDiv(JSBI.multiply(two_fWAD, WAD), JSBI.BigInt(1), Rplus1WAD);
      const denomDelWAD = sub(WAD, denomSub);
  
      const deficit = sub(twoD0, V0);
  
      if (JSBI.lessThanOrEqual(denomDelWAD, ZERO)) {
        // withdraw everything fallback
        const sharesAll = this.totalSupply;
        const usdcOutAll = USDC0;
        const btcOutAll = BTC0;
        const btcValAllUSDC = this.btcRawToUsdcRaw(btcOutAll, priceWad);
        const swapFeeUSDC = FullMath.mulDiv(btcValAllUSDC, feeNum, FEE_DEN); // NEW
        const usdcFromBtc = sub(btcValAllUSDC, swapFeeUSDC);
        const repay = add(usdcOutAll, usdcFromBtc);
        const repayClamped = JSBI.lessThan(repay, D0) ? repay : D0;
  
        const V1 = ZERO;
        const D1 = sub(D0, repayClamped);
        const postCR = eq(D1, ZERO) ? Number.POSITIVE_INFINITY : (JSBI.toNumber(V1) / JSBI.toNumber(D1)) * 100;
  
        return {
          mode: "deleverage",
          sharesToBurn: sharesAll,
          withdrawUSDC: usdcOutAll,
          withdrawWBTC: btcOutAll,
          repayUSDC: repayClamped,
          swapFeeUSDC,
          postCR
        };
      }
  
      // Targeted withdrawal value:
      const W = ceilDiv(FullMath.mulDiv(deficit, WAD, JSBI.BigInt(1)), denomDelWAD);
  
      // Composition by current vault mix:
      const usdcOut = FullMath.mulDiv(W, Rw, Rplus1WAD);
      const btcValOut = sub(W, usdcOut); // USDC value of BTC withdrawn
      const swapFeeUSDC = FullMath.mulDiv(btcValOut, feeNum, FEE_DEN); // NEW
      const usdcFromBtc = sub(btcValOut, swapFeeUSDC);
  
      const repay = add(usdcOut, usdcFromBtc);
      const repayClamped = JSBI.lessThan(repay, D0) ? repay : D0;
  
      const btcOut = this.usdcRawToBtcRaw(btcValOut, priceWad);
      const sharesToBurn = eq(V0, ZERO) ? ZERO : FullMath.mulDiv(this.totalSupply, W, V0);
  
      const V1 = sub(V0, W);
      const D1 = sub(D0, repayClamped);
      const postCR = eq(D1, ZERO) ? Number.POSITIVE_INFINITY : (JSBI.toNumber(V1) / JSBI.toNumber(D1)) * 100;
  
      return {
        mode: "deleverage",
        sharesToBurn,
        withdrawUSDC: usdcOut,
        withdrawWBTC: btcOut,
        repayUSDC: repayClamped,
        swapFeeUSDC,
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