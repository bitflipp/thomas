// Pagination: header, placing the systems top to bottom on pages, vertical justification, and the
// layout geometry the editor uses for hit testing.
import type { Score } from '../model.ts';
import type { SysCtx } from './draw.ts';
import type { FinalizedSystem } from './finalize.ts';
import type { Page, Prim } from './scene.ts';
import { shiftPrim } from './scene.ts';

/** Where a measure of a staff sits on its page (staff spaces); `cols` are the x positions of its rhythmic columns, which the editor snaps to. */
export interface MeasureGeom {
  page: number;
  sys: number;
  mi: number;
  staff: number;
  x0: number;
  x1: number;
  y: number;
  cols: { tick: number; x: number }[];
}
/** Where a system sits: its measure range, horizontal extent and the page y of each staff's top line. */
export interface SystemGeom {
  page: number;
  sys: number;
  a: number;
  b: number;
  x0: number;
  x1: number;
  staffY: number[];
}
/** The page geometry of the whole piece, for the editor's hit testing (see src/editor/hit.ts). */
export interface Layout {
  systems: SystemGeom[];
  measures: MeasureGeom[];
}

export interface PaginateOptions {
  respectBreaks: boolean;
  justifyVertical: boolean;
  /** Width reserved left of the systems for the brace. */
  braceRoom: number;
}

/** Page geometry in staff spaces. */
interface PageFrame {
  width: number;
  height: number;
  margin: number;
  /** One typographic point in staff spaces. */
  pt: number;
  /** Lowest y a system may reach (above the footer). */
  usableBottom: number;
}

const FOOTER_HEIGHT = 3.5;
const MIN_SYSTEM_DISTANCE = 1.5;
const MAX_JUSTIFY_STRETCH = 5;

function pageFrame(score: Score): PageFrame {
  const S = score.page.staffSpace;
  const margin = score.page.margin / S;
  const height = score.page.height / S;
  return { width: score.page.width / S, height, margin, pt: 0.3528 / S, usableBottom: height - margin - FOOTER_HEIGHT };
}

/** Title, subtitle and composer on the first page; returns the y where the first system's area starts. */
function drawHeader(page: Page, score: Score, frame: PageFrame): number {
  const { meta } = score;
  const { pt, margin, width } = frame;
  let y = margin + 1.5;
  if (meta.title) {
    y += 22 * pt * 0.9;
    page.prims.push({ t: 'text', x: width / 2, y, s: meta.title, size: 22 * pt, anchor: 'middle' });
  }
  if (meta.subtitle) {
    y += 14 * pt * 1.7;
    page.prims.push({ t: 'text', x: width / 2, y, s: meta.subtitle, size: 14 * pt, anchor: 'middle' });
  }
  if (meta.composer) {
    y += 11 * pt * 1.9;
    page.prims.push({ t: 'text', x: width - margin, y, s: meta.composer, size: 11 * pt, anchor: 'end' });
  }
  return y + 3.5;
}

/** Where each system goes: the page it is on (as lists of system indices) and its y (of the first staff's top line) on that page. */
interface Placement {
  pageSystems: number[][];
  placeY: number[];
}

/**
 * Systems are placed top to bottom below the header (page 1) or the margin; a system that does not
 * fit in the remaining height, or that follows a forced page break, starts a new page.
 */
function placeSystems(
  score: Score,
  systems: SysCtx[],
  done: FinalizedSystem[],
  frame: PageFrame,
  firstPageTop: number,
  respectBreaks: boolean,
): Placement {
  const topOf = (pageIdx: number) => (pageIdx === 0 ? firstPageTop : frame.margin + 2.5);
  const pageSystems: number[][] = [[]];
  const placeY: number[] = [];
  let pageIdx = 0;
  let cursor = topOf(0);
  systems.forEach((ctx, i) => {
    const needTop = -done[i].top;
    const height = done[i].bottom - done[i].top;
    const forcedPage = respectBreaks && score.measures[ctx.a].breakBefore === 'page';
    const onPage = pageSystems[pageIdx].length;
    let y = cursor + (onPage ? MIN_SYSTEM_DISTANCE : 0) + needTop;
    if (onPage && (forcedPage || y - needTop + height > frame.usableBottom)) {
      pageIdx++;
      pageSystems[pageIdx] = [];
      cursor = topOf(pageIdx);
      y = cursor + needTop;
    }
    placeY[i] = y;
    pageSystems[pageIdx].push(i);
    cursor = y + done[i].bottom;
  });
  return { pageSystems, placeY };
}

/** On every page but the last, spreads the leftover height evenly between the systems, so that full pages end at the bottom margin. */
function justifyPagesVertically(place: Placement, done: FinalizedSystem[], usableBottom: number): void {
  const { pageSystems, placeY } = place;
  pageSystems.forEach((list, pi) => {
    if (pi === pageSystems.length - 1 || list.length < 2) return;
    const last = list[list.length - 1];
    const extra = usableBottom - (placeY[last] + done[last].bottom);
    if (extra <= 0) return;
    const per = Math.min(extra / (list.length - 1), MAX_JUSTIFY_STRETCH);
    list.forEach((si, k) => {
      placeY[si] += per * k;
    });
  });
}

/** The editor geometry of one system placed at (x0, y). */
function recordLayout(layout: Layout, ctx: SysCtx, page: number, x0: number, y: number): void {
  const nStaves = ctx.prep.score.staves.length;
  layout.systems.push({
    page,
    sys: ctx.index,
    a: ctx.a,
    b: ctx.b,
    x0,
    x1: x0 + ctx.width,
    staffY: ctx.staffY.map((sy) => y + sy),
  });
  for (let mi = ctx.a; mi <= ctx.b; mi++)
    for (let staff = 0; staff < nStaves; staff++) {
      const cols = ctx.spacing[mi].cols.map((c, j) => ({ tick: c.tick, x: x0 + ctx.mx[mi] + ctx.placed[mi].xs[j] }));
      layout.measures.push({
        page,
        sys: ctx.index,
        mi,
        staff,
        x0: x0 + ctx.mx[mi],
        x1: x0 + ctx.mx[mi] + ctx.placed[mi].endX,
        y: y + ctx.staffY[staff],
        cols,
      });
    }
}

/** Rights line and page number, added once the systems are on the page. */
function drawFooter(page: Page, score: Score, frame: PageFrame, pageIdx: number): void {
  const { pt, margin, width, height } = frame;
  if (score.meta.rights)
    page.prims.push({
      t: 'text',
      x: width / 2,
      y: height - margin,
      s: score.meta.rights,
      size: 9 * pt,
      anchor: 'middle',
    });
  if (pageIdx > 0)
    page.prims.push({
      t: 'text',
      x: width - margin,
      y: margin + 1.2,
      s: String(pageIdx + 1),
      size: 10 * pt,
      anchor: 'end',
    });
}

const placedCache = new WeakMap<FinalizedSystem, { x0: number; y: number; prims: Prim[] }>();

/** The primitives of a finished system moved to its place on the page; remembered, since an unchanged system often lands at the same place again. */
function placedPrims(sys: FinalizedSystem, x0: number, y: number): Prim[] {
  const c = placedCache.get(sys);
  if (c && c.x0 === x0 && c.y === y) return c.prims;
  const prims: Prim[] = [];
  for (const p of sys.prims) prims.push(shiftPrim(p, x0, y));
  for (const sp of sys.staffPrims) for (const p of sp.prims) prims.push(shiftPrim(p, x0, y + sp.dy));
  placedCache.set(sys, { x0, y, prims });
  return prims;
}

/** Lays the finished systems out on pages. */
export function paginate(
  score: Score,
  systems: SysCtx[],
  done: FinalizedSystem[],
  opts: PaginateOptions,
): { pages: Page[]; layout: Layout } {
  const frame = pageFrame(score);
  const firstPage: Page = { width: frame.width, height: frame.height, prims: [] };
  const firstPageTop = drawHeader(firstPage, score, frame);
  const place = placeSystems(score, systems, done, frame, firstPageTop, opts.respectBreaks);
  if (opts.justifyVertical) justifyPagesVertically(place, done, frame.usableBottom);
  const layout: Layout = { systems: [], measures: [] };
  const x0 = frame.margin + opts.braceRoom;
  const pages = place.pageSystems.map((list, pi) => {
    const page = pi === 0 ? firstPage : { width: frame.width, height: frame.height, prims: [] };
    for (const si of list) for (const p of placedPrims(done[si], x0, place.placeY[si])) page.prims.push(p);
    for (const si of list) recordLayout(layout, systems[si], pi, x0, place.placeY[si]);
    drawFooter(page, score, frame, pi);
    return page;
  });
  return { pages, layout };
}
