// The top level of the engraver: `engrave` runs the whole pipeline.
//
// Prepare the score, space every measure, choose the systems (`planSystems`), justify and draw each
// system's notes, run the spanners over all systems, then finalise each system (staff distances from the
// skylines, staff lines, clefs, barlines, brace) and paginate.
import type { Score } from '../model.ts';
import { must } from '../util.ts';
import type { SysCtx } from './draw.ts';
import type { FinalizedSystem, MeasureNumbering } from './finalize.ts';
import { finalizeSystem } from './finalize.ts';
import { justifySystem } from './justify.ts';
import type { SysPlan } from './linebreak.ts';
import { planSystems } from './linebreak.ts';
import type { Layout, PlacedSystem } from './paginate.ts';
import { paginate } from './paginate.ts';
import type { MeasureEntry, PrepCache } from './prep.ts';
import { prepare } from './prep.ts';
import type { Page, Prim } from './scene.ts';
import type { MeasureSpacing } from './spacing.ts';
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
  /** Results of the previous run (see `createEngraveCache`): only what an edit touched is computed again. */
  cache?: EngraveCache;
  /** Editor aid: draw hidden rests as ghosts (`Prim.ghost`) that can be selected; a renderer for output leaves them out. */
  ghostRests?: boolean;
}

/** The part of the previous run that the next one may reuse. Make one with `createEngraveCache` and pass it to every `engrave` of the same document. */
export interface EngraveCache {
  prep: PrepCache;
  /** Per system of the previous run: what it was made from and the drawing context holding the result. */
  systems: CachedSystem[];
  /** The parts of the score every system depends on; when one changes nothing is reused. */
  scoreKey: unknown[];
}

/** What a system looked like just before it was finalised, and the result of that: if the next run arrives at the same, the result is still good. */
interface FinalSnapshot {
  key: string;
  /** Copies of the primitives added after the notes (spanners, marks): finalising moves some of them. */
  post: Prim[][];
  extents: { top: number; bottom: number }[];
  done: FinalizedSystem;
}

interface CachedSystem {
  final?: FinalSnapshot;
  ctx: SysCtx;
  last: boolean;
  width: number;
  fillLast: boolean;
  entries: MeasureEntry[];
}

export function createEngraveCache(): EngraveCache {
  return { prep: { entries: [], nextId: 0 }, systems: [], scoreKey: [] };
}

function primEqual(a: Prim, b: Prim): boolean {
  const x = a as unknown as Record<string, unknown>;
  const y = b as unknown as Record<string, unknown>;
  for (const k in x) {
    const u = x[k];
    const v = y[k];
    if (u === v) continue;
    if (!(Array.isArray(u) && Array.isArray(v) && u.length === v.length && u.every((q, i) => q === v[i]))) return false;
  }
  for (const k in y) if (!(k in x)) return false;
  return true;
}

/** Is the system, with its spanners and marks added, the same as when `snap` was taken? Only meaningful for a system whose notes were kept. */
function sameAsSnapshot(ctx: SysCtx, snap: FinalSnapshot, key: string): boolean {
  if (snap.key !== key) return false;
  const base = must(ctx.base);
  for (let s = 0; s < ctx.prims.length; s++) {
    const old = snap.post[s];
    const now = ctx.prims[s];
    if (now.length - base.prims[s] !== old.length) return false;
    for (let i = 0; i < old.length; i++) if (!primEqual(now[base.prims[s] + i], old[i])) return false;
    const e = ctx.sky[s].extent();
    if (e.top !== snap.extents[s].top || e.bottom !== snap.extents[s].bottom) return false;
  }
  return true;
}

/** Can the system drawn before as `c` be used again for `plan`? Same measures made from the same inputs at the same width. */
function reusable(c: CachedSystem, plan: SysPlan, entries: MeasureEntry[], width: number, fillLast: boolean): boolean {
  const { ctx } = c;
  if (ctx.a !== plan.a || ctx.b !== plan.b || c.last !== plan.last || c.width !== width || c.fillLast !== fillLast)
    return false;
  if (ctx.widened || !ctx.base) return false;
  for (let mi = plan.a; mi <= plan.b; mi++) if (c.entries[mi - plan.a] !== entries[mi]) return false;
  return true;
}

/** The result of engraving: pages of primitives plus the layout geometry. */
export interface Engraved {
  pages: Page[];
  systems: number;
  staffSpace: number;
  layout: Layout;
  /** The systems' primitives as placed on the pages (also found in `pages`), for caching work per system (see `buildHitIndex`). */
  placed: PlacedSystem[];
}

/** Width of the brace area left of the systems, with and without a braced staff group. */
const BRACE_ROOM = 2.4;
const NO_BRACE_ROOM = 0.8;

/** Engraves the whole score. Vertical sizes are only known after the spanners are placed, so the staff distances come last. */
export function engrave(score: Score, opts: EngraveOptions = {}): Engraved {
  const respectBreaks = opts.respectBreaks ?? true;
  const cache = opts.cache;
  const prep = prepare(score, cache?.prep);
  prep.ghostRests = opts.ghostRests;
  const S = score.page.staffSpace;
  const braceRoom = score.groups.some((g) => g.kind === 'brace') ? BRACE_ROOM : NO_BRACE_ROOM;
  const lineWidth = (score.page.width - 2 * score.page.margin) / S - braceRoom;

  // Both variants of a measure's spacing are made together (they write onto the same records), and kept with its cache entry.
  const spacing = (mi: number): [MeasureSpacing, MeasureSpacing] => {
    const e = prep.entries?.[mi];
    if (!e) {
      const sp = spaceMeasure(prep, mi);
      return [sp, sp];
    }
    if (!(e.spN && e.spF)) e.spN = e.spF = spaceMeasure(prep, mi);
    return [e.spN, e.spF];
  };
  const spacings = score.measures.map((_, mi) => spacing(mi));
  const spacingNormal = spacings.map((s) => s[0]);
  const spacingFirstInSystem = spacings.map((s) => s[1]);
  const forcedBreaks = new Set<number>();
  if (respectBreaks)
    score.measures.forEach((m, mi) => {
      if (m.breakBefore) forcedBreaks.add(mi);
    });
  const plans = planSystems(prep, spacingNormal, spacingFirstInSystem, lineWidth, forcedBreaks);

  const warn = opts.warn ?? (() => undefined);
  const justifyOpts = { fillLast: opts.fillLast, warn };
  const fillLast = opts.fillLast ?? false;
  const scoreKey = [score.page, score.groups, score.staves, !!opts.ghostRests];
  if (cache?.scoreKey.some((x, i) => x !== scoreKey[i])) cache.systems = [];
  const kept = new Set<SysCtx>();
  const systems: SysCtx[] = plans.map((plan, index) => {
    const old = cache?.systems.find((c) => c.ctx.a === plan.a);
    if (old && prep.entries && reusable(old, plan, prep.entries, lineWidth, fillLast)) {
      const ctx = old.ctx;
      ctx.prep = prep;
      ctx.index = index;
      if (ctx.overflow) warn(`system ${index + 1}: content exceeds width ${lineWidth.toFixed(1)}`);
      kept.add(ctx);
      return ctx;
    }
    return justifySystem(prep, plan, index, spacingNormal, spacingFirstInSystem, lineWidth, justifyOpts);
  });
  drawNotesAndSpanners(systems, kept);

  const numbering: MeasureNumbering = opts.measureNumbers ?? 'system';
  const oldFinal = new Map<SysCtx, FinalSnapshot | undefined>(cache?.systems.map((c) => [c.ctx, c.final]));
  const finals: (FinalSnapshot | undefined)[] = [];
  const done: FinalizedSystem[] = systems.map((ctx, i) => {
    if (!cache) return finalizeSystem(ctx, numbering);
    const key = `${ctx.index}|${numbering}|${score.measures.length}`;
    const old = kept.has(ctx) ? oldFinal.get(ctx) : undefined;
    if (old && sameAsSnapshot(ctx, old, key)) {
      finals[i] = old;
      return old.done;
    }
    const base = ctx.base;
    const post = ctx.prims.map((p, s) => p.slice(base?.prims[s] ?? 0).map((q) => ({ ...q })));
    const extents = ctx.sky.map((k) => k.extent());
    const d = finalizeSystem(ctx, numbering);
    finals[i] = { key, post, extents, done: d };
    return d;
  });
  if (cache && prep.entries) {
    const entries = prep.entries;
    cache.scoreKey = scoreKey;
    cache.systems = systems.map((ctx, i) => ({
      final: finals[i],
      ctx,
      last: plans[i].last,
      width: lineWidth,
      fillLast,
      entries: entries.slice(ctx.a, ctx.b + 1),
    }));
  }
  const { pages, layout, placed } = paginate(score, systems, done, {
    respectBreaks,
    justifyVertical: opts.justifyVertical ?? true,
    braceRoom,
  });
  return { pages, systems: systems.length, staffSpace: S, layout, placed };
}
