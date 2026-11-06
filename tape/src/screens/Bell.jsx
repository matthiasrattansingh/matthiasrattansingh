import { useMemo, useState } from 'react';
import Feed from '../components/Feed.jsx';
import CardShell from '../components/CardShell.jsx';
import Choice from '../components/Choice.jsx';
import { bellCards, bellKey, bellSummary, shareText } from '../lib/bell.js';
import { fmtMoney } from '../lib/book.js';
import { BOTS, botById } from '../lib/rivals.js';
import { FEED_CARDS } from '../data/index.js';

function Results({ date, summary }) {
  const [status, setStatus] = useState('');
  const share = async () => {
    const text = shareText(date, summary);
    try {
      if (navigator.share) { await navigator.share({ text }); return; }
      await navigator.clipboard.writeText(text);
      setStatus('Copied. Paste it to a friend.');
    } catch {
      setStatus(text);
    }
  };
  const board = [{ id: 'you', name: 'You', emoji: '🫵', pnl: summary.you },
    ...BOTS.map((b) => ({ ...b, pnl: summary.bots[b.id] ?? 0 }))].sort((a, b) => b.pnl - a.pnl);

  return (
    <CardShell kicker="OPEN BELL · RESULTS">
      {!summary.done ? (
        <div className="my-auto text-center">
          <div className="text-5xl">🔔</div>
          <p className="mt-3 text-lg font-bold">Finish all 5 trades to post your score.</p>
          <p className="num mt-1 text-sm text-dim">{summary.grid}</p>
        </div>
      ) : (
        <>
          <div className="num text-center text-4xl tracking-widest">{summary.grid}</div>
          <div className={`num mt-3 text-center text-5xl font-extrabold ${summary.you >= 0 ? 'text-up' : 'text-down'}`}>{fmtMoney(summary.you)}</div>
          <div className="num mt-1 text-center text-sm font-bold text-amber">
            {summary.beat === 4 ? '👑 You beat the whole desk' : `You beat ${summary.beat}/4 of the desk`}
          </div>
          <ol className="mt-5 space-y-1.5">
            {board.map((r, i) => (
              <li key={r.id} className={`num flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${
                r.id === 'you' ? 'border-amber/50 bg-amber/10' : 'border-line bg-panel'}`}>
                <span>{i + 1}. {r.emoji} {r.name}</span>
                <span className={r.pnl >= 0 ? 'text-up' : 'text-down'}>{fmtMoney(r.pnl)}</span>
              </li>
            ))}
          </ol>
          <div className="mt-auto pt-4">
            <Choice tone="amber" className="w-full" onClick={share}>SHARE · CHALLENGE A FRIEND</Choice>
            {status && <p className="mt-2 whitespace-pre-wrap text-center text-[12px] text-dim">{status}</p>}
            <p className="mt-2 text-center text-[11px] text-dim">New bell at midnight. Same 5 cards for everyone today.</p>
          </div>
        </>
      )}
    </CardShell>
  );
}

// The daily challenge: same five cards for everyone today, one shot each.
export default function Bell({ date, progress, renderCard, onActive, active }) {
  const cards = useMemo(() => bellCards(FEED_CARDS, date), [date]);
  const saved = progress.bell[date]?.saved ?? {};
  const summary = bellSummary(cards, date, saved);
  const items = useMemo(
    () => [
      { key: `bell-intro-${date}`, intro: true },
      ...cards.map((card, i) => ({ key: bellKey(date, i), card, bell: true })),
      { key: `bell-results-${date}`, results: true },
    ],
    [cards, date],
  );

  return (
    <Feed
      items={items}
      onActiveChange={onActive}
      renderItem={(item, i) => {
        if (item.intro) {
          return (
            <CardShell kicker="OPEN BELL">
              <div className="my-auto">
                <div className="text-6xl">🔔</div>
                <h2 className="mt-4 text-3xl font-extrabold leading-tight">Today's Open Bell</h2>
                <p className="mt-2 text-[15px] text-white/80">5 trades. The same 5 for everyone today. One shot each.</p>
                <p className="mt-2 text-[15px] text-white/80">Beat the desk, then send your score to a friend and see if they can top it.</p>
                <div className="num mt-6 flex gap-2 text-2xl">{BOTS.map((b) => <span key={b.id} title={botById[b.id].name}>{b.emoji}</span>)}</div>
                <p className="num mt-6 text-sm text-dim">{summary.done ? `Done today: ${summary.grid} ${fmtMoney(summary.you)}` : 'Swipe up to start ↑'}</p>
              </div>
            </CardShell>
          );
        }
        if (item.results) return <Results date={date} summary={summary} />;
        return renderCard(active)(item, i);
      }}
    />
  );
}
