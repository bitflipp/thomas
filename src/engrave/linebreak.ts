// Line breaking: which measures make up each system.

import type { Prepared } from './prep.ts';

import { prefixWidth } from './signatures.ts';
import type { MeasureSpacing } from './spacing.ts';

/** The measures a..b (inclusive) that make up one system. */
export interface SysPlan {
  a: number;
  b: number;
  last: boolean;
}

/** At most this many measures are tried per line. */
const MAX_MEASURES_PER_LINE = 14;

/** The last line of the piece is not stretched at all when it is less full than this. */
export const LAST_LINE_MIN_FILL = 0.55;

const COST_PER_SYSTEM = 3;

/**
 * The cost of a line whose natural width is `nat` (`cmp` when squeezed as far as allowed) in a line of
 * width `W`: a quadratic penalty for slack, a larger one for having to squeeze, a very large one for
 * not fitting at all, plus a constant so that fewer lines are preferred.
 */
function lineCost(nat: number, cmp: number, W: number, isLastLineOfPiece: boolean): number {
  let cost: number;
  if (cmp > W) cost = 200 + (cmp - W) * 10;
  else if (nat > W) {
    const squeeze = (nat - W) / Math.max(0.01, nat - cmp);
    cost = 10 * squeeze * squeeze;
  } else if (isLastLineOfPiece) cost = nat / W > LAST_LINE_MIN_FILL ? 2 * (1 - nat / W) ** 2 * 100 : 0;
  else cost = ((W - nat) / W) ** 2 * 160;
  return cost + COST_PER_SYSTEM;
}

/**
 * The cheapest line breaks within a segment of `len` measures, as the exclusive end index of every line (`noCut(i)`: no line may end before measure i).
 * `width(j, i, compressed)` is the width of the measures j..i-1 of the segment.
 */
function cheapestCuts(
  len: number,
  isFinalSegment: boolean,
  width: (j: number, i: number, compressed: boolean) => number,
  W: number,
  noCut: (i: number) => boolean,
): number[] {
  const best: number[] = new Array(len + 1).fill(Number.POSITIVE_INFINITY);
  const from: number[] = new Array(len + 1).fill(-1);
  best[0] = 0;
  for (let i = 1; i <= len; i++) {
    if (i < len && noCut(i)) continue; // A line may not end inside a multi-measure rest.
    for (let j = Math.max(0, i - MAX_MEASURES_PER_LINE); j < i; j++) {
      if (best[j] === Number.POSITIVE_INFINITY) continue;
      const nat = width(j, i, false);
      const cmp = width(j, i, true);
      const single = i - j === 1;
      if (cmp > W && !single) continue;
      const total = best[j] + lineCost(nat, cmp, W, isFinalSegment && i === len);
      if (total < best[i]) {
        best[i] = total;
        from[i] = j;
      }
    }
  }
  const cuts: number[] = [];
  for (let i = len; i > 0; i = from[i]) cuts.push(i);
  return cuts.reverse();
}

/**
 * Chooses the line breaks by dynamic programming over the measures (see `lineCost` for what makes a
 * line good). Forced breaks split the piece into independent segments first. The first measure of a
 * system uses its "first in system" spacing `spF`, the others `spN`. `firstIndent` is how much narrower
 * the first system is than the others (the room of its staff labels).
 */
export function planSystems(
  prep: Prepared,
  spN: MeasureSpacing[],
  spF: MeasureSpacing[],
  W: number,
  forced: Set<number>,
  firstIndent = 0,
): SysPlan[] {
  const n = spN.length;
  // Width of measures a..b as the first of a system is a's own variant, the rest the normal ones: prefix sums make a range O(1).
  const prefixOf = Array.from({ length: n }, (_, a) => prefixWidth(prep, a, a === 0) + (a === 0 ? firstIndent : 0));
  const sums = (pick: (sp: MeasureSpacing) => number): number[] => {
    const out = [0];
    for (let k = 0; k < n; k++) out.push(out[k] + pick(spN[k]));
    return out;
  };
  const sumMin = sums((sp) => sp.minWidth);
  const sumComp = sums((sp) => sp.compWidth);
  const rangeWidth = (a: number, b: number, compressed: boolean) => {
    const sum = compressed ? sumComp : sumMin;
    const first = compressed ? spF[a].compWidth : spF[a].minWidth;
    return prefixOf[a] + first + sum[b + 1] - sum[a + 1];
  };
  const plans: SysPlan[] = [];
  const starts = [0, ...[...forced].filter((i) => i > 0).sort((x, y) => x - y)];
  starts.forEach((segStart, si) => {
    const segEnd = (si + 1 < starts.length ? starts[si + 1] : n) - 1;
    const cuts = cheapestCuts(
      segEnd - segStart + 1,
      segEnd === n - 1,
      (j, i, compressed) => rangeWidth(segStart + j, segStart + i - 1, compressed),
      W,
      (i) => !!prep.absorbed?.has(segStart + i),
    );
    let prev = 0;
    for (const c of cuts) {
      plans.push({ a: segStart + prev, b: segStart + c - 1, last: false });
      prev = c;
    }
  });
  plans[plans.length - 1].last = true;
  return plans;
}
