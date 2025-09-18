import {
  EndBlockTypeWhenRecover,
  MainnetDataDownloader,
  EventDataSourceType
} from "@bella-defintech/uniswap-v3-simulator";
import { getCurrentPoolConfig } from "../src/pool-config";

async function main() {
  let endBlock: EndBlockTypeWhenRecover = "latestOnChain";
  // It will use RPCProviderUrl in tuner.config.js if this is undefined.
  let RPCProviderUrl: string | undefined = process.env.RPC_PROVIDER_URL;
  
  // Use the database path from config.ts (single source of truth)
  const poolConfig = getCurrentPoolConfig();
  let mainnetEventDBFilePath = poolConfig.getDbPath();

  let mainnetDataDownloader = new MainnetDataDownloader(RPCProviderUrl, EventDataSourceType.RPC);
  await mainnetDataDownloader.update(mainnetEventDBFilePath, endBlock, 10000);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
});