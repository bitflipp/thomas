// Hit testing on an engraved score: which model object is under a point, and which rhythmic slot and
// staff position a point means (for note input).
//
// `buildHitIndex` runs once per engraving. It reads the tags the engraver put on every primitive
// (`Prim.r`, `.n`, `.k`; see scene.ts), groups the primitives of one object into a `Target` with a few
// boxes (or sampled points for curves) and addresses it with a `Ref`. Queries are then plain geometry
// on those targets and never need the primitives again.
import type { Engraved, Layout, MeasureGeom } from '../engrave/system.ts';
import type { Kind, Prim } from '../engrave/scene.ts';
import { loadSmufl } from '../smufl.ts';
import { markOf, eventOf, type EvAddr, indexScore, refKey, tupletOf, voiceOf, type Ref, type ScoreIndex } from './addr.ts';
import { flattenVoice, marksOf, type Mark, type Score } from '../model.ts';

export interface Box { x0: number; y0: number; x1: number; y1: number }
export interface Target {
  page: number;
  ref: Ref;
  k: Kind;
  /** The parts that count as "on" the object. */
  boxes: Box[];
  /** Curves (slurs, ties): sampled points along the curve instead of boxes, so the empty inside of a slur is not a hit. */
  pts?: { x: number; y: number }[];
  bbox: Box;
  /** Lower wins when several targets are under the pointer: a head beats the stem and a slur over it. */
  prio: number;
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
  if (t.pts) {
    // Distance to the polyline through the samples, not to the samples themselves: those are far
    // apart on a long slur and a point between two of them would otherwise miss.
    let m = Infinity;
    for (let i = 0; i < t.pts.length; i++) {
      const a = t.pts[i], b = t.pts[i + 1] ?? a, dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const u = l2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
      m = Math.min(m, Math.hypot(a.x + u * dx - x, a.y + u * dy - y));
    }
    return m;
  }
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
    const ref: Ref = { ...rest } as Ref;
    out.set(refKey(ref), ref);
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- slots
// Mapping a point to where a note would go: staff-measure, rhythmic position (snapped to columns) and pitch row.

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

/** The rhythmic position nearest to x: an existing column or a multiple of `grid` ticks (`'events'`: columns only, where marks can hang). */
export function snapTick(g: MeasureGeom, len: number, x: number, grid: number | 'events'): { tick: number; x: number; onColumn: boolean } {
  const cand = new Map<number, boolean>();
  if (grid !== 'events') for (let t = 0; t < len; t += grid) cand.set(t, false);
  else if (!g.cols.some((c) => c.tick < len)) cand.set(0, false);
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

// ---------------------------------------------------------------- dependents
// Selecting a slur, tie, tuplet or mark highlights the notes it depends on; this finds them.

/** The notes a selected slur, tie or tuplet belongs to (its start and end notes; all notes of a tuplet). */
export function dependentNotes(score: Score, ref: Ref): EvAddr[] {
  if (ref.t === 'mark') return markNotes(score, ref);
  if (ref.t !== 'slur' && ref.t !== 'tie' && ref.t !== 'tuplet') return [];
  const out: EvAddr[] = [{ mi: ref.mi, staff: ref.staff, voice: ref.voice, idx: ref.idx }];
  if (ref.t === 'tuplet') {
    const v = voiceOf(score, ref), g = v && tupletOf(score, ref);
    if (v && g) for (const te of flattenVoice(v)) if (te.tuplets[ref.depth] === g) out.push({ mi: ref.mi, staff: ref.staff, voice: ref.voice, idx: te.index });
    return out;
  }
  // Walk forward through the voice, across measures, to the note that ends the slur (the one carrying
  // its stop) or receives the tie (the next note: a tie that is not followed by a note has no end).
  const start = eventOf(score, ref);
  for (let mi = ref.mi; mi < score.measures.length; mi++) {
    const v = voiceOf(score, { mi, staff: ref.staff, voice: ref.voice });
    if (!v) break;
    for (const te of flattenVoice(v)) {
      if (mi === ref.mi && te.index <= ref.idx) continue;
      if (te.ev === start) continue;
      if (ref.t === 'tie' ? te.ev.kind === 'note' : te.ev.slurStop?.includes(ref.id)) { out.push({ mi, staff: ref.staff, voice: ref.voice, idx: te.index }); return out; }
      if (ref.t === 'tie') return out;
    }
  }
  return out;
}

/**
 * The event a mark belongs to, as a reader sees it: the one it hangs on, except for a stop, which ends the event before
 * (marks at the end of a measure hang on the voice's last event).
 */
function anchorOf(score: Score, staff: string, mi: number, m: Mark): EvAddr | undefined {
  const at = { staff, voice: m.voice };
  const count = (i: number) => { const v = voiceOf(score, { mi: i, ...at }); return v ? flattenVoice(v).length : 0; };
  if (m.idx < 0) { const n = count(mi); return n ? { mi, ...at, idx: n - 1 } : undefined; }
  if (m.type !== 'stop') return { mi, ...at, idx: m.idx };
  if (m.idx > 0) return { mi, ...at, idx: m.idx - 1 };
  for (let i = mi - 1; i >= 0; i--) { const n = count(i); if (n) return { mi: i, ...at, idx: n - 1 }; } // the previous measure's last event
  return { mi, ...at, idx: 0 };
}

/** The events a mark hangs on; for the start of a hairpin, pedal or octave shift also those of its end. */
function markNotes(score: Score, ref: Extract<Ref, { t: 'mark' }>): EvAddr[] {
  const m = markOf(score, ref);
  if (!m) return [];
  const out: EvAddr[] = [];
  const own = anchorOf(score, ref.staff, ref.mi, m);
  if (own) out.push(own);
  const ends = m.type === 'hairpin' ? (x: Mark) => x.type === 'stop' && x.of === 'hairpin' && x.id === m.id
    : m.type === 'pedal' || m.type === 'ottava' ? (x: Mark) => x.type === 'stop' && x.of === m.type : undefined;
  if (ends) for (let mi = ref.mi; mi < score.measures.length; mi++) {
    const stop = marksOf(score.measures[mi].staves[ref.staff]).find((x) => ends(x) && (mi > ref.mi || x.tick > m.tick));
    if (stop) { const a = anchorOf(score, ref.staff, mi, stop); if (a) out.push(a); break; }
  }
  return out;
}

/**
 * Where the notes `want` sit on a page. A note whose head is shared with a note of another voice (a unison) has no head of its own
 * in the drawing: it is found as the head touching the end of its stem.
 */
export function noteBoxes(h: HitIndex, page: number, want: EvAddr[]): Box[] {
  const keys = new Set(want.map((a) => `${a.mi}:${a.staff}:${a.voice}:${a.idx}`));
  const key = (r: Ref) => (r.t === 'ev' ? `${r.mi}:${r.staff}:${r.voice}:${r.idx}` : '');
  const ts = h.byPage[page] ?? [];
  const heads = ts.filter((t) => t.ref.t === 'ev' && (t.k === 'head' || t.k === 'rest'));
  const out: Box[] = [];
  const own = new Set<string>();
  for (const t of heads) if (keys.has(key(t.ref))) { out.push(t.bbox); own.add(key(t.ref)); }
  for (const t of ts) {
    if (t.ref.t !== 'ev' || t.k !== 'stem' || !keys.has(key(t.ref)) || own.has(key(t.ref))) continue;
    const b = t.bbox, r = 0.8;
    const ends: Box[] = [{ x0: b.x0 - r, x1: b.x1 + r, y0: b.y0 - r, y1: b.y0 + r }, { x0: b.x0 - r, x1: b.x1 + r, y0: b.y1 - r, y1: b.y1 + r }];
    for (const hd of heads) if (ends.some((e) => hd.bbox.x0 <= e.x1 && hd.bbox.x1 >= e.x0 && hd.bbox.y0 <= e.y1 && hd.bbox.y1 >= e.y0)) out.push(hd.bbox);
  }
  return out;
}

/**
 * The event a position on a staff-measure stands for: the one at the nearest column (a mark hangs on it), in voice `prefer`
 * if it has an event there, else in the first voice that does. Undefined when the staff-measure has no events.
 */
export function eventAtX(score: Score, g: MeasureGeom, staff: string, len: number, x: number, prefer: number): EvAddr | undefined {
  const sn = snapTick(g, len, x, 'events');
  const sm = score.measures[g.mi]?.staves[staff];
  if (!sm) return undefined;
  const voices = [...sm.voices].sort((a, b) => Number(b.id === prefer) - Number(a.id === prefer));
  for (const v of voices) {
    const te = flattenVoice(v).find((t) => t.start === sn.tick);
    if (te) return { mi: g.mi, staff, voice: v.id, idx: te.index };
  }
  return undefined;
}
