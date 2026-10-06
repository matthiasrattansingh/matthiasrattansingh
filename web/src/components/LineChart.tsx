// Single-series SVG line chart: 2px line, hairline grid, end dot with surface ring and direct
// end label, solid labeled reference lines, crosshair + tooltip on hover/keyboard, and a table
// twin. Provisional (stale-input) points are drawn hollow and kept off the line.
import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtLocal, fmtLocalTime } from '../format.ts';

export interface ChartPoint {
  t: number;
  v: number | null;
  valid: boolean;
}

export interface RefLine {
  value: number;
  label: string;
  tone: 'critical' | 'muted';
}

function niceTicks(min: number, max: number, count = 4): number[] {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 1e-6; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

export function LineChart({
  points,
  refLines = [],
  format,
  zone,
  height = 220,
  label,
}: {
  points: ChartPoint[];
  refLines?: RefLine[];
  format: (v: number) => string;
  zone: string;
  height?: number;
  label: string;
}) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const [wrapEl, setWrapEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  // Callback ref: the chart div only exists once there is data, so observe it when it mounts.
  useEffect(() => {
    if (!wrapEl) return;
    wrap.current = wrapEl;
    const ro = new ResizeObserver((e) => setWidth(Math.max(280, e[0].contentRect.width)));
    ro.observe(wrapEl);
    return () => ro.disconnect();
  }, [wrapEl]);

  const data = useMemo(() => points.filter((p) => p.v !== null).sort((a, b) => a.t - b.t), [points]);
  const pad = { l: 64, r: 92, t: 14, b: 28 };
  const iw = Math.max(10, width - pad.l - pad.r);
  const ih = height - pad.t - pad.b;

  const geom = useMemo(() => {
    if (!data.length) return null;
    const vals = [...data.map((p) => p.v as number), ...refLines.map((r) => r.value)];
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const span = hi - lo || Math.max(Math.abs(hi) * 0.02, 1);
    lo -= span * 0.1;
    hi += span * 0.1;
    let t0 = data[0].t;
    let t1 = data[data.length - 1].t;
    if (t1 === t0) {
      t0 -= 3600_000;
      t1 += 3600_000;
    }
    const x = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * iw;
    const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * ih;
    const yTicks = niceTicks(lo, hi, 4).filter((v) => v >= lo && v <= hi);
    const xTicks = [0, 0.5, 1].map((f) => t0 + f * (t1 - t0));
    const spanMs = t1 - t0;
    const valid = data.filter((p) => p.valid);
    const path = valid.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v as number).toFixed(1)}`).join('');
    return { x, y, yTicks, xTicks, path, valid, lo, hi, spanMs };
  }, [data, refLines, iw, ih, pad.l, pad.t]);

  if (!geom) return <p className="empty">No marks recorded yet — the chart fills in as valid quotes are marked.</p>;

  const onMove = (clientX: number) => {
    const rect = wrap.current!.getBoundingClientRect();
    const px = clientX - rect.left;
    let best = 0;
    let bestD = Infinity;
    data.forEach((p, i) => {
      const d = Math.abs(geom.x(p.t) - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setHover(best);
  };
  const last = geom.valid[geom.valid.length - 1];
  const hp = hover !== null ? data[hover] : null;

  return (
    <div>
      <div className="chart" ref={setWrapEl}>
        <svg
          height={height}
          role="img"
          aria-label={label}
          tabIndex={0}
          onPointerMove={(e) => onMove(e.clientX)}
          onPointerLeave={() => setHover(null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') setHover((h) => Math.min(data.length - 1, (h ?? -1) + 1));
            if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? data.length) - 1));
            if (e.key === 'Escape') setHover(null);
          }}
          onBlur={() => setHover(null)}
        >
          {geom.yTicks.map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={pad.l + iw} y1={geom.y(v)} y2={geom.y(v)} stroke="var(--grid)" strokeWidth={1} />
              <text x={pad.l - 8} y={geom.y(v)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {format(v)}
              </text>
            </g>
          ))}
          <line x1={pad.l} x2={pad.l + iw} y1={pad.t + ih} y2={pad.t + ih} stroke="var(--axis)" strokeWidth={1} />
          {geom.xTicks.map((t, i) => (
            <text key={i} x={geom.x(t)} y={height - 8} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'} fontSize={11} fill="var(--muted)">
              {geom.spanMs < 36 * 3600_000 ? fmtLocalTime(t, zone, geom.spanMs < 20 * 60_000) : fmtLocal(t, zone)}
            </text>
          ))}
          {refLines.map((r) => (
            <g key={r.label}>
              <line x1={pad.l} x2={pad.l + iw} y1={geom.y(r.value)} y2={geom.y(r.value)} stroke={r.tone === 'critical' ? 'var(--critical)' : 'var(--axis)'} strokeWidth={1} />
              <text x={pad.l + iw + 6} y={geom.y(r.value)} dy="0.32em" fontSize={11} fill="var(--ink-2)">
                {r.label}
              </text>
            </g>
          ))}
          <path d={geom.path} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {data
            .filter((p) => !p.valid)
            .map((p) => (
              <circle key={`p${p.t}`} cx={geom.x(p.t)} cy={geom.y(p.v as number)} r={4} fill="var(--surface)" stroke="var(--muted)" strokeWidth={1.5} />
            ))}
          {last ? (
            <g>
              <circle cx={geom.x(last.t)} cy={geom.y(last.v as number)} r={6} fill="var(--surface)" />
              <circle cx={geom.x(last.t)} cy={geom.y(last.v as number)} r={4} fill="var(--series-1)" />
              {refLines.every((r) => Math.abs(geom.y(r.value) - geom.y(last.v as number)) > 12) ? (
                <text x={pad.l + iw + 6} y={geom.y(last.v as number)} dy="0.32em" fontSize={12} fontWeight={600} fill="var(--ink)">
                  {format(last.v as number)}
                </text>
              ) : null}
            </g>
          ) : null}
          {hp ? (
            <g pointerEvents="none">
              <line x1={geom.x(hp.t)} x2={geom.x(hp.t)} y1={pad.t} y2={pad.t + ih} stroke="var(--axis)" strokeWidth={1} />
              <circle cx={geom.x(hp.t)} cy={geom.y(hp.v as number)} r={6} fill="var(--surface)" />
              <circle cx={geom.x(hp.t)} cy={geom.y(hp.v as number)} r={4} fill={hp.valid ? 'var(--series-1)' : 'var(--muted)'} />
            </g>
          ) : null}
          <rect x={pad.l} y={pad.t} width={iw} height={ih} fill="transparent" />
        </svg>
        {hp ? (
          <div className="tooltip" style={{ left: Math.min(Math.max(geom.x(hp.t), 90), width - 90), top: geom.y(hp.v as number) - 10 }}>
            <strong>{format(hp.v as number)}</strong>
            <span className="muted">
              {fmtLocal(hp.t, zone)}
              {hp.valid ? '' : ' · provisional'}
            </span>
          </div>
        ) : null}
      </div>
      <div className="chart-caption">
        Filled line: marks where every input was valid. Hollow points: provisional (a stale or missing input). ·{' '}
        <button className="btn small" onClick={() => setShowTable((s) => !s)} aria-expanded={showTable}>
          {showTable ? 'Hide table' : 'Show table'}
        </button>
      </div>
      {showTable ? (
        <div className="table-wrap" style={{ maxHeight: 240, overflowY: 'auto', marginTop: 8 }}>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th className="num">Value</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {[...data].reverse().map((p) => (
                <tr key={p.t}>
                  <td className="small">{fmtLocal(p.t, zone, true)}</td>
                  <td className="num">{format(p.v as number)}</td>
                  <td className="small">{p.valid ? 'valid' : 'provisional'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
