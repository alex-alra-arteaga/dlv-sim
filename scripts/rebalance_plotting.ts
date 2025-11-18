import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import knex, { Knex } from "knex";
import Decimal from "decimal.js-light";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import customParse from "dayjs/plugin/customParseFormat.js";
import { getCurrentPoolConfig } from "../src/pool-config";
import { isDebtNeuralRebalancing } from "../config";
import { TickMath, FullMath } from "@bella-defintech/uniswap-v3-simulator";
import JSBI from "jsbi";

dayjs.extend(utc);
dayjs.extend(customParse);

/** ------- CONFIG -------- */
// Get dynamic configuration from pool config
const poolConfig = getCurrentPoolConfig();

const CONFIG = {
  sqlitePath: poolConfig.getRebalanceLogDbPath(),
  tableName: "rebalanceLog",
  outFile: "rebalance_dashboard.html",

  // token decimals (from pool configuration)
  asset0Symbol: poolConfig.getToken0Symbol(),
  asset1Symbol: poolConfig.getToken1Symbol(),
  asset0Decimals: poolConfig.getToken0Decimals(),
  asset1Decimals: poolConfig.getToken1Decimals(),
  volatileDecimals: poolConfig.getVolatileDecimals(),
  stableDecimals: poolConfig.getStableDecimals(),
  
  // volatile and stable token info
  volatileSymbol: poolConfig.getVolatileSymbol(),
  stableSymbol: poolConfig.getStableSymbol(),
  volatileName: poolConfig.getVolatileName(),
  stableName: poolConfig.getStableName(),
  
  // pool display info
  poolDisplayName: poolConfig.getDisplayName(),

  // fixed end date (inclusive)
  endDateUtc: dayjs.utc("2024-10-29").endOf("day").valueOf(),

  // date parsing formats used by DB 'date' column
  dateFormats: [
    "YYYY-MM-DD HH:mm:ss",
    "YYYY-MM-DD HH:mm:ss.SSS",
    "YYYY-MM-DDTHH:mm:ss[Z]",
    "YYYY-MM-DDTHH:mm:ss.SSS[Z]",
    "YYYY-MM-DDTHH:mm:ssZ",
    "YYYY-MM-DDTHH:mm:ss.SSSZ"
  ],
  maxRows: undefined as number | undefined
};
/** ------------------------ */

type RawRow = {
  wide0: string; wide1: string;
  base0: string; base1: string;
  limit0: string; limit1: string;
  total0: string; total1: string;
  nonVolatileAssetPrice: string; // 18
  prevTotalPoolValue: string;    // 8
  afterTotalPoolValue: string;   // 8
  lpRatio: string;               // 1e18 == perfectly balanced (higher => more stable)
  swapFeeStable: string;         // assumed native stable token units
  almSwapFeeStable?: string;
  prevCollateralRatio: string;   // 8
  afterCollateralRatio: string;  // 8
  accumulatedSwapFees0: string;  // accumulated token0 swap fees collected
  accumulatedSwapFees1: string;  // accumulated token1 swap fees collected
  volatileHoldValueStable: string; // value if we held volatile token from start
  realizedIL: string;            // realized impermanent loss
  swapFeesGainedThisPeriod: string; // swap fees gained during this period
  date: string;
};

type ParsedRow = {
  t: number; // unix ms (UTC)
  // price bands (assumed: 0=lower, 1=upper) - converted to prices
  wide0: number; wide1: number;
  base0: number; base1: number;
  limit0: number; limit1: number;
  // raw tick values for width calculations
  wide0Tick: number; wide1Tick: number;
  base0Tick: number; base1Tick: number;
  limit0Tick: number; limit1Tick: number;
  // series (scaled)
  price: number;              // volatile token price in stable token
  vaultValue: number;         // position value in stable token
  lpRatio: number;            // normalized (1 == balanced)
  prevCR: number; afterCR: number; // 0..?
  accumulatedSwapFees0Raw: number; // accumulated token0 swap fees (raw units)
  accumulatedSwapFees1Raw: number; // accumulated token1 swap fees (raw units)
  accumulatedSwapFeesUsd: number;  // accumulated swap fees in USD value
  accumulatedSwapFeesPercent: number; // accumulated swap fees as % of position
  volatileHoldValueStable: number; // value if we held volatile token from start (in stable token)
  realizedIL: number;          // realized impermanent loss in stable token
  swapFeesGainedThisPeriod: number; // swap fees gained during this period
  almFeeAccumulated?: number; // plugin property for ALM fee aggregation
} & {
  // Dynamic properties that depend on pool configuration
  [key: string]: number; // allows volatile, stable, feeStable, btcHoldValueInStable, etc.
};

function toNum(s: string): number {
  if (s == null) return NaN;
  const d = new Decimal(s);
  const n = d.toNumber();
  if (!Number.isFinite(n)) return d.isNegative() ? -Number.MAX_VALUE : Number.MAX_VALUE;
  return n;
}

function parseDate(s: string): number {
  for (const fmt of CONFIG.dateFormats) {
    const d = dayjs.utc(s, fmt, true);
    if (d.isValid()) return d.valueOf();
  }
  const iso = dayjs.utc(s);
  if (iso.isValid()) return iso.valueOf();
  const native = Date.parse(s);
  if (!Number.isNaN(native)) return native;
  throw new Error(`Unparseable date: "${s}"`);
}

// Convert tick to price using the same logic as the vault
function tickToPrice(tick: number): number {
  if (!Number.isFinite(tick)) return 0;
  
  // Get sqrt price at tick
  const sqrtPriceX96 = TickMath.getSqrtRatioAtTick(tick);
  
  // Convert to price: (sqrtPriceX96^2 / 2^192) * 10^18
  const priceX192 = JSBI.multiply(sqrtPriceX96, sqrtPriceX96);
  const Q96 = JSBI.exponentiate(JSBI.BigInt(2), JSBI.BigInt(96));
  const WAD = JSBI.BigInt("1000000000000000000"); // 1e18
  
  // priceWad = priceX192 / 2^192 * 1e18
  const priceWad = FullMath.mulDiv(priceX192, WAD, JSBI.multiply(Q96, Q96));
  
  // Apply decimal scaling for token pair
  // e.g. WBTC-USDC: WBTC has 8 decimals, USDC has 6 decimals
  // Need to multiply by 10^(asset0Decimals - asset1Decimals) = 10^(8-6) = 100
  const decimalAdjustment = Math.pow(10, CONFIG.asset0Decimals - CONFIG.asset1Decimals);
  
  // Convert JSBI to number and apply decimal adjustment
  return (Number(priceWad.toString()) / 1e18) * decimalAdjustment;
}

function parseRow(r: RawRow): ParsedRow {
  const result: ParsedRow = {
    t: parseDate(r.date),

    // Convert tick values to prices - these are stored as ticks in the database
    wide0: tickToPrice(toNum(r.wide0)),   wide1: tickToPrice(toNum(r.wide1)),
    base0: tickToPrice(toNum(r.base0)),   base1: tickToPrice(toNum(r.base1)),
    limit0: tickToPrice(toNum(r.limit0)), limit1: tickToPrice(toNum(r.limit1)),

    // Store raw tick values for width calculations
    wide0Tick: toNum(r.wide0),   wide1Tick: toNum(r.wide1),
    base0Tick: toNum(r.base0),   base1Tick: toNum(r.base1),
    limit0Tick: toNum(r.limit0), limit1Tick: toNum(r.limit1),

    // scaled fields
    price:       toNum(r.nonVolatileAssetPrice) / 1e18,
    vaultValue:  toNum(r.afterTotalPoolValue)   / 1e6,  // Scale by another 10x (1e6 instead of 1e7)
    lpRatio:     toNum(r.lpRatio) / 1e18,
    prevCR:      toNum(r.prevCollateralRatio)  / 100,  // Changed from 1e8 to 100
    afterCR:     toNum(r.afterCollateralRatio) / 100,  // Changed from 1e8 to 100
    
    // accumulated swap fees
    accumulatedSwapFees0Raw: toNum(r.accumulatedSwapFees0 || "0") / 10 ** CONFIG.asset0Decimals,
    accumulatedSwapFees1Raw: toNum(r.accumulatedSwapFees1 || "0") / 10 ** CONFIG.asset1Decimals,
    
    // IL tracking fields
    realizedIL: toNum(r.realizedIL || "0") / 100, // convert from basis points to percentage (10000 basis points = 100%)
    swapFeesGainedThisPeriod: toNum(r.swapFeesGainedThisPeriod || "0") / 1e6,
    
    // computed fields (will be calculated below)
    accumulatedSwapFeesUsd: 0,
    accumulatedSwapFeesPercent: 0,
    volatileHoldValueStable: toNum(r.volatileHoldValueStable || "0") / 1e6,
  };

  // Add dynamic token properties
  result[CONFIG.asset0Symbol.toLowerCase()] = toNum(r.total0) / 10 ** CONFIG.asset0Decimals;
  result[CONFIG.asset1Symbol.toLowerCase()] = toNum(r.total1) / 10 ** CONFIG.asset1Decimals;
  const stableDivisor = 10 ** CONFIG.stableDecimals;
  result[`fee${CONFIG.stableSymbol}`] = toNum(r.swapFeeStable || "0") / stableDivisor;
  result[`almFee${CONFIG.stableSymbol}`] = toNum(r.almSwapFeeStable || "0") / stableDivisor;
  result[`${CONFIG.volatileSymbol.toLowerCase()}HoldValue${CONFIG.stableSymbol}`] = toNum(r.volatileHoldValueStable || "0") / 1e6;

  return result;
}

function postProcessSwapFees(row: ParsedRow): ParsedRow {
  // Calculate USD value of accumulated swap fees using current price
  const volatileFeesUsd = row.accumulatedSwapFees0Raw * row.price;
  row.accumulatedSwapFeesUsd = row.accumulatedSwapFees1Raw + volatileFeesUsd;
  
  // Calculate percentage of position value
  if (row.vaultValue > 0) {
    row.accumulatedSwapFeesPercent = (row.accumulatedSwapFeesUsd / row.vaultValue) * 100;
  } else {
    row.accumulatedSwapFeesPercent = 0;
  }
  
  return row;
}

// batching utilities
type Grain = "raw" | "day" | "week" | "month";
type Series = ParsedRow[];

function floorToGrain(tsMs: number, g: Grain): number {
  const d = dayjs.utc(tsMs);
  switch (g) {
    case "day": return d.startOf("day").valueOf();
    case "week": return d.startOf("week").valueOf();
    case "month": return d.startOf("month").valueOf();
    default: return tsMs;
  }
}

function aggregate(rows: Series, g: Grain): Series {
  if (g === "raw") return rows;
  const map = new Map<number, ParsedRow[]>();
  for (const r of rows) {
    const k = floorToGrain(r.t, g);
    const arr = map.get(k) ?? [];
    arr.push(r);
    map.set(k, arr);
  }
  const out: Series = [];
  const feeKey = `fee${CONFIG.stableSymbol}`;
  const almFeeKey = `almFee${CONFIG.stableSymbol}`;
  for (const [k, arr] of map) {
    const n = arr.length;
    const sum = (p: (x: ParsedRow) => number) => arr.reduce((a, b) => a + p(b), 0);
    const token0Key = CONFIG.asset0Symbol.toLowerCase();
    const token1Key = CONFIG.asset1Symbol.toLowerCase();
    
    out.push({
      t: k,
      wide0: sum(x => x.wide0) / n,  wide1: sum(x => x.wide1) / n,
      base0: sum(x => x.base0) / n,  base1: sum(x => x.base1) / n,
      limit0: sum(x => x.limit0) / n,limit1: sum(x => x.limit1) / n,
      // Include tick values for width calculations
      wide0Tick: sum(x => x.wide0Tick) / n,  wide1Tick: sum(x => x.wide1Tick) / n,
      base0Tick: sum(x => x.base0Tick) / n,  base1Tick: sum(x => x.base1Tick) / n,
      limit0Tick: sum(x => x.limit0Tick) / n, limit1Tick: sum(x => x.limit1Tick) / n,
      // Use dynamic token symbols for aggregation
      [token0Key]: sum(x => x[token0Key]) / n,
      [token1Key]: sum(x => x[token1Key]) / n,
      price: sum(x => x.price) / n,  vaultValue: sum(x => x.vaultValue) / n,
      [feeKey]: sum(x => x[feeKey] || 0),  // sum fees within bucket
      [almFeeKey]: sum(x => x[almFeeKey] || 0),
      lpRatio: sum(x => x.lpRatio) / n,
      prevCR:  sum(x => x.prevCR) / n, afterCR: sum(x => x.afterCR) / n,
      // For accumulated swap fees, take the last value in the bucket
      accumulatedSwapFees0Raw: arr[arr.length - 1].accumulatedSwapFees0Raw,
      accumulatedSwapFees1Raw: arr[arr.length - 1].accumulatedSwapFees1Raw,
      accumulatedSwapFeesUsd: arr[arr.length - 1].accumulatedSwapFeesUsd,
      accumulatedSwapFeesPercent: arr[arr.length - 1].accumulatedSwapFeesPercent,
      // IL tracking - take last values for accumulated metrics
      volatileHoldValueStable: arr[arr.length - 1].volatileHoldValueStable,
      realizedIL: arr[arr.length - 1].realizedIL,
      swapFeesGainedThisPeriod: sum(x => x.swapFeesGainedThisPeriod), // sum over period
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function htmlTemplate(payload: { raw: Series; day: Series; week: Series; month: Series; a0: string; a1: string; volatileSymbol: string; stableSymbol: string; debtAgentEnabled: boolean }): string {
  const dataJSON = JSON.stringify(payload);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Rebalance Dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js" defer></script>
<style>
  :root{ --blue:#2f80ed; --pink:#ff4da6; --muted:#94a3b8; --band-blue:#a3c8ff; --band-pink:#ffc0da; --band-gray:#d8dee9; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, 'Helvetica Neue', Arial; margin: 22px; color:#0f172a; }
  .row { display: grid; grid-template-columns: 1fr; gap: 18px; }
  .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px; }
  .controls { display: flex; gap: 12px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
  .muted { color: #6b7280; font-size: 12px; }
  .kpi { display:flex; gap:16px; flex-wrap:wrap; margin-bottom: 10px; }
  .kpi .box { padding:8px 10px; border-radius:10px; background:#f3f4f6;}
  .mono{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;}
  h2{margin:8px 0 4px 4px; font-size:16px;}
  .status-chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;border-radius:999px;padding:6px 12px;font-weight:600;}
  .status-chip .icon{font-size:14px;line-height:1;}
  .status-chip.on{background:#e0e7ff;color:#312e81;}
  .status-chip.off{background:#fee2e2;color:#991b1b;}
</style>
</head>
<body>
  <div class="controls">
    <label><strong>Batching</strong>
      <select id="grain">
        <option value="day">Daily</option>
        <option value="week">Weekly</option>
        <option value="month">Monthly</option>
      </select>
    </label>
    <div class="muted">• Drag the range slider under each chart to zoom</div>
    <div class="status-chip ${payload.debtAgentEnabled ? "on" : "off"}" title="Debt neural agent status">
      <span class="icon">${payload.debtAgentEnabled ? "🧠" : "⚙️"}</span>
      <span>${payload.debtAgentEnabled ? "Debt neural agent enabled" : "Debt neural agent disabled"}</span>
    </div>
  </div>

  <div class="kpi">
    <div class="box mono" id="points"></div>
    <div class="box mono" id="range"></div>
    <div class="box mono" id="apy"></div>
  </div>

  <div class="row">
    <div class="card"><h2>Vault vs Hold (0.01 ${payload.volatileSymbol})</h2><div id="perf"></div></div>
    <div class="card"><h2>Position Ranges (wide/base/limit)</h2><div id="ranges"></div></div>
    <div class="card"><h2>${payload.volatileSymbol} vs ${payload.stableSymbol} Share</h2><div id="shares"></div></div>
    <div class="card"><h2>Collateral Ratio (target 200%)</h2><div id="cr"></div></div>
    <div class="card"><h2>Accumulated Swap Fee Cost</h2><div id="fees"></div></div>
      <div class="card"><h2>Accumulated Swap Fee cost on active rebalances</h2><div id="almFees"></div></div>
    <div class="card"><h2>Swap fees collected</h2><div id="swapFeesCollected"></div></div>
    <div class="card"><h2>Impermanent Loss vs ${payload.volatileSymbol} Hold Strategy</h2><div id="realizedIL"></div></div>
    <div class="card"><h2>Position Range Widths</h2><div id="widths"></div></div>
    <div class="card"><h2>Portfolio Value Breakdown</h2><div id="portfolio"></div></div>
    <div class="card"><h2>Collateral Ratio Changes</h2><div id="crchange"></div></div>
  </div>
<script>
const PAYLOAD = ${dataJSON};

const dateAxis = {
  type: 'date',
  showspikes: true,
  spikemode: 'across',
  rangeslider: { visible: true },
  tickformat: '%Y-%m-%d',
  tickformatstops: [
    { dtickrange: [null, 24*60*60*1000], value: '%Y-%m-%d %H:%M' },
    { dtickrange: [24*60*60*1000, null], value: '%Y-%m-%d' }
  ]
};
const numAxis = { showspikes:true, spikemode:'across', tickformat:'~s' };
const hoverLines = { type:'scatter', mode:'lines', hovertemplate:'%{x|%Y-%m-%d %H:%M}<br>%{y:,}<extra></extra>' };

function xDates(d){ return d.map(p => new Date(p.t)); }
function fmtRange(d){ return d.length ? 
  new Date(d[0].t).toISOString().slice(0,16).replace('T',' ') + ' → ' +
  new Date(d[d.length-1].t).toISOString().slice(0,16).replace('T',' ') : '-'; }

function calculateAPY(data) {
  if (!data.length || data.length < 2) return { vault: 0, hold: 0, diff: 0 };
  
  const first = data[0];
  const last = data[data.length - 1];
  const daysDiff = (last.t - first.t) / (1000 * 60 * 60 * 24);
  
  if (daysDiff <= 0) return { vault: 0, hold: 0, diff: 0 };
  
  // Calculate returns
  const vaultReturn = (last.vaultValue / first.vaultValue) - 1;
  const holdReturn = ((last.price * 0.01) / (first.price * 0.01)) - 1;
  
  // Annualize (compound)
  const vaultAPY = (Math.pow(1 + vaultReturn, 365 / daysDiff) - 1) * 100;
  const holdAPY = (Math.pow(1 + holdReturn, 365 / daysDiff) - 1) * 100;
  const diffAPY = vaultAPY - holdAPY;
  
  return { vault: vaultAPY, hold: holdAPY, diff: diffAPY };
}

function perfSeries(data, grain) {
  if (!data.length) return [];
  const x = xDates(data);
  const startVault = data[0].vaultValue;
  const startHold  = data[0].price * 0.01;
  const vaultPct = data.map(d => (d.vaultValue / startVault - 1)*100);
  const holdPct  = data.map(d => ((d.price*0.01) / startHold - 1)*100);
  // requirement: "Vault vs Hold" shouldn't be an area graph when Raw
  const common = { ...hoverLines };
  return [
    { ...common, name:'Vault %', x, y: vaultPct, line:{color:'var(--blue)'} },
    { ...common, name:\`Hold % (0.01 \${PAYLOAD.volatileSymbol})\`, x, y: holdPct, line:{color:'var(--pink)'} }
  ];
}

function rangesSeries(data){
  const x = xDates(data);
  // Three shaded bands: wide, base, limit. No "update price" line.
  const baseLower = { ...hoverLines, name:'Base (low)',  x, y:data.map(d=>d.base0),  line:{width:0.5, color:'var(--band-blue)'}, showlegend:false };
  const baseUpper = { ...hoverLines, name:'Base range',  x, y:data.map(d=>d.base1),  fill:'tonexty', line:{color:'var(--band-blue)'} };

  const limitLower= { ...hoverLines, name:'Limit (low)', x, y:data.map(d=>d.limit0), line:{width:0.5, color:'var(--band-pink)'}, showlegend:false };
  const limitUpper= { ...hoverLines, name:'Limit range', x, y:data.map(d=>d.limit1), fill:'tonexty', line:{color:'var(--band-pink)'} };

  const wideLower = { ...hoverLines, name:'Wide (low)',  x, y:data.map(d=>d.wide0),  line:{width:0.5, color:'var(--band-gray)'}, showlegend:false };
  const wideUpper = { ...hoverLines, name:'Wide range',  x, y:data.map(d=>d.wide1),  fill:'tonexty', line:{color:'var(--band-gray)'} };

  return [wideLower, wideUpper, baseLower, baseUpper, limitLower, limitUpper];
}

function almFeesSeries(data){
  const x = xDates(data);
  const key = \`almFee\${PAYLOAD.stableSymbol}\`;
  const cumFees = [];
  let acc = 0;
  for (const d of data){ acc += d[key] || 0; cumFees.push(acc); }
  const pct = data.map((d,i) => d.vaultValue ? (cumFees[i] / d.vaultValue) : 0);

  return [
    { ...hoverLines, name:\`Active rebalance cumulative fees (\${PAYLOAD.stableSymbol})\`, x, y:cumFees, line:{color:'#7c3aed'} },
    { ...hoverLines, name:'Fees as % of position', x, y:pct, yaxis:'y2', line:{color:'#f97316'},
      hovertemplate:'%{x|%Y-%m-%d %H:%M}<br>%{y:.2f}%<extra></extra>' }
  ];
}

function sharesSeries(data){
  const x = xDates(data);
  // lpRatio is normalized to 1 == 50:50 (more stable token when >1)
  const r = data.map(d => Math.max(0, d.lpRatio || 0));

  // Convert ratio to % shares
  const stableShare = r.map(v => 100 * (v / (1 + v)));   // e.g. r=2 => 66.67%
  const volatileShare = stableShare.map(s => 100 - s);        // complement

  return [
    { type:'scatter', mode:'lines', name:\`\${PAYLOAD.volatileSymbol} share (LP)\`, x, y:volatileShare, stackgroup:'one',
      line:{color:'var(--blue)'},
      hovertemplate:\`%{x|%Y-%m-%d %H:%M}<br>\${PAYLOAD.volatileSymbol}: %{y:.2f}%<extra></extra>\` },
    { type:'scatter', mode:'lines', name:\`\${PAYLOAD.stableSymbol} share (LP)\`, x, y:stableShare, stackgroup:'one',
      line:{color:'var(--pink)'},
      hovertemplate:\`%{x|%Y-%m-%d %H:%M}<br>\${PAYLOAD.stableSymbol}: %{y:.2f}%<extra></extra>\` }
  ];
}

function sharesLayout(data){
  const L = layout('${payload.a0} vs ${payload.a1} share', '% of portfolio');
  return L;
}

function crSeries(data){
  const x = xDates(data);
  // afterCR is already in percentage format after parsing (divided by 100)
  const crPct = data.map(d => (d.afterCR ?? 0));
  return [
    { ...hoverLines, name:'Collateral Ratio', x, y: crPct, line:{color:'var(--blue)'} }
  ];
}

function crLayout(data){
  const center = 200;
  const vals = data.map(d => (d.afterCR ?? 0)).filter(Number.isFinite);
  let min = Math.min(...(vals.length ? vals : [center-50]));
  let max = Math.max(...(vals.length ? vals : [center+50]));
  const dev = Math.max(Math.abs(min-center), Math.abs(max-center), 5);  // keep at least ±5%
  const L = layout('Collateral Ratio (target 200%)', '%');
  L.yaxis.range = [center - dev, center + dev];
  L.shapes = [
    { type:'line', xref:'paper', x0:0, x1:1, y0:center, y1:center,
      line:{dash:'dash', width:1, color:'#94a3b8'} },
    { type:'rect', xref:'paper', x0:0, x1:1, y0:center-5, y1:center+5,
      fillcolor:'rgba(147,197,253,0.15)', line:{width:0} }
  ];
  return L;
}

function feesSeries(data){
  const x = xDates(data);
  const cumFees = [];
  let acc = 0;
  for (const d of data){ acc += d[\`fee\${PAYLOAD.stableSymbol}\`] || 0; cumFees.push(acc); }
  const pct = data.map((d,i) => d.vaultValue ? (cumFees[i] / d.vaultValue) : 0);

  return [
    { ...hoverLines, name:\`Cumulative fees (\${PAYLOAD.stableSymbol})\`, x, y:cumFees, line:{color:'var(--blue)'} },
    { ...hoverLines, name:'Fees as % of position', x, y:pct, yaxis:'y2', line:{color:'var(--pink)'},
      hovertemplate:'%{x|%Y-%m-%d %H:%M}<br>%{y:.2f}%<extra></extra>' }
  ];
}

function swapFeesCollectedSeries(data){
  const x = xDates(data);
  const feesUsd = data.map(d => d.accumulatedSwapFeesUsd);
  const feesPercent = data.map(d => d.accumulatedSwapFeesPercent);

  return [
    { ...hoverLines, name:'Accumulated swap fees collected (USD)', x, y:feesUsd, line:{color:'var(--blue)'} },
    { ...hoverLines, name:'Fees as % of position', x, y:feesPercent, yaxis:'y2', line:{color:'var(--pink)'},
      hovertemplate:'%{x|%Y-%m-%d %H:%M}<br>%{y:.2f}%<extra></extra>' }
  ];
}

function realizedILSeries(data){
  const x = xDates(data);
  
  // IL is already stored as percentage (converted from basis points)
  // Positive = vault underperformed (traditional IL)
  // Negative = vault outperformed (impermanent gain)
  const realizedILPercent = data.map(d => d.realizedIL);
  
  const volatileHoldValue = data.map(d => d[\`\${PAYLOAD.volatileSymbol.toLowerCase()}HoldValue\${PAYLOAD.stableSymbol}\`]);
  const vaultValue = data.map(d => d.vaultValue);

  return [
    { ...hoverLines, name:'Impermanent Loss (%)', x, y:realizedILPercent, line:{color:'#ef4444', width:3} },
    { ...hoverLines, name:\`\${PAYLOAD.volatileSymbol} Hold Value (\${PAYLOAD.stableSymbol})\`, x, y:volatileHoldValue, yaxis:'y2', line:{color:'#f97316'}, visible:'legendonly' },
    { ...hoverLines, name:\`Vault Value (\${PAYLOAD.stableSymbol})\`, x, y:vaultValue, yaxis:'y2', line:{color:'#22c55e'}, visible:'legendonly' }
  ];
}

function rangeWidthSeries(data){
  const x = xDates(data);
  // Use raw tick values for width calculations to show actual tick differences
  const wideWidth = data.map(d => d.wide1Tick - d.wide0Tick);
  const baseWidth = data.map(d => d.base1Tick - d.base0Tick);
  const limitWidth = data.map(d => d.limit1Tick - d.limit0Tick);

  return [
    { ...hoverLines, name:'Wide range width', x, y:wideWidth, line:{color:'var(--band-gray)'} },
    { ...hoverLines, name:'Base range width', x, y:baseWidth, line:{color:'var(--band-blue)'} },
    { ...hoverLines, name:'Limit range width', x, y:limitWidth, line:{color:'var(--band-pink)'} }
  ];
}

function portfolioValueSeries(data){
  const x = xDates(data);
  // Use vault value as authoritative total, derive asset splits from LP ratio
  const totalValue = data.map(d => d.vaultValue);
  const stableValue = data.map(d => {
    const ratio = d.lpRatio || 1;
    // lpRatio > 1 means more stable token weight
    return d.vaultValue * (ratio / (1 + ratio));
  });
  const volatileValue = data.map((d,i) => totalValue[i] - stableValue[i]);

  return [
    { type:'scatter', mode:'lines', name:\`\${PAYLOAD.volatileSymbol} value (\${PAYLOAD.stableSymbol})\`, x, y:volatileValue, stackgroup:'one',
      line:{color:'var(--blue)'},
      hovertemplate:\`%{x|%Y-%m-%d %H:%M}<br>\${PAYLOAD.volatileSymbol}: $%{y:,.0f}<extra></extra>\` },
    { type:'scatter', mode:'lines', name:\`\${PAYLOAD.stableSymbol} value\`, x, y:stableValue, stackgroup:'one',
      line:{color:'var(--pink)'},
      hovertemplate:\`%{x|%Y-%m-%d %H:%M}<br>\${PAYLOAD.stableSymbol}: $%{y:,.0f}<extra></extra>\` },
    { ...hoverLines, name:'Total portfolio value', x, y:totalValue, line:{color:'#000', width:2},
      hovertemplate:'%{x|%Y-%m-%d %H:%M}<br>Total: $%{y:,.0f}<extra></extra>' }
  ];
}

function crChangeSeries(data){
  const x = xDates(data);
  const crChange = data.map(d => ((d.afterCR ?? 0) - (d.prevCR ?? 0))); // Change in CR percentage points (already in %)
  const colors = crChange.map(v => v >= 0 ? 'rgba(34,197,94,0.7)' : 'rgba(239,68,68,0.7)'); // green/red

  return [
    { type:'bar', name:'CR Change', x, y:crChange, 
      marker:{color:colors},
      hovertemplate:'%{x|%Y-%m-%d %H:%M}<br>CR Change: %{y:+.2f}pp<extra></extra>' },
    // Zero line
    { type:'scatter', mode:'lines', x:[x[0], x[x.length-1]], y:[0, 0], 
      line:{dash:'dash', color:'#94a3b8', width:1}, showlegend:false, hoverinfo:'skip' }
  ];
}

function layout(title, yTitle, y2Title=null){
  return {
    title, hovermode:'x unified',
    xaxis: { ...dateAxis },
    yaxis: { ...numAxis, title: yTitle },
    ...(y2Title ? { yaxis2: { overlaying:'y', side:'right', title:y2Title, tickformat:'~s' } } : {}),
    margin:{ t:40, r:10, b:30, l:60 },
    legend:{ orientation:'h', x:0, y:1.12 }
  };
}

function render(grain='raw'){
  const data = PAYLOAD[grain];

  Plotly.react('perf',   perfSeries(data, grain),   layout('Vault vs Hold', '% Return'));
  Plotly.react('ranges', rangesSeries(data),        layout('Position price ranges', \`Price (\${PAYLOAD.stableSymbol})\`));
  Plotly.react('shares', sharesSeries(data),        layout(\`\${PAYLOAD.volatileSymbol} vs \${PAYLOAD.stableSymbol} share\`, '% of portfolio'));
  Plotly.react('cr',     crSeries(data),            crLayout(data));
  Plotly.react('fees',   feesSeries(data),          layout(\`Accumulated swap fee cost paid on DLV rebalances\`, PAYLOAD.stableSymbol, '% of position'));
  Plotly.react('almFees', almFeesSeries(data),      layout(\`Accumulated Swap Fee cost on active rebalances\`, PAYLOAD.stableSymbol, '% of position'));
  Plotly.react('swapFeesCollected', swapFeesCollectedSeries(data), layout('Swap fees collected', 'USD', '% of position'));
  Plotly.react('realizedIL', realizedILSeries(data), layout(\`Impermanent Loss vs \${PAYLOAD.volatileSymbol} Hold Strategy\`, 'IL %', PAYLOAD.stableSymbol));
  Plotly.react('portfolio', portfolioValueSeries(data), layout(\`Portfolio value breakdown\`, \`Value (\${PAYLOAD.stableSymbol})\`));
  Plotly.react('crchange', crChangeSeries(data),    layout('Collateral ratio change per rebalance', 'Change (percentage points)'));
  Plotly.react('widths', rangeWidthSeries(data),    layout('Position range widths (could be dynamically changed)', 'Tick width'));

  // Update KPI displays
  document.getElementById('points').textContent = \`\${data.length.toLocaleString()} points\`;
  document.getElementById('range').textContent = fmtRange(data);
  
  // Calculate and display APY
  const apy = calculateAPY(data);
  const apyColor = apy.diff >= 0 ? '#22c55e' : '#ef4444';
  document.getElementById('apy').innerHTML = 
    \`APY: <span style="color:var(--blue)">\${apy.vault.toFixed(1)}%</span> vs Hold: <span style="color:var(--pink)">\${apy.hold.toFixed(1)}%</span> | <span style="color:\${apyColor}">Δ\${apy.diff >= 0 ? '+' : ''}\${apy.diff.toFixed(1)}%</span>\`;
}

document.addEventListener('DOMContentLoaded', ()=>{
  const sel = document.getElementById('grain');
  sel.addEventListener('change', () => render(sel.value));
  render(sel.value);
});
</script>
</body>
</html>`;
}

async function main() {
  const db: Knex = knex({
    client: "sqlite3",
    connection: { filename: CONFIG.sqlitePath },
    useNullAsDefault: true
  });

  try {
    let q = db<RawRow>(CONFIG.tableName).select("*").orderBy("date", "asc");
    if (CONFIG.maxRows) q = q.limit(CONFIG.maxRows);
    const rows = await q;
    if (!rows.length) throw new Error(`No rows found in ${CONFIG.tableName}`);

    // parse + scale
    const parsedAll = rows.map(parseRow)
      .map(postProcessSwapFees)
      .filter(r => r.t <= CONFIG.endDateUtc)
      .sort((a,b)=>a.t-b.t);

    const payload = {
      raw: parsedAll,
      day: aggregate(parsedAll, "day"),
      week: aggregate(parsedAll, "week"),
      month: aggregate(parsedAll, "month"),
      a0: CONFIG.asset0Symbol,
      a1: CONFIG.asset1Symbol,
      volatileSymbol: CONFIG.volatileSymbol,
      stableSymbol: CONFIG.stableSymbol,
      debtAgentEnabled: isDebtNeuralRebalancing
    };

    const html = htmlTemplate(payload);
    const outPath = path.resolve(CONFIG.outFile);
    fs.writeFileSync(outPath, html);
    console.log(`✔ Dashboard written to ${outPath}`);

    // auto-open in default browser
    openInBrowser(outPath);
  } finally {
    await db.destroy();
  }
}

function openInBrowser(filePath: string) {
  const abs = path.resolve(filePath);
  const platform = process.platform;
  let cmd: string, args: string[];

  if (platform === "darwin") {        // macOS
    cmd = "open"; args = [abs];
  } else if (platform === "win32") {  // Windows
    cmd = "cmd";  args = ["/c", "start", "", abs];
  } else {                             // Linux/*nix
    cmd = "xdg-open"; args = [abs];
  }
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.unref();
}

main().catch((e) => { console.error(e); process.exit(1); });
