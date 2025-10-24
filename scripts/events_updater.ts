import {
  EndBlockTypeWhenRecover,
  MainnetDataDownloader,
  EventDataSourceType
} from "@bella-defintech/uniswap-v3-simulator";
// import { getCurrentPoolConfig } from "../src/pool-config";

async function main() {
  let endBlock: EndBlockTypeWhenRecover = "latestOnChain";
  // It will use RPCProviderUrl in tuner.config.js if this is undefined.
  let RPCProviderUrl: string | undefined = 'https://smart-dawn-rain.quiknode.pro/a0555e8e9c5ef4699c55e6baa9ff2b05424d1770/';
  
  // Use the database path from config.ts (single source of truth)
  // const poolConfig = getCurrentPoolConfig();
  let mainnetEventDBFilePath = 'data/PAXG-USDC-30_0xb431c70f800100d87554ac1142c4a94c5fe4c0c4.db';

  let mainnetDataDownloader = new MainnetDataDownloader(RPCProviderUrl, EventDataSourceType.RPC);
  await mainnetDataDownloader.update(mainnetEventDBFilePath, endBlock, 10000);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
});