import { BigNumber as BN } from "ethers";
import { AlphaProVault } from "./charm/alpha-pro-vault";
import { JSBI } from "./charm/types";
import { charmConfig, managerFee } from "../config";
import { CorePoolView } from "@bella-defintech/uniswap-v3-simulator";
import { Engine } from "./engine";
import { MANAGER } from "./internal_constants";
import { getCurrentPoolConfig } from "./pool-config";

export interface Account {
  token0: BN;  // volatile token
  token1: BN;  // stable token
  vault: AlphaProVault;
}

export function print(account: Account) {
  const poolConfig = getCurrentPoolConfig();
  const volatileSymbol = poolConfig.getVolatileSymbol();
  const stableSymbol = poolConfig.getStableSymbol();
  
  console.log(`${volatileSymbol} balance: ` + account.token0.toString());
  console.log(`${stableSymbol} balance: ` + account.token1.toString());
}

export async function buildAccount(
  corePoolView: CorePoolView
): Promise<Account> {
  const vaultAddress = '0x2146520cA9FaBB6ad227d0e8BCe2bF18Fd742BAB'; // Random
  const vault = new AlphaProVault(charmConfig, corePoolView, vaultAddress, managerFee, 0);

  return {
    token0: BN.from(0),
    token1: BN.from(0),
    vault: vault
  };
}

export async function initializeAccountVault(
  account: Account,
  engine: Engine
): Promise<void> {
  // Low amount to not vary too much the historical price of the pool
  // represent amounts as integers before scaling to avoid BigNumber.from decimal underflow
  // 0.01 volatile token with appropriate decimals
  const TARGET_USD_VALUE = 500; // $500 target value
  
  await account.vault.init();
  
  const poolConfig = getCurrentPoolConfig();
  const volatileSymbol = poolConfig.getVolatileSymbol();
  const stableSymbol = poolConfig.getStableSymbol();
  const volatileDecimals = poolConfig.getVolatileDecimals();
  const stableDecimals = poolConfig.getStableDecimals();

  // Get current pool price (stable per volatile token in WAD)
  const currentPriceWad = account.vault.priceStablePerVolatileWad(account.vault.pool.sqrtPriceX96);

  const powVolatileDecimals = JSBI.exponentiate(JSBI.BigInt(10), JSBI.BigInt(volatileDecimals));
  const powStableDecimals = JSBI.exponentiate(JSBI.BigInt(10), JSBI.BigInt(stableDecimals));

  const oneVolatileRaw = powVolatileDecimals;
  const stableForOneVolatileRaw = poolConfig.volatileToStable(oneVolatileRaw, currentPriceWad);

  let pricePerVolatileToken = Number(stableForOneVolatileRaw.toString()) / Math.pow(10, stableDecimals);
  console.log(`Raw price WAD: ${currentPriceWad.toString()}`);

  const targetStableAmount = JSBI.multiply(JSBI.BigInt(TARGET_USD_VALUE.toString()), powStableDecimals);

  let initialVolatileAmount: JSBI;

  if (pricePerVolatileToken <= 0 || !Number.isFinite(pricePerVolatileToken)) {
    console.log(`Warning: Invalid price detected, attempting to derive price from pool data`);

    const sqrtPrice = account.vault.pool.sqrtPriceX96;
    const sqrtPriceNum = Number(sqrtPrice.toString());
    const Q96 = Math.pow(2, 96);
    const rawPrice = Math.pow(sqrtPriceNum / Q96, 2);
    const fallbackPrice = rawPrice * Math.pow(10, volatileDecimals - stableDecimals);
    pricePerVolatileToken = fallbackPrice;

    const fallbackTokenAmount = TARGET_USD_VALUE / fallbackPrice;
    initialVolatileAmount = JSBI.BigInt(
      Math.floor(fallbackTokenAmount * Math.pow(10, volatileDecimals))
    );

    console.log(`Using fallback: ${fallbackTokenAmount.toFixed(8)} ${volatileSymbol} (derived price $${fallbackPrice.toFixed(2)} = $${(fallbackTokenAmount * fallbackPrice).toFixed(2)})`);
  } else {
    initialVolatileAmount = poolConfig.stableToVolatile(targetStableAmount, currentPriceWad);
  }

  console.log(`Target USD value: $${TARGET_USD_VALUE}`);
  console.log(`${volatileSymbol} tokens to deposit: ${poolConfig.getFormattedVolatileAmount(initialVolatileAmount)}`);
  console.log(`Current ${volatileSymbol} price: $${pricePerVolatileToken.toFixed(2)}`);
  console.log(`Initial ${volatileSymbol} amount (raw): ${initialVolatileAmount.toString()}`);

  const stableAmount = await account.vault.stableAmountForVolatileAmount(initialVolatileAmount);
  console.log(`Initial ${stableSymbol} amount: ${poolConfig.getFormattedStableAmount(stableAmount)}`);
  console.log(`Initial ${volatileSymbol} amount: ${poolConfig.getFormattedVolatileAmount(initialVolatileAmount)}`);

  // 0.001% slippage
  const slippageDivisor = JSBI.BigInt(100000);
  const volatileMin = JSBI.subtract(initialVolatileAmount, JSBI.divide(initialVolatileAmount, slippageDivisor));
  const stableMin = JSBI.subtract(stableAmount, JSBI.divide(stableAmount, slippageDivisor));

  const depositParams = poolConfig.isVolatileToken0()
    ? {
        sender: MANAGER,
        to: MANAGER,
        amount0Desired: initialVolatileAmount,
        amount1Desired: stableAmount,
        amount0Min: volatileMin,
        amount1Min: stableMin,
      }
    : {
        sender: MANAGER,
        to: MANAGER,
        amount0Desired: stableAmount,
        amount1Desired: initialVolatileAmount,
        amount0Min: stableMin,
        amount1Min: volatileMin,
      };

  await account.vault.deposit(engine, depositParams);

  const data = await account.vault.rebalanceBorrowedAmount();
  console.log("Rebalance borrowed amount: " + JSON.stringify(data));

  await account.vault.rebalance(engine);
  await account.vault.rebalanceDebt(engine);

  const lpRatio = await account.vault.lpRatio(true);
  const collateralRatio = await account.vault.collateralRatio();
  console.log("Initial LP ratio: " + lpRatio.toString());
  console.log("Initial Collateral ratio: " + collateralRatio.toString());
  const totalPoolValue = await account.vault.totalPoolValue();
  console.log("Initial Total pool value: " + totalPoolValue.toString());
}