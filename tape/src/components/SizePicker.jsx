import Choice from './Choice.jsx';
import { LOT_SIZES } from '../lib/book.js';

// Second tap of every trade: how many lots. Tapping a size places the trade.
// 1 lot = 1,000 bbl, so a $1/bbl move = $1,000 per lot.
export default function SizePicker({ enabled, onPick }) {
  return (
    <div className={`pop mt-2 ${enabled ? "" : "pointer-events-none opacity-30"}`}>
      <div className="mb-1 text-center text-[10px] uppercase tracking-[0.2em] text-dim">size it · $1/bbl = $1,000 per lot</div>
      <div className="grid grid-cols-3 gap-2">
        {LOT_SIZES.map((n) => (
          <Choice key={n} tone="amber" onClick={() => onPick(n)}>
            {n} LOT{n > 1 ? 'S' : ''}{n === 5 ? ' 🔥' : ''}
          </Choice>
        ))}
      </div>
    </div>
  );
}
