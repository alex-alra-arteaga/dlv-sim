# DLV-Sim

DLV-Sim is a simulation tool for modeling custom Uniswap V3 strategies. You can plug different automated liquidity management (ALM), represented by 'accounts'.
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

4. In case you don't have pytorch, open a second terminal and run:
```bash
# 0. open venv
cd agents/debt
python3 -m venv .venv
source .venv/bin/activate

# 1. make sure pip resolves to the venv (either unalias or call the full path)
unalias pip 2>/dev/null || true

# 2. install torch into the venv
pip install --upgrade pip
# For Apple Silicon CPU-only build
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu

# 3. verify from the same shell
python -c "import torch; print(torch.__version__)"
```

5. Back in the first terminal:
```bash
export BF_DEBT_AGENT_JSON='{"pythonExecutable":"'"$PWD"'/agents/debt/.venv/bin/python"}'
```

### Enabling the ALM neural agent

If you want the neural network to drive the ALM rebalancing loop (`isALMNeuralRebalancing = true` in `config.ts`), mirror the setup above for the ALM agent:

```bash
# 0. open venv
cd agents/alm
python3 -m venv .venv
source .venv/bin/activate

# 1. make sure pip resolves to the venv (either unalias or call the full path)
unalias pip 2>/dev/null || true

# 2. install torch into the venv
pip install --upgrade pip
# For Apple Silicon CPU-only build
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu

# 3. verify from the same shell
python -c "import torch; print(torch.__version__)"
```

Then point the simulator at that interpreter (from the repo root):

```bash
export BF_ALM_AGENT_JSON='{"pythonExecutable":"'"$PWD"'/agents/alm/.venv/bin/python"}'
```

With this environment variable in place you can toggle `isALMNeuralRebalancing` to `true` in `config.ts` (or via `BF_ALM_AGENT_JSON`) and the TypeScript layer will spawn the Python inference process from `agents/alm/inference.py`.

## Usage

Run a simulation based on `config.ts`, for detailed information check [Configuration](#configuration):
```bash
yarn simulate
```

Run a combination of simulations concurrently with different configurations:
```bash
yarn build:scripts
# Defaults to standard level
yarn brute-force
# or with custom simple flags
yarn brute-force:light
```

You can customize the brute-force sweep with the following flags:

- `--level <air|light|standard|heavy|extreme>`: Chooses how wide the parameter grid is. Higher levels explore more Charm/DLV combinations (and therefore take longer).
- `--concurrency <n>`: Overrides the number of worker processes that run backtests in parallel. By default it uses `min(4, CPU cores - 1)`.
- `--runs <n>`: Caps the total number of parameter combinations executed. Use `0` (default) for all combinations produced by the selected level.
- `--heapMB <n>`: Sets the Node.js heap size (in megabytes) for each worker. Defaults to `18192`, but you can lower it to fit smaller machines.

- `--captureRebalanceDetails`: Whether to capture detailed per-rebalance data for each simulation. This increases memory usage and output file size, so it's off by default. Stores `token0/1` (amount), `accumulatedSwapFees0/1`, `debt` (amount, before rebalance), `volatileAssetPrice` (in USD and WAD, derived from the pool), and `rebalanceType` (ALM/DLV rebalance) for each rebalance event.

Example for MacBook Pro M3 with 18GB RAM:
```bash
node dist/scripts/brute-force.js --prebuilt --buildDir dist --level light --tickSpacing 60 --runs 0 --mochaSpec dist/test/DLV.test.js --concurrency 9 --heapMB 2048 --listOnce false --reporter min
```

At the end, both `yarn simulate` and `yarn brute-force` will output results in the `results` folder and will open a browser window with plots.
The first one individualized, the second one a summary of all the runs and lots of comparison plots for advanced analysis.

The command to plot the existing results is:
```bash
npx tsx scripts/plot-brute-force.ts
```

## Configuration

Configure parameters in `config.json` to adjust Charm, DLV and simulation look-up period settings.

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

## Configuration

Under `config.ts` you can set the type of pool you desire:

- **PoolConfig**
    - The repo comes with WBTC-USDC 0.3%, you can download any by going down to [Data Gathering](#data-gathering) and following instructions.
        - You will still have to set the pool information in `src/pool-config.ts`.

- **configLookUpPeriod**
    - You can choose between `MINUTELY`, `HOURLY`, `FOUR_HOURLY` and `DAILY` data. It defines the simulations steps (how often ALM and debt rebalancing are considered).

- **isDebtNeuralRebalancing**
    - Whether we want to use the neural network (sitting in `agents/debt`) to rebalance debt or a mechanical strategy.

- **targetCR**
    - The target CR we want to maintain, if using neural rebalancing this will vary per rebalance, but we always try to target 2x so that if the pool ratio is 50:50, we don't need to swap assets.

Below are only relevant if `isDebtNeuralRebalancing` is `true`.
- **topLeverage**
    - The maximum leverage we want to allow, the agent will try to stay below this value.
- **bottomLeverage**
    - The minimum leverage we want to allow, the agent will try to stay above this value
- **horizonSeconds**
    - The number of seconds in the future we want the agent to have observations over for internal inputs (vol_token_mean, vol_token_gain_mean_normed, calm_part_gain_mean_normed)

Charm (ALM solution) parameters:
- **wideRangeWeight**
    - The weight of the wide range liquidity band position, 1e6 is 100%.
- **wideThreshold**
    - The threshold (in ticks) from the current price to place the wide range position.
- **baseThreshold**
    - The threshold (in ticks) from the current price to place the base range position.
- **limitThreshold**
    - The threshold (in ticks) from the current price to place the limit range position.
- **period**
    - The number of seconds between each ALM rebalance.
- **activeRebalanceMode**
    - Chooses whether ALM rebalances rely on only `Active` swaps, only passive Charm `rebalance`, or `Hybrid` (default). In `Hybrid`, both conditions are checked independently and, when both fire, the active rebalance runs and the passive one is skipped so the vault never double-executes a rebalance. Change the `configuredActiveRebalanceMode` constant in `config.ts` for manual control or override it via the `ACTIVE_REBALANCE_MODE` env var.

DLV config (only relevant if `isDebtNeuralRebalancing` is `false`):
- **period**
    - The number of seconds between each DLV rebalance.
- **deviationThresholdAbove**
    - The threshold above the target CR to trigger a rebalance, in percentage from 0 to 1.
- **deviationThresholdBelow**
    - The threshold below the target CR to trigger a rebalance, in percentage from 0 to 1.
- **debtToVolatileSwapFee**
    - Swap cost (fee + slippage) to consider when swapping debt to volatile asset or viceversa inside a debt releveraging, in percentage from 0 to 1.

# Brute force Comparison

To compare between brute-force runs with underlying changes, for example between neural agent versions, and against a mechnical strategy, run a brute-force with **isDebtNeuralRebalancing** set to `true` and `false` respectively.

Once you do a run, change the name of the output file to `brute-force-results_ai_disabled.jsonl` or `brute-force-results_ai_enabled.jsonl`, respectively, and run the plotter:

```bash
# If they don't match in length, you can subset the larger one to the smaller one
# For example, if ai_enabled has 359 runs and ai_disabled has 300 runs:
head -n 300 brute-force-results_ai_disabled.jsonl > brute-force-results_ai_disabled_subset.jsonl

# And finally
python3 scripts/helper/brute-force-comparison/analyze_results.py
```

# Context

DLV swaps and Active ALM rebalances doesn't mock fees going through our own pool, slightly understating performance.
Neither we account for gas costs.

# Future features

- Borrow Interest
