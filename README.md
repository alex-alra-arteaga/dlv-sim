- Fork EVM at x timestamp
- Deploy DLV and ALM with x parameters
- Simulate uniswap price data movement as arbitrage volume
    - I have the hourly data of fees


- The strategy will have a module for ALM rebalancing, and another for DLV rebalancing
- Tester has to add the Charm vault config

- The program has to look at the current tick, and check if any of the liquidity of the Charm vault is there, if yes, check which % and give fees to the user.

# Architectural decisions

Instead of forking the targeting chain, we recreate the UniswapV3 deployment from 0


# node_modules/ changes

client/MainnetDataDownloader.js

```javascript
    async queryInitializationBlockNumber(poolAddress, batchSize = 5000) {
      const pool = await this.getCorePoolContarct(poolAddress);
      const topic = pool.filters.Initialize();
      const latest = await this.RPCProvider.getBlockNumber();

      for (let from = 0; from <= latest; from += (batchSize + 1)) {
        console.log(`Searching for Initialize event from block ${from} to ${Math.min(from + batchSize, latest)}`);
        const to = Math.min(from + batchSize, latest);
        const logs = await pool.queryFilter(topic, from, to);
        if (logs.length) return logs[0].blockNumber;
      }
      throw new Error("Initialize event not found");
    }
```

util/DateUtils.js

```javascript
function getNextHour(date) {
    return new Date(date.getTime() + 60 * 60 * 1000);
}
function getNext4Hour(date) {
    return new Date(date.getTime() + 4 * 60 * 60 * 1000);
}
exports.getNext4Hour = getNext4Hour;
exports.getNextHour = getNextHour;
function getNextMinute(date) {
    return new Date(date.getTime() + 60 * 1000);
}
exports.getNextMinute = getNextMinute;
```

util/DateUtils.d.ts

```javascript
export declare function getNextHour(date: Date): Date;
export declare function getNext4Hour(date: Date): Date;
export declare function getNextMinute(date: Date): Date;
```