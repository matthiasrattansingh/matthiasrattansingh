import { useState } from 'react';
import CardShell from '../components/CardShell.jsx';
import Choice from '../components/Choice.jsx';
import { AGENTS } from '../data/index.js';
import {
  CLASS_NAMES, UNIT, actualOf, classOf, dominantDriver, driverClues, priceName, reaction,
} from './engine.js';

const fmt = (x, kind, d = kind === 'gas' ? 0 : 1) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}`;
const word = (kind, x) => (x < 0 ? (kind === 'gas' ? 'withdrawal' : 'draw') : (kind === 'gas' ? 'injection' : 'build'));
const longDate = (iso) => new Date(`${iso}T12:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const CLASS_TONE = { FLAT: 'bg-white/10 text-white/70', NORMAL: 'bg-sky-400/20 text-sky-200', BIG: 'bg-amber/25 text-amber', HUGE: 'bg-down/25 text-down' };
const toneCls = (t) => (t > 0 ? 'text-up' : t < 0 ? 'text-down' : 'text-white/70');
const KICKER = { petroleum: 'EIA CRUDE', gas: 'EIA GAS' };
const RANGE = { petroleum: { min: -20, max: 20, step: 0.1, nudge: 1 }, gas: { min: -400, max: 200, step: 1, nudge: 10 } };

export function ClassChip({ name }) {
  return <span className={`num rounded px-1.5 py-0.5 text-[10px] font-extrabold tracking-wider ${CLASS_TONE[name]}`}>{name}</span>;
}

/** Real base rates of the size classes: the prior every forecast starts from. */
function BaseRates({ rates }) {
  return (
    <div className="num mt-1 flex items-center gap-1 whitespace-nowrap text-[9.5px] text-dim">
      <span className="mr-0.5 uppercase">base</span>
      {CLASS_NAMES.map((n) => <span key={n} className="rounded bg-white/5 px-1">{n} {Math.round(rates[n] * 100)}%</span>)}
    </div>
  );
}

/**
 * PRINT card. Before the lock: the week's driver clues with the date hidden, the real base
 * rates and a locked regime chip. After: the print, the driver that dominated, the desk's
 * forecasts and your running calibration.
 */
export function PrintCard({ kind, rec, records, index, classes, rates, guess, onLock, stats, agents }) {
  const R = RANGE[kind];
  const [g, setG] = useState(0);
  const clues = driverClues(kind, rec);
  const locked = guess != null;
  const x = actualOf(kind, rec);
  const cls = classOf(x, classes);
  const unit = UNIT[kind];

  return (
    <CardShell kicker={`${KICKER[kind]} · ${locked ? `wk to ${longDate(rec.week_ending)}` : 'WEEK ?'}`}
      badge={locked ? <ClassChip name={cls} /> : <span className="num text-[10px] text-dim">{index + 1}</span>}>
      {!locked ? (
        <>
          <div className="text-[16px] font-extrabold leading-tight">
            {kind === 'gas' ? 'Storage change this week?' : 'Crude stock change this week?'}
          </div>
          <BaseRates rates={rates} />
          <div className="mt-1.5 space-y-1">
            {clues.map((c) => (
              <div key={c.key} className="flex items-baseline justify-between gap-2 whitespace-nowrap rounded-lg border border-line bg-panel px-2.5 py-1">
                <span className="text-[10px] uppercase tracking-wider text-dim">{c.label}</span>
                <span className={`num text-[12px] font-bold ${toneCls(c.tone)}`}>{c.text}</span>
              </div>
            ))}
            {rec.regime.length > 0 && (
              <div className="num rounded-lg border border-dashed border-white/20 px-2.5 py-1 text-[10.5px] text-white/60">🔒 a regime tag applies; revealed after the print</div>
            )}
          </div>
          <p className="mt-1 text-[10px] leading-snug text-dim">
            {kind === 'gas' ? 'Start from the 5-yr average; move off it only if a driver says so.' : 'Start from the base rate; go to a tail only if a driver says so. Green = draw.'}
          </p>
          <div className="mt-auto">
            <div className="num flex items-baseline justify-center gap-2">
              <span className={`text-[34px] font-extrabold leading-none ${g < 0 ? 'text-up' : g > 0 ? 'text-down' : 'text-white'}`}>{fmt(g, kind)}</span>
              <span className="text-sm text-dim">{unit}</span>
              <ClassChip name={classOf(g, classes)} />
            </div>
            <div className="mt-1 flex items-center gap-2">
              <button className="num h-10 w-12 rounded-lg bg-white/10 font-bold" onClick={() => setG((v) => Math.max(R.min, Math.round((v - R.nudge) * 10) / 10))}>−</button>
              <input aria-label="forecast" type="range" min={R.min} max={R.max} step={R.step} value={g}
                onChange={(e) => setG(Number(e.target.value))} className="h-10 flex-1 accent-amber" />
              <button className="num h-10 w-12 rounded-lg bg-white/10 font-bold" onClick={() => setG((v) => Math.min(R.max, Math.round((v + R.nudge) * 10) / 10))}>+</button>
            </div>
            <Choice tone="amber" className="mt-1.5 w-full" onClick={() => onLock(Math.round(g * 10) / 10)}>LOCK {fmt(g, kind)} {unit}</Choice>
          </div>
        </>
      ) : (
        <PrintResult kind={kind} rec={rec} guess={guess} cls={cls} x={x} unit={unit} stats={stats} agents={agents} />
      )}
    </CardShell>
  );
}

function PrintResult({ kind, rec, guess, cls, x, unit, stats, agents }) {
  const err = Math.abs(guess - x);
  const drv = dominantDriver(kind, rec);
  return (
    <div className="pop flex min-h-0 flex-1 flex-col">
      <div className="num text-[11px] text-dim">released {longDate(rec.release_date)}</div>
      <div className="flex items-end justify-between">
        <div>
          <div className={`num text-[40px] font-extrabold leading-none ${x < 0 ? 'text-up' : 'text-down'}`}>{fmt(x, kind)}</div>
          <div className="num text-[11px] text-dim">{unit} {word(kind, x)}{kind === 'petroleum' ? ` · gasoline ${fmt(rec.gasoline, kind)} · distillate ${fmt(rec.distillate, kind)}` : ` · storage ${rec.level.toLocaleString()} Bcf`}</div>
        </div>
        <div className="num text-right">
          <div className="text-[11px] text-dim">you {fmt(guess, kind)}</div>
          <div className={`text-lg font-bold ${err <= (kind === 'gas' ? 10 : 1) ? 'text-up' : err <= (kind === 'gas' ? 30 : 3) ? 'text-amber' : 'text-down'}`}>off {err.toFixed(kind === 'gas' ? 0 : 1)}</div>
        </div>
      </div>
      {rec.regime.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {rec.regime.map((t, i) => <span key={i} title={t.source} className="num rounded bg-sky-400/15 px-1.5 text-[10px] font-bold uppercase text-sky-200">{t.tag.replace('_', ' ')}</span>)}
        </div>
      )}
      <div className="mt-2 rounded-xl border border-amber/30 bg-amber/5 px-3 py-2">
        <div className="text-[10px] uppercase tracking-[0.2em] text-amber">What dominated</div>
        <p className="mt-0.5 text-[13px] leading-snug">{drv.text}</p>
      </div>
      <div className="num mt-2 grid grid-cols-4 gap-1 text-center">
        {AGENTS.map((a) => (
          <div key={a.id} className="rounded-lg bg-black/40 py-1">
            <div className="text-[10px]" style={{ color: a.color }}>{a.emoji} {a.name.split(' ').pop()}</div>
            <div className="text-[12px] font-bold">{fmt(agents[a.id], kind)}</div>
          </div>
        ))}
      </div>
      <Calibration kind={kind} stats={stats} />
      <div className="num mt-auto pt-1 text-center text-[11px] text-white/60">↓ next: did {priceName(kind)} finish release day UP or DOWN?</div>
    </div>
  );
}

/** Running calibration: your average forecast size vs the market's, and error by size class. */
export function Calibration({ kind, stats }) {
  if (!stats?.n) return null;
  const d = kind === 'gas' ? 0 : 1;
  const big = stats.avgGuessSize > stats.avgActualSize * 1.25;
  const small = stats.avgGuessSize < stats.avgActualSize * 0.75;
  return (
    <div className="mt-2 rounded-xl border border-line bg-panel px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="whitespace-nowrap text-[10px] uppercase tracking-wider text-dim">Calibration · {stats.n}wk</span>
        <span className="num whitespace-nowrap text-[11px]">avg size you <b>{stats.avgGuessSize.toFixed(d)}</b> · mkt <b>{stats.avgActualSize.toFixed(d)}</b></span>
      </div>
      <div className="num mt-1 grid grid-cols-4 gap-1 text-center text-[10.5px]">
        {CLASS_NAMES.map((n) => {
          const c = stats.byClass[n];
          return (
            <div key={n} className="whitespace-nowrap rounded bg-black/40 py-0.5">
              <div className="text-[9.5px] text-dim">{n} {c.n}</div>
              <div className="font-bold">{c.n ? `±${c.mae.toFixed(d)}` : '—'}</div>
            </div>
          );
        })}
      </div>
      <div className="num mt-1 text-[10.5px] text-white/70">
        {big ? 'You forecast bigger than the market prints: gambling on tails.' : small ? 'You forecast smaller than the market prints: too timid for the base rate.' : 'Your size matches the market. Now check where the error lives.'}
      </div>
    </div>
  );
}

/**
 * REACTION card: its own micro-decision after the print. Given the print and the run into
 * it, did the price finish release day UP or DOWN? The reveal says why, from stored context.
 */
export function ReactionCard({ kind, rec, printLocked, call, onCall, rstats }) {
  const x = actualOf(kind, rec);
  const rx = reaction(kind, rec);
  const p = rx.price;
  const name = priceName(kind);
  const unit = kind === 'gas' ? '/MMBtu' : '/bbl';
  return (
    <CardShell kicker={`${name} REACTION`} badge={rstats?.n ? <span className="num text-[10px] text-dim">{rstats.right}/{rstats.n} right</span> : null}>
      {!printLocked ? (
        <div className="m-auto text-center text-sm text-dim">↑ Lock the print first.</div>
      ) : (
        <>
          <div className="text-[19px] font-extrabold leading-tight">Did {name} finish release day UP or DOWN?</div>
          <div className="num mt-2 space-y-1.5 text-[13px]">
            <div className="flex justify-between rounded-lg border border-line bg-panel px-3 py-1.5"><span className="text-dim">The print</span><b className={x < 0 ? 'text-up' : 'text-down'}>{fmt(x, kind)} {UNIT[kind]} {word(kind, x)}</b></div>
            {kind === 'gas' && <div className="flex justify-between rounded-lg border border-line bg-panel px-3 py-1.5"><span className="text-dim">5-yr avg for the week</span><b>{fmt(rec.avg5_change, kind)} Bcf</b></div>}
            {kind === 'petroleum' && rec.api != null && <div className="flex justify-between rounded-lg border border-line bg-panel px-3 py-1.5"><span className="text-dim">API on Tuesday</span><b>{fmt(rec.api, kind)} MMbbl</b></div>}
            {kind === 'petroleum' && rec.consensus != null && <div className="flex justify-between rounded-lg border border-line bg-panel px-3 py-1.5"><span className="text-dim">Consensus</span><b>{fmt(rec.consensus, kind)} MMbbl</b></div>}
            <div className="flex justify-between rounded-lg border border-line bg-panel px-3 py-1.5"><span className="text-dim">Run into the print (5 sessions)</span><b className={p.run5_pct > 0 ? 'text-up' : 'text-down'}>{p.run5_pct > 0 ? '+' : ''}{p.run5_pct.toFixed(1)}%</b></div>
          </div>
          {!call ? (
            <div className="mt-auto grid grid-cols-2 gap-2">
              <Choice tone="up" onClick={() => onCall('UP')}>▲ UP</Choice>
              <Choice tone="down" onClick={() => onCall('DOWN')}>▼ DOWN</Choice>
            </div>
          ) : (
            <div className="pop mt-3 flex min-h-0 flex-1 flex-col">
              <div className="flex items-end justify-between">
                <div className={`num text-[30px] font-extrabold leading-none ${p.chg > 0 ? 'text-up' : 'text-down'}`}>{rx.actual} {p.chg > 0 ? '+' : '−'}${Math.abs(p.chg).toFixed(2)}</div>
                <div className={`num text-lg font-bold ${call === rx.actual ? 'text-up' : 'text-down'}`}>{call === rx.actual ? '✓ right' : '✗ wrong'}</div>
              </div>
              <div className="num text-[11.5px] text-white/75">
                {longDate(p.date)}: settled ${p.settle.toFixed(2)}{unit} ({p.chg_pct > 0 ? '+' : ''}{p.chg_pct.toFixed(1)}%) · next day {p.next_chg > 0 ? '+' : '−'}${Math.abs(p.next_chg).toFixed(2)} ({p.next_chg_pct > 0 ? '+' : ''}{p.next_chg_pct.toFixed(1)}%)
              </div>
              <div className="num mt-1 text-[11px] text-dim">Naive read: {kind === 'gas' ? (rx.naive === 'UP' ? 'tighter than the seasonal norm' : 'looser than the seasonal norm') : word(kind, x)} → {rx.naive}. {rx.matched ? 'The naive read worked.' : 'The naive read failed.'}</div>
              <div className="mt-2 space-y-1">
                {rx.reasons.map((r) => (
                  <p key={r.key} className="rounded-lg border border-amber/30 bg-amber/5 px-3 py-1.5 text-[12.5px] leading-snug">{r.text}</p>
                ))}
              </div>
              {rstats?.n > 0 && <div className="num mt-auto pt-1 text-center text-[11px] text-white/60">Reaction calls {rstats.right}/{rstats.n} · the naive rule got {rstats.naive}/{rstats.n} of the same weeks</div>}
            </div>
          )}
        </>
      )}
    </CardShell>
  );
}
