// Drawing of notes, rests, stems, beams, tuplets etc. into staff-local primitives.
import { isTuplet, type TupletGroup, type Clef } from '../model.ts';
import { loadSmufl } from '../smufl.ts';
import { posToY, beamLevels, type EvL, type Prepared } from './prep.ts';
import { headGlyph, headWidth, HEAD_SCALE, restGlyph, STEM_T, DOT_STEP, type MeasureSpacing, type PlacedMeasure } from './spacing.ts';
import { Skyline, tagFrom, oid, type Prim } from './scene.ts';

const sm = loadSmufl();
export const D = sm.def;

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
}

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

export interface Geom { shift: number; x: number; hw: number; yTop: number; yBot: number; stemX: number; stemTip: number; stemBase: number; headL: number; headR: number }
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
      const prims = ctx.prims[s];
      const sml = prep.measures[mi][s];
      // ---- 1. position events
      for (const e of sml.evs) {
        if (e.ev.kind === 'rest' && e.ev.measure) { e.x = ctx.mx[mi] + (sp.lead + pl.endX) / 2 - sm.adv('restWhole') / 2; continue; }
        const j = colIndex.get(e.start);
        e.x = j === undefined ? xAtTick(ctx, mi, e.start) : ctx.mx[mi] + pl.xs[j];
      }
      // ---- 2. notes: heads, ledger, accidentals, dots, arpeggio, stems (unbeamed)
      for (const e of sml.evs) {
        if (e.ev.kind === 'rest') { if (!e.ev.hidden) drawRest(ctx, e, s); continue; }
        drawNoteBasics(ctx, e, s);
      }
      // ---- 3. stems & beams per voice
      for (const v of sml.voices) {
        const doneBeams = new Set<object>();
        for (const e of v.evs) {
          if (e.ev.kind !== 'note') continue;
          const g = geomOf.get(e)!;
          if (e.beam) {
            if (doneBeams.has(e.beam)) continue;
            doneBeams.add(e.beam);
            drawBeamGroup(ctx, e.beam.notes, s, levelsFor);
          } else if (e.tremPair && e.tremIsFirst) {
            drawTremoloPair(ctx, e, e.tremPair, s);
          } else if (e.tremPair) { /* drawn with partner */ }
          else if (e.stem) {
            const lv = levelsFor(e);
            let len = stemLength(Math.max(1, lv));
            // a displaced head right of an up-stem would run into the flag
            if (e.stem === 'up' && e.te.ev.dur.base >= 8 && e.heads.some((h) => h.dx > g.hw / 2 && !h.shared)) len += 0.6;
            if (e.stem === 'down' && e.te.ev.dur.base >= 8) len += 0.3; // the flag curls up towards the (wider) head
            setStem(e, g, len);
            drawStem(ctx, e, g, s, true);
          }
        }
      }
      // ---- 4. articulations (need stems)
      for (const e of sml.evs) if (e.ev.kind === 'note' && e.ev.art?.length) drawArticulations(ctx, e, s);
      // ---- 5. tuplets
      const seen = new Set<TupletGroup>();
      for (const v of sml.voices) for (const e of v.evs) for (const t of e.tupletKeys) if (!seen.has(t)) {
        seen.add(t);
        drawTuplet(ctx, t, v.evs.filter((x) => x.tupletKeys.includes(t)), s);
      }
      void prims;
    }
  }
  trimLedgers(ctx);
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

function drawStem(ctx: SysCtx, e: EvL, g: Geom, s: number, flag: boolean): void {
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
  pushBox(ctx, s, g.stemX - STEM_T / 2, g.stemX + STEM_T / 2, lo, hi);
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
  for (const h of e.heads) {
    if (h.shared) continue;
    prims.push({ t: 'glyph', name: gl, x: e.x + h.dx, y: posToY(h.pos), sx: HEAD_SCALE, sy: 1 });
    tagFrom(prims, prims.length - 1, 'head', e, h.sharers);
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
  }
  // ledger lines
  const ledgerExt = D.legerLineExtension as number;
  const lx0 = e.x + minDx - ledgerExt, lx1 = e.x + maxDx + hw + ledgerExt;
  const own = e.heads.filter((h) => !h.shared);
  if (own.length) {
    const posMin = Math.min(...own.map((h) => h.pos)), posMax = Math.max(...own.map((h) => h.pos));
    // a ledger line is needed where a head sits on it or beyond it (not for the space just outside the staff)
    const ledger = (p: number) => {
      const prim: Prim = { t: 'line', x1: lx0, x2: lx1, y1: posToY(p), y2: posToY(p), w: D.legerLineThickness as number };
      prim.k = 'ledger'; prim.o = oid(e);
      prims.push(prim);
      ledgerSegs.push({ prim, s, y: posToY(p), x0: lx0, x1: lx1, hx0: e.x + minDx, hx1: e.x + maxDx + hw });
    };
    for (let p = -2; p >= posMin; p -= 2) ledger(p);
    for (let p = 10; p <= posMax; p += 2) ledger(p);
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

function drawRest(ctx: SysCtx, e: EvL, s: number): void {
  const n0 = ctx.prims[s].length;
  drawRestPrims(ctx, e, s);
  tagFrom(ctx.prims[s], n0, 'rest', e);
}
function drawRestPrims(ctx: SysCtx, e: EvL, s: number): void {
  const base = e.te.ev.dur.base;
  const name = restGlyph(base, e.ev.kind === 'rest' ? e.ev.measure : false);
  let y = base === 1 || (e.ev.kind === 'rest' && e.ev.measure) ? 1 : 2;
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
    const nb = e1.ev.kind === 'note' && e1.ev.tremolo2 ? e1.ev.tremolo2.beams : 2;
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
  const n = e1.ev.kind === 'note' && e1.ev.tremolo2 ? e1.ev.tremolo2.beams : 2;
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
  if (!showNum && !bracket) return;
  const anchor = notes[0] ?? evs[0];
  const side: 'above' | 'below' = forceSide ?? t.placement ?? (anchor.stem === 'down' ? 'below' : 'above');
  const above = side === 'above';
  // a number on the side away from the beams (where the heads are) gets a bracket
  const beamDir = notes[0]?.beam?.dir ?? anchor.stem;
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
    const o = above ? sky.top(g.headL - 1.6, g.headR, Infinity) : sky.bottom(g.headL - 1.6, g.headR, -Infinity);
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
      if (list.length > 1 && dx > 0.5) { sl += ((gb.stemTip - ga.stemTip) / dx) * dx; sw += dx; }
    }
    const m = sw > 0 ? sl / sw : (exts[idxLast] - exts[idxFirst]) / (x1 - x0);
    const mm = Math.max(-0.5, Math.min(0.5, m));
    // intercept so every extent is cleared
    let a = above ? Infinity : -Infinity;
    evs.forEach((_, i) => {
      const v = exts[i] - mm * (sx(i) - x0);
      a = above ? Math.min(a, v) : Math.max(a, v);
    });
    ya = a + (above ? -clearance : clearance);
    yb = ya + mm * (x1 - x0);
  } else {
    const e0 = above ? Math.min(...exts) : Math.max(...exts);
    ya = yb = e0 + (above ? -clearance : clearance);
  }
  const bx0 = xa - (bracket ? 0 : 0), bx1 = xb;
  // a bare number is centred over the beam (first to last stem), a bracketed one over the whole group
  const cx = !bracket && x1 > x0 && notes.length > 1 ? (x0 + x1) / 2 : (bx0 + bx1) / 2;
  const cy = ya + ((yb - ya) * (cx - x0)) / Math.max(0.001, x1 - x0);
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
  const above = e.ev.artSide ? e.ev.artSide === 'above' : e.nVoices > 1 ? e.voiceRank === 0 : e.stem === 'down' || e.ev.art.includes('marcato');
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
