import { LiquidityEvent } from "@bella-defintech/uniswap-v3-simulator/dist/entity/LiquidityEvent";
import { SwapEvent } from "@bella-defintech/uniswap-v3-simulator/dist/entity/SwapEvent";
import JSBI from "jsbi";

export type Big = JSBI;

/** ---------- Params kept (others removed per request) ---------- */
export interface VaultParams {
  managerFee: number;        // 1e6 scale (kept)
  wideRangeWeight: number;   // 1e6
  wideThreshold: number;     // int24
  baseThreshold: number;     // int24
  limitThreshold: number;    // int24
  period: number;            // seconds
  minTickMove: number;       // int24
}

export type PoolEvent = LiquidityEvent | SwapEvent;

export { JSBI };