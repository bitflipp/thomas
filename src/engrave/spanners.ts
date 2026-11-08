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
import { DOT_STEP, flagGlyph, STEM_T } from './spacing.ts';
import { drawVoltas } from './volta.ts';

const sm = loadSmufl();

type Side = 'above' | 'below';

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
  a = 0.3,
): string {
  const s = above ? -1 : 1;
  const L = x1 - x0;
  const k = h / 0.75;
  const k2 = Math.max(0, k - thick / 0.75);
  /**
   * The control points sit at fraction `a` of the span in x but follow the chord in y (the 0.3/0.7
   * factors), so a small `a` gives steep ends and a flat top.
   */
  const cx = (f: number, kk: number) =>
    `${(x0 + L * f).toFixed(3)} ${(y0 + (y1 - y0) * (f < 0.5 ? 0.3 : 0.7) + s * kk).toFixed(3)}`;
  // The inner edge ends slightly towards the chord (`tip`) so that the tips of the crescent
  // keep a visible thickness instead of tapering to a hairline.
  const iy0 = y0 - s * tip;
  const iy1 = y1 - s * tip;
  return `M${x0.toFixed(3)} ${y0.toFixed(3)}C${cx(a, k)} ${cx(1 - a, k)} ${x1.toFixed(3)} ${y1.toFixed(3)}L${x1.toFixed(3)} ${iy1.toFixed(3)}C${cx(1 - a, k2)} ${cx(a, k2)} ${x0.toFixed(3)} ${iy0.toFixed(3)}Z`;
}

/** The y of the outer edge of `crescent(x0, y0, x1, y1, h, ..., a)` at `x` (the curve is a cubic whose control points follow the chord, so it differs from a parabola over a sloped chord). */
function crescentY(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  h: number,
  above: boolean,
  x: number,
  a = 0.2,
): number {
  const s = above ? -1 : 1;
  const L = x1 - x0;
  const k = h / 0.75;
  const ys = [y0, y0 + (y1 - y0) * 0.3 + s * k, y0 + (y1 - y0) * 0.7 + s * k, y1];
  const xs = [x0, x0 + L * a, x0 + L * (1 - a), x1];
  const at = (t: number, v: number[]) =>
    (1 - t) ** 3 * v[0] + 3 * (1 - t) ** 2 * t * v[1] + 3 * (1 - t) * t * t * v[2] + t ** 3 * v[3];
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid, xs) < x) lo = mid;
    else hi = mid;
  }
  return at((lo + hi) / 2, ys);
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
        key: `t${e.id}.${hi}>${next ? next.id : -1}.${nh}`,
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
  const open = new Map<string, { ev: EvL; side?: Side; id: number }>();
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
        key: `s${start.ev.id}>${e.id}.${start.id}.${side}`,
        draw: () => drawSlur(systems, sysOf, start.ev, e, start.side, voice, start.id),
        cross: start.ev.staff !== start.ev.home || e.staff !== start.ev.home,
      });
      open.delete(key);
    }
    for (const ss of e.ev.slurStart ?? []) open.set(`${e.voice}|${ss.id}`, { ev: e, side: ss.side, id: ss.id });
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
          for (const id of e.ev.lineStop ?? []) ends.push({ ...at, role: 'stop', id });
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
      draw: () => drawLink(systems[sysOf[a.mi]], a, b, start.id, dashed),
    });
  }
  return out;
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

/**
 * A straight line from a head of note `a` to a head of note `b`, in the coordinates of `a`'s staff. Of a chord the head
 * nearest to the other end is used; the line stops a little short of each head. Nothing is recorded in the skyline.
 */
function drawLink(ctx: SysCtx, a: EvL, b: EvL, id: number, dashed: boolean): void {
  if (a.ev.kind !== 'note' || b.ev.kind !== 'note') return;
  const ga = must(geomOf.get(a));
  const gb = must(geomOf.get(b));
  const yOf = (e: EvL, pos: number) => posToY(pos) + staffOffset(ctx, a.staff, e.staff);
  const mean = (e: EvL) => e.heads.reduce((t, h) => t + yOf(e, h.pos), 0) / e.heads.length;
  const nearest = (e: EvL, y: number) =>
    e.heads.reduce((best, h) => (Math.abs(yOf(e, h.pos) - y) < Math.abs(yOf(e, best.pos) - y) ? h : best));
  const ha = nearest(a, mean(b));
  const hb = nearest(b, mean(a));
  const x0 = a.x + ha.dx + ga.hw / 2;
  const y0 = yOf(a, ha.pos);
  const x1 = b.x + hb.dx + gb.hw / 2;
  const y1 = yOf(b, hb.pos);
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len < 1e-6) return;
  const ux = (x1 - x0) / len;
  const uy = (y1 - y0) / len;
  /** Distance from a head's centre to its outline along the line (an ellipse), plus clearance. */
  const reach = (hw: number) => 1 / Math.hypot(ux / (hw / 2), uy / 0.5) + 0.6;
  // The end keeps the same clearance from the note's own stem as from the head: it is pushed along the line until it is
  // out of the stem's neighbourhood (which may mean past the stem).
  const CLEAR = 0.6;
  const pastStem = (e: EvL, g: typeof ga, cx: number, cy: number, dir: number, r: number): number => {
    if (!e.stem) return r;
    const [lo, hi] = [Math.min(g.stemTip, g.stemBase), Math.max(g.stemTip, g.stemBase)];
    const off = staffOffset(ctx, a.staff, e.staff);
    const near = (q: number) => {
      const px = cx + ux * dir * q;
      const py = cy + uy * dir * q;
      return Math.abs(px - g.stemX) < CLEAR + STEM_T / 2 && py > lo + off - CLEAR && py < hi + off + CLEAR;
    };
    let q = r;
    while (near(q) && q < len) q += 0.05;
    return q < len ? q : r;
  };
  const ra = pastStem(a, ga, x0, y0, 1, reach(ga.hw));
  const rb = pastStem(b, gb, x1, y1, -1, reach(gb.hw));
  if (len - ra - rb < 0.5) return;
  ctx.prims[a.staff].push({
    t: 'line',
    x1: x0 + ux * ra,
    y1: y0 + uy * ra,
    x2: x1 - ux * rb,
    y2: y1 - uy * rb,
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
  const headGap = HEAD_HALF + SLUR_CLEAR; // This is measured from the centre of the outermost head.
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

/** Does the tie of head `hi` arch above it? By voice with several voices, by position within a chord, else opposite to the stem. */
function tieAbove(e: EvL, hi: number): boolean {
  const h = e.heads[hi];
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
          d: crescent(xa, y, xb, y, hh, thick, above),
          k: 'tie',
          o: oid(h),
          r: e.ev,
          n: hi,
        });
        ctx.sky[e.staff].add(xa, xb, above ? y - hh - 0.1 : y, above ? y : y + hh + 0.1, true);
      },
    };
  };
  const solo = (p: { hgt: number; draw: (hh: number) => void } | undefined) => p?.draw(p.hgt);
  if (!next || nh < 0) {
    solo(place(si, x0, Math.min(x0 + 2.6, si.width), y));
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
  if (sj === si) solo(place(si, x0, x1, y));
  else {
    // A tie broken across systems: the outgoing half runs to the end of the line, the incoming half
    // starts after the next system's prefix (clef, key, time signature).
    const outgoing = place(si, x0, si.width - 0.2, y);
    const incoming = place(sj, Math.max(0.4, Math.min(Math.max(sj.prefix - 0.6, 0.5), x1 - 2.4)), x1, yN); // A continuation is never a stub.
    // The halves of a broken tie match in height, except that an obstacle-driven outgoing half does not turn the
    // incoming half into a bowl: that one only follows part of the way.
    const ho = outgoing?.hgt ?? 0;
    const hi = incoming?.hgt ?? 0;
    outgoing?.draw(Math.max(ho, hi));
    incoming?.draw(hi >= ho ? hi : Math.max(hi, Math.min(ho, hi * 1.25 + 0.05)));
  }
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
 * The skyline edge over a window of the span: the nearest obstacle on the slur's side. Accidentals do not count: a
 * slur may cross them, which keeps its arc from rising steeply over a sharp or flat next to its notes.
 */
const slurReach = (f: SlurFrame, a: number, b: number) =>
  f.above ? f.sky.top(a, b, 99, false, true) : f.sky.bottom(a, b, -99, false, true);

/**
 * Where the two ends start. An attached end stays exactly where `headPoint` put it, so that every slur begins and ends
 * at the same clearance from its note. An open (system-break) end has no note to attach to: it starts clear of whatever
 * stands within `edge` spaces of the system edge, but at most 3 spaces off the original y.
 */
function slurEndHeights(f: SlurFrame, x0: number, y0: number, x1: number, y1: number): [number, number] {
  const { above, openL, openR } = f;
  const edge = 12;
  const openY = (y: number, o: number): number =>
    above ? Math.max(y - 3, Math.min(y, o - 0.9)) : Math.min(y + 3, Math.max(y, o + 0.9));
  if (openL) {
    const o = slurReach(f, x0, x0 + edge);
    if (Math.abs(o) < 90) y0 = openY(y0, o);
  }
  if (openR) {
    const o = slurReach(f, x1 - edge, x1);
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
    if ((!f.openL && x < x0 + 0.45) || (!f.openR && x > x1 - 0.45)) continue; // Attached ends are skipped because the note itself is there.
    const o = slurReach(f, x - window / 2, x + window / 2);
    if (Math.abs(o) < 90) samples.push({ t: (x - x0) / L, o });
  }
  return samples;
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
  // The end points stay at their notes, so the arc alone clears what is under it: it starts from a preferred height
  // and grows until the drawn curve (not an approximation) clears every obstacle, the slur's own thickness included.
  const hPref = Math.max(0.7, Math.min(3.0, 0.09 * L + 0.6));
  const clears = (h: number) =>
    samples.every(({ t, o }) => {
      const y = crescentY(x0, y0, x1, y1, h, st.above, x0 + t * L, 0.2);
      // The outer edge plus the slur's own thickness must clear the obstacle.
      return st.above ? y + st.thick <= o - SLUR_CLEAR : y - st.thick >= o + SLUR_CLEAR;
    });
  let hMin = 0.3;
  while (hMin < 8 && !clears(hMin)) hMin += 0.1;
  const h0 = Math.max(Math.min(hPref, Math.max(7, 0.12 * L)), hMin);
  return {
    h: h0,
    hMin,
    L,
    draw: (h) => {
      ctx.prims[staff].push({
        t: 'path',
        d: crescent(x0, y0, x1, y1, h, st.thick, st.above, 0.1, 0.2),
        k: 'slur',
        o: st.slurId,
        r: st.from.ev,
        n: st.id,
      });
      const ym = Math.min(y0, y1);
      const yM = Math.max(y0, y1);
      // A slur between staves reaches into the other staff: it is not recorded there, or it would
      // push the staves apart for good.
      frame.sky.add(x0, x1, st.above ? ym - h : ym, st.above ? yM : yM + h, true);
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
