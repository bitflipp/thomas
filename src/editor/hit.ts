// Hit testing on an engraved score: which model object is under a point, which rhythmic slot and staff position a point means.
import type { Engraved, Layout, MeasureGeom } from '../engrave/system.ts';
import type { Kind, Prim } from '../engrave/scene.ts';
import { loadSmufl } from '../smufl.ts';
import { indexScore, refKey, type Ref, type ScoreIndex } from './addr.ts';
import type { Score } from '../model.ts';

export interface Box { x0: number; y0: number; x1: number; y1: number }
export interface Target {
  page: number;
  ref: Ref;
  k: Kind;
  boxes: Box[]; // the parts that count as "on" the object
  pts?: { x: number; y: number }[]; // curves (slurs, ties): sampled points instead of boxes
  bbox: Box;
  prio: number; // lower wins when several are under the pointer
}
export interface HitIndex { targets: Target[]; byPage: Target[][]; layout: Layout; index: ScoreIndex }

const PRIO: Partial<Record<Kind, number>> = { head: 0, rest: 0, acc: 1, dot: 1, artic: 1, arpeggio: 1, dyn: 1, hairpin: 1, pedal: 1, ottava: 1, tempo: 1, text: 1, stem: 2, flag: 2, ledger: 3, tie: 2, slur: 2, tuplet: 3 };

function primBox(p: Prim): Box | undefined {
  const sm = loadSmufl();
  switch (p.t) {
    case 'glyph': {
      const b = sm.bbox(p.name), sx = p.sx ?? 1, sy = p.sy ?? 1;
      return { x0: p.x + b.x0 * sx, x1: p.x + b.x1 * sx, y0: p.y - b.y1 * sy, y1: p.y - b.y0 * sy };
    }
    case 'line': { const h = p.w / 2; return { x0: Math.min(p.x1, p.x2) - h, x1: Math.max(p.x1, p.x2) + h, y0: Math.min(p.y1, p.y2) - h, y1: Math.max(p.y1, p.y2) + h }; }
    case 'text': {
      const w = p.s.length * p.size * 0.55;
      const x0 = p.anchor === 'middle' ? p.x - w / 2 : p.anchor === 'end' ? p.x - w : p.x;
      return { x0, x1: x0 + w, y0: p.y - p.size * 0.8, y1: p.y + p.size * 0.25 };
    }
    case 'path': {
      const n = p.d.match(/-?\d*\.?\d+/g)?.map(Number) ?? [];
      if (n.length < 4) return undefined;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i + 1 < n.length; i += 2) { x0 = Math.min(x0, n[i]); x1 = Math.max(x1, n[i]); y0 = Math.min(y0, n[i + 1]); y1 = Math.max(y1, n[i + 1]); }
      return { x0, y0, x1, y1 };
    }
  }
}

/** Points along the first (upper) curve of a crescent path "M x y C ... " */
function curvePts(d: string): { x: number; y: number }[] {
  const n = d.match(/-?\d*\.?\d+/g)?.map(Number) ?? [];
  if (n.length < 8) return [];
  const [x0, y0, ax, ay, bx, by, x1, y1] = n;
  const out: { x: number; y: number }[] = [];
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const u = 1 - t;
    out.push({ x: u * u * u * x0 + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * x1, y: u * u * u * y0 + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * y1 });
  }
  return out;
}

const union = (a: Box, b: Box): Box => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });

/** The model reference a primitive depicts (tagged by the engraver). */
export function primRef(index: ScoreIndex, p: Prim): Ref | undefined {
  const r = p.r;
  if (!r) return undefined;
  const ev = index.ev.get(r as never);
  if (ev) {
    if (p.k === 'tie') return { t: 'tie', ...ev, pi: p.n ?? 0 };
    if (p.k === 'slur') return { t: 'slur', ...ev, id: p.n ?? 1 };
    return { t: 'ev', ...ev, ...((p.k === 'head' || p.k === 'acc') && p.n !== undefined ? { pi: p.n } : {}) };
  }
  const mk = index.mark.get(r as never);
  if (mk) return { t: 'mark', ...mk };
  const tp = index.tuplet.get(r as never);
  if (tp) return { t: 'tuplet', ...tp };
  return undefined;
}

export function buildHitIndex(score: Score, res: Engraved): HitIndex {
  const index = indexScore(score);
  const byKey = new Map<string, Target>();
  const refOf = (p: Prim) => primRef(index, p);
  res.pages.forEach((page, pi) => {
    for (const p of page.prims) {
      if (!p.k || p.k === 'beam') continue;
      const ref = refOf(p);
      if (!ref) continue;
      const bb = primBox(p);
      if (!bb) continue;
      const head = ref.t === 'ev' && ref.pi !== undefined;
      const key = `${pi}|${p.k === 'slur' || p.k === 'tie' ? p.k + '|' : ''}${refKey(ref)}${head ? '|h' : ''}`;
      let t = byKey.get(key);
      if (!t) { t = { page: pi, ref, k: head ? 'head' : p.k, boxes: [], bbox: bb, prio: PRIO[head ? 'head' : p.k] ?? 3 }; byKey.set(key, t); }
      if (p.k === 'slur' || p.k === 'tie') (t.pts ??= []).push(...curvePts(p.t === 'path' ? p.d : ''));
      else t.boxes.push(bb);
      t.bbox = union(t.bbox, bb);
      if (p.k === 'rest') t.prio = 0;
    }
  });
  const targets = [...byKey.values()];
  const byPage: Target[][] = res.pages.map(() => []);
  for (const t of targets) byPage[t.page].push(t);
  return { targets, byPage, layout: res.layout, index };
}

function distBox(b: Box, x: number, y: number): number {
  const dx = Math.max(b.x0 - x, 0, x - b.x1), dy = Math.max(b.y0 - y, 0, y - b.y1);
  return Math.hypot(dx, dy);
}
function distTarget(t: Target, x: number, y: number): number {
  if (t.pts) return t.pts.reduce((m, q) => Math.min(m, Math.hypot(q.x - x, q.y - y)), Infinity);
  return t.boxes.reduce((m, b) => Math.min(m, distBox(b, x, y)), Infinity);
}

/** The object under (x, y) on a page, `tol` staff spaces of slack. */
export function hitTest(h: HitIndex, page: number, x: number, y: number, tol = 0.3): Target | undefined {
  let best: Target | undefined, bestScore = Infinity;
  for (const t of h.byPage[page] ?? []) {
    if (x < t.bbox.x0 - tol - 2 && !t.pts) continue;
    const d = distTarget(t, x, y);
    const lim = t.k === 'slur' || t.k === 'tie' ? 0.5 : tol;
    if (d > lim) continue;
    const s = t.prio * 0.4 + d;
    if (s < bestScore) { best = t; bestScore = s; }
  }
  return best;
}

/** Events (notes and rests) whose heads touch the rectangle. */
export function marquee(h: HitIndex, page: number, r: Box): Ref[] {
  const out = new Map<string, Ref>();
  for (const t of h.byPage[page] ?? []) {
    if (t.ref.t !== 'ev' || (t.k !== 'head' && t.k !== 'rest')) continue;
    if (t.bbox.x1 < r.x0 || t.bbox.x0 > r.x1 || t.bbox.y1 < r.y0 || t.bbox.y0 > r.y1) continue;
    const { pi: _pi, ...rest } = t.ref;
    void _pi;
    const ref: Ref = { ...rest } as Ref;
    out.set(refKey(ref), ref);
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- slots

/** The staff-measure under a point: the nearest staff (vertically) of the system there, then the measure by x. */
export function measureAt(layout: Layout, page: number, x: number, y: number): MeasureGeom | undefined {
  let best: { sys: (typeof layout.systems)[number]; staff: number; d: number } | undefined;
  for (const sys of layout.systems) {
    if (sys.page !== page || x < sys.x0 - 1 || x > sys.x1 + 1) continue;
    sys.staffY.forEach((top, staff) => {
      const d = y < top ? top - y : y > top + 4 ? y - top - 4 : 0;
      if (d < 7 && (!best || d < best.d)) best = { sys, staff, d };
    });
  }
  if (!best) return undefined;
  const { sys, staff } = best;
  let found: MeasureGeom | undefined;
  for (const g of layout.measures) if (g.sys === sys.sys && g.staff === staff && x >= g.x0 && x < g.x1 + 0.01) { found = g; break; }
  return found;
}

/** x of a tick within a measure, interpolated between its columns. */
export function xOfTick(g: MeasureGeom, len: number, tick: number): number {
  const pts = [...g.cols.map((c) => ({ t: c.tick, x: c.x })), { t: len, x: g.x1 }];
  if (!pts.length || pts[0].t > 0) pts.unshift({ t: 0, x: Math.min(g.x0 + 1.2, pts[0]?.x ?? g.x1) });
  for (let i = 1; i < pts.length; i++) if (tick <= pts[i].t) { const a = pts[i - 1], b = pts[i]; return b.t === a.t ? b.x : a.x + ((b.x - a.x) * (tick - a.t)) / (b.t - a.t); }
  return g.x1;
}

/** The rhythmic position nearest to x: an existing column or a multiple of `grid` ticks. */
export function snapTick(g: MeasureGeom, len: number, x: number, grid: number): { tick: number; x: number; onColumn: boolean } {
  const cand = new Map<number, boolean>();
  for (let t = 0; t < len; t += grid) cand.set(t, false);
  for (const c of g.cols) if (c.tick < len) cand.set(c.tick, true);
  let best = { tick: 0, x: xOfTick(g, len, 0), onColumn: false }, bd = Infinity;
  for (const [t, col] of cand) {
    const cx = xOfTick(g, len, t), d = Math.abs(cx - x) - (col ? 0.15 : 0);
    if (d < bd) { bd = d; best = { tick: t, x: cx, onColumn: col }; }
  }
  return best;
}

/** Staff position (half spaces above the bottom line) of a y on the staff whose top line is at `top`. */
export const posAtY = (top: number, y: number): number => Math.round((top + 4 - y) * 2);
export const yAtPos = (top: number, pos: number): number => top + 4 - pos / 2;

/** The measure of a given staff nearest to a point (used when a drag must stay on one staff). */
export function measureAtStaff(layout: Layout, page: number, x: number, y: number, staff: number): MeasureGeom | undefined {
  let best: MeasureGeom | undefined, bd = Infinity;
  for (const g of layout.measures) {
    if (g.page !== page || g.staff !== staff || x < g.x0 || x >= g.x1 + 0.01) continue;
    const d = Math.abs(g.y + 2 - y);
    if (d < bd) { bd = d; best = g; }
  }
  return best;
}
