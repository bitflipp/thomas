// The top level of the engraver: `engrave` runs the whole pipeline.
//
// Prepare the score, space every measure, choose the systems (`planSystems`), justify and draw each
// system's notes, run the spanners over all systems, then finalise each system (staff distances from the
// skylines, staff lines, clefs, barlines, brace) and paginate.
import type { Score } from '../model.ts';
import type { SysCtx } from './draw.ts';
import type { FinalizedSystem, MeasureNumbering } from './finalize.ts';
import { finalizeSystem } from './finalize.ts';
import { justifySystem } from './justify.ts';
import { planSystems } from './linebreak.ts';
import type { Layout } from './paginate.ts';
import { paginate } from './paginate.ts';
import { prepare } from './prep.ts';
import type { Page } from './scene.ts';
import { spaceMeasure } from './spacing.ts';
import { drawNotesAndSpanners } from './staffgap.ts';

export type { Layout, MeasureGeom, SystemGeom } from './paginate.ts';
export { clefGlyph } from './signatures.ts';

export interface EngraveOptions {
  /** Honour the score's `breakBefore` flags (default true). */
  respectBreaks?: boolean;
  /** Spread the systems of full pages over the page height (default true). */
  justifyVertical?: boolean;
  /** Justify the last system however short it is (editors want room to click in). */
  fillLast?: boolean;
  /** Default 'system': the first measure of every system but the first. */
  measureNumbers?: 'system' | 'all' | 'none';
  warn?: (m: string) => void;
}

/** The result of engraving: pages of primitives plus the layout geometry. */
export interface Engraved {
  pages: Page[];
  systems: number;
  staffSpace: number;
  layout: Layout;
}

/** Width of the brace area left of the systems, with and without a braced staff group. */
const BRACE_ROOM = 2.4;
const NO_BRACE_ROOM = 0.8;

/** Engraves the whole score. Vertical sizes are only known after the spanners are placed, so the staff distances come last. */
export function engrave(score: Score, opts: EngraveOptions = {}): Engraved {
  const respectBreaks = opts.respectBreaks ?? true;
  const prep = prepare(score);
  const S = score.page.staffSpace;
  const braceRoom = score.groups.some((g) => g.kind === 'brace') ? BRACE_ROOM : NO_BRACE_ROOM;
  const lineWidth = (score.page.width - 2 * score.page.margin) / S - braceRoom;

  const spacingNormal = score.measures.map((_, mi) => spaceMeasure(prep, mi, false));
  const spacingFirstInSystem = score.measures.map((_, mi) => spaceMeasure(prep, mi, true));
  const forcedBreaks = new Set<number>();
  if (respectBreaks)
    score.measures.forEach((m, mi) => {
      if (m.breakBefore) forcedBreaks.add(mi);
    });
  const plans = planSystems(prep, spacingNormal, spacingFirstInSystem, lineWidth, forcedBreaks);

  const justifyOpts = { fillLast: opts.fillLast, warn: opts.warn ?? (() => undefined) };
  const systems: SysCtx[] = plans.map((plan, index) =>
    justifySystem(prep, plan, index, spacingNormal, spacingFirstInSystem, lineWidth, justifyOpts),
  );
  drawNotesAndSpanners(systems);

  const numbering: MeasureNumbering = opts.measureNumbers ?? 'system';
  const done: FinalizedSystem[] = systems.map((ctx) => finalizeSystem(ctx, numbering));
  const { pages, layout } = paginate(score, systems, done, {
    respectBreaks,
    justifyVertical: opts.justifyVertical ?? true,
    braceRoom,
  });
  return { pages, systems: systems.length, staffSpace: S, layout };
}
