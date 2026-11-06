import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { refresh } from './game/afterSession.js';
import { specialsLog } from './game/calendar.js';
import { SESSION_CARDS } from './data/index.js';
import Feed from './components/Feed.jsx';
import Hud from './components/Hud.jsx';
import MarginCall from './components/MarginCall.jsx';
import Profile from './screens/Profile.jsx';
import Desk from './screens/Desk.jsx';
import Bell from './screens/Bell.jsx';
import Trade from './screens/Trade.jsx';
// The EIA tab carries ~5 years of weekly prints: load it only when opened.
const ForecastScreen = lazy(() => import('./forecast/ForecastScreen.jsx'));
import useProgress from './lib/useProgress.js';
import useLiveQuotes from './lib/useLiveQuotes.js';
import { localDay } from './lib/progress.js';
import { bellDone } from './lib/bell.js';
import { TAPE_CARDS } from './data/index.js';
import TapeCheckCard from './cards/TapeCheckCard.jsx';

const SYMBOLS = TAPE_CARDS.map((c) => c.symbol);
const LIVE_ITEMS = TAPE_CARDS.map((card) => ({ key: `live-${card.id}`, card }));

export default function App() {
  const { progress, session, record, apply, view, saveBell, clearMarginCall, reset } = useProgress();
  const { quotes, status } = useLiveQuotes(SYMBOLS);
  const [tab, setTab] = useState('trade');
  const date = useMemo(() => localDay(), [tab]); // recomputed on tab switches, so it rolls over at midnight
  const [liveSeen, setLiveSeen] = useState({});
  const [startWith, setStartWith] = useState(null);
  const openSession = (id) => { setStartWith(id); setTab('trade'); };
  const noop = useCallback(() => {}, []);

  // Roll over the day (quests) and the week (league) on open and on every tab switch.
  useEffect(() => { apply((p) => refresh(p, new Date())); }, [tab, apply]);

  return (
    <div className="relative h-[100dvh] overflow-hidden bg-black">
      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 mx-auto max-w-md bg-gradient-to-b from-black via-black/90 to-transparent pb-1">
        <Hud progress={progress} tab={tab} onTab={setTab} liveStatus={status} bellDone={bellDone(progress, date)} compact={tab === 'trade' || tab === 'bell' || tab === 'eia'} />
      </header>

      <div className="mx-auto h-[100dvh] max-w-md">
        {tab === 'trade' && <Trade progress={progress} record={record} apply={apply} startWith={startWith} onStarted={() => setStartWith(null)} />}
        {tab === 'bell' && <Bell date={date} progress={progress} record={record} apply={apply} saveBell={saveBell} />}
        {tab === 'live' && (
          <Feed
            items={LIVE_ITEMS}
            onActiveChange={noop}
            renderItem={(item) => (
              <TapeCheckCard
                card={item.card}
                quote={quotes[item.card.symbol]}
                answer={liveSeen[item.key]}
                onAnswer={() => { setLiveSeen((a) => ({ ...a, [item.key]: true })); view(item.card.id); }}
              />
            )}
          />
        )}
        {tab === 'eia' && <Suspense fallback={<div className="num pt-24 text-center text-sm text-dim">Loading EIA history…</div>}><ForecastScreen progress={progress} apply={apply} /></Suspense>}
        {tab === 'desk' && <Desk progress={progress} />}
        {tab === 'me' && <Profile progress={progress} session={session} onReset={reset} apply={apply} onOpenSession={openSession} onTrade={() => setTab('trade')} specials={specialsLog(progress, date, SESSION_CARDS)} />}
      </div>

      {progress.marginCall && <MarginCall blowups={progress.blowups} onClose={clearMarginCall} />}
    </div>
  );
}
