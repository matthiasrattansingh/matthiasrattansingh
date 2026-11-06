// Which session plays next: unplayed first, then your lowest grade, then the
// review queue. Recently played sessions are skipped so nothing repeats back to back.
import { GRADE_RANK } from './collection.js';
import { seeded } from '../lib/format.js';

export function pickNext(progress, cards, { recent = [], salt = '' } = {}) {
  const rand = seeded(`next|${salt}|${progress.answered}`);
  const fresh = cards.filter((c) => !recent.includes(c.id));
  const pool = fresh.length ? fresh : cards;
  const jitter = new Map(pool.map((c) => [c.id, rand()]));

  const unplayed = pool.filter((c) => !progress.played[c.id]);
  if (unplayed.length) return unplayed.sort((a, b) => jitter.get(a.id) - jitter.get(b.id))[0];

  const byGrade = [...pool].sort((a, b) => {
    const ga = GRADE_RANK[progress.played[a.id].grade];
    const gb = GRADE_RANK[progress.played[b.id].grade];
    if (ga !== gb) return ga - gb;
    // Same grade: sessions in the miss queue first, then the one played longest ago.
    const ma = progress.misses[a.id] ? 0 : 1;
    const mb = progress.misses[b.id] ? 0 : 1;
    if (ma !== mb) return ma - mb;
    return (progress.played[a.id].at ?? 0) - (progress.played[b.id].at ?? 0) || jitter.get(a.id) - jitter.get(b.id);
  });
  return byGrade[0];
}
