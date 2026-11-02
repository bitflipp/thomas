// "Select similar": every element of the score that is like a given one (all `p` dynamics, all cresc. hairpins,
// all quarter rests ...), as refs ready to become the selection.
import type { MarkBody, Score } from '../model.ts';
import { flattenVoice, marksOf } from '../model.ts';
import type { Ref } from './addr.ts';
import { eventOf } from './addr.ts';

/** Elements are "similar" when the Properties panel edits them together: marks of one type, all notes (or all rests), all slurs ... */
const markKey = (m: MarkBody): string => m.type;

/** Refs to everything in `score` that is like `ref` (including `ref` itself): everything the Properties panel would bulk-edit along with it; empty for measures. */
export function similarTo(score: Score, ref: Ref): Ref[] {
  const out: Ref[] = [];
  if (ref.t === 'mark') {
    const at = marksOf(score.measures[ref.mi]?.staves[ref.staff]).find(
      (m) => m.voice === ref.voice && m.idx === ref.idx && m.k === ref.k,
    );
    if (!at) return out;
    const key = markKey(at);
    score.measures.forEach((m, mi) => {
      for (const [staff, sm] of Object.entries(m.staves))
        for (const mk of marksOf(sm))
          if (markKey(mk) === key) out.push({ t: 'mark', mi, staff, voice: mk.voice, idx: mk.idx, k: mk.k });
    });
  } else if (ref.t === 'measure') {
    return out;
  } else {
    // Notes are edited together, as are rests, all slurs, all ties and all tuplets.
    const kind = eventOf(score, ref)?.kind;
    score.measures.forEach((m, mi) => {
      for (const [staff, sm] of Object.entries(m.staves))
        for (const vv of sm.voices) {
          const seen = new Set<unknown>();
          for (const te of flattenVoice(vv)) {
            const at = { mi, staff, voice: vv.id, idx: te.index };
            if (ref.t === 'ev') {
              if (te.ev.kind === kind) out.push({ t: 'ev', ...at });
            } else if (ref.t === 'slur')
              for (const sl of te.ev.slurStart ?? []) out.push({ t: 'slur', ...at, id: sl.id });
            else if (ref.t === 'line')
              for (const ln of te.ev.lineStart ?? []) out.push({ t: 'line', ...at, id: ln.id });
            else if (ref.t === 'tie') {
              if (te.ev.kind === 'note')
                te.ev.pitches.forEach((p, pi) => {
                  if (p.tie) out.push({ t: 'tie', ...at, pi });
                });
            } else
              te.tuplets.forEach((g, depth) => {
                if (seen.has(g)) return;
                seen.add(g);
                out.push({ t: 'tuplet', ...at, depth });
              });
          }
        }
    });
  }
  return out;
}
