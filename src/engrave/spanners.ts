// Ties, slurs and the other spans that can cross system breaks. They are drawn after all systems exist
// (planSpanners), against the skyline of the notes; marks.ts and lyrics.ts run from here as well.

import type { LineEnd } from '../model.ts';
import { pairLines, pitchStep } from '../model.ts';
import { loadSmufl } from '../smufl.ts';
import { must } from '../util.ts';
import type { SysCtx } from './draw.ts';
import { articExtent, D, geomOf, staffOffset } from './draw.ts';
import { drawLyrics } from './lyrics.ts';
import { drawMarks } from './marks.ts';
import type { EvL } from './prep.ts';
import { beamLevels, posToY } from './prep.ts';
import { oid, Skyline } from './scene.ts';
import { DOT_STEP, END_CLEF_GAP, flagGlyph, STEM_T } from './spacing.ts';
import { drawVoltas } from './volta.ts';

const sm = loadSmufl();

type Side = 'above' | 'below';

/**
 * The form of a slur's cubic: `a0`/`a1` are how far along the span (as a fraction) the control points sit, and `m0`/`m1`
 * scale how high each one is lifted off the chord. The symmetric default is `{ a0: 0.2, a1: 0.2, m0: 1, m1: 1 }`; a
 * skewed shape moves the peak toward the end with the larger lift, so a slur can hug a low side and rise over a high one.
 */
interface SlurShape {
  a0: number;
  a1: number;
  m0: number;
  m1: number;
}

const SYMMETRIC: SlurShape = { a0: 0.2, a1: 0.2, m0: 1, m1: 1 };

/** The rounder shape of ties. */
const TIE_SHAPE: SlurShape = { a0: 0.3, a1: 0.3, m0: 1, m1: 1 };

/** The four control points (x, y) of the outer edge of a slur of height `h` over the chord (x0,y0)-(x1,y1). */
function slurControls(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  h: number,
  above: boolean,
  sh: SlurShape,
): [number, number][] {
  const s = above ? -1 : 1;
  const L = x1 - x0;
  const k = h / 0.75;
  return [
    [x0, y0],
    [x0 + L * sh.a0, y0 + (y1 - y0) * 0.3 + s * k * sh.m0],
    [x1 - L * sh.a1, y0 + (y1 - y0) * 0.7 + s * k * sh.m1],
    [x1, y1],
  ];
}

/** Filled crescent from (x0,y0) to (x1,y1) bulging `h` away from the chord; `thick` at the middle, `tip` at the ends. */
function crescent(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  h: number,
  thick: number,
  above: boolean,
  tip = 0.1,
  sh: SlurShape = SYMMETRIC,
): string {
  const s = above ? -1 : 1;
  const out = slurControls(x0, y0, x1, y1, h, above, sh);
  const inn = slurControls(x0, y0, x1, y1, Math.max(0, h - thick), above, sh);
  const f = (q: [number, number]) => `${q[0].toFixed(3)} ${q[1].toFixed(3)}`;
  // The inner edge ends slightly toward the chord (`tip`) so that the tips of the crescent
  // keep a visible thickness instead of tapering to a hairline.
  const iy0 = y0 - s * tip;
  const iy1 = y1 - s * tip;
  return `M${f(out[0])}C${f(out[1])} ${f(out[2])} ${f(out[3])}L${x1.toFixed(3)} ${iy1.toFixed(3)}C${f(inn[2])} ${f(inn[1])} ${x0.toFixed(3)} ${iy0.toFixed(3)}Z`;
}

/** Points per curve in the tables of `curveTable`. */
const TABLE_N = 48;

/**
 * The outer edge of a slur shape sampled at `TABLE_N + 1` parameter values: x, the y of the curve at height 0, and
 * the y gained per unit of height. The curve's y is linear in `h`, so the least height clearing an obstacle is a
 * division, not a search.
 */
function curveTable(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  above: boolean,
  sh: SlurShape,
): { x: number[]; y: number[]; g: number[] } {
  const base = slurControls(x0, y0, x1, y1, 0, above, sh);
  const unit = slurControls(x0, y0, x1, y1, 0.75, above, sh);
  const x: number[] = [];
  const y: number[] = [];
  const g: number[] = [];
  for (let i = 0; i <= TABLE_N; i++) {
    const t = i / TABLE_N;
    const w = [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3];
    const at = (c: [number, number][], d: 0 | 1) => c.reduce((sum, q, j) => sum + w[j] * q[d], 0);
    x.push(at(base, 0));
    y.push(at(base, 1));
    g.push((at(unit, 1) - at(base, 1)) / 0.75);
  }
  return { x, y, g };
}

/** The tied head of `e` connects to the same pitch in the next event of the voice, unless a rest stands in between. */
function findTieTarget(evs: EvL[], i: number, head: EvL['heads'][number]): { next?: EvL; nh: number } {
  for (let k = i + 1; k < evs.length && k <= i + 2; k++) {
    const candidate = evs[k];
    if (candidate.ev.kind !== 'note') {
      if (candidate.ev.kind === 'rest' && candidate.ev.style !== 'hidden') break;
      continue;
    }
    const nh = candidate.heads.findIndex(
      (x) => pitchStep(x.pitch) === pitchStep(head.pitch) && x.pitch.alter === head.pitch.alter,
    );
    return nh >= 0 ? { next: candidate, nh } : { nh };
  }
  return { nh: -1 };
}

/** A tie that finds no note in its own voice may end on the same pitch in another voice of the staff starting exactly where the tied note ends. */
function findOtherVoiceTarget(
  timeOrder: EvL[],
  measureLen: number[],
  e: EvL,
  head: EvL['heads'][number],
): { next?: EvL; nh: number } {
  const end = e.start + e.ticks;
  const wrap = end >= measureLen[e.mi];
  for (const c of timeOrder) {
    if (c.voice === e.voice || c.ev.kind !== 'note') continue;
    if (!(wrap ? c.mi === e.mi + 1 && c.start === 0 : c.mi === e.mi && c.start === end)) continue;
    const nh = c.heads.findIndex(
      (x) => pitchStep(x.pitch) === pitchStep(head.pitch) && x.pitch.alter === head.pitch.alter,
    );
    if (nh >= 0) return { next: c, nh };
  }
  return { nh: -1 };
}

/**
 * Ties of one voice, one unit per tied head. The tie of a note whose successor is in another system is drawn in two halves.
 * Nested ties of a chord are drawn from the inside out: the arc nearest the chord first, the outer
 * ones around it, so each can clear the previous one through the skyline.
 */
function tieUnits(
  systems: SysCtx[],
  sysOf: number[],
  evs: EvL[],
  timeOrder: EvL[],
  measureLen: number[],
): SpannerUnit[] {
  const out: SpannerUnit[] = [];
  evs.forEach((e, i) => {
    if (e.ev.kind !== 'note' || !e.heads.some((h) => h.tie)) return;
    const order = e.heads
      .map((_, hi) => hi)
      .sort((p, q) => {
        const pa = tieAbove(e, p);
        const qa = tieAbove(e, q);
        if (pa !== qa) return pa ? -1 : 1;
        return pa ? e.heads[p].pos - e.heads[q].pos : e.heads[q].pos - e.heads[p].pos;
      });
    for (const hi of order) {
      if (!e.heads[hi].tie) continue;
      let { next, nh } = findTieTarget(evs, i, e.heads[hi]);
      if (!next) ({ next, nh } = findOtherVoiceTarget(timeOrder, measureLen, e, e.heads[hi]));
      const second = next && nh >= 0 ? sysOf[next.mi] : sysOf[e.mi];
      out.push({
        sys: [sysOf[e.mi], second],
        key: `t${e.id}.${hi}${e.heads[hi].tieSide ?? ''}>${next ? next.id : -1}.${nh}`,
        cross: false,
        draw: () => drawTie(systems, e, hi, next, nh),
      });
    }
  });
  return out;
}

/** Slurs of one staff, matched start to stop by voice and id; each is a unit that draws it, tagged with whether it crosses staves. */
function matchSlurs(systems: SysCtx[], sysOf: number[], timeOrder: EvL[], voiceEvs: Map<number, EvL[]>): SpannerUnit[] {
  const out: SpannerUnit[] = [];
  const open = new Map<string, { ev: EvL; side?: Side; id: number; skewed: boolean }>();
  for (const e of timeOrder) {
    for (const id of e.ev.slurStop ?? []) {
      const key = `${e.voice}|${id}`;
      const start = open.get(key);
      if (!start) continue;
      const voice = must(voiceEvs.get(e.voice));
      // The side is part of the key: it depends on the stems of every note between the ends, which may lie in other systems.
      const side = start.ev.ev.kind === 'note' && e.ev.kind === 'note' ? slurSide(start.ev, e, start.side, voice) : '-';
      out.push({
        sys: [sysOf[start.ev.mi], sysOf[e.mi]],
        key: `s${start.ev.id}>${e.id}.${start.id}.${side}${start.skewed ? '/' : ''}`,
        draw: () => drawSlur(systems, sysOf, start.ev, e, start.side, voice, start.id, start.skewed),
        cross: start.ev.staff !== start.ev.home || e.staff !== start.ev.home,
      });
      open.delete(key);
    }
    for (const ss of e.ev.slurStart ?? [])
      open.set(`${e.voice}|${ss.id}`, { ev: e, side: ss.side, id: ss.id, skewed: ss.skewed === true });
  }
  return out;
}

/** Lines between notes: pairs of ends found over the whole piece (any voices and staves), drawn when both ends are in one system. */
function linkUnits(systems: SysCtx[], sysOf: number[]): SpannerUnit[] {
  const ends: LineEnd<EvL>[] = [];
  for (const measure of systems[0].prep.measures)
    for (const sml of measure)
      for (const v of sml.voices)
        for (const e of v.evs) {
          const at = { mi: e.mi, tick: e.start, ord: e.home * 1000 + e.voice, ref: e };
          for (const st of e.ev.lineStart ?? []) ends.push({ ...at, role: 'start', id: st.id });
          for (const x of e.ev.lineStop ?? []) ends.push({ ...at, role: 'stop', id: x.id });
        }
  if (!ends.length) return [];
  const out: SpannerUnit[] = [];
  for (const { start, stop } of pairLines(ends).pairs) {
    const a = start.ref;
    const b = stop.ref;
    if (a === b || sysOf[a.mi] !== sysOf[b.mi]) continue; // A line is drawn only within one system.
    const dashed = !!a.ev.lineStart?.find((x) => x.id === start.id)?.dashed;
    out.push({
      sys: [sysOf[a.mi]],
      key: `l${a.id}>${b.id}.${start.id}${dashed ? 'd' : ''}`,
      cross: a.staff !== b.staff,
      draw: () =>
        drawLink(
          systems[sysOf[a.mi]],
          a,
          b,
          start.id,
          dashed,
          headOf(a, start.id, 'start'),
          headOf(b, stop.id, 'stop'),
        ),
    });
  }
  return out;
}

/** The chord pitch a line end is attached to, or `undefined` for the chord as a whole (or a head the note does not have). */
function headOf(e: EvL, id: number, role: 'start' | 'stop'): number | undefined {
  const x = (role === 'start' ? e.ev.lineStart : e.ev.lineStop)?.find((l) => l.id === id);
  return x && x.head !== undefined && x.head < e.heads.length ? x.head : undefined;
}

const linkOwners = new WeakMap<EvL, Map<number, number>>();

/** Owner tag of a line, stable across drawings (see `slurOwner`). */
function linkOwner(a: EvL, id: number): number {
  let m = linkOwners.get(a);
  if (!m) {
    m = new Map();
    linkOwners.set(a, m);
  }
  let o = m.get(id);
  if (o === undefined) {
    o = oid({});
    m.set(id, o);
  }
  return o;
}

/** The clearance a line keeps from the heads, stem and accidentals of the notes it joins. */
const LINK_CLEAR = 0.6;

/**
 * A straight line between notes `a` and `b`, in the coordinates of `a`'s staff. Each end is the point nearest to the
 * centroid of that note's heads (all of them, so the line points at the chord as a whole, or the one head `ha`/`hb` it
 * is attached to) that keeps `LINK_CLEAR` from the note's heads, stem and accidentals and is reached from the other
 * end without crossing them. Where the stem or an accidental is in the way the end therefore moves only as far from
 * the centroid as it has to. Nothing is recorded in the skyline.
 */
function drawLink(ctx: SysCtx, a: EvL, b: EvL, id: number, dashed: boolean, ha?: number, hb?: number): void {
  if (a.ev.kind !== 'note' || b.ev.kind !== 'note') return;
  const yOf = (e: EvL, pos: number) => posToY(pos) + staffOffset(ctx, a.staff, e.staff);
  /** What a line must keep away from at one note: signed distance to the nearest obstacle (negative inside). */
  const obstacles = (e: EvL) => {
    const g = must(geomOf.get(e));
    const off = staffOffset(ctx, a.staff, e.staff);
    const heads = e.heads.map((h) => ({ x: e.x + h.dx + g.hw / 2, y: yOf(e, h.pos), acc: h.accX }));
    const [lo, hi] = [Math.min(g.stemTip, g.stemBase) + off, Math.max(g.stemTip, g.stemBase) + off];
    const box = (px: number, py: number, x0: number, x1: number, y0: number, y1: number) => {
      const qx = Math.max(x0 - px, 0, px - x1);
      const qy = Math.max(y0 - py, 0, py - y1);
      const inside = qx === 0 && qy === 0 ? -Math.min(px - x0, x1 - px, py - y0, y1 - py) : 0;
      return qx || qy ? Math.hypot(qx, qy) : inside;
    };
    return {
      heads,
      dist: (px: number, py: number): number => {
        let d = Number.POSITIVE_INFINITY;
        for (const h of heads) {
          d = Math.min(d, (Math.hypot((px - h.x) / (g.hw / 2), (py - h.y) / 0.5) - 1) * 0.5);
          if (h.acc !== undefined) d = Math.min(d, box(px, py, e.x + h.acc, e.x + h.acc + 1.1, h.y - 1, h.y + 1));
        }
        if (e.stem) d = Math.min(d, box(px, py, g.stemX - STEM_T / 2, g.stemX + STEM_T / 2, lo, hi));
        return d;
      },
    };
  };
  const oa = obstacles(a);
  const ob = obstacles(b);
  /** The centroid of the heads of a note, or the position of its one chosen head. */
  const centroid = (o: ReturnType<typeof obstacles>, only?: number) => {
    const hs = only === undefined ? o.heads : [o.heads[only]];
    return { x: hs.reduce((t, h) => t + h.x, 0) / hs.length, y: hs.reduce((t, h) => t + h.y, 0) / hs.length };
  };
  const ca = centroid(oa, ha);
  const cb = centroid(ob, hb);
  /** The end at one note for a line coming from `from`: the free point nearest to the centroid that `from` sees. */
  const endAt = (o: ReturnType<typeof obstacles>, c: { x: number; y: number }, from: { x: number; y: number }) => {
    const toward = Math.atan2(from.y - c.y, from.x - c.x);
    const free = (px: number, py: number) => {
      if (o.dist(px, py) < LINK_CLEAR) return false;
      const n = Math.ceil(Math.hypot(px - from.x, py - from.y) / 0.1);
      for (let i = 0; i < n; i++) {
        const t = i / n;
        if (o.dist(from.x + (px - from.x) * t, from.y + (py - from.y) * t) < LINK_CLEAR * 0.85) return false;
      }
      return true;
    };
    for (let r = 0; r <= 5; r += 0.1)
      for (let k = 0; k < 24; k++) {
        // The angles are tried from the direction of `from` outward to both sides.
        const turn = (Math.ceil(k / 2) * (k % 2 ? 1 : -1) * 2 * Math.PI) / 24;
        const px = c.x + r * Math.cos(toward + turn);
        const py = c.y + r * Math.sin(toward + turn);
        if (free(px, py)) return { x: px, y: py };
      }
    return c;
  };
  let pb = endAt(ob, cb, ca);
  const pa = endAt(oa, ca, pb);
  pb = endAt(ob, cb, pa);
  const x0 = pa.x;
  const y0 = pa.y;
  const x1 = pb.x;
  const y1 = pb.y;
  if (Math.hypot(x1 - x0, y1 - y0) < 0.5) return;
  ctx.prims[a.staff].push({
    t: 'line',
    x1: x0,
    y1: y0,
    x2: x1,
    y2: y1,
    w: 0.12,
    ...(dashed ? { dash: [0.45, 0.3] as [number, number] } : {}),
    k: 'link',
    o: linkOwner(a, id),
    r: a.ev,
    n: id,
  });
}

/** One tie or slur to draw: the systems it puts primitives into, what identifies it (its ends and whatever else it depends on beyond those systems), and how to draw it. */
interface SpannerUnit {
  sys: number[];
  key: string;
  cross: boolean;
  draw: () => void;
}

/**
 * What the ties and slurs of the next drawing will be: `affected` are the systems that must be rewound and drawn
 * again and `draw` draws the units touching them, in the order a full drawing would. `sigs` identifies the units
 * of each system.
 *
 * A system is affected when it is in `dirty`, when its units differ from `prevSigs` (the ones drawn before), and
 * when a unit touching it also touches an affected system (the pieces of one tie or slur are drawn together).
 * What is not affected has its previous ties and slurs still right: they depend only on the system's own
 * notes and on the notes at the ends of the units.
 */
export interface SpannerPlan {
  affected: Set<number>;
  sigs: string[];
  draw: () => void;
}

/**
 * Plans the ties and slurs of all `systems` and says which systems need redrawing (see `SpannerPlan`). `dirty` are
 * the systems whose notes were redrawn, `prevSigs` the unit signatures of the previous drawing.
 */
export function planSpanners(
  systems: SysCtx[],
  dirty: Set<number>,
  prevSigs: (string | undefined)[] = [],
): SpannerPlan {
  const prep = systems[0].prep;
  const nStaves = prep.score.staves.length;
  const sysOf = sysOfMeasures(systems);
  const ties: SpannerUnit[] = [];
  const slurs: SpannerUnit[] = [];
  // Per staff: gather each voice's events over the whole piece (ties and slurs run across measures
  // and systems), then plan this staff's ties and slurs.
  for (let s = 0; s < nStaves; s++) {
    const voiceEvs = new Map<number, EvL[]>();
    const timeOrder: EvL[] = [];
    for (const measure of prep.measures) {
      for (const v of measure[s].voices) {
        const list = voiceEvs.get(v.id);
        if (list) for (const e of v.evs) list.push(e);
        else voiceEvs.set(v.id, [...v.evs]);
      }
      // Slurs belong to the voice, wherever its (cross-staff) notes are drawn; `timeOrder` is the staff's
      // events by time so that stops can be matched to starts.
      for (const e of measure[s].byTime) timeOrder.push(e);
    }
    for (const evs of voiceEvs.values()) ties.push(...tieUnits(systems, sysOf, evs, timeOrder, prep.measureLen));
    slurs.push(...matchSlurs(systems, sysOf, timeOrder, voiceEvs));
  }
  // Slurs between staves go first so that the others nest around them; lines take no part in the skyline and come last.
  const units = [
    ...ties,
    ...slurs.filter((q) => q.cross),
    ...slurs.filter((q) => !q.cross),
    ...linkUnits(systems, sysOf),
  ];
  const keys: string[][] = systems.map(() => []);
  for (const u of units) for (const i of new Set(u.sys)) keys[i].push(u.key);
  const sigs = keys.map((k) => k.join(','));
  const affected = new Set<number>(dirty);
  systems.forEach((_, i) => {
    if (prevSigs[i] !== sigs[i]) affected.add(i);
  });
  for (let grew = true; grew; ) {
    grew = false;
    for (const u of units) {
      if (!u.sys.some((i) => affected.has(i))) continue;
      for (const i of u.sys)
        if (!affected.has(i)) {
          affected.add(i);
          grew = true;
        }
    }
  }
  return {
    affected,
    sigs,
    draw: () => {
      for (const u of units) if (u.sys.some((i) => affected.has(i))) u.draw();
    },
  };
}

/** System index of each measure. */
function sysOfMeasures(systems: SysCtx[]): number[] {
  const sysOf: number[] = [];
  systems.forEach((s, i) => {
    for (let m = s.a; m <= s.b; m++) sysOf[m] = i;
  });
  return sysOf;
}

/**
 * Marks come after the ties and slurs so that they see their skylines and are stacked outside them. They are cheap
 * and depend on spans that run across many systems, so they are always drawn for every system.
 */
export function drawStaffMarks(systems: SysCtx[]): void {
  const sysOf = sysOfMeasures(systems);
  drawVoltas(systems);
  drawLyrics(systems, sysOf);
  for (let s = 0; s < systems[0].prep.score.staves.length; s++) drawMarks(systems, sysOf, s);
}

// The clear gap between a slur and whatever it passes: a notehead, a stem tip, an articulation, or an obstacle under
// its arc. One value keeps the distances even; the slur's own thickness comes on top where it matters.
const SLUR_CLEAR = 0.45;

// How far from an open (system-break) end obstacles are ignored, in staff spaces.
const OPEN_BLIND = 2.5;

// How far from an attached end obstacles are ignored: the note itself, its stem and flag stand there.
const ATTACHED_BLIND = 1.3;

// Half the height of a notehead, one staff space high.
const HEAD_HALF = 0.5;

/** The point where a slur on `side` attaches to `e`: at the stem tip when the stem is on that side, else beyond the outermost head; beyond any articulations on that side. */
function headPoint(e: EvL, side: 'above' | 'below'): { x: number; y: number; stemSide: boolean; homed: boolean } {
  const g = must(geomOf.get(e));
  const above = side === 'above';
  const stemSide = e.stem === (above ? 'up' : 'down');
  // Articulations on the same side as the slur: start just beyond them, since a slur that
  // began at the head would run through the articulation.
  const ax = articExtent.get(e);
  const artEdge = ax && ax.above === above ? ax.edge + (above ? -SLUR_CLEAR : SLUR_CLEAR) : undefined;
  if (stemSide)
    return {
      x: g.stemX,
      y: artEdge ?? (above ? g.stemTip - SLUR_CLEAR : g.stemTip + SLUR_CLEAR),
      stemSide,
      homed: !!g.homed,
    };
  const headGap = HEAD_HALF + SLUR_CLEAR; // This is measured from the center of the outermost head.
  const ref = above
    ? e.heads.reduce((a, h) => (h.pos > a.pos ? h : a))
    : e.heads.reduce((a, h) => (h.pos < a.pos ? h : a));
  return {
    x: e.x + ref.dx + g.hw / 2,
    y: artEdge ?? posToY(ref.pos) + (above ? -headGap : headGap),
    stemSide,
    homed: false,
  };
}

/** Does the tie of head `hi` arch above it? As forced, else by voice with several voices, by position within a chord, else opposite to the stem. */
function tieAbove(e: EvL, hi: number): boolean {
  const h = e.heads[hi];
  if (h.tieSide) return h.tieSide === 'above';
  if (e.nVoices > 1) return e.voiceRank === 0;
  if (e.heads.length > 1) {
    // The upper half of a chord ties upwards, the lower half downwards, so that the ties fan
    // out from the middle of the chord and never cross.
    const sorted = [...e.heads].sort((a, b) => a.pos - b.pos);
    return sorted.indexOf(h) >= sorted.length / 2;
  }
  return e.stem === 'down';
}

/** Draws the tie from head `hi` of `e` to head `nh` of `next`, in two halves if it crosses a system break. */
function drawTie(systems: SysCtx[], e: EvL, hi: number, next: EvL | undefined, nh: number): void {
  const h = e.heads[hi];
  const g = must(geomOf.get(e));
  const above = tieAbove(e, hi);
  const dots = e.te.ev.dur.dots;
  const y = posToY(h.pos) + (above ? -0.38 : 0.38);
  const ledgerExt = D.legerLineExtension as number;
  /**
   * A tie runs in the space next to a ledger line (the first one past the head, whether the head sits
   * on a line or in a space). When there is one, start and stop the tie beyond that line's extension,
   * so that the arc between the ends can bulge freely.
   */
  const ledgerNear = (ev: EvL, hh: { pos: number }, ab = above): boolean => {
    const q = ab ? (hh.pos % 2 === 0 ? hh.pos + 2 : hh.pos + 1) : hh.pos % 2 === 0 ? hh.pos - 2 : hh.pos - 1;
    const own = ev.heads.filter((x) => !x.shared);
    return (q <= -2 && own.some((x) => x.pos <= q)) || (q >= 10 && own.some((x) => x.pos >= q));
  };
  // The tied heads of a chord share their reach and arch height, so that the upper and lower
  // ties are mirror images of each other (`sibs` are all tied heads of this event).
  const sibs = e.heads.map((_x, i) => i).filter((i) => e.heads[i].tie);
  const nextOf = (i: number): number =>
    next
      ? next.heads.findIndex(
          (x) => pitchStep(x.pitch) === pitchStep(e.heads[i].pitch) && x.pitch.alter === e.heads[i].pitch.alter,
        )
      : -1;
  const flagged = e.stem === (above ? 'up' : 'down') && e.te.ev.dur.base >= 8 && !e.beam && !e.tremPair;
  const x0Plain = e.x + h.dx + g.hw + 0.12 + (dots ? 0.4 + DOT_STEP * dots : 0);
  let x0 = x0Plain;
  const ledgerStart = sibs.some((i) => ledgerNear(e, e.heads[i], tieAbove(e, i)));
  if (ledgerStart) x0 = Math.max(x0, e.x + h.dx + g.hw + ledgerExt + 0.1);
  if (flagged) x0 = Math.max(x0, g.stemX + sm.bbox(flagGlyph(beamLevels(e.te.ev.dur.base), above)).x1 + 0.1);
  const si = systems[e.mi >= 0 ? sysOfIndex(systems, e.mi) : 0];
  const thick = D.tieMidpointThickness as number;
  const place = (
    ctx: SysCtx,
    xa: number,
    xb: number,
    y: number,
  ): { hgt: number; draw: (hh: number) => void } | undefined => {
    const len = xb - xa;
    if (len < 0.4) return undefined;
    let hgt = Math.min(1.1, 0.4 + len * 0.045);
    // Bulge further if something (accidentals of other voices ...) stands in the way: probe the arc
    // (a parabola, factor f) at points along it against the skyline.
    const sk = ctx.sky[e.staff];
    for (let t = 0.1; t <= 0.9001; t += 0.05) {
      const x = xa + len * t;
      const f = 4 * t * (1 - t);
      const o = above
        ? sk.top(x - 0.35, x + 0.35, Number.POSITIVE_INFINITY, false, true)
        : sk.bottom(x - 0.35, x + 0.35, Number.NEGATIVE_INFINITY, false, true); // Accidentals are crossed, not avoided.
      if (!Number.isFinite(o)) continue;
      const gap = above ? y - (o - 0.25) : o + 0.25 - y;
      if (gap > 0 && gap < 3) hgt = Math.max(hgt, gap / (f * 0.95));
    }
    hgt = Math.min(hgt, 1.6, Math.max(0.4 + len * 0.045, 0.5 + 0.12 * len)); // A short tie never becomes a hump.
    if (len < 2) hgt = Math.min(hgt, 0.05 + 0.25 * len); // Nor a steep stub.
    return {
      hgt,
      draw: (hh: number) => {
        ctx.prims[e.staff].push({
          t: 'path',
          d: crescent(xa, y, xb, y, hh, thick, above, 0.1, TIE_SHAPE),
          k: 'tie',
          o: oid(h),
          r: e.ev,
          n: hi,
        });
        ctx.sky[e.staff].add(xa, xb, above ? y - hh - 0.1 : y, above ? y : y + hh + 0.1, true);
      },
    };
  };
  type Piece = { hgt: number; draw: (hh: number) => void };
  // A tie stops short of a signature change or a small clef it would run through and goes on after it, so a
  // stretch of tie can come in several pieces, each drawn at its own height.
  // Only a tie inside the staff meets them (it bulges by at most about a space).
  const pieces = (ctx: SysCtx, xa: number, xb: number, yy: number): Piece[] =>
    cutAround(xa, xb, (above ? yy > 0 && yy - 1 < 4 : yy < 4 && yy + 1 > 0) ? tieBlocks(ctx, e.staff) : [])
      .map(([a, b]) => place(ctx, a, b, yy))
      .filter((p): p is Piece => !!p);
  const solo = (ps: Piece[]) => {
    for (const p of ps) p.draw(p.hgt);
  };
  if (!next || nh < 0) {
    solo(pieces(si, x0, Math.min(x0 + 2.6, si.width), y));
    return;
  }
  const sj = systems[sysOfIndex(systems, next.mi)];
  const x1Plain = next.x + next.heads[nh].dx - 0.12;
  let x1 = x1Plain;
  const ledgerEnd = sibs.some((i) => nextOf(i) >= 0 && ledgerNear(next, next.heads[nextOf(i)], tieAbove(e, i)));
  if (ledgerEnd) x1 = Math.min(x1, next.x + next.heads[nh].dx - ledgerExt - 0.1);
  // Clearing the ledger lines must not squeeze a tie into a steep stub: then it keeps its plain ends.
  if ((ledgerStart || ledgerEnd) && x1 - x0 < 1.8 && sj === si) {
    x0 = x0Plain;
    x1 = x1Plain;
  }
  const yN = posToY(next.heads[nh].pos) + (above ? -0.38 : 0.38);
  if (sj === si) solo(pieces(si, x0, x1, y));
  else {
    // A tie broken across systems: the outgoing half runs to the end of the line, the incoming half
    // starts after the next system's prefix (clef, key, time signature).
    const outs = pieces(si, x0, si.width - 0.2, y);
    const ins = pieces(sj, Math.max(0.4, Math.min(Math.max(sj.prefix - 0.6, 0.5), x1 - 2.4)), x1, yN); // A continuation is never a stub.
    const outgoing = outs.pop();
    const incoming = ins.shift();
    solo(outs);
    solo(ins);
    // The halves of a broken tie match in height, except that an obstacle-driven outgoing half does not turn the
    // incoming half into a bowl: that one only follows part of the way.
    const ho = outgoing?.hgt ?? 0;
    const hi = incoming?.hgt ?? 0;
    outgoing?.draw(Math.max(ho, hi));
    incoming?.draw(hi >= ho ? hi : Math.max(hi, Math.min(ho, hi * 1.25 + 0.05)));
  }
}

/** Room a tie keeps from a signature or clef it is interrupted by. */
const TIE_BLOCK_GAP = 0.3;

/**
 * Where a tie on staff `s` must not run in a system, as x ranges: a key or time signature change at the start of a
 * measure (at the start of the system only the time signature, which is drawn in the measure's own room) and a small
 * clef before a barline. Their places are those `signatures.ts` draws them at, worked out from the spacing.
 */
function tieBlocks(ctx: SysCtx, s: number): [number, number][] {
  const out: [number, number][] = [];
  for (let mi = ctx.a; mi <= ctx.b; mi++) {
    const sp = ctx.spacing[mi];
    const x = ctx.mx[mi];
    if (mi > ctx.a && sp.prefix > 0) out.push([x + 0.6, x + sp.prefix - 0.6]);
    else if (mi === ctx.a && sp.timeSig) {
      const digits = Math.max(String(sp.timeSig.beats).length, String(sp.timeSig.beatType).length);
      out.push([x, x + digits * sm.adv('timeSig2')]);
    }
    if (sp.endClef[s]) {
      const end = x + ctx.placed[mi].endX - END_CLEF_GAP;
      out.push([end - sm.adv('gClefChange'), end]);
    }
  }
  return out;
}

/** The parts of [xa, xb] that keep `TIE_BLOCK_GAP` clear of every block. */
function cutAround(xa: number, xb: number, blocks: [number, number][]): [number, number][] {
  const parts: [number, number][] = [];
  let a = xa;
  for (const [l, r] of [...blocks].sort((p, q) => p[0] - q[0])) {
    if (r + TIE_BLOCK_GAP <= a || l - TIE_BLOCK_GAP >= xb) continue;
    if (l - TIE_BLOCK_GAP > a) parts.push([a, l - TIE_BLOCK_GAP]);
    a = Math.max(a, r + TIE_BLOCK_GAP);
  }
  if (a < xb) parts.push([a, xb]);
  return parts;
}

/** Index of the system containing measure `mi`. */
function sysOfIndex(systems: SysCtx[], mi: number): number {
  for (let i = 0; i < systems.length; i++) if (mi >= systems[i].a && mi <= systems[i].b) return i;
  return 0;
}

/** The side of a slur: an explicit side wins; otherwise by voice when there are several (the first above, the others below); otherwise by the stems of the notes under the slur. */
function slurSide(a: EvL, b: EvL, explicit: Side | undefined, voice: EvL[]): Side {
  if (explicit) return explicit;
  if (a.nVoices > 1) return a.voiceRank === 0 ? 'above' : 'below';
  const span = voice.slice(voice.indexOf(a), voice.indexOf(b) + 1).filter((x) => x.ev.kind === 'note');
  const ups = span.filter((x) => x.stem === 'up').length;
  const downs = span.filter((x) => x.stem === 'down').length;
  return ups > 0 && downs === 0 ? 'below' : 'above';
}

/** The side a tie of `e` arches to, if it has one. */
function tieSideOf(e: EvL): Side | null {
  if (!e.heads.some((h) => h.tie)) return null;
  const forced = e.heads.find((h) => h.tie && h.tieSide)?.tieSide;
  if (forced) return forced;
  if (e.nVoices > 1) return e.voiceRank === 0 ? 'above' : 'below';
  return e.stem === 'down' ? 'above' : 'below';
}

/** The skyline a slur on `staff` must clear. A slur between staves must clear the content of both: they are merged, with the other staff's boxes shifted into the voice's coordinates. */
function slurSkyline(ctx: SysCtx, staff: number, a: EvL, b: EvL): Skyline {
  const others = [...new Set([a.staff, b.staff])].filter((q) => q !== staff);
  if (!others.length) return ctx.sky[staff];
  const sky = new Skyline();
  sky.boxes = [...ctx.sky[staff].boxes];
  for (const q of others) {
    const d = staffOffset(ctx, staff, q);
    for (const bx of ctx.sky[q].boxes) sky.boxes.push({ ...bx, y0: bx.y0 + d, y1: bx.y1 + d });
  }
  return sky;
}

/** How a slur piece is laid out: which side, its skyline and the ends that are open (at a system break). */
interface SlurFrame {
  above: boolean;
  sky: Skyline;
  openL: boolean;
  openR: boolean;
}

/**
 * The skyline edge over a window of the span: the nearest obstacle on the slur's side. Accidentals count, so the arc
 * clears them; `skipAcc` ignores them.
 */
const slurReach = (f: SlurFrame, a: number, b: number, skipAcc = false) =>
  f.above ? f.sky.top(a, b, 99, false, skipAcc) : f.sky.bottom(a, b, -99, false, skipAcc);

/**
 * Where the two ends start. An attached end stays exactly where `headPoint` put it, so that every slur begins and ends
 * at the same clearance from its note. An open (system-break) end has no note to attach to: it starts clear of whatever
 * stands within `edge` spaces of the system edge (accidentals included, since the arc leaves the end at its y and would
 * cross one), but at most 8 spaces off the original y.
 */
function slurEndHeights(f: SlurFrame, x0: number, y0: number, x1: number, y1: number): [number, number] {
  const { above, openL, openR } = f;
  const edge = 12;
  const openY = (y: number, o: number): number =>
    above ? Math.max(y - 8, Math.min(y, o - 0.9)) : Math.min(y + 8, Math.max(y, o + 0.9));
  if (openL) {
    const o = slurReach(f, x0, x0 + edge, false);
    if (Math.abs(o) < 90) y0 = openY(y0, o);
  }
  if (openR) {
    const o = slurReach(f, x1 - edge, x1, false);
    if (Math.abs(o) < 90) y1 = openY(y1, o);
  }
  return [y0, y1];
}

/**
 * The obstacle profile under the arc, sampled once: `o` is the skyline edge at each sampled `t` (0..1
 * along the span). Sampling once keeps the search for the end points cheap.
 */
function sampleObstacles(f: SlurFrame, x0: number, x1: number): { t: number; o: number }[] {
  const L = x1 - x0;
  const window = 0.7;
  const samples: { t: number; o: number }[] = [];
  for (let x = x0 + 0.3; x <= x1 - 0.3; x += 0.25) {
    if ((!f.openL && x < x0 + ATTACHED_BLIND) || (!f.openR && x > x1 - ATTACHED_BLIND)) continue; // Attached ends are skipped because the note itself is there.
    if ((f.openL && x < x0 + OPEN_BLIND) || (f.openR && x > x1 - OPEN_BLIND)) continue; // An open end has not left its y yet, so no height could clear what stands there.
    const o = slurReach(f, x - window / 2, x + window / 2);
    if (Math.abs(o) < 90) samples.push({ t: (x - x0) / L, o });
  }
  return samples;
}

// The candidate shapes of a slur: the lateral reach of the control points and a skew of their lifts. The grid is small
// because every shape is tried for every slur.
const SLUR_SHAPES: SlurShape[] = (() => {
  const out: SlurShape[] = [];
  for (const a0 of [0.12, 0.2, 0.3])
    for (const a1 of [0.12, 0.2, 0.3])
      for (const skew of [-0.6, -0.3, 0, 0.3, 0.6]) out.push({ a0, a1, m0: 1 + skew, m1: 1 - skew });
  return out;
})();

// The mirror-symmetric candidates, which a slur uses unless it may be skewed: the same lift at both ends, and control points
// equally far in from both. Only their reach varies, so that one with higher ends can clear what a flatter one cannot.
const SYMMETRIC_SHAPES: SlurShape[] = SLUR_SHAPES.filter((sh) => sh.m0 === sh.m1 && sh.a0 === sh.a1);

/** What a shape costs beyond its height: the further from the symmetric shape, the more. */
const shapePenalty = (sh: SlurShape): number =>
  0.5 * (Math.abs(sh.a0 - SYMMETRIC.a0) + Math.abs(sh.a1 - SYMMETRIC.a1)) + 0.15 * Math.abs(sh.m0 - sh.m1);

/**
 * The least height at which a slur of shape `sh` clears every sampled obstacle (the slur's own thickness included), or
 * undefined when none does. The curve's y is linear in the height, so each obstacle gives its own bound directly.
 */
function leastHeight(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  st: SlurStyle,
  samples: { t: number; o: number }[],
  sh: SlurShape,
): number | undefined {
  const { x, y, g } = curveTable(x0, y0, x1, y1, st.above, sh);
  let hMin = 0.3;
  let i = 0;
  for (const { t, o } of samples) {
    const xs = x0 + t * (x1 - x0);
    while (i < TABLE_N - 1 && x[i + 1] < xs) i++;
    const f = (xs - x[i]) / (x[i + 1] - x[i] || 1);
    const yb = y[i] + (y[i + 1] - y[i]) * f;
    const gain = (st.above ? -1 : 1) * (g[i] + (g[i + 1] - g[i]) * f);
    // The outer edge plus the slur's own thickness must clear the obstacle.
    const need = st.above ? yb + st.thick - (o - SLUR_CLEAR) : o + SLUR_CLEAR + st.thick - yb;
    if (need <= 0) continue;
    if (gain < 1e-3) return undefined;
    hMin = Math.max(hMin, need / gain);
  }
  return hMin < 8 ? hMin : undefined;
}

/** How far the outer edge of a slur of shape `sh` and height `h` rises beyond its higher end (beyond its lower one when below). */
function peakExtent(x0: number, y0: number, x1: number, y1: number, above: boolean, sh: SlurShape, h: number): number {
  const { y, g } = curveTable(x0, y0, x1, y1, above, sh);
  const ys = y.map((v, i) => v + h * g[i]);
  return above ? Math.min(y0, y1) - Math.min(...ys) : Math.max(...ys) - Math.max(y0, y1);
}

/** A slur piece laid out but not yet drawn: its natural height, and a function drawing it at a (possibly shared) height. */
interface SlurPiece {
  h: number;
  /** The least height at which the arc still clears what is under it. */
  hMin: number;
  L: number;
  draw: (h: number) => void;
}

/**
 * The owner tag shared by the pieces of one slur. It is looked up by the slur's first event, not made up on
 * the spot, so that drawing the same slur again gives its primitives the same tag (see `FinalSnapshot`).
 */
const slurOwners = new WeakMap<EvL, Map<number, number>>();

/** The owner tag of slur `id` that starts at event `a`; the same tag every time it is asked for. */
function slurOwner(a: EvL, id: number): number {
  let m = slurOwners.get(a);
  if (!m) {
    m = new Map();
    slurOwners.set(a, m);
  }
  let o = m.get(id);
  if (o === undefined) {
    o = oid({});
    m.set(id, o);
  }
  return o;
}

/** What a slur piece needs to draw itself. */
interface SlurStyle {
  above: boolean;
  thick: number;
  id: number;
  skewed: boolean; // Skewed shapes are considered from the start, not only when no symmetric one clears.
  slurId: number;
  from: EvL;
}

/**
 * Plans the piece of a slur between (x0, y0) and (x1, y1) on `staff`: lifts the arc over the notes under it and
 * returns its height range and a function that draws it at a chosen height. `openL`/`openR` mark ends that
 * continue in another system.
 */
function planSlurPiece(
  ctx: SysCtx,
  st: SlurStyle,
  b: EvL,
  [x0, y0In, x1, y1In]: [number, number, number, number],
  staff: number,
  openL: boolean,
  openR: boolean,
): SlurPiece | undefined {
  const L = x1 - x0;
  if (L < 0.5) return undefined;
  const frame: SlurFrame = { above: st.above, sky: slurSkyline(ctx, staff, st.from, b), openL, openR };
  const [y0, y1] = slurEndHeights(frame, x0, y0In, x1, y1In);
  const samples = sampleObstacles(frame, x0, x1);
  // The end points stay at their notes, so the arc alone clears what is under it. Among the candidate shapes, the one
  // whose peak ends up lowest wins; a lopsided shape pays a small penalty, so the symmetric one stays unless an obstacle
  // makes a skewed one clearly flatter.
  const hPref = Math.max(0.7, Math.min(3.0, 0.09 * L + 0.6));
  type Pick = { sh: SlurShape; hMin: number; h: number; cost: number };
  const choose = (shapes: SlurShape[]): Pick | undefined => {
    let best: Pick | undefined;
    for (const sh of shapes) {
      const hMin = leastHeight(x0, y0, x1, y1, st, samples, sh);
      if (hMin === undefined) continue;
      const h = Math.max(hPref, hMin);
      const cost = peakExtent(x0, y0, x1, y1, st.above, sh, h) + shapePenalty(sh);
      if (!best || cost < best.cost - 1e-9) best = { sh, hMin, h, cost };
    }
    return best;
  };
  // A slur keeps to the mirror-symmetric shapes unless it is marked skewed; only when none of them can clear what
  // stands under it does it give way to a skewed one, since a collision is worse.
  const best = (!st.skewed ? choose(SYMMETRIC_SHAPES) : undefined) ?? choose(SLUR_SHAPES);
  const { sh, hMin, h: h0 } = best ?? { sh: SYMMETRIC, hMin: hPref, h: hPref };
  return {
    h: h0,
    hMin,
    L,
    draw: (h) => {
      ctx.prims[staff].push({
        t: 'path',
        d: crescent(x0, y0, x1, y1, h, st.thick, st.above, 0.1, sh),
        k: 'slur',
        o: st.slurId,
        r: st.from.ev,
        n: st.id,
      });
      const ym = Math.min(y0, y1);
      const yM = Math.max(y0, y1);
      // A slur between staves reaches into the other staff: it is not recorded there, or it would
      // push the staves apart for good.
      // The skyline follows the curve in slices, so that what is placed above a low side of a lopsided slur may sit lower.
      const { x, y, g } = curveTable(x0, y0, x1, y1, st.above, sh);
      const n = Math.max(2, Math.min(TABLE_N, Math.ceil(L / 0.8)));
      for (let j = 0; j < n; j++) {
        const lo = Math.floor((j * TABLE_N) / n);
        const hi = Math.ceil(((j + 1) * TABLE_N) / n);
        let edge = st.above ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
        for (let i = lo; i <= hi; i++) edge = (st.above ? Math.min : Math.max)(edge, y[i] + h * g[i]);
        frame.sky.add(x[lo], x[hi], st.above ? edge : ym, st.above ? yM : edge, true);
      }
    },
  };
}

/**
 * Draws the slur from note `a` to note `b` (in the same voice, `voice` being all its events). The side comes
 * from `explicit`, else the voice, else the stems of the notes spanned. Each end attaches to its note; the arc
 * is raised to clear the skyline underneath, with the ends allowed to move off the notes when that flattens it.
 */
function drawSlur(
  systems: SysCtx[],
  sysOf: number[],
  a: EvL,
  b: EvL,
  explicit: Side | undefined,
  voice: EvL[],
  id: number,
  skewed: boolean,
): void {
  if (a.ev.kind !== 'note' || b.ev.kind !== 'note') return;
  const side = slurSide(a, b, explicit, voice);
  const above = side === 'above';
  const pa = headPoint(a, side);
  const pb = headPoint(b, side);
  // A tie starting on the same side as the slur: start the slur beyond the tie, so the slur
  // does not begin inside the tie's arc.
  if (tieSideOf(a) === side && !pa.stemSide) pa.y += above ? -0.7 : 0.7;
  const sa = systems[sysOf[a.mi]];
  const sb = systems[sysOf[b.mi]];
  // A slur belongs to the voice's staff; an end on another staff is converted to the voice's coordinates
  // (a stem end that is already in those coordinates is not).
  if (a.staff !== a.home && !(pa.stemSide && pa.homed)) pa.y += staffOffset(sa, a.home, a.staff);
  if (b.staff !== a.home && !(pb.stemSide && pb.homed)) pb.y += staffOffset(sb, a.home, b.staff);
  const style: SlurStyle = {
    above,
    thick: D.slurMidpointThickness as number,
    id,
    skewed,
    slurId: slurOwner(a, id),
    from: a,
  };
  if (sa === sb) {
    const p = planSlurPiece(sa, style, b, [pa.x, pa.y, pb.x, pb.y], a.home, false, false);
    p?.draw(p.h);
    return;
  }
  // The two halves of a slur broken across systems get the same arch height so that they
  // read as one slur: the higher of the two is used for both...
  const p1 = planSlurPiece(sa, style, b, [pa.x, pa.y, sa.width - 0.2, pa.y], a.home, false, true);
  const p2 = planSlurPiece(sb, style, b, [Math.max(sb.prefix - 0.3, 0.5), pb.y, pb.x, pb.y], a.home, true, false);
  const hh = Math.max(p1?.h ?? 0, p2?.h ?? 0);
  // ... but a short half must not become a bowl just because the other one is long. `cap`
  // limits a half's height to a multiple of its own length (or its own natural height).
  const cap = (p: SlurPiece | undefined) =>
    p ? Math.min(hh, Math.max(0.12 * p.L + 0.35, Math.min(p.h, 0.7), p.hMin)) : hh;
  p1?.draw(cap(p1));
  p2?.draw(cap(p2));
}
