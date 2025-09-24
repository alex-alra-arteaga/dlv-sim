// e.g. tsx scripts/brute-force.ts --level standard --tickSpacing 60 --runs 0

// NOTE: Assumes config.ts 'configLookUpPeriod' is FOUR_HOURLY
// The pool we are looking is defined in config.ts::setCurrentPoolConfig
import { spawn } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

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

const LEVEL: Level = (args.level ?? "standard") as Level;
const TICK_SPACING = Number(args.tickSpacing ?? 60);
const POOL_FEE_TIER = Number(args.feeTierBps ?? 30); // just metadata for report
const SEED = String(args.seed ?? "42");
const RUNS_CAP = Number(args.runs ?? 0); // 0 = no cap
const PROJECT_ROOT = process.cwd();
const RESULTS_PATH = path.join(PROJECT_ROOT, "brute-force-results.jsonl");

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

function grids(level: Level) {
  const PERIODS = {
    tight: [align4h(12*3600), align4h(24*3600)],
    medium: [align4h(24*3600), align4h(48*3600), align4h(72*3600)],
    wide: [align4h(12*3600), align4h(24*3600), align4h(48*3600), align4h(72*3600), align4h(96*3600)]
  };

  const weights_sm = [pctToWeight(0.05), pctToWeight(0.10), pctToWeight(0.15)];
  const weights_md = [pctToWeight(0.05), pctToWeight(0.10), pctToWeight(0.15), pctToWeight(0.20), pctToWeight(0.25)];

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
      wideTh = [alignTick(8000, TICK_SPACING), alignTick(12000, TICK_SPACING)];
      baseTh = [alignTick(3600, TICK_SPACING), alignTick(4800, TICK_SPACING)];
      limitTh = [alignTick(900, TICK_SPACING), alignTick(1200, TICK_SPACING)];
      cPeriods = PERIODS.tight;
      weights = [pctToWeight(0.10)];
  // dlvPeriods = [undefined, align4h(7*24*3600)]; // commented out
      devs = [0.10];
      break;
    }
    case "light": {
      wideTh = [8000, 10000, 12000].map(v=>alignTick(v,TICK_SPACING));
      baseTh = [3000, 4200, 4800].map(v=>alignTick(v,TICK_SPACING));
      limitTh = [600, 900, 1200].map(v=>alignTick(v,TICK_SPACING));
      cPeriods = PERIODS.medium;
      weights = weights_sm;
  // dlvPeriods = [undefined, align4h(7*24*3600), align4h(30*24*3600)]; // commented out
      devs = [0.05, 0.10, 0.15];
      break;
    }
    case "standard": {
      wideTh = [8000, 10000, 12000, 14000].map(v=>alignTick(v,TICK_SPACING));
      baseTh = [2400, 3600, 4800, 5400].map(v=>alignTick(v,TICK_SPACING));
      limitTh = [600, 900, 1200, 1800].map(v=>alignTick(v,TICK_SPACING));
      cPeriods = PERIODS.wide;
      weights = weights_md;
  // dlvPeriods = [undefined, align4h(7*24*3600), align4h(30*24*3600), align4h(90*24*3600)]; // commented out
      devs = [0.05, 0.10, 0.15, 0.20];
      break;
    }
    case "heavy": {
      wideTh = [6000, 8000, 10000, 12000, 14000, 16000].map(v=>alignTick(v,TICK_SPACING));
      baseTh = [2400, 3000, 3600, 4200, 4800, 6000].map(v=>alignTick(v,TICK_SPACING));
      limitTh = [600, 900, 1200, 1500, 1800, 2100].map(v=>alignTick(v,TICK_SPACING));
      cPeriods = [12,24,36,48,72,96].map(h=>align4h(h*3600));
      weights = [0.05,0.075,0.10,0.125,0.15,0.20,0.25].map(pctToWeight);
  // dlvPeriods = [undefined, ...[12,24,36,48,72].map(h=>align4h(h*3600))]; // commented out
      devs = [0.03,0.05,0.075,0.10,0.125,0.15,0.20,0.25];
      break;
    }
    case "extreme": {
      // large quasi-random coverage; sizes are upper-bounded later by RUNS_CAP
      wideTh  = seededInts(20, 6000, 20000, TICK_SPACING);
      baseTh  = seededInts(20, 2000,  8000, TICK_SPACING);
      limitTh = seededInts(20,  400,  3000, TICK_SPACING);
      cPeriods = Array.from(new Set([12,16,20,24,28,32,36,40,48,60,72,84,96].map(h=>align4h(h*3600))));
      weights = Array.from({length: 15}, (_,i)=>pctToWeight(0.04 + i*0.014)); // ~4%..24.6%
  // dlvPeriods = [undefined, ...[12,16,20,24,28,32,36,40,48,60,72].map(h=>align4h(h*3600))]; // commented out
      devs = Array.from({length: 12}, (_,i)=>0.03 + i*0.02); // 3%..25%
      break;
    }
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
  for (const [p, a, b] of cartesian([undefined], devs, devs)) {
    dlv.push({
      period: p,
      deviationThresholdAbove: a,
      deviationThresholdBelow: b,
      debtToVolatileSwapFee: 0.0015,
    });
  }

  return { charm, dlv };
}

// ---- runner ----
function runOnce(charm: Charm, dlv: DLV): Promise<{ ok: boolean; apy?: any; stdout?: string; stderr?: string }> {
  console.log(`[BRUTE-FORCE] Starting run with charm config:`, JSON.stringify(charm));
  console.log(`[BRUTE-FORCE] DLV config:`, JSON.stringify(dlv));

  const mochaCmd = [
    "node",
    "--import=tsx",
    "--max-old-space-size=18192",
    "--expose-gc",
    "./node_modules/mocha/bin/mocha",
    "--extension", "ts",
  ];
  console.log(`[BRUTE-FORCE] Running mocha command: ${mochaCmd.join(' ')}`);

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
      const res = await runOnce(c, d);
      const ms = Date.now() - started;

      const row = {
        key, level: LEVEL, tickSpacing: TICK_SPACING, poolFeeBps: POOL_FEE_TIER,
        charm: c, dlv: d,
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

      fs.appendFileSync(RESULTS_PATH, JSON.stringify(row) + "\n", "utf8");
      runCount++;
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  // Summary statistics
  const avgVaultAPY = successCount > 0 ? totalVaultAPY / successCount : 0;
  const avgHoldAPY = successCount > 0 ? totalHoldAPY / successCount : 0;
  const avgDiffAPY = successCount > 0 ? totalDiffAPY / successCount : 0;

  console.log(`[BRUTE-FORCE SUMMARY] Completed ${runCount} runs`);
  console.log(`[BRUTE-FORCE SUMMARY] Success rate: ${successCount}/${runCount} (${((successCount/runCount)*100).toFixed(1)}%)`);
  console.log(`[BRUTE-FORCE SUMMARY] Average APY - Vault: ${avgVaultAPY.toFixed(2)}%, Hold: ${avgHoldAPY.toFixed(2)}%, Diff: ${avgDiffAPY.toFixed(2)}%`);
  console.log(`Done. Wrote ${RESULTS_PATH}`);
})();
