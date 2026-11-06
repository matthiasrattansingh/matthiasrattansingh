import { fmtMoney, START_BANKROLL } from '../lib/book.js';

// Shown when a trade takes the account to zero or below.
export default function MarginCall({ blowups, onClose }) {
  return (
    <div className="pop fixed inset-0 z-50 flex items-center justify-center bg-down/25 px-6 backdrop-blur-sm">
      <div className="loss-shake w-full max-w-sm rounded-2xl border border-down bg-black p-6 text-center">
        <div className="text-6xl">💀</div>
        <div className="num mt-3 text-3xl font-extrabold tracking-widest text-down">MARGIN CALL</div>
        <p className="mt-3 text-[15px] text-white/85">That trade wiped out your account. On a real desk, risk would have cut you off long before this.</p>
        <p className="mt-2 text-[13px] text-dim">Size so one bad call can't end you. You've been refilled to {fmtMoney(START_BANKROLL, { sign: false })}.</p>
        <p className="num mt-3 text-sm text-down">Margin calls: {blowups}</p>
        <button onClick={onClose} className="num mt-5 w-full rounded-xl border border-white/30 bg-white/10 py-3 text-sm font-bold tracking-widest">
          BACK TO THE DESK
        </button>
      </div>
    </div>
  );
}
