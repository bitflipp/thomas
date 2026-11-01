// Addresses: stable ways to name things in a Score across edits.
//
// Immer replaces model objects on every edit, so UI state (selection, hover, the text pane's
// highlight) cannot hold on to events or marks themselves. It holds a `Ref` instead: measure index,
// staff id, voice id and the flat event index within the voice, which survive an edit that does not
// restructure that voice. `indexScore` goes from objects to addresses and the `*Of` functions back.
import { flattenVoice, marksOf, type Event, type Mark, type Score, type TupletGroup, type Voice } from '../model.ts';

/** An event: measure, staff id, voice id and its index in the voice's flattened event order. */
export interface EvAddr { mi: number; staff: string; voice: number; idx: number }
/** A mark: the voice it hangs on, the event (index in the voice; -1 = the voice's end marks) and its place in that list. */
export interface MarkAddr { mi: number; staff: string; voice: number; idx: number; k: number }

/**
 * Anything that can be selected or hovered. The extra fields say which part of an event is meant:
 * `pi` one head of a chord, `id` a slur (several can start at one event), `depth` a tuplet level.
 */
export type Ref =
  | ({ t: 'ev'; pi?: number } & EvAddr) // a note/rest; `pi`: one head of a chord
  | ({ t: 'tie'; pi: number } & EvAddr)
  | ({ t: 'slur'; id: number } & EvAddr) // addressed by the event it starts at
  | ({ t: 'tuplet'; depth: number } & EvAddr) // by its first event; depth = nesting level (0 = outermost)
  | ({ t: 'mark' } & MarkAddr)
  | { t: 'measure'; mi: number };

/** A string identity for a Ref, for sets and map keys (refs are plain objects and compare by identity). */
export const refKey = (r: Ref): string => {
  switch (r.t) {
    case 'ev': return `ev:${r.mi}:${r.staff}:${r.voice}:${r.idx}${r.pi === undefined ? '' : ':' + r.pi}`;
    case 'tie': return `tie:${r.mi}:${r.staff}:${r.voice}:${r.idx}:${r.pi}`;
    case 'slur': return `slur:${r.mi}:${r.staff}:${r.voice}:${r.idx}:${r.id}`;
    case 'tuplet': return `tup:${r.mi}:${r.staff}:${r.voice}:${r.idx}:${r.depth}`;
    case 'mark': return `mark:${r.mi}:${r.staff}:${r.voice}:${r.idx}:${r.k}`;
    case 'measure': return `m:${r.mi}`;
  }
};

/** Reverse lookup of a whole score: where each event, mark and tuplet lives. Rebuilt per score, not per edit. */
export interface ScoreIndex {
  ev: Map<Event, EvAddr>;
  mark: Map<Mark, MarkAddr>;
  tuplet: Map<TupletGroup, EvAddr & { depth: number }>;
}

export function indexScore(score: Score): ScoreIndex {
  const ev = new Map<Event, EvAddr>(), mark = new Map<Mark, MarkAddr>(), tuplet = new Map<TupletGroup, EvAddr & { depth: number }>();
  score.measures.forEach((m, mi) => {
    for (const [staff, sm] of Object.entries(m.staves)) {
      for (const mk of marksOf(sm)) mark.set(mk, { mi, staff, voice: mk.voice, idx: mk.idx, k: mk.k });
      for (const v of sm.voices) {
        for (const te of flattenVoice(v)) {
          const a = { mi, staff, voice: v.id, idx: te.index };
          ev.set(te.ev, a);
          te.tuplets.forEach((t, depth) => { if (!tuplet.has(t)) tuplet.set(t, { ...a, depth }); });
        }
      }
    }
  });
  return { ev, mark, tuplet };
}

export function voiceOf(score: Score, a: { mi: number; staff: string; voice: number }): Voice | undefined {
  return score.measures[a.mi]?.staves[a.staff]?.voices.find((v) => v.id === a.voice);
}
export function eventOf(score: Score, a: EvAddr): Event | undefined {
  const v = voiceOf(score, a);
  return v ? flattenVoice(v)[a.idx]?.ev : undefined;
}
export function markOf(score: Score, a: MarkAddr): Mark | undefined { return marksOf(score.measures[a.mi]?.staves[a.staff]).find((m) => m.voice === a.voice && m.idx === a.idx && m.k === a.k); }
export function tupletOf(score: Score, a: EvAddr & { depth: number }): TupletGroup | undefined {
  const v = voiceOf(score, a);
  return v ? flattenVoice(v)[a.idx]?.tuplets[a.depth] : undefined;
}
