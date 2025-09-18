import JSBI from "jsbi";
import { FeeAmount } from "@bella-defintech/uniswap-v3-simulator";

// constants used internally but not expected to be used externally
export const NEGATIVE_ONE = JSBI.BigInt(-1);
export const ZERO = JSBI.BigInt(0);
export const ONE = JSBI.BigInt(1);
export const TWO = JSBI.BigInt(2);
export const MaxUint128 = JSBI.subtract(
  JSBI.exponentiate(JSBI.BigInt(2), JSBI.BigInt(128)),
  ONE
);
export const MaxUint160 = JSBI.subtract(
  JSBI.exponentiate(JSBI.BigInt(2), JSBI.BigInt(160)),
  ONE
);
export const MaxUint256 = JSBI.subtract(
  JSBI.exponentiate(JSBI.BigInt(2), JSBI.BigInt(256)),
  ONE
);

// used in liquidity amount math
export const Q32 = JSBI.exponentiate(JSBI.BigInt(2), JSBI.BigInt(32));
export const Q96 = JSBI.exponentiate(JSBI.BigInt(2), JSBI.BigInt(96));
export const Q128 = JSBI.exponentiate(JSBI.BigInt(2), JSBI.BigInt(128));
export const Q192 = JSBI.exponentiate(Q96, JSBI.BigInt(2));

// used in fee calculation
export const MAX_FEE = JSBI.exponentiate(JSBI.BigInt(10), JSBI.BigInt(6));

// The default factory tick spacings by fee amount.
export const TICK_SPACINGS: { [amount in FeeAmount]: number } = {
  [FeeAmount.LOW]: 10,
  [FeeAmount.MEDIUM]: 60,
  [FeeAmount.HIGH]: 200,
};

export const MANAGER = "0xB333Cc6898ddc72C4E529103e771b7A5a84fAFBc"; // Random
export const TARGET_CR = JSBI.BigInt(2e18); // 200% in WAD

// Tiny per-token dust tolerances in raw units (token native decimals)
export const ALLOWED_DUST0 = JSBI.BigInt(10);    // ≤ 10 units of volatile token (pool-specific)
export const ALLOWED_DUST1 = JSBI.BigInt(1000);  // ≤ 1000 units of stable token (pool-specific)