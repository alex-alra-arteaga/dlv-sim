import { BigNumber as BN } from "ethers";
import { AlphaProVault } from "./charm/alpha-pro-vault";
import { JSBI } from "./charm/types";
import { charmConfig } from "../config";
import { CorePoolView } from "@bella-defintech/uniswap-v3-simulator";
import { Engine } from "./engine";
import { MANAGER } from "./internal_constants";

export interface Account {
  WBTC: BN;
  USDC: BN;
  vault: AlphaProVault;
}

export function print(account: Account) {
  console.log("WBTC balance: " + account.WBTC.toString());
  console.log("USDC balance: " + account.USDC.toString());
}

export async function buildAccount(
  WBTCAmount: BN,
  USDCAmount: BN,
  corePoolView: CorePoolView
): Promise<Account> {
  const vaultAddress = '0x2146520cA9FaBB6ad227d0e8BCe2bF18Fd742BAB'; // Random
  const vault = new AlphaProVault(charmConfig, corePoolView, vaultAddress);

  return {
    WBTC: WBTCAmount,
    USDC: USDCAmount,
    vault: vault
  };
}

export async function initializeAccountVault(
  account: Account,
  initialToken0Amount: JSBI,
  engine: Engine
): Promise<void> {
  await account.vault.init();

  const usdcAmount = await account.vault.usdcAmountForBtcAmount(initialToken0Amount);
  console.log("Initial USDC amount: " + usdcAmount.toString());
  console.log("Initial WBTC amount: " + initialToken0Amount.toString());

  // 0.001% slippage
  const amount0Min = JSBI.subtract(initialToken0Amount, JSBI.divide(initialToken0Amount, JSBI.BigInt(100000))); 
  const amount1Min = JSBI.subtract(usdcAmount, JSBI.divide(usdcAmount, JSBI.BigInt(100000)));

  await account.vault.deposit(
    engine,
    {
      sender: MANAGER,
      to: MANAGER,
      amount0Desired: initialToken0Amount,
      amount1Desired: usdcAmount,
      amount0Min,
      amount1Min
    }
  );

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