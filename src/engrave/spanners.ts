// Ties, slurs and marks (dynamics, hairpins, pedal, octave shifts, tempo, text).
import { pitchStep, type Mark } from '../model.ts';
import { loadSmufl } from '../smufl.ts';
import { posToY, type EvL } from './prep.ts';
import { D, geomOf, xAtTick, type SysCtx } from './draw.ts';
import { DOT_STEP } from './spacing.ts';
import type { Prim } from './scene.ts';

const sm = loadSmufl();

/** Filled crescent from (x0,y0) to (x1,y1) bulging `h` away from the chord; `thick` at the middle, `tip` at the ends. */
function crescent(x0: number, y0: number, x1: number, y1: number, h: number, thick: number, above: boolean, tip = 0.1): string {
  const s = above ? -1 : 1;
  const L = x1 - x0;
  const k = h / 0.75;
  const k2 = Math.max(0, k - thick / 0.75);
  const c = (t: number, kk: number) => `${(x0 + L * t).toFixed(3)} ${(y0 + (y1 - y0) * t + s * kk).toFixed(3)}`;
  // the inner edge ends slightly towards the chord so that the tips keep a visible thickness
  const iy0 = y0 - s * tip, iy1 = y1 - s * tip;
  return `M${x0.toFixed(3)} ${y0.toFixed(3)}C${c(0.3, k)} ${c(0.7, k)} ${x1.toFixed(3)} ${y1.toFixed(3)}L${x1.toFixed(3)} ${iy1.toFixed(3)}C${c(0.7, k2 - s * tip * 0)} ${c(0.3, k2)} ${x0.toFixed(3)} ${iy0.toFixed(3)}Z`;
}

export function drawSpanners(systems: SysCtx[]): void {
  if (!systems.length) return;
  const prep = systems[0].prep;
  const nS = prep.score.staves.length;
  const sysOf: number[] = [];
  systems.forEach((s, i) => { for (let m = s.a; m <= s.b; m++) sysOf[m] = i; });

  // ---- per staff, per voice event lists over the whole piece
  for (let s = 0; s < nS; s++) {
    const voiceEvs = new Map<number, EvL[]>();
    const timeOrder: EvL[] = [];
    for (let mi = 0; mi < prep.measures.length; mi++) {
      for (const v of prep.measures[mi][s].voices) {
        if (!voiceEvs.has(v.id)) voiceEvs.set(v.id, []);
        voiceEvs.get(v.id)!.push(...v.evs);
      }
      timeOrder.push(...prep.measures[mi][s].evs);
    }
    // ---- ties
    for (const [, evs] of voiceEvs) {
      evs.forEach((e, i) => {
        if (e.ev.kind !== 'note') return;
        e.heads.forEach((h, hi) => {
          if (!h.tie) return;
          let next: EvL | undefined, nh: number = -1;
          for (let k = i + 1; k < evs.length && k <= i + 2; k++) {
            if (evs[k].ev.kind !== 'note') { if (evs[k].ev.kind === 'rest' && !(evs[k].ev as { hidden?: boolean }).hidden) break; continue; }
            nh = evs[k].heads.findIndex((x) => pitchStep(x.pitch) === pitchStep(h.pitch) && x.pitch.alter === h.pitch.alter);
            if (nh >= 0) { next = evs[k]; }
            break;
          }
          drawTie(systems, sysOf, e, hi, next, nh);
        });
      });
    }
    // ---- slurs
    const open = new Map<string, { ev: EvL; side?: 'above' | 'below' }>();
    for (const e of timeOrder) {
      for (const id of e.ev.slurStop ?? []) {
        const k = `${e.voice}|${id}`;
        const st = open.get(k);
        if (st) { drawSlur(systems, sysOf, st.ev, e, st.side, voiceEvs.get(e.voice)!); open.delete(k); }
      }
      for (const ss of e.ev.slurStart ?? []) open.set(`${e.voice}|${ss.id}`, { ev: e, side: ss.side });
    }
  }
  // ---- marks
  for (let s = 0; s < nS; s++) drawMarks(systems, sysOf, s);
}

function headPoint(e: EvL, side: 'above' | 'below', margin: number): { x: number; y: number; stemSide: boolean } {
  const g = geomOf.get(e)!;
  const above = side === 'above';
  const stemSide = e.stem === (above ? 'up' : 'down');
  if (stemSide) return { x: g.stemX, y: above ? g.stemTip - margin * 0.8 : g.stemTip + margin * 0.8, stemSide };
  const ref = above ? e.heads.reduce((a, h) => (h.pos > a.pos ? h : a)) : e.heads.reduce((a, h) => (h.pos < a.pos ? h : a));
  return { x: e.x + ref.dx + g.hw / 2, y: posToY(ref.pos) + (above ? -margin : margin), stemSide };
}

function drawTie(systems: SysCtx[], sysOf: number[], e: EvL, hi: number, next: EvL | undefined, nh: number): void {
  const h = e.heads[hi];
  const g = geomOf.get(e)!;
  let above: boolean;
  if (e.nVoices > 1) above = e.voiceRank === 0;
  else if (e.heads.length > 1) above = hi >= e.heads.length / 2;
  else above = e.stem === 'down';
  if (e.heads.length > 1 && e.nVoices === 1) {
    const sorted = [...e.heads].sort((a, b) => a.pos - b.pos);
    above = sorted.indexOf(h) >= sorted.length / 2;
  }
  const dots = e.te.ev.dur.dots;
  const y = posToY(h.pos) + (above ? -0.38 : 0.38);
  const x0 = e.x + h.dx + g.hw + 0.12 + (dots ? 0.4 + DOT_STEP * dots : 0);
  const si = systems[e.mi >= 0 ? sysOfIndex(systems, e.mi) : 0];
  const thick = D.tieMidpointThickness as number;
  const place = (ctx: SysCtx, xa: number, xb: number) => {
    const len = xb - xa;
    if (len < 0.4) return;
    const hgt = Math.min(1.1, 0.4 + len * 0.045);
    ctx.prims[e.staff].push({ t: 'path', d: crescent(xa, y, xb, y, hgt, thick, above) });
    ctx.sky[e.staff].add(xa, xb, above ? y - hgt - 0.1 : y, above ? y : y + hgt + 0.1);
  };
  if (!next || nh < 0) { place(si, x0, Math.min(x0 + 2.6, si.width)); return; }
  const sj = systems[sysOfIndex(systems, next.mi)];
  const x1 = next.x + next.heads[nh].dx - 0.12;
  const yN = posToY(next.heads[nh].pos) + (above ? -0.38 : 0.38);
  void yN;
  if (sj === si) place(si, x0, x1);
  else { place(si, x0, si.width - 0.2); place(sj, Math.max(sj.prefix - 0.6, 0.5), x1); }
}

function sysOfIndex(systems: SysCtx[], mi: number): number {
  for (let i = 0; i < systems.length; i++) if (mi >= systems[i].a && mi <= systems[i].b) return i;
  return 0;
}

function drawSlur(systems: SysCtx[], sysOf: number[], a: EvL, b: EvL, explicit: 'above' | 'below' | undefined, voice: EvL[]): void {
  if (a.ev.kind !== 'note' || b.ev.kind !== 'note') return;
  // side
  let side: 'above' | 'below';
  if (explicit) side = explicit;
  else if (a.nVoices > 1) side = a.voiceRank === 0 ? 'above' : 'below';
  else {
    const ia = voice.indexOf(a), ib = voice.indexOf(b);
    const span = voice.slice(ia, ib + 1).filter((x) => x.ev.kind === 'note');
    const ups = span.filter((x) => x.stem === 'up').length, downs = span.filter((x) => x.stem === 'down').length;
    side = ups > 0 && downs === 0 ? 'below' : 'above';
  }
  const above = side === 'above';
  const pa = headPoint(a, side, 0.65), pb = headPoint(b, side, 0.65);
  // a tie starting on the same side as the slur: start the slur above the tie
  const tieSide = (e: EvL): 'above' | 'below' | null => (e.heads.some((h) => h.tie) ? (e.nVoices > 1 ? (e.voiceRank === 0 ? 'above' : 'below') : e.stem === 'down' ? 'above' : 'below') : null);
  if (tieSide(a) === side && !pa.stemSide) pa.y += above ? -0.7 : 0.7;
  const sa = systems[sysOf[a.mi]], sb = systems[sysOf[b.mi]];
  const thick = (D.slurMidpointThickness as number) * 1.3;
  const piece = (ctx: SysCtx, x0: number, y0: number, x1: number, y1: number, staff: number) => {
    const L = x1 - x0;
    if (L < 0.5) return;
    let h = Math.max(0.6, Math.min(2.3, 0.065 * L + 0.5));
    const sky = ctx.sky[staff];
    const win = 0.7;
    for (let t = 0.1; t <= 0.9001; t += 0.05) {
      const x = x0 + L * t;
      const chord = y0 + (y1 - y0) * t;
      const f = 4 * t * (1 - t);
      if (x < x0 + 0.9 || x > x1 - 0.9) continue;
      const obst = above ? sky.top(x - win / 2, x + win / 2, 99) : sky.bottom(x - win / 2, x + win / 2, -99);
      if (above && obst < 90) h = Math.max(h, (chord - (obst - 0.3)) / (f * 0.95));
      if (!above && obst > -90) h = Math.max(h, ((obst + 0.3) - chord) / (f * 0.95));
    }
    h = Math.min(h, 5);
    ctx.prims[staff].push({ t: 'path', d: crescent(x0, y0, x1, y1, h, thick, above) });
    const ym = Math.min(y0, y1), yM = Math.max(y0, y1);
    sky.add(x0, x1, above ? ym - h : ym, above ? yM : yM + h);
  };
  if (sa === sb) piece(sa, pa.x, pa.y, pb.x, pb.y, a.staff);
  else {
    piece(sa, pa.x, pa.y, sa.width - 0.2, pa.y, a.staff);
    piece(sb, Math.max(sb.prefix - 0.3, 0.5), pb.y, pb.x, pb.y, b.staff);
  }
}

// ------------------------------------------------------------------ marks
interface Item {
  kind: 'dyn' | 'hair' | 'pedal' | 'ott' | 'tempo' | 'text';
  x0: number; x1: number;
  side: 'above' | 'below';
  up: number; down: number; // extent above / below the reference line
  draw: (ref: number) => Prim[];
  row: number;
  order: number;
}

function dynRun(text: string): { names: string[]; w: number; up: number; down: number } {
  const map: Record<string, string> = { p: 'dynamicPiano', m: 'dynamicMezzo', f: 'dynamicForte', r: 'dynamicRinforzando', s: 'dynamicSforzando', z: 'dynamicZ', n: 'dynamicNiente' };
  const names = text.split('').map((c) => map[c]).filter(Boolean);
  let w = 0, up = 0, down = 0;
  for (const n of names) { const b = sm.bbox(n); w += sm.adv(n); up = Math.max(up, b.y1); down = Math.max(down, -b.y0); }
  return { names, w, up, down };
}

interface Span { mark: Mark & { type: string }; mi: number; end?: { mark: Mark; mi: number } }

function drawMarks(systems: SysCtx[], sysOf: number[], s: number): void {
  const prep = systems[0].prep;
  const staffId = prep.score.staves[s].id;
  void staffId;
  const items: Item[][] = systems.map(() => []);
  // collect spans
  const hairs: Span[] = [], pedals: Span[] = [], otts: Span[] = [];
  const openHair = new Map<number, Span>();
  let openPedal: Span | null = null, openOtt: Span | null = null;
  const lastMi = prep.measures.length - 1;
  for (let mi = 0; mi < prep.measures.length; mi++) {
    for (const m of prep.measures[mi][s].marks) {
      const sys = systems[sysOf[mi]];
      const x = xAtTick(sys, mi, m.tick);
      const si = sysOf[mi];
      switch (m.type) {
        case 'dynamic': {
          const r = dynRun(m.text);
          const cx = x + 0.6;
          const side = m.placement ?? 'below';
          items[si].push({ kind: 'dyn', x0: cx - r.w / 2, x1: cx + r.w / 2, side, up: r.up, down: r.down, row: 0, order: 0, draw: (ref) => { let px = cx - r.w / 2; return r.names.map((n) => { const p: Prim = { t: 'glyph', name: n, x: px, y: ref }; px += sm.adv(n); return p; }); } });
          break;
        }
        case 'hairpin': { const sp: Span = { mark: m, mi }; openHair.set(m.id, sp); hairs.push(sp); break; }
        case 'hairpin-stop': { const sp = openHair.get(m.id); if (sp) { sp.end = { mark: m, mi }; openHair.delete(m.id); } break; }
        case 'pedal-start': { if (openPedal && !openPedal.end) openPedal.end = { mark: m, mi }; openPedal = { mark: m, mi }; pedals.push(openPedal); break; }
        case 'pedal-stop': { if (openPedal) { openPedal.end = { mark: m, mi }; openPedal = null; } break; }
        case 'ottava-start': { openOtt = { mark: m, mi }; otts.push(openOtt); break; }
        case 'ottava-stop': { if (openOtt) { openOtt.end = { mark: m, mi }; openOtt = null; } break; }
        case 'tempo': {
          const unit = m.unit === 4 ? 'metNoteQuarterUp' : m.unit === 2 ? 'metNoteHalfUp' : 'metNoteQuarterUp';
          const nb = sm.bbox(unit);
          const label = `= ${m.bpm}`;
          const size = 2.2;
          const wText = label.length * size * 0.5;
          const dotsW = m.dots * 0.5;
          items[si].push({
            kind: 'tempo', x0: x, x1: x + nb.x1 + dotsW + 0.5 + wText, side: 'above', up: 1.6, down: 0.2, row: 0, order: 0,
            draw: (ref) => {
              const out: Prim[] = [{ t: 'glyph', name: unit, x, y: ref }];
              for (let k = 0; k < m.dots; k++) out.push({ t: 'glyph', name: 'metAugmentationDot', x: x + nb.x1 + 0.2 + k * 0.5, y: ref });
              out.push({ t: 'text', x: x + nb.x1 + dotsW + 0.5, y: ref + 0.45, s: label, size, bold: false });
              return out;
            },
          });
          break;
        }
        case 'text': {
          const side = m.placement ?? 'above';
          const size = 2.0;
          items[si].push({ kind: 'text', x0: x, x1: x + m.text.length * size * 0.5, side, up: 1.5, down: 0.5, row: 0, order: 1, draw: (ref) => [{ t: 'text', x, y: ref, s: m.text, size, italic: true }] });
          break;
        }
        default: break;
      }
    }
  }
  const endOfPiece = { mi: lastMi, tick: prep.measureLen[lastMi] };
  // spans -> per-system pieces
  const pieces = (sp: Span, startOff: number, endOff: number): { si: number; x0: number; x1: number; first: boolean; last: boolean }[] => {
    const m0 = sp.mi, t0 = (sp.mark as Mark).tick;
    const m1 = sp.end ? sp.end.mi : endOfPiece.mi, t1 = sp.end ? (sp.end.mark as Mark).tick : endOfPiece.tick;
    const out: { si: number; x0: number; x1: number; first: boolean; last: boolean }[] = [];
    const s0 = sysOf[m0], s1 = sysOf[m1];
    for (let si = s0; si <= s1; si++) {
      const ctx = systems[si];
      const first = si === s0, last = si === s1;
      const x0 = first ? xAtTick(ctx, m0, t0) + startOff : ctx.prefix;
      const x1 = last ? xAtTick(ctx, m1, t1) + endOff : ctx.width - 0.3;
      if (x1 - x0 > 0.3) out.push({ si, x0, x1, first, last });
    }
    return out;
  };
  // hairpins
  const W = 1.15;
  for (const sp of hairs) {
    const m = sp.mark as Mark & { type: 'hairpin' };
    const ps = pieces(sp, 0, -0.5);
    const total = ps.reduce((a, p) => a + (p.x1 - p.x0), 0);
    let acc = 0;
    for (const p of ps) {
      const len = p.x1 - p.x0;
      const f0 = acc / total, f1 = (acc + len) / total;
      acc += len;
      const wide = W, mid = W * 0.55;
      const o0 = m.kind === 'cresc' ? (p.first ? 0 : mid) : (p.first ? wide : mid);
      const o1 = m.kind === 'cresc' ? (p.last ? wide : mid) : (p.last ? 0 : mid);
      void f0; void f1;
      const th = D.hairpinThickness as number;
      items[p.si].push({
        kind: 'hair', x0: p.x0, x1: p.x1, side: m.placement ?? 'below', up: Math.max(o0, o1) / 2 + th, down: Math.max(o0, o1) / 2 + th, row: 0, order: 0,
        draw: (ref) => [
          { t: 'line', x1: p.x0, y1: ref - o0 / 2, x2: p.x1, y2: ref - o1 / 2, w: th },
          { t: 'line', x1: p.x0, y1: ref + o0 / 2, x2: p.x1, y2: ref + o1 / 2, w: th },
        ],
      });
    }
  }
  // pedal
  for (const sp of pedals) {
    const ps = pieces(sp, -0.2, -0.2);
    const pedB = sm.bbox('keyboardPedalPed');
    const pedW = sm.adv('keyboardPedalPed');
    const th = D.pedalLineThickness as number;
    for (const p of ps) {
      const upExt = pedB.y1, downExt = -pedB.y0;
      items[p.si].push({
        kind: 'pedal', x0: p.x0, x1: p.x1, side: 'below', up: upExt, down: downExt, row: 1, order: 0,
        draw: (ref) => {
          const out: Prim[] = [];
          let lx = p.x0;
          if (p.first) { out.push({ t: 'glyph', name: 'keyboardPedalPed', x: p.x0, y: ref }); lx = p.x0 + pedW + 0.3; }
          const ly = ref - 0.25;
          if (p.x1 - lx > 0.2) out.push({ t: 'line', x1: lx, y1: ly, x2: p.x1, y2: ly, w: th });
          if (p.last && sp.end) out.push({ t: 'line', x1: p.x1, y1: ly, x2: p.x1, y2: ly - 0.9, w: th });
          return out;
        },
      });
    }
  }
  // octave shifts
  for (const sp of otts) {
    const m = sp.mark as Mark & { type: 'ottava-start' };
    const above = m.dir === 'up';
    const gname = above ? 'ottavaAlta' : 'ottavaBassa';
    const gb = sm.bbox(gname);
    const gw = sm.adv(gname);
    const ps = pieces(sp, -0.2, 0.7);
    for (const p of ps) {
      const up = Math.max(gb.y1, 0.8), down = Math.max(-gb.y0, 0.8);
      items[p.si].push({
        kind: 'ott', x0: p.x0, x1: p.x1, side: above ? 'above' : 'below', up, down, row: 0, order: -1,
        draw: (ref) => {
          const out: Prim[] = [];
          const ly = ref - (gb.y1 + gb.y0) / 2 + (above ? 0 : 0);
          let lx = p.x0;
          if (p.first) { out.push({ t: 'glyph', name: gname, x: p.x0, y: ref }); lx = p.x0 + gw + 0.3; }
          const th = D.octaveLineThickness as number;
          void ly;
          const lineY = ref - (gb.y1 + gb.y0) / 2;
          out.push({ t: 'line', x1: lx, y1: lineY, x2: p.x1, y2: lineY, w: th, dash: [0.5, 0.35] });
          if (p.last && sp.end) out.push({ t: 'line', x1: p.x1, y1: lineY, x2: p.x1, y2: lineY + (above ? 0.9 : -0.9), w: th });
          return out;
        },
      });
    }
  }
  // ---- place per system
  systems.forEach((ctx, si) => {
    const sky = ctx.sky[s];
    const its = items[si];
    const place = (side: 'above' | 'below') => {
      const list = its.filter((i) => i.side === side).sort((a, b) => a.row - b.row || a.order - b.order || a.x0 - b.x0);
      // cluster dynamics & hairpins (same row) that touch so they share one baseline
      const groups: Item[][] = [];
      let cur: Item[] = [];
      let curRow = -99, curEnd = -Infinity;
      for (const it of list) {
        const clusterable = it.kind === 'dyn' || it.kind === 'hair';
        if (clusterable && cur.length && it.row === curRow && it.x0 < curEnd + 2.5 && (cur[0].kind === 'dyn' || cur[0].kind === 'hair')) { cur.push(it); curEnd = Math.max(curEnd, it.x1); }
        else { if (cur.length) groups.push(cur); cur = [it]; curRow = it.row; curEnd = it.x1; }
      }
      if (cur.length) groups.push(cur);
      for (const g of groups) {
        const clear = 0.55;
        let ref = side === 'below' ? -Infinity : Infinity;
        for (const it of g) {
          const hairOff = it.kind === 'hair' ? 0.55 : 0; // hairpin centre sits above the dynamic baseline
          if (side === 'below') {
            const b = sky.bottom(it.x0, it.x1, 4);
            ref = Math.max(ref, b + clear + it.up + (it.kind === 'hair' ? 0 : 0) + hairOff);
          } else {
            const t = sky.top(it.x0, it.x1, 0);
            ref = Math.min(ref, t - clear - it.down + hairOff * 0);
          }
        }
        for (const it of g) {
          const r = it.kind === 'hair' ? ref - 0.55 : ref;
          for (const p of it.draw(r)) ctx.prims[s].push(p);
          sky.add(it.x0, it.x1, r - it.up, r + it.down);
        }
      }
    };
    place('above');
    place('below');
  });
}
