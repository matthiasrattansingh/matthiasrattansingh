import { bellDone } from '../lib/bell.js';
import { localDay, todayDesk } from '../lib/progress.js';

function Ring({ value, color, label, small }) {
  const r = 15;
  const len = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  const size = small ? 'h-7 w-7' : 'h-11 w-11';
  return (
    <div className="flex items-center gap-1.5">
      <svg viewBox="0 0 40 40" className={`${size} -rotate-90`}>
        <circle cx="20" cy="20" r={r} fill="none" stroke="rgba(255,255,255,.12)" strokeWidth="5" />
        <circle cx="20" cy="20" r={r} fill="none" stroke={color} strokeWidth="5" strokeLinecap="round"
          strokeDasharray={len} strokeDashoffset={len * (1 - v)} style={{ transition: 'stroke-dashoffset .6s' }} />
      </svg>
      <span className={`num leading-tight ${small ? 'text-[9px]' : 'text-[10px]'} text-white/80`}>{label}</span>
    </div>
  );
}

/** Today's three rings: OPEN BELL done · 3 sessions · 3 quests. */
export default function Rings({ progress, small = false }) {
  const date = localDay();
  const sessions = todayDesk(progress.day, date).sessions ?? 0;
  const quests = progress.quests?.date === date ? progress.quests.list.filter((q) => q.done).length : 0;
  const bell = bellDone(progress, date) ? 1 : 0;
  return (
    <div className={`flex items-center ${small ? 'gap-3' : 'justify-between'}`}>
      <Ring small={small} value={bell} color="#ff4d5e" label={small ? `BELL ${bell}/1` : <>BELL<br />{bell}/1</>} />
      <Ring small={small} value={sessions / 3} color="#22e584" label={small ? `TRADES ${Math.min(sessions, 3)}/3` : <>SESSIONS<br />{Math.min(sessions, 3)}/3</>} />
      <Ring small={small} value={quests / 3} color="#ffb000" label={small ? `QUESTS ${quests}/3` : <>QUESTS<br />{quests}/3</>} />
    </div>
  );
}
