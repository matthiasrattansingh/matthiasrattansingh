// One phone screen. Every card type renders inside this frame.
export default function CardShell({ kicker, kickerTone = 'text-amber', badge, children, footer }) {
  return (
    <section className="relative h-[100dvh] w-full snap-start snap-always flex justify-center">
      <div className="flex h-full w-full max-w-md flex-col px-4 pt-14 pb-5">
        <div className="mb-3 flex items-center justify-between text-[11px] uppercase tracking-[0.18em]">
          <span className={`num font-semibold ${kickerTone}`}>{kicker}</span>
          {badge}
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        {footer && <div className="pt-3">{footer}</div>}
      </div>
    </section>
  );
}
