// Charts. Palette validated with the dataviz validator (light surface): #0E8A74, #2F5DB3 —
// all checks pass (chroma, CVD separation, normal-vision floor, contrast).
// Single series: no legend (the title names it). Two series: legend always shown.
// Every chart offers its numbers as a table for screen readers and printing.
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export const SERIES = ['#0E8A74', '#2F5DB3'];
const GRID = '#E4EAE8';
const AXIS = { fontSize: 12, fill: '#5A6B70' };

function TooltipBox({ active, payload, label, format }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded border border-rule bg-white px-3 py-2 text-sm shadow-md">
      <p className="font-semibold">{label}</p>
      {payload.map((p) => (
        <p key={p.dataKey} className="flex items-center gap-2 text-ink">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: p.color }} aria-hidden />
          {p.name}: <strong className="tabular-nums">{format ? format(p.value) : p.value}</strong>
        </p>
      ))}
    </div>
  );
}

export function ColumnChart({ data, xKey, series, height = 220, format, xFormat, title }) {
  const multi = series.length > 1;
  return (
    <figure>
      <div style={{ height }} role="img" aria-label={title}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="22%" barGap={2}>
            <CartesianGrid vertical={false} stroke={GRID} strokeWidth={1} />
            <XAxis dataKey={xKey} tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} tickFormatter={xFormat} interval="preserveStartEnd" minTickGap={12} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={56} allowDecimals={false} tickFormatter={(v) => (format ? format(v, true) : v.toLocaleString())} />
            <Tooltip content={<TooltipBox format={format} />} cursor={{ fill: 'rgba(18,40,47,0.05)' }} labelFormatter={xFormat} />
            {multi && <Legend verticalAlign="top" align="right" height={28} iconType="square" iconSize={10} wrapperStyle={{ fontSize: 12, color: '#12282F' }} />}
            {series.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={SERIES[i]} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details className="mt-1 text-xs text-muted">
        <summary className="cursor-pointer select-none">Show data</summary>
        <table className="table-base mt-2">
          <thead><tr><th>{xKey === 'date' ? 'Date' : 'Period'}</th>{series.map((s) => <th key={s.key} className="text-right">{s.label}</th>)}</tr></thead>
          <tbody>{data.map((d) => <tr key={d[xKey]}><td>{xFormat ? xFormat(d[xKey]) : d[xKey]}</td>{series.map((s) => <td key={s.key} className="text-right tabular-nums">{format ? format(d[s.key]) : d[s.key]}</td>)}</tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}
