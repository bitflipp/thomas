// Editing the performance of a score (`Score.performance`: the tempo ratio curve, the sustain pedal and the una corda
// regions). Pure `Score -> Score` functions like the commands in commands.ts, but in terms of absolute ticks, which is
// what a lane in the Expression pane shows; the model itself anchors every point by measure and tick (`Pos`), so that it
// follows the music when measures are inserted or deleted (`moveAnchorsOnInsert`, `moveAnchorsOnDelete`, used by those
// two commands) and stays valid when a time signature change shortens a measure (`fitPerformance`, run after every edit).

import type { Draft } from 'immer';
import { produce } from 'immer';
import type { CurvePoint, Performance, Pos, Score, SoftRegion } from '../model.ts';
import { measureTicks, timeAt } from '../model.ts';
import { measureStarts } from '../playback/sequence.ts';
import { EditError } from './voice.ts';

/** The curves that are lists of points. */
export type CurveName = 'tempo' | 'sustain';

/** The range of the values of each curve (the model's own limits). */
const CURVE_RANGE: Record<CurveName, [number, number]> = { tempo: [0.1, 10], sustain: [0, 1] };

/** The absolute tick of a position of the score. */
function absTick(starts: number[], total: number, pos: Pos): number {
  return pos.mi < starts.length ? starts[pos.mi] + pos.tick : total;
}

/** The position of an absolute tick: its measure and the tick within it (the end of the last measure for a tick past the piece). */
function posAt(score: Score, starts: number[], total: number, abs: number): Pos {
  const tick = Math.max(0, Math.min(total, Math.round(abs)));
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= tick) lo = mid;
    else hi = mid - 1;
  }
  if (tick >= total) return { mi: lo, tick: measureTicks(timeAt(score, lo)) };
  return { mi: lo, tick: tick - starts[lo] };
}

/** The points of a curve with their absolute ticks. */
export function curveTicks(score: Score, name: CurveName): { tick: number; value: number }[] {
  const pts = score.performance?.[name];
  if (!pts?.length) return [];
  const { measureStart, total } = measureStarts(score);
  return pts.map((p) => ({ tick: absTick(measureStart, total, p.pos), value: p.value }));
}

/** The soft pedal regions as absolute ticks. */
export function softTicks(score: Score): { from: number; to: number }[] {
  const regions = score.performance?.soft;
  if (!regions?.length) return [];
  const { measureStart, total } = measureStarts(score);
  return regions.map((r) => ({ from: absTick(measureStart, total, r.from), to: absTick(measureStart, total, r.to) }));
}

/** Whether `a` comes before `b`. */
const before = (a: Pos, b: Pos) => a.mi < b.mi || (a.mi === b.mi && a.tick < b.tick);

/** Whether two positions are the same. */
const samePos = (a: Pos, b: Pos) => a.mi === b.mi && a.tick === b.tick;

/** Removes what the performance does not hold (empty lists, an empty performance), so that a score without any has none. */
function canonical(perf: Draft<Performance>): void {
  if (!perf.tempo?.length) delete perf.tempo;
  if (!perf.sustain?.length) delete perf.sustain;
  if (!perf.soft?.length) delete perf.soft;
}

/** Applies `fn` to the performance of a draft (created if it has none) and leaves it canonical. */
function editPerformance(d: Draft<Score>, fn: (perf: Draft<Performance>) => void): void {
  d.performance ??= {};
  fn(d.performance);
  canonical(d.performance);
  if (!Object.keys(d.performance).length) delete d.performance;
}

/** Runs `fn` on the performance of `score` and returns the edited score (the same one when nothing changed). */
function edit(score: Score, fn: (perf: Draft<Performance>, score: Score) => void): Score {
  return fitPerformance(produce(score, (d) => editPerformance(d, (perf) => fn(perf, score))));
}

/** Rounds a curve value to what the lane can show (and the text format keeps short) and clamps it to the curve's range. */
export function curveValue(name: CurveName, v: number): number {
  const [lo, hi] = CURVE_RANGE[name];
  return Math.max(lo, Math.min(hi, Math.round(v * 1000) / 1000));
}

/** Sets the value of a curve at an absolute tick: a point already there changes, else one is added. */
export function setCurvePoint(score: Score, name: CurveName, tick: number, value: number): Score {
  const { measureStart, total } = measureStarts(score);
  const pos = posAt(score, measureStart, total, tick);
  return edit(score, (perf) => {
    perf[name] ??= [];
    const pts = perf[name] as Draft<CurvePoint>[];
    const same = pts.findIndex((p) => samePos(p.pos, pos));
    const point = { pos, value: curveValue(name, value) };
    if (same >= 0) pts[same] = point;
    else {
      let i = pts.findIndex((p) => before(pos, p.pos));
      if (i < 0) i = pts.length;
      pts.splice(i, 0, point);
    }
  });
}

/** Moves point `index` of a curve to a tick and a value; the order of the points is kept by stopping at the neighbors. */
export function moveCurvePoint(score: Score, name: CurveName, index: number, tick: number, value: number): Score {
  const pts = score.performance?.[name];
  if (!pts?.[index]) throw new EditError('No such point');
  const { measureStart, total } = measureStarts(score);
  const lo = index > 0 ? absTick(measureStart, total, pts[index - 1].pos) + 1 : 0;
  const hi = index < pts.length - 1 ? absTick(measureStart, total, pts[index + 1].pos) - 1 : total;
  const pos = posAt(score, measureStart, total, Math.max(lo, Math.min(hi, tick)));
  return edit(score, (perf) => {
    (perf[name] as Draft<CurvePoint>[])[index] = { pos, value: curveValue(name, value) };
  });
}

/** Removes points `indices` of a curve. */
export function removeCurvePoints(score: Score, name: CurveName, indices: number[]): Score {
  return edit(score, (perf) => {
    const gone = new Set(indices);
    perf[name] = (perf[name] ?? []).filter((_, i) => !gone.has(i));
  });
}

/** Removes the whole curve or all una corda regions. */
export function clearCurve(score: Score, name: CurveName | 'soft'): Score {
  return edit(score, (perf) => {
    delete perf[name];
  });
}

/**
 * Merges regions that overlap or touch into one (one pair of controller changes per held passage) and drops empty ones;
 * the result is in order.
 */
function mergedRegions(regions: SoftRegion[]): SoftRegion[] {
  const sorted = regions.filter((r) => before(r.from, r.to)).sort((a, b) => (before(a.from, b.from) ? -1 : 1));
  const out: SoftRegion[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && !before(last.to, r.from)) {
      if (before(last.to, r.to)) last.to = r.to;
    } else out.push({ from: { ...r.from }, to: { ...r.to } });
  }
  return out;
}

/** Puts the una corda pedal down from `from` to `to` (absolute ticks, in either order); it merges with regions it touches. */
export function addSoftRegion(score: Score, from: number, to: number): Score {
  const { measureStart, total } = measureStarts(score);
  const a = posAt(score, measureStart, total, Math.min(from, to));
  const b = posAt(score, measureStart, total, Math.max(from, to));
  if (!before(a, b)) throw new EditError('The region is empty');
  return edit(score, (perf) => {
    perf.soft = mergedRegions([...(perf.soft ?? []), { from: a, to: b }]);
  });
}

/** Replaces region `index` by the span from `from` to `to` (absolute ticks); it merges with the regions it now touches. */
export function setSoftRegion(score: Score, index: number, from: number, to: number): Score {
  const regions = score.performance?.soft;
  if (!regions?.[index]) throw new EditError('No such region');
  const { measureStart, total } = measureStarts(score);
  const a = posAt(score, measureStart, total, Math.min(from, to));
  const b = posAt(score, measureStart, total, Math.max(from, to));
  if (!before(a, b)) throw new EditError('The region is empty');
  return edit(score, (perf) => {
    perf.soft = mergedRegions([...(perf.soft ?? []).filter((_, i) => i !== index), { from: a, to: b }]);
  });
}

/** Removes the una corda regions `indices`. */
export function removeSoftRegions(score: Score, indices: number[]): Score {
  return edit(score, (perf) => {
    const gone = new Set(indices);
    perf.soft = (perf.soft ?? []).filter((_, i) => !gone.has(i));
  });
}

/**
 * Makes every position of the performance valid again after an edit that changed the measures: points in measures that
 * are gone are dropped, a tick past the end of a (now shorter) measure moves to its end, points that no longer follow
 * each other are dropped, and regions that became empty go. Returns the same score if nothing needed fixing.
 */
export function fitPerformance(score: Score): Score {
  const perf = score.performance;
  if (!perf) return score;
  const n = score.measures.length;
  const lens = new Map<number, number>();
  const len = (mi: number) => {
    const l = lens.get(mi) ?? measureTicks(timeAt(score, mi));
    lens.set(mi, l);
    return l;
  };
  const fix = (p: Pos): Pos | undefined =>
    p.mi >= n ? undefined : p.tick > len(p.mi) ? { mi: p.mi, tick: len(p.mi) } : p;
  const curve = (pts: CurvePoint[] | undefined) => {
    const out: CurvePoint[] = [];
    for (const pt of pts ?? []) {
      const pos = fix(pt.pos);
      if (pos && (!out.length || before(out[out.length - 1].pos, pos))) out.push(pos === pt.pos ? pt : { ...pt, pos });
    }
    return out;
  };
  const regions = mergedRegions(
    (perf.soft ?? []).flatMap((r) => {
      const from = fix(r.from);
      const to = fix(r.to);
      return from && to ? [{ from, to }] : from ? [{ from, to: { mi: n - 1, tick: len(n - 1) } }] : [];
    }),
  );
  const next: Performance = {};
  for (const name of ['tempo', 'sustain'] as const) {
    const pts = curve(perf[name]);
    if (pts.length) next[name] = pts;
  }
  if (regions.length) next.soft = regions;
  if (JSON.stringify(next) === JSON.stringify(perf)) return score;
  return produce(score, (d) => {
    if (Object.keys(next).length) d.performance = next as Draft<Performance>;
    else delete d.performance;
  });
}

/** Shifts the anchors of the performance of a draft for `count` measures inserted before measure `at`. */
export function moveAnchorsOnInsert(d: Draft<Score>, at: number, count: number): void {
  const perf = d.performance;
  if (!perf) return;
  const move = (p: Draft<Pos>) => {
    // A point at the very end of the measure before the insertion stays with it; one at the start of `at` moves.
    if (p.mi >= at) p.mi += count;
  };
  for (const name of ['tempo', 'sustain'] as const) for (const pt of perf[name] ?? []) move(pt.pos);
  for (const r of perf.soft ?? []) {
    move(r.from);
    move(r.to);
  }
}

/**
 * Moves the anchors of the performance of a draft for measures `from` to `to` (inclusive) having been removed: points in
 * them go, later ones move up, and a region that reached into them is cut at the place where they were.
 */
export function moveAnchorsOnDelete(d: Draft<Score>, from: number, to: number): void {
  const perf = d.performance;
  if (!perf) return;
  const count = to - from + 1;
  const gone = (p: Pos) => p.mi >= from && p.mi <= to;
  const move = (p: Draft<Pos>) => {
    if (p.mi > to) p.mi -= count;
  };
  for (const name of ['tempo', 'sustain'] as const) {
    perf[name] = (perf[name] ?? []).filter((pt) => !gone(pt.pos));
    for (const pt of perf[name] ?? []) move(pt.pos);
  }
  perf.soft = (perf.soft ?? []).flatMap((r) => {
    const a = gone(r.from) ? { mi: from, tick: 0 } : { ...r.from };
    const b = gone(r.to) ? { mi: from, tick: 0 } : { ...r.to };
    move(a);
    move(b);
    return samePos(a, b) ? [] : [{ from: a, to: b }];
  });
  canonical(perf);
  if (!Object.keys(perf).length) delete d.performance;
}
