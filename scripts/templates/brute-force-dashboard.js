const dataset = __DATASET__;
const summary = __SUMMARY__;
const debtAgentEnabled = __DEBT_AGENT_ENABLED__;

const NUMBER_FORMAT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const PERCENT_FORMAT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const numericFeatureMeta = [
  { key: "wideRangeWeight", label: "Wide range weight" },
  { key: "wideThreshold", label: "Wide threshold" },
  { key: "baseThreshold", label: "Base threshold" },
  { key: "limitThreshold", label: "Limit threshold" },
  { key: "period", label: "Charm period (s)" },
  { key: "deviationThresholdAbove", label: "Deviation ↑" },
  { key: "deviationThresholdBelow", label: "Deviation ↓" },
  { key: "dlvPeriod", label: "DLV period (s)" },
  { key: "debtToVolatileSwapFee", label: "Debt↔Vol swap fee" },
  { key: "activeRebalanceDeviationBps", label: "Active deviation (bps)" },
];

const registeredPlots = new Set();

(function bootstrap() {
  if (!Array.isArray(dataset) || dataset.length === 0) {
    const emptyNodes = [
      "leaderboard",
      "leaderboardTable",
      "heatmaps",
      "parallel",
      "pdpSurface",
      "iceSurface",
      "importanceChart",
      "interactionChart",
      "embedding",
      "contourChart",
    ];
    for (const id of emptyNodes) {
      const node = document.getElementById(id);
      if (node) {
        node.innerHTML = "<div class=\"empty\">No data available. Run the brute-force sweep first.</div>";
      }
    }
    return;
  }

  renderLeaderboard();
  initHeatmaps();
  renderParallelCoordinates();
  initModelInsights();
  initEmbeddings();
  injectDebtAgentBadge();
  registerResize();
})();

function injectDebtAgentBadge() {
  const meta = document.querySelector(".meta");
  if (!meta) return;

  const chip = document.createElement("span");
  chip.className = `status-chip ${debtAgentEnabled ? "on" : "off"}`;
  chip.title = "Debt neural agent status";
  chip.innerHTML = `
    <span class="icon">${debtAgentEnabled ? "🧠" : "⚙️"}</span>
    <span>${debtAgentEnabled ? "Debt neural agent enabled" : "Debt neural agent disabled"}</span>
  `;
  meta.appendChild(chip);
}

function registerResize() {
  const ids = Array.from(registeredPlots);
  if (!ids.length) return;
  window.addEventListener("resize", debounce(() => {
    for (const id of ids) {
      const node = document.getElementById(id);
      if (node) {
        Plotly.Plots.resize(node);
      }
    }
  }, 150));
}

function renderLeaderboard() {
  const leaderboardDiv = document.getElementById("leaderboard");
  const tableDiv = document.getElementById("leaderboardTable");
  if (!leaderboardDiv || !tableDiv) return;

  const sorted = dataset.slice().sort((a, b) => b.diff - a.diff);
  const top = sorted.slice(0, 25);

  const barTrace = {
    type: "bar",
    x: top.map((row) => row.diff),
    y: top.map((row) => row.key),
    orientation: "h",
    marker: {
      color: top.map((row) => (row.diff >= 0 ? "rgb(37, 99, 235)" : "rgb(220, 38, 38)")),
    },
    hovertemplate:
      "Key: %{y}<br>ΔAPY: %{x:.2f}%<br>Vault: %{customdata[0]:.2f}%<br>Hold: %{customdata[1]:.2f}%<extra></extra>",
    customdata: top.map((row) => [row.vault, row.hold]),
  };

  Plotly.newPlot(
    leaderboardDiv,
    [barTrace],
    {
      margin: { l: 120, r: 30, t: 10, b: 40 },
      xaxis: { title: "ΔAPY (vault − hold)" },
      yaxis: { automargin: true },
      height: 600,
    },
    { displaylogo: false, responsive: true }
  );
  registeredPlots.add("leaderboard");

  const tableRows = sorted.slice(0, 150);
  const headers = [
    "Key",
    "ΔAPY",
    "Vault",
    "Hold",
    "Wide weight",
    "Wide threshold",
    "Base threshold",
    "Limit threshold",
    "Period (h)",
    "Deviation ↑",
    "Deviation ↓",
    "DLV swap fee",
    "Active deviation",
  ];

  const html = ["<table>", "<thead><tr>" + headers.map((h) => `<th>${h}</th>`).join("") + "</tr></thead>"];
  html.push("<tbody>");
  for (const row of tableRows) {
    html.push(
      `<tr>
        <td>${row.key}</td>
        <td>${formatPercent(row.diff)}</td>
        <td>${formatPercent(row.vault)}</td>
        <td>${formatPercent(row.hold)}</td>
        <td>${formatNumber(row.wideRangeWeight)}</td>
        <td>${formatNumber(row.wideThreshold)}</td>
        <td>${formatNumber(row.baseThreshold)}</td>
        <td>${formatNumber(row.limitThreshold)}</td>
        <td>${formatNumber(secondsToHours(row.period))}</td>
        <td>${formatPercent(row.deviationThresholdAbove)}</td>
        <td>${formatPercent(row.deviationThresholdBelow)}</td>
        <td>${formatPercent(row.debtToVolatileSwapFee, 4)}</td>
        <td>${formatPercent(row.activeRebalanceDeviationBps != null ? row.activeRebalanceDeviationBps / 100 : null)}</td>
      </tr>`
    );
  }
  html.push("</tbody></table>");
  tableDiv.innerHTML = html.join("");
}

function initHeatmaps() {
  const heatmapsDiv = document.getElementById("heatmaps");
  if (!heatmapsDiv) return;

  const rowSelect = document.getElementById("heatRowFacet");
  const colSelect = document.getElementById("heatColFacet");
  const limitSelect = document.getElementById("heatLimitFilter");

  const limitThresholds = unique(dataset.map((row) => row.limitThreshold)).sort((a, b) => a - b);
  if (limitSelect) {
    limitSelect.innerHTML = '<option value="all">(all)</option>' +
      limitThresholds.map((value) => `<option value="${value}">${formatNumber(value)}</option>`).join("");
  }

  const render = () => {
    renderHeatmaps({
      rowFacet: rowSelect ? rowSelect.value : "none",
      colFacet: colSelect ? colSelect.value : "none",
      limitFilter: limitSelect ? limitSelect.value : "all",
    });
  };

  rowSelect?.addEventListener("change", render);
  colSelect?.addEventListener("change", render);
  limitSelect?.addEventListener("change", render);

  render();
}

function renderHeatmaps({ rowFacet, colFacet, limitFilter }) {
  const heatmapsDiv = document.getElementById("heatmaps");
  if (!heatmapsDiv) return;

  heatmapsDiv.innerHTML = "";
  heatmapsDiv.style.display = "grid";
  heatmapsDiv.style.gridTemplateColumns = "repeat(auto-fit, minmax(320px, 1fr))";
  heatmapsDiv.style.gap = "16px";

  let filtered = dataset.slice();
  if (limitFilter && limitFilter !== "all") {
    const numericLimit = Number(limitFilter);
    filtered = filtered.filter((row) => row.limitThreshold === numericLimit);
  }

  const weightValues = unique(filtered.map((row) => row.wideRangeWeight)).sort((a, b) => a - b);
  const rowKeys = rowFacet === "none" ? ["__ALL__"] : unique(filtered.map((row) => row[rowFacet])).sort(compare);
  const colKeys = colFacet === "none" ? ["__ALL__"] : unique(filtered.map((row) => row[colFacet])).sort(compare);

  if (!filtered.length) {
    heatmapsDiv.innerHTML = "<div class=\"empty\">No data after filters.</div>";
    return;
  }

  const combos = [];
  for (const rowKey of rowKeys) {
    for (const colKey of colKeys) {
      for (const weight of weightValues) {
        const group = filtered.filter((row) => {
          if (row.wideRangeWeight !== weight) return false;
          if (rowFacet !== "none" && row[rowFacet] !== rowKey) return false;
          if (colFacet !== "none" && row[colFacet] !== colKey) return false;
          return true;
        });
        if (group.length) {
          combos.push({ rowKey, colKey, weight, group });
        }
      }
    }
  }

  if (!combos.length) {
    heatmapsDiv.innerHTML = "<div class=\"empty\">No cells match the selected facets.</div>";
    return;
  }

  for (const combo of combos.slice(0, 24)) {
    const cell = document.createElement("div");
    cell.style.background = "var(--panel, #fff)";
    cell.style.border = "1px solid var(--panel-border, #e5e7eb)";
    cell.style.borderRadius = "12px";
    cell.style.padding = "12px";

    const title = document.createElement("div");
    title.style.fontWeight = "600";
    title.style.marginBottom = "8px";
    title.textContent = buildHeatmapTitle({ combo, rowFacet, colFacet });
    cell.appendChild(title);

    const plot = document.createElement("div");
    plot.style.minHeight = "280px";
    cell.appendChild(plot);
    heatmapsDiv.appendChild(cell);

    const matrix = buildHeatmapMatrix(combo.group);
    const heatTrace = {
      type: "heatmap",
      x: matrix.x,
      y: matrix.y,
      z: matrix.z,
      colorscale: "RdBu",
      reversescale: true,
      hovertemplate: "Deviation ↑: %{x}<br>Deviation ↓: %{y}<br>ΔAPY: %{z:.2f}%<extra></extra>",
    };

    Plotly.newPlot(
      plot,
      [heatTrace],
      {
        margin: { l: 40, r: 20, t: 20, b: 40 },
        xaxis: { title: "Deviation threshold ↑" },
        yaxis: { title: "Deviation threshold ↓" },
        height: 320,
      },
      { displaylogo: false, responsive: true }
    );
  }
}

function buildHeatmapTitle({ combo, rowFacet, colFacet }) {
  const parts = [`Wide weight ${formatNumber(combo.weight)}`];
  if (rowFacet !== "none") {
    parts.push(`${facetLabel(rowFacet)} ${formatFacetValue(combo.rowKey)}`);
  }
  if (colFacet !== "none") {
    parts.push(`${facetLabel(colFacet)} ${formatFacetValue(combo.colKey)}`);
  }
  return parts.join(" · ");
}

function facetLabel(key) {
  switch (key) {
    case "period":
      return "Period";
    case "baseThreshold":
      return "Base";
    case "wideThreshold":
      return "Wide";
    default:
      return key;
  }
}

function formatFacetValue(value) {
  if (value === "__ALL__") return "(all)";
  if (typeof value === "number") {
    return formatNumber(value);
  }
  return String(value);
}

function buildHeatmapMatrix(rows) {
  const xValues = unique(rows.map((row) => row.deviationThresholdAbove).filter((v) => v != null)).sort((a, b) => a - b);
  const yValues = unique(rows.map((row) => row.deviationThresholdBelow).filter((v) => v != null)).sort((a, b) => a - b);

  const matrix = yValues.map(() => xValues.map(() => null));
  const counts = yValues.map(() => xValues.map(() => 0));

  for (const row of rows) {
    const xIndex = xValues.indexOf(row.deviationThresholdAbove);
    const yIndex = yValues.indexOf(row.deviationThresholdBelow);
    if (xIndex === -1 || yIndex === -1) continue;
    matrix[yIndex][xIndex] = (matrix[yIndex][xIndex] ?? 0) + row.diff;
    counts[yIndex][xIndex] += 1;
  }

  for (let y = 0; y < yValues.length; y++) {
    for (let x = 0; x < xValues.length; x++) {
      if (!counts[y][x]) continue;
      matrix[y][x] = matrix[y][x] / counts[y][x];
    }
  }

  const xLabels = xValues.map((v) => formatPercent(v));
  const yLabels = yValues.map((v) => formatPercent(v));

  return { x: xLabels, y: yLabels, z: matrix };
}

function renderParallelCoordinates() {
  const node = document.getElementById("parallel");
  if (!node) return;

  const dims = [];
  dims.push({ label: "ΔAPY", values: dataset.map((row) => row.diff) });
  dims.push({ label: "Vault APY", values: dataset.map((row) => row.vault) });
  dims.push({ label: "Hold APY", values: dataset.map((row) => row.hold) });

  for (const feature of numericFeatureMeta) {
    const values = dataset.map((row) => sanitizeNumber(row[feature.key]));
    if (values.every((value) => value == null)) continue;
    dims.push({ label: feature.label, values: values.map((v) => (v == null ? NaN : v)) });
  }

  Plotly.newPlot(
    node,
    [
      {
        type: "parcoords",
        line: {
          color: dataset.map((row) => row.diff),
          colorscale: "RdBu",
          showscale: true,
        },
        dimensions: dims,
      },
    ],
    { margin: { l: 60, r: 60, t: 30, b: 20 }, height: 520 },
    { displaylogo: false, responsive: true }
  );
  registeredPlots.add("parallel");
}

function initModelInsights() {
  const pairSelect = document.getElementById("pdpPair");
  if (!pairSelect) return;

  const pairKeys = unique(dataset.map((row) => derivePairKey(row)));
  pairSelect.innerHTML = pairKeys.map((key) => `<option value="${key}">${key}</option>`).join("");

  const contourX = document.getElementById("contourX");
  const contourY = document.getElementById("contourY");
  if (contourX && contourY) {
    contourX.innerHTML = numericFeatureMeta
      .map((feature) => `<option value="${feature.key}">${feature.label}</option>`)
      .join("");
    contourY.innerHTML = numericFeatureMeta
      .map((feature) => `<option value="${feature.key}">${feature.label}</option>`)
      .join("");
    contourY.selectedIndex = 1;
  }

  const render = () => {
    const key = pairSelect.value;
    const subset = dataset.filter((row) => derivePairKey(row) === key);
    renderModelCharts(subset.length ? subset : dataset);
  };

  pairSelect.addEventListener("change", render);
  contourX?.addEventListener("change", render);
  contourY?.addEventListener("change", render);

  render();
}

function renderModelCharts(subset) {
  renderPDPSurface(subset);
  renderICE(subset);
  renderFeatureImportance(subset);
  renderInteractionHeatmap(subset);
  renderContour(subset);
}

function renderPDPSurface(subset) {
  const node = document.getElementById("pdpSurface");
  if (!node) return;

  const xValues = unique(subset.map((row) => row.baseThreshold)).sort((a, b) => a - b);
  const yValues = unique(subset.map((row) => row.limitThreshold)).sort((a, b) => a - b);

  if (!xValues.length || !yValues.length) {
    node.innerHTML = "<div class=\"empty\">Insufficient data for surface.</div>";
    return;
  }

  const grid = buildGrid({ subset, xKey: "baseThreshold", yKey: "limitThreshold", valueKey: "diff" });

  Plotly.newPlot(
    node,
    [
      {
        type: "surface",
        x: grid.x,
        y: grid.y,
        z: grid.z,
        colorscale: "RdBu",
        reversescale: true,
        showscale: true,
      },
    ],
    {
      margin: { l: 40, r: 20, t: 20, b: 40 },
      scene: {
        xaxis: { title: "Base threshold" },
        yaxis: { title: "Limit threshold" },
        zaxis: { title: "ΔAPY" },
      },
      height: 420,
    },
    { displaylogo: false, responsive: true }
  );
  registeredPlots.add("pdpSurface");
}

function renderICE(subset) {
  const node = document.getElementById("iceSurface");
  if (!node) return;

  const groups = groupBy(subset, (row) => row.wideRangeWeight);
  const traces = [];
  for (const [weight, rows] of groups) {
    const buckets = groupBy(rows, (row) => secondsToHours(row.period));
    const points = [];
    for (const [period, periodRows] of buckets) {
      points.push({ period: Number(period), value: average(periodRows.map((row) => row.diff)) });
    }
    points.sort((a, b) => a.period - b.period);
    if (!points.length) continue;
    traces.push({
      type: "scatter",
      mode: "lines+markers",
      name: `Weight ${formatNumber(Number(weight))}`,
      x: points.map((row) => row.period),
      y: points.map((row) => row.value),
      hovertemplate: "Period: %{x}h<br>ΔAPY: %{y:.2f}%<extra></extra>",
    });
  }

  if (!traces.length) {
    node.innerHTML = "<div class=\"empty\">Insufficient data for ICE.</div>";
    return;
  }

  Plotly.newPlot(
    node,
    traces,
    {
      margin: { l: 50, r: 20, t: 20, b: 40 },
      xaxis: { title: "Charm period (hours)" },
      yaxis: { title: "ΔAPY" },
      height: 420,
    },
    { displaylogo: false, responsive: true }
  );
  registeredPlots.add("iceSurface");
}

function renderFeatureImportance(subset) {
  const node = document.getElementById("importanceChart");
  if (!node) return;

  const diffs = subset.map((row) => row.diff);
  const importances = numericFeatureMeta
    .map((feature) => ({
      feature,
      value: Math.abs(pearson(subset.map((row) => row[feature.key]), diffs)) || 0,
    }))
    .filter((entry) => !Number.isNaN(entry.value))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  if (!importances.length) {
    node.innerHTML = "<div class=\"empty\">Insufficient variation for importance analysis.</div>";
    return;
  }

  Plotly.newPlot(
    node,
    [
      {
        type: "bar",
        x: importances.map((entry) => entry.value),
        y: importances.map((entry) => entry.feature.label),
        orientation: "h",
        marker: { color: "rgb(37, 99, 235)" },
      },
    ],
    { margin: { l: 120, r: 20, t: 20, b: 40 }, height: 360, xaxis: { title: "|Correlation|" } },
    { displaylogo: false, responsive: true }
  );
  registeredPlots.add("importanceChart");
}

function renderInteractionHeatmap(subset) {
  const node = document.getElementById("interactionChart");
  if (!node) return;

  const diffs = subset.map((row) => row.diff);
  const features = numericFeatureMeta.slice(0, 6);
  const matrix = [];
  for (const featureY of features) {
    const rowVals = [];
    for (const featureX of features) {
      if (featureX.key === featureY.key) {
        rowVals.push(Math.abs(pearson(subset.map((row) => row[featureX.key]), diffs)) || 0);
        continue;
      }
      const product = subset.map((row) => sanitizeNumber(row[featureX.key]) * sanitizeNumber(row[featureY.key]));
      rowVals.push(Math.abs(pearson(product, diffs)) || 0);
    }
    matrix.push(rowVals);
  }

  Plotly.newPlot(
    node,
    [
      {
        type: "heatmap",
        x: features.map((feature) => feature.label),
        y: features.map((feature) => feature.label),
        z: matrix,
        colorscale: "Viridis",
        hovertemplate: "%{y} × %{x}<br>|Correlation|: %{z:.3f}<extra></extra>",
      },
    ],
    { margin: { l: 100, r: 20, t: 20, b: 60 }, height: 360 },
    { displaylogo: false, responsive: true }
  );
  registeredPlots.add("interactionChart");
}

function renderContour(subset) {
  const node = document.getElementById("contourChart");
  const contourX = document.getElementById("contourX");
  const contourY = document.getElementById("contourY");
  if (!node || !contourX || !contourY) return;

  const xKey = contourX.value;
  const yKey = contourY.value;
  if (xKey === yKey) {
    node.innerHTML = "<div class=\"empty\">Pick two distinct axes.</div>";
    return;
  }

  const grid = buildGrid({ subset, xKey, yKey, valueKey: "diff" });
  if (!grid.x.length || !grid.y.length) {
    node.innerHTML = "<div class=\"empty\">Insufficient data for contour.</div>";
    return;
  }

  Plotly.newPlot(
    node,
    [
      {
        type: "contour",
        x: grid.x,
        y: grid.y,
        z: grid.z,
        contours: { coloring: "heatmap" },
        colorbar: { title: "ΔAPY" },
      },
    ],
    {
      margin: { l: 50, r: 20, t: 20, b: 50 },
      xaxis: { title: featureLabel(xKey) },
      yaxis: { title: featureLabel(yKey) },
      height: 420,
    },
    { displaylogo: false, responsive: true }
  );
  registeredPlots.add("contourChart");
}

function initEmbeddings() {
  const node = document.getElementById("embedding");
  if (!node) return;

  const vectors = dataset.map((row) => numericFeatureMeta.map((feature) => sanitizeNumber(row[feature.key]) ?? 0));
  const projection = pca2d(vectors);
  const x = projection.map((point) => point[0]);
  const y = projection.map((point) => point[1]);

  Plotly.newPlot(
    node,
    [
      {
        type: "scattergl",
        mode: "markers",
        x,
        y,
        text: dataset.map((row) => buildTooltip(row)),
        marker: {
          size: 8,
          color: dataset.map((row) => row.diff),
          colorscale: "RdBu",
          reversescale: true,
          colorbar: { title: "ΔAPY" },
        },
        hovertemplate: "%{text}<extra></extra>",
      },
    ],
    {
      margin: { l: 40, r: 20, t: 20, b: 40 },
      xaxis: { title: "Component 1" },
      yaxis: { title: "Component 2" },
      height: 420,
    },
    { displaylogo: false, responsive: true }
  );
  registeredPlots.add("embedding");
}

function buildGrid({ subset, xKey, yKey, valueKey }) {
  const xValues = unique(subset.map((row) => sanitizeNumber(row[xKey]))).filter((value) => value != null).sort((a, b) => a - b);
  const yValues = unique(subset.map((row) => sanitizeNumber(row[yKey]))).filter((value) => value != null).sort((a, b) => a - b);

  const z = yValues.map(() => xValues.map(() => null));
  const counts = yValues.map(() => xValues.map(() => 0));

  for (const row of subset) {
    const x = sanitizeNumber(row[xKey]);
    const y = sanitizeNumber(row[yKey]);
    const val = sanitizeNumber(row[valueKey]);
    if (x == null || y == null || val == null) continue;
    const xi = xValues.indexOf(x);
    const yi = yValues.indexOf(y);
    if (xi === -1 || yi === -1) continue;
    z[yi][xi] = (z[yi][xi] ?? 0) + val;
    counts[yi][xi] += 1;
  }

  for (let yi = 0; yi < yValues.length; yi++) {
    for (let xi = 0; xi < xValues.length; xi++) {
      if (!counts[yi][xi]) continue;
      z[yi][xi] = z[yi][xi] / counts[yi][xi];
    }
  }

  return { x: xValues, y: yValues, z };
}

function pca2d(data) {
  if (!data.length) return [];
  const dims = data[0].length;
  const mean = new Array(dims).fill(0);
  for (const row of data) {
    for (let i = 0; i < dims; i++) {
      mean[i] += row[i];
    }
  }
  for (let i = 0; i < dims; i++) {
    mean[i] /= data.length;
  }

  const centered = data.map((row) => row.map((value, idx) => value - mean[idx]));
  const covariance = new Array(dims).fill(null).map(() => new Array(dims).fill(0));
  for (const row of centered) {
    for (let i = 0; i < dims; i++) {
      for (let j = i; j < dims; j++) {
        covariance[i][j] += row[i] * row[j];
      }
    }
  }
  for (let i = 0; i < dims; i++) {
    for (let j = i; j < dims; j++) {
      const value = covariance[i][j] / (data.length - 1 || 1);
      covariance[i][j] = value;
      covariance[j][i] = value;
    }
  }

  const eigen1 = powerIteration(covariance, 100);
  const deflated = deflate(covariance, eigen1);
  const eigen2 = powerIteration(deflated, 100, eigen1.vector);

  const projection = centered.map((row) => [dot(row, eigen1.vector), dot(row, eigen2.vector)]);
  return projection;
}

function powerIteration(matrix, iterations = 50, orthogonalTo) {
  const size = matrix.length;
  let vector = new Array(size).fill(0).map(() => Math.random() - 0.5);
  normalize(vector);

  for (let iter = 0; iter < iterations; iter++) {
    let next = multiplyMatrixVector(matrix, vector);
    if (orthogonalTo) {
      const projection = dot(next, orthogonalTo);
      for (let i = 0; i < size; i++) {
        next[i] -= projection * orthogonalTo[i];
      }
    }
    normalize(next);
    vector = next;
  }

  const eigenvalue = dot(vector, multiplyMatrixVector(matrix, vector));
  return { vector, eigenvalue };
}

function deflate(matrix, eigen) {
  const size = matrix.length;
  const result = matrix.map((row) => row.slice());
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      result[i][j] -= eigen.eigenvalue * eigen.vector[i] * eigen.vector[j];
    }
  }
  return result;
}

function multiplyMatrixVector(matrix, vector) {
  const result = new Array(matrix.length).fill(0);
  for (let i = 0; i < matrix.length; i++) {
    let sum = 0;
    for (let j = 0; j < matrix.length; j++) {
      sum += matrix[i][j] * vector[j];
    }
    result[i] = sum;
  }
  return result;
}

function normalize(vector) {
  const norm = Math.hypot(...vector) || 1;
  for (let i = 0; i < vector.length; i++) {
    vector[i] /= norm;
  }
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

function renderContourPlaceholder(message) {
  const node = document.getElementById("contourChart");
  if (node) {
    node.innerHTML = `<div class=\"empty\">${message}</div>`;
  }
}

function derivePairKey(row) {
  const level = row.level ?? "n/a";
  const fee = row.poolFeeBps != null ? `${row.poolFeeBps}bps` : "fee?";
  const tickSpacing = row.tickSpacing != null ? `Δ${row.tickSpacing}` : "tick?";
  return `${level} · ${fee} · ${tickSpacing}`;
}

function buildTooltip(row) {
  return `Key ${row.key}<br>ΔAPY ${formatPercent(row.diff)}<br>Weight ${formatNumber(row.wideRangeWeight)}<br>Base ${formatNumber(row.baseThreshold)}<br>Limit ${formatNumber(row.limitThreshold)}`;
}

function sanitizeNumber(value) {
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function secondsToHours(value) {
  if (value == null) return null;
  return Math.round((value / 3600) * 100) / 100;
}

function formatNumber(value) {
  if (value == null || Number.isNaN(value)) return "—";
  if (Math.abs(value) >= 1000 && Number.isInteger(value)) {
    return value.toLocaleString("en-US");
  }
  return NUMBER_FORMAT.format(value);
}

function formatPercent(value, digits = 2) {
  if (value == null || Number.isNaN(value)) return "—";
  const formatter = digits === 2 ? PERCENT_FORMAT : new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${formatter.format(value)}%`;
}

function groupBy(array, selector) {
  const map = new Map();
  for (const item of array) {
    const key = selector(item);
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(item);
  }
  return map;
}

function average(values) {
  if (!values.length) return null;
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

function unique(values) {
  return Array.from(new Set(values.filter((value) => value != null)));
}

function compare(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function pearson(xs, ys) {
  const pairs = [];
  for (let i = 0; i < xs.length && i < ys.length; i++) {
    const xVal = sanitizeNumber(xs[i]);
    const yVal = sanitizeNumber(ys[i]);
    if (xVal == null || yVal == null) continue;
    pairs.push([xVal, yVal]);
  }

  if (!pairs.length) return NaN;

  const xsClean = pairs.map(([x]) => x);
  const ysClean = pairs.map(([, y]) => y);
  const meanX = average(xsClean);
  const meanY = average(ysClean);
  let numerator = 0;
  let denomX = 0;
  let denomY = 0;
  for (let i = 0; i < pairs.length; i++) {
    const dx = xsClean[i] - meanX;
    const dy = ysClean[i] - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  const denominator = Math.sqrt(denomX * denomY);
  return denominator ? numerator / denominator : 0;
}

function featureLabel(key) {
  return numericFeatureMeta.find((feature) => feature.key === key)?.label ?? key;
}

function debounce(fn, delay) {
  let handle = null;
  return function (...args) {
    if (handle) {
      clearTimeout(handle);
    }
    handle = setTimeout(() => fn.apply(this, args), delay);
  };
}
