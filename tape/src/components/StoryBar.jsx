import { useEffect, useState } from 'react';

// Reel-style timer across the top: fills over the 15-second budget for the
// card on screen, and snaps full once you've answered.
export default function StoryBar({ activeKey, done, seconds = 15 }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    setElapsed(0);
    const start = performance.now();
    const id = setInterval(() => setElapsed((performance.now() - start) / 1000), 100);
    return () => clearInterval(id);
  }, [activeKey]);

  const pct = done ? 100 : Math.min(100, (elapsed / seconds) * 100);
  const late = !done && elapsed > seconds;
  return (
    <div className="h-[3px] w-full bg-white/10">
      <div
        className={`h-full transition-[width] duration-100 ease-linear ${done ? 'bg-up' : late ? 'bg-down' : 'bg-white/80'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
