// Step entry from a MIDI keyboard, headless: spelling a MIDI key as a pitch of the key signature, entering it at a
// cursor and moving the cursor on. The UI (`ui/midiin.ts`) owns the device and the chord timing; everything that
// changes the score lives here so that it can be tested with `node --test`.

import type { Dur, Pitch, Score, Step } from '../model.ts';
import { baseTicks, keyAt, measureTicks, timeAt } from '../model.ts';
import { enterNote, insertMeasures } from './commands.ts';

/** Where the next note goes: a position in one voice of one staff. */
export interface Cursor {
  mi: number;
  staff: string;
  voice: number;
  tick: number;
}

/** The step and alteration of each pitch class (0 = c) spelled with sharps, and with flats. */
const SHARP_SPELLING: [Step, number][] = [
  ['c', 0],
  ['c', 1],
  ['d', 0],
  ['d', 1],
  ['e', 0],
  ['f', 0],
  ['f', 1],
  ['g', 0],
  ['g', 1],
  ['a', 0],
  ['a', 1],
  ['b', 0],
];

const FLAT_SPELLING: [Step, number][] = [
  ['c', 0],
  ['d', -1],
  ['d', 0],
  ['e', -1],
  ['e', 0],
  ['f', 0],
  ['g', -1],
  ['g', 0],
  ['a', -1],
  ['a', 0],
  ['b', -1],
  ['b', 0],
];

/** The pitch of MIDI key `midi` (60 = c4), spelled with sharps in sharp keys and in C, with flats in flat keys. */
export function spellMidi(midi: number, fifths: number): Pitch {
  const [step, alter] = (fifths < 0 ? FLAT_SPELLING : SHARP_SPELLING)[((midi % 12) + 12) % 12];
  return { step, octave: Math.floor(midi / 12) - 1, alter };
}

/** Enters MIDI key `midi` at the cursor, adding it to the note that starts there when `chord`; a missing measure at the end is added first. */
export function enterMidi(score: Score, cur: Cursor, dur: Dur, midi: number, chord = false): Score {
  const s = cur.mi >= score.measures.length ? insertMeasures(score, score.measures.length) : score;
  return enterNote(s, cur, cur.tick, dur, spellMidi(midi, keyAt(s, cur.mi)), { chord });
}

/** The cursor after a note of `dur` entered at `cur`: later in the measure, or at the start of the next one (added when the score ends). */
export function advanceCursor(score: Score, cur: Cursor, dur: Dur): { score: Score; cursor: Cursor } {
  const tick = cur.tick + baseTicks(dur);
  if (tick < measureTicks(timeAt(score, cur.mi))) return { score, cursor: { ...cur, tick } };
  const s = cur.mi + 1 >= score.measures.length ? insertMeasures(score, score.measures.length) : score;
  return { score: s, cursor: { ...cur, mi: cur.mi + 1, tick: 0 } };
}
