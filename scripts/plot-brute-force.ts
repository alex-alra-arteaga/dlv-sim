import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

const RESULTS_PATH = path.join(process.cwd(), "brute-force-results.jsonl");
const OUTPUT_HTML = path.join(process.cwd(), "brute-force-report.html");

if (!fs.existsSync(RESULTS_PATH)) {
  console.error(`Could not find ${RESULTS_PATH}. Run the brute-force sweep first.`);
  process.exit(1);
}

const raw = fs.readFileSync(RESULTS_PATH, "utf8").trim();
if (!raw) {
  console.error(`No rows found in ${RESULTS_PATH}.`);
  process.exit(1);
}

interface BruteForceRow {
  key: string;
  diff: number;
  vault: number;
  hold: number;
  wideRangeWeight: number;
  wideThreshold: number;
  baseThreshold: number;
  limitThreshold: number;
  period: number;
  deviationThresholdAbove: number | null;
  deviationThresholdBelow: number | null;
  dlvPeriod: number | null;
  debtToVolatileSwapFee: number | null;
}

type RawRow = Record<string, unknown>;

const rows: RawRow[] = raw.split("\n").map((line) => JSON.parse(line) as RawRow);
const successful = rows.filter((row) => Boolean((row as any).ok) && (row as any).apy);

const dataset: BruteForceRow[] = successful.map((rowAny) => {
  const row = rowAny as Record<string, any>;
  const charm = (row.charm ?? {}) as Record<string, any>;
  const dlv = (row.dlv ?? {}) as Record<string, any>;
  const apy = (row.apy ?? {}) as Record<string, any>;
  return {
    key: String(row.key ?? ""),
    diff: Number(apy.diff ?? 0),
    vault: Number(apy.vault ?? 0),
    hold: Number(apy.hold ?? 0),
    wideRangeWeight: Number(charm.wideRangeWeight ?? 0),
    wideThreshold: Number(charm.wideThreshold ?? 0),
    baseThreshold: Number(charm.baseThreshold ?? 0),
    limitThreshold: Number(charm.limitThreshold ?? 0),
    period: Number(charm.period ?? 0),
    deviationThresholdAbove: dlv.deviationThresholdAbove != null ? Number(dlv.deviationThresholdAbove) : null,
    deviationThresholdBelow: dlv.deviationThresholdBelow != null ? Number(dlv.deviationThresholdBelow) : null,
    dlvPeriod: dlv.period != null ? Number(dlv.period) : null,
    debtToVolatileSwapFee: dlv.debtToVolatileSwapFee != null ? Number(dlv.debtToVolatileSwapFee) : null,
  };
});

const firstRow = rows[0] as Record<string, any> | undefined;
const summary = {
  total: rows.length,
  ok: successful.length,
  level: firstRow?.level ?? null,
  tickSpacing: firstRow?.tickSpacing ?? null,
  poolFeeBps: firstRow?.poolFeeBps ?? null,
};

const scriptTemplatePath = path.join(process.cwd(), "scripts/templates/brute-force-dashboard.js");
const scriptTemplate = fs.readFileSync(scriptTemplatePath, "utf8");
const scriptContent = scriptTemplate
  .replace("__DATASET__", JSON.stringify(dataset))
  .replace("__SUMMARY__", JSON.stringify(summary));

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Brute-Force Analytics</title>
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <style>
      :root {
        color-scheme: light dark;
        font-family: "Inter", "Segoe UI", sans-serif;
        --bg: #f7f8fa;
        --panel: #fff;
        --panel-border: #dfe3eb;
        --text: #1b1f29;
        --muted: #616b86;
        --accent: #2563eb;
      }
      body {
        margin: 0;
        padding: 24px;
        background: var(--bg);
        color: var(--text);
      }
      h1, h2, h3 {
        margin: 0 0 12px 0;
        font-weight: 600;
      }
      h1 { font-size: 28px; }
      h2 { font-size: 20px; }
      h3 { font-size: 16px; }
      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-bottom: 24px;
        color: var(--muted);
      }
      .meta span {
        background: var(--panel);
        border: 1px solid var(--panel-border);
        padding: 6px 12px;
        border-radius: 6px;
      }
      section {
        background: var(--panel);
        box-shadow: 0 10px 35px rgba(15, 23, 42, 0.08);
        border-radius: 16px;
        margin-bottom: 32px;
        padding: 24px;
        border: 1px solid var(--panel-border);
      }
      .grid-two {
        display: grid;
        gap: 24px;
        grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
      }
      .controls {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-bottom: 16px;
      }
      select {
        padding: 6px 10px;
        border-radius: 6px;
        border: 1px solid var(--panel-border);
        background: var(--panel);
        color: inherit;
      }
      .chart-container {
        position: relative;
        min-height: 360px;
      }
      .note {
        color: var(--muted);
        font-size: 13px;
        margin-top: 8px;
      }
      .flex {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--panel-border);
        border-radius: 12px;
        padding: 16px;
        min-width: 180px;
      }
      .card span {
        display: block;
        color: var(--muted);
        font-size: 12px;
      }
      .card strong {
        font-size: 20px;
      }
      .table-scroll {
        overflow-x: auto;
        margin-top: 20px;
      }
      table {
        border-collapse: collapse;
        width: 100%;
      }
      th, td {
        padding: 6px 10px;
        border-bottom: 1px solid #e5e7eb;
        text-align: left;
        white-space: nowrap;
      }
      tr:hover {
        background: rgba(37, 99, 235, 0.08);
      }
      .empty {
        text-align: center;
        color: var(--muted);
        padding: 120px 0;
      }
      #heatmaps { min-height: 420px; }
      #pdpSurface, #iceSurface, #embedding, #parallel { min-height: 420px; }
      #importanceChart, #interactionChart { min-height: 360px; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
  </head>
  <body>
    <header>
      <h1>Brute-Force Analytics</h1>
      <div class="meta">
        <span>Total combos: <b>${summary.total}</b></span>
        <span>Successful: <b>${summary.ok}</b></span>
        <span>Level: <b>${summary.level ?? "n/a"}</b></span>
        <span>Tick spacing: <b>${summary.tickSpacing ?? "n/a"}</b></span>
        <span>Pool fee: <b>${summary.poolFeeBps ?? "n/a"} bps</b></span>
      </div>
    </header>

    <section>
      <h2>Leaderboard</h2>
      <div id="leaderboard" class="chart-container"></div>
      <div class="table-scroll" id="leaderboardTable"></div>
    </section>

    <section>
      <h2>Small-Multiple Heatmaps</h2>
      <div class="controls">
        <label>Facet rows:
          <select id="heatRowFacet">
            <option value="none">(none)</option>
            <option value="period">Charm period (hours)</option>
            <option value="baseThreshold">Base threshold</option>
          </select>
        </label>
        <label>Facet columns:
          <select id="heatColFacet">
            <option value="none">(none)</option>
            <option value="period">Charm period (hours)</option>
            <option value="baseThreshold">Base threshold</option>
          </select>
        </label>
        <label>Limit thresholds:
          <select id="heatLimitFilter"></select>
        </label>
      </div>
      <div id="heatmaps" class="chart-container"></div>
      <p class="note">Heatmaps show \u0394APY (vault − hold) across deviation thresholds (above × below) faceted by wide-range weight. Use the facet selectors to slice across additional parameters.</p>
    </section>

    <section>
      <h2>Parallel Coordinates</h2>
      <div id="parallel" class="chart-container"></div>
      <p class="note">Brush over axes to highlight high-diff configurations. Hover to see exact parameter sets.</p>
    </section>

    <section>
      <h2>Global Model Insights</h2>
      <div class="controls">
        <label>Pair:
          <select id="pdpPair"></select>
        </label>
      </div>
      <div class="grid-two">
        <div>
          <h3>Partial Dependence</h3>
          <div id="pdpSurface" class="chart-container"></div>
        </div>
        <div>
          <h3>ICE (Individual Conditional Expectation)</h3>
          <div id="iceSurface" class="chart-container"></div>
        </div>
      </div>
      <div class="grid-two">
        <div>
          <h3>Feature Importance</h3>
          <div id="importanceChart" class="chart-container"></div>
        </div>
        <div>
          <h3>Pairwise Interaction Strength</h3>
          <div id="interactionChart" class="chart-container"></div>
        </div>
      </div>
      <p class="note">Random-forest regressor fit on \u0394APY. Permutation importance measures marginal impact per feature. Interaction chart shows joint importance drops when shuffling feature pairs.</p>
    </section>

    <section>
      <h2>Rule Surfaces & Embeddings</h2>
      <div class="grid-two">
        <div>
          <h3>UMAP Overview</h3>
          <div id="embedding" class="chart-container"></div>
          <p class="note">2-D manifold embedding of the full parameter grid. Color encodes \u0394APY.</p>
        </div>
        <div>
          <h3>Contour Explorer</h3>
          <div class="controls">
            <label>X axis:
              <select id="contourX"></select>
            </label>
            <label>Y axis:
              <select id="contourY"></select>
            </label>
          </div>
          <div id="contourChart" class="chart-container"></div>
          <p class="note">Iso-diff contours from the learned regressor, with other variables fixed to their median.</p>
        </div>
      </div>
    </section>

    <script type="module">
${scriptContent}
    </script>
  </body>
</html>`;

fs.writeFileSync(OUTPUT_HTML, html, "utf8");
console.log(`Wrote ${OUTPUT_HTML}`);

openInBrowser(OUTPUT_HTML);

function openInBrowser(filePath: string) {
  const abs = path.resolve(filePath);
  let command: string;
  let args: string[];
  if (process.platform === "darwin") {
    command = "open";
    args = [abs];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", abs];
  } else {
    command = "xdg-open";
    args = [abs];
  }
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.unref();
  } catch (err) {
    const message = err && typeof err === "object" && "message" in err ? err.message : String(err);
    console.warn(`Unable to open browser automatically (${message}).`);
  }
}
