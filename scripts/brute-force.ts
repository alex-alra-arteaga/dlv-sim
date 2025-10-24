// scripts/brute-force.ts
// Run: node dist/scripts/brute-force.js --prebuilt --buildDir dist --level standard --tickSpacing 60 --runs 50 --mochaSpec dist/test/DLV.test.js --concurrency 32 --heapMB 2048 --heartbeatSec 20 --debug true

import { spawn } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

type Level = "air" | "light" | "standard" | "heavy" | "extreme";
type Range<T> = T[];

const args: Record<string, any> = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg.startsWith("--")) {
    const [k, v] = arg.replace(/^--/, "").split("=");
    if (v !== undefined) args[k] = v;
    else {
      const nxt = argv[i + 1];
      if (nxt && !nxt.startsWith("--")) {
        args[k] = nxt;
        i++;
      } else {
        args[k] = true;
      }
    }
  }
}

// ---- CLI / globals ----
const LEVEL: Level = (args.level ?? "standard") as Level;
const TICK_SPACING = Number(args.tickSpacing ?? 60);
const POOL_FEE_TIER = Number(args.feeTierBps ?? 30);
const RUNS_CAP = Number(args.runs ?? 0); // 0 = no cap
const PROJECT_ROOT = process.cwd();
const RESULTS_PATH = path.join(PROJECT_ROOT, "brute-force-results.jsonl");

const HEAP_MB = Number(args.heapMB ?? 2048);
const REPORTER = String(args.reporter ?? "min");
const DEBUG = String(args.debug ?? "false").toLowerCase() === "true";
const HEARTBEAT_SEC = Number(args.heartbeatSec ?? 30);
const MOCHA_SPEC = String(args.mochaSpec ?? "");              // e.g. dist/test/DLV.test.js
const MOCHA_GREP = String(args.grep ?? "");                   // e.g. "DLV simulation"
const MOCHA_TIMEOUT_MS = Number(args.mochaTimeoutMs ?? 600000000); // mocha soft timeout
const KILL_AFTER_SEC = Number(args.killAfterSec ?? 90000);        // hard kill if stuck
const LIST_ONCE = String(args.listOnce ?? "false").toLowerCase() === "true";
const PREBUILT = args.prebuilt === true || String(args.prebuilt || "").toLowerCase() === "true";
const BUILD_DIR = String(args.buildDir ?? "dist");

// ---- helpers ----
function getAvailMemMB() {
  try {
    const s = fs.readFileSync("/proc/meminfo", "utf8");
    const m = s.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (m) return Math.floor(Number(m[1]) / 1024);
  } catch {}
  return Math.floor(os.freemem() / (1024 * 1024));
}
function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }
function alignTick(n: number, spacing: number) { const q = Math.round(n / spacing); return q * spacing; }
function align4h(seconds: number) { const step = 4 * 60 * 60; const q = Math.round(seconds / step); return Math.max(step, q * step); }
function pctToWeight(p: number) { return Math.round(p * 1_000_000); }
function* cartesian<T>(...ranges: Range<T>[]): Generator<T[]> {
  if (ranges.length === 0) return;
  for (let i = 0; i < ranges.length; i++) if (!Array.isArray(ranges[i])) throw new Error(`Range ${i} not array`);
  const [head, ...tail] = ranges;
  if (tail.length === 0) { for (const v of head) yield [v]; return; }
  for (const h of head) for (const t of cartesian(...tail)) yield [h, ...t];
}
function halton(index: number, base: number) {
  let f = 1, r = 0, i = index;
  while (i > 0) { f = f / base; r = r + f * (i % base); i = Math.floor(i / base); }
  return r;
}
function seededInts(n: number, lo: number, hi: number, spacing = 1) {
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

// ---- parameter grids ----
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
    tight: [align4h(12 * 3600), align4h(24 * 3600)],
    medium: [align4h(24 * 3600), align4h(48 * 3600), align4h(72 * 3600)],
    wide: [align4h(12 * 3600), align4h(24 * 3600), align4h(48 * 3600), align4h(72 * 3600), align4h(96 * 3600)],
  };

  const weights_sm = [pctToWeight(0.05), pctToWeight(0.10), pctToWeight(0.15)];
  const weights_md = [pctToWeight(0.05), pctToWeight(0.10), pctToWeight(0.15), pctToWeight(0.20), pctToWeight(0.25)];

  let wideTh: number[] = [];
  let baseTh: number[] = [];
  let limitTh: number[] = [];
  let cPeriods: number[] = [];
  let weights: number[] = [];
  let devs: number[] = [];

  switch (level) {
    case "air": {
      wideTh = [alignTick(8000, TICK_SPACING), alignTick(12000, TICK_SPACING)];
      baseTh = [alignTick(3600, TICK_SPACING), alignTick(4800, TICK_SPACING)];
      limitTh = [alignTick(900, TICK_SPACING), alignTick(1200, TICK_SPACING)];
      cPeriods = PERIODS.tight;
      weights = [pctToWeight(0.10)];
      devs = [0.10];
      break;
    }
    case "light": {
      wideTh = [8000, 10000, 12000].map(v => alignTick(v, TICK_SPACING));
      baseTh = [3000, 4200, 4800].map(v => alignTick(v, TICK_SPACING));
      limitTh = [600, 900, 1200].map(v => alignTick(v, TICK_SPACING));
      cPeriods = PERIODS.medium;
      weights = weights_sm;
      devs = [0.05, 0.10, 0.15];
      break;
    }
    case "standard": {
      wideTh = [8000, 10000, 12000, 14000].map(v => alignTick(v, TICK_SPACING));
      baseTh = [2400, 3600, 4800, 5400].map(v => alignTick(v, TICK_SPACING));
      limitTh = [600, 900, 1200, 1800].map(v => alignTick(v, TICK_SPACING));
      cPeriods = PERIODS.wide;
      weights = weights_md;
      devs = [0.05, 0.10, 0.15, 0.20];
      break;
    }
    case "heavy": {
      wideTh = [6000, 8000, 10000, 12000, 14000, 16000].map(v => alignTick(v, TICK_SPACING));
      baseTh = [2400, 3000, 3600, 4200, 4800, 6000].map(v => alignTick(v, TICK_SPACING));
      limitTh = [600, 900, 1200, 1500, 1800, 2100].map(v => alignTick(v, TICK_SPACING));
      cPeriods = [12, 24, 36, 48, 72, 96].map(h => align4h(h * 3600));
      weights = [0.05, 0.075, 0.10, 0.125, 0.15, 0.20, 0.25].map(pctToWeight);
      devs = [0.03, 0.05, 0.075, 0.10, 0.125, 0.15, 0.20, 0.25];
      break;
    }
    case "extreme": {
      wideTh = seededInts(20, 6000, 20000, TICK_SPACING);
      baseTh = seededInts(20, 2000, 8000, TICK_SPACING);
      limitTh = seededInts(20, 400, 3000, TICK_SPACING);
      cPeriods = Array.from(new Set([12, 16, 20, 24, 28, 32, 36, 40, 48, 60, 72, 84, 96].map(h => align4h(h * 3600))));
      weights = Array.from({ length: 15 }, (_, i) => pctToWeight(0.04 + i * 0.014));
      devs = Array.from({ length: 12 }, (_, i) => 0.03 + i * 0.02);
      break;
    }
  }

  const charm: Charm[] = [];
  for (const [wT, bT, lT, period, wW] of cartesian(wideTh, baseTh, limitTh, cPeriods, weights)) {
    if (wT < 2 * bT) continue;
    if (lT > Math.floor(bT / 2)) continue;
    charm.push({ wideRangeWeight: wW, wideThreshold: wT, baseThreshold: bT, limitThreshold: lT, period });
  }

  const dlv: DLV[] = [];
  for (const [p, a, b] of cartesian([undefined], devs, devs)) {
    dlv.push({ period: p, deviationThresholdAbove: a, deviationThresholdBelow: b, debtToVolatileSwapFee: 0.0015 });
  }
  return { charm, dlv };
}

// ---- runner ----
type RunMeta = { wid: number; key: string; idx: number; total: number };
const active = new Map<number, { wid: number; key: string; start: number; lastOut: number; cmd: string }>();

function runOnce(charm: Charm, dlv: DLV, meta: RunMeta): Promise<{ ok: boolean; apy?: any; stdout?: string; stderr?: string }> {
  console.log(`[BRUTE-FORCE] [W${meta.wid}] [${meta.idx}/${meta.total}] key=${meta.key} charm=${JSON.stringify(charm)} dlv=${JSON.stringify(dlv)}`);

  const mochaCmd = PREBUILT
    ? [
        "node",
        `--max-old-space-size=${HEAP_MB}`,
        "--expose-gc",
        "./node_modules/mocha/bin/mocha",
        "--no-config",
        "--no-package",
        "--extension", "js",
        "--recursive",
        "--reporter", REPORTER,
        "--timeout", String(MOCHA_TIMEOUT_MS),
        "--exit",
        ...(MOCHA_GREP ? ["--grep", MOCHA_GREP] : []),
        "--spec", MOCHA_SPEC || `${BUILD_DIR}/test/**/*.js`,
      ]
    : [
        "node",
        "--import=tsx",
        `--max-old-space-size=${HEAP_MB}`,
        "--expose-gc",
        "./node_modules/mocha/bin/mocha",
        "--extension", "ts",
        "--reporter", REPORTER,
        "--timeout", String(MOCHA_TIMEOUT_MS),
        "--exit",
        ...(MOCHA_GREP ? ["--grep", MOCHA_GREP] : []),
      ];
  console.log(`[BRUTE-FORCE] CMD pid=? ${mochaCmd.join(" ")}`);

  const env = {
    ...process.env,
    BRUTE_FORCE: "true",
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
    const child = spawn(mochaCmd[0], mochaCmd.slice(1), { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const pid = child.pid!;
    active.set(pid, { wid: meta.wid, key: meta.key, start: Date.now(), lastOut: Date.now(), cmd: mochaCmd.join(" ") });
    console.log(`[SPAWN] pid=${pid} W${meta.wid} key=${meta.key}`);
    const hardKill = setTimeout(() => {
      console.error(`[TIMEOUT-KILL] pid=${pid} W${meta.wid} key=${meta.key} > ${KILL_AFTER_SEC}s → SIGKILL`);
      try { process.kill(pid, "SIGKILL" as any); } catch {}
    }, KILL_AFTER_SEC * 1000);

    let stdoutStr = "";
    let stderrStr = "";
    child.stdout?.on("data", (d) => {
      const s = d.toString("utf8");
      stdoutStr += s;
      const a = active.get(pid); if (a) a.lastOut = Date.now();
      if (DEBUG) process.stdout.write(`[pid ${pid}] ${s}`);
    });
    child.stderr?.on("data", (d) => {
      const s = d.toString("utf8");
      stderrStr += s;
      const a = active.get(pid); if (a) a.lastOut = Date.now();
      if (DEBUG) process.stderr.write(`[pid ${pid}][stderr] ${s}`);
    });
    child.on("error", (e) => console.error(`[CHILD-ERROR] pid=${pid} W${meta.wid} key=${meta.key}:`, e));

    child.on("close", (code) => {
      clearTimeout(hardKill);
      const a = active.get(pid);
      const age = a ? (((Date.now() - a.start) / 1000) | 0) : -1;
      active.delete(pid);
      console.log(`[BRUTE-FORCE] EXIT code=${code} pid=${pid} W${meta.wid} key=${meta.key} age=${age}s`);
      console.log(`[BRUTE-FORCE] Process stdout length: ${stdoutStr.length}`);
      console.log(`[BRUTE-FORCE] Process stderr length: ${stderrStr.length}`);

      if (stderrStr && stderrStr.trim()) console.error(`[BRUTE-FORCE ERROR] stderr:`, stderrStr);

      const m = stdoutStr.match(/RESULT_JSON:\s*(\{[\s\S]*?\})/);
      if (!m) {
        console.error(`[BRUTE-FORCE ERROR] RESULT_JSON not found (pid=${pid} key=${meta.key})`);
        const outTail = stdoutStr.split(/\r?\n/).slice(-80).join("\n");
        const errTail = stderrStr.split(/\r?\n/).slice(-80).join("\n");
        console.log(`[STDOUT-TAIL]\n${outTail}`);
        if (errTail.trim()) console.log(`[STDERR-TAIL]\n${errTail}`);
        resolve({ ok: false, stdout: stdoutStr, stderr: stderrStr });
        return;
      }

      try {
        const apy = JSON.parse(m[1]);
        console.log(`[BRUTE-FORCE SUCCESS] [W${meta.wid}] key=${meta.key} vault=${apy.vault?.toFixed?.(2)} hold=${apy.hold?.toFixed?.(2)} diff=${apy.diff?.toFixed?.(2)}`);
        resolve({ ok: true, apy, stdout: stdoutStr, stderr: stderrStr });
      } catch (e) {
        console.error(`[BRUTE-FORCE ERROR] Failed to parse APY JSON (pid=${pid} key=${meta.key}):`, e);
        console.log(`[BRUTE-FORCE] Raw APY string:`, m[1]);
        resolve({ ok: false, stdout: stdoutStr, stderr: stderrStr });
      }
    });
  });
}

// ---- main ----
(async function main() {
  const { charm, dlv } = grids(LEVEL);
  const totalCombos = charm.length * dlv.length;
  const MAX_MATERIALIZED_COMBOS = 5_000_000;

  if (totalCombos === 0) {
    throw new Error("No parameter combinations generated. Check level/tick spacing inputs.");
  }

  const comboAt = (index: number): { charm: Charm; dlv: DLV } => {
    if (index < 0 || index >= totalCombos) throw new Error(`Combo index ${index} out of range (0-${totalCombos - 1})`);
    const charmIdx = Math.floor(index / dlv.length);
    const dlvIdx = index % dlv.length;
    const charmCfg = charm[charmIdx];
    const dlvCfg = dlv[dlvIdx];
    return {
      charm: { ...charmCfg },
      dlv: { ...dlvCfg },
    };
  };

  // cap runs for ALL levels when --runs > 0 (deterministic quasi-random pick)
  let indices: number[];
  if (RUNS_CAP > 0 && totalCombos > RUNS_CAP) {
    const picks = new Set<number>();
    let i = 1;
    while (picks.size < Math.min(RUNS_CAP, totalCombos)) {
      const u = halton(i, 3);
      const idx = Math.min(totalCombos - 1, Math.floor(u * totalCombos));
      picks.add(idx);
      i++;
    }
    indices = Array.from(picks);
  } else {
    if (totalCombos > MAX_MATERIALIZED_COMBOS) {
      throw new Error(`Total combos (${totalCombos.toLocaleString()}) exceed safe materialized limit (${MAX_MATERIALIZED_COMBOS.toLocaleString()}). Use --runs to cap the search or reduce the grid.`);
    }
    indices = Array.from({ length: totalCombos }, (_, i) => i);
  }

  console.log(`Brute-force level=${LEVEL}, tickSpacing=${TICK_SPACING}, feeTier=${POOL_FEE_TIER}bps, combos=${totalCombos}, toRun=${indices.length}`);

  const resultsWS = fs.createWriteStream(RESULTS_PATH, { flags: "w" });

  let runCount = 0;
  let successCount = 0;
  let totalVaultAPY = 0;
  let totalHoldAPY = 0;
  let totalDiffAPY = 0;

  // concurrency
  const vcpus = os.cpus().length;
  const smt = process.arch === "x64" ? 2 : 1; // heuristic
  const physCores = Math.max(1, Math.floor(vcpus / smt));
  const availMB = getAvailMemMB();
  const perChildMB = HEAP_MB + 512; // overhead fudge
  const maxByMem = Math.max(1, Math.floor((availMB * 0.80) / perChildMB));
  const defaultConc = clamp(Math.min(physCores, maxByMem), 1, vcpus - 1);
  const CONCURRENCY = Number(args.concurrency ?? defaultConc);
  console.log(`[BRUTE-FORCE] vcpus=${vcpus} phys≈${physCores} availMB=${availMB} perChild≈${perChildMB} maxByMem=${maxByMem}`);
  console.log(`[BRUTE-FORCE] Using concurrency=${CONCURRENCY}`);

  if (LIST_ONCE) {
    const listCmd = [
      "node", "./node_modules/mocha/bin/mocha",
      "--no-config", "--no-package",
      "--extension", "js", "--recursive", "--list-files",
      "--spec", MOCHA_SPEC || `${BUILD_DIR}/test/**/*.js`,
    ];
    console.log(`[MOCHA-LIST] ${listCmd.join(" ")}`);
    const p = spawn(listCmd[0], listCmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let lf = ""; p.stdout?.on("data", d => lf += d.toString("utf8"));
    await new Promise(res => p.on("close", res as any));
    const files = lf.trim().split(/\r?\n/).filter(Boolean);
    console.log(`[MOCHA-LIST] files=${files.length}\n${files.slice(0, 12).join("\n")}${files.length > 12 ? "\n..." : ""}`);
  }

  const queue = indices.slice();

  // Heartbeat
  let hb: NodeJS.Timeout | undefined;
  if (HEARTBEAT_SEC > 0) {
    hb = setInterval(() => {
      const now = Date.now();
      const load = (os.loadavg?.() || []).map(x => x.toFixed(2)).join("/");
      console.log(`[HB] t=${new Date().toISOString()} run=${runCount}/${indices.length} ok=${successCount} q=${queue.length} active=${active.size} vcpus=${vcpus} load=${load}`);
      for (const [pid, a] of active) {
        const age = ((now - a.start) / 1000) | 0;
        const idle = ((now - a.lastOut) / 1000) | 0;
        console.log(`[HB] pid=${pid} W${a.wid} key=${a.key} age=${age}s idle=${idle}s cmd="${a.cmd}"`);
      }
    }, HEARTBEAT_SEC * 1000);
  }

  async function worker(wid: number) {
    while (true) {
      const idx = queue.shift();
      if (idx === undefined) return;

      const { charm: c, dlv: d } = comboAt(idx);
      const key = crypto.createHash("sha1").update(JSON.stringify({ c, d })).digest("hex").slice(0, 12);
      console.log(`[BRUTE-FORCE PROGRESS] [W${wid}] Starting run ${runCount + 1}/${indices.length} key=${key}`);
      const started = Date.now();
      const res = await runOnce(c, d, { wid, key, idx: runCount + 1, total: indices.length });
      const ms = Date.now() - started;

      const row = {
        key, level: LEVEL, tickSpacing: TICK_SPACING, poolFeeBps: POOL_FEE_TIER,
        charm: c, dlv: d,
        ok: res.ok,
        apy: res.ok ? res.apy : null,
        err: res.ok ? null : { stdout: res.stdout, stderr: res.stderr },
        ms,
      };

      if (res.ok && res.apy) {
        successCount++;
        totalVaultAPY += res.apy.vault ?? 0;
        totalHoldAPY += res.apy.hold ?? 0;
        totalDiffAPY += res.apy.diff ?? 0;
        console.log(`[BRUTE-FORCE SUCCESS] [W${wid}] key=${key} (${ms}ms)`);
      } else {
        console.log(`[BRUTE-FORCE FAILED] [W${wid}] key=${key} (${ms}ms)`);
      }

      resultsWS.write(JSON.stringify(row) + "\n");
      runCount++;
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
  await Promise.all(workers);
  await new Promise<void>((res) => resultsWS.end(res));
  if (hb) clearInterval(hb);

  const avgVaultAPY = successCount > 0 ? totalVaultAPY / successCount : 0;
  const avgHoldAPY = successCount > 0 ? totalHoldAPY / successCount : 0;
  const avgDiffAPY = successCount > 0 ? totalDiffAPY / successCount : 0;

  console.log(`[BRUTE-FORCE SUMMARY] Completed ${runCount} runs`);
  console.log(`[BRUTE-FORCE SUMMARY] Success rate: ${successCount}/${runCount} (${((successCount / runCount) * 100).toFixed(1)}%)`);
  console.log(`[BRUTE-FORCE SUMMARY] Average APY - Vault: ${avgVaultAPY.toFixed(2)}%, Hold: ${avgHoldAPY.toFixed(2)}%, Diff: ${avgDiffAPY.toFixed(2)}%`);
  console.log(`Done. Wrote ${RESULTS_PATH}`);
})();

process.on("unhandledRejection", (e) => { console.error("[UNHANDLED REJECTION]", e); });
process.on("uncaughtException", (e) => { console.error("[UNCAUGHT EXCEPTION]", e); });
process.on("SIGINT", () => { console.log("[SIGINT] Exiting"); process.exit(130); });
