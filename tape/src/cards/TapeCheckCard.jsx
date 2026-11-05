import CardShell from '../components/CardShell.jsx';
import Sparkline from '../components/Sparkline.jsx';
import Choice from '../components/Choice.jsx';
import { fmtDate, fmtPrice, fmtSigned, fmtPct, toneFor, decimalsFor } from '../lib/format.js';
import { headlineFor } from '../lib/tape.js';

// TAPE CHECK: today's print for one instrument. `quote` is live data when the
// fetch worked, or the seed snapshot otherwise. The one concrete thing to
// learn is the driver line: a matching seeded headline, or what moves it.
export default function TapeCheckCard({ card, quote, answer, onAnswer, badge }) {
  const q = quote ?? { ...card.fallback, live: false };
  const chg = q.price - q.prevClose;
  const pct = (chg / q.prevClose) * 100;
  const headline = headlineFor(card.symbol, q.asOf);
  const perBbl = card.unit === '$/gal' ? chg * 42 : null;

  return (
    <CardShell
      kicker="TAPE CHECK"
      badge={
        badge ?? (
          <span className={`num ${q.live ? 'text-up' : 'text-dim'}`}>{q.live ? '● LIVE' : '○ SNAPSHOT'}</span>
        )
      }
    >
      <div className="num text-xs text-dim">as of {fmtDate(q.asOf)}</div>
      <div className="mt-1 text-3xl font-extrabold leading-tight">{card.name}</div>
      <div className="text-[11px] text-dim">{card.contract} · {card.symbol}</div>

      <div className="mt-4 flex items-end justify-between">
        <div>
          <div className="num text-5xl font-bold leading-none">{fmtPrice(q.price, card.unit)}</div>
          <div className="num mt-1 text-xs text-dim">{card.unit}</div>
        </div>
        <div className={`num text-right ${toneFor(chg)}`}>
          <div className="text-xl font-bold">{fmtSigned(chg, decimalsFor(card.unit))}</div>
          <div className="text-sm">{fmtPct(pct)}</div>
          {perBbl !== null && <div className="text-[11px] text-dim">≈ {fmtSigned(perBbl)}/bbl</div>}
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-line bg-panel px-2 py-2">
        <Sparkline data={q.series} height={96} marker={false} />
        <div className="num px-1 text-[10px] text-dim">{q.series.length - 1}-day</div>
      </div>

      <div className="mt-4 rounded-xl border border-amber/30 bg-amber/5 p-3">
        <div className="text-[10px] uppercase tracking-[0.2em] text-amber">{headline ? 'What drove it' : 'What moves it'}</div>
        <p className="mt-1 text-[14px] leading-snug">{headline ?? card.driver}</p>
      </div>

      <div className="mt-auto pt-3">
        {answer ? (
          <div className="num pop text-center text-sm text-up">✓ Logged · +3 XP</div>
        ) : (
          <Choice tone="amber" className="w-full" onClick={() => onAnswer({ viewed: true }, null)}>GOT IT</Choice>
        )}
      </div>
    </CardShell>
  );
}
