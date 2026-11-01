// Horizontal spacing: per measure, derive columns (distinct onset times), their natural widths and
// minimum distances. A system is justified by scaling the "ideal" part.
//
// Model: column j sits at x_j = max(x_{j-1} + f * ideal_j, collision constraints), where the ideal
// distance grows with the time since the previous column (`idealSpace`, a power law so that long notes
// get more but not proportionally more room), and the constraints keep the left extent of a column
// clear of the right extent of the previous one on every staff. The stretch factor `f` is solved for a
// whole system in system.ts; `COMPRESS` bounds how far a measure may be squeezed below its ideal.
import { PPQ, timeAt, type Score } from '../model.ts';
import { loadSmufl } from '../smufl.ts';
import type { Prepared, EvL, HeadL } from './prep.ts';

const sm = loadSmufl();

export function headGlyph(base: number): string { return base === 1 ? 'noteheadWhole' : base === 2 ? 'noteheadHalf' : 'noteheadBlack'; }
/** MuseScore's noteheads are a little fuller than Bravura's at the same staff size; the reference piece was set with those. */
export const HEAD_SCALE = 1.1;
export function headWidth(base: number): number { return sm.adv(headGlyph(base)) * HEAD_SCALE; }
/** Stem thickness. */
export const STEM_T = 0.12;
/** Grace notes are drawn at this fraction of the normal size. */
export const GRACE_SCALE = 0.7;
/** Distance between successive augmentation dots of a multiply dotted note (the first dot sits 0.4 right of the head). */
export const DOT_STEP = 0.55;
/** Least distance between an up-stem and the following down-stem of a cross-staff beam. */
export const CROSS_STEM_SEP = 2.0;
/** Minimum stretch factor allowed when fitting measures on a line (0.7: at most 30 % tighter than ideal). */
export const COMPRESS = 0.7;

/** Ideal distance (staff spaces) between two columns `dt` ticks apart: a fixed part plus a power law (a quarter apart: 3.0). */
export function idealSpace(dt: number): number {
  return 1.1 + 1.9 * Math.pow(dt / PPQ, 0.6);
}

/** All events starting at one tick of a measure, across staves. Columns of one tick are aligned vertically. */
export interface Column {
  tick: number;
  evs: EvL[]; // events starting here (all staves)
  ideal: number; // ideal distance from previous column (or from measure start for first)
  L: number[]; // per-staff left extent
  R: number[]; // per-staff right extent
  has: boolean[]; // per-staff: occupied
  clefChange: boolean[]; // per-staff
  clefW: number[]; // per-staff width reserved for a clef change (added to L)
  minFrom: { j: number; d: number }[]; // at least d to the right of column j (stems of a cross-staff beam)
}

/** What system layout needs to know about one measure: its columns and how narrow or wide it can get. */
export interface MeasureSpacing {
  mi: number;
  cols: Column[];
  endIdeal: number;
  lead: number; // x of first column at minimum
  endTrail: number; // required distance from last column to barline (per staff max)
  endReq: number[]; // per-staff: R of last occupied col
  prefix: number; // extra leading width (time signature change)
  timeSig?: { beats: number; beatType: number };
  minWidth: number;
  compWidth: number; // width when compressed to COMPRESS
  restOnly: boolean;
}

/**
 * Builds the columns of measure `mi` and measures it at minimum and compressed width. `skipClef0` is the
 * "first in system" variant, where a clef change at tick 0 is not drawn because the system's own clef
 * already shows it. Runs twice per measure, so everything it writes onto the `EvL`s must be idempotent.
 */
export function spaceMeasure(prep: Prepared, mi: number, skipClef0 = false): MeasureSpacing {
  const nS = prep.score.staves.length;
  const len = prep.measureLen[mi];
  const colMap = new Map<number, Column>();
  const mk = (tick: number): Column => {
    let c = colMap.get(tick);
    if (!c) { c = { tick, evs: [], ideal: 0, L: Array(nS).fill(0), R: Array(nS).fill(0), has: Array(nS).fill(false), clefChange: Array(nS).fill(false), clefW: Array(nS).fill(0), minFrom: [] }; colMap.set(tick, c); }
    return c;
  };
  let anyVisible = false;
  for (let s = 0; s < nS; s++) {
    const sml = prep.measures[mi][s];
    for (const e of sml.evs) {
      if (e.ev.kind === 'rest' && e.ev.style === 'hidden') continue;
      if (e.ev.kind === 'rest' && e.ev.style === 'measure') { mk(e.start).evs.push(e); continue; }
      anyVisible = true;
      const c = mk(e.start);
      c.evs.push(e);
      c.has[s] = true;
    }
    for (const m of sml.marks) if (m.type === 'clef' && !(skipClef0 && m.tick === 0)) { const c = mk(m.tick); c.clefChange[s] = true; c.has[s] = true; }
  }
  const cols = [...colMap.values()].sort((a, b) => a.tick - b.tick);
  const restOnly = !anyVisible;

  // Extents: how far each column reaches left and right of its x on each staff (heads, accidentals,
  // dots, graces, a clef change), which decides the minimum distance to its neighbours.
  for (let s = 0; s < nS; s++) {
    for (const c of cols) {
      const evs = c.evs.filter((e) => e.staff === s);
      if (c.clefChange[s]) c.clefW[s] = sm.adv('gClefChange') + 1.4; // clef, then clear space before the notes (and their accidentals)
      if (evs.length) layoutColumnStaff(c, s, evs);
      c.L[s] += c.clefW[s];
    }
  }
  // A cross-staff beam has up-stems on the right of their heads followed by down-stems on the left of
  // theirs; the columns involved are pushed apart (`minFrom`) so the two stems do not merge.
  {
    const colAt = new Map(cols.map((c, j) => [c.tick, j]));
    const seen = new Set<object>();
    for (const c of cols) for (const e of c.evs) {
      if (!e.beam?.cross || seen.has(e.beam)) continue;
      seen.add(e.beam);
      const ns = e.beam.notes;
      for (let k = 1; k < ns.length; k++) {
        const a = ns[k - 1], b = ns[k];
        const ja = colAt.get(a.start), jb = colAt.get(b.start);
        if (a.stem === 'up' && b.stem === 'down' && ja !== undefined && jb !== undefined && ja < jb)
          cols[jb].minFrom.push({ j: ja, d: headWidth(a.te.ev.dur.base) + CROSS_STEM_SEP });
      }
    }
  }
  // Ideal distances: from each column to the previous one by elapsed time. `endIdeal` is the
  // distance from the last column to the barline, by the time left in the measure.
  let prevTick = 0;
  cols.forEach((c, i) => { c.ideal = i === 0 ? 0 : idealSpace(c.tick - prevTick); prevTick = c.tick; });
  const lastTick = cols.length ? cols[cols.length - 1].tick : 0;
  const endIdeal = cols.length ? idealSpace(len - lastTick) : idealSpace(len);

  const tsChanged = mi > 0 && prep.score.measures[mi].time;
  const timeSig = tsChanged ? timeAt(prep.score, mi) : undefined;
  const prefix = timeSig ? Math.max(sm.adv('timeSig2') * String(timeSig.beats).length, sm.adv('timeSig2') * String(timeSig.beatType).length) + 1.2 : 0;
  const lead = 0.9 + prefix + Math.max(0, ...cols.slice(0, 1).flatMap((c) => c.L));
  const endReq: number[] = Array(nS).fill(0);
  for (let s = 0; s < nS; s++) for (const c of cols) if (c.has[s]) endReq[s] = c.R[s];
  const sp: MeasureSpacing = { mi, cols, endIdeal, lead, endTrail: 0.75, endReq, prefix, timeSig, minWidth: 0, compWidth: 0, restOnly };
  sp.minWidth = placeMeasure(sp, 1).width;
  sp.compWidth = placeMeasure(sp, COMPRESS).width;
  return sp;
}

function layoutColumnStaff(c: Column, s: number, evs: EvL[]): void {
  let L = 0, R = 0;
  // spaceMeasure runs more than once per measure and writes onto shared EvL/HeadL objects, so start
  // from a clean state each time; everything below must be a pure function of the model.
  for (const e of evs) {
    e.shiftDx = 0;
    for (const h of e.heads) { h.dx = 0; h.shared = false; h.skipDots = false; h.accX = undefined; h.sharers = undefined; }
  }
  // --- Voice collisions. A head of a later voice that sits on the same position as one of the first
  // voice (a unison) shares it when the two are indistinguishable or have opposite stems and the same
  // head shape; other clashes (heads a step or less apart, or a head on the other voice's stem) shift
  // the later voice to the right.
  const notesEvs = evs.filter((e) => e.ev.kind === 'note');
  if (notesEvs.length > 1) {
    const first = notesEvs.filter((e) => e.voiceRank === 0);
    for (const e of notesEvs.filter((x) => x.voiceRank > 0)) {
      const d = e.te.ev.dur;
      for (const h of e.heads)
        for (const f of first) {
          const fd = f.te.ev.dur;
          const sameDur = fd.base === d.base && fd.dots === d.dots;
          // Distinguishable by opposite stems and the same head shape: one head serves both voices
          // (the two stems attach to it), which is how unisons between voices are usually written.
          const distinct = !!f.stem && !!e.stem && f.stem !== e.stem && headGlyph(fd.base) === headGlyph(d.base);
          const host = (sameDur || distinct) ? f.heads.find((g) => g.pos === h.pos && g.pitch.alter === h.pitch.alter && !g.shared) : undefined;
          if (host) { h.shared = true; h.skipDots = fd.dots >= d.dots; (host.sharers ??= []).push(e); }
        }
      let clash = false;
      for (const h of e.heads) if (!h.shared) for (const f of first) for (const g of f.heads) if (Math.abs(h.pos - g.pos) <= 1) clash = true;
      // A head standing on the stem of the other voice (or the other way round): move this voice
      // aside. `stemSpan` is the staff-position range a voice's heads and stem cover.
      const stemSpan = (x: EvL): [number, number] => {
        const ps = x.heads.map((q) => q.pos), lo = Math.min(...ps), hi = Math.max(...ps);
        return x.stem === 'up' ? [lo, hi + 7] : x.stem === 'down' ? [lo - 7, hi] : [lo, hi];
      };
      for (const f of first) {
        const [fl, fh] = stemSpan(f), [el, eh] = stemSpan(e);
        if (e.heads.some((h) => !h.shared && h.pos > fl && h.pos <= fh && f.stem) && f.stem !== null) clash = true;
        if (f.heads.some((g) => g.pos >= el && g.pos < eh && e.stem)) clash = true;
      }
      if (clash) { e.shiftDx = headWidth(e.te.ev.dur.base); for (const h of e.heads) if (!h.shared) h.dx += e.shiftDx; }
    }
  }
  const heads: { h: HeadL; e: EvL }[] = [];
  for (const e of evs) {
    if (e.ev.kind === 'note') {
      const w = headWidth(e.te.ev.dur.base);
      for (const h of e.heads) {
        if (h.shared) continue;
        if (h.displaced) h.dx += e.stem === 'down' ? -(w - STEM_T) : w - STEM_T;
        heads.push({ h, e });
        L = Math.max(L, -h.dx);
        let r = h.dx + w;
        if (h.pos <= -2 || h.pos >= 10) r += sm.def.legerLineExtension as number; // its ledger line reaches beyond the head
        const dots = e.te.ev.dur.dots;
        if (dots) r += 0.4 + DOT_STEP * dots;
        R = Math.max(R, r);
      }
      if (e.stem === 'up' && e.te.ev.dur.base >= 8 && !e.beam && !e.tremPair) R = Math.max(R, Math.max(...e.heads.map((h) => h.dx)) + w + 0.9);
    } else if (e.ev.style !== 'hidden') {
      const g = restGlyph(e.te.ev.dur.base, e.ev.style === 'measure');
      R = Math.max(R, e.ev.style === 'measure' ? 0 : sm.adv(g) + (e.te.ev.dur.dots ? 0.4 + DOT_STEP * e.te.ev.dur.dots : 0));
    }
  }
  // --- Accidental stacking: all heads of this staff column together. Accidentals are placed in columns
  // to the left of the heads, the highest first, each in the first column where it does not overlap one
  // already there (the usual zig-zag).
  const accHeads = heads.filter((x) => x.h.acc).sort((a, b) => b.h.pos - a.h.pos);
  if (accHeads.length) {
    const leftEdge = Math.min(...heads.map((x) => x.h.dx));
    const stacks: { pos: number; h: number; w: number }[][] = [];
    const info = accHeads.map((x) => {
      const g = x.h.acc!.glyph;
      const w = sm.adv(g) + (x.h.acc!.cautionary ? sm.adv('accidentalParensLeft') + sm.adv('accidentalParensRight') : 0);
      const hh = g === 'accidentalSharp' || g === 'accidentalNatural' ? 6 : g === 'accidentalDoubleSharp' ? 4 : 5;
      return { x, w, hh };
    });
    const colOf: number[] = [];
    info.forEach((it, idx) => {
      let k = 0;
      for (;; k++) {
        const st = stacks[k] ?? [];
        if (st.every((q) => Math.abs(q.pos - it.x.h.pos) >= (q.h + it.hh) / 2)) break;
      }
      (stacks[k] ??= []).push({ pos: it.x.h.pos, h: it.hh, w: it.w });
      colOf[idx] = k;
    });
    const colW = stacks.map((st) => Math.max(...st.map((q) => q.w)));
    const colRight: number[] = [];
    // An accidental level with a ledger line must clear the line's extension as well: the ledger
    // line sticks out to the left of the head by `legerLineExtension`, and the accidental would
    // otherwise sit on it.
    const own = heads.filter((x) => !x.h.shared);
    const pMin = Math.min(...own.map((x) => x.h.pos)), pMax = Math.max(...own.map((x) => x.h.pos));
    const ledgerHit = info.some((it) => {
      const half = it.hh / 2 + 0.3;
      for (let p = -2; p >= pMin; p -= 2) if (Math.abs(p - it.x.h.pos) < half) return true;
      for (let p = 10; p <= pMax; p += 2) if (Math.abs(p - it.x.h.pos) < half) return true;
      return false;
    });
    let edge = leftEdge - 0.2 - (ledgerHit ? (sm.def.legerLineExtension as number) : 0);
    stacks.forEach((_, k) => { colRight[k] = edge; edge -= colW[k] + 0.12; });
    info.forEach((it, idx) => {
      const k = colOf[idx];
      it.x.h.accX = colRight[k] - it.w; // left edge of the (possibly parenthesised) glyph
    });
    L = Math.max(L, -(edge + 0.12));
  }
  // --- The arpeggio wiggle sits left of everything, including accidentals, and takes a fixed
  // width (wiggle plus the space between it and the accidentals).
  if (evs.some((e) => e.ev.kind === 'note' && e.ev.arpeggio)) L += 0.5 + 0.9;
  // --- Grace notes stand to the left of the note (and its accidentals) they belong to. This
  // reserves their width in the column's left extent; `drawGraces` draws them at that place.
  const L0 = L;
  for (const e of evs) {
    if (e.ev.kind !== 'note' || !e.graces?.length) continue;
    const gls = e.graces;
    let x = -(L0 + 0.3 + (gls.length === 1 && gls[0].g.base >= 8 ? 0.7 : 0)); // right edge of the nearest grace note (a lone flag reaches out to the right)
    for (let k = gls.length - 1; k >= 0; k--) {
      const gl = gls[k];
      gl.hw = headWidth(gl.g.base) * GRACE_SCALE;
      gl.dx = x - gl.hw;
      let left = gl.dx;
      const accs = gl.heads.filter((h) => h.acc);
      if (accs.length) {
        const aw = Math.max(...accs.map((h) => sm.adv(h.acc!.glyph))) * GRACE_SCALE;
        const gap = 0.1 + (gl.heads.some((h) => h.acc && (h.pos <= -2 || h.pos >= 10)) ? (sm.def.legerLineExtension as number) * GRACE_SCALE : 0); // clear of a ledger line
        for (const h of accs) h.accX = gl.dx - gap - aw;
        left = gl.dx - gap - aw;
      }
      L = Math.max(L, -left);
      x = left - 0.45;
    }
  }
  c.L[s] = Math.max(c.L[s], L);
  c.R[s] = Math.max(c.R[s], R);
  c.has[s] = true;
}

export function restGlyph(base: number, measure?: boolean): string {
  if (measure) return 'restWhole';
  return base === 1 ? 'restWhole' : base === 2 ? 'restHalf' : base === 4 ? 'restQuarter' : base === 8 ? 'rest8th' : base === 16 ? 'rest16th' : base === 32 ? 'rest32nd' : 'rest64th';
}

export interface PlacedMeasure { xs: number[]; width: number; endX: number }

/** Place columns for stretch factor f (f=1 natural). x = 0 at the measure's left edge. */
export function placeMeasure(sp: MeasureSpacing, f: number): PlacedMeasure {
  const nS = sp.endReq.length;
  const xs: number[] = [];
  const lastOcc: number[] = Array(nS).fill(-1);
  sp.cols.forEach((c, j) => {
    let x = j === 0 ? sp.lead : xs[j - 1] + f * c.ideal;
    for (let s = 0; s < nS; s++) {
      if (!c.has[s]) continue;
      const i = lastOcc[s];
      if (i >= 0) x = Math.max(x, xs[i] + sp.cols[i].R[s] + c.L[s] + 0.47);
      lastOcc[s] = j;
    }
    for (const m of c.minFrom) x = Math.max(x, xs[m.j] + m.d);
    if (j === 0) x = Math.max(x, sp.lead);
    xs.push(x);
  });
  const last = xs.length ? xs[xs.length - 1] : sp.lead;
  let endX = last + f * sp.endIdeal;
  if (sp.cols.length === 0 || sp.restOnly) endX = Math.max(endX, sp.lead + 5.5 * Math.min(1.5, f));
  for (let s = 0; s < nS; s++) if (lastOcc[s] >= 0) endX = Math.max(endX, xs[lastOcc[s]] + sp.cols[lastOcc[s]].R[s] + sp.endTrail);
  return { xs, width: endX, endX };
}

export function systemMinWidths(prep: Prepared): MeasureSpacing[] {
  return prep.score.measures.map((_, mi) => spaceMeasure(prep, mi));
}
export type { Score };
