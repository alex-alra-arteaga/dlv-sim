# DLV-Sim

DLV-Sim is a simulation tool for modeling custom Uniswap V3 strategies. You can plug different automated liquidity management (ALM), representd by 'accounts'.
It allows users to simulate complex strategies against historical behaviour of any Uniswap V3 pool.

This specific  simulation mocks a Charm Vault being used as collateral, targeting a CR equivalent to 2x leverage and a 50:50 LP ratio via Charm passive rebalancing.

## Features

- **Uniswap V3 Recreation**: Deploys a fresh Uniswap V3 instance for accurate simulation without forking existing chains.
It offers unparalled speed, you can run 5 years data, recreating swaps|mints|burns in the same exact order it happened, in around 2 minutes of execution.
- **Rebalance Simulation**: Tracks DLV and ALM rebalances with visual plotting on the strategy performance and characteristics.
- **Extensible Design**: Built with compatible of new strategies with unique features, with built-in advanced plotting.

## Installation

1. Clone the repository.

2. Install dependencies:
    ```bash
    yarn install
    ```

3. Set up environment variables (e.g., for RPC endpoints) in a `.env` file.

## Usage

Run the simulation:
```bash
yarn simulate
```

## Configuration

Configure parameters in `config.json` to adjust pool settings, rebalance intervals, and interest rates.

## Data Gathering

1. Add your `RPC_URL` inside `tuner.config.js`.

2. Go inside 'scripts/events_downloader.ts` and set the pool name and its address.

```bash
yarn run download
```

Wait for it to finish.

3. If it drops, or you simply want it to be up-to-date run, make sure to do step 2 for `scripts/events_updater.ts`:

```bash
yarn run update
```

At the end, move the database file from the source to the `data` folder.

# Future features
Not in any particular order

- Borrow Interest
- Show on the plotting when DLV and ALM rebalances happen
- Show volume fees captured
- IL realized between ALM rebalances