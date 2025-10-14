import JSBI from "jsbi";
import {
  ConfigurableCorePool,
} from "@bella-defintech/uniswap-v3-simulator";

export interface Engine {
  mint(
    recipient: string,
    tickLower: number,
    tickUpper: number,
    amount: JSBI
  ): Promise<{ amount0: JSBI; amount1: JSBI }>;

  burn(
    owner: string,
    tickLower: number,
    tickUpper: number,
    amount: JSBI
  ): Promise<{ amount0: JSBI; amount1: JSBI }>;

  collect(
    recipient: string,
    tickLower: number,
    tickUpper: number,
    amount0Requested: JSBI,
    amount1Requested: JSBI
  ): Promise<{ amount0: JSBI; amount1: JSBI }>;

  swap(
    zeroForOne: boolean,
    amountSpecified: JSBI,
    sqrtPriceLimitX96?: JSBI
  ): Promise<{ amount0: JSBI; amount1: JSBI }>;
}

export async function buildDryRunEngine(
  configurableCorePool: ConfigurableCorePool
): Promise<Engine> {
  function mint(
    recipient: string,
    tickLower: number,
    tickUpper: number,
    amount: JSBI
  ): Promise<{ amount0: JSBI; amount1: JSBI }> {
    return configurableCorePool
      .mint(recipient, tickLower, tickUpper, amount)
      .then(({ amount0, amount1 }) => {
        // vault already deducted idle0/idle1 before calling engine.mint(...)
        return { amount0, amount1 };
      });
  }

  function burn(
    owner: string,
    tickLower: number,
    tickUpper: number,
    amount: JSBI
  ): Promise<{ amount0: JSBI; amount1: JSBI }> {
    return configurableCorePool.burn(owner, tickLower, tickUpper, amount);
  }

  function collect(
    recipient: string,
    tickLower: number,
    tickUpper: number,
    amount0Requested: JSBI,
    amount1Requested: JSBI
  ): Promise<{ amount0: JSBI; amount1: JSBI }> {
    return configurableCorePool
      .collect(recipient, tickLower, tickUpper, amount0Requested, amount1Requested)
      .then(({ amount0, amount1 }) => {
        // vault already credited idle0/idle1 before calling collect
        return { amount0, amount1 };
      });
  }

  function swap(
    zeroForOne: boolean,
    amountSpecified: JSBI,
    sqrtPriceLimitX96?: JSBI
  ): Promise<{ amount0: JSBI; amount1: JSBI }> {
    return configurableCorePool.swap(zeroForOne, amountSpecified, sqrtPriceLimitX96);
  }

  return { mint, burn, collect, swap };
}
