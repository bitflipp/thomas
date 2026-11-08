// Headless helpers for lyric entry: which note comes next under a syllable, and how a syllable is
// shown for editing. The command that changes lyrics is `setSyllable` in `commands.ts`.

import type { Score, Syllable } from '../model.ts';
import { flattenVoice } from '../model.ts';
import type { EvAddr } from './addr.ts';

/** A syllable as typed: hyphens show how it joins its neighbours (`Ly-`, `-ri-`, `-cs`). */
export function syllableText(y: Syllable): string {
  const lead = y.syllabic === 'middle' || y.syllabic === 'end' ? '-' : '';
  const trail = y.syllabic === 'middle' || y.syllabic === 'begin' ? '-' : '';
  return lead + y.text + trail;
}

/**
 * The note that carries the next (`dir` 1) or previous (-1) syllable of the voice at `a`: the next
 * note, skipping rests and notes that continue a tie, across measures. Undefined at the ends.
 */
export function neighbourNote(score: Score, a: EvAddr, dir: 1 | -1): EvAddr | undefined {
  const notes: EvAddr[] = [];
  let tiedIn = false;
  for (let mi = 0; mi < score.measures.length; mi++) {
    const v = score.measures[mi].staves[a.staff]?.voices.find((x) => x.id === a.voice);
    if (!v) continue;
    flattenVoice(v).forEach((t, idx) => {
      if (t.ev.kind !== 'note') {
        tiedIn = false;
        return;
      }
      if (!tiedIn) notes.push({ mi, staff: a.staff, voice: a.voice, idx });
      tiedIn = t.ev.pitches.some((p) => p.tie);
    });
  }
  const at = notes.findIndex((n) => n.mi === a.mi && n.idx === a.idx);
  return notes[at + dir];
}
