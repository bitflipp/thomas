// Volta brackets ("1.", "2." endings): a bracket above the first staff over the measures of one
// ending, with the pass numbers under its left end. Drawn before the other marks so that tempo and
// dynamics are stacked above it; the bracket itself sits just above the notes of its measures.

import type { SysCtx } from './draw.ts';
import { oid, tagFrom } from './scene.ts';

const HOOK = 1.7;
const LINE_W = 0.12;
const TEXT_SIZE = 1.6;

/** The label of a volta: `1.`, `1., 2.`, or a range `1.-3.` for three or more consecutive passes. */
export function voltaLabel(numbers: number[]): string {
  const consecutive = numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1);
  if (numbers.length >= 3 && consecutive) return `${numbers[0]}.–${numbers[numbers.length - 1]}.`;
  return numbers.map((n) => `${n}.`).join(', ');
}

/** Draws the volta brackets of every system, one per run of measures with the same ending. */
export function drawVoltas(systems: SysCtx[]): void {
  for (const ctx of systems) {
    const { measures } = ctx.prep.score;
    let mi = ctx.a;
    while (mi <= ctx.b) {
      const ending = measures[mi].ending;
      if (!ending) {
        mi++;
        continue;
      }
      const key = ending.join(',');
      let last = mi;
      while (last < ctx.b && measures[last + 1].ending?.join(',') === key) last++;
      const opens = mi === ctx.a ? measures[mi - 1]?.ending?.join(',') !== key : true;
      drawVolta(ctx, mi, last, ending, opens, measures[last].barline === 'repeat-end');
      mi = last + 1;
    }
  }
}

/** One bracket over measures `m0..m1` of a system; `opens` draws the left hook, `closes` the right one. */
function drawVolta(ctx: SysCtx, m0: number, m1: number, ending: number[], opens: boolean, closes: boolean): void {
  const x0 = ctx.mx[m0] + 0.3;
  const x1 = ctx.mx[m1] + ctx.placed[m1].endX - 0.3;
  const y = Math.min(-2.5 - HOOK + 1, ctx.sky[0].top(x0, x1, 0, true) - HOOK - 0.6);
  const P = ctx.prims[0];
  const n0 = P.length;
  const line = (ax: number, ay: number, bx: number, by: number) =>
    P.push({ t: 'line', x1: ax, y1: ay, x2: bx, y2: by, w: LINE_W });
  line(x0, y, x1, y);
  if (opens) line(x0, y, x0, y + HOOK);
  if (closes) line(x1, y, x1, y + HOOK);
  if (opens) P.push({ t: 'text', x: x0 + 0.5, y: y + TEXT_SIZE * 0.85, s: voltaLabel(ending), size: TEXT_SIZE });
  tagFrom(P, n0, 'volta', oid(ctx.prep.score.measures[m0]));
  ctx.sky[0].add(x0, x1, y - LINE_W, y + HOOK);
}
