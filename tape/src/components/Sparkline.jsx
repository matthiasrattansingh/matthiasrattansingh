// Minimal SVG sparkline. `data` is drawn solid; `after` (the reveal) is drawn
// dashed in the outcome colour. The scale only includes `after` once it's
// shown, so the chart never leaks where price went.
export default function Sparkline({ data, after = [], showAfter = false, height = 88, zeroLine = false, marker = true }) {
  const all = showAfter ? [...data, ...after] : data;
  const n = all.length;
  const W = 300;
  const H = height;
  const pad = 6;
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (zeroLine) { min = Math.min(min, 0); max = Math.max(max, 0); }
  if (max === min) { max += 1; min -= 1; }
  const x = (i) => pad + (i / Math.max(n - 1, 1)) * (W - pad * 2);
  const y = (v) => pad + (1 - (v - min) / (max - min)) * (H - pad * 2);
  const pts = (xs, offset = 0) => xs.map((v, i) => `${x(i + offset).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  const last = data[data.length - 1];
  const baseTone = last >= data[0] ? 'stroke-up' : 'stroke-down';
  const end = after[after.length - 1];
  const afterTone = end >= last ? 'stroke-up' : 'stroke-down';
  const di = data.length - 1;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block w-full" style={{ height }}>
      {zeroLine && (
        <line x1="0" x2={W} y1={y(0)} y2={y(0)} className="stroke-white/25" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
      )}
      <polyline points={pts(data)} fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" className={baseTone} />
      {showAfter && after.length > 0 && (
        <polyline points={pts([last, ...after], di)} fill="none" strokeWidth="2.5" strokeDasharray="5 4"
          vectorEffect="non-scaling-stroke" className={afterTone} />
      )}
      {marker && (
        <>
          <line x1={x(di)} x2={x(di)} y1="0" y2={H} className="stroke-amber/50" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
          <circle cx={x(di)} cy={y(last)} r="3.5" className="fill-amber" />
        </>
      )}
    </svg>
  );
}
