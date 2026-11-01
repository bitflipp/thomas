// Drawing of notes, rests, stems, beams, tuplets etc. into staff-local primitives.
import { isTuplet, type TupletGroup, type Clef } from '../model.ts';
import { loadSmufl } from '../smufl.ts';
import { posToY, beamLevels, type EvL, type BeamL, type Prepared } from './prep.ts';
import { headGlyph, headWidth, HEAD_SCALE, GRACE_SCALE, restGlyph, STEM_T, DOT_STEP, type MeasureSpacing, type PlacedMeasure } from './spacing.ts';
import { Skyline, tagFrom, oid, type Prim } from './scene.ts';

const sm = loadSmufl();
export const D = new Proxy({} as typeof sm.def, { get: (_, k) => sm.def[k as string] }); // lazy: the font may not be loaded yet

export interface SysCtx {
  prep: Prepared;
  index: number;
  a: number; b: number; // first / last measure index (inclusive)
  spacing: MeasureSpacing[]; // indexed by measure index (the variant actually used)
  placed: PlacedMeasure[]; // indexed by measure index
  mx: number[]; // measure left x (system-local), by measure index
  prefix: number; // width before first measure
  width: number;
  f: number;
  prims: Prim[][]; // per staff, staff-local
  sky: Skyline[];
  staffY: number[]; // y of each staff's top line (system-local)
  barlines: { x: number; type: 'single' | 'final' | 'double'; mi: number }[];
  tupletBoxes: [number, number][];
  /** staff-to-staff gap (bottom of staff s-1 to top of staff s) that cross-staff geometry is drawn for; finalize must keep it */
  gap: number[];
  /** per staff: gap required by the cross-staff beams drawn with `gap` (may be smaller than `gap`) */
  gapNeed: number[];
  pinned?: boolean; // gap[] is final (the system has cross-staff beams)
}
export const CROSS_GAP0 = 6;

export function glyphCentered(name: string, cx: number, cy: number): Prim {
  const b = sm.bbox(name);
  return { t: 'glyph', name, x: cx - (b.x0 + b.x1) / 2, y: cy + (b.y0 + b.y1) / 2 };
}

export function xAtTick(ctx: SysCtx, mi: number, tick: number): number {
  const sp = ctx.spacing[mi];
  const pl = ctx.placed[mi];
  const base = ctx.mx[mi];
  const len = ctx.prep.measureLen[mi];
  if (tick >= len) return base + pl.endX;
  const cols = sp.cols;
  if (!cols.length) return base + sp.lead + (pl.endX - sp.lead) * (tick / len);
  if (tick <= cols[0].tick) {
    if (cols[0].tick === 0) return base + pl.xs[0];
    return base + sp.lead + (pl.xs[0] - sp.lead) * (tick / cols[0].tick);
  }
  for (let j = 0; j < cols.length; j++) {
    if (cols[j].tick === tick) return base + pl.xs[j];
    if (cols[j].tick > tick) {
      const t0 = cols[j - 1].tick, t1 = cols[j].tick;
      return base + pl.xs[j - 1] + ((pl.xs[j] - pl.xs[j - 1]) * (tick - t0)) / (t1 - t0);
    }
  }
  const j = cols.length - 1;
  return base + pl.xs[j] + ((pl.endX - pl.xs[j]) * (tick - cols[j].tick)) / (len - cols[j].tick);
}

function pushBox(ctx: SysCtx, s: number, x0: number, x1: number, y0: number, y1: number) { ctx.sky[s].add(x0, x1, y0, y1); }

function stemLength(levels: number): number { return levels <= 2 ? 3.5 : 3.5 + 0.75 * (levels - 2); }

export interface Geom { homed?: boolean; shift: number; x: number; hw: number; yTop: number; yBot: number; stemX: number; stemTip: number; stemBase: number; headL: number; headR: number }
export const geomOf = new WeakMap<EvL, Geom>();
/** Outer edge (y) of the articulation stack of a note and the side it is on; slurs on that side start beyond it. */
export const articExtent = new WeakMap<EvL, { above: boolean; edge: number }>();

interface LedgerSeg { prim: Prim; s: number; y: number; x0: number; x1: number; hx0: number; hx1: number }
let ledgerSegs: LedgerSeg[] = [];

/** Neighbouring notes must not have their ledger lines run into each other: leave a gap, trimming both sides evenly. */
function trimLedgers(ctx: SysCtx): void {
  const GAP = 0.35;
  const groups = new Map<string, LedgerSeg[]>();
  for (const l of ledgerSegs) {
    const k = `${l.s}|${l.y.toFixed(3)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(l);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.hx0 - b.hx0 || a.x0 - b.x0);
    let a = list[0];
    for (let i = 1; i < list.length; i++) {
      const b = list[i];
      const deficit = GAP - (b.x0 - a.x1);
      if (deficit <= 0) { a = b; continue; }
      // never cut into the head itself; the rest of the deficit falls on the other side
      const ra = Math.max(0, a.x1 - (a.hx1 + 0.05)), rb = Math.max(0, (b.hx0 - 0.05) - b.x0);
      const ta = Math.min(ra, deficit / 2), tb = Math.min(rb, deficit - ta);
      const ta2 = Math.min(ra, deficit - tb);
      a.x1 -= ta2; b.x0 += tb;
      // no room for a gap (heads nearly on top of each other): the two lines become one
      if (b.x0 < a.x1 + GAP / 2) { a.x1 = Math.max(a.x1, b.x1); b.x0 = b.x1 = NaN; } else a = b;
    }
  }
  const dead = new Set<Prim>();
  for (const l of ledgerSegs) {
    if (Number.isNaN(l.x0)) { dead.add(l.prim); continue; }
    const p = l.prim as { x1: number; x2: number }; p.x1 = l.x0; p.x2 = l.x1;
  }
  if (dead.size) ctx.prims.forEach((arr, k) => { ctx.prims[k] = arr.filter((q) => !dead.has(q)); });
}

/** y of the top line of staff `to` relative to that of staff `from`, for the gaps cross-staff geometry is drawn with */
export function staffOffset(ctx: SysCtx, from: number, to: number): number {
  let y = 0;
  for (let k = from + 1; k <= to; k++) y += 4 + ctx.gap[k];
  for (let k = to + 1; k <= from; k++) y -= 4 + ctx.gap[k];
  return y;
}

export function drawSystemNotes(ctx: SysCtx): void {
  const { prep } = ctx;
  ledgerSegs = [];
  const nS = prep.score.staves.length;
  const levelsFor = (e: EvL) => beamLevels(e.te.ev.dur.base);

  for (let mi = ctx.a; mi <= ctx.b; mi++) {
    const sp = ctx.spacing[mi];
    const pl = ctx.placed[mi];
    const colIndex = new Map(sp.cols.map((c, j) => [c.tick, j]));
    for (let s = 0; s < nS; s++) {
      const sml = prep.measures[mi][s];
      // ---- 1. position events
      for (const e of sml.evs) {
        if (e.ev.kind === 'rest' && e.ev.style === 'measure') { e.x = ctx.mx[mi] + (sp.lead + pl.endX) / 2 - sm.adv('restWhole') / 2; continue; }
        const j = colIndex.get(e.start);
        e.x = j === undefined ? xAtTick(ctx, mi, e.start) : ctx.mx[mi] + pl.xs[j];
      }
      // ---- 2. notes: heads, ledger, accidentals, dots, arpeggio
      for (const e of sml.evs) {
        if (e.ev.kind === 'rest') {
          // a whole-measure rest gives way to notes crossing over from another staff
          const crossedOver = e.ev.style === 'measure' && sml.evs.some((o) => o.home !== s && o.ev.kind === 'note');
          if (e.ev.style !== 'hidden' && !crossedOver) drawRest(ctx, e, s);
          continue;
        }
        drawNoteBasics(ctx, e, s);
        if (e.graces) drawGraces(ctx, e, s);
      }
    }
    for (let s = 0; s < nS; s++) {
      const sml = prep.measures[mi][s];
      // ---- 3. stems & beams per voice (a cross-staff note's stem is drawn on the staff it sits on, a cross-staff beam on the voice's)
      for (const v of sml.voices) {
        const doneBeams = new Set<object>();
        for (const e of v.evs) {
          if (e.ev.kind !== 'note') continue;
          const g = geomOf.get(e)!;
          if (e.beam) {
            if (doneBeams.has(e.beam)) continue;
            doneBeams.add(e.beam);
            if (e.beam.cross) drawCrossBeam(ctx, e.beam, s, levelsFor);
            else drawBeamGroup(ctx, e.beam.notes, e.staff, levelsFor);
          } else if (e.tremPair && e.tremIsFirst) {
            drawTremoloPair(ctx, e, e.tremPair, e.staff);
          } else if (e.tremPair) { /* drawn with partner */ }
          else if (e.stem) {
            const lv = levelsFor(e);
            let len = stemLength(Math.max(1, lv));
            // a displaced head right of an up-stem would run into the flag
            if (e.stem === 'up' && e.te.ev.dur.base >= 8 && e.heads.some((h) => h.dx > g.hw / 2 && !h.shared)) len += 0.6;
            if (e.stem === 'down' && e.te.ev.dur.base >= 8) len += 0.3; // the flag curls up towards the (wider) head
            setStem(e, g, len);
            drawStem(ctx, e, g, e.staff, true);
          }
        }
      }
    }
    for (let s = 0; s < nS; s++) {
      const sml = prep.measures[mi][s];
      // ---- 4. articulations (need stems)
      for (const e of sml.evs) if (e.ev.kind === 'note' && e.ev.art?.length) drawArticulations(ctx, e, s);
      // ---- 5. tuplets
      const seen = new Set<TupletGroup>();
      for (const v of sml.voices) for (const e of v.evs) for (const t of e.tupletKeys) if (!seen.has(t)) {
        seen.add(t);
        const members = v.evs.filter((x) => x.tupletKeys.includes(t));
        // over a beam between two staves the bracket cannot avoid the stems in the gap: it goes above the upper staff's notes
        const at = members.some((x) => x.beam?.cross) ? Math.min(...members.map((x) => x.staff)) : s;
        if (at !== s || members.some((x) => x.staff !== s)) withHomeGeometry(ctx, members, at, () => drawTuplet(ctx, t, members, at));
        else drawTuplet(ctx, t, members, s);
      }
    }
  }
  trimLedgers(ctx);
}

/** Runs `fn` with the geometry of members expressed in the coordinates of staff `target`. */
function withHomeGeometry(ctx: SysCtx, evs: EvL[], target: number, fn: () => void): void {
  const saved = new Map<EvL, Geom>();
  for (const e of evs) {
    const g = geomOf.get(e);
    if (!g) continue;
    const dh = staffOffset(ctx, target, e.staff); // heads are in the coordinates of their own staff
    const ds = staffOffset(ctx, target, g.homed ? e.home : e.staff); // stems of cross-staff beams are in those of the voice's
    if (!dh && !ds) continue;
    saved.set(e, g);
    geomOf.set(e, { ...g, yTop: g.yTop + dh, yBot: g.yBot + dh, stemBase: g.stemBase + ds, stemTip: g.stemTip + ds });
  }
  fn();
  for (const [e, g] of saved) geomOf.set(e, g);
}

/**
 * A beam between two staves, drawn in the coordinates of the voice's staff. Stems of the upper staff's notes point down,
 * those of the lower staff's up, and the beam (flat) runs in the gap between: when the gap is too small `ctx.gapNeed`
 * says how large it must be.
 */
function drawCrossBeam(ctx: SysCtx, beam: BeamL, home: number, levelsFor: (e: EvL) => number): void {
  const notes = beam.notes;
  const maxLv = Math.max(...notes.map(levelsFor));
  const bt = D.beamThickness as number, bs = D.beamSpacing as number;
  const inner = (maxLv - 1) * (bt + bs) + bt;
  const gs = notes.map((n) => geomOf.get(n)!);
  const off = notes.map((n) => staffOffset(ctx, home, n.staff));
  const MIN = 3.0;
  let lo = -Infinity, hi = Infinity; // admissible y of the beam's top edge
  notes.forEach((n, i) => {
    const g = gs[i];
    g.stemX = n.stem === 'up' ? g.x + g.shift + g.hw - STEM_T / 2 : g.x + g.shift + STEM_T / 2;
    // stems run to the outer edge of the beam stack: the bottom for the upper staff's, the top for the lower staff's
    if (n.stem === 'down') lo = Math.max(lo, g.yBot + off[i] + MIN - inner); else hi = Math.min(hi, g.yTop + off[i] - MIN);
  });
  // the beam lives in the gap: centre it where there is room
  const a = Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : Number.isFinite(lo) ? lo : hi;
  if (Number.isFinite(lo) && Number.isFinite(hi)) {
    // growing the gap between the staves by d raises hi (or lowers lo) by d
    const low = Math.max(...notes.map((n) => n.staff));
    ctx.gapNeed[low] = Math.max(ctx.gapNeed[low], ctx.gap[low] + (lo - hi));
  }
  notes.forEach((n, i) => {
    const g = gs[i];
    g.homed = true;
    g.stemBase = n.stem === 'up' ? g.yBot + off[i] - 0.168 : g.yTop + off[i] + 0.168;
    g.stemTip = n.stem === 'up' ? a : a + inner;
    drawStem(ctx, n, g, home, false, true);
  });
  beam.crossY = [a, a + inner];
  const n0 = ctx.prims[home].length;
  for (let lv = 1; lv <= maxLv; lv++) {
    const y0 = a + (lv - 1) * (bt + bs);
    let i = 0;
    while (i < notes.length) {
      if (levelsFor(notes[i]) < lv) { i++; continue; }
      let j = i;
      while (j + 1 < notes.length && levelsFor(notes[j + 1]) >= lv && !restBetween(notes[j], notes[j + 1], beam.evs, lv)) j++;
      let xa: number, xb: number;
      if (j > i) { xa = gs[i].stemX - STEM_T / 2; xb = gs[j].stemX + STEM_T / 2; }
      else if (i === 0 || (i < notes.length - 1 && notes[i + 1].start - notes[i].start < notes[i].start - notes[i - 1].start)) { xa = gs[i].stemX - STEM_T / 2; xb = gs[i].stemX + 1.1; }
      else { xa = gs[i].stemX - 1.1; xb = gs[i].stemX + STEM_T / 2; }
      ctx.prims[home].push({ t: 'path', d: `M${xa.toFixed(3)} ${y0.toFixed(3)}L${xb.toFixed(3)} ${y0.toFixed(3)}L${xb.toFixed(3)} ${(y0 + bt).toFixed(3)}L${xa.toFixed(3)} ${(y0 + bt).toFixed(3)}Z` });
      i = j + 1;
    }
  }
  tagFrom(ctx.prims[home], n0, 'beam', beam);
}

function setStem(e: EvL, g: Geom, len: number): void {
  const up = e.stem === 'up';
  let tip = up ? g.yTop - len : g.yBot + len;
  if (up) tip = Math.min(tip, 2); else tip = Math.max(tip, 2);
  g.stemTip = tip;
}

function stemGroups(e: EvL): (object | undefined)[] {
  return [e.beam, e.tremPair ? (e.tremIsFirst ? e : e.tremPair) : undefined, ...e.tupletKeys];
}

function drawStem(ctx: SysCtx, e: EvL, g: Geom, s: number, flag: boolean, noSky = false): void {
  const up = e.stem === 'up';
  const n0 = ctx.prims[s].length;
  ctx.prims[s].push({ t: 'line', x1: g.stemX, y1: g.stemBase, x2: g.stemX, y2: g.stemTip + (up ? 0 : 0), w: STEM_T });
  tagFrom(ctx.prims[s], n0, 'stem', e, stemGroups(e));
  const base = e.te.ev.dur.base;
  if (flag && base >= 8 && !e.beam) {
    const n = beamLevels(base);
    const name = `flag${n === 1 ? '8th' : n === 2 ? '16th' : n === 3 ? '32nd' : '64th'}${up ? 'Up' : 'Down'}`;
    ctx.prims[s].push({ t: 'glyph', name, x: g.stemX - STEM_T / 2, y: g.stemTip });
    tagFrom(ctx.prims[s], ctx.prims[s].length - 1, 'flag', e, stemGroups(e));
    const b = sm.bbox(name);
    pushBox(ctx, s, g.stemX, g.stemX + b.x1, Math.min(g.stemTip, g.stemTip - b.y1), Math.max(g.stemTip, g.stemTip - b.y0));
  }
  const lo = Math.min(g.stemBase, g.stemTip), hi = Math.max(g.stemBase, g.stemTip);
  if (!noSky) pushBox(ctx, s, g.stemX - STEM_T / 2, g.stemX + STEM_T / 2, lo, hi);
}

function drawNoteBasics(ctx: SysCtx, e: EvL, s: number): void {
  const prims = ctx.prims[s];
  const base = e.te.ev.dur.base;
  const hw = headWidth(base);
  const gl = headGlyph(base);
  const ys = e.heads.map((h) => posToY(h.pos));
  const yTop = Math.min(...ys), yBot = Math.max(...ys);
  const minDx = Math.min(...e.heads.map((h) => h.dx));
  const maxDx = Math.max(...e.heads.map((h) => h.dx));
  for (const [hi, h] of e.heads.entries()) {
    if (h.shared) continue;
    prims.push({ t: 'glyph', name: gl, x: e.x + h.dx, y: posToY(h.pos), sx: HEAD_SCALE, sy: 1 });
    tagFrom(prims, prims.length - 1, 'head', e, h.sharers);
    prims[prims.length - 1].n = hi;
    const nAcc = prims.length;
    if (h.acc) {
      const ax = e.x + h.accX!;
      const ay = posToY(h.pos);
      if (h.acc.cautionary) {
        const pw = sm.adv('accidentalParensLeft');
        prims.push({ t: 'glyph', name: 'accidentalParensLeft', x: ax, y: ay });
        prims.push({ t: 'glyph', name: h.acc.glyph, x: ax + pw, y: ay });
        prims.push({ t: 'glyph', name: 'accidentalParensRight', x: ax + pw + sm.adv(h.acc.glyph), y: ay });
        const cb = sm.bbox(h.acc.glyph);
        pushBox(ctx, s, ax, ax + pw * 2 + sm.adv(h.acc.glyph), ay - cb.y1 - 0.1, ay - cb.y0 + 0.1);
      } else {
        prims.push({ t: 'glyph', name: h.acc.glyph, x: ax, y: ay });
        const ab = sm.bbox(h.acc.glyph);
        pushBox(ctx, s, ax + ab.x0, ax + ab.x1, ay - ab.y1 - 0.1, ay - ab.y0 + 0.1);
      }
    }
    tagFrom(prims, nAcc, 'acc', e);
    for (let i = nAcc; i < prims.length; i++) prims[i].n = hi;
  }
  // ledger lines
  const ledgerExt = D.legerLineExtension as number;
  const own = e.heads.filter((h) => !h.shared);
  if (own.length) {
    const posMin = Math.min(...own.map((h) => h.pos)), posMax = Math.max(...own.map((h) => h.pos));
    // a ledger line is needed where a head sits on it or beyond it (not for the space just outside the staff);
    // it extends over those heads only (not over the displaced heads of the rest of the chord)
    const ledger = (p: number, reach: typeof own) => {
      const d0 = Math.min(...reach.map((h) => h.dx)), d1 = Math.max(...reach.map((h) => h.dx));
      const lx0 = e.x + d0 - ledgerExt, lx1 = e.x + d1 + hw + ledgerExt;
      const prim: Prim = { t: 'line', x1: lx0, x2: lx1, y1: posToY(p), y2: posToY(p), w: D.legerLineThickness as number };
      prim.k = 'ledger'; prim.o = oid(e); prim.r = e.ev;
      prims.push(prim);
      ledgerSegs.push({ prim, s, y: posToY(p), x0: lx0, x1: lx1, hx0: e.x + d0, hx1: e.x + d1 + hw });
    };
    for (let p = -2; p >= posMin; p -= 2) ledger(p, own.filter((h) => h.pos <= p + 1));
    for (let p = 10; p <= posMax; p += 2) ledger(p, own.filter((h) => h.pos >= p - 1));
  }
  // dots
  const dots = e.te.ev.dur.dots;
  const nDots = prims.length;
  if (dots) {
    const seen = new Set<number>();
    for (const h of e.heads) {
      if (h.shared && h.skipDots) continue;
      let p = h.pos;
      if (p % 2 === 0) p += 1; // dots go in the space above a line
      if (seen.has(p)) continue;
      seen.add(p);
      for (let k = 0; k < dots; k++) prims.push({ t: 'glyph', name: 'augmentationDot', x: e.x + maxDx + hw + 0.4 + k * DOT_STEP, y: posToY(p) });
    }
  }
  tagFrom(prims, nDots, 'dot', e);
  // geometry & stem anchors
  const stemX = e.stem === 'up' ? e.x + e.shiftDx + hw - STEM_T / 2 : e.x + e.shiftDx + STEM_T / 2;
  const g: Geom = {
    shift: e.shiftDx, x: e.x, hw, yTop: yTop, yBot: yBot, stemX, stemTip: 0,
    stemBase: e.stem === 'up' ? yBot - 0.168 * HEAD_SCALE : yTop + 0.168 * HEAD_SCALE,
    headL: e.x + minDx, headR: e.x + maxDx + hw,
  };
  geomOf.set(e, g);
  pushBox(ctx, s, g.headL, g.headR + (dots ? 0.4 + DOT_STEP * dots : 0), yTop - 0.5, yBot + 0.5);
  if (e.stem === null) g.stemTip = g.stemBase;
  // arpeggio
  if (e.ev.kind === 'note' && e.ev.arpeggio) {
    const accMin = Math.min(0, ...e.heads.map((h) => h.accX ?? 0), minDx);
    const right = e.x + accMin - 0.3;
    const seg = sm.bbox('wiggleArpeggiatoUp');
    const step = sm.adv('wiggleArpeggiatoUp');
    const top = yTop - 0.4, bot = yBot + 0.4;
    const n = Math.max(1, Math.ceil((bot - top) / step));
    const w = seg.y1 - seg.y0;
    // the glyph is a horizontal segment: rotate it 90 degrees and stack upwards from the bottom note
    const nArp = prims.length;
    for (let k = 0; k < n; k++) prims.push({ t: 'glyph', name: 'wiggleArpeggiatoUp', x: right, y: bot - k * step + seg.x0, rot: -90 });
    tagFrom(prims, nArp, 'arpeggio', e);
    pushBox(ctx, s, right - w, right, top - 0.2, bot + 0.2);
  }
}

/** Grace notes: small heads with their own up-stems, a flag or beams, and a slash for an acciaccatura. */
function drawGraces(ctx: SysCtx, e: EvL, s: number): void {
  const gls = e.graces!;
  const prims = ctx.prims[s];
  const GS = GRACE_SCALE;
  const STEM = 0.1, STEM_LEN = 2.7;
  const bt = (D.beamThickness as number) * 0.8, bs = (D.beamSpacing as number) * 0.8;
  const ext = (D.legerLineExtension as number) * GS;
  // runs of beamed grace notes (consecutive, eighth or shorter)
  const runOf: (object | undefined)[] = [];
  for (let i = 0; i < gls.length;) {
    let j = i;
    while (j < gls.length && gls[j].g.base >= 8) j++;
    if (j - i >= 2) { const run = {}; for (let k = i; k < j; k++) runOf[k] = run; i = j; } else i = Math.max(j, i + 1);
  }
  const tag = (from: number, k: 'head' | 'acc' | 'ledger' | 'stem' | 'flag' | 'beam', gl: (typeof gls)[number], i: number) => {
    tagFrom(prims, from, k, gl.g, runOf[i] ? [runOf[i]] : undefined);
    for (let q = from; q < prims.length; q++) prims[q].r = e.ev;
  };
  const geo = gls.map((gl, i) => {
    const ys = gl.heads.map((h) => posToY(h.pos));
    const yTop = Math.min(...ys), yBot = Math.max(...ys);
    const x = e.x + gl.dx;
    const stemX = x + gl.hw - STEM / 2;
    gl.heads.forEach((h) => {
      const n0 = prims.length;
      prims.push({ t: 'glyph', name: headGlyph(gl.g.base), x, y: posToY(h.pos), sx: HEAD_SCALE * GS, sy: GS });
      tag(n0, 'head', gl, i);
      if (h.acc) {
        const n1 = prims.length;
        const ax = e.x + h.accX!;
        prims.push({ t: 'glyph', name: h.acc.glyph, x: ax, y: posToY(h.pos), sx: GS, sy: GS });
        tag(n1, 'acc', gl, i);
        const ab = sm.bbox(h.acc.glyph);
        pushBox(ctx, s, ax + ab.x0 * GS, ax + ab.x1 * GS, posToY(h.pos) - ab.y1 * GS - 0.1, posToY(h.pos) - ab.y0 * GS + 0.1);
      }
    });
    const posMin = Math.min(...gl.heads.map((h) => h.pos)), posMax = Math.max(...gl.heads.map((h) => h.pos));
    const ledger = (p: number) => {
      const n0 = prims.length;
      const prim: Prim = { t: 'line', x1: x - ext, x2: x + gl.hw + ext, y1: posToY(p), y2: posToY(p), w: D.legerLineThickness as number };
      prims.push(prim);
      tag(n0, 'ledger', gl, i);
      ledgerSegs.push({ prim, s, y: posToY(p), x0: x - ext, x1: x + gl.hw + ext, hx0: x, hx1: x + gl.hw });
    };
    for (let p = -2; p >= posMin; p -= 2) ledger(p);
    for (let p = 10; p <= posMax; p += 2) ledger(p);
    return { yTop, yBot, x, stemX, tip: Math.min(yTop - STEM_LEN, 2) };
  });
  // stems, then flags or beams
  const stem = (i: number, tip: number) => {
    const gl = gls[i], g = geo[i];
    if (gl.g.base < 2) return;
    const n0 = prims.length;
    prims.push({ t: 'line', x1: g.stemX, y1: g.yBot - 0.168 * GS, x2: g.stemX, y2: tip, w: STEM });
    tag(n0, 'stem', gl, i);
  };
  for (let i = 0; i < gls.length;) {
    const run = runOf[i];
    if (!run) {
      const gl = gls[i], g = geo[i];
      stem(i, g.tip);
      if (gl.g.base >= 8) {
        const n = beamLevels(gl.g.base);
        const name = `flag${n === 1 ? '8th' : n === 2 ? '16th' : n === 3 ? '32nd' : '64th'}Up`;
        const n0 = prims.length;
        prims.push({ t: 'glyph', name, x: g.stemX - STEM / 2, y: g.tip, sx: GS, sy: GS });
        tag(n0, 'flag', gl, i);
      }
      i++;
      continue;
    }
    let j = i;
    while (j < gls.length && runOf[j] === run) j++;
    const tip = Math.min(...geo.slice(i, j).map((g) => g.tip));
    for (let k = i; k < j; k++) stem(k, tip);
    const maxLv = Math.max(...gls.slice(i, j).map((gl) => beamLevels(gl.g.base)));
    for (let lv = 1; lv <= maxLv; lv++) {
      const y0 = tip + (lv - 1) * (bt + bs);
      let a = i;
      while (a < j) {
        if (beamLevels(gls[a].g.base) < lv) { a++; continue; }
        let b = a;
        while (b + 1 < j && beamLevels(gls[b + 1].g.base) >= lv) b++;
        let xa: number, xb: number;
        if (b > a) { xa = geo[a].stemX - STEM / 2; xb = geo[b].stemX + STEM / 2; }
        else if (a === i) { xa = geo[a].stemX - STEM / 2; xb = geo[a].stemX + 0.8; }
        else { xa = geo[a].stemX - 0.8; xb = geo[a].stemX + STEM / 2; }
        const n0 = prims.length;
        prims.push({ t: 'path', d: `M${xa.toFixed(3)} ${y0.toFixed(3)}L${xb.toFixed(3)} ${y0.toFixed(3)}L${xb.toFixed(3)} ${(y0 + bt).toFixed(3)}L${xa.toFixed(3)} ${(y0 + bt).toFixed(3)}Z` });
        tag(n0, 'beam', gls[a], a);
        a = b + 1;
      }
    }
    i = j;
  }
  // the slash of an acciaccatura runs through the stem of the first note of its run (or the lone note)
  for (let i = 0; i < gls.length; i++) {
    if (!gls[i].g.slash || gls[i].g.base < 8 || (runOf[i] && runOf[i] === runOf[i - 1])) continue;
    const g = geo[i];
    let tip = g.tip;
    if (runOf[i]) { let j = i; while (runOf[j + 1] === runOf[i]) j++; tip = Math.min(...geo.slice(i, j + 1).map((q) => q.tip)); }
    const n0 = prims.length;
    prims.push({ t: 'line', x1: g.stemX - 0.9, y1: tip + 1.9, x2: g.stemX + 1.0, y2: tip + 0.5, w: 0.1 });
    tag(n0, 'stem', gls[i], i);
  }
  const xs = geo.map((g) => g.x), top = Math.min(...geo.map((g) => g.tip)), bot = Math.max(...geo.map((g) => g.yBot));
  pushBox(ctx, s, Math.min(...xs) - 0.3, e.x - 0.2, top - 0.3, bot + 0.5);
}

function drawRest(ctx: SysCtx, e: EvL, s: number): void {
  const n0 = ctx.prims[s].length;
  drawRestPrims(ctx, e, s);
  tagFrom(ctx.prims[s], n0, 'rest', e);
}
function drawRestPrims(ctx: SysCtx, e: EvL, s: number): void {
  const base = e.te.ev.dur.base;
  const name = restGlyph(base, e.ev.kind === 'rest' && e.ev.style === 'measure');
  let y = base === 1 || (e.ev.kind === 'rest' && e.ev.style === 'measure') ? 1 : 2;
  if (e.ev.kind === 'rest' && e.ev.display) {
    const clef = e.clef;
    y = posToY(Math.round(((e.ev.display.octave * 7 + ['c', 'd', 'e', 'f', 'g', 'a', 'b'].indexOf(e.ev.display.step)) - clefBottom(clef))));
    if (base === 1) y += 0; 
  } else if (e.nVoices > 1) {
    y += e.voiceRank === 0 ? -1.5 : 1.5;
    // keep clear of the heads (and accidentals) of the other voices sounding at the same time
    const rb = sm.bbox(name);
    const others = ctx.prep.measures[e.mi][s].evs.filter((o) => o.ev.kind === 'note' && o.voice !== e.voice && o.start < e.start + e.ticks && e.start < o.start + o.ticks);
    const hits = (yy: number) => others.some((o) => o.heads.some((h) => {
      const hy = posToY(h.pos), r = h.acc ? 1.6 : 0.75;
      return hy + r > yy - rb.y1 && hy - r < yy - rb.y0;
    }));
    const stepDir = e.voiceRank === 0 ? -1 : 1;
    for (let k = 0; k < 8 && hits(y); k++) y += stepDir;
  }
  ctx.prims[s].push({ t: 'glyph', name, x: e.x, y });
  const b = sm.bbox(name);
  pushBox(ctx, s, e.x, e.x + b.x1, y - b.y1, y - b.y0);
  const dots = e.te.ev.dur.dots;
  for (let k = 0; k < dots; k++) ctx.prims[s].push({ t: 'glyph', name: 'augmentationDot', x: e.x + b.x1 + 0.4 + k * DOT_STEP, y: y - 0.5 });
  // long rests above/below the staff need ledger lines: ignored
}
function clefBottom(c: Clef): number {
  const sign = c.sign === 'G' ? 4 * 7 + 4 : c.sign === 'F' ? 3 * 7 + 3 : 4 * 7;
  return sign - 2 * (c.line - 1) + 7 * (c.octave ?? 0);
}

// ------------------------------------------------------------------ beams
function drawBeamGroup(ctx: SysCtx, notes: EvL[], s: number, levelsFor: (e: EvL) => number): void {
  const dir = notes[0].beam!.dir;
  const up = dir === 'up';
  const maxLv = Math.max(...notes.map(levelsFor));
  const L = stemLength(maxLv);
  const gs = notes.map((n) => geomOf.get(n)!);
  // stems for every note use the beam's direction (chord stems at proper side)
  notes.forEach((n, i) => {
    const g = gs[i];
    g.stemX = up ? g.x + g.shift + g.hw - STEM_T / 2 : g.x + g.shift + STEM_T / 2;
    g.stemBase = up ? g.yBot - 0.168 : g.yTop + 0.168;
  });
  const x0 = gs[0].stemX, x1 = gs[gs.length - 1].stemX;
  const tips = gs.map((g) => (up ? g.yTop - L : g.yBot + L));
  const span = Math.max(0.001, x1 - x0);
  const rise = tips[tips.length - 1] - tips[0];
  const maxTilt = 1.25;
  const m = (Math.sign(rise) * Math.min(Math.abs(rise) * 0.5, maxTilt)) / span;
  let a = up ? Infinity : -Infinity;
  gs.forEach((g, i) => {
    const v = tips[i] - m * (g.stemX - x0);
    a = up ? Math.min(a, v) : Math.max(a, v);
  });
  // keep beam out of the staff middle region for stems that would end inside the staff, nothing more
  // keep clear of the noteheads of other voices underneath/above the beam
  {
    const inner0 = (maxLv - 1) * ((D.beamThickness as number) + (D.beamSpacing as number)) + (D.beamThickness as number);
    for (const o of ctx.prep.measures[notes[0].mi][s].evs) {
      if (o.ev.kind !== 'note' || notes.includes(o)) continue;
      const go = geomOf.get(o);
      if (!go || go.headR < x0 - 0.5 || go.headL > x1 + 0.5) continue;
      const xc = (go.headL + go.headR) / 2;
      const v = up ? go.yTop - 0.9 - inner0 - m * (xc - x0) : go.yBot + 0.9 + inner0 - m * (xc - x0);
      a = up ? Math.min(a, v) : Math.max(a, v);
    }
    // accidentals (of any note, including the group's own) must not touch the beam either
    for (const o of ctx.prep.measures[notes[0].mi][s].evs) {
      if (o.ev.kind !== 'note') continue;
      for (const h of o.heads) {
        if (!h.acc || h.shared) continue;
        const ab = sm.bbox(h.acc.glyph);
        const ax0 = o.x + h.accX! + ab.x0, ax1 = o.x + h.accX! + ab.x1;
        if (ax1 < x0 - 0.3 || ax0 > x1 + 0.3) continue;
        const xc = (ax0 + ax1) / 2, yc = posToY(h.pos);
        const v = up ? yc - ab.y1 - 0.4 - inner0 - m * (xc - x0) : yc - ab.y0 + 0.4 + inner0 - m * (xc - x0);
        a = up ? Math.min(a, v) : Math.max(a, v);
      }
    }
  }
  // stems pointing at the staff reach at least the middle line (keeps beams off the ledger lines)
  gs.forEach((g) => { const v = 2 - m * (g.stemX - x0); a = up ? Math.min(a, v) : Math.max(a, v); });
  const lineY = (x: number) => a + m * (x - x0);
  const bt = D.beamThickness as number, bs = D.beamSpacing as number;
  const inward = up ? 1 : -1;
  notes.forEach((n, i) => {
    const g = gs[i];
    g.stemTip = lineY(g.stemX);
    drawStem(ctx, n, g, s, false);
  });
  // beam polygons
  const poly = (xa: number, xb: number, off: number) => {
    const ya = lineY(xa) + inward * off, yb = lineY(xb) + inward * off;
    return `M${xa.toFixed(3)} ${ya.toFixed(3)}L${xb.toFixed(3)} ${yb.toFixed(3)}L${xb.toFixed(3)} ${(yb + inward * bt).toFixed(3)}L${xa.toFixed(3)} ${(ya + inward * bt).toFixed(3)}Z`;
  };
  const nBeam0 = ctx.prims[s].length;
  for (let lv = 1; lv <= maxLv; lv++) {
    const off = (lv - 1) * (bt + bs);
    let i = 0;
    while (i < notes.length) {
      if (levelsFor(notes[i]) < lv) { i++; continue; }
      let j = i;
      while (j + 1 < notes.length && levelsFor(notes[j + 1]) >= lv && !restBetween(notes[j], notes[j + 1], notes[0].beam!.evs, lv)) j++;
      if (j > i) ctx.prims[s].push({ t: 'path', d: poly(gs[i].stemX - STEM_T / 2, gs[j].stemX + STEM_T / 2, off) });
      else {
        // hook
        const hookLen = 1.1;
        const prevDotted = i > 0 && notes[i - 1].te.ev.dur.dots > 0;
        let toRight = i === 0 ? true : i === notes.length - 1 ? false : !prevDotted;
        if (i > 0 && i < notes.length - 1 && notes[i + 1].start - notes[i].start < notes[i].start - notes[i - 1].start) toRight = true;
        const xa = toRight ? gs[i].stemX - STEM_T / 2 : gs[i].stemX - hookLen;
        const xb = toRight ? gs[i].stemX + hookLen : gs[i].stemX + STEM_T / 2;
        ctx.prims[s].push({ t: 'path', d: poly(xa, xb, off) });
      }
      i = j + 1;
    }
  }
  tagFrom(ctx.prims[s], nBeam0, 'beam', notes[0].beam);
  // skyline: beam extent, per pair of stems
  for (let i = 0; i + 1 < gs.length; i++) {
    const ya = lineY(gs[i].stemX), yb = lineY(gs[i + 1].stemX);
    const inner = (maxLv - 1) * (bt + bs) + bt;
    pushBox(ctx, s, gs[i].stemX, gs[i + 1].stemX, Math.min(ya, yb) - (up ? 0 : inner), Math.max(ya, yb) + (up ? inner : 0));
  }
}

function restBetween(a: EvL, b: EvL, all: EvL[], _lv: number): boolean {
  void _lv;
  const ia = all.indexOf(a), ib = all.indexOf(b);
  for (let k = ia + 1; k < ib; k++) if (all[k].ev.kind === 'rest') return true;
  return false;
}

function drawTremoloPair(ctx: SysCtx, e1: EvL, e2: EvL, s: number): void {
  const up = e1.stem === 'up';
  const g1 = geomOf.get(e1)!, g2 = geomOf.get(e2)!;
  const L = 3.5;
  for (const [e, g] of [[e1, g1], [e2, g2]] as [EvL, Geom][]) {
    g.stemX = up ? g.x + g.shift + g.hw - STEM_T / 2 : g.x + g.shift + STEM_T / 2;
    g.stemBase = up ? g.yBot - 0.168 : g.yTop + 0.168;
    setStem(e, g, L);
  }
  // the beams must clear accidentals between the stems
  {
    const nb = e1.tremBeams ?? 2;
    const inner0 = (nb - 1) * ((D.beamThickness as number) + (D.beamSpacing as number)) + (D.beamThickness as number);
    for (const [e, g] of [[e1, g1], [e2, g2]] as [EvL, Geom][]) {
      for (const h of e.heads) {
        if (!h.acc || h.shared) continue;
        const ab = sm.bbox(h.acc.glyph);
        const yc = posToY(h.pos);
        const lim = up ? yc - ab.y1 - 0.4 - inner0 : yc - ab.y0 + 0.4 + inner0;
        for (const q of [g1, g2]) q.stemTip = up ? Math.min(q.stemTip, lim) : Math.max(q.stemTip, lim);
      }
      void g;
    }
  }
  // the beams run from stem end to stem end: tilt follows the tips, limited like ordinary beams
  const maxTilt = 1.0;
  if (up) {
    const hi = Math.min(g1.stemTip, g2.stemTip);
    g1.stemTip = Math.min(g1.stemTip, hi + maxTilt); g2.stemTip = Math.min(g2.stemTip, hi + maxTilt);
  } else {
    const lo = Math.max(g1.stemTip, g2.stemTip);
    g1.stemTip = Math.max(g1.stemTip, lo - maxTilt); g2.stemTip = Math.max(g2.stemTip, lo - maxTilt);
  }
  drawStem(ctx, e1, g1, s, false);
  drawStem(ctx, e2, g2, s, false);
  const bt = D.beamThickness as number, bs = D.beamSpacing as number;
  const inward = up ? 1 : -1;
  const n = e1.tremBeams ?? 2;
  const DETACH = 0.3; // tremolo beams stop short of the stems so they read differently from ordinary beams
  const xa = g1.stemX + STEM_T / 2 + DETACH, xb = g2.stemX - STEM_T / 2 - DETACH;
  const slopeAt = (x: number) => g1.stemTip + ((g2.stemTip - g1.stemTip) * (x - g1.stemX)) / Math.max(0.001, g2.stemX - g1.stemX);
  let yMin = Infinity, yMax = -Infinity;
  const nTr = ctx.prims[s].length;
  for (let k = 0; k < n; k++) {
    const off = k * (bt + bs);
    const ya = slopeAt(xa) + inward * off, yb = slopeAt(xb) + inward * off;
    const d = `M${xa.toFixed(3)} ${ya.toFixed(3)}L${xb.toFixed(3)} ${yb.toFixed(3)}L${xb.toFixed(3)} ${(yb + inward * bt).toFixed(3)}L${xa.toFixed(3)} ${(ya + inward * bt).toFixed(3)}Z`;
    ctx.prims[s].push({ t: 'path', d });
    yMin = Math.min(yMin, ya, yb, ya + inward * bt, yb + inward * bt); yMax = Math.max(yMax, ya, yb, ya + inward * bt, yb + inward * bt);
  }
  tagFrom(ctx.prims[s], nTr, 'beam', e1);
  pushBox(ctx, s, xa, xb, yMin, yMax);
}

// ------------------------------------------------------------------ tuplets
function drawTuplet(ctx: SysCtx, t: TupletGroup, evs: EvL[], s: number): void {
  const n0 = ctx.prims[s].length;
  drawTupletPrims(ctx, t, evs, s);
  tagFrom(ctx.prims[s], n0, 'tuplet', t);
}
function drawTupletPrims(ctx: SysCtx, t: TupletGroup, evs: EvL[], s: number, forceSide?: 'above' | 'below', dry = false): number | void {
  if (!evs.length) return;
  const showNum = t.number !== 'none';
  const notes = evs.filter((e) => e.ev.kind === 'note');
  const beamSets = new Set(notes.map((n) => n.beam));
  const fullyBeamed = notes.length > 0 && beamSets.size === 1 && !beamSets.has(undefined);
  let bracket = t.bracket ?? !fullyBeamed;
  if (notes[0]?.beam?.cross) bracket = true; // the number alone is lost among the stems of a beam between the staves
  if (!showNum && !bracket) return;
  const anchor = notes[0] ?? evs[0];
  const crossY = notes[0]?.beam?.crossY; // a beam between two staves: number goes on top of it
  const side: 'above' | 'below' = forceSide ?? t.placement ?? (crossY ? 'above' : anchor.stem === 'down' ? 'below' : 'above');
  const above = side === 'above';
  // a number on the side away from the beams (where the heads are) gets a bracket
  const beamDir = crossY ? undefined : notes[0]?.beam?.dir ?? anchor.stem;
  if (showNum && notes.length && beamDir && above !== (beamDir === 'up')) bracket = true;
  const label = String(t.label ?? t.actual);
  // x extent
  const gAll = evs.map((e) => (e.ev.kind === 'note' ? geomOf.get(e)! : null));
  const xa = Math.min(...evs.map((e, i) => (gAll[i] ? gAll[i]!.headL : e.x)));
  const xb = Math.max(...evs.map((e, i) => (gAll[i] ? gAll[i]!.headR : e.x + 1)));
  // y extent on chosen side (stems/beams/heads)
  const ext = (e: EvL, i: number): number => {
    const g = gAll[i];
    if (!g) return above ? 1.5 : 2.5;
    const stemSide = e.stem === (above ? 'up' : 'down');
    if (above) return stemSide ? Math.min(g.stemTip, g.yTop - 0.5) : g.yTop - 0.5;
    return stemSide ? Math.max(g.stemTip, g.yBot + 0.5) : g.yBot + 0.5;
  };
  const sky = ctx.sky[s];
  const exts = evs.map((e, i) => {
    const base = ext(e, i);
    const g = gAll[i];
    if (!g) return base;
    // accidentals, articulations etc. of the note itself
    const lx = g.headL - (e.heads.some((h) => h.acc) ? 1.6 : 0.2); // only a note's own accidentals reach to its left
    const o = above ? sky.top(lx, g.headR, Infinity) : sky.bottom(lx, g.headR, -Infinity);
    return above ? Math.min(base, o) : Math.max(base, o);
  });
  const hh = (sm.bbox('tuplet6').y1 - sm.bbox('tuplet6').y0) / 2;
  const clearance = bracket ? 1.1 : hh + 0.5; // number sits clear of beams / stems
  // slope: follow the beam if present, else flat
  const idxFirst = 0, idxLast = evs.length - 1;
  let ya: number, yb: number;
  const sx = (i: number) => (gAll[i] ? gAll[i]!.stemX : evs[i].x);
  const x0 = gAll[idxFirst] ? sx(idxFirst) : xa, x1 = gAll[idxLast] ? sx(idxLast) : xb;
  const slopeOk = fullyBeamed || bracket;
  if (slopeOk && x1 > x0 && notes.length > 1) {
    // parallel to the beams (several beam groups: their slopes averaged by length)
    const groups = new Map<object, EvL[]>();
    for (const n of notes) {
      const key = n.beam ?? (n.tremPair ? (n.tremIsFirst ? n : n.tremPair) : undefined);
      if (key) { if (!groups.has(key)) groups.set(key, []); groups.get(key)!.push(n); }
    }
    let sl = 0, sw = 0;
    for (const list of groups.values()) {
      const ga = geomOf.get(list[0])!, gb = geomOf.get(list[list.length - 1])!;
      const dx = gb.stemX - ga.stemX;
      if (list.length > 1 && dx > 0.5 && !list[0].beam?.cross) { sl += ((gb.stemTip - ga.stemTip) / dx) * dx; sw += dx; }
    }
    // over a cross-staff beam the bracket rises or falls with the notes themselves, whatever else stands near its ends
    const headSlope = (): number => {
      // the notes on the staff the bracket belongs to (the upper one) set the slope
      const topSt = Math.min(...notes.map((n) => n.staff));
      const on = notes.filter((n) => n.staff === topSt);
      const ga = geomOf.get(on[0])!, gb = geomOf.get(on[on.length - 1])!;
      const dx = gb.x - ga.x;
      return dx > 0.5 ? (above ? gb.yTop - ga.yTop : gb.yBot - ga.yBot) / dx : 0;
    };
    const m = sw > 0 ? sl / sw : crossY ? headSlope() : (exts[idxLast] - exts[idxFirst]) / (x1 - x0);
    const mHead = Math.max(-0.5, Math.min(0.5, m));
    const fit = (mm: number): { a: number; gap: number } => {
      let a = above ? Infinity : -Infinity;
      evs.forEach((_, i) => {
        const v = exts[i] - mm * (sx(i) - x0);
        a = above ? Math.min(a, v) : Math.max(a, v);
      });
      // how far the line stays from what it clears, summed over the notes and the two ends
      let gap = 0;
      const pts = [...evs.map((_, i) => ({ x: sx(i), e: exts[i] })), { x: x0, e: Math.min(...exts) }, { x: x1, e: Math.min(...exts) }];
      if (!above) pts.forEach((q) => { q.e = Math.max(...exts); });
      for (const q of pts) gap += Math.abs(q.e - (a + mm * (q.x - x0)));
      return { a, gap };
    };
    // over a cross-staff beam the bracket follows the heads, but only as far as keeps it close to them
    let mm = mHead, best = fit(mm);
    if (crossY) for (let k = 1; k <= 10; k++) {
      const c = (mHead * (10 - k)) / 10, f = fit(c);
      if (f.gap < best.gap - 1e-6) { best = f; mm = c; }
    }
    const a = best.a;
    ya = a + (above ? -clearance : clearance);
    yb = ya + mm * (x1 - x0);
  } else {
    const e0 = above ? Math.min(...exts) : Math.max(...exts);
    ya = yb = e0 + (above ? -clearance : clearance);
  }
  const bx0 = xa - (bracket ? 0 : 0), bx1 = xb;
  // a bare number is centred over the beam (first to last stem), a bracketed one over the whole group
  const cx = !bracket && x1 > x0 && notes.length > 1 ? (x0 + x1) / 2 : (bx0 + bx1) / 2;
  let cy = ya + ((yb - ya) * (cx - x0)) / Math.max(0.001, x1 - x0);
  // the number of a bracket sits in a gap of the line: move the bracket away from the notes until no staff line runs through it
  if (bracket && showNum && !dry) {
    const onLine = (c: number) => [0, 1, 2, 3, 4].some((l) => Math.abs(l - c) < 0.7);
    // a digit is taller than a staff space, so only outside the staff is it clear of the lines; not worth more than a few spaces
    const d = above ? -0.25 : 0.25;
    let k = 0;
    while (k < 18 && onLine(cy + k * d)) k++;
    if (!onLine(cy + k * d)) { ya += k * d; yb += k * d; cy += k * d; }
  }
  const tw = label.length * 1.0;
  if (dry) return cy;
  // a bare number that would sit on staff lines moves to the other side of the group, if that is clear of them
  if (!bracket && showNum && !forceSide && !t.placement) {
    const hitsLine = (c: number) => [0, 1, 2, 3, 4].some((l) => Math.abs(l - c) < 0.75);
    if (hitsLine(cy)) {
      const alt = drawTupletPrims(ctx, t, evs, s, above ? 'below' : 'above', true) as number;
      if (!hitsLine(alt)) return drawTupletPrims(ctx, t, evs, s, above ? 'below' : 'above');
    }
  }
  const th = sm.bbox('tuplet6');
  const hookLen = 0.75 * (above ? 1 : -1);
  const lw = D.tupletBracketThickness as number;
  const yAt = (x: number) => ya + ((yb - ya) * (x - x0)) / Math.max(0.001, x1 - x0);
  if (bracket) {
    const gap = showNum ? tw / 2 + 0.35 : 0;
    const segs: [number, number][] = showNum ? [[bx0, cx - gap], [cx + gap, bx1]] : [[bx0, bx1]];
    for (const [p, q] of segs) ctx.prims[s].push({ t: 'line', x1: p, y1: yAt(p), x2: q, y2: yAt(q), w: lw });
    ctx.prims[s].push({ t: 'line', x1: bx0, y1: yAt(bx0), x2: bx0, y2: yAt(bx0) + hookLen, w: lw });
    ctx.prims[s].push({ t: 'line', x1: bx1, y1: yAt(bx1), x2: bx1, y2: yAt(bx1) + hookLen, w: lw });
  }
  if (showNum) {
    // plain italic text (lighter than Bravura's bold tuplet figures)
    const size = 1.8;
    ctx.prims[s].push({ t: 'text', x: cx, y: cy + size * 0.3, s: label, size, italic: true, anchor: 'middle' });
  }
  const yLo = Math.min(ya, yb) - (above ? 1.0 : 0), yHi = Math.max(ya, yb) + (above ? 0 : 1.0);
  if (bracket) pushBox(ctx, s, bx0, bx1, above ? yLo - 0.2 : yLo, above ? yHi : yHi + 0.2); // no bracket, no band
  if (showNum) pushBox(ctx, s, cx - tw / 2, cx + tw / 2, cy - 0.9, cy + 0.9);
  void isTuplet;
}

// ------------------------------------------------------------------ articulations
function drawArticulations(ctx: SysCtx, e: EvL, s: number): void {
  const n0 = ctx.prims[s].length;
  drawArticulationPrims(ctx, e, s);
  tagFrom(ctx.prims[s], n0, 'artic', e);
}
function drawArticulationPrims(ctx: SysCtx, e: EvL, s: number): void {
  if (e.ev.kind !== 'note' || !e.ev.art) return;
  const g = geomOf.get(e)!;
  const above = e.ev.artSide ? e.ev.artSide === 'above' : e.beam?.cross ? e.stem === 'down' : e.nVoices > 1 ? e.voiceRank === 0 : e.stem === 'down' || e.ev.art.includes('marcato');
  const stemSide = e.stem === (above ? 'up' : 'down');
  const arts = [...e.ev.art].sort((a, b) => (a === 'staccato' ? -1 : b === 'staccato' ? 1 : 0)); // staccato nearest the head
  let cx: number, y: number;
  if (stemSide) {
    cx = g.stemX;
    y = above ? g.stemTip - 1.2 : g.stemTip + 1.2;
    if (e.beam) y += above ? -0.2 : 0.2;
  } else {
    const ref = above ? Math.max(...e.heads.map((h) => h.pos)) : Math.min(...e.heads.map((h) => h.pos));
    let q = above ? ref + 3 : ref - 3; // 1.5 spaces from the head centre leaves a clear gap
    if (q % 2 === 0 && q >= 0 && q <= 8) q += above ? 1 : -1; // inside the staff: sit in a space, not on a line
    y = posToY(q);
    if (arts[0] === 'staccato') y = posToY(ref) + (above ? -1.25 : 1.25); // dots hug the head a little closer
    const head = e.heads.find((h) => h.pos === ref)!;
    cx = e.x + head.dx + g.hw / 2;
  }
  let edge = y;
  for (const a of arts) {
    const nm = `artic${a === 'accent' ? 'Accent' : a === 'staccato' ? 'Staccato' : 'Marcato'}${above ? 'Above' : 'Below'}`;
    ctx.prims[s].push(glyphCentered(nm, cx, y));
    const b = sm.bbox(nm);
    const h = b.y1 - b.y0;
    pushBox(ctx, s, cx - 0.7, cx + 0.7, y - Math.max(0.5, h / 2), y + Math.max(0.5, h / 2));
    edge = above ? y - Math.max(0.2, h / 2) : y + Math.max(0.2, h / 2);
    y += (above ? -1 : 1) * Math.max(0.9, h + 0.3);
  }
  articExtent.set(e, { above, edge });
}
