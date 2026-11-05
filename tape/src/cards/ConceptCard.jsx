import { useMemo } from 'react';
import CardShell from '../components/CardShell.jsx';
import Reveal from '../components/Reveal.jsx';
import { scoreConcept } from '../lib/scoring.js';
import { seeded } from '../lib/format.js';

// CONCEPT BITE: one idea in four lines, then one multiple-choice question.
// Choices are shuffled per feed slot, so the JSON can always list the answer first.
export default function ConceptCard({ card, slotKey, answer, onAnswer, badge }) {
  const order = useMemo(() => {
    const rand = seeded(slotKey);
    const idx = card.question.choices.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    return idx;
  }, [card, slotKey]);

  const done = Boolean(answer);
  const pick = (i) => {
    const result = scoreConcept(card, i);
    onAnswer({ choice: i, result }, result);
  };

  return (
    <CardShell kicker="CONCEPT BITE" badge={badge}>
      <h2 className={`font-extrabold leading-tight ${done ? 'text-xl' : 'text-2xl'}`}>{card.title}</h2>
      <ul className={`mt-3 leading-snug text-white/85 ${done ? 'space-y-1 text-[13px]' : 'space-y-2 text-[15px]'}`}>
        {card.lines.map((l) => (
          <li key={l} className="flex gap-2">
            <span className="text-amber">›</span>
            <span>{l}</span>
          </li>
        ))}
      </ul>

      <div className="mt-auto pt-4">
        <p className="mb-2 text-[15px] font-semibold leading-snug">{card.question.prompt}</p>
        <div className="space-y-2">
          {order.map((i) => {
            const isAnswer = i === card.question.answer;
            const isPicked = answer?.choice === i;
            const look = !done
              ? 'border-line bg-panel active:bg-white/10'
              : isAnswer
                ? 'border-up/60 bg-up/15 text-up'
                : isPicked
                  ? 'border-down/60 bg-down/15 text-down'
                  : 'hidden';
            return (
              <button key={i} disabled={done} onClick={() => pick(i)}
                className={`w-full rounded-xl border px-3 text-left ${done ? 'py-2' : 'py-3'} text-sm leading-snug transition ${look}`}>
                {card.question.choices[i]}
              </button>
            );
          })}
        </div>
        {done && (
          <div className="mt-2">
            <Reveal correct={answer.result.correct} points={answer.result.points}
              title={answer.result.correct ? 'Right' : 'Not quite'} why={[card.question.explain]} source={card.source} />
          </div>
        )}
      </div>
    </CardShell>
  );
}
