// Justification: stretches the measures of a planned system to fill the line and sets up its drawing context.

import type { SysCtx } from './draw.ts';
import { CROSS_GAP0 } from './draw.ts';
import type { SysPlan } from './linebreak.ts';
import { LAST_LINE_MIN_FILL } from './linebreak.ts';
import type { Prepared } from './prep.ts';
import { Skyline } from './scene.ts';
import { prefixWidth } from './signatures.ts';
import type { MeasureSpacing, PlacedMeasure } from './spacing.ts';
import { MIN_CLEARANCE, placeMeasure } from './spacing.ts';

export interface JustifyOptions {
  /** Justify the last system however short it is. */
  fillLast?: boolean;
  warn: (m: string) => void;
}

/** Empties everything drawn so far for a system, so that it can be drawn again (with other gaps). */
export function resetDrawing(ctx: SysCtx): void {
  const nStaves = ctx.prep.score.staves.length;
  ctx.prims = Array.from({ length: nStaves }, () => []);
  ctx.sky = Array.from({ length: nStaves }, () => new Skyline());
  ctx.gapNeed = new Array(nStaves).fill(0);
}

/** The stretch factor that makes the measures exactly fill the line (bisection); 1 for a short last line. */
function stretchFactor(widthAt: (f: number) => number, W: number, isLast: boolean, fillLast: boolean): number {
  if (isLast && widthAt(1) / W <= LAST_LINE_MIN_FILL && !fillLast) return 1;
  let lo = 0.3;
  let hi = 20;
  if (widthAt(lo) > W) return lo;
  for (let it = 0; it < 50; it++) {
    const mid = (lo + hi) / 2;
    if (widthAt(mid) > W) hi = mid;
    else lo = mid;
  }
  return isLast ? Math.min(lo, fillLast ? 4 : 1.6) : lo;
}

/** Places the measures of a planned system at the stretch factor that fills the line and returns its (still empty) drawing context. */
export function justifySystem(
  prep: Prepared,
  plan: SysPlan,
  index: number,
  spN: MeasureSpacing[],
  spF: MeasureSpacing[],
  W: number,
  opts: JustifyOptions,
): SysCtx {
  const nStaves = prep.score.staves.length;
  const prefix = prefixWidth(prep, plan.a, plan.a === 0);
  const spacing: MeasureSpacing[] = [];
  for (let mi = plan.a; mi <= plan.b; mi++) spacing[mi] = mi === plan.a ? spF[mi] : spN[mi];
  const widthAt = (f: number, z = 1) => {
    let w = prefix;
    for (let mi = plan.a; mi <= plan.b; mi++) w += placeMeasure(spacing[mi], f, z).width;
    return w;
  };
  const f = stretchFactor(widthAt, W, plan.last, opts.fillLast ?? false);
  // Too dense even at the least stretch: shrink the clearances between columns as far as needed (down to MIN_CLEARANCE).
  let z = 1;
  if (widthAt(f) > W * 1.001) {
    let lo = MIN_CLEARANCE;
    let hi = 1;
    if (widthAt(f, lo) <= W) {
      for (let it = 0; it < 40; it++) {
        const mid = (lo + hi) / 2;
        if (widthAt(f, mid) > W) hi = mid;
        else lo = mid;
      }
    }
    z = lo;
  }
  const placed: PlacedMeasure[] = [];
  const mx: number[] = [];
  let x = prefix;
  for (let mi = plan.a; mi <= plan.b; mi++) {
    const p = placeMeasure(spacing[mi], f, z);
    placed[mi] = p;
    mx[mi] = x;
    x += p.width;
  }
  if (widthAt(f, z) > W * 1.001)
    opts.warn(`system ${index + 1}: content ${widthAt(1).toFixed(1)} exceeds width ${W.toFixed(1)}`);
  return {
    prep,
    index,
    a: plan.a,
    b: plan.b,
    spacing,
    placed,
    mx,
    prefix,
    width: x,
    f,
    prims: Array.from({ length: nStaves }, () => []),
    sky: Array.from({ length: nStaves }, () => new Skyline()),
    staffY: [],
    barlines: [],
    tupletBoxes: [],
    gap: new Array(nStaves).fill(CROSS_GAP0),
    gapNeed: new Array(nStaves).fill(0),
  };
}
