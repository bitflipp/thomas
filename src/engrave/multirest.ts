// Multi-measure rests: runs of empty measures that the engraver draws as one wide measure with a bar
// and a count. Nothing changes in the model; this module finds the runs, makes the spacing of their
// measures (the first one is wide, the others have no width), and draws the bar. It sits between
// `prepare` and line breaking: `planSystems` may not cut inside a run.

import type { Score } from '../model.ts';

import type { Prepared } from './prep.ts';
import type { MeasureSpacing } from './spacing.ts';
import { COMPRESS, placeMeasure } from './spacing.ts';

/** The runs: the length of the run that starts at a measure, and the measures swallowed after the first. */
export interface MultiRuns {
  len: Map<number, number>;
  absorbed: Set<number>;
}

/** Every staff of the measure has one voice holding just a whole-measure rest, and nothing hangs on it but marks at its start. */
function isEmptyMeasure(prep: Prepared, mi: number, allowMarks: boolean): boolean {
  const m = prep.score.measures[mi];
  for (let s = 0; s < prep.score.staves.length; s++) {
    const sm = prep.measures[mi][s];
    const sv = m.staves[prep.score.staves[s].id];
    if (sv?.voices.length !== 1 || sm.voices.length !== 1 || sm.voices[0].evs.length !== 1) return false;
    const e = sm.voices[0].evs[0].ev;
    if (e.kind !== 'rest' || e.style !== 'measure' || e.staff !== undefined || e.slurStart || e.lineStart) return false;
    if (e.slurStop || e.lineStop) return false;
    if (sm.marks.some((k) => !allowMarks || k.tick > 0)) return false;
  }
  return true;
}

/** Finds the runs of two or more empty measures; a run never crosses a forced break or a key or time change. */
export function findMultiRuns(prep: Prepared, forced: Set<number>): MultiRuns {
  const n = prep.score.measures.length;
  const len = new Map<number, number>();
  const absorbed = new Set<number>();
  let mi = 0;
  while (mi < n) {
    if (!isEmptyMeasure(prep, mi, true)) {
      mi++;
      continue;
    }
    let end = mi + 1;
    while (end < n && !forced.has(end) && isFollower(prep.score, prep, end)) end++;
    if (end - mi >= 2) {
      len.set(mi, end - mi);
      for (let k = mi + 1; k < end; k++) absorbed.add(k);
    }
    mi = end;
  }
  return { len, absorbed };
}

/** Can measure `mi` be swallowed by the run before it: empty and with no key or time change, and no special barline unless it ends the run. */
function isFollower(score: Score, prep: Prepared, mi: number): boolean {
  const m = score.measures[mi];
  if (m.time || m.key !== undefined || !isEmptyMeasure(prep, mi, false)) return false;
  return true;
}

/** Whether measure `mi` has no barline of its own: it is inside a run and not its last measure. */
export function barlineHidden(prep: Prepared, mi: number): boolean {
  return !!prep.absorbed?.has(mi + 1);
}

/**
 * The spacing of the first measure of a run of `count` measures: wider than an empty measure, growing a
 * little with the count. A clef change at the end of the run needs its room here, so `endClef` is the last measure's.
 */
export function multiRestSpacing(sp: MeasureSpacing, count: number, last: MeasureSpacing): MeasureSpacing {
  const out: MeasureSpacing = { ...sp, multi: count, restOnly: true, endClef: last.endClef };
  out.minWidth = placeMeasure(out, 1).width;
  out.compWidth = placeMeasure(out, COMPRESS, 0.9).width;
  return out;
}

/** The spacing of a measure swallowed by a run: nothing. */
export function absorbedSpacing(sp: MeasureSpacing): MeasureSpacing {
  return {
    ...sp,
    cols: [],
    endIdeal: 0,
    lead: 0,
    endTrail: 0,
    endReq: sp.endReq.map(() => 0),
    endClef: sp.endClef.map(() => false),
    prefix: 0,
    timeSig: undefined,
    minWidth: 0,
    compWidth: 0,
    absorbed: true,
  };
}
