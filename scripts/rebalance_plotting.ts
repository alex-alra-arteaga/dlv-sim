import knex from "knex";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import customParse from "dayjs/plugin/customParseFormat.js";
import fs from "fs";
import { exec } from "child_process";
dayjs.extend(utc);
dayjs.extend(customParse);

const CONFIG = {
  sqlitePath: "./rebalance_log_usdc_wbtc_3000.db",
  tableName: "rebalanceLog",
  outFile: "rebalance_dashboard.html",

  // labels can be in any order; mapping below figures it out
  asset0Symbol: "WBTC",
  asset1Symbol: "USDC",
  asset0Decimals: 8,
  asset1Decimals: 6,

  priceScale: 1e18,   // price is 1e18-scaled in the logs
  poolValueDecimals: 8,
  feeDecimals: 6,
  lpRatioDecimals: 1e18,
  collateralDecimals: 1e8,

  minNavForBaseline: 1_000, // USD
  endDateUtc: dayjs.utc("2024-12-18").endOf("day").valueOf(),

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

type RawRow = {
  wide0: string; wide1: string;
  base0: string; base1: string;
  limit0: string; limit1: string;
  total0: string; total1: string;
  nonVolatileAssetPrice: string;
  prevTotalPoolValue: string;
  afterTotalPoolValue: string;
  lpRatio: string;
  swapFeeUSDC: string;
  prevCollateralRatio: string;
  afterCollateralRatio: string;
  date: string;
};

type ParsedRow = {
  t: number;
  wide0: number; wide1: number;
  base0: number; base1: number;
  limit0: number; limit1: number;
  usdc: number; wbtc: number;
  price: number;
  poolValue: number;
  feeUSDC: number;
  lpRatio: number;
  prevCR: number; afterCR: number;
};

function parseDateToMsUTC(s: string): number | null {
  for (const f of CONFIG.dateFormats) {
    const d = dayjs.utc(s, f, true);
    if (d.isValid()) return d.valueOf();
  }
  const d = dayjs.utc(s);
  return d.isValid() ? d.valueOf() : null;
}

async function readRows(): Promise<ParsedRow[]> {
  const db = knex({
    client: "sqlite3",
    connection: { filename: CONFIG.sqlitePath },
    useNullAsDefault: true
  });

  try {
    const cols = [
      "wide0","wide1","base0","base1","limit0","limit1",
      "total0","total1","nonVolatileAssetPrice",
      "prevTotalPoolValue","afterTotalPoolValue",
      "lpRatio","swapFeeUSDC","prevCollateralRatio","afterCollateralRatio",
      "date"
    ];

    const raw: RawRow[] = await db<RawRow>(CONFIG.tableName)
      .select(cols)
      .orderBy("date", "asc");

    const sliced = CONFIG.maxRows ? raw.slice(0, CONFIG.maxRows) : raw;

    // === option B: symbol-aware mapping (works regardless of label order) ===
    const s0 = CONFIG.asset0Symbol.toUpperCase();
    const s1 = CONFIG.asset1Symbol.toUpperCase();

    const rows: ParsedRow[] = [];
    for (const r of sliced) {
      const t = parseDateToMsUTC(r.date);
      if (t == null || t > CONFIG.endDateUtc) continue;

      const total0 = Number(r.total0);
      const total1 = Number(r.total1);

      // choose which column contains USDC/WBTC by symbol
      const usdc =
        (s0 === "USDC" ? total0 / 10 ** CONFIG.asset0Decimals :
         s1 === "USDC" ? total1 / 10 ** CONFIG.asset1Decimals : 0);

      const wbtc =
        (s0 === "WBTC" ? total0 / 10 ** CONFIG.asset0Decimals :
         s1 === "WBTC" ? total1 / 10 ** CONFIG.asset1Decimals : 0);

      rows.push({
        t,
        wide0: Number(r.wide0) / CONFIG.priceScale,
        wide1: Number(r.wide1) / CONFIG.priceScale,
        base0: Number(r.base0) / CONFIG.priceScale,
        base1: Number(r.base1) / CONFIG.priceScale,
        limit0: Number(r.limit0) / CONFIG.priceScale,
        limit1: Number(r.limit1) / CONFIG.priceScale,

        usdc, wbtc,

        price: Number(r.nonVolatileAssetPrice) / CONFIG.priceScale,
        poolValue: Number(r.afterTotalPoolValue) / 10 ** CONFIG.poolValueDecimals,
        feeUSDC: Number(r.swapFeeUSDC) / 10 ** CONFIG.feeDecimals,

        lpRatio: Number(r.lpRatio) / CONFIG.lpRatioDecimals,
        prevCR: Number(r.prevCollateralRatio) / CONFIG.collateralDecimals,
        afterCR: Number(r.afterCollateralRatio) / CONFIG.collateralDecimals
      });
    }
    return rows.sort((a, b) => a.t - b.t);
  } finally {
    await db.destroy();
  }
}

function buildHtml(rows: ParsedRow[]) {
  if (rows.length === 0) throw new Error("No rows within end date.");

  const enriched = rows.map(r => ({ ...r, nav: r.usdc + r.wbtc * r.price }));

  const startIdx = enriched.findIndex(r => r.nav >= CONFIG.minNavForBaseline);
  const start = startIdx >= 0 ? enriched[startIdx] : enriched[0];
  const nav0 = start.nav;
  const t0 = start.t;
  const price0 = start.price;

  const holdBTC = 0.01;
  const hold0 = holdBTC * price0;

  let cumFees = 0;
  const series = enriched.map(r => {
    cumFees += r.feeUSDC;
    const holdVal = holdBTC * r.price;
    const nav = r.nav;
    return {
      t: r.t,
      nav,
      vaultPct: (nav / nav0 - 1) * 100,
      holdPct: (holdVal / hold0 - 1) * 100,
      wbtcShare: nav > 0 ? ((r.wbtc * r.price) / nav) * 100 : 0,
      usdcShare: nav > 0 ? (r.usdc / nav) * 100 : 0,
      cumFees,
      feesPctOfNav: nav > 0 ? (cumFees / nav) * 100 : 0,
      wide0: r.wide0, wide1: r.wide1,
      base0: r.base0, base1: r.base1,
      limit0: r.limit0, limit1: r.limit1,
      price: r.price
    };
  });

  const days = Math.max(1e-9, (series.at(-1)!.t - t0) / 86_400_000);
  const vaultAPY = Math.pow(series.at(-1)!.nav / nav0, 365 / days) - 1;
  const holdAPY  = Math.pow((holdBTC * series.at(-1)!.price) / hold0, 365 / days) - 1;

  const payload = { meta: { days, vaultAPY, holdAPY, holdBTC }, rows: series };

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<script src="https://cdn.plot.ly/plotly-2.30.0.min.js"></script>
<style>
  body{font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px;background:#fafafa;color:#222}
  .plot{height:400px}
</style>
</head>
<body>
<div id="chart_perf" class="plot"></div>
<div id="chart_ranges" class="plot"></div>
<div id="chart_share" class="plot"></div>
<div id="chart_fees" class="plot"></div>
<script>
const DATA = ${JSON.stringify(payload)};

function bucketize(rows, grain) {
  if (grain==='raw') return rows;
  const keyed=new Map();
  for (const r of rows){
    const d=new Date(r.t);
    let k;
    if (grain==='day') k=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate());
    else if(grain==='week'){const tmp=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()));const dow=(tmp.getUTCDay()+6)%7;tmp.setUTCDate(tmp.getUTCDate()-dow);k=tmp.getTime();}
    else if(grain==='month')k=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1);
    const prev=keyed.get(k);if(!prev||r.t>=prev.t)keyed.set(k,r);
  }
  return [...keyed.values()].sort((a,b)=>a.t-b.t);
}

function render(grain='raw'){
  const rows=bucketize(DATA.rows,grain);
  const t=rows.map(r=>new Date(r.t));

  // 1) Vault vs Hold (line on raw; area on aggregated)
  Plotly.newPlot('chart_perf',[
    {x:t,y:rows.map(r=>r.vaultPct),type:'scatter',mode:'lines',name:'Vault %',...(grain==='raw'?{}:{fill:'tozeroy'})},
    {x:t,y:rows.map(r=>r.holdPct), type:'scatter',mode:'lines',name:'Hold %', ...(grain==='raw'?{}:{fill:'tozeroy'})}
  ],{xaxis:{title:'Date'},yaxis:{title:'Return %'},margin:{t:20,r:20,l:40,b:40},legend:{orientation:'h'}},{displaylogo:false,responsive:true});

  // 2) Ranges (no Update price)
  function band(name, high, low, alpha){
    return [
      {x:t,y:high,type:'scatter',mode:'lines',name:name+' high',showlegend:false,line:{width:0.6}},
      {x:t,y:low ,type:'scatter',mode:'lines',name:name,fill:'tonexty',fillcolor:'rgba(0,0,0,'+alpha+')',line:{width:0.6}}
    ];
  }
  const tr=[
    ...band('Wide',  rows.map(r=>r.wide1),  rows.map(r=>r.wide0), 0.06),
    ...band('Base',  rows.map(r=>r.base1),  rows.map(r=>r.base0), 0.12),
    ...band('Limit', rows.map(r=>r.limit1), rows.map(r=>r.limit0),0.12)
  ];
  Plotly.newPlot('chart_ranges',tr,{xaxis:{title:'Date'},yaxis:{title:'BTC price (USDC)'},
    margin:{t:20,r:20,l:40,b:40},legend:{orientation:'h'}},{displaylogo:false,responsive:true});

  // 3) WBTC vs USDC shares
  Plotly.newPlot('chart_share',[
    {x:t,y:rows.map(r=>r.wbtcShare),type:'scatter',mode:'lines',stackgroup:'g',name:'WBTC share'},
    {x:t,y:rows.map(r=>r.usdcShare),type:'scatter',mode:'lines',stackgroup:'g',name:'USDC share'}
  ],{xaxis:{title:'Date'},yaxis:{title:'Share %',range:[0,100]},margin:{t:20,r:20,l:40,b:40},legend:{orientation:'h'}},{displaylogo:false,responsive:true});

  // 4) Fees (USDC + % of NAV)
  Plotly.newPlot('chart_fees',[
    {x:t,y:rows.map(r=>r.cumFees),type:'scatter',mode:'lines',name:'Cum fees (USDC)'},
    {x:t,y:rows.map(r=>r.feesPctOfNav),type:'scatter',mode:'lines',name:'Fees % of NAV',yaxis:'y2'}
  ],{xaxis:{title:'Date'},yaxis:{title:'Fees (USDC)'},
     yaxis2:{title:'Fees / NAV %',overlaying:'y',side:'right'},
     margin:{t:20,r:50,l:40,b:40},legend:{orientation:'h'}},{displaylogo:false,responsive:true});
}
render();
</script>
</body>
</html>`;

  fs.writeFileSync(CONFIG.outFile, html, "utf8");

  // auto-open
  const f = CONFIG.outFile.replace(/"/g, '\\"');
  const cmd = process.platform === "darwin" ? `open "${f}"` :
              process.platform === "win32" ? `start "" "${f}"` :
              `xdg-open "${f}"`;
  exec(cmd, () => {});
}

(async () => {
  const rows = await readRows();
  buildHtml(rows);
})();
