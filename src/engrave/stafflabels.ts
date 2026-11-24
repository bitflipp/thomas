// Staff labels: the instrument names printed left of the first staves of a system, in full before the
// first system (which is indented to make room) and abbreviated before the others. The room they take
// is part of the page layout (`leftRooms`, used by `engrave`); `drawStaffLabels` draws them when a
// system is finalized, after the staff distances are known.

import type { PageSetup, Score, StaffDef } from '../model.ts';
import { groupStaffIndices } from '../model.ts';

import type { SysCtx } from './draw.ts';
import type { Prim } from './scene.ts';
import { oid } from './scene.ts';
import { STAFF_HEIGHT } from './staffgap.ts';
import { textWidth } from './textmetrics.ts';

/** Width of the brace area left of the systems, with and without a braced staff group. */
const BRACE_ROOM = 2.4;

const NO_BRACE_ROOM = 0.8;

/** Free space between a label and what is left of the staff (brace or bracket), in staff spaces. */
const LABEL_GAP = 0.7;

/** The font size of a label in staff spaces when the page does not say. */
const DEFAULT_LABEL_SIZE = 2;

type LabelMode = NonNullable<PageSetup['labelsFirst']>;

/** The text a staff shows in `mode` (undefined: nothing). */
function labelText(s: StaffDef, mode: LabelMode | undefined): string | undefined {
  const t = mode === 'full' ? s.name : mode === 'abbr' ? s.abbr : undefined;
  return t || undefined;
}

/** The space left of the staves taken by the brace area, by the labels of the first system and by those of the others. */
export interface LeftRooms {
  brace: number;
  first: number;
  later: number;
}

/** The width of the widest label in `mode`, with the gap to the brace; 0 when there is none. */
function roomFor(score: Score, mode: LabelMode | undefined): number {
  const size = score.page.labelSize ?? DEFAULT_LABEL_SIZE;
  let w = 0;
  for (const s of score.staves) {
    const t = labelText(s, mode);
    if (t) w = Math.max(w, textWidth(t, size));
  }
  return w ? w + LABEL_GAP : 0;
}

/** The rooms left of the staves of `score`. */
export function leftRooms(score: Score): LeftRooms {
  const brace = score.groups.some((g) => g.kind === 'brace') ? BRACE_ROOM : NO_BRACE_ROOM;
  return { brace, first: roomFor(score, score.page.labelsFirst), later: roomFor(score, score.page.labelsLater) };
}

/**
 * The vertical middle of the label of staff `s`: the middle of its group when it opens a group in which no
 * other staff has a label (a name over a braced pair), else the middle of the staff itself.
 */
function labelMiddle(ctx: SysCtx, s: number, mode: LabelMode): number {
  const { score } = ctx.prep;
  for (const g of score.groups) {
    const idx = groupStaffIndices(score, g);
    if (idx[0] !== s || idx.length < 2) continue;
    if (idx.slice(1).some((i) => labelText(score.staves[i], mode))) continue;
    return (ctx.staffY[s] + ctx.staffY[idx[idx.length - 1]] + STAFF_HEIGHT) / 2;
  }
  return ctx.staffY[s] + STAFF_HEIGHT / 2;
}

/** Draws the labels of a system, right-aligned left of the brace area. */
export function drawStaffLabels(P: Prim[], ctx: SysCtx): void {
  const { score } = ctx.prep;
  const mode = ctx.index === 0 ? score.page.labelsFirst : score.page.labelsLater;
  if (!mode) return;
  const size = score.page.labelSize ?? DEFAULT_LABEL_SIZE;
  const x = -leftRooms(score).brace - LABEL_GAP;
  score.staves.forEach((st, s) => {
    const text = labelText(st, mode);
    if (!text) return;
    const y = labelMiddle(ctx, s, mode) + size * 0.33; // The baseline sits a third of the size below the middle.
    P.push({ t: 'text', x, y, s: text, size, anchor: 'end', k: 'stafflabel', o: oid({}) });
  });
}
