// Hit testing on an engraved score: which model object is under a point, and which rhythmic slot and
// staff position a point means (for note input).
//
// `buildHitIndex` runs once per engraving. It reads the tags the engraver put on every primitive
// (`Prim.r`, `.n`, `.k`; see scene.ts), groups the primitives of one object into a `Target` with a few
// boxes (or sampled points for curves) and addresses it with a `Ref`. Queries are then plain geometry
// on those targets and never need the primitives again.

import type { Kind, Prim } from '../engrave/scene.ts';
import type { Engraved, Layout, MeasureGeom } from '../engrave/system.ts';
import type { Mark, Score } from '../model.ts';
import { flattenVoice, lineEnds, marksOf, pairLines } from '../model.ts';
import { loadSmufl } from '../smufl.ts';
import type { EvAddr, Ref, ScoreIndex } from './addr.ts';
import { eventOf, indexScore, markOf, refKey, tupletOf, voiceOf } from './addr.ts';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

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

export interface HitIndex {
  targets: Target[];
  byPage: Target[][];
  layout: Layout;
  index: ScoreIndex;
}

const PRIO: Partial<Record<Kind, number>> = {
  head: 0,
  rest: 0,
  acc: 1,
  dot: 1,
  artic: 1,
  arpeggio: 1,
  dyn: 1,
  hairpin: 1,
  pedal: 1,
  ottava: 1,
  tempo: 1,
  text: 1,
  stem: 2,
  flag: 2,
  ledger: 3,
  tie: 2,
  slur: 2,
  link: 2,
  tuplet: 3,
};

function primBox(p: Prim): Box | undefined {
  const sm = loadSmufl();
  switch (p.t) {
    case 'glyph': {
      const b = sm.bbox(p.name);
      const sx = p.sx ?? 1;
      const sy = p.sy ?? 1;
      return { x0: p.x + b.x0 * sx, x1: p.x + b.x1 * sx, y0: p.y - b.y1 * sy, y1: p.y - b.y0 * sy };
    }
    case 'line': {
      const h = p.w / 2;
      return {
        x0: Math.min(p.x1, p.x2) - h,
        x1: Math.max(p.x1, p.x2) + h,
        y0: Math.min(p.y1, p.y2) - h,
        y1: Math.max(p.y1, p.y2) + h,
      };
    }
    case 'text': {
      const w = p.s.length * p.size * 0.55;
      const x0 = p.anchor === 'middle' ? p.x - w / 2 : p.anchor === 'end' ? p.x - w : p.x;
      return { x0, x1: x0 + w, y0: p.y - p.size * 0.8, y1: p.y + p.size * 0.25 };
    }
    case 'path': {
      const n = pathNumbers(p);
      if (n.length < 4) return undefined;
      let x0 = Number.POSITIVE_INFINITY;
      let y0 = Number.POSITIVE_INFINITY;
      let x1 = Number.NEGATIVE_INFINITY;
      let y1 = Number.NEGATIVE_INFINITY;
      for (let i = 0; i + 1 < n.length; i += 2) {
        x0 = Math.min(x0, n[i]);
        x1 = Math.max(x1, n[i]);
        y0 = Math.min(y0, n[i + 1]);
        y1 = Math.max(y1, n[i + 1]);
      }
      return { x0, y0, x1, y1 };
    }
  }
}

/** The coordinates of a path's data as x y pairs (absolute commands; H and V are expanded), moved by the path's offset. */
function pathNumbers(p: Extract<Prim, { t: 'path' }>): number[] {
  const out: number[] = [];
  let cx = 0;
  let cy = 0;
  for (const seg of p.d.match(/[A-Za-z][^A-Za-z]*/g) ?? []) {
    const cmd = seg[0];
    const n =
      seg
        .slice(1)
        .match(/-?\d*\.?\d+/g)
        ?.map(Number) ?? [];
    if (cmd === 'H') {
      for (const x of n) {
        cx = x;
        out.push(cx, cy);
      }
    } else if (cmd === 'V') {
      for (const y of n) {
        cy = y;
        out.push(cx, cy);
      }
    } else {
      for (let i = 0; i + 1 < n.length; i += 2) {
        cx = n[i];
        cy = n[i + 1];
        out.push(cx, cy);
      }
    }
  }
  if (p.dx || p.dy)
    for (let i = 0; i + 1 < out.length; i += 2) {
      out[i] += p.dx ?? 0;
      out[i + 1] += p.dy ?? 0;
    }
  return out;
}

/** Points along the first (upper) curve of a crescent path "M x y C ... " */
function curvePts(p: Prim): { x: number; y: number }[] {
  if (p.t === 'line')
    return [
      { x: p.x1, y: p.y1 },
      { x: p.x2, y: p.y2 },
    ];
  const n = p.t === 'path' ? pathNumbers(p) : [];
  if (n.length < 8) return [];
  const [x0, y0, ax, ay, bx, by, x1, y1] = n;
  const out: { x: number; y: number }[] = [];
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const u = 1 - t;
    out.push({
      x: u * u * u * x0 + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * x1,
      y: u * u * u * y0 + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * y1,
    });
  }
  return out;
}

const union = (a: Box, b: Box): Box => ({
  x0: Math.min(a.x0, b.x0),
  y0: Math.min(a.y0, b.y0),
  x1: Math.max(a.x1, b.x1),
  y1: Math.max(a.y1, b.y1),
});

/** The model reference a primitive depicts (tagged by the engraver). */
export function primRef(index: ScoreIndex, p: Prim): Ref | undefined {
  const r = p.r;
  if (!r) return undefined;
  const ev = index.ev.get(r as never);
  if (ev) {
    if (p.k === 'tie') return { t: 'tie', ...ev, pi: p.n ?? 0 };
    if (p.k === 'slur') return { t: 'slur', ...ev, id: p.n ?? 1 };
    if (p.k === 'link') return { t: 'line', ...ev, id: p.n ?? 1 };
    return { t: 'ev', ...ev, ...((p.k === 'head' || p.k === 'acc') && p.n !== undefined ? { pi: p.n } : {}) };
  }
  const mk = index.mark.get(r as never);
  if (mk) return { t: 'mark', ...mk };
  const tp = index.tuplet.get(r as never);
  if (tp) return { t: 'tuplet', ...tp };
  return undefined;
}

const isCurveKind = (k: string | undefined) => k === 'slur' || k === 'tie' || k === 'link';

/** The key under which a prim joins a target: one target per model object and page (heads of an event are one each; slurs and ties are told apart from other prims of the same object). */
function targetKey(page: number, p: Prim, ref: Ref): { key: string; head: boolean } {
  const head = ref.t === 'ev' && ref.pi !== undefined;
  const kind = isCurveKind(p.k) ? `${p.k}|` : '';
  return { key: `${page}|${kind}${refKey(ref)}${head ? '|h' : ''}`, head };
}

/** Adds a prim (with its box) to the target of its model object, creating the target if needed. */
function addToTarget(byKey: Map<string, Target>, page: number, p: Prim, ref: Ref, bb: Box): void {
  const { key, head } = targetKey(page, p, ref);
  let t = byKey.get(key);
  if (!t) {
    t = { page, ref, k: head ? 'head' : p.k, boxes: [], bbox: bb, prio: PRIO[head ? 'head' : p.k] ?? 3 };
    byKey.set(key, t);
  }
  if (isCurveKind(p.k)) {
    t.pts ??= [];
    t.pts.push(...curvePts(p));
  } else t.boxes.push(bb);
  t.bbox = union(t.bbox, bb);
  if (p.k === 'rest') t.prio = 0;
}

/** The targets of a list of prims (all on one page): one per model object, curves and heads apart. */
function targetsOf(index: ScoreIndex, page: number, prims: Prim[]): Target[] {
  const byKey = new Map<string, Target>();
  for (const p of prims) {
    if (!p.k || p.k === 'beam') continue;
    const ref = primRef(index, p);
    const bb = ref && primBox(p);
    if (ref && bb) addToTarget(byKey, page, p, ref, bb);
  }
  return [...byKey.values()];
}

/**
 * The targets of each system, by the array of its primitives on the page. An engraving that reuses an
 * unchanged system hands over the same array (see `Engraved.placed`), whose primitives still point at
 * model objects that have not moved, so the targets made for it before are still right.
 */
const targetsOfSystem = new WeakMap<Prim[], { page: number; targets: Target[] }>();

export function buildHitIndex(score: Score, res: Engraved): HitIndex {
  const index = indexScore(score);
  const targets: Target[] = [];
  // Everything model-related on a page belongs to a system, so the systems' arrays are all there is to look at.
  for (const pl of res.placed) {
    let c = targetsOfSystem.get(pl.prims);
    if (!c || c.page !== pl.page) {
      c = { page: pl.page, targets: targetsOf(index, pl.page, pl.prims) };
      targetsOfSystem.set(pl.prims, c);
    }
    for (const t of c.targets) targets.push(t);
  }
  const byPage: Target[][] = res.pages.map(() => []);
  for (const t of targets) byPage[t.page].push(t);
  return { targets, byPage, layout: res.layout, index };
}

function distBox(b: Box, x: number, y: number): number {
  const dx = Math.max(b.x0 - x, 0, x - b.x1);
  const dy = Math.max(b.y0 - y, 0, y - b.y1);
  return Math.hypot(dx, dy);
}

/** Distance from (x, y) to the segment a-b. */
function distSegment(a: { x: number; y: number }, b: { x: number; y: number }, x: number, y: number): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const u = l2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
  return Math.hypot(a.x + u * dx - x, a.y + u * dy - y);
}

function distTarget(t: Target, x: number, y: number): number {
  if (t.pts) {
    // Distance to the polyline through the samples, not to the samples themselves: those are far
    // apart on a long slur and a point between two of them would otherwise miss.
    const pts = t.pts;
    return pts.reduce((m, a, i) => Math.min(m, distSegment(a, pts[i + 1] ?? a, x, y)), Number.POSITIVE_INFINITY);
  }
  return t.boxes.reduce((m, b) => Math.min(m, distBox(b, x, y)), Number.POSITIVE_INFINITY);
}

/** The object under (x, y) on a page, `tol` staff spaces of slack. */
export function hitTest(h: HitIndex, page: number, x: number, y: number, tol = 0.3): Target | undefined {
  let best: Target | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const t of h.byPage[page] ?? []) {
    if (x < t.bbox.x0 - tol - 2 && !t.pts) continue;
    const d = distTarget(t, x, y);
    const lim = t.k === 'slur' || t.k === 'tie' || t.k === 'link' ? 0.5 : tol;
    if (d > lim) continue;
    const s = t.prio * 0.4 + d;
    if (s < bestScore) {
      best = t;
      bestScore = s;
    }
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

// Slots: mapping a pointer position to where a note would go. That is a staff-measure, a rhythmic
// position (snapped to the engraver's columns) and a pitch row.
//
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
  for (const g of layout.measures)
    if (g.sys === sys.sys && g.staff === staff && x >= g.x0 && x < g.x1 + 0.01) {
      found = g;
      break;
    }
  return found;
}

/** x of a tick within a measure, interpolated between its columns. */
export function xOfTick(g: MeasureGeom, len: number, tick: number): number {
  const pts = [...g.cols.map((c) => ({ t: c.tick, x: c.x })), { t: len, x: g.x1 }];
  if (!pts.length || pts[0].t > 0) pts.unshift({ t: 0, x: Math.min(g.x0 + 1.2, pts[0]?.x ?? g.x1) });
  for (let i = 1; i < pts.length; i++)
    if (tick <= pts[i].t) {
      const a = pts[i - 1];
      const b = pts[i];
      return b.t === a.t ? b.x : a.x + ((b.x - a.x) * (tick - a.t)) / (b.t - a.t);
    }
  return g.x1;
}

/** The rhythmic position nearest to x: an existing column or a multiple of `grid` ticks (`'events'`: columns only, where marks can hang). */
export function snapTick(
  g: MeasureGeom,
  len: number,
  x: number,
  grid: number | 'events',
): { tick: number; x: number; onColumn: boolean } {
  const cand = new Map<number, boolean>();
  if (grid !== 'events') for (let t = 0; t < len; t += grid) cand.set(t, false);
  else if (!g.cols.some((c) => c.tick < len)) cand.set(0, false);
  for (const c of g.cols) if (c.tick < len) cand.set(c.tick, true);
  let best = { tick: 0, x: xOfTick(g, len, 0), onColumn: false };
  let bd = Number.POSITIVE_INFINITY;
  for (const [t, col] of cand) {
    const cx = xOfTick(g, len, t);
    const d = Math.abs(cx - x) - (col ? 0.15 : 0);
    if (d < bd) {
      bd = d;
      best = { tick: t, x: cx, onColumn: col };
    }
  }
  return best;
}

/** Staff position (half spaces above the bottom line) of a y on the staff whose top line is at `top`. */
export const posAtY = (top: number, y: number): number => Math.round((top + 4 - y) * 2);

export const yAtPos = (top: number, pos: number): number => top + 4 - pos / 2;

/** The measure of a given staff nearest to a point (used when a drag must stay on one staff). */
export function measureAtStaff(
  layout: Layout,
  page: number,
  x: number,
  y: number,
  staff: number,
): MeasureGeom | undefined {
  let best: MeasureGeom | undefined;
  let bd = Number.POSITIVE_INFINITY;
  for (const g of layout.measures) {
    if (g.page !== page || g.staff !== staff || x < g.x0 || x >= g.x1 + 0.01) continue;
    const d = Math.abs(g.y + 2 - y);
    if (d < bd) {
      bd = d;
      best = g;
    }
  }
  return best;
}

// Dependents: selecting a slur, tie, tuplet or mark highlights the notes it depends on, and this
// part of the file finds them.
//
// Selecting a slur, tie, tuplet or mark highlights the notes it depends on; this finds them.

/** All notes of a tuplet (and the event the ref points at). */
function tupletMembers(score: Score, ref: Extract<Ref, { t: 'tuplet' }>): EvAddr[] {
  const out: EvAddr[] = [{ mi: ref.mi, staff: ref.staff, voice: ref.voice, idx: ref.idx }];
  const v = voiceOf(score, ref);
  const g = v && tupletOf(score, ref);
  if (v && g)
    for (const te of flattenVoice(v))
      if (te.tuplets[ref.depth] === g) out.push({ mi: ref.mi, staff: ref.staff, voice: ref.voice, idx: te.index });
  return out;
}

/**
 * The note that ends a slur (the one carrying its stop) or receives a tie (the next note: a tie that
 * is not followed by a note has no end). Walks forward through the voice, across measures.
 */
function endNoteOf(score: Score, ref: Extract<Ref, { t: 'slur' | 'tie' }>): EvAddr | undefined {
  const start = eventOf(score, ref);
  for (let mi = ref.mi; mi < score.measures.length; mi++) {
    const v = voiceOf(score, { mi, staff: ref.staff, voice: ref.voice });
    if (!v) return undefined;
    for (const te of flattenVoice(v)) {
      if ((mi === ref.mi && te.index <= ref.idx) || te.ev === start) continue;
      const ends = ref.t === 'tie' ? te.ev.kind === 'note' : te.ev.slurStop?.includes(ref.id);
      if (ends) return { mi, staff: ref.staff, voice: ref.voice, idx: te.index };
      if (ref.t === 'tie') return undefined;
    }
  }
  return undefined;
}

/** The two notes of a line: the one it starts at and the one carrying the matching stop. */
function lineNotes(score: Score, ref: Extract<Ref, { t: 'line' }>): EvAddr[] {
  const at = (x: { mi: number; staff: string; voice: number; idx: number }): EvAddr => ({
    mi: x.mi,
    staff: x.staff,
    voice: x.voice,
    idx: x.idx,
  });
  const pair = pairLines(lineEnds(score)).pairs.find(
    ({ start }) =>
      start.id === ref.id &&
      start.ref.mi === ref.mi &&
      start.ref.staff === ref.staff &&
      start.ref.voice === ref.voice &&
      start.ref.idx === ref.idx,
  );
  return pair ? [at(pair.start.ref), at(pair.stop.ref)] : [at(ref)];
}

/** The notes a selected slur, tie or tuplet belongs to (its start and end notes; all notes of a tuplet). */
export function dependentNotes(score: Score, ref: Ref): EvAddr[] {
  if (ref.t === 'mark') return markNotes(score, ref);
  if (ref.t === 'tuplet') return tupletMembers(score, ref);
  if (ref.t === 'line') return lineNotes(score, ref);
  if (ref.t !== 'slur' && ref.t !== 'tie') return [];
  const start: EvAddr = { mi: ref.mi, staff: ref.staff, voice: ref.voice, idx: ref.idx };
  const end = endNoteOf(score, ref);
  return end ? [start, end] : [start];
}

/**
 * The event a mark belongs to, as a reader sees it: the one it hangs on, except for a stop, which ends the event before
 * (marks at the end of a measure hang on the voice's last event).
 */
function anchorOf(score: Score, staff: string, mi: number, m: Mark): EvAddr | undefined {
  const at = { staff, voice: m.voice };
  const count = (i: number) => {
    const v = voiceOf(score, { mi: i, ...at });
    return v ? flattenVoice(v).length : 0;
  };
  if (m.idx < 0) {
    const n = count(mi);
    return n ? { mi, ...at, idx: n - 1 } : undefined;
  }
  if (m.type !== 'stop') return { mi, ...at, idx: m.idx };
  if (m.idx > 0) return { mi, ...at, idx: m.idx - 1 };
  for (let i = mi - 1; i >= 0; i--) {
    const n = count(i);
    if (n) return { mi: i, ...at, idx: n - 1 };
  } // This is the last event of the previous measure.
  return { mi, ...at, idx: 0 };
}

/** The events a mark hangs on; for the start of a hairpin, pedal or octave shift also those of its end. */
function markNotes(score: Score, ref: Extract<Ref, { t: 'mark' }>): EvAddr[] {
  const m = markOf(score, ref);
  if (!m) return [];
  const out: EvAddr[] = [];
  const own = anchorOf(score, ref.staff, ref.mi, m);
  if (own) out.push(own);
  const ends =
    m.type === 'hairpin'
      ? (x: Mark) => x.type === 'stop' && x.of === 'hairpin' && x.id === m.id
      : m.type === 'pedal' || m.type === 'ottava'
        ? (x: Mark) => x.type === 'stop' && x.of === m.type
        : undefined;
  if (ends)
    for (let mi = ref.mi; mi < score.measures.length; mi++) {
      const stop = marksOf(score.measures[mi].staves[ref.staff]).find(
        (x) => ends(x) && (mi > ref.mi || x.tick > m.tick),
      );
      if (stop) {
        const a = anchorOf(score, ref.staff, mi, stop);
        if (a) out.push(a);
        break;
      }
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
  for (const t of heads)
    if (keys.has(key(t.ref))) {
      out.push(t.bbox);
      own.add(key(t.ref));
    }
  for (const t of ts) {
    if (t.ref.t !== 'ev' || t.k !== 'stem' || !keys.has(key(t.ref)) || own.has(key(t.ref))) continue;
    const b = t.bbox;
    const r = 0.8;
    const ends: Box[] = [
      { x0: b.x0 - r, x1: b.x1 + r, y0: b.y0 - r, y1: b.y0 + r },
      { x0: b.x0 - r, x1: b.x1 + r, y0: b.y1 - r, y1: b.y1 + r },
    ];
    for (const hd of heads)
      if (ends.some((e) => hd.bbox.x0 <= e.x1 && hd.bbox.x1 >= e.x0 && hd.bbox.y0 <= e.y1 && hd.bbox.y1 >= e.y0))
        out.push(hd.bbox);
  }
  return out;
}

/**
 * The event a position on a staff-measure stands for: the one at the nearest column (a mark hangs on it), in voice `prefer`
 * if it has an event there, else in the first voice that does. Undefined when the staff-measure has no events.
 */
export function eventAtX(
  score: Score,
  g: MeasureGeom,
  staff: string,
  len: number,
  x: number,
  prefer: number,
): EvAddr | undefined {
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
