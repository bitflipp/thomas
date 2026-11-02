// What the MusicXML reader produces before voices are built: notes with absolute ticks inside the
// measure, and the shared name tables.
import type { BaseDur, Dur, Event } from './model.ts';
import { baseTicks } from './model.ts';

/** A note or rest as read from the file, before it is placed into a voice tree. */
export interface RawNote {
  tick: number;
  ticks: number;
  staff: number;
  voice: number;
  ev: Event;
  /** Time modification: [actual, normal] notes of a tuplet. */
  tmRatio?: [number, number];
  /** Tuplets starting at this note, outermost first, with the display options of each. */
  tupStart?: TupletStart[];
  /** Number of tuplets ending at this note. */
  tupStop: number;
  /** Beam state at the first beam level (begin/continue/end), the only one needed to recover the grouping. */
  beam1?: string;
  trem?: { role: 'start' | 'stop'; beams: number };
}

/** Display options of a tuplet that starts at a note. */
export type TupletStart = { bracket?: boolean; number?: 'none'; placement?: 'above' | 'below'; label?: number };

export const TYPE_BASE: Record<string, BaseDur> = {
  whole: 1,
  half: 2,
  quarter: 4,
  eighth: 8,
  '16th': 16,
  '32nd': 32,
  '64th': 64,
  '128th': 128,
};

export const ALL_BASES: BaseDur[] = [1, 2, 4, 8, 16, 32, 64, 128];

/** The written duration with exactly this many ticks (up to three dots), if there is one. */
export function ticksToDur(t: number): Dur | null {
  for (const base of ALL_BASES)
    for (let dots = 0; dots <= 3; dots++) if (baseTicks({ base, dots }) === t) return { base, dots };
  return null;
}
