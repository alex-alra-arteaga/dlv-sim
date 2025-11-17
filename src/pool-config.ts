/**
 * Pool Configuration System
 * 
 * This file defines the configuration structure for making the DLV simulation
 * pool-agnostic. It supports any Uniswap V3 pool with stable/volatile token pairs.
 */

import { JSBI } from "./charm/types";
import { FullMath } from "@bella-defintech/uniswap-v3-simulator";

export interface TokenConfig {
  symbol: string;
  name: string;
  decimals: number;
  address: string;
}

export interface PoolConfig {
  // Pool identification
  poolAddress: string;
  feeAmount: number; // 500, 3000, 10000, etc.
  
  // Token configuration
  token0: TokenConfig;
  token1: TokenConfig;
  
  // Token role identification
  volatileToken: 'token0' | 'token1';
  stableToken: 'token0' | 'token1';
  
  // Database configuration
  dbPath: string;
  rebalanceLogDbPath: string;
  
  // Display configuration
  displayName: string; // e.g., "WBTC-USDC 0.3%"
}

export class PoolConfigManager {
  private config: PoolConfig;
  
  constructor(config: PoolConfig) {
    this.config = config;
    this.validateConfig();
  }
  
  private validateConfig(): void {
    if (this.config.volatileToken === this.config.stableToken) {
      throw new Error("Volatile and stable token must be different");
    }
    
    if (this.config.volatileToken !== 'token0' && this.config.volatileToken !== 'token1') {
      throw new Error("Volatile token must be either 'token0' or 'token1'");
    }
    
    if (this.config.stableToken !== 'token0' && this.config.stableToken !== 'token1') {
      throw new Error("Stable token must be either 'token0' or 'token1'");
    }
  }
  
  // Getters for pool configuration
  getPoolAddress(): string {
    return this.config.poolAddress;
  }
  
  getFeeAmount(): number {
    return this.config.feeAmount;
  }
  
  getDbPath(): string {
    return this.config.dbPath;
  }
  
  getRebalanceLogDbPath(): string {
    return this.config.rebalanceLogDbPath;
  }
  
  getDisplayName(): string {
    return this.config.displayName;
  }
  
  // Token getters
  getVolatileToken(): TokenConfig {
    return this.config.volatileToken === 'token0' ? this.config.token0 : this.config.token1;
  }
  
  getStableToken(): TokenConfig {
    return this.config.stableToken === 'token0' ? this.config.token0 : this.config.token1;
  }
  
  getToken0(): TokenConfig {
    return this.config.token0;
  }
  
  getToken1(): TokenConfig {
    return this.config.token1;
  }
  
  // Convenience methods for determining token positions
  isVolatileToken0(): boolean {
    return this.config.volatileToken === 'token0';
  }
  
  isStableToken0(): boolean {
    return this.config.stableToken === 'token0';
  }
  
  // Decimal helpers
  getVolatileDecimals(): number {
    return this.getVolatileToken().decimals;
  }
  
  getStableDecimals(): number {
    return this.getStableToken().decimals;
  }
  
  getToken0Decimals(): number {
    return this.config.token0.decimals;
  }
  
  getToken1Decimals(): number {
    return this.config.token1.decimals;
  }
  
  // Symbol helpers
  getVolatileSymbol(): string {
    return this.getVolatileToken().symbol;
  }
  
  getStableSymbol(): string {
    return this.getStableToken().symbol;
  }
  
  getToken0Symbol(): string {
    return this.config.token0.symbol;
  }
  
  getToken1Symbol(): string {
    return this.config.token1.symbol;
  }
  
  // Name helpers
  getVolatileName(): string {
    return this.getVolatileToken().name;
  }
  
  getStableName(): string {
    return this.getStableToken().name;
  }
  
  // Amount conversion helpers
  
  /**
   * Convert volatile token amount to stable token amount using price
   * @param volatileAmount Amount in volatile token raw units
   * @param priceWad Price in WAD format (stable per volatile)
   * @returns Amount in stable token raw units
   */
  volatileToStable(volatileAmount: JSBI, priceWad: JSBI): JSBI {
    const WAD = JSBI.BigInt("1000000000000000000"); // 1e18
    return FullMath.mulDiv(volatileAmount, priceWad, WAD);
  }
  
  /**
   * Convert stable token amount to volatile token amount using price
   * @param stableAmount Amount in stable token raw units
   * @param priceWad Price in WAD format (stable per volatile)
   * @returns Amount in volatile token raw units
   */
  stableToVolatile(stableAmount: JSBI, priceWad: JSBI): JSBI {
    const WAD = JSBI.BigInt("1000000000000000000"); // 1e18
    return FullMath.mulDiv(stableAmount, WAD, priceWad);
  }
  
  /**
   * Convert token0 amount to token1 amount using price
   * Handles the conversion regardless of which token is volatile/stable
   */
  token0ToToken1(token0Amount: JSBI, priceWad: JSBI): JSBI {
    const WAD = JSBI.BigInt("1000000000000000000"); // 1e18
    return FullMath.mulDiv(token0Amount, priceWad, WAD);
  }
  
  /**
   * Convert token1 amount to token0 amount using price
   * Handles the conversion regardless of which token is volatile/stable
   */
  token1ToToken0(token1Amount: JSBI, priceWad: JSBI): JSBI {
    const WAD = JSBI.BigInt("1000000000000000000"); // 1e18
    return FullMath.mulDiv(token1Amount, WAD, priceWad);
  }
  
  // HTML formatting helpers for reports
  getFormattedVolatileAmount(amount: JSBI): string {
    const decimals = this.getVolatileDecimals();
    const divisor = JSBI.exponentiate(JSBI.BigInt(10), JSBI.BigInt(decimals));
    const wholePart = JSBI.divide(amount, divisor);
    const remainder = JSBI.remainder(amount, divisor);
    const fractionalPart = remainder.toString().padStart(decimals, '0');
    return `${wholePart.toString()}.${fractionalPart} ${this.getVolatileSymbol()}`;
  }
  
  getFormattedStableAmount(amount: JSBI): string {
    const decimals = this.getStableDecimals();
    const divisor = JSBI.exponentiate(JSBI.BigInt(10), JSBI.BigInt(decimals));
    const wholePart = JSBI.divide(amount, divisor);
    const remainder = JSBI.remainder(amount, divisor);
    const fractionalPart = remainder.toString().padStart(decimals, '0');
    return `${wholePart.toString()}.${fractionalPart} ${this.getStableSymbol()}`;
  }
}

// Pre-configured pool configurations
export const WBTC_USDC_CONFIG: PoolConfig = {
  poolAddress: "0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35",
  feeAmount: 3000,
  token0: {
    symbol: "WBTC",
    name: "Wrapped Bitcoin",
    decimals: 8,
    address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"
  },
  token1: {
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    address: "0xA0b86a33E6417c8Ade68E31cAdE412F9a8f03C5B"
  },
  volatileToken: 'token0', // WBTC is volatile
  stableToken: 'token1',   // USDC is stable
  dbPath: "data/WBTC-USDC_0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35.db",
  rebalanceLogDbPath: "rebalance_log_usdc_wbtc_3000.db",
  displayName: "WBTC-USDC 0.3%"
};

export const ETH_USDT_CONFIG: PoolConfig = {
  poolAddress: "0x4e68Ccd3E89f51C3074ca5072bbAC773960dFa36",
  feeAmount: 3000,
  token0: {
    symbol: "WETH",
    name: "Wrapped Ethereum",
    decimals: 18,
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
  },
  token1: {
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7"
  },
  volatileToken: 'token0', // WETH is volatile
  stableToken: 'token1',   // USDT is stable
  dbPath: "data/ETH-USDT_0x4e68Ccd3E89f51C3074ca5072bbAC773960dFa36.db",
  rebalanceLogDbPath: "rebalance_log_usdt_weth_500.db",
  displayName: "WETH-USDT 0.3%"
};

// Global pool configuration instance
let currentPoolConfig: PoolConfigManager | null = null;

export function setCurrentPoolConfig(config: PoolConfig): void {
  currentPoolConfig = new PoolConfigManager(config);
}

export function getCurrentPoolConfig(): PoolConfigManager {
  if (!currentPoolConfig) {
    // Default to WBTC-USDC if no config is set
    setCurrentPoolConfig(WBTC_USDC_CONFIG);
  }
  return currentPoolConfig!;
}

// Convenience function to create custom pool config
export function createPoolConfig(
  poolAddress: string,
  feeAmount: number,
  token0: TokenConfig,
  token1: TokenConfig,
  volatileToken: 'token0' | 'token1',
  dbPathSuffix?: string
): PoolConfig {
  const stableToken = volatileToken === 'token0' ? 'token1' : 'token0';
  const vol = volatileToken === 'token0' ? token0 : token1;
  const stable = stableToken === 'token0' ? token0 : token1;
  
  const defaultDbPath = dbPathSuffix || 
    `${vol.symbol}-${stable.symbol}_${poolAddress}.db`;
  const defaultRebalanceDbPath = 
    `rebalance_log_${stable.symbol.toLowerCase()}_${vol.symbol.toLowerCase()}_${feeAmount}.db`;
  
  return {
    poolAddress,
    feeAmount,
    token0,
    token1,
    volatileToken,
    stableToken,
    dbPath: `data/${defaultDbPath}`,
    rebalanceLogDbPath: defaultRebalanceDbPath,
    displayName: `${vol.symbol}-${stable.symbol} ${(feeAmount/10000).toFixed(2)}%`
  };
}