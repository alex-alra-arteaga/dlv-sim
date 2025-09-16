export enum LookUpPeriod {
  MINUTELY = 60,
  HOURLY = 3600,
  FOUR_HOURLY = 14400,
  DAILY = 86400
}

export enum Phase {
  AFTER_NEW_TIME_PERIOD,
  AFTER_EVENT_APPLIED,
}

export enum Rebalance {
  DLV,
  ALM
}

export enum CommonVariables {
  ACCOUNT = "account",
  DATE = "currDate",
  EVENT = "poolEvent",
  PRICE = "sqrtPriceX96",
  TICK = "tickCurrent",
}
