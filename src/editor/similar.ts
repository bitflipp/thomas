// "Select similar": every element of the score that is like a given one (all `p` dynamics, all cresc. hairpins,
// all quarter rests ...), as refs ready to become the selection.
import type { Event, MarkBody, Score } from '../model.ts';
import { flattenVoice, marksOf } from '../model.ts';
import type { Ref } from './addr.ts';

/** What makes two marks "the same" for selecting: type plus the property that gives it its meaning. */
function markKey(m: MarkBody): string {
  switch (m.type) {
    case 'dynamic':
      return 'dynamic'; // all dynamics are alike, whatever they say
    case 'text':
      return `${m.type}:${m.text}`;
    case 'hairpin':
      return `hairpin:${m.kind}`;
    case 'ottava':
      return `ottava:${m.dir}`;
    case 'stop':
      return `stop:${m.of}`;
    case 'clef':
      return `clef:${m.clef.sign}${m.clef.line}`;
    case 'tempo':
      return `tempo:${m.unit}.${m.dots}=${m.bpm}`;
    case 'pedal':
      return 'pedal';
  }
}

/** Events are alike when they are of the same kind and written duration. */
const eventKey = (e: Event): string => `${e.kind}:${JSON.stringify(e.dur)}`;

/** Refs to everything in `score` that is like `ref` (including `ref` itself); empty for kinds that cannot be compared. */
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
  } else if (ref.t === 'ev') {
    const v = score.measures[ref.mi]?.staves[ref.staff]?.voices.find((x) => x.id === ref.voice);
    const at = v && flattenVoice(v)[ref.idx]?.ev;
    if (!at) return out;
    const key = eventKey(at);
    score.measures.forEach((m, mi) => {
      for (const [staff, sm] of Object.entries(m.staves))
        for (const vv of sm.voices)
          for (const te of flattenVoice(vv))
            if (eventKey(te.ev) === key) out.push({ t: 'ev', mi, staff, voice: vv.id, idx: te.index });
    });
  }
  return out;
}
