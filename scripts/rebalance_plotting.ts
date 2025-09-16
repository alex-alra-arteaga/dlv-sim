import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import knex, { Knex } from "knex";
import Decimal from "decimal.js-light";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import customParse from "dayjs/plugin/customParseFormat.js";
dayjs.extend(utc);
dayjs.extend(customParse);

/** ------- CONFIG -------- */
const CONFIG = {
  sqlitePath: "./rebalance_log_usdc_wbtc_3000.db",
  tableName: "rebalanceLog",
  outFile: "rebalance_dashboard.html",

  // token decimals (adjust if your schema differs)
  asset0Symbol: "WBTC",
  asset1Symbol: "USDC",
  asset0Decimals: 8,  // total0
  asset1Decimals: 6,  // total1

  // fixed end date (inclusive)
  endDateUtc: dayjs.utc("2024-12-15").endOf("day").valueOf(),

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
  lpRatio: string;               // 1e18 == perfectly balanced (higher => more USDC)
  swapFeeUSDC: string;           // assumed native USDC units (override if needed)
  prevCollateralRatio: string;   // 8
  afterCollateralRatio: string;  // 8
  date: string;
};

type ParsedRow = {
  t: number; // unix ms (UTC)
  // price bands (assumed: 0=lower, 1=upper)
  wide0: number; wide1: number;
  base0: number; base1: number;
  limit0: number; limit1: number;
  // inventory (scaled to human units)
  wbtc: number; usdc: number;
  // series (scaled)
  price: number;              // BTC in USDC
  vaultValue: number;         // position value in USDC
  feeUSDC: number;            // swap fees (USDC)
  lpRatio: number;            // normalized (1 == balanced)
  prevCR: number; afterCR: number; // 0..?
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

function parseRow(r: RawRow): ParsedRow {
  return {
    t: parseDate(r.date),

    // price ranges: assuming already in price units; change if your DB stores scaled ints
    wide0: toNum(r.wide0),  wide1: toNum(r.wide1),
    base0: toNum(r.base0),  base1: toNum(r.base1),
    limit0: toNum(r.limit0),limit1: toNum(r.limit1),

    // inventory (scale by token decimals)
    wbtc: toNum(r.total0) / 10 ** CONFIG.asset0Decimals,
    usdc: toNum(r.total1) / 10 ** CONFIG.asset1Decimals,

    // scaled fields
    price:       toNum(r.nonVolatileAssetPrice) / 1e18,
    vaultValue:  toNum(r.afterTotalPoolValue)   / 1e6,  // Scale by another 10x (1e6 instead of 1e7)
    feeUSDC:     toNum(r.swapFeeUSDC) / 1e6,
    lpRatio:     toNum(r.lpRatio) / 1e18,
    prevCR:      toNum(r.prevCollateralRatio)  / 1e8,
    afterCR:     toNum(r.afterCollateralRatio) / 1e8,
  };
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
  for (const [k, arr] of map) {
    const n = arr.length;
    const sum = (p: (x: ParsedRow) => number) => arr.reduce((a, b) => a + p(b), 0);
    out.push({
      t: k,
      wide0: sum(x => x.wide0) / n,  wide1: sum(x => x.wide1) / n,
      base0: sum(x => x.base0) / n,  base1: sum(x => x.base1) / n,
      limit0: sum(x => x.limit0) / n,limit1: sum(x => x.limit1) / n,
      wbtc:  sum(x => x.wbtc)  / n,  usdc:  sum(x => x.usdc)  / n,
      price: sum(x => x.price) / n,  vaultValue: sum(x => x.vaultValue) / n,
      feeUSDC: sum(x => x.feeUSDC),  // sum fees within bucket
      lpRatio: sum(x => x.lpRatio) / n,
      prevCR:  sum(x => x.prevCR) / n, afterCR: sum(x => x.afterCR) / n
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function htmlTemplate(payload: { raw: Series; day: Series; week: Series; month: Series; a0: string; a1: string }): string {
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
  </div>

  <div class="kpi">
    <div class="box mono" id="points"></div>
    <div class="box mono" id="range"></div>
    <div class="box mono" id="apy"></div>
  </div>

  <div class="row">
    <div class="card"><h2>Vault vs Hold (0.01 ${payload.a0})</h2><div id="perf"></div></div>
    <div class="card"><h2>Position Ranges (wide/base/limit)</h2><div id="ranges"></div></div>
    <div class="card"><h2>${payload.a0} vs ${payload.a1} Share</h2><div id="shares"></div></div>
    <div class="card"><h2>Collateral Ratio (target 200%)</h2><div id="cr"></div></div>
    <div class="card"><h2>Accumulated Swap Fees</h2><div id="fees"></div></div>
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
    { ...common, name:'Hold % (0.01 ${payload.a0})', x, y: holdPct, line:{color:'var(--pink)'} }
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

function sharesSeries(data){
  const x = xDates(data);
  // lpRatio is normalized to 1 == 50:50 (more USDC when >1)
  const r = data.map(d => Math.max(0, d.lpRatio || 0));

  // Convert ratio to % shares
  const usdcShare = r.map(v => 100 * (v / (1 + v)));   // e.g. r=2 => 66.67%
  const wbtcShare = usdcShare.map(s => 100 - s);        // complement

  return [
    { type:'scatter', mode:'lines', name:'WBTC share (LP)', x, y:wbtcShare, stackgroup:'one',
      line:{color:'var(--blue)'},
      hovertemplate:'%{x|%Y-%m-%d %H:%M}<br>WBTC: %{y:.2f}%<extra></extra>' },
    { type:'scatter', mode:'lines', name:'USDC share (LP)', x, y:usdcShare, stackgroup:'one',
      line:{color:'var(--pink)'},
      hovertemplate:'%{x|%Y-%m-%d %H:%M}<br>USDC: %{y:.2f}%<extra></extra>' }
  ];
}

function sharesLayout(data){
  const L = layout('${payload.a0} vs ${payload.a1} share', '% of portfolio');
  return L;
}

function crSeries(data){
  const x = xDates(data);
  // afterCR is a ratio (e.g., 2.0 == 200%); convert to %
  const crPct = data.map(d => (d.afterCR ?? 0) * 100);
  return [
    { ...hoverLines, name:'Collateral Ratio', x, y: crPct, line:{color:'var(--blue)'} }
  ];
}

function crLayout(data){
  const center = 200;
  const vals = data.map(d => (d.afterCR ?? 0) * 100).filter(Number.isFinite);
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
  for (const d of data){ acc += d.feeUSDC || 0; cumFees.push(acc); }
  const pct = data.map((d,i) => d.vaultValue ? (cumFees[i] / d.vaultValue) : 0);

  return [
    { ...hoverLines, name:'Cumulative fees (USDC)', x, y:cumFees, line:{color:'var(--blue)'} },
    { ...hoverLines, name:'Fees as % of position', x, y:pct, yaxis:'y2', line:{color:'var(--pink)'},
      hovertemplate:'%{x|%Y-%m-%d %H:%M}<br>%{y:.2f}%<extra></extra>' }
  ];
}

function rangeWidthSeries(data){
  const x = xDates(data);
  const wideWidth = data.map(d => d.wide1 - d.wide0);
  const baseWidth = data.map(d => d.base1 - d.base0);
  const limitWidth = data.map(d => d.limit1 - d.limit0);

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
  const usdcValue = data.map(d => {
    const ratio = d.lpRatio || 1;
    // lpRatio > 1 means more USDC weight
    return d.vaultValue * (ratio / (1 + ratio));
  });
  const wbtcValue = data.map((d,i) => totalValue[i] - usdcValue[i]);

  return [
    { type:'scatter', mode:'lines', name:'WBTC value (USDC)', x, y:wbtcValue, stackgroup:'one',
      line:{color:'var(--blue)'},
      hovertemplate:'%{x|%Y-%m-%d %H:%M}<br>WBTC: $%{y:,.0f}<extra></extra>' },
    { type:'scatter', mode:'lines', name:'USDC value', x, y:usdcValue, stackgroup:'one',
      line:{color:'var(--pink)'},
      hovertemplate:'%{x|%Y-%m-%d %H:%M}<br>USDC: $%{y:,.0f}<extra></extra>' },
    { ...hoverLines, name:'Total portfolio value', x, y:totalValue, line:{color:'#000', width:2},
      hovertemplate:'%{x|%Y-%m-%d %H:%M}<br>Total: $%{y:,.0f}<extra></extra>' }
  ];
}

function crChangeSeries(data){
  const x = xDates(data);
  const crChange = data.map(d => ((d.afterCR ?? 0) - (d.prevCR ?? 0)) * 100); // Change in CR percentage points
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
  Plotly.react('ranges', rangesSeries(data),        layout('Position price ranges', 'Price (USDC)'));
  Plotly.react('shares', sharesSeries(data),        layout('${payload.a0} vs ${payload.a1} share', '% of portfolio'));
  Plotly.react('cr',     crSeries(data),            crLayout(data));
  Plotly.react('fees',   feesSeries(data),          layout('Accumulated swap fees paid on DLV rebalances', 'USDC', '% of position'));
  Plotly.react('portfolio', portfolioValueSeries(data), layout('Portfolio value breakdown', 'Value (USDC)'));
  Plotly.react('crchange', crChangeSeries(data),    layout('Collateral ratio change per rebalance', 'Change (percentage points)'));
  Plotly.react('widths', rangeWidthSeries(data),    layout('Position range widths (could be dynamically changed)', 'Price width (USDC)'));

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
      .filter(r => r.t <= CONFIG.endDateUtc)
      .sort((a,b)=>a.t-b.t);

    const payload = {
      raw: parsedAll,
      day: aggregate(parsedAll, "day"),
      week: aggregate(parsedAll, "week"),
      month: aggregate(parsedAll, "month"),
      a0: CONFIG.asset0Symbol,
      a1: CONFIG.asset1Symbol
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
  const url = `file://${abs}`;
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
