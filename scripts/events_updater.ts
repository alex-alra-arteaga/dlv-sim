import {
  EndBlockTypeWhenRecover,
  MainnetDataDownloader,
  EventDataSourceType
} from "@bella-defintech/uniswap-v3-simulator";

async function main() {
  let endBlock: EndBlockTypeWhenRecover = "latestOnChain";
  // It will use RPCProviderUrl in tuner.config.js if this is undefined.
  let RPCProviderUrl: string | undefined = process.env.RPC_PROVIDER_URL;
  let mainnetEventDBFilePath =
    "data/WBTC-USDC_0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35.db";

  let mainnetDataDownloader = new MainnetDataDownloader(RPCProviderUrl, EventDataSourceType.RPC);
  await mainnetDataDownloader.update(mainnetEventDBFilePath, endBlock, 10000);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
});