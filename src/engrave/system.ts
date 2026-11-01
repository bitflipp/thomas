// Line breaking, system assembly, vertical layout and pagination.
import { keyAt, timeAt, type Score, type Clef } from '../model.ts';
import { loadSmufl } from '../smufl.ts';
import { prepare, posToY, keyAlter, type Prepared } from './prep.ts';
import { spaceMeasure, placeMeasure, COMPRESS, type MeasureSpacing } from './spacing.ts';
import { drawSystemNotes, xAtTick, D, type SysCtx } from './draw.ts';
import { drawSpanners } from './spanners.ts';
import { Skyline, oid, tagFrom, type Page, type Prim } from './scene.ts';

const sm = loadSmufl();

export interface EngraveOptions {
  respectBreaks?: boolean; // honour breakBefore flags from the score (default true)
  justifyVertical?: boolean;
  measureNumbers?: 'system' | 'all' | 'none'; // default 'system': first measure of every system but the first
  warn?: (m: string) => void;
}

const SHARP_POS_TREBLE = [8, 5, 9, 6, 3, 7, 4];
const FLAT_POS_TREBLE = [4, 7, 3, 6, 2, 5, 1];

export function clefGlyph(c: Clef, change = false): { name: string; y: number } {
  const y = 4 - (c.line - 1);
  if (c.sign === 'G') return { name: change ? 'gClefChange' : c.octave === -1 ? 'gClef8vb' : c.octave === 1 ? 'gClef8va' : 'gClef', y };
  if (c.sign === 'F') return { name: change ? 'fClefChange' : c.octave === -1 ? 'fClef8vb' : c.octave === 1 ? 'fClef8va' : 'fClef', y };
  return { name: change ? 'cClefChange' : 'cClef', y };
}

function keyPositions(fifths: number, clef: Clef): number[] {
  // shift pattern from treble clef to the given clef
  const bottom = (c: Clef) => {
    const sign = c.sign === 'G' ? 4 * 7 + 4 : c.sign === 'F' ? 3 * 7 + 3 : 4 * 7;
    return sign - 2 * (c.line - 1) + 7 * (c.octave ?? 0);
  };
  const shift = (((bottom({ sign: 'G', line: 2 }) - bottom(clef)) % 7) + 7) % 7;
  const base = fifths > 0 ? SHARP_POS_TREBLE.slice(0, fifths) : FLAT_POS_TREBLE.slice(0, -fifths);
  return base.map((p) => { let q = p + shift; while (q > 9) q -= 7; return q; });
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
  score.staves.forEach((_, si) => { cw = Math.max(cw, sm.adv(clefGlyph(prep.clefAt(si, mi, 0)).name)); });
  let w = 0.9 + cw + 1.0;
  w += keyWidth(keyAt(score, mi));
  if (first) w += timeWidth(timeAt(score, mi));
  return w;
}

interface SysPlan { a: number; b: number; last: boolean }

function planSystems(prep: Prepared, spN: MeasureSpacing[], spF: MeasureSpacing[], W: number, forced: Set<number>): SysPlan[] {
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
    const best: number[] = Array(len + 1).fill(Infinity);
    const from: number[] = Array(len + 1).fill(-1);
    best[0] = 0;
    for (let i = 1; i <= len; i++) {
      for (let j = Math.max(0, i - 14); j < i; j++) {
        if (best[j] === Infinity) continue;
        const nat = natural(segStart + j, segStart + i - 1);
        const cmp = natural(segStart + j, segStart + i - 1, true);
        const single = i - j === 1;
        if (cmp > W && !single) continue;
        const lastLine = isFinalSeg && i === len;
        let cost: number;
        if (cmp > W) cost = 200 + (cmp - W) * 10;
        else if (nat > W) { const c = (nat - W) / Math.max(0.01, nat - cmp); cost = 10 * c * c; }
        else if (lastLine) cost = nat / W > 0.55 ? 2 * (1 - nat / W) ** 2 * 100 : 0;
        else cost = ((W - nat) / W) ** 2 * 160;
        cost += 3; // per-system cost: prefer fewer lines
        const tot = best[j] + cost;
        if (tot < best[i]) { best[i] = tot; from[i] = j; }
      }
    }
    const cuts: number[] = [];
    let i = len;
    while (i > 0) { cuts.push(i); i = from[i]; }
    cuts.reverse();
    let prev = 0;
    for (const c of cuts) { plans.push({ a: segStart + prev, b: segStart + c - 1, last: false }); prev = c; }
  });
  plans[plans.length - 1].last = true;
  return plans;
}

export interface Engraved { pages: Page[]; systems: number; staffSpace: number }

export function engrave(score: Score, opts: EngraveOptions = {}): Engraved {
  const warn = opts.warn ?? (() => {});
  const respect = opts.respectBreaks ?? true;
  const prep = prepare(score);
  const nS = score.staves.length;
  const nM = score.measures.length;
  const S = score.page.staffSpace;
  const pageW = score.page.width / S, pageH = score.page.height / S;
  const margin = score.page.margin / S;
  const hasBrace = score.groups.some((g) => g.kind === 'brace');
  const braceRoom = hasBrace ? 2.4 : 0.8;
  const W = pageW - 2 * margin - braceRoom;

  const spN = score.measures.map((_, mi) => spaceMeasure(prep, mi, false));
  const spF = score.measures.map((_, mi) => spaceMeasure(prep, mi, true));

  const forced = new Set<number>();
  if (respect) score.measures.forEach((m, mi) => { if (m.breakBefore) forced.add(mi); });
  const plans = planSystems(prep, spN, spF, W, forced);

  // ---- build systems
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
    if (!plan.last || nat / W > 0.55) {
      let lo = 0.3, hi = 20;
      if (widthAt(lo) > W) f = lo;
      else {
        for (let it = 0; it < 50; it++) { const mid = (lo + hi) / 2; if (widthAt(mid) > W) hi = mid; else lo = mid; }
        f = lo;
      }
      if (plan.last) f = Math.min(f, 1.6);
    }
    const placed = [];
    const mx: number[] = [];
    let x = prefix;
    for (let mi = plan.a; mi <= plan.b; mi++) {
      const p = placeMeasure(spacing[mi], f);
      placed[mi] = p; mx[mi] = x; x += p.width;
    }
    if (widthAt(f) > W * 1.001) warn(`system ${index + 1}: content ${nat.toFixed(1)} exceeds width ${W.toFixed(1)}`);
    systems.push({
      prep, index, a: plan.a, b: plan.b, spacing, placed, mx, prefix, width: x, f,
      prims: score.staves.map(() => []), sky: score.staves.map(() => new Skyline()), staffY: [], barlines: [], tupletBoxes: [],
    });
  }

  for (const ctx of systems) drawSystemNotes(ctx);
  drawSpanners(systems);

  // ---- finalize each system: staff positions, staff lines, clefs, barlines, brace
  const sysPrims: Prim[][] = [];
  const sysTop: number[] = [], sysBottom: number[] = [];
  for (const ctx of systems) {
    const ext = ctx.sky.map((k) => k.extent());
    ctx.staffY = [0];
    for (let s = 1; s < nS; s++) {
      // minimum gap from pairwise overlap in x (a tall slur in one staff only matters where the other staff has content)
      let need = 0;
      for (const a of ctx.sky[s - 1].boxes) for (const b of ctx.sky[s].boxes) {
        if (a.spanner && b.spanner) continue;
        if (a.x1 > b.x0 && a.x0 < b.x1) need = Math.max(need, a.y1 - 4 - b.y0 + 1.0);
      }
      // ... and clear of both staves' lines: content hanging below the upper staff, or above the lower one
      for (const a of ctx.sky[s - 1].boxes) if (!a.spanner) need = Math.max(need, a.y1 - 4 + 0.7);
      for (const b of ctx.sky[s].boxes) if (!b.spanner) need = Math.max(need, -b.y0 + 0.7);
      const gap = Math.max(3.7, need);
      ctx.staffY[s] = ctx.staffY[s - 1] + 4 + gap;
    }
    alignDynamics(ctx, nS);
    const P: Prim[] = [];
    const first = ctx.a === 0;
    // staves
    for (let s = 0; s < nS; s++) {
      const y0 = ctx.staffY[s];
      for (let l = 0; l < 5; l++) P.push({ t: 'line', x1: 0, x2: ctx.width, y1: y0 + l, y2: y0 + l, w: D.staffLineThickness as number, k: 'staff' });
      for (const p of ctx.prims[s]) P.push(shift(p, 0, y0));
      // clef + key + time
      const clef = prep.clefAt(s, ctx.a, 0);
      const cg = clefGlyph(clef);
      P.push({ t: 'glyph', name: cg.name, x: 0.9, y: y0 + cg.y, k: 'clef', o: oid({}) });
      let kx = 0.9 + sm.adv(cg.name) + 1.0;
      const key = keyAt(score, ctx.a);
      const keyId = oid({});
      if (key) {
        const name = key > 0 ? 'accidentalSharp' : 'accidentalFlat';
        keyPositions(key, clef).forEach((pos) => { P.push({ t: 'glyph', name, x: kx, y: y0 + posToY(pos), k: 'keysig', o: keyId }); kx += sm.adv(name) + 0.12; });
        kx += 0.9;
      }
      if (first) timeSig(P, kx, y0, timeAt(score, ctx.a));
      // mid-system key/time changes and clef changes
      for (let mi = ctx.a; mi <= ctx.b; mi++) {
        if (mi > ctx.a && score.measures[mi].time) timeSig(P, ctx.mx[mi] + 0.6, y0, timeAt(score, mi));
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
    // measure numbers (above the first staff; left-aligned at the system start, or at each barline in 'all' mode)
    const mode = opts.measureNumbers ?? 'system';
    if (mode !== 'none') {
      const size = 1.8;
      const list = mode === 'all' ? Array.from({ length: ctx.b - ctx.a + 1 }, (_, k) => ctx.a + k) : [ctx.a];
      for (const mi of list) {
        if (mi === 0) continue;
        const label = String(score.measures[mi].number);
        const x = mi === ctx.a ? 0.2 : ctx.mx[mi] + 0.3;
        const w = label.length * size * 0.5 + 0.4;
        let y = Math.min(-0.8, ctx.sky[0].top(x, x + w, 0) - 0.5);
        if (mi === ctx.a) { // the clef at the start of the system may reach above the staff
          const cb = sm.bbox(clefGlyph(prep.clefAt(0, ctx.a, 0)).name), cy = clefGlyph(prep.clefAt(0, ctx.a, 0)).y;
          if (x + w > 0.9) y = Math.min(y, cy - cb.y1 - 0.5);
        }
        P.push({ t: 'text', x, y, s: label, size, italic: true, k: 'measurenum', o: oid({}) });
        ctx.sky[0].add(x, x + w, y - size * 0.75, y + 0.2);
      }
      ext[0] = ctx.sky[0].extent();
    }
    // barlines
    const bottom = ctx.staffY[nS - 1] + 4;
    const groupsOf: [number, number][] = [];
    const used = new Set<number>();
    for (const g of score.groups) {
      const idx = g.staves.map((id) => score.staves.findIndex((s) => s.id === id)).filter((i) => i >= 0).sort((x, y) => x - y);
      if (idx.length) { groupsOf.push([idx[0], idx[idx.length - 1]]); idx.forEach((i) => used.add(i)); }
    }
    for (let s = 0; s < nS; s++) if (!used.has(s)) groupsOf.push([s, s]);
    const thin = D.thinBarlineThickness as number, thick = D.thickBarlineThickness as number, sep = D.thinThickBarlineSeparation as number ?? 0.4;
    P.push({ t: 'line', x1: 0, x2: 0, y1: 0, y2: bottom, w: thin, k: 'barline', o: oid({}) });
    for (let mi = ctx.a; mi <= ctx.b; mi++) {
      const bx = ctx.mx[mi] + ctx.placed[mi].endX;
      const bl = score.measures[mi].barline ?? 'single';
      const lastInSys = mi === ctx.b;
      for (const [s0, s1] of groupsOf) {
        const nBar = P.length;
        const y0 = ctx.staffY[s0], y1 = ctx.staffY[s1] + 4;
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
    void sep;
    // brace / bracket
    for (const g of score.groups) {
      const idx = g.staves.map((id) => score.staves.findIndex((s) => s.id === id)).filter((i) => i >= 0).sort((x, y) => x - y);
      if (!idx.length) continue;
      const y0 = ctx.staffY[idx[0]], y1 = ctx.staffY[idx[idx.length - 1]] + 4;
      if (g.kind === 'brace') {
        const b = sm.bbox('brace');
        const bh = b.y1 - b.y0;
        const sy = (y1 - y0) / bh;
        const sx = Math.min(3.2, 0.75 * sy);
        // glyph origin is at the bottom of the brace in SMuFL; place so its top edge matches the staff top
        P.push({ t: 'glyph', name: 'brace', x: -0.35 - b.x1 * sx, y: y1 + b.y0 * sy, sx, sy, k: 'brace', o: oid({}) });
      } else {
        P.push({ t: 'line', x1: -0.8, x2: -0.8, y1: y0 - 0.2, y2: y1 + 0.2, w: D.bracketThickness as number, k: 'brace', o: oid({}) });
      }
    }
    sysPrims.push(P);
    sysTop.push(Math.min(0, ...ext.map((e, s) => ctx.staffY[s] + e.top)));
    sysBottom.push(Math.max(bottom, ...ext.map((e, s) => ctx.staffY[s] + e.bottom)));
  }

  // ---- pages
  const pt = 0.3528 / S; // 1pt in staff spaces
  const pages: Page[] = [];
  const footerH = 3.5;
  const usableBottom = pageH - margin - footerH;
  const newPage = (): Page => { const p: Page = { width: pageW, height: pageH, prims: [] }; pages.push(p); return p; };
  const meta = score.meta;
  let page = newPage();
  // header on first page
  let top1 = margin + 1.5;
  const tsz = 22 * pt, ssz = 14 * pt, csz = 11 * pt;
  if (meta.title) { top1 += tsz * 0.9; page.prims.push({ t: 'text', x: pageW / 2, y: top1, s: meta.title, size: tsz, anchor: 'middle' }); }
  if (meta.subtitle) { top1 += ssz * 1.7; page.prims.push({ t: 'text', x: pageW / 2, y: top1, s: meta.subtitle, size: ssz, anchor: 'middle' }); }
  if (meta.composer) { top1 += csz * 1.9; page.prims.push({ t: 'text', x: pageW - margin, y: top1, s: meta.composer, size: csz, anchor: 'end' }); }
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
      pageIdx++; pageSystems[pageIdx] = [];
      cursor = topOf(pageIdx);
      y = cursor + needTop;
    }
    placeY[i] = y;
    pageSystems[pageIdx].push(i);
    cursor = y + sysBottom[i];
  });
  // vertical justification of full pages
  if (opts.justifyVertical ?? true) {
    pageSystems.forEach((list, pi) => {
      if (pi === pageSystems.length - 1 || list.length < 2) return;
      const last = list[list.length - 1];
      const extra = usableBottom - (placeY[last] + sysBottom[last]);
      if (extra <= 0) return;
      const per = Math.min(extra / (list.length - 1), 5);
      list.forEach((si, k) => { placeY[si] += per * k; });
    });
  }
  pageSystems.forEach((list, pi) => {
    if (pi > 0) page = newPage();
    const x0 = margin + braceRoom;
    for (const si of list) for (const p of sysPrims[si]) page.prims.push(shift(p, x0, placeY[si]));
    if (meta.rights) page.prims.push({ t: 'text', x: pageW / 2, y: pageH - margin, s: meta.rights, size: 9 * pt, anchor: 'middle' });
    if (pi > 0) page.prims.push({ t: 'text', x: pageW - margin, y: margin + 1.2, s: String(pi + 1), size: 10 * pt, anchor: 'end' });
  });
  return { pages, systems: systems.length, staffSpace: S };
}

/**
 * Dynamics and hairpins below a staff and above the next one share the gap between the two staves. Where both occur,
 * the upper-staff row is the reference and the lower staff's row moves up to its (absolute) baseline, so that they
 * read as one line — unless that would put them on top of each other horizontally.
 */
function alignDynamics(ctx: SysCtx, nS: number): void {
  const isMark = (p: Prim) => (p.k === 'dyn' || p.k === 'hairpin') && p.a !== undefined;
  const span = (p: Prim): [number, number] => (p.t === 'glyph' ? [p.x, p.x + sm.adv(p.name)] : p.t === 'line' ? [Math.min(p.x1, p.x2), Math.max(p.x1, p.x2)] : [0, 0]);
  for (let s = 0; s + 1 < nS; s++) {
    const below = ctx.prims[s].filter((p) => isMark(p) && p.a! > 4);
    const above = ctx.prims[s + 1].filter((p) => isMark(p) && p.a! < 0);
    if (!below.length || !above.length) continue;
    const target = ctx.staffY[s] + below[0].a!;
    const dy = target - (ctx.staffY[s + 1] + above[0].a!);
    if (dy >= 0) continue; // only ever move up, away from the lower staff
    // ... but never into the upper staff's own content (notes standing below it, ledger lines, ...)
    let dyMin = -Infinity;
    for (const p of above) {
      const [x0, x1] = span(p);
      const top = p.t === 'glyph' ? p.y - sm.bbox(p.name).y1 : p.t === 'line' ? Math.min(p.y1, p.y2) - 0.3 : 0;
      for (const b of ctx.sky[s].boxes) if (!b.spanner && b.x1 > x0 - 0.3 && b.x0 < x1 + 0.3) dyMin = Math.max(dyMin, ctx.staffY[s] - ctx.staffY[s + 1] + b.y1 + 0.3 - top);
    }
    const dyAdj = Math.max(dy, dyMin);
    if (dyAdj >= 0) continue;
    const clash = above.some((a) => below.some((b) => { const [a0, a1] = span(a), [b0, b1] = span(b); return a1 > b0 - 0.5 && a0 < b1 + 0.5; }));
    if (clash) continue;
    for (const p of above) {
      if (p.t === 'glyph') p.y += dyAdj;
      else if (p.t === 'line') { p.y1 += dyAdj; p.y2 += dyAdj; }
      p.a! += dyAdj;
    }
  }
}

function timeSig(P: Prim[], x: number, y0: number, ts: { beats: number; beatType: number }): void {
  const draw = (n: number, y: number) => {
    const s = String(n);
    const w = sm.adv('timeSig2');
    const total = s.length * w;
    let px = x;
    void total;
    for (const ch of s) { P.push({ t: 'glyph', name: `timeSig${ch}`, x: px, y }); px += w; }
  };
  const wn = String(ts.beats).length, wd = String(ts.beatType).length;
  const w = sm.adv('timeSig2');
  const maxw = Math.max(wn, wd) * w;
  const drawC = (n: number, y: number, len: number) => {
    const off = (maxw - len * w) / 2;
    let px = x + off;
    for (const ch of String(n)) { P.push({ t: 'glyph', name: `timeSig${ch}`, x: px, y }); px += w; }
  };
  void draw;
  const n0 = P.length;
  drawC(ts.beats, y0 + 1, wn);
  drawC(ts.beatType, y0 + 3, wd);
  tagFrom(P, n0, 'timesig', oid({}));
}

function shift(p: Prim, dx: number, dy: number): Prim {
  switch (p.t) {
    case 'glyph': return { ...p, x: p.x + dx, y: p.y + dy };
    case 'line': return { ...p, x1: p.x1 + dx, x2: p.x2 + dx, y1: p.y1 + dy, y2: p.y2 + dy };
    case 'text': return { ...p, x: p.x + dx, y: p.y + dy };
    case 'path': return { ...p, d: p.d.replace(/(-?\d*\.?\d+(?:e-?\d+)?)[ ,](-?\d*\.?\d+(?:e-?\d+)?)/gi, (_m, a: string, b: string) => `${(parseFloat(a) + dx).toFixed(3)} ${(parseFloat(b) + dy).toFixed(3)}`) };
  }
}
void keyAlter;
