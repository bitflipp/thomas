// Finalising a system once the spanners are placed: staff lines, the notes shifted onto their staves,
// clefs and signatures, measure numbers, barlines and the brace or bracket. All in system coordinates.

import type { Score, StaffGroup } from '../model.ts';

import { loadSmufl } from '../smufl.ts';
import type { SysCtx } from './draw.ts';
import { D } from './draw.ts';
import { barlineHidden } from './multirest.ts';
import type { Prim } from './scene.ts';
import { oid, tagFrom } from './scene.ts';
import { clefGlyph, drawMidSystemChanges, drawSystemStart } from './signatures.ts';
import { placeStaves, STAFF_HEIGHT } from './staffgap.ts';

const sm = loadSmufl();

export type MeasureNumbering = 'system' | 'all' | 'none';

/**
 * A finished system: its primitives and how far it reaches above its first staff and below its last.
 * `staffPrims` are the notes of each staff, still in staff-local y and to be moved down by `dy`; leaving
 * that to pagination, which moves every primitive anyway, saves a copy of each one.
 */
export interface FinalizedSystem {
  prims: Prim[];
  staffPrims: { dy: number; prims: Prim[] }[];
  top: number;
  bottom: number;
}

export function finalizeSystem(ctx: SysCtx, numbering: MeasureNumbering): FinalizedSystem {
  const { score } = ctx.prep;
  const nStaves = score.staves.length;
  placeStaves(ctx);
  const P: Prim[] = [];
  for (let s = 0; s < nStaves; s++) drawStaff(P, ctx, s);
  drawMeasureNumbers(P, ctx, numbering);
  drawBarlines(P, ctx);
  drawGroupBrackets(P, ctx);
  const extents = ctx.sky.map((k) => k.extent());
  const bottom = ctx.staffY[nStaves - 1] + STAFF_HEIGHT;
  return {
    prims: P,
    // Copies: the lists in `ctx` are rewound and refilled when the system is drawn again, but this result may be kept.
    staffPrims: ctx.prims.map((prims, s) => ({ dy: ctx.staffY[s], prims: [...prims] })),
    top: Math.min(0, ...extents.map((e, s) => ctx.staffY[s] + e.top)),
    bottom: Math.max(bottom, ...extents.map((e, s) => ctx.staffY[s] + e.bottom)),
  };
}

/** The five lines of a staff, then clef, key and time signature (its notes are added by pagination, see `FinalizedSystem`). */
function drawStaff(P: Prim[], ctx: SysCtx, s: number): void {
  const y0 = ctx.staffY[s];
  for (let l = 0; l < 5; l++)
    P.push({
      t: 'line',
      x1: 0,
      x2: ctx.width,
      y1: y0 + l,
      y2: y0 + l,
      w: D.staffLineThickness as number,
      k: 'staff',
    });
  drawSystemStart(P, ctx, s, y0);
  drawMidSystemChanges(P, ctx, s, y0);
}

const MEASURE_NUMBER_SIZE = 1.8;

/**
 * Measure numbers sit above the first staff: at the system start, or at every barline in 'all' mode.
 * They avoid whatever the skyline holds there (so are placed after the spanners).
 */
function drawMeasureNumbers(P: Prim[], ctx: SysCtx, numbering: MeasureNumbering): void {
  if (numbering === 'none') return;
  const size = MEASURE_NUMBER_SIZE;
  const measures = numbering === 'all' ? Array.from({ length: ctx.b - ctx.a + 1 }, (_, k) => ctx.a + k) : [ctx.a];
  for (const mi of measures) {
    if (mi === 0 || ctx.prep.absorbed?.has(mi)) continue;
    const label = String(mi + 1);
    const x = mi === ctx.a ? 0.2 : ctx.mx[mi] + 0.3;
    const w = label.length * size * 0.5 + 0.4;
    let y = Math.min(-0.8, ctx.sky[0].top(x, x + w, 0) - 0.5);
    if (mi === ctx.a && x + w > 0.9) {
      // The clef at the start of the system may reach above the staff and it is not in the
      // skyline, so a measure number there is lifted above it explicitly.
      const clef = clefGlyph(ctx.prep.clefAt(0, ctx.a, 0));
      y = Math.min(y, clef.y - sm.bbox(clef.name).y1 - 0.5);
    }
    P.push({ t: 'text', x, y, s: label, size, italic: true, k: 'measurenum', o: oid({}) });
    ctx.sky[0].add(x, x + w, y - size * 0.75, y + 0.2);
  }
}

/** Indices (into `score.staves`) of the staves of a group, ascending; staves that do not exist are skipped. */
function groupStaves(score: Score, g: StaffGroup): number[] {
  return g.staves
    .map((id) => score.staves.findIndex((s) => s.id === id))
    .filter((i) => i >= 0)
    .sort((x, y) => x - y);
}

/** First and last staff of each barline run: one per staff group (a braced pair shares one), one per ungrouped staff. */
function barlineRuns(score: Score): [number, number][] {
  const runs: [number, number][] = [];
  const grouped = new Set<number>();
  for (const g of score.groups) {
    const idx = groupStaves(score, g);
    if (!idx.length) continue;
    runs.push([idx[0], idx[idx.length - 1]]);
    for (const i of idx) grouped.add(i);
  }
  for (let s = 0; s < score.staves.length; s++) if (!grouped.has(s)) runs.push([s, s]);
  return runs;
}

/** One barline from y0 to y1 at x: single, double, or at the end of the piece a thin-thick final bar. */
function drawBarline(P: Prim[], ctx: SysCtx, kind: 'single' | 'double' | 'final', x: number, y0: number, y1: number) {
  const thin = D.thinBarlineThickness as number;
  const thick = D.thickBarlineThickness as number;
  const vertical = (px: number, w: number) => P.push({ t: 'line', x1: px, x2: px, y1: y0, y2: y1, w });
  if (kind === 'final') {
    const thickX = ctx.width - thick / 2;
    vertical(thickX, thick);
    vertical(thickX - thick / 2 - (D.barlineSeparation as number) - thin / 2, thin);
  } else if (kind === 'double') {
    vertical(x - 0.4, thin);
    vertical(x, thin);
  } else vertical(x, thin);
}

/** The barline at the system start and one at the end of every measure, per run of joined staves. */
function drawBarlines(P: Prim[], ctx: SysCtx): void {
  const { score } = ctx.prep;
  const runs = barlineRuns(score);
  const bottom = ctx.staffY[score.staves.length - 1] + STAFF_HEIGHT;
  P.push({
    t: 'line',
    x1: 0,
    x2: 0,
    y1: 0,
    y2: bottom,
    w: D.thinBarlineThickness as number,
    k: 'barline',
    o: oid({}),
  });
  for (let mi = ctx.a; mi <= ctx.b; mi++) {
    if (barlineHidden(ctx.prep, mi)) continue;
    const x = ctx.mx[mi] + ctx.placed[mi].endX;
    const declared = score.measures[mi].barline ?? 'single';
    const endOfPiece = mi === ctx.b && mi === score.measures.length - 1;
    const kind = declared === 'final' || endOfPiece ? 'final' : declared;
    for (const [first, last] of runs) {
      const start = P.length;
      drawBarline(P, ctx, kind, x, ctx.staffY[first], ctx.staffY[last] + STAFF_HEIGHT);
      tagFrom(P, start, 'barline', oid({}));
    }
  }
}

/**
 * Brace or bracket for each staff group. A brace glyph is scaled to the height of its staves, with
 * its width following in proportion up to a maximum; a bracket is a plain thick line.
 */
function drawGroupBrackets(P: Prim[], ctx: SysCtx): void {
  const { score } = ctx.prep;
  for (const g of score.groups) {
    const idx = groupStaves(score, g);
    if (!idx.length) continue;
    const y0 = ctx.staffY[idx[0]];
    const y1 = ctx.staffY[idx[idx.length - 1]] + STAFF_HEIGHT;
    if (g.kind !== 'brace') {
      const w = D.bracketThickness as number;
      P.push({ t: 'line', x1: -0.8, x2: -0.8, y1: y0 - 0.2, y2: y1 + 0.2, w, k: 'brace', o: oid({}) });
      continue;
    }
    const b = sm.bbox('brace');
    const sy = (y1 - y0) / (b.y1 - b.y0);
    const sx = Math.min(3.2, 0.75 * sy);
    // The glyph origin is at the bottom of the brace in SMuFL, with the outline extending upwards:
    // place it so that its top edge matches the top of the first staff.
    P.push({ t: 'glyph', name: 'brace', x: -0.35 - b.x1 * sx, y: y1 + b.y0 * sy, sx, sy, k: 'brace', o: oid({}) });
  }
}
