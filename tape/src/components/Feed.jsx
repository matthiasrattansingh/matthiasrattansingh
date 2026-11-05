import { useEffect, useRef } from 'react';

// Vertical scroll-snap container. Reports which card is on screen and
// asks for more cards when you get near the end (endless feed).
export default function Feed({ items, renderItem, onActiveChange, onNearEnd }) {
  const ref = useRef(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const i = Number(e.target.dataset.index);
            onActiveChange?.(i);
            if (i >= items.length - 3) onNearEnd?.();
          }
        }
      },
      { root, threshold: 0.6 },
    );
    root.querySelectorAll('[data-index]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [items, onActiveChange, onNearEnd]);

  return (
    <main ref={ref} className="feed h-[100dvh] snap-y snap-mandatory overflow-y-scroll">
      {items.map((item, i) => (
        <div key={item.key} data-index={i}>
          {renderItem(item, i)}
        </div>
      ))}
    </main>
  );
}
