// The vertical distance between the staves of a system: how much room the content of both needs,
// cross-staff beams that fix it early, and the alignment of dynamics that sit in the gap.

import { loadSmufl } from '../smufl.ts';

import { must } from '../util.ts';
import type { SysCtx } from './draw.ts';
import { drawSystemNotes } from './draw.ts';
import { resetDrawing } from './justify.ts';
import type { Prim } from './scene.ts';
import { drawStaffMarks, planSpanners } from './spanners.ts';

const sm = loadSmufl();

/** Staff height in staff spaces (the distance between the top and bottom line). */
export const STAFF_HEIGHT = 4;

/** Distance between the bottom line of staff s-1 and the top line of staff s that the content of both requires. */
function staffGap(ctx: SysCtx, s: number): number {
  // First the gap that the pairwise overlap in x requires: a tall slur in one staff only matters
  // where the other staff has content below it.
  let need = 0;
  for (const a of ctx.sky[s - 1].boxes)
    for (const b of ctx.sky[s].boxes) {
      if (a.spanner && b.spanner) continue;
      if (a.x1 > b.x0 && a.x0 < b.x1) need = Math.max(need, a.y1 - STAFF_HEIGHT - b.y0 + 1.0);
    }
  // Then clear of both staves' lines, whether or not anything overlaps in x: content hanging
  // below the upper staff or above the lower one needs room of its own, and 3.7 is the minimum.
  // A tie or slur may not reach into the other staff's lines either, but needs less room than other content.
  for (const a of ctx.sky[s - 1].boxes) need = Math.max(need, a.y1 - STAFF_HEIGHT + (a.spanner ? 0.4 : 0.7));
  for (const b of ctx.sky[s].boxes) need = Math.max(need, -b.y0 + (b.spanner ? 0.4 : 0.7));
  return Math.max(3.7, need);
}

/**
 * Whether the system needs its staff distances fixed before the notes are final: cross-staff notes or beams, or a
 * line between staves.
 */
function hasCrossStaffNotes(ctx: SysCtx): boolean {
  if (ctx.gapNeed.some((g) => g > 0)) return true;
  for (let mi = ctx.a; mi <= ctx.b; mi++)
    // A line between staves is drawn at the final distance, so the distance is fixed first.
    for (const sm of ctx.prep.measures[mi])
      for (const v of sm.voices)
        if (v.evs.some((e) => e.staff !== e.home || e.ev.lineStart || e.ev.lineStop)) return true;
  return false;
}

/**
 * Draws the notes of a system. A cross-staff beam is drawn for a given distance between the staves,
 * and the beam itself changes what room the gap needs: iterate a few times until the gap satisfies
 * both, then pin it so later phases may widen but never shrink it.
 */
function drawNotesFixingCrossStaffGap(ctx: SysCtx): void {
  drawFixingGap(ctx);
  markNotes(ctx);
}

/** Empties a system of everything added after its notes (spanners, marks) so that those can be drawn again. */
export function rewindToNotes(ctx: SysCtx): void {
  const base = must(ctx.base);
  ctx.prims.forEach((p, s) => {
    p.length = base.prims[s];
  });
  ctx.sky.forEach((k, s) => {
    k.boxes.length = base.sky[s];
  });
}

/**
 * The iteration behind `drawNotesFixingCrossStaffGap`: draws the notes and, with cross-staff notes, draws them
 * again until the staff distance they need has settled, then pins the distances.
 */
function drawFixingGap(ctx: SysCtx): void {
  const nStaves = ctx.prep.score.staves.length;
  drawSystemNotes(ctx);
  if (!hasCrossStaffNotes(ctx)) return;
  for (let it = 0; it < 4; it++) {
    let changed = false;
    for (let s = 1; s < nStaves; s++) {
      const want = Math.max(staffGap(ctx, s), ctx.gapNeed[s] + 0.3);
      if (Math.abs(want - ctx.gap[s]) > 0.01) {
        ctx.gap[s] = want;
        changed = true;
      }
    }
    if (!changed) break;
    resetDrawing(ctx);
    drawSystemNotes(ctx);
  }
  ctx.pinned = true;
}

/**
 * Records where the notes alone end, so that ties, slurs and marks drawn after can be removed again
 * (`rewindToNotes`).
 */
function markNotes(ctx: SysCtx): void {
  ctx.base = { prims: ctx.prims.map((p) => p.length), sky: ctx.sky.map((k) => k.boxes.length) };
}

/** Records where the notes with their ties and slurs end, so that the marks drawn after can be removed again. */
function markSpanners(ctx: SysCtx): void {
  ctx.ts = { prims: ctx.prims.map((p) => p.length), sky: ctx.sky.map((k) => k.boxes.length) };
}

/** Removes the marks of a system (what came after its ties and slurs) so that they can be drawn again. */
function rewindToSpanners(ctx: SysCtx): void {
  const ts = must(ctx.ts);
  ctx.prims.forEach((p, s) => {
    p.length = ts.prims[s];
  });
  ctx.sky.forEach((k, s) => {
    k.boxes.length = ts.sky[s];
  });
}

/**
 * Draws the ties and slurs that `dirty` systems (whose notes were just drawn) and changes since the last drawing make
 * necessary, then all marks. A system that is not affected (see `planSpanners`) still holds its notes with their ties
 * and slurs from before; only its marks, which come last, are taken off to be drawn again.
 */
function drawSpannersFor(systems: SysCtx[], dirty: Set<number>): void {
  const plan = planSpanners(
    systems,
    dirty,
    systems.map((ctx) => ctx.spanSig),
  );
  systems.forEach((ctx, i) => {
    if (dirty.has(i)) return;
    if (plan.affected.has(i)) rewindToNotes(ctx);
    else rewindToSpanners(ctx);
  });
  plan.draw();
  systems.forEach((ctx, i) => {
    if (!plan.affected.has(i)) return;
    markSpanners(ctx);
    ctx.spanSig = plan.sigs[i];
  });
  drawStaffMarks(systems);
}

/**
 * Slurs and marks may need more room between the staves of a system whose gap was pinned for its
 * cross-staff beams: widen it and draw it again (notes, then the ties and slurs connected to it, then all marks).
 */
function widenPinnedGaps(systems: SysCtx[]): void {
  for (let it = 0; it < 4; it++) {
    const changed = new Set<number>();
    systems.forEach((ctx, i) => {
      if (!ctx.pinned) return;
      for (let s = 1; s < ctx.prep.score.staves.length; s++) {
        const want = staffGap(ctx, s);
        if (want > ctx.gap[s] + 0.01) {
          ctx.gap[s] = want;
          changed.add(i);
        }
      }
    });
    if (!changed.size) break;
    for (const i of changed) {
      const ctx = systems[i];
      ctx.widened = true;
      resetDrawing(ctx);
      drawSystemNotes(ctx);
      markNotes(ctx);
    }
    drawSpannersFor(systems, changed);
  }
}

/** Sets `staffY` from the gaps (pinned ones as they are, the others from the content), then aligns the dynamics in the gaps. */
export function placeStaves(ctx: SysCtx): void {
  const nStaves = ctx.prep.score.staves.length;
  ctx.staffY = [0];
  for (let s = 1; s < nStaves; s++) {
    const gap = ctx.pinned ? ctx.gap[s] : staffGap(ctx, s);
    ctx.staffY[s] = ctx.staffY[s - 1] + STAFF_HEIGHT + gap;
  }
  for (let s = 0; s + 1 < nStaves; s++) alignDynamicsBetween(ctx, s);
  for (let s = 0; s + 1 < nStaves; s++) centerBetweenMarks(ctx, s);
}

/** Whether a primitive belongs to a mark that sits between the staves. */
const isBetweenMark = (p: Prim) => (p.r as { placement?: string } | undefined)?.placement === 'between';

/** Whether a primitive is a dynamic or hairpin that is not placed between the staves. */
const isDynamicsMark = (p: Prim) => (p.k === 'dyn' || p.k === 'hairpin') && p.a !== undefined && !isBetweenMark(p);

/** Horizontal extent of a dynamic or hairpin primitive. */
function horizontalSpan(p: Prim): [number, number] {
  if (p.t === 'glyph') return [p.x, p.x + sm.adv(p.name)];
  if (p.t === 'line') return [Math.min(p.x1, p.x2), Math.max(p.x1, p.x2)];
  if (p.t === 'text') return [p.x, p.x + p.s.length * p.size * 0.5];
  return [0, 0];
}

/** Moves the marks' primitives down by `dy`. */
function moveMarks(marks: Prim[], dy: number): void {
  for (const p of marks) {
    if (p.t === 'glyph' || p.t === 'text') p.y += dy;
    else if (p.t === 'line') {
      p.y1 += dy;
      p.y2 += dy;
    }
    p.a = must(p.a) + dy;
  }
}

/** The lowest move (most negative dy) of the lower staff's marks that keeps them out of the upper staff's own content. */
function lowestRiseAboveUpperStaff(ctx: SysCtx, s: number, marks: Prim[]): number {
  let dyMin = Number.NEGATIVE_INFINITY;
  for (const p of marks) {
    const [x0, x1] = horizontalSpan(p);
    const top =
      p.t === 'glyph'
        ? p.y - sm.bbox(p.name).y1
        : p.t === 'line'
          ? Math.min(p.y1, p.y2) - 0.3
          : p.t === 'text'
            ? p.y - 1.5
            : 0;
    for (const b of ctx.sky[s].boxes)
      if (!b.spanner && b.x1 > x0 - 0.3 && b.x0 < x1 + 0.3)
        dyMin = Math.max(dyMin, ctx.staffY[s] - ctx.staffY[s + 1] + b.y1 + 0.3 - top);
  }
  return dyMin;
}

/** Whether any primitive of `rowA` shares horizontal extent with one of `rowB`. */
function overlapHorizontally(rowA: Prim[], rowB: Prim[]): boolean {
  return rowA.some((a) =>
    rowB.some((b) => {
      const [a0, a1] = horizontalSpan(a);
      const [b0, b1] = horizontalSpan(b);
      return a1 > b0 - 0.5 && a0 < b1 + 0.5;
    }),
  );
}

/** Vertical extent of a primitive of a dynamic or hairpin. */
function verticalSpan(p: Prim): [number, number] {
  if (p.t === 'glyph') return [p.y - sm.bbox(p.name).y1, p.y - sm.bbox(p.name).y0];
  if (p.t === 'line') return [Math.min(p.y1, p.y2) - p.w / 2, Math.max(p.y1, p.y2) + p.w / 2];
  if (p.t === 'text') return [p.y - 1.5, p.y + 0.5];
  return [0, 0];
}

interface CenterPlan {
  marks: Prim[];
  /** The range of moves that keep the marks clear of the content, and the move that centers them. */
  dyMin: number;
  dyMax: number;
  dy: number;
  /** Vertical middle of the marks' ink before the move. */
  mid: number;
}

/**
 * Dynamics and hairpins placed `between` the staves sit below the upper staff or above the lower one (`marks`, of staff
 * `owner`) as far as the content there allows; this moves them to the vertical middle of the free space of the gap
 * between staff s and s+1. Content in the way of the move (what hangs into the gap, other marks of the staves)
 * limits it; a mark with content on both sides is left alone.
 */
function planCenter(
  ctx: SysCtx,
  s: number,
  owner: number,
  first: Prim[],
  sameSide: (p: Prim) => boolean,
): CenterPlan | undefined {
  if (!first.length) return;
  const marks = [...first, ...attachedMarks(ctx, owner, first, sameSide)]; // The attached marks move along, so they are limited by the content too.
  const moving = new Set(marks.map((p) => p.o));
  let x0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const p of marks) {
    const [a, b] = horizontalSpan(p);
    const [t, u] = verticalSpan(p);
    x0 = Math.min(x0, a);
    x1 = Math.max(x1, b);
    top = Math.min(top, ctx.staffY[owner] + t);
    bottom = Math.max(bottom, ctx.staffY[owner] + u);
  }
  let lo = ctx.staffY[s] + STAFF_HEIGHT; // This is the free space of the gap, from the upper staff's bottom line to the lower staff's top line.
  let hi = ctx.staffY[s + 1];
  for (const k of [s, s + 1])
    for (const b of ctx.sky[k].boxes) {
      if (
        b.btw ||
        (b.o !== undefined && moving.has(b.o)) ||
        (b.spanner && k !== owner) ||
        !(b.x1 > x0 - 0.3 && b.x0 < x1 + 0.3)
      )
        continue;
      // A slur's box is as deep as its middle; its ends are thin, so only the middle half blocks.
      if (b.spanner) {
        const w = b.x1 - b.x0;
        if (!(b.x1 - w / 4 > x0 - 0.3 && b.x0 + w / 4 < x1 + 0.3)) continue;
      }
      const by0 = ctx.staffY[k] + b.y0;
      const by1 = ctx.staffY[k] + b.y1;
      if (by1 <= top + 0.01) lo = Math.max(lo, by1);
      else if (by0 >= bottom - 0.01) hi = Math.min(hi, by0);
      else if (by1 > lo && by0 < hi) return; // A mark that overlaps the mark itself is left where it is.
    }
  const clearance = 0.3;
  const dyMin = lo + clearance - top;
  const dyMax = hi - clearance - bottom;
  if (dyMin > dyMax) return;
  const dy = Math.min(dyMax, Math.max(dyMin, (lo + hi) / 2 - (top + bottom) / 2));
  return { marks, dyMin, dyMax, dy, mid: (top + bottom) / 2 };
}

/** Horizontal distance up to which a plain dynamic or hairpin counts as continuing a `between` mark. */
const ATTACH_DIST = 10;

/** The dynamics and hairpins of `owner` on the same side that are not `between` but chain up to `marks` (a hairpin ending at a dynamic): they follow it so that the row stays one line. */
function attachedMarks(ctx: SysCtx, owner: number, marks: Prim[], sameSide: (p: Prim) => boolean): Prim[] {
  const rest = ctx.prims[owner].filter((p) => isDynamicsMark(p) && sameSide(p));
  const taken: Prim[] = [];
  const spans = marks.map(horizontalSpan);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of rest) {
      if (taken.includes(p)) continue;
      const [a, b] = horizontalSpan(p);
      if (!spans.some(([c, d]) => b > c - ATTACH_DIST && a < d + ATTACH_DIST)) continue;
      taken.push(p);
      spans.push([a, b]);
      grew = true;
    }
  }
  return taken;
}

/**
 * Centers the `between` dynamics and hairpins of staves `s` and `s+1` in the free space of the gap; two rows that
 * both fit share one line.
 */
function centerBetweenMarks(ctx: SysCtx, s: number): void {
  const plans = [
    planCenter(
      ctx,
      s,
      s,
      ctx.prims[s].filter((p) => isBetweenMark(p) && must(p.a) > STAFF_HEIGHT),
      (p) => must(p.a) > STAFF_HEIGHT,
    ),
    planCenter(
      ctx,
      s,
      s + 1,
      ctx.prims[s + 1].filter((p) => isBetweenMark(p) && must(p.a) < 0),
      (p) => must(p.a) < 0,
    ),
  ].filter((p) => p !== undefined);
  // Both rows sit on one line when the content allows it: the line nearest to where each would be centered alone.
  if (plans.length === 2) {
    const [a, b] = plans;
    const lo = Math.max(a.mid + a.dyMin, b.mid + b.dyMin);
    const hi = Math.min(a.mid + a.dyMax, b.mid + b.dyMax);
    if (lo <= hi) {
      const line = Math.min(hi, Math.max(lo, (a.mid + a.dy + b.mid + b.dy) / 2));
      a.dy = line - a.mid;
      b.dy = line - b.mid;
    }
  }
  for (const p of plans) if (Math.abs(p.dy) > 0.001) moveMarks(p.marks, p.dy);
}

/**
 * Dynamics and hairpins below a staff and above the next one share the gap between the two staves. Where both occur,
 * the upper-staff row is the reference and the lower staff's row moves up to its (absolute) baseline, so that they
 * read as one line — unless that would put them on top of each other horizontally.
 */
function alignDynamicsBetween(ctx: SysCtx, s: number): void {
  const below = ctx.prims[s].filter((p) => isDynamicsMark(p) && must(p.a) > STAFF_HEIGHT);
  const above = ctx.prims[s + 1].filter((p) => isDynamicsMark(p) && must(p.a) < 0);
  if (!(below.length && above.length)) return;
  const dy = ctx.staffY[s] + must(below[0].a) - (ctx.staffY[s + 1] + must(above[0].a));
  // Only ever move up, away from the lower staff: dy < 0 means the lower staff's row sits below
  // the upper staff's row and has to rise to its baseline...
  if (dy >= 0) return;
  // ... but never into the upper staff's own content (notes standing below it, ledger lines, ...).
  const dyAdj = Math.min(0, Math.max(dy, lowestRiseAboveUpperStaff(ctx, s, above)));
  if (overlapHorizontally(above, below)) return;
  if (dyAdj < 0) moveMarks(above, dyAdj);
  // The lower marks could not rise all the way (content of the upper staff hangs into the gap): the upper staff's marks
  // sink to the same row instead, so that dynamics and hairpins of the two staves still read as one line.
  const deficit = dyAdj - dy;
  if (deficit > 0.01) moveMarks(below, deficit);
}

/**
 * Draws the notes of the systems that need it, then the spanners, then widens gaps the spanners need. The systems
 * in `kept` were drawn by an earlier run and their notes are still good (`drawSpannersFor` sees what else needs doing).
 */
export function drawNotesAndSpanners(systems: SysCtx[], kept?: Set<SysCtx>): void {
  const dirty = new Set<number>();
  systems.forEach((ctx, i) => {
    if (kept?.has(ctx)) return;
    drawNotesFixingCrossStaffGap(ctx);
    dirty.add(i);
  });
  drawSpannersFor(systems, dirty);
  widenPinnedGaps(systems);
}
