// Line breaking, system assembly, vertical layout and pagination: the top level of the engraver.
//
// `engrave` runs the whole pipeline: prepare the score, space every measure, choose the systems
// (`planSystems`), justify and draw each system's notes, run the spanners over all systems, then
// finalise (staff distances from the skylines, staff lines, clefs, barlines, brace) and paginate.
import type { Clef, Score } from '../model.ts';
import { keyAt, timeAt } from '../model.ts';
import { loadSmufl } from '../smufl.ts';
import { must } from '../util.ts';
import type { SysCtx } from './draw.ts';
import { CROSS_GAP0, D, drawSystemNotes, xAtTick } from './draw.ts';
import type { Prepared } from './prep.ts';
import { posToY, prepare } from './prep.ts';
import type { Page, Prim } from './scene.ts';
import { oid, Skyline, tagFrom } from './scene.ts';
import type { MeasureSpacing } from './spacing.ts';
import { keyChange, placeMeasure, spaceMeasure } from './spacing.ts';
import { drawSpanners } from './spanners.ts';

const sm = loadSmufl();

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

/** Staff positions (half spaces above the bottom line) of the sharps and flats of a key signature in the treble clef, in order of fifths; other clefs shift them by whole octaves. */
const SHARP_POS_TREBLE = [8, 5, 9, 6, 3, 7, 4];
const FLAT_POS_TREBLE = [4, 7, 3, 6, 2, 5, 1];

export function clefGlyph(c: Clef, change = false): { name: string; y: number } {
  const y = 4 - (c.line - 1);
  if (c.sign === 'G')
    return { name: change ? 'gClefChange' : c.octave === -1 ? 'gClef8vb' : c.octave === 1 ? 'gClef8va' : 'gClef', y };
  if (c.sign === 'F')
    return { name: change ? 'fClefChange' : c.octave === -1 ? 'fClef8vb' : c.octave === 1 ? 'fClef8va' : 'fClef', y };
  return { name: change ? 'cClefChange' : 'cClef', y };
}

function keyPositions(fifths: number, clef: Clef): number[] {
  // `bottom` is the diatonic step number of the bottom line; the treble pattern moves by the difference
  // modulo an octave (a seventh), so e.g. bass clef sharps sit a third lower.
  const bottom = (c: Clef) => {
    const sign = c.sign === 'G' ? 4 * 7 + 4 : c.sign === 'F' ? 3 * 7 + 3 : 4 * 7;
    return sign - 2 * (c.line - 1) + 7 * (c.octave ?? 0);
  };
  const shift = (((bottom({ sign: 'G', line: 2 }) - bottom(clef)) % 7) + 7) % 7;
  // Use the signed offset (bass: two steps down, not five up) and wrap each kind into its window.
  const d = shift > 3 ? shift - 7 : shift;
  const base = fifths > 0 ? SHARP_POS_TREBLE.slice(0, fifths) : FLAT_POS_TREBLE.slice(0, -fifths);
  // Flats keep the treble window [1, 7] moved by the offset (bass: -1..5, the last flat lowest).
  return base.map((p) => {
    let q = p + d;
    if (fifths > 0) {
      while (q > 9) q -= 7;
    } else {
      while (q < 1 + d) q += 7;
      while (q > 7 + d) q -= 7;
    }
    return q;
  });
}

function keyWidth(fifths: number): number {
  if (!fifths) return 0;
  const g = fifths > 0 ? 'accidentalSharp' : 'accidentalFlat';
  return Math.abs(fifths) * (sm.adv(g) + 0.12) + 0.9;
}
function timeWidth(ts: { beats: number; beatType: number }): number {
  return Math.max(String(ts.beats).length, String(ts.beatType).length) * sm.adv('timeSig2') + 1.3;
}

function prefixWidth(prep: Prepared, mi: number, first: boolean): number {
  const score = prep.score;
  let cw = 0;
  score.staves.forEach((_, si) => {
    cw = Math.max(cw, sm.adv(clefGlyph(prep.clefAt(si, mi, 0)).name));
  });
  let w = 0.9 + cw + 1.0;
  w += keyWidth(keyAt(score, mi));
  if (first) w += timeWidth(timeAt(score, mi));
  return w;
}

/** The measures a..b (inclusive) that make up one system. */
interface SysPlan {
  a: number;
  b: number;
  last: boolean;
}

/**
 * Chooses the line breaks by dynamic programming over the measures. A system a..b costs more the
 * further its natural width is from the line width W: a quadratic penalty for slack, a larger one for
 * having to squeeze (but still possible down to `COMPRESS`), a very large one for not fitting at all
 * (only a single measure may do that), plus a constant per system so fewer lines are preferred. The
 * last line of the piece is not stretched at all when it is under 55 % full, so it costs nothing then. Forced breaks split the piece
 * into independent segments first. At most 14 measures are tried per line.
 */
function planSystems(
  prep: Prepared,
  spN: MeasureSpacing[],
  spF: MeasureSpacing[],
  W: number,
  forced: Set<number>,
): SysPlan[] {
  const n = spN.length;
  const natural = (a: number, b: number, comp = false) => {
    let w = prefixWidth(prep, a, a === 0) + (comp ? spF[a].compWidth : spF[a].minWidth);
    for (let k = a + 1; k <= b; k++) w += comp ? spN[k].compWidth : spN[k].minWidth;
    return w;
  };
  const plans: SysPlan[] = [];
  const starts = [0, ...[...forced].filter((i) => i > 0).sort((x, y) => x - y)];
  starts.forEach((segStart, si) => {
    const segEnd = (si + 1 < starts.length ? starts[si + 1] : n) - 1;
    const isFinalSeg = segEnd === n - 1;
    const len = segEnd - segStart + 1;
    const best: number[] = new Array(len + 1).fill(Number.POSITIVE_INFINITY);
    const from: number[] = new Array(len + 1).fill(-1);
    best[0] = 0;
    for (let i = 1; i <= len; i++) {
      for (let j = Math.max(0, i - 14); j < i; j++) {
        if (best[j] === Number.POSITIVE_INFINITY) continue;
        const nat = natural(segStart + j, segStart + i - 1);
        const cmp = natural(segStart + j, segStart + i - 1, true);
        const single = i - j === 1;
        if (cmp > W && !single) continue;
        const lastLine = isFinalSeg && i === len;
        let cost: number;
        if (cmp > W) cost = 200 + (cmp - W) * 10;
        else if (nat > W) {
          const c = (nat - W) / Math.max(0.01, nat - cmp);
          cost = 10 * c * c;
        } else if (lastLine) cost = nat / W > 0.55 ? 2 * (1 - nat / W) ** 2 * 100 : 0;
        else cost = ((W - nat) / W) ** 2 * 160;
        cost += 3; // per-system cost: prefer fewer lines
        const tot = best[j] + cost;
        if (tot < best[i]) {
          best[i] = tot;
          from[i] = j;
        }
      }
    }
    const cuts: number[] = [];
    let i = len;
    while (i > 0) {
      cuts.push(i);
      i = from[i];
    }
    cuts.reverse();
    let prev = 0;
    for (const c of cuts) {
      plans.push({ a: segStart + prev, b: segStart + c - 1, last: false });
      prev = c;
    }
  });
  plans[plans.length - 1].last = true;
  return plans;
}

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
/** The result of engraving: pages of primitives plus the layout geometry. */
export interface Engraved {
  pages: Page[];
  systems: number;
  staffSpace: number;
  layout: Layout;
}

/** Engraves the whole score. Vertical sizes are only known after the spanners are placed, so the staff distances come last. */
export function engrave(score: Score, opts: EngraveOptions = {}): Engraved {
  const warn = opts.warn ?? (() => undefined);
  const respect = opts.respectBreaks ?? true;
  const prep = prepare(score);
  const nS = score.staves.length;
  const nM = score.measures.length;
  const S = score.page.staffSpace;
  const pageW = score.page.width / S;
  const pageH = score.page.height / S;
  const margin = score.page.margin / S;
  const hasBrace = score.groups.some((g) => g.kind === 'brace');
  const braceRoom = hasBrace ? 2.4 : 0.8;
  const W = pageW - 2 * margin - braceRoom;

  const spN = score.measures.map((_, mi) => spaceMeasure(prep, mi, false));
  const spF = score.measures.map((_, mi) => spaceMeasure(prep, mi, true));

  const forced = new Set<number>();
  if (respect)
    score.measures.forEach((m, mi) => {
      if (m.breakBefore) forced.add(mi);
    });
  const plans = planSystems(prep, spN, spF, W, forced);

  // ---- Build systems. Each system is justified by solving for the stretch factor that makes
  // its measures exactly fill the line (bisection), then its notes are drawn.
  const systems: SysCtx[] = [];
  for (const [index, plan] of plans.entries()) {
    const prefix = prefixWidth(prep, plan.a, plan.a === 0);
    const spacing: MeasureSpacing[] = [];
    for (let mi = plan.a; mi <= plan.b; mi++) spacing[mi] = mi === plan.a ? spF[mi] : spN[mi];
    const widthAt = (f: number) => {
      let w = prefix;
      for (let mi = plan.a; mi <= plan.b; mi++) w += placeMeasure(spacing[mi], f).width;
      return w;
    };
    let f = 1;
    const nat = widthAt(1);
    if (!plan.last || nat / W > 0.55 || opts.fillLast) {
      let lo = 0.3;
      let hi = 20;
      if (widthAt(lo) > W) f = lo;
      else {
        for (let it = 0; it < 50; it++) {
          const mid = (lo + hi) / 2;
          if (widthAt(mid) > W) hi = mid;
          else lo = mid;
        }
        f = lo;
      }
      if (plan.last) f = Math.min(f, opts.fillLast ? 4 : 1.6);
    }
    const placed = [];
    const mx: number[] = [];
    let x = prefix;
    for (let mi = plan.a; mi <= plan.b; mi++) {
      const p = placeMeasure(spacing[mi], f);
      placed[mi] = p;
      mx[mi] = x;
      x += p.width;
    }
    if (widthAt(f) > W * 1.001) warn(`system ${index + 1}: content ${nat.toFixed(1)} exceeds width ${W.toFixed(1)}`);
    systems.push({
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
      prims: score.staves.map(() => []),
      sky: score.staves.map(() => new Skyline()),
      staffY: [],
      barlines: [],
      tupletBoxes: [],
      gap: score.staves.map(() => CROSS_GAP0),
      gapNeed: score.staves.map(() => 0),
    });
  }

  for (const ctx of systems) {
    drawSystemNotes(ctx);
    // A cross-staff beam is drawn for a given distance between the staves, and the beam itself changes
    // what room the gap needs: iterate a few times until the gap satisfies both, then pin it so later
    // phases may widen but never shrink it.
    const crossing =
      ctx.gapNeed.some((g) => g > 0) || prep.allEvs.some((e) => e.mi >= ctx.a && e.mi <= ctx.b && e.staff !== e.home);
    if (!crossing) continue;
    for (let it = 0; it < 4; it++) {
      let changed = false;
      for (let s = 1; s < nS; s++) {
        const want = Math.max(staffGap(ctx, s), ctx.gapNeed[s] + 0.3);
        if (Math.abs(want - ctx.gap[s]) > 0.01) {
          ctx.gap[s] = want;
          changed = true;
        }
      }
      if (!changed) break;
      ctx.prims = score.staves.map(() => []);
      ctx.sky = score.staves.map(() => new Skyline());
      ctx.gapNeed = score.staves.map(() => 0);
      drawSystemNotes(ctx);
    }
    ctx.pinned = true;
  }
  drawSpanners(systems);
  // Slurs and marks may need more room between the staves of a system whose gap was pinned for its
  // cross-staff beams: widen it and redraw.
  for (let it = 0; it < 4; it++) {
    let changed = false;
    for (const ctx of systems)
      if (ctx.pinned)
        for (let s = 1; s < nS; s++) {
          const want = staffGap(ctx, s);
          if (want > ctx.gap[s] + 0.01) {
            ctx.gap[s] = want;
            changed = true;
          }
        }
    if (!changed) break;
    for (const ctx of systems) {
      ctx.prims = score.staves.map(() => []);
      ctx.sky = score.staves.map(() => new Skyline());
      ctx.gapNeed = score.staves.map(() => 0);
      drawSystemNotes(ctx);
    }
    drawSpanners(systems);
  }

  // ---- Finalize each system: staff positions from the skyline extents, then staff lines, clefs,
  // key/time signatures, measure numbers, barlines and the brace, in system coordinates.
  const sysPrims: Prim[][] = [];
  const sysTop: number[] = [];
  const sysBottom: number[] = [];
  for (const ctx of systems) {
    const ext = ctx.sky.map((k) => k.extent());
    ctx.staffY = [0];
    for (let s = 1; s < nS; s++) {
      const gap = ctx.pinned ? ctx.gap[s] : staffGap(ctx, s);
      ctx.staffY[s] = ctx.staffY[s - 1] + 4 + gap;
    }
    alignDynamics(ctx, nS);
    const P: Prim[] = [];
    const first = ctx.a === 0;
    // Per staff: the five lines, the notes drawn earlier (shifted down to this staff's y), then
    // the clef, key and time signature at the left.
    for (let s = 0; s < nS; s++) {
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
      for (const p of ctx.prims[s]) P.push(shift(p, 0, y0));
      // Initial clef, then key signature, then the time signature, left to right. The time
      // signature is shown at the start of the piece only; later ones are drawn mid-system.
      const clef = prep.clefAt(s, ctx.a, 0);
      const cg = clefGlyph(clef);
      P.push({ t: 'glyph', name: cg.name, x: 0.9, y: y0 + cg.y, k: 'clef', o: oid({}) });
      let kx = 0.9 + sm.adv(cg.name) + 1.0;
      const key = keyAt(score, ctx.a);
      const keyId = oid({});
      if (key) {
        const name = key > 0 ? 'accidentalSharp' : 'accidentalFlat';
        keyPositions(key, clef).forEach((pos) => {
          P.push({ t: 'glyph', name, x: kx, y: y0 + posToY(pos), k: 'keysig', o: keyId });
          kx += sm.adv(name) + 0.12;
        });
        kx += 0.9;
      }
      if (first) timeSig(P, kx, y0, timeAt(score, ctx.a));
      // Changes inside the system: a time signature at the start of its measure and clef changes
      // at their column, placed left of the notes of that column (`L` is the column's left extent).
      for (let mi = ctx.a; mi <= ctx.b; mi++) {
        if (mi > ctx.a) {
          let tx = ctx.mx[mi] + 0.6;
          const kc = keyChange(score, mi);
          if (kc) {
            const oid2 = oid({});
            const put = (name: string, pos: number) => {
              P.push({ t: 'glyph', name, x: tx, y: y0 + posToY(pos), k: 'keysig', o: oid2 });
              tx += sm.adv(name) + 0.12;
            };
            const oldPos = keyPositions(kc.from, clef);
            const newPos = keyPositions(kc.to, clef);
            for (const i of kc.nat) put('accidentalNatural', oldPos[i]);
            for (const pos of newPos) put(kc.to > 0 ? 'accidentalSharp' : 'accidentalFlat', pos);
            tx += 0.6;
          }
          if (score.measures[mi].time) timeSig(P, tx, y0, timeAt(score, mi));
        }
        for (const mk of prep.measures[mi][s].marks) {
          if (mk.type !== 'clef') continue;
          if (mk.tick === 0 && mi === ctx.a) continue;
          const g = clefGlyph(mk.clef, true);
          const cx = xAtTick(ctx, mi, mk.tick);
          const colj = ctx.spacing[mi].cols.findIndex((c) => c.tick === mk.tick);
          const L = colj >= 0 ? ctx.spacing[mi].cols[colj].L[s] : 0;
          P.push({ t: 'glyph', name: g.name, x: cx - L + 0.5, y: y0 + g.y, k: 'clef', o: oid({}) });
        }
      }
    }
    // Measure numbers sit above the first staff: at the system start, or at every barline in 'all'
    // mode. They avoid whatever the skyline holds there (so are placed after the spanners).
    const mode = opts.measureNumbers ?? 'system';
    if (mode !== 'none') {
      const size = 1.8;
      const list = mode === 'all' ? Array.from({ length: ctx.b - ctx.a + 1 }, (_, k) => ctx.a + k) : [ctx.a];
      for (const mi of list) {
        if (mi === 0) continue;
        const label = String(mi + 1);
        const x = mi === ctx.a ? 0.2 : ctx.mx[mi] + 0.3;
        const w = label.length * size * 0.5 + 0.4;
        let y = Math.min(-0.8, ctx.sky[0].top(x, x + w, 0) - 0.5);
        if (mi === ctx.a) {
          // The clef at the start of the system may reach above the staff and it is not in the
          // skyline, so a measure number there is lifted above it explicitly.
          const cb = sm.bbox(clefGlyph(prep.clefAt(0, ctx.a, 0)).name);
          const cy = clefGlyph(prep.clefAt(0, ctx.a, 0)).y;
          if (x + w > 0.9) y = Math.min(y, cy - cb.y1 - 0.5);
        }
        P.push({ t: 'text', x, y, s: label, size, italic: true, k: 'measurenum', o: oid({}) });
        ctx.sky[0].add(x, x + w, y - size * 0.75, y + 0.2);
      }
      ext[0] = ctx.sky[0].extent();
    }
    // Barlines: one line per group of joined staves (a braced pair shares one). The measure's
    // `barline` asks for a double bar or, at the end of the piece, a thin-thick final bar.
    const bottom = ctx.staffY[nS - 1] + 4;
    const groupsOf: [number, number][] = [];
    const used = new Set<number>();
    for (const g of score.groups) {
      const idx = g.staves
        .map((id) => score.staves.findIndex((s) => s.id === id))
        .filter((i) => i >= 0)
        .sort((x, y) => x - y);
      if (idx.length) {
        groupsOf.push([idx[0], idx[idx.length - 1]]);
        for (const i of idx) used.add(i);
      }
    }
    for (let s = 0; s < nS; s++) if (!used.has(s)) groupsOf.push([s, s]);
    const thin = D.thinBarlineThickness as number;
    const thick = D.thickBarlineThickness as number;
    P.push({ t: 'line', x1: 0, x2: 0, y1: 0, y2: bottom, w: thin, k: 'barline', o: oid({}) });
    for (let mi = ctx.a; mi <= ctx.b; mi++) {
      const bx = ctx.mx[mi] + ctx.placed[mi].endX;
      const bl = score.measures[mi].barline ?? 'single';
      const lastInSys = mi === ctx.b;
      for (const [s0, s1] of groupsOf) {
        const nBar = P.length;
        const y0 = ctx.staffY[s0];
        const y1 = ctx.staffY[s1] + 4;
        if (bl === 'final' || (lastInSys && mi === nM - 1)) {
          const tx = ctx.width - thick / 2;
          P.push({ t: 'line', x1: tx, x2: tx, y1: y0, y2: y1, w: thick });
          const nx = tx - thick / 2 - (D.barlineSeparation as number) - thin / 2;
          P.push({ t: 'line', x1: nx, x2: nx, y1: y0, y2: y1, w: thin });
        } else if (bl === 'double') {
          P.push({ t: 'line', x1: bx - 0.4, x2: bx - 0.4, y1: y0, y2: y1, w: thin });
          P.push({ t: 'line', x1: bx, x2: bx, y1: y0, y2: y1, w: thin });
        } else P.push({ t: 'line', x1: bx, x2: bx, y1: y0, y2: y1, w: thin });
        tagFrom(P, nBar, 'barline', oid({}));
      }
    }
    // Brace or bracket for each staff group. A brace glyph is scaled to the height of its staves,
    // with its width following in proportion up to a maximum; a bracket is a plain thick line.
    for (const g of score.groups) {
      const idx = g.staves
        .map((id) => score.staves.findIndex((s) => s.id === id))
        .filter((i) => i >= 0)
        .sort((x, y) => x - y);
      if (!idx.length) continue;
      const y0 = ctx.staffY[idx[0]];
      const y1 = ctx.staffY[idx[idx.length - 1]] + 4;
      if (g.kind === 'brace') {
        const b = sm.bbox('brace');
        const bh = b.y1 - b.y0;
        const sy = (y1 - y0) / bh;
        const sx = Math.min(3.2, 0.75 * sy);
        // The glyph origin is at the bottom of the brace in SMuFL, with the outline extending upwards:
        // place it so that its top edge matches the top of the first staff.
        P.push({ t: 'glyph', name: 'brace', x: -0.35 - b.x1 * sx, y: y1 + b.y0 * sy, sx, sy, k: 'brace', o: oid({}) });
      } else {
        P.push({
          t: 'line',
          x1: -0.8,
          x2: -0.8,
          y1: y0 - 0.2,
          y2: y1 + 0.2,
          w: D.bracketThickness as number,
          k: 'brace',
          o: oid({}),
        });
      }
    }
    sysPrims.push(P);
    sysTop.push(Math.min(0, ...ext.map((e, s) => ctx.staffY[s] + e.top)));
    sysBottom.push(Math.max(bottom, ...ext.map((e, s) => ctx.staffY[s] + e.bottom)));
  }

  // ---- Pages. Systems are placed top to bottom below the header (page 1) or the margin; a system
  // that does not fit in the remaining height, or that follows a forced page break, starts a new page.
  const pt = 0.3528 / S; // 1pt in staff spaces
  const pages: Page[] = [];
  const footerH = 3.5;
  const usableBottom = pageH - margin - footerH;
  const newPage = (): Page => {
    const p: Page = { width: pageW, height: pageH, prims: [] };
    pages.push(p);
    return p;
  };
  const meta = score.meta;
  let page = newPage();
  // Header on the first page: title, subtitle, composer. The rights line and the page numbers
  // are added after the systems are placed.
  let top1 = margin + 1.5;
  const tsz = 22 * pt;
  const ssz = 14 * pt;
  const csz = 11 * pt;
  if (meta.title) {
    top1 += tsz * 0.9;
    page.prims.push({ t: 'text', x: pageW / 2, y: top1, s: meta.title, size: tsz, anchor: 'middle' });
  }
  if (meta.subtitle) {
    top1 += ssz * 1.7;
    page.prims.push({ t: 'text', x: pageW / 2, y: top1, s: meta.subtitle, size: ssz, anchor: 'middle' });
  }
  if (meta.composer) {
    top1 += csz * 1.9;
    page.prims.push({ t: 'text', x: pageW - margin, y: top1, s: meta.composer, size: csz, anchor: 'end' });
  }
  top1 += 3.5;
  const topOf = (pi: number) => (pi === 0 ? top1 : margin + 2.5);
  let pageIdx = 0;
  const pageSystems: number[][] = [[]];
  let cursor = topOf(0);
  const placeY: number[] = [];
  const gapMin = 1.5;
  systems.forEach((ctx, i) => {
    const needTop = -sysTop[i];
    const h = sysBottom[i] - sysTop[i];
    const forcedPage = respect && score.measures[ctx.a].breakBefore === 'page';
    const onPageCount = pageSystems[pageIdx].length;
    let y = cursor + (onPageCount ? gapMin : 0) + needTop;
    if (onPageCount && (forcedPage || y - needTop + h > usableBottom)) {
      pageIdx++;
      pageSystems[pageIdx] = [];
      cursor = topOf(pageIdx);
      y = cursor + needTop;
    }
    placeY[i] = y;
    pageSystems[pageIdx].push(i);
    cursor = y + sysBottom[i];
  });
  // Vertical justification: on every page but the last, spread the leftover height evenly
  // between the systems, so that full pages end at the bottom margin.
  if (opts.justifyVertical ?? true) {
    pageSystems.forEach((list, pi) => {
      if (pi === pageSystems.length - 1 || list.length < 2) return;
      const last = list[list.length - 1];
      const extra = usableBottom - (placeY[last] + sysBottom[last]);
      if (extra <= 0) return;
      const per = Math.min(extra / (list.length - 1), 5);
      list.forEach((si, k) => {
        placeY[si] += per * k;
      });
    });
  }
  const layout: Layout = { systems: [], measures: [] };
  pageSystems.forEach((list, pi) => {
    if (pi > 0) page = newPage();
    const x0 = margin + braceRoom;
    for (const si of list) for (const p of sysPrims[si]) page.prims.push(shift(p, x0, placeY[si]));
    for (const si of list) {
      const ctx = systems[si];
      layout.systems.push({
        page: pi,
        sys: si,
        a: ctx.a,
        b: ctx.b,
        x0,
        x1: x0 + ctx.width,
        staffY: ctx.staffY.map((y) => placeY[si] + y),
      });
      for (let mi = ctx.a; mi <= ctx.b; mi++)
        for (let st = 0; st < nS; st++) {
          const cols = ctx.spacing[mi].cols.map((c, j) => ({
            tick: c.tick,
            x: x0 + ctx.mx[mi] + ctx.placed[mi].xs[j],
          }));
          layout.measures.push({
            page: pi,
            sys: si,
            mi,
            staff: st,
            x0: x0 + ctx.mx[mi],
            x1: x0 + ctx.mx[mi] + ctx.placed[mi].endX,
            y: placeY[si] + ctx.staffY[st],
            cols,
          });
        }
    }
    if (meta.rights)
      page.prims.push({ t: 'text', x: pageW / 2, y: pageH - margin, s: meta.rights, size: 9 * pt, anchor: 'middle' });
    if (pi > 0)
      page.prims.push({
        t: 'text',
        x: pageW - margin,
        y: margin + 1.2,
        s: String(pi + 1),
        size: 10 * pt,
        anchor: 'end',
      });
  });
  return { pages, systems: systems.length, staffSpace: S, layout };
}

/** Distance between the bottom line of staff s-1 and the top line of staff s that the content of both requires. */
function staffGap(ctx: SysCtx, s: number): number {
  // First the gap that the pairwise overlap in x requires: a tall slur in one staff only matters
  // where the other staff has content below it.
  let need = 0;
  for (const a of ctx.sky[s - 1].boxes)
    for (const b of ctx.sky[s].boxes) {
      if (a.spanner && b.spanner) continue;
      if (a.x1 > b.x0 && a.x0 < b.x1) need = Math.max(need, a.y1 - 4 - b.y0 + 1.0);
    }
  // Then clear of both staves' lines, whether or not anything overlaps in x: content hanging
  // below the upper staff or above the lower one needs room of its own, and 3.7 is the minimum.
  for (const a of ctx.sky[s - 1].boxes) if (!a.spanner) need = Math.max(need, a.y1 - 4 + 0.7);
  for (const b of ctx.sky[s].boxes) if (!b.spanner) need = Math.max(need, -b.y0 + 0.7);
  return Math.max(3.7, need);
}

/**
 * Dynamics and hairpins below a staff and above the next one share the gap between the two staves. Where both occur,
 * the upper-staff row is the reference and the lower staff's row moves up to its (absolute) baseline, so that they
 * read as one line — unless that would put them on top of each other horizontally.
 */
function alignDynamics(ctx: SysCtx, nS: number): void {
  const isMark = (p: Prim) => (p.k === 'dyn' || p.k === 'hairpin') && p.a !== undefined;
  const span = (p: Prim): [number, number] =>
    p.t === 'glyph'
      ? [p.x, p.x + sm.adv(p.name)]
      : p.t === 'line'
        ? [Math.min(p.x1, p.x2), Math.max(p.x1, p.x2)]
        : [0, 0];
  for (let s = 0; s + 1 < nS; s++) {
    const below = ctx.prims[s].filter((p) => isMark(p) && must(p.a) > 4);
    const above = ctx.prims[s + 1].filter((p) => isMark(p) && must(p.a) < 0);
    if (!(below.length && above.length)) continue;
    const target = ctx.staffY[s] + must(below[0].a);
    const dy = target - (ctx.staffY[s + 1] + must(above[0].a));
    // Only ever move up, away from the lower staff: dy < 0 means the lower staff's row sits below
    // the upper staff's row and has to rise to its baseline...
    if (dy >= 0) continue;
    // ... but never into the upper staff's own content (notes standing below it, ledger lines, ...):
    // `dyMin` is the lowest it may go, from the upper staff's skyline.
    let dyMin = Number.NEGATIVE_INFINITY;
    for (const p of above) {
      const [x0, x1] = span(p);
      const top = p.t === 'glyph' ? p.y - sm.bbox(p.name).y1 : p.t === 'line' ? Math.min(p.y1, p.y2) - 0.3 : 0;
      for (const b of ctx.sky[s].boxes)
        if (!b.spanner && b.x1 > x0 - 0.3 && b.x0 < x1 + 0.3)
          dyMin = Math.max(dyMin, ctx.staffY[s] - ctx.staffY[s + 1] + b.y1 + 0.3 - top);
    }
    const dyAdj = Math.min(0, Math.max(dy, dyMin));
    const clash = above.some((a) =>
      below.some((b) => {
        const [a0, a1] = span(a);
        const [b0, b1] = span(b);
        return a1 > b0 - 0.5 && a0 < b1 + 0.5;
      }),
    );
    if (clash) continue;
    for (const p of dyAdj < 0 ? above : []) {
      if (p.t === 'glyph') p.y += dyAdj;
      else if (p.t === 'line') {
        p.y1 += dyAdj;
        p.y2 += dyAdj;
      }
      p.a = must(p.a) + dyAdj;
    }
    // the lower marks could not rise all the way (content of the upper staff hangs into the gap): the upper staff's marks
    // sink to the same row instead, so that dynamics and hairpins of the two staves still read as one line
    const deficit = dyAdj - dy;
    if (deficit > 0.01) {
      for (const p of below) {
        if (p.t === 'glyph') p.y += deficit;
        else if (p.t === 'line') {
          p.y1 += deficit;
          p.y2 += deficit;
        }
        p.a = must(p.a) + deficit;
      }
    }
  }
}

/** Draws a time signature as stacked digits, each row centred on the wider one. */
function timeSig(P: Prim[], x: number, y0: number, ts: { beats: number; beatType: number }): void {
  const wn = String(ts.beats).length;
  const wd = String(ts.beatType).length;
  const w = sm.adv('timeSig2');
  const maxw = Math.max(wn, wd) * w;
  const drawC = (n: number, y: number, len: number) => {
    const off = (maxw - len * w) / 2;
    let px = x + off;
    for (const ch of String(n)) {
      P.push({ t: 'glyph', name: `timeSig${ch}`, x: px, y });
      px += w;
    }
  };
  const n0 = P.length;
  drawC(ts.beats, y0 + 1, wn);
  drawC(ts.beatType, y0 + 3, wd);
  tagFrom(P, n0, 'timesig', oid({}));
}

function shift(p: Prim, dx: number, dy: number): Prim {
  switch (p.t) {
    case 'glyph':
      return { ...p, x: p.x + dx, y: p.y + dy };
    case 'line':
      return { ...p, x1: p.x1 + dx, x2: p.x2 + dx, y1: p.y1 + dy, y2: p.y2 + dy };
    case 'text':
      return { ...p, x: p.x + dx, y: p.y + dy };
    case 'path':
      return {
        ...p,
        d: p.d.replace(
          /(-?\d*\.?\d+(?:e-?\d+)?)[ ,](-?\d*\.?\d+(?:e-?\d+)?)/gi,
          (_m, a: string, b: string) =>
            `${(Number.parseFloat(a) + dx).toFixed(3)} ${(Number.parseFloat(b) + dy).toFixed(3)}`,
        ),
      };
  }
}
