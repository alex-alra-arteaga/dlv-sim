import {
  EndBlockTypeWhenInit,
  MainnetDataDownloader,
  EventDataSourceType
} from "@bella-defintech/uniswap-v3-simulator";

async function main() {
  let poolName = "PAXG-USDC-30"; // "events"
  let poolAddress = "0xb431c70f800100d87554ac1142c4a94c5fe4c0c4";
  let endBlock: EndBlockTypeWhenInit = "latest";
  // It will use RPCProviderUrl in tuner.config.js if this is undefined.
  let RPCProviderUrl: string | undefined = 'https://smart-dawn-rain.quiknode.pro/a0555e8e9c5ef4699c55e6baa9ff2b05424d1770/';
  let mainnetDataDownloader = new MainnetDataDownloader(RPCProviderUrl, EventDataSourceType.RPC);
  await mainnetDataDownloader.download(poolName, poolAddress, endBlock, 10000);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
});