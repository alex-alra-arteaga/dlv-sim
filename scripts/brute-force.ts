// e.g. tsx scripts/brute-force.ts --level standard --tickSpacing 60 --runs 0

// NOTE: Assumes config.ts 'configLookUpPeriod' is FOUR_HOURLY
// The pool we are looking is defined in config.ts::setCurrentPoolConfig
import { spawn } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sqlite3 from "sqlite3";

import { configLookUpPeriod, activeRebalanceMode, ActiveRebalanceMode } from "../config";
import { getCurrentPoolConfig } from "../src/pool-config";

type Level = "air" | "light" | "standard" | "heavy" | "extreme";
type Range<T> = T[];

// ---- CLI ----
const args: Record<string, any> = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg.startsWith('--')) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (value !== undefined) {
      // Format: --key=value
      args[key] = value;
    } else {
      // Format: --key value (check next argument)
      const nextArg = argv[i + 1];
      if (nextArg && !nextArg.startsWith('--')) {
        args[key] = nextArg;
        i++; // Skip next argument since we consumed it
      } else {
        args[key] = true; // Boolean flag
      }
    }
  }
}

function parseBooleanFlag(raw: unknown): boolean {
  if (raw === undefined) return false;
  if (typeof raw === "boolean") return raw;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "") return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return true;
}

const LEVEL: Level = (args.level ?? "standard") as Level;
const TICK_SPACING = Number(args.tickSpacing ?? 60);
const POOL_FEE_TIER = Number(args.feeTierBps ?? 30); // just metadata for report
const RUNS_CAP = Number(args.runs ?? 0); // 0 = no cap
const HEAP_MB = Number(args.heapMB ?? 18192);
const PROJECT_ROOT = process.cwd();
const RESULTS_PATH = path.join(PROJECT_ROOT, "brute-force-results.jsonl");
const IS_ACTIVE_REBALANCE = activeRebalanceMode === ActiveRebalanceMode.ACTIVE;
const CAPTURE_REBALANCE_DETAILS = parseBooleanFlag(args.captureRebalanceDetails);
const fsp = fs.promises;
const poolConfig = getCurrentPoolConfig();
const REBALANCE_DB_REL_PATH = poolConfig.getRebalanceLogDbPath();
const REBALANCE_LOG_DB_PATH = path.isAbsolute(REBALANCE_DB_REL_PATH)
  ? REBALANCE_DB_REL_PATH
  : path.join(PROJECT_ROOT, REBALANCE_DB_REL_PATH);
const SNAPSHOT_DIR = path.join(os.tmpdir(), "dlv-sim-rebalance-logs");

// ---- helpers ----
function alignTick(n: number, spacing: number) {
  const q = Math.round(n / spacing);
  return q * spacing;
}
function align4h(seconds: number) {
  const step = 4*60*60;
  const q = Math.round(seconds / step);
  return Math.max(step, q * step);
}
function pctToWeight(p: number) { // 0.10 -> 100000
  return Math.round(p * 1_000_000);
}
function* cartesian<T>(...ranges: Range<T>[]): Generator<T[]> {
  if (ranges.length === 0) return;
  
  // Check that all ranges are iterable arrays
  for (let i = 0; i < ranges.length; i++) {
    if (!Array.isArray(ranges[i])) {
      throw new Error(`Range at index ${i} is not an array: ${typeof ranges[i]} - ${ranges[i]}`);
    }
  }
  
  const [head, ...tail] = ranges;
  if (tail.length === 0) { for (const v of head) yield [v]; return; }
  for (const h of head) for (const t of cartesian(...tail)) yield [h, ...t];
}
function halton(index: number, base: number) {
  let f = 1, r = 0, i = index;
  while (i > 0) { f = f / base; r = r + f * (i % base); i = Math.floor(i / base); }
  return r;
}
function seededInts(n: number, lo: number, hi: number, spacing=1) {
  // halton-seeded pseudo; deterministic
  const out: number[] = [];
  let i = 1;
  while (out.length < n) {
    const u = halton(i, 2);
    const raw = lo + Math.round(u * (hi - lo));
    const aligned = alignTick(raw, spacing);
    if (!out.includes(aligned)) out.push(aligned);
    i++;
  }
  return out;
}
// No longer needed; we won't patch files for concurrency

const RANGE_THINNING_FACTOR = 0.5;
const WEIGHT_THINNING_FACTOR = 0.5;
const uniq = <T>(values: T[]) => Array.from(new Set(values));
const thinTickValue = (value: number) =>
  alignTick(Math.max(TICK_SPACING, value * RANGE_THINNING_FACTOR), TICK_SPACING);
const thinTickSet = (values: number[]) => uniq(values.map(thinTickValue));
const alignTickSet = (values: number[]) => values.map((value) => alignTick(value, TICK_SPACING));
const maybeThinTicks = (values: number[]) => IS_ACTIVE_REBALANCE ? thinTickSet(values) : alignTickSet(values);
const thinWeightSet = (percentages: number[]) =>
  uniq(percentages.map((pct) => pctToWeight(Math.max(0, pct * WEIGHT_THINNING_FACTOR))));
const maybeThinWeights = (percentages: number[]) =>
  IS_ACTIVE_REBALANCE
    ? thinWeightSet(percentages)
    : percentages.map((pct) => pctToWeight(pct));
const scaledSeedBounds = (lo: number, hi: number): [number, number] => {
  const scaledLo = thinTickValue(lo);
  const scaledHi = thinTickValue(hi);
  const hiAdjusted = Math.max(scaledLo + TICK_SPACING, scaledHi);
  return [scaledLo, hiAdjusted];
};
const maybeThinSeedBounds = (lo: number, hi: number): [number, number] =>
  IS_ACTIVE_REBALANCE ? scaledSeedBounds(lo, hi) : [lo, hi];

// ---- parameter grids per level ----
// constraints (reasonable defaults):
// wideThreshold >= 2 * baseThreshold
// limitThreshold <= baseThreshold / 2
// period multiple of 4h; tick thresholds multiple of TICK_SPACING
type Charm = {
  wideRangeWeight: number;
  wideThreshold: number;
  baseThreshold: number;
  limitThreshold: number;
  period: number;
};
type DLV = {
  period?: number;
  deviationThresholdAbove?: number;
  deviationThresholdBelow?: number;
  debtToVolatileSwapFee: number;
};
type CharmOutput = Omit<Charm, "period"> & Partial<Pick<Charm, "period">>;
type DLVOutput = DLV | undefined;
type RawRebalanceRow = {
  id?: number;
  wide0?: string; wide1?: string;
  base0?: string; base1?: string;
  limit0?: string; limit1?: string;
  total0?: string; total1?: string;
  nonVolatileAssetPrice?: string;
  prevTotalPoolValue?: string;
  afterTotalPoolValue?: string;
  lpRatio?: string;
  swapFeeStable?: string;
  almSwapFeeStable?: string;
  prevCollateralRatio?: string;
  afterCollateralRatio?: string;
  accumulatedSwapFees0?: string;
  accumulatedSwapFees1?: string;
  volatileHoldValueStable?: string;
  realizedIL?: string;
  swapFeesGainedThisPeriod?: string;
  date?: string;
  debt?: string;
  rebalanceType?: string;
};
type RebalanceStep = {
  token0: string;
  token1: string;
  accumulatedSwapFees0: string;
  accumulatedSwapFees1: string;
  rebalanceType?: string;
  volatileAssetPrice: string;
  debt: string;
  timestampMs?: number;
};

const formatCharmForOutput = (cfg: Charm): CharmOutput => {
  if (!IS_ACTIVE_REBALANCE) return cfg;
  const { period, ...rest } = cfg;
  return rest;
};

const formatDLVForOutput = (cfg: DLV): DLVOutput => {
  if (IS_ACTIVE_REBALANCE) return undefined;
  return cfg;
};

const strOrZero = (value: unknown, fallback = "0") =>
  value === undefined || value === null ? fallback : String(value);
const optionalString = (value: unknown) =>
  value === undefined || value === null ? undefined : String(value);
let snapshotDirReady = false;

async function ensureSnapshotDir(): Promise<void> {
  if (snapshotDirReady) return;
  await fsp.mkdir(SNAPSHOT_DIR, { recursive: true });
  snapshotDirReady = true;
}

async function snapshotRebalanceDb(runKey: string): Promise<string | undefined> {
  try {
    await ensureSnapshotDir();
    const snapshotPath = path.join(SNAPSHOT_DIR, `${runKey}-${Date.now()}.db`);
    await fsp.copyFile(REBALANCE_LOG_DB_PATH, snapshotPath);
    return snapshotPath;
  } catch (err) {
    console.error(`[BRUTE-FORCE WARNING] Failed to snapshot rebalance DB for run ${runKey}:`, err);
    return undefined;
  }
}

function mapRowToStep(row: RawRebalanceRow, _: number): RebalanceStep {
  const timestampMs = row.date ? Date.parse(row.date) : undefined;
  return {
    token0: strOrZero(row.total0),
    token1: strOrZero(row.total1),
    accumulatedSwapFees0: strOrZero(row.accumulatedSwapFees0),
    accumulatedSwapFees1: strOrZero(row.accumulatedSwapFees1),
    rebalanceType: optionalString(row.rebalanceType),
    volatileAssetPrice: strOrZero(row.nonVolatileAssetPrice),
    debt: strOrZero(row.debt),
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : undefined,
  };
}

function fetchRebalanceStepsFromDb(dbPath: string): Promise<RebalanceStep[]> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) {
        reject(err);
        return;
      }
      db.all("SELECT * FROM rebalanceLog ORDER BY id ASC", (allErr, rows: RawRebalanceRow[]) => {
        if (allErr) {
          db.close(() => reject(allErr));
          return;
        }
        const steps = rows.map((row, idx) => mapRowToStep(row, idx));
        db.close((closeErr) => {
          if (closeErr) {
            reject(closeErr);
            return;
          }
          resolve(steps);
        });
      });
    });
  });
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await fsp.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[BRUTE-FORCE WARNING] Failed to clean up snapshot ${filePath}:`, err);
    }
  }
}

async function readStepsFromSnapshot(snapshotPath: string): Promise<RebalanceStep[]> {
  try {
    return await fetchRebalanceStepsFromDb(snapshotPath);
  } finally {
    await safeUnlink(snapshotPath);
  }
}

function grids(level: Level) {
  const PERIODS = {
    tight: [align4h(12*3600), align4h(24*3600)],
    medium: [align4h(24*3600), align4h(48*3600), align4h(72*3600)],
    wide: [align4h(12*3600), align4h(24*3600), align4h(48*3600), align4h(72*3600), align4h(96*3600)]
  };

  const weights_sm = maybeThinWeights([0.05, 0.10, 0.15]);
  const weights_md = maybeThinWeights([0.05, 0.10, 0.15, 0.20, 0.25]);

  // base ranges (pre-constraint)
  let wideTh: number[] = [];
  let baseTh: number[] = [];
  let limitTh: number[] = [];
  let cPeriods: number[] = [];
  let weights: number[] = [];
  // let dlvPeriods: Array<number|undefined> = [];
  let devs: number[] = [];

  switch (level) {
    case "air": {
      wideTh = maybeThinTicks([8000, 12000]);
      baseTh = maybeThinTicks([3600, 4800]);
      limitTh = maybeThinTicks([900, 1200]);
      cPeriods = PERIODS.tight;
      weights = maybeThinWeights([0.10]);
  // dlvPeriods = [undefined, align4h(7*24*3600)]; // commented out
      devs = [0.10];
      break;
    }
    case "light": {
      wideTh = maybeThinTicks([8000, 10000, 12000]);
      baseTh = maybeThinTicks([3000, 4200, 4800]);
      limitTh = maybeThinTicks([600, 900, 1200]);
      cPeriods = PERIODS.medium;
      weights = weights_sm;
  // dlvPeriods = [undefined, align4h(7*24*3600), align4h(30*24*3600)]; // commented out
      devs = [0.05, 0.10, 0.15];
      break;
    }
    case "standard": {
      wideTh = maybeThinTicks([8000, 10000, 12000, 14000]);
      baseTh = maybeThinTicks([2400, 3600, 4800, 5400]);
      limitTh = maybeThinTicks([600, 900, 1200, 1800]);
      cPeriods = PERIODS.wide;
      weights = weights_md;
  // dlvPeriods = [undefined, align4h(7*24*3600), align4h(30*24*3600), align4h(90*24*3600)]; // commented out
      devs = [0.05, 0.10, 0.15, 0.20];
      break;
    }
    case "heavy": {
      wideTh = maybeThinTicks([6000, 8000, 10000, 12000, 14000, 16000]);
      baseTh = maybeThinTicks([2400, 3000, 3600, 4200, 4800, 6000]);
      limitTh = maybeThinTicks([600, 900, 1200, 1500, 1800, 2100]);
      cPeriods = [12,24,36,48,72,96].map(h=>align4h(h*3600));
      weights = maybeThinWeights([0.05,0.075,0.10,0.125,0.15,0.20,0.25]);
  // dlvPeriods = [undefined, ...[12,24,36,48,72].map(h=>align4h(h*3600))]; // commented out
      devs = [0.03,0.05,0.075,0.10,0.125,0.15,0.20,0.25];
      break;
    }
    case "extreme": {
      // large quasi-random coverage; sizes are upper-bounded later by RUNS_CAP
      const [wideLo, wideHi] = maybeThinSeedBounds(6000, 20000);
      const [baseLo, baseHi] = maybeThinSeedBounds(2000, 8000);
      const [limitLo, limitHi] = maybeThinSeedBounds(400, 3000);
      wideTh  = seededInts(20, wideLo, wideHi, TICK_SPACING);
      baseTh  = seededInts(20, baseLo, baseHi, TICK_SPACING);
      limitTh = seededInts(20, limitLo, limitHi, TICK_SPACING);
      cPeriods = Array.from(new Set([12,16,20,24,28,32,36,40,48,60,72,84,96].map(h=>align4h(h*3600))));
      const extremeWeightPcts = Array.from({length: 15}, (_,i)=>0.04 + i*0.014);
      weights = maybeThinWeights(extremeWeightPcts);
  // dlvPeriods = [undefined, ...[12,16,20,24,28,32,36,40,48,60,72].map(h=>align4h(h*3600))]; // commented out
      devs = Array.from({length: 12}, (_,i)=>0.03 + i*0.02); // 3%..25%
      break;
    }
  }

  if (IS_ACTIVE_REBALANCE) {
    devs = [0.01];
  }

  // build charm configs honoring constraints
  const charm: Charm[] = [];
  for (const [wT, bT, lT, period, wW] of cartesian(wideTh, baseTh, limitTh, cPeriods, weights)) {
    if (wT < 2*bT) continue;
    if (lT > Math.floor(bT/2)) continue;
    charm.push({
      wideRangeWeight: wW,
      wideThreshold: wT,
      baseThreshold: bT,
      limitThreshold: lT,
      period,
    });
  }

  // build dlv configs
  const dlv: DLV[] = [];
  // for (const [p, a, b] of cartesian(dlvPeriods, devs, devs)) {
  //   dlv.push({
  //     period: p,
  //     deviationThresholdAbove: a,
  //     deviationThresholdBelow: b,
  //     debtToVolatileSwapFee: 0.0015,
  //   });
  // }
  // Use a fixed undefined period while dlvPeriods logic is commented out
  const dlvPeriodOptions: Array<number | undefined> = [undefined];
  for (const [p, a, b] of cartesian(dlvPeriodOptions, devs, devs)) {
    const next: DLV = {
      deviationThresholdAbove: a,
      deviationThresholdBelow: b,
      debtToVolatileSwapFee: 0.0015,
    };
    if (p !== undefined) next.period = p;
    dlv.push(next);
  }

  return { charm, dlv };
}

// ---- runner ----
function runOnce(charm: Charm, dlv: DLV, workerId: number): Promise<{ ok: boolean; apy?: any; stdout?: string; stderr?: string }> {
  console.log(`[BRUTE-FORCE] [W${workerId}] Starting run with charm config:`, JSON.stringify(formatCharmForOutput(charm)));
  const dlvLog = formatDLVForOutput(dlv);
  if (dlvLog !== undefined) {
    console.log(`[BRUTE-FORCE] [W${workerId}] DLV config:`, JSON.stringify(dlvLog));
  }

  const mochaCmd = [
    "node",
    "--import=tsx",
    `--max-old-space-size=${HEAP_MB}`,
    "--expose-gc",
    "./node_modules/mocha/bin/mocha",
    "--extension", "ts",
  ];
  console.log(`[BRUTE-FORCE] [W${workerId}] Running mocha command: ${mochaCmd.join(' ')}`);

  // Setup worker-specific Python virtual environment
  const baseDir = PROJECT_ROOT;
  const workerVenvPath = path.join(baseDir, "agents", "debt", `.venv-${workerId}`, "bin", "python");
  const inferencePath = path.join(baseDir, "agents", "debt", "inference.py");

  const env = {
    ...process.env,
    BRUTE_FORCE: 'true',
    BF_CHARM_JSON: JSON.stringify({
      wideRangeWeight: charm.wideRangeWeight,
      wideThreshold: charm.wideThreshold,
      baseThreshold: charm.baseThreshold,
      limitThreshold: charm.limitThreshold,
      period: charm.period,
    }),
    BF_DLV_JSON: JSON.stringify({
      period: dlv.period,
      deviationThresholdAbove: dlv.deviationThresholdAbove,
      deviationThresholdBelow: dlv.deviationThresholdBelow,
      debtToVolatileSwapFee: dlv.debtToVolatileSwapFee,
    }),
    BF_DEBT_AGENT_JSON: JSON.stringify({
      topLeverage: 2.2,
      bottomLeverage: 1.8,
      horizonSeconds: 600,
      pythonExecutable: workerVenvPath,
      inferencePath: inferencePath,
    }),
    BF_ALM_AGENT_JSON: JSON.stringify({
      horizonSteps: 1000,
      stepSeconds: configLookUpPeriod,
      pythonExecutable: workerVenvPath,
      inferencePath: path.join(baseDir, "agents", "alm", "inference.py"),
    }),
  } as NodeJS.ProcessEnv;

  return new Promise((resolve) => {
    const child = spawn(mochaCmd[0], mochaCmd.slice(1), {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdoutStr = '';
    let stderrStr = '';
    child.stdout?.on('data', (d) => { stdoutStr += d.toString('utf8'); });
    child.stderr?.on('data', (d) => { stderrStr += d.toString('utf8'); });

    child.on('close', (code) => {
      console.log(`[BRUTE-FORCE] Process exit code: ${code}`);
      console.log(`[BRUTE-FORCE] Process stdout length: ${stdoutStr.length}`);
      console.log(`[BRUTE-FORCE] Process stderr length: ${stderrStr.length}`);

      if (stderrStr && stderrStr.trim()) {
        console.error(`[BRUTE-FORCE ERROR] stderr:`, stderrStr);
      }

      const m = stdoutStr.match(/RESULT_JSON:\s*(\{[\s\S]*?\})/);
      if (!m) {
        console.error(`[BRUTE-FORCE ERROR] Could not find RESULT_JSON in stdout`);
        console.log(`[BRUTE-FORCE] Full stdout:`, stdoutStr);
        resolve({ ok: false, stdout: stdoutStr, stderr: stderrStr });
        return;
      }

      try {
        const apy = JSON.parse(m[1]);
        console.log(`[BRUTE-FORCE SUCCESS] Parsed APY:`, apy);
        resolve({ ok: true, apy, stdout: stdoutStr, stderr: stderrStr });
      } catch (parseError) {
        console.error(`[BRUTE-FORCE ERROR] Failed to parse APY JSON:`, parseError);
        console.log(`[BRUTE-FORCE] Raw APY string:`, m[1]);
        resolve({ ok: false, stdout: stdoutStr, stderr: stderrStr });
      }
    });
  });
}

// ---- main brute-force ----
(async function main() {
  const { charm, dlv } = grids(LEVEL);

  const combos: Array<{charm: Charm; dlv: DLV}> = [];
  // Cartesian product of all charm and dlv configurations
  for (const c of charm) for (const d of dlv) {
    combos.push({ charm: c, dlv: d });
  }

  // trim for "extreme" using quasi-random subsample if cap set
  let indices = combos.map((_,i)=>i);
  if (RUNS_CAP > 0 && combos.length > RUNS_CAP) {
    // deterministic pick using halton
    const picks: number[] = [];
    let i = 1;
    while (picks.length < RUNS_CAP) {
      const u = halton(i, 3);
      const idx = Math.floor(u * combos.length);
      if (!picks.includes(idx)) picks.push(idx);
      i++;
    }
    indices = picks;
  }

  console.log(`Brute-force level=${LEVEL}, tickSpacing=${TICK_SPACING}, feeTier=${POOL_FEE_TIER}bps, combos=${combos.length}, toRun=${indices.length}`);

  // header for results
  fs.writeFileSync(RESULTS_PATH, "", "utf8");

  const rowWritePromises: Promise<void>[] = [];
  function queueRowWrite(row: Record<string, any>, runKey: string, snapshotPath?: string) {
    const detailPromise: Promise<RebalanceStep[] | undefined> = CAPTURE_REBALANCE_DETAILS
      ? (snapshotPath
          ? readStepsFromSnapshot(snapshotPath).catch((err) => {
              console.error(`[BRUTE-FORCE WARNING] Failed to read rebalance log for run ${runKey}:`, err);
              return [];
            })
          : Promise.resolve([]))
      : Promise.resolve(undefined);

    const writePromise = detailPromise.then((steps) => {
      const outputRow = CAPTURE_REBALANCE_DETAILS
        ? { ...row, rebalanceSteps: steps ?? [] }
        : row;
      fs.appendFileSync(RESULTS_PATH, JSON.stringify(outputRow) + "\n", "utf8");
    });

    rowWritePromises.push(writePromise);
  }

  let runCount = 0;
  let successCount = 0;
  let totalVaultAPY = 0;
  let totalHoldAPY = 0;
  let totalDiffAPY = 0;

  // Concurrency settings
  const defaultConc = Math.max(1, Math.min(4, os.cpus().length - 1));
  const CONCURRENCY = Number(args.concurrency ?? defaultConc);
  console.log(`[BRUTE-FORCE] Using concurrency=${CONCURRENCY}`);

  const queue = indices.slice();
  async function worker(wid: number) {
    while (true) {
      const idx = queue.shift();
      if (idx === undefined) return;

      const { charm: c, dlv: d } = combos[idx];
      const key = crypto.createHash("sha1").update(JSON.stringify({ c, d })).digest("hex").slice(0, 12);
      console.log(`[BRUTE-FORCE PROGRESS] [W${wid}] Starting run ${runCount + 1}/${indices.length} key=${key}`);
      const started = Date.now();
      const res = await runOnce(c, d, wid);
      const ms = Date.now() - started;

      const row = {
        key, level: LEVEL, tickSpacing: TICK_SPACING, poolFeeBps: POOL_FEE_TIER,
        charm: formatCharmForOutput(c),
        dlv: formatDLVForOutput(d),
        ok: res.ok,
        apy: res.ok ? res.apy : null,
        err: res.ok ? null : { stdout: res.stdout, stderr: res.stderr },
        ms
      };

      if (res.ok && res.apy) {
        successCount++;
        totalVaultAPY += res.apy.vault;
        totalHoldAPY += res.apy.hold;
        totalDiffAPY += res.apy.diff;
        console.log(`[BRUTE-FORCE SUCCESS] [W${wid}] Run: vault=${res.apy.vault.toFixed(2)}%, hold=${res.apy.hold.toFixed(2)}%, diff=${res.apy.diff.toFixed(2)}% (${ms}ms)`);
      } else {
        console.log(`[BRUTE-FORCE FAILED] [W${wid}] Run: ${key} (${ms}ms)`);
      }

      let snapshotPath: string | undefined;
      if (CAPTURE_REBALANCE_DETAILS) {
        snapshotPath = await snapshotRebalanceDb(key);
      }

      queueRowWrite(row, key, snapshotPath);
      runCount++;
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
  await Promise.all(workers);
  await Promise.all(rowWritePromises);

  // Summary statistics
  const avgVaultAPY = successCount > 0 ? totalVaultAPY / successCount : 0;
  const avgHoldAPY = successCount > 0 ? totalHoldAPY / successCount : 0;
  const avgDiffAPY = successCount > 0 ? totalDiffAPY / successCount : 0;

  console.log(`[BRUTE-FORCE SUMMARY] Completed ${runCount} runs`);
  console.log(`[BRUTE-FORCE SUMMARY] Success rate: ${successCount}/${runCount} (${((successCount/runCount)*100).toFixed(1)}%)`);
  console.log(`[BRUTE-FORCE SUMMARY] Average APY - Vault: ${avgVaultAPY.toFixed(2)}%, Hold: ${avgHoldAPY.toFixed(2)}%, Diff: ${avgDiffAPY.toFixed(2)}%`);
  console.log(`Done. Wrote ${RESULTS_PATH}`);
})();
