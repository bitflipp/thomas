// Musical context at a position: clef, octave shift, key and the accidentals already in force; and
// pitch <-> staff position. Editing needs this to turn a click on a staff line into a pitch the way
// a reader would (a sharp earlier in the bar still applies) and to keep pitches sounding right under
// 8va lines and clef changes. All of it is recomputed from the score on demand: nothing is cached.

import { clefBottomStep, keyAlter } from '../engrave/prep.ts';
import type { Clef, Pitch, Score, Step } from '../model.ts';
import { flattenVoice, keyAt, marksOf, pitchStep, STEPS } from '../model.ts';
import { must } from '../util.ts';

/** The clef in force at `tick` of measure `mi`: the staff's initial clef, then every clef change before that point. */
export function clefAt(score: Score, staff: string, mi: number, tick: number): Clef {
  let c = must(score.staves.find((s) => s.id === staff)).clef;
  for (let m = 0; m <= mi; m++)
    for (const mk of marksOf(score.measures[m].staves[staff]))
      if (mk.type === 'clef' && (m < mi || mk.tick <= tick)) c = mk.clef;
  return c;
}

/** -1: under an 8va (written an octave below the sounding pitch), +1: under an 8vb, else 0. */
export function ottavaAt(score: Score, staff: string, mi: number, tick: number): number {
  let sh = 0;
  for (let m = 0; m <= mi; m++)
    for (const mk of marksOf(score.measures[m].staves[staff])) {
      if (m === mi && mk.tick > tick) continue;
      if (mk.type === 'ottava') sh = mk.dir === 'up' ? -1 : 1;
      else if (mk.type === 'stop' && mk.of === 'ottava' && (m < mi || mk.tick <= tick)) sh = 0;
    }
  return sh;
}

/** Written staff position (half spaces above the bottom line) -> diatonic step number (c0 = 0). */
function stepAtPos(pos: number, clef: Clef): number {
  return clefBottomStep(clef) + pos;
}

/** The alteration a plain (unmarked) note on this step has here: the key signature, then accidentals earlier in the measure. */
function alterIn(score: Score, staff: string, mi: number, tick: number, step: Step, octave: number): number {
  let alter = keyAlter(keyAt(score, mi), step);
  const sm = score.measures[mi].staves[staff];
  if (!sm) return alter;
  const seen: { start: number; voice: number; alter: number }[] = [];
  for (const v of sm.voices)
    for (const te of flattenVoice(v)) {
      if (te.start > tick || te.ev.kind !== 'note') continue;
      for (const np of te.ev.pitches)
        if (np.pitch.step === step && np.pitch.octave === octave)
          seen.push({ start: te.start, voice: v.id, alter: np.pitch.alter });
    }
  seen.sort((a, b) => a.start - b.start || a.voice - b.voice);
  if (seen.length) alter = seen[seen.length - 1].alter;
  return alter;
}

/** Pitch (sounding) for a click at staff position `pos`; `acc` forces an alteration (undefined: whatever is in force). */
export function pitchAtPos(score: Score, staff: string, mi: number, tick: number, pos: number, acc?: number): Pitch {
  const clef = clefAt(score, staff, mi, tick);
  const shift = ottavaAt(score, staff, mi, tick);
  const st = stepAtPos(pos, clef);
  const octave = Math.floor(st / 7);
  const step = STEPS[((st % 7) + 7) % 7];
  return { step, octave: octave - shift, alter: acc ?? alterIn(score, staff, mi, tick, step, octave) };
}

/** Spelling of each pitch class (0 = c) when transposing up: sharps, or flats when going down. */
const SHARPS: [Step, number][] = [
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

const FLATS: [Step, number][] = [
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

/** Chromatic transposition by semitones: sharps going up, flats going down. */
export function transposeSemis(p: Pitch, semis: number): Pitch {
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[p.step];
  const midi = (p.octave + 1) * 12 + base + p.alter + semis;
  const pc = ((midi % 12) + 12) % 12;
  const [step, alter] = (semis >= 0 ? SHARPS : FLATS)[pc];
  const stepBase = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[step];
  return { step, alter, octave: Math.round((midi - stepBase - alter) / 12) - 1 };
}

/** Diatonic transposition: the same alteration, `steps` letter names up. */
export function transposeSteps(p: Pitch, steps: number): Pitch {
  const st = pitchStep(p) + steps;
  return { step: STEPS[((st % 7) + 7) % 7], octave: Math.floor(st / 7), alter: p.alter };
}

/** Orders pitches from low to high by diatonic step first, then by alteration. */
export const comparePitch = (a: Pitch, b: Pitch): number => pitchStep(a) - pitchStep(b) || a.alter - b.alter;
