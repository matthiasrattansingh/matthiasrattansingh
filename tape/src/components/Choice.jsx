// Big thumb-friendly buttons.
const TONES = {
  up: ['border-up/50 text-up', 'bg-up/25'],
  down: ['border-down/50 text-down', 'bg-down/25'],
  flat: ['border-white/30 text-white', 'bg-white/15'],
  amber: ['border-amber/50 text-amber', 'bg-amber/25'],
};

export default function Choice({ tone = 'flat', selected, dim, onClick, children, className = '' }) {
  const [base, sel] = TONES[tone];
  return (
    <button
      onClick={onClick}
      className={`num rounded-xl border py-3.5 text-sm font-bold tracking-widest transition active:scale-[.97] ${base} ${
        selected ? sel : 'bg-panel'
      } ${dim ? 'opacity-40' : ''} ${className}`}
    >
      {children}
    </button>
  );
}
