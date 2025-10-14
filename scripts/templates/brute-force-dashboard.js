const DATASET = __DATASET__;
const SUMMARY = __SUMMARY__;

const featureAccessors = {
  wideRangeWeight: (row) => row.wideRangeWeight,
  wideThreshold: (row) => row.wideThreshold,
  baseThreshold: (row) => row.baseThreshold,
  limitThreshold: (row) => row.limitThreshold,
  period: (row) => row.period,
  deviationThresholdAbove: (row) => row.deviationThresholdAbove,
  deviationThresholdBelow: (row) => row.deviationThresholdBelow,
  dlvPeriod: (row) => row.dlvPeriod,
  debtToVolatileSwapFee: (row) => row.debtToVolatileSwapFee,
};

document.addEventListener("DOMContentLoaded", () => {
  if (!Array.isArray(DATASET) || DATASET.length === 0) {
    renderEmptyState();
    return;
  }

  renderLeaderboard(DATASET);
  renderLeaderboardTable(DATASET);
  setupHeatmapControls(DATASET);
  renderParallelCoordinates(DATASET);
  renderModelInsights(DATASET);
  renderEmbeddings(DATASET);
  renderContourControls(DATASET);
});

function renderEmptyState() {
  const targets = [
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
  for (const id of targets) {
    const el = document.getElementById(id);
    if (el) {
      el.innerHTML = '<div class="empty">No successful rows found in brute-force output.</div>';
    }
  }
}

function renderLeaderboard(dataset) {
  const sorted = [...dataset].sort((a, b) => b.diff - a.diff).slice(0, 25);
  const data = [
    {
      type: "bar",
      x: sorted.map((row) => row.diff),
      y: sorted.map((row) => row.key || ""),
      orientation: "h",
      marker: { color: sorted.map((row) => row.diff >= 0 ? "#2563eb" : "#d946ef") },
      hovertemplate:
        "<b>%{y}</b><br>ΔAPY: %{x:.2f}%<br>Vault: %{customdata[0]:.2f}%<br>Hold: %{customdata[1]:.2f}%<extra></extra>",
      customdata: sorted.map((row) => [row.vault, row.hold]),
    },
  ];
  const layout = {
    margin: { t: 10, r: 10, b: 10, l: 200 },
    height: Math.max(400, sorted.length * 20 + 80),
    xaxis: { title: "ΔAPY (vault − hold)" },
  };
  Plotly.newPlot("leaderboard", data, layout, { responsive: true });
}

function renderLeaderboardTable(dataset) {
  const container = document.getElementById("leaderboardTable");
  if (!container) return;
  const sorted = [...dataset].sort((a, b) => b.diff - a.diff).slice(0, 100);
  const headers = [
    "Key",
    "ΔAPY",
    "Vault",
    "Hold",
    "Wide Weight",
    "Wide Threshold",
    "Base Threshold",
    "Limit Threshold",
    "Charm Period",
    "Δ Above",
    "Δ Below",
    "DLV Period",
    "Debt/Vol Swap Fee",
  ];
  const rowsHtml = sorted
    .map((row) => `
      <tr>
        <td>${row.key}</td>
        <td>${formatNumber(row.diff)}</td>
        <td>${formatNumber(row.vault)}</td>
        <td>${formatNumber(row.hold)}</td>
        <td>${formatNumber(row.wideRangeWeight)}</td>
        <td>${formatNumber(row.wideThreshold)}</td>
        <td>${formatNumber(row.baseThreshold)}</td>
        <td>${formatNumber(row.limitThreshold)}</td>
        <td>${formatNumber(row.period)}</td>
        <td>${formatOptional(row.deviationThresholdAbove)}</td>
        <td>${formatOptional(row.deviationThresholdBelow)}</td>
        <td>${formatOptional(row.dlvPeriod)}</td>
        <td>${formatOptional(row.debtToVolatileSwapFee)}</td>
      </tr>
    `)
    .join("");
  container.innerHTML = `
    <table>
      <thead>
        <tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;
}

function setupHeatmapControls(dataset) {
  const limitSelect = document.getElementById("heatLimitFilter");
  const rowFacet = document.getElementById("heatRowFacet");
  const colFacet = document.getElementById("heatColFacet");
  if (!limitSelect || !rowFacet || !colFacet) return;

  const limits = unique(dataset.map((row) => row.limitThreshold).filter((v) => v != null)).sort((a, b) => a - b);
  limitSelect.innerHTML = limits.map((v) => `<option value="${v}">${v}</option>`).join("");

  const render = () => {
    const limit = Number(limitSelect.value);
    const rowKey = rowFacet.value === "none" ? null : rowFacet.value;
    const colKey = colFacet.value === "none" ? null : colFacet.value;
    renderHeatmaps(dataset, { limitThreshold: limit, rowKey, colKey });
  };

  rowFacet.addEventListener("change", render);
  colFacet.addEventListener("change", render);
  limitSelect.addEventListener("change", render);

  if (limits.length) {
    limitSelect.value = limits[0];
  }
  render();
}

function renderHeatmaps(dataset, { limitThreshold, rowKey, colKey }) {
  const container = document.getElementById("heatmaps");
  if (!container) return;

  const filtered = dataset.filter((row) => row.limitThreshold === limitThreshold);
  if (!filtered.length) {
    container.innerHTML = '<div class="empty">No rows match the selected filters.</div>';
    return;
  }

  const facets = facetData(filtered, rowKey, colKey);
  const subplots = [];
  const subplotTitles = [];
  const sharedX = filtered.some((row) => row.deviationThresholdAbove != null);
  const sharedY = filtered.some((row) => row.deviationThresholdBelow != null);

  let rowIndex = 0;
  for (const [rowFacetValue, colMap] of facets) {
    let colIndex = 0;
    for (const [colFacetValue, rows] of colMap) {
      const zMap = new Map();
      const xVals = unique(rows.map((r) => r.deviationThresholdAbove).filter((v) => v != null)).sort((a, b) => a - b);
      const yVals = unique(rows.map((r) => r.deviationThresholdBelow).filter((v) => v != null)).sort((a, b) => a - b);
      for (const row of rows) {
        const key = `${row.deviationThresholdAbove}|${row.deviationThresholdBelow}`;
        if (!zMap.has(key)) zMap.set(key, []);
        zMap.get(key).push(row.diff);
      }
      const z = yVals.map((y) =>
        xVals.map((x) => {
          const key = `${x}|${y}`;
          const values = zMap.get(key);
          if (!values || !values.length) return null;
          return average(values);
        })
      );

      subplots.push({
        type: "heatmap",
        x: xVals,
        y: yVals,
        z,
        colorbar: { title: "ΔAPY" },
        xaxis: `x${subplots.length + 1}`,
        yaxis: `y${subplots.length + 1}`,
      });
      const titleParts = [];
      if (rowKey) titleParts.push(`${rowKey}: ${rowFacetValue}`);
      if (colKey) titleParts.push(`${colKey}: ${colFacetValue}`);
      if (!titleParts.length) titleParts.push(`Wide weight: ${rows[0].wideRangeWeight}`);
      subplotTitles.push(titleParts.join(" • "));
      colIndex++;
    }
    rowIndex++;
  }

  const layout = {
    title: undefined,
    grid: {
      rows: facets.size,
      columns: subplots.length / facets.size,
      pattern: "independent",
      xgap: 0.1,
      ygap: 0.2,
    },
    annotations: subplotTitles.map((title, idx) => ({
      text: title,
      xref: `x${idx + 1} domain`,
      yref: `y${idx + 1} domain`,
      x: 0.5,
      y: 1.1,
      showarrow: false,
      font: { size: 12, color: "#1b1f29" },
    })),
  };

  Plotly.react(container, subplots, layout, { responsive: true });
}

function renderParallelCoordinates(dataset) {
  const container = document.getElementById("parallel");
  if (!container) return;

  const dimensions = [
    { label: "ΔAPY", values: dataset.map((row) => row.diff) },
    { label: "Vault", values: dataset.map((row) => row.vault) },
    { label: "Hold", values: dataset.map((row) => row.hold) },
  ];

  for (const [key, accessor] of Object.entries(featureAccessors)) {
    const values = dataset.map((row) => accessor(row));
    if (!values.some((v) => v != null)) continue;
    dimensions.push({ label: key, values: values.map((v) => v ?? -1) });
  }

  const trace = {
    type: "parcoords",
    line: {
      color: dataset.map((row) => row.diff),
      colorscale: "Electric",
      showscale: true,
      cmin: Math.min(...dataset.map((row) => row.diff)),
      cmax: Math.max(...dataset.map((row) => row.diff)),
    },
    dimensions,
  };
  Plotly.newPlot(container, [trace], { margin: { t: 10, b: 10, l: 40, r: 10 } }, { responsive: true });
}

function renderModelInsights(dataset) {
  renderPdp(dataset);
  renderIce(dataset);
  renderImportance(dataset);
  renderInteraction(dataset);
}

function renderPdp(dataset) {
  const container = document.getElementById("pdpSurface");
  const select = document.getElementById("pdpPair");
  if (!container || !select) return;

  const numericKeys = Object.keys(featureAccessors).filter((key) => dataset.some((row) => featureAccessors[key](row) != null));
  const pairs = getPairs(numericKeys);
  select.innerHTML = pairs
    .map(([a, b]) => `<option value="${a},${b}">${a} × ${b}</option>`)
    .join("");

  const render = () => {
    const [a, b] = select.value.split(",");
    renderSurface(container, dataset, a, b, false);
  };

  select.addEventListener("change", render);
  if (pairs.length) {
    select.value = pairs[0].join(",");
  }
  render();
}

function renderIce(dataset) {
  const container = document.getElementById("iceSurface");
  if (!container) return;
  const [xKey, yKey] = ["wideThreshold", "baseThreshold"];
  renderSurface(container, dataset, xKey, yKey, true);
}

function renderSurface(container, dataset, xKey, yKey, traceAll) {
  const xAccessor = featureAccessors[xKey];
  const yAccessor = featureAccessors[yKey];
  if (!xAccessor || !yAccessor) {
    container.innerHTML = `<div class="empty">Unable to render surface for ${xKey} × ${yKey}.</div>`;
    return;
  }
  const points = dataset
    .map((row) => ({
      x: xAccessor(row),
      y: yAccessor(row),
      z: row.diff,
    }))
    .filter((pt) => pt.x != null && pt.y != null);
  if (!points.length) {
    container.innerHTML = `<div class="empty">Not enough data for ${xKey} × ${yKey}.</div>`;
    return;
  }
  if (traceAll) {
    const traces = dataset.map((row, idx) => {
      const x = xAccessor(row);
      const y = yAccessor(row);
      if (x == null || y == null) return null;
      return {
        type: "scatter3d",
        mode: "lines+markers",
        x: [x, x],
        y: [y, y],
        z: [0, row.diff],
        name: row.key || `row_${idx}`,
        opacity: 0.3,
        showlegend: idx < 10,
      };
    }).filter(Boolean);
    Plotly.newPlot(container, traces, {
      margin: { t: 10, b: 10, l: 10, r: 10 },
      scene: {
        xaxis: { title: xKey },
        yaxis: { title: yKey },
        zaxis: { title: "ΔAPY" },
      },
    }, { responsive: true });
    return;
  }

  const trace = {
    type: "histogram2dcontour",
    x: points.map((p) => p.x),
    y: points.map((p) => p.y),
    z: points.map((p) => p.z),
    contours: { coloring: "heatmap" },
    colorbar: { title: "ΔAPY" },
  };
  const scatter = {
    type: "scatter",
    mode: "markers",
    x: points.map((p) => p.x),
    y: points.map((p) => p.y),
    text: points.map((_, idx) => dataset[idx].key || ""),
    marker: { color: points.map((p) => p.z), colorscale: "Viridis", size: 6 },
  };
  Plotly.newPlot(container, [trace, scatter], {
    margin: { t: 10, b: 50, l: 60, r: 20 },
    xaxis: { title: xKey },
    yaxis: { title: yKey },
  }, { responsive: true });
}

function renderImportance(dataset) {
  const container = document.getElementById("importanceChart");
  if (!container) return;

  const scores = Object.keys(featureAccessors)
    .map((key) => ({
      key,
      score: Math.abs(correlation(dataset, (row) => row.diff, featureAccessors[key])),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  if (!scores.length) {
    container.innerHTML = '<div class="empty">Not enough signal to compute feature importance.</div>';
    return;
  }

  Plotly.newPlot(
    container,
    [
      {
        type: "bar",
        x: scores.map((s) => s.score),
        y: scores.map((s) => s.key),
        orientation: "h",
        marker: { color: "#2563eb" },
      },
    ],
    { margin: { t: 10, b: 20, l: 120, r: 20 }, xaxis: { title: "|corr(ΔAPY, feature)|" } },
    { responsive: true }
  );
}

function renderInteraction(dataset) {
  const container = document.getElementById("interactionChart");
  if (!container) return;

  const keys = Object.keys(featureAccessors).filter((key) => dataset.some((row) => featureAccessors[key](row) != null));
  const pairs = getPairs(keys).map(([a, b]) => ({
    pair: `${a} × ${b}`,
    score: jointScore(dataset, featureAccessors[a], featureAccessors[b]),
  }));
  const topPairs = pairs.sort((a, b) => b.score - a.score).slice(0, 15);

  Plotly.newPlot(
    container,
    [
      {
        type: "bar",
        x: topPairs.map((p) => p.score),
        y: topPairs.map((p) => p.pair),
        orientation: "h",
        marker: { color: "#10b981" },
      },
    ],
    { margin: { t: 10, b: 20, l: 160, r: 20 }, xaxis: { title: "Interaction strength" } },
    { responsive: true }
  );
}

function renderEmbeddings(dataset) {
  const container = document.getElementById("embedding");
  if (!container) return;

  const features = Object.keys(featureAccessors);
  const normalized = dataset.map((row) =>
    features.map((key) => normalize(featureAccessors[key](row), features))
  );
  const projections = simplePca(normalized);
  const trace = {
    type: "scatter",
    mode: "markers",
    x: projections.map((p) => p[0]),
    y: projections.map((p) => p[1]),
    text: dataset.map((row) => row.key || ""),
    marker: {
      size: 8,
      color: dataset.map((row) => row.diff),
      colorscale: "Portland",
      showscale: true,
      colorbar: { title: "ΔAPY" },
    },
  };
  Plotly.newPlot(container, [trace], {
    margin: { t: 10, b: 40, l: 40, r: 20 },
    xaxis: { title: "Component 1" },
    yaxis: { title: "Component 2" },
  }, { responsive: true });
}

function renderContourControls(dataset) {
  const xSelect = document.getElementById("contourX");
  const ySelect = document.getElementById("contourY");
  if (!xSelect || !ySelect) return;

  const numericKeys = Object.keys(featureAccessors).filter((key) => dataset.some((row) => featureAccessors[key](row) != null));
  xSelect.innerHTML = numericKeys.map((key) => `<option value="${key}">${key}</option>`).join("");
  ySelect.innerHTML = numericKeys.map((key) => `<option value="${key}">${key}</option>`).join("");

  const render = () => {
    const xKey = xSelect.value;
    const yKey = ySelect.value;
    if (xKey === yKey) {
      document.getElementById("contourChart").innerHTML = '<div class="empty">Select different axes.</div>';
      return;
    }
    renderSurface(document.getElementById("contourChart"), dataset, xKey, yKey, false);
  };

  xSelect.addEventListener("change", render);
  ySelect.addEventListener("change", render);

  if (numericKeys.length >= 2) {
    xSelect.value = numericKeys[0];
    ySelect.value = numericKeys[1];
  }
  render();
}

function facetData(rows, rowKey, colKey) {
  const rowMap = new Map();
  for (const row of rows) {
    const rVal = rowKey ? row[rowKey] ?? "(missing)" : row.wideRangeWeight;
    const cVal = colKey ? row[colKey] ?? "(missing)" : row.wideRangeWeight;
    if (!rowMap.has(rVal)) rowMap.set(rVal, new Map());
    const colMap = rowMap.get(rVal);
    if (!colMap.has(cVal)) colMap.set(cVal, []);
    colMap.get(cVal).push(row);
  }
  return rowMap;
}

function average(values) {
  const valid = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!valid.length) return null;
  return valid.reduce((sum, v) => sum + v, 0) / valid.length;
}

function unique(values) {
  return Array.from(new Set(values));
}

function formatNumber(value) {
  if (value == null || Number.isNaN(value)) return "—";
  if (Math.abs(value) >= 100 || Math.abs(value) === 0) return value.toFixed(2);
  return value.toPrecision(4);
}

function formatOptional(value) {
  return value == null ? "—" : formatNumber(value);
}

function correlation(dataset, targetAccessor, featureAccessor) {
  const pairs = dataset
    .map((row) => ({ x: featureAccessor(row), y: targetAccessor(row) }))
    .filter((pair) => pair.x != null && pair.y != null);
  if (pairs.length < 2) return 0;
  const meanX = pairs.reduce((sum, p) => sum + p.x, 0) / pairs.length;
  const meanY = pairs.reduce((sum, p) => sum + p.y, 0) / pairs.length;
  let numerator = 0;
  let denomX = 0;
  let denomY = 0;
  for (const { x, y } of pairs) {
    const dx = x - meanX;
    const dy = y - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  if (denomX === 0 || denomY === 0) return 0;
  return numerator / Math.sqrt(denomX * denomY);
}

function jointScore(dataset, accessorA, accessorB) {
  const triples = dataset
    .map((row) => ({
      ax: accessorA(row),
      bx: accessorB(row),
      diff: row.diff,
    }))
    .filter((triple) => triple.ax != null && triple.bx != null);
  if (triples.length < 3) return 0;
  const meanDiff = triples.reduce((sum, t) => sum + t.diff, 0) / triples.length;
  const meanAx = triples.reduce((sum, t) => sum + t.ax, 0) / triples.length;
  const meanBx = triples.reduce((sum, t) => sum + t.bx, 0) / triples.length;
  let cov = 0;
  let varAx = 0;
  let varBx = 0;
  for (const { ax, bx, diff } of triples) {
    const dax = ax - meanAx;
    const dbx = bx - meanBx;
    const dd = diff - meanDiff;
    cov += dax * dbx * dd;
    varAx += dax * dax;
    varBx += dbx * dbx;
  }
  if (varAx === 0 || varBx === 0) return 0;
  return Math.abs(cov) / Math.sqrt(varAx * varBx);
}

function getPairs(keys) {
  const pairs = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      pairs.push([keys[i], keys[j]]);
    }
  }
  return pairs;
}

function normalize(value) {
  if (value == null || Number.isNaN(value)) return 0;
  return value;
}

function simplePca(data) {
  if (!data.length) return [[0, 0]];
  const dimension = data[0].length;
  const means = new Array(dimension).fill(0);
  for (const row of data) {
    for (let i = 0; i < dimension; i++) {
      means[i] += row[i];
    }
  }
  for (let i = 0; i < dimension; i++) {
    means[i] /= data.length;
  }
  const centered = data.map((row) => row.map((value, idx) => value - means[idx]));
  const cov = Array.from({ length: dimension }, () => new Array(dimension).fill(0));
  for (const row of centered) {
    for (let i = 0; i < dimension; i++) {
      for (let j = i; j < dimension; j++) {
        cov[i][j] += row[i] * row[j];
      }
    }
  }
  for (let i = 0; i < dimension; i++) {
    for (let j = i; j < dimension; j++) {
      cov[i][j] /= centered.length || 1;
      cov[j][i] = cov[i][j];
    }
  }

  const { eigenvectors } = powerIteration(cov, 2);
  return centered.map((row) => eigenvectors.map((vec) => dot(row, vec)));
}

function powerIteration(matrix, k) {
  const n = matrix.length;
  let vectors = [];
  for (let i = 0; i < k; i++) {
    let v = Array.from({ length: n }, () => Math.random() * 2 - 1);
    v = normalizeVector(v);
    for (let iter = 0; iter < 50; iter++) {
      v = mulMatVec(matrix, v);
      for (const prev of vectors) {
        v = subtract(v, scale(prev, dot(v, prev)));
      }
      v = normalizeVector(v);
    }
    vectors.push(v);
  }
  return { eigenvectors: vectors };
}

function mulMatVec(matrix, vector) {
  return matrix.map((row) => dot(row, vector));
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] || 0) * (b[i] || 0);
  return sum;
}

function normalizeVector(vector) {
  const norm = Math.sqrt(dot(vector, vector)) || 1;
  return vector.map((value) => value / norm);
}

function subtract(a, b) {
  return a.map((value, idx) => value - (b[idx] || 0));
}

function scale(vector, scalar) {
  return vector.map((value) => value * scalar);
}