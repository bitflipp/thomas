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
export function staffGap(ctx: SysCtx, s: number): number {
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
  for (const a of ctx.sky[s - 1].boxes) if (!a.spanner) need = Math.max(need, a.y1 - STAFF_HEIGHT + 0.7);
  for (const b of ctx.sky[s].boxes) if (!b.spanner) need = Math.max(need, -b.y0 + 0.7);
  return Math.max(3.7, need);
}

function hasCrossStaffNotes(ctx: SysCtx): boolean {
  if (ctx.gapNeed.some((g) => g > 0)) return true;
  for (let mi = ctx.a; mi <= ctx.b; mi++)
    for (const sm of ctx.prep.measures[mi])
      for (const v of sm.voices) if (v.evs.some((e) => e.staff !== e.home)) return true;
  return false;
}

/**
 * Draws the notes of a system. A cross-staff beam is drawn for a given distance between the staves,
 * and the beam itself changes what room the gap needs: iterate a few times until the gap satisfies
 * both, then pin it so later phases may widen but never shrink it.
 */
export function drawNotesFixingCrossStaffGap(ctx: SysCtx): void {
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

/** Where the notes alone end, and where the notes with their ties and slurs do. */
function markNotes(ctx: SysCtx): void {
  ctx.base = { prims: ctx.prims.map((p) => p.length), sky: ctx.sky.map((k) => k.boxes.length) };
}
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
}

const isDynamicsMark = (p: Prim) => (p.k === 'dyn' || p.k === 'hairpin') && p.a !== undefined;

/** Horizontal extent of a dynamic or hairpin primitive. */
function horizontalSpan(p: Prim): [number, number] {
  if (p.t === 'glyph') return [p.x, p.x + sm.adv(p.name)];
  if (p.t === 'line') return [Math.min(p.x1, p.x2), Math.max(p.x1, p.x2)];
  return [0, 0];
}

function moveMarks(marks: Prim[], dy: number): void {
  for (const p of marks) {
    if (p.t === 'glyph') p.y += dy;
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
    const top = p.t === 'glyph' ? p.y - sm.bbox(p.name).y1 : p.t === 'line' ? Math.min(p.y1, p.y2) - 0.3 : 0;
    for (const b of ctx.sky[s].boxes)
      if (!b.spanner && b.x1 > x0 - 0.3 && b.x0 < x1 + 0.3)
        dyMin = Math.max(dyMin, ctx.staffY[s] - ctx.staffY[s + 1] + b.y1 + 0.3 - top);
  }
  return dyMin;
}

function overlapHorizontally(rowA: Prim[], rowB: Prim[]): boolean {
  return rowA.some((a) =>
    rowB.some((b) => {
      const [a0, a1] = horizontalSpan(a);
      const [b0, b1] = horizontalSpan(b);
      return a1 > b0 - 0.5 && a0 < b1 + 0.5;
    }),
  );
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
