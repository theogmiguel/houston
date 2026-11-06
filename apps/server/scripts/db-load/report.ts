import type { Comparison, Delta } from "./compare.ts";
import type { QueryResult, RunResults } from "./run.ts";
import { project } from "./stats.ts";

const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ms = (value: number | undefined) =>
  value === undefined || !Number.isFinite(value)
    ? "–"
    : value >= 100
      ? value.toFixed(0)
      : value >= 10
        ? value.toFixed(1)
        : value.toFixed(2);

const STYLE = `
.viz-root { color-scheme: light; --surface-1:#fcfcfb; --surface-2:#f3f2ee; --text-primary:#0b0b0b; --text-secondary:#52514e; --grid:#e1e0d9;
  --series-1:#2a78d6; --series-2:#eb6834; --critical:#d03b3b; --good:#0ca30c; }
@media (prefers-color-scheme: dark) { .viz-root { color-scheme: dark; --surface-1:#1a1a19; --surface-2:#242422; --text-primary:#f0efec;
  --text-secondary:#c3c2b7; --grid:#2c2c2a; --series-1:#3987e5; --series-2:#d95926; } }
body { margin:0; }
.viz-root { background:var(--surface-1); color:var(--text-primary); font:14px/1.45 system-ui, sans-serif; padding:24px 32px; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:17px; margin:32px 0 8px; }
.meta { color:var(--text-secondary); margin:0 0 16px; }
table { border-collapse:collapse; font-variant-numeric:tabular-nums; }
th, td { padding:4px 10px; border-bottom:1px solid var(--grid); text-align:right; vertical-align:top; }
th { color:var(--text-secondary); font-weight:600; } td.l, th.l { text-align:left; }
.fail { color:var(--critical); font-weight:600; } .ok { color:var(--text-secondary); }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(300px, 1fr)); gap:16px; }
.card { background:var(--surface-2); border-radius:8px; padding:10px 12px; }
.card h3 { font-size:13px; margin:0; } .card .sub { color:var(--text-secondary); font-size:12px; margin:0 0 4px; }
.legend { display:flex; gap:16px; color:var(--text-secondary); font-size:12px; margin:8px 0; }
.swatch { display:inline-block; width:14px; height:3px; border-radius:2px; vertical-align:middle; margin-right:6px; }
svg text { fill:var(--text-secondary); font-size:10px; }
details { margin:4px 0; } summary { cursor:pointer; }
pre { background:var(--surface-2); padding:8px; border-radius:6px; overflow-x:auto; font-size:12px; white-space:pre-wrap; }
`;

interface Series {
  readonly label: string;
  readonly color: string;
  readonly points: ReadonlyArray<{
    readonly scale: number;
    readonly p50: number;
    readonly p95: number;
    readonly failing: boolean;
    readonly projected?: boolean;
  }>;
}

function seriesOf(query: QueryResult, label: string, color: string): Series {
  const points: Array<Series["points"][number]> = query.scales
    .filter((s) => s.summary !== null)
    .map((s) => ({
      scale: s.scale,
      p50: s.summary!.p50,
      p95: s.summary!.p95,
      failing: query.failing.some((f) => f.scale === s.scale),
    }));
  const largest = query.scales.at(-1);
  if (
    query.projectedP95At1000 !== undefined &&
    query.fitP50 !== undefined &&
    largest !== undefined &&
    largest.scale < 1000
  ) {
    const size = largest.size * (1000 / largest.scale);
    points.push({
      scale: 1000,
      p50: project(query.fitP50, size),
      p95: query.projectedP95At1000,
      failing: query.projectedP95At1000 > query.budgetMs,
      projected: true,
    });
  }
  return { label, color, points };
}

function chart(query: QueryResult, series: ReadonlyArray<Series>): string {
  const width = 280;
  const height = 170;
  const left = 40;
  const right = 10;
  const top = 10;
  const bottom = 24;
  const all = series.flatMap((s) => s.points);
  const scalesShown = [...new Set([1, 10, 100, 1000, ...all.map((p) => p.scale)])].sort(
    (a, b) => a - b,
  );
  const values = [...all.flatMap((p) => [p.p50, p.p95]), query.budgetMs].filter((v) => v > 0);
  const minY = 10 ** Math.floor(Math.log10(Math.min(...values)));
  const maxY = 10 ** Math.ceil(Math.log10(Math.max(...values)));
  const minX = Math.log10(scalesShown[0]!);
  const maxX = Math.log10(scalesShown.at(-1)!);
  const x = (scale: number) =>
    left + ((Math.log10(scale) - minX) / Math.max(maxX - minX, 1e-9)) * (width - left - right);
  const y = (value: number) =>
    top +
    (1 -
      (Math.log10(value) - Math.log10(minY)) /
        Math.max(Math.log10(maxY) - Math.log10(minY), 1e-9)) *
      (height - top - bottom);
  const parts: Array<string> = [];
  for (let decade = minY; decade <= maxY * 1.0001; decade *= 10) {
    parts.push(
      `<line x1="${left}" x2="${width - right}" y1="${y(decade)}" y2="${y(decade)}" stroke="var(--grid)" stroke-width="1"/>`,
    );
    parts.push(
      `<text x="${left - 4}" y="${y(decade) + 3}" text-anchor="end">${decade >= 1000 ? `${decade / 1000}s` : `${decade}`}</text>`,
    );
  }
  for (const scale of scalesShown)
    parts.push(`<text x="${x(scale)}" y="${height - 8}" text-anchor="middle">${scale}x</text>`);
  const budgetY = y(query.budgetMs);
  parts.push(
    `<line x1="${left}" x2="${width - right}" y1="${budgetY}" y2="${budgetY}" stroke="var(--text-secondary)" stroke-width="1" stroke-dasharray="4 3"/>`,
  );
  parts.push(
    `<text x="${width - right}" y="${budgetY - 3}" text-anchor="end">budget ${query.budgetMs} ms</text>`,
  );
  for (const s of series) {
    const measured = s.points.filter((p) => !p.projected);
    const projected = s.points.find((p) => p.projected);
    if (measured.length > 1) {
      const band = [
        ...measured.map((p) => `${x(p.scale)},${y(p.p95)}`),
        ...[...measured].reverse().map((p) => `${x(p.scale)},${y(p.p50)}`),
      ].join(" ");
      parts.push(`<polygon points="${band}" fill="${s.color}" opacity="0.15"/>`);
    }
    parts.push(
      `<polyline points="${measured.map((p) => `${x(p.scale)},${y(p.p50)}`).join(" ")}" fill="none" stroke="${s.color}" stroke-width="2"/>`,
    );
    parts.push(
      `<polyline points="${measured.map((p) => `${x(p.scale)},${y(p.p95)}`).join(" ")}" fill="none" stroke="${s.color}" stroke-width="1" stroke-dasharray="2 2"/>`,
    );
    if (projected !== undefined && measured.length > 0) {
      const last = measured.at(-1)!;
      parts.push(
        `<line x1="${x(last.scale)}" y1="${y(last.p95)}" x2="${x(1000)}" y2="${y(projected.p95)}" stroke="${s.color}" stroke-width="1" stroke-dasharray="6 4" opacity="0.7"/>`,
      );
    }
    for (const p of s.points) {
      const title = `${escape(query.name)} ${p.scale}x${p.projected ? " (projected)" : ""} · ${s.label}: p50 ${ms(p.p50)} ms, p95 ${ms(p.p95)} ms${p.failing ? " · fails" : ""}`;
      const cx = x(p.scale);
      const cy = y(p.p95);
      parts.push(
        `<g><title>${title}</title><circle cx="${cx}" cy="${cy}" r="12" fill="transparent"/>` +
          (p.failing
            ? `<circle cx="${cx}" cy="${cy}" r="5" fill="var(--critical)" stroke="var(--surface-2)" stroke-width="2"${p.projected ? ' opacity="0.6"' : ""}/>`
            : `<circle cx="${cx}" cy="${cy}" r="4" fill="${s.color}" stroke="var(--surface-2)" stroke-width="2"${p.projected ? ' opacity="0.6"' : ""}/>`) +
          `</g>`,
      );
    }
  }
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${escape(query.name)} latency by scale">${parts.join("")}</svg>`;
}

function statusCell(query: QueryResult, scale: number): string {
  const s = query.scales.find((r) => r.scale === scale);
  if (s === undefined) return "<td>–</td>";
  if (s.error !== undefined) return `<td class="fail">✕ error</td>`;
  const failing = query.failing.find((f) => f.scale === scale);
  const p95 = s.summary?.p95;
  return failing === undefined
    ? `<td class="ok">${ms(p95)}</td>`
    : `<td class="fail" title="${escape(failing.reasons.join("; "))}">✕ ${ms(p95)}${failing.reasons.some((r) => r.startsWith("full scan")) ? " ⊘" : ""}</td>`;
}

function memoryCell(query: QueryResult): string {
  const memory = [...query.scales].reverse().find((s) => s.memory !== undefined)?.memory;
  return memory === undefined ? "–" : `${memory.resultHeapMb} / ${memory.peakRssGrowthMb}`;
}

function severity(query: QueryResult): number {
  const worst = query.scales.reduce(
    (max, s) => Math.max(max, (s.summary?.p95 ?? 0) / query.budgetMs),
    0,
  );
  return (
    (query.failing.length > 0 ? 1_000 : 0) +
    Math.max(worst, (query.projectedP95At1000 ?? 0) / query.budgetMs / 100)
  );
}

function deltaRows(deltas: ReadonlyArray<Delta>): string {
  return deltas
    .map(
      (d) =>
        `<tr><td class="l">${escape(d.query)}</td><td>${d.scale}x</td><td>${ms(d.beforeP50)}</td><td>${ms(d.afterP50)}</td><td>${ms(d.beforeP95)}</td><td>${ms(d.afterP95)}</td>` +
        `<td>${d.ratio.toFixed(2)}</td><td>[${d.ratioCi[0].toFixed(2)}, ${d.ratioCi[1].toFixed(2)}]</td><td>${d.pAdjusted.toExponential(1)}</td>` +
        `<td class="l ${d.verdict === "slower" ? "fail" : ""}">${d.verdict === "faster" ? "▼ faster" : d.verdict === "slower" ? "▲ slower" : "= unchanged"}</td></tr>`,
    )
    .join("");
}

export function renderReport(
  results: RunResults,
  compare?: { readonly before: RunResults; readonly comparison: Comparison },
): string {
  const scales = results.databases.map((d) => d.scale);
  const queries = [...results.queries].sort((a, b) => severity(b) - severity(a));
  const failing = queries.filter((q) => q.failing.length > 0).length;
  const cards = queries
    .map((query) => {
      const series = [
        seriesOf(
          query,
          compare === undefined ? results.label : `after (${results.label})`,
          compare === undefined ? "var(--series-1)" : "var(--series-2)",
        ),
      ];
      const beforeQuery = compare?.before.queries.find((q) => q.name === query.name);
      if (beforeQuery !== undefined)
        series.unshift(
          seriesOf(beforeQuery, `before (${compare!.before.label})`, "var(--series-1)"),
        );
      const exponent = query.fitP50 === undefined ? "–" : query.fitP50.exponent.toFixed(2);
      return `<div class="card"><h3>${query.failing.length > 0 ? '<span class="fail">✕</span> ' : ""}${escape(query.name)}</h3>
<p class="sub">${query.path} · grows with ${query.grows === "breadth" ? "all rows" : "thread length"} · exponent ${exponent}</p>${chart(query, series)}</div>`;
    })
    .join("\n");
  const summaryRows = queries
    .map(
      (q) =>
        `<tr><td class="l">${escape(q.name)}</td><td class="l">${q.path}</td><td>${q.budgetMs}</td>${scales.map((s) => statusCell(q, s)).join("")}` +
        `<td>${q.fitP50 === undefined ? "–" : q.fitP50.exponent.toFixed(2)}</td><td class="${(q.projectedP95At1000 ?? 0) > q.budgetMs ? "fail" : "ok"}">${ms(q.projectedP95At1000)}</td>` +
        `<td>${memoryCell(q)}</td><td class="l">${escape(q.calls)}</td></tr>`,
    )
    .join("");
  const plans = queries
    .map((q) => {
      const largest = [...q.scales].reverse().find((s) => s.statements.length > 0);
      if (largest === undefined) return "";
      const body = largest.statements
        .map(
          (st) =>
            `<pre>${escape(st.sql)}\n-- executions: ${st.executions}${st.ms === undefined ? "" : ` · ${ms(st.ms)} ms in SQLite (one call)`}${st.fullScans.length > 0 ? ` · FULL SCAN: ${st.fullScans.join(", ")}` : ""}\n${escape(st.plan.join("\n"))}${st.planError === undefined ? "" : `\n-- plan error: ${escape(st.planError)}`}</pre>`,
        )
        .join("");
      const counts = q.scales
        .map((s) => `${s.scale}x: ${s.statements.reduce((t, st) => t + st.executions, 0)}`)
        .join(", ");
      return `<details><summary>${escape(q.name)} — ${largest.statements.length} statements at ${largest.scale}x (executions ${counts})</summary>${body}</details>`;
    })
    .join("\n");
  const legend =
    compare === undefined
      ? `<div class="legend"><span><span class="swatch" style="background:var(--series-1)"></span>p50 (solid), p95 (dotted), band between</span><span>dashed line: budget</span><span><span class="fail">●</span> fails at that scale (✕ in tables, ⊘ = full scan)</span><span>faded point at 1000x: projected from the fit</span></div>`
      : `<div class="legend"><span><span class="swatch" style="background:var(--series-1)"></span>before (${escape(compare.before.label)})</span><span><span class="swatch" style="background:var(--series-2)"></span>after (${escape(results.label)})</span><span>solid p50, dotted p95; dashed line: budget</span><span><span class="fail">●</span> fails</span></div>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>SQLite load test: ${escape(results.label)}</title><style>${STYLE}</style></head>
<body><div class="viz-root">
<h1>SQLite load test: ${escape(results.label)}</h1>
<p class="meta">${escape(results.gitSha.slice(0, 12))} · ${escape(results.startedAt)} · ${escape(results.machine.cpu)} (${results.machine.cpus} threads, ${results.machine.memoryGb} GB) · ${escape(results.machine.platform)} · Node ${escape(results.machine.node)} · ${failing} of ${queries.length} queries fail at some scale</p>
<h2>Databases</h2>
<table><tr><th>scale</th><th>rows</th><th>file</th><th>deep thread turns</th><th>turn items</th><th>events</th><th>threads</th></tr>
${results.databases.map((d) => `<tr><td>${d.scale}x</td><td>${d.totalRows.toLocaleString("en-US")}</td><td>${(d.fileBytes / 1e6).toFixed(0)} MB</td><td>${d.deepTurns.toLocaleString("en-US")}</td><td>${(d.rowCounts.orchestration_v2_projection_turn_items ?? 0).toLocaleString("en-US")}</td><td>${(d.rowCounts.orchestration_events ?? 0).toLocaleString("en-US")}</td><td>${(d.rowCounts.orchestration_v2_projection_threads ?? 0).toLocaleString("en-US")}</td></tr>`).join("")}
</table>
${
  compare === undefined
    ? ""
    : `<h2>Before / after (${escape(compare.before.label)} → ${escape(results.label)})</h2>
<p class="meta">Ratio = after p50 / before p50 with a bootstrap 95% CI; p = Mann-Whitney U, Holm-adjusted over all rows. A change counts when p &lt; ${compare.comparison.alpha} and the CI excludes 1.</p>
<table><tr><th class="l">query</th><th>scale</th><th>p50 before</th><th>p50 after</th><th>p95 before</th><th>p95 after</th><th>ratio</th><th>95% CI</th><th>p</th><th class="l">verdict</th></tr>${deltaRows(compare.comparison.deltas)}</table>`
}
<h2>Latency by scale (log-log, ms)</h2>
${legend}
<div class="grid">${cards}</div>
<h2>p95 by scale (ms)</h2>
<table><tr><th class="l">query</th><th class="l">path</th><th>budget</th>${scales.map((s) => `<th>${s}x</th>`).join("")}<th>exponent</th><th>1000x (proj.)</th><th>result heap / peak RSS rise (MB, largest scale)</th><th class="l">calls</th></tr>${summaryRows}</table>
<h2>Statements and query plans (largest scale)</h2>
${plans}
</div></body></html>`;
}
