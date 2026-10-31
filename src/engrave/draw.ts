// Drawing of notes, rests, stems, beams, tuplets etc. into staff-local primitives.
import { isTuplet, type TupletGroup, type Clef } from '../model.ts';
import { loadSmufl } from '../smufl.ts';
import { posToY, beamLevels, type EvL, type Prepared } from './prep.ts';
import { headGlyph, headWidth, restGlyph, STEM_T, DOT_STEP, type MeasureSpacing, type PlacedMeasure } from './spacing.ts';
import { Skyline, type Prim } from './scene.ts';

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

export function drawSystemNotes(ctx: SysCtx): void {
  const { prep } = ctx;
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
            const len = stemLength(Math.max(1, lv));
            setStem(e, g, len);
            drawStem(ctx, e, g, s, true);
          }
        }
      }
      // ---- 4. tuplets
      const seen = new Set<TupletGroup>();
      for (const v of sml.voices) for (const e of v.evs) for (const t of e.tupletKeys) if (!seen.has(t)) {
        seen.add(t);
        drawTuplet(ctx, t, v.evs.filter((x) => x.tupletKeys.includes(t)), s);
      }
      // ---- 5. articulations (need stems)
      for (const e of sml.evs) if (e.ev.kind === 'note' && e.ev.art?.length) drawArticulations(ctx, e, s);
      void prims;
    }
  }
}

function setStem(e: EvL, g: Geom, len: number): void {
  const up = e.stem === 'up';
  let tip = up ? g.yTop - len : g.yBot + len;
  if (up) tip = Math.min(tip, 2); else tip = Math.max(tip, 2);
  g.stemTip = tip;
}

function drawStem(ctx: SysCtx, e: EvL, g: Geom, s: number, flag: boolean): void {
  const up = e.stem === 'up';
  ctx.prims[s].push({ t: 'line', x1: g.stemX, y1: g.stemBase, x2: g.stemX, y2: g.stemTip + (up ? 0 : 0), w: STEM_T });
  const base = e.te.ev.dur.base;
  if (flag && base >= 8 && !e.beam) {
    const n = beamLevels(base);
    const name = `flag${n === 1 ? '8th' : n === 2 ? '16th' : n === 3 ? '32nd' : '64th'}${up ? 'Up' : 'Down'}`;
    ctx.prims[s].push({ t: 'glyph', name, x: g.stemX - STEM_T / 2, y: g.stemTip });
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
    prims.push({ t: 'glyph', name: gl, x: e.x + h.dx, y: posToY(h.pos) });
    if (h.acc) {
      const ax = e.x + h.accX!;
      const ay = posToY(h.pos);
      if (h.acc.cautionary) {
        const pw = sm.adv('accidentalParensLeft');
        prims.push({ t: 'glyph', name: 'accidentalParensLeft', x: ax, y: ay });
        prims.push({ t: 'glyph', name: h.acc.glyph, x: ax + pw, y: ay });
        prims.push({ t: 'glyph', name: 'accidentalParensRight', x: ax + pw + sm.adv(h.acc.glyph), y: ay });
        pushBox(ctx, s, ax, ax + pw * 2 + sm.adv(h.acc.glyph), ay - 1.4, ay + 1.4);
      } else {
        prims.push({ t: 'glyph', name: h.acc.glyph, x: ax, y: ay });
        pushBox(ctx, s, ax, ax + sm.adv(h.acc.glyph), ay - 1.4, ay + 1.4);
      }
    }
  }
  // ledger lines
  const ledgerExt = D.legerLineExtension as number;
  const lx0 = e.x + minDx - ledgerExt, lx1 = e.x + maxDx + hw + ledgerExt;
  const own = e.heads.filter((h) => !h.shared);
  if (own.length) {
    const posMin = Math.min(...own.map((h) => h.pos)), posMax = Math.max(...own.map((h) => h.pos));
    // a ledger line is needed where a head sits on it or beyond it (not for the space just outside the staff)
    for (let p = -2; p >= posMin; p -= 2) prims.push({ t: 'line', x1: lx0, x2: lx1, y1: posToY(p), y2: posToY(p), w: D.legerLineThickness as number });
    for (let p = 10; p <= posMax; p += 2) prims.push({ t: 'line', x1: lx0, x2: lx1, y1: posToY(p), y2: posToY(p), w: D.legerLineThickness as number });
  }
  // dots
  const dots = e.te.ev.dur.dots;
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
  // geometry & stem anchors
  const stemX = e.stem === 'up' ? e.x + e.shiftDx + hw - STEM_T / 2 : e.x + e.shiftDx + STEM_T / 2;
  const g: Geom = {
    shift: e.shiftDx, x: e.x, hw, yTop: yTop, yBot: yBot, stemX, stemTip: 0,
    stemBase: e.stem === 'up' ? yBot - 0.168 : yTop + 0.168,
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
    for (let k = 0; k < n; k++) prims.push({ t: 'glyph', name: 'wiggleArpeggiatoUp', x: right, y: bot - k * step + seg.x0, rot: -90 });
    pushBox(ctx, s, right - w, right, top - 0.2, bot + 0.2);
  }
}

function drawRest(ctx: SysCtx, e: EvL, s: number): void {
  const base = e.te.ev.dur.base;
  const name = restGlyph(base, e.ev.kind === 'rest' ? e.ev.measure : false);
  let y = base === 1 || (e.ev.kind === 'rest' && e.ev.measure) ? 1 : 2;
  if (e.ev.kind === 'rest' && e.ev.display) {
    const clef = e.clef;
    y = posToY(Math.round(((e.ev.display.octave * 7 + ['c', 'd', 'e', 'f', 'g', 'a', 'b'].indexOf(e.ev.display.step)) - clefBottom(clef))));
    if (base === 1) y += 0; 
  } else if (e.nVoices > 1) y += e.voiceRank === 0 ? -1.5 : 1.5;
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
  const tip = up ? Math.min(g1.stemTip, g2.stemTip) : Math.max(g1.stemTip, g2.stemTip);
  g1.stemTip = tip; g2.stemTip = tip;
  drawStem(ctx, e1, g1, s, false);
  drawStem(ctx, e2, g2, s, false);
  const bt = D.beamThickness as number, bs = D.beamSpacing as number;
  const inward = up ? 1 : -1;
  const n = e1.ev.kind === 'note' && e1.ev.tremolo2 ? e1.ev.tremolo2.beams : 2;
  // slashes between the stems, nearest the stem end
  const xa = g1.stemX + STEM_T / 2 + 0.3, xb = g2.stemX - STEM_T / 2 - 0.3;
  const slant = 0.6; // slashes lean slightly
  for (let k = 0; k < n; k++) {
    const y = tip + inward * (1.0 + k * (bt + bs));
    const d = `M${xa.toFixed(3)} ${(y + slant / 2).toFixed(3)}L${xb.toFixed(3)} ${(y - slant / 2).toFixed(3)}L${xb.toFixed(3)} ${(y - slant / 2 + bt).toFixed(3)}L${xa.toFixed(3)} ${(y + slant / 2 + bt).toFixed(3)}Z`;
    ctx.prims[s].push({ t: 'path', d });
  }
  pushBox(ctx, s, xa, xb, Math.min(tip, tip + inward * 2.5), Math.max(tip, tip + inward * 2.5));
}

// ------------------------------------------------------------------ tuplets
function drawTuplet(ctx: SysCtx, t: TupletGroup, evs: EvL[], s: number): void {
  if (!evs.length) return;
  const showNum = t.number !== 'none';
  const notes = evs.filter((e) => e.ev.kind === 'note');
  const beamSets = new Set(notes.map((n) => n.beam));
  const fullyBeamed = notes.length > 0 && beamSets.size === 1 && !beamSets.has(undefined);
  const bracket = t.bracket ?? !fullyBeamed;
  if (!showNum && !bracket) return;
  const anchor = notes[0] ?? evs[0];
  const side: 'above' | 'below' = t.placement ?? (anchor.stem === 'down' ? 'below' : 'above');
  const above = side === 'above';
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
  const exts = evs.map(ext);
  const clearance = 0.9;
  // slope: follow the beam if present, else flat
  const idxFirst = 0, idxLast = evs.length - 1;
  let ya: number, yb: number;
  const sx = (i: number) => (gAll[i] ? gAll[i]!.stemX : evs[i].x);
  const x0 = gAll[idxFirst] ? sx(idxFirst) : xa, x1 = gAll[idxLast] ? sx(idxLast) : xb;
  const slopeOk = fullyBeamed || bracket;
  if (slopeOk && x1 > x0 && notes.length > 1) {
    const m = (exts[idxLast] - exts[idxFirst]) / (x1 - x0);
    const mm = Math.max(-0.3, Math.min(0.3, m));
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
  const cx = (bx0 + bx1) / 2;
  const cy = ya + ((yb - ya) * (cx - x0)) / Math.max(0.001, x1 - x0);
  const tw = label.split('').reduce((w, ch) => w + sm.adv(`tuplet${ch}`), 0);
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
    let px = cx - tw / 2;
    const yc = bracket ? cy : cy; // glyph centre on the line
    for (const ch of label) {
      const nm = `tuplet${ch}`;
      ctx.prims[s].push({ t: 'glyph', name: nm, x: px, y: yc + (th.y0 + th.y1) / 2 });
      px += sm.adv(nm);
    }
  }
  const yLo = Math.min(ya, yb) - (above ? 1.0 : 0), yHi = Math.max(ya, yb) + (above ? 0 : 1.0);
  pushBox(ctx, s, bx0, bx1, above ? yLo - 0.2 : yLo, above ? yHi : yHi + 0.2);
  if (showNum) pushBox(ctx, s, cx - tw / 2, cx + tw / 2, cy - 0.9, cy + 0.9);
  void isTuplet;
}

// ------------------------------------------------------------------ articulations
function drawArticulations(ctx: SysCtx, e: EvL, s: number): void {
  if (e.ev.kind !== 'note' || !e.ev.art) return;
  const g = geomOf.get(e)!;
  const above = e.nVoices > 1 ? e.voiceRank === 0 : e.stem === 'down';
  const stemSide = e.stem === (above ? 'up' : 'down');
  const arts = [...e.ev.art].sort((a, b) => (a === 'staccato' ? -1 : b === 'staccato' ? 1 : 0)); // staccato nearest the head
  let cx: number, y: number;
  if (stemSide) {
    cx = g.stemX;
    y = above ? g.stemTip - 0.9 : g.stemTip + 0.9;
    if (e.beam) y += above ? -0.2 : 0.2;
  } else {
    const ref = above ? Math.max(...e.heads.map((h) => h.pos)) : Math.min(...e.heads.map((h) => h.pos));
    let q = above ? ref + 2 : ref - 2;
    if (q % 2 === 0 && q >= 0 && q <= 8) q += above ? 1 : -1;
    y = posToY(q);
    if (!(ref >= 0 && ref <= 8) || (above ? ref > 8 : ref < 0)) y = posToY(above ? ref + 2 : ref - 2);
    const head = e.heads.find((h) => h.pos === ref)!;
    cx = e.x + head.dx + g.hw / 2;
  }
  for (const a of arts) {
    const nm = `artic${a === 'accent' ? 'Accent' : a === 'staccato' ? 'Staccato' : 'Marcato'}${above ? 'Above' : 'Below'}`;
    ctx.prims[s].push(glyphCentered(nm, cx, y));
    const b = sm.bbox(nm);
    const h = b.y1 - b.y0;
    pushBox(ctx, s, cx - 0.7, cx + 0.7, y - Math.max(0.5, h / 2), y + Math.max(0.5, h / 2));
    y += (above ? -1 : 1) * Math.max(0.9, h + 0.3);
  }
}
