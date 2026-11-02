// Ties, slurs and marks (dynamics, hairpins, pedal, octave shifts, tempo, text).
//
// Runs after every system's notes are drawn, because all of these can cross system breaks and need
// to know what stands near them. Obstacles come from each staff's `Skyline` (boxes pushed by the note
// drawing); placed spanners add their own boxes, so later ones route around earlier ones. Order matters:
// ties first, then slurs between staves, then ordinary slurs, then marks.
import type { Mark } from '../model.ts';
import { pitchStep } from '../model.ts';
import { loadSmufl } from '../smufl.ts';
import { must } from '../util.ts';
import type { SysCtx } from './draw.ts';
import { articExtent, D, geomOf, staffOffset, xAtTick } from './draw.ts';
import type { EvL } from './prep.ts';
import { posToY } from './prep.ts';
import type { Kind, Prim } from './scene.ts';
import { oid, Skyline } from './scene.ts';
import { DOT_STEP } from './spacing.ts';

const sm = loadSmufl();

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
  // The control points sit at fraction `a` of the span in x but follow the chord in y (the 0.3/0.7
  // factors), so a small `a` gives steep ends and a flat top.
  const cx = (f: number, kk: number) =>
    `${(x0 + L * f).toFixed(3)} ${(y0 + (y1 - y0) * (f < 0.5 ? 0.3 : 0.7) + s * kk).toFixed(3)}`;
  // The inner edge ends slightly towards the chord (`tip`) so that the tips of the crescent
  // keep a visible thickness instead of tapering to a hairline.
  const iy0 = y0 - s * tip;
  const iy1 = y1 - s * tip;
  return `M${x0.toFixed(3)} ${y0.toFixed(3)}C${cx(a, k)} ${cx(1 - a, k)} ${x1.toFixed(3)} ${y1.toFixed(3)}L${x1.toFixed(3)} ${iy1.toFixed(3)}C${cx(1 - a, k2)} ${cx(a, k2)} ${x0.toFixed(3)} ${iy0.toFixed(3)}Z`;
}

export function drawSpanners(systems: SysCtx[]): void {
  if (!systems.length) return;
  const prep = systems[0].prep;
  const nS = prep.score.staves.length;
  const sysOf: number[] = [];
  systems.forEach((s, i) => {
    for (let m = s.a; m <= s.b; m++) sysOf[m] = i;
  });

  const slurs: (() => void)[] = [];
  const crossSlurs: (() => void)[] = [];
  // ---- Per staff: gather each voice's events over the whole piece (ties and slurs run across
  // measures and systems), then draw this staff's ties and queue its slurs.
  for (let s = 0; s < nS; s++) {
    const voiceEvs = new Map<number, EvL[]>();
    const timeOrder: EvL[] = [];
    for (const measure of prep.measures) {
      for (const v of measure[s].voices) {
        if (!voiceEvs.has(v.id)) voiceEvs.set(v.id, []);
        must(voiceEvs.get(v.id)).push(...v.evs);
      }
      // Slurs belong to the voice, wherever its (cross-staff) notes are drawn; `timeOrder` is the staff's
      // events by time so that stops can be matched to starts.
      timeOrder.push(...measure[s].voices.flatMap((v) => v.evs).sort((p, q) => p.start - q.start || p.voice - q.voice));
    }
    // ---- Ties: each tied head connects to the same pitch in the next event of the voice. The
    // tie of a note whose successor is in another system is drawn in two halves.
    for (const [, evs] of voiceEvs) {
      evs.forEach((e, i) => {
        if (e.ev.kind !== 'note') return;
        // Nested ties of a chord are drawn from the inside out: the arc nearest the chord first,
        // the outer ones around it, so each can clear the previous one through the skyline.
        const order = e.heads
          .map((_, hi) => hi)
          .sort((p, q) => {
            const pa = tieAbove(e, p);
            const qa = tieAbove(e, q);
            if (pa !== qa) return pa ? -1 : 1;
            return pa ? e.heads[p].pos - e.heads[q].pos : e.heads[q].pos - e.heads[p].pos;
          });
        order.forEach((hi) => {
          const h = e.heads[hi];
          if (!h.tie) return;
          let next: EvL | undefined;
          let nh = -1;
          for (let k = i + 1; k < evs.length && k <= i + 2; k++) {
            if (evs[k].ev.kind !== 'note') {
              if (evs[k].ev.kind === 'rest' && (evs[k].ev as { style?: string }).style !== 'hidden') break;
              continue;
            }
            nh = evs[k].heads.findIndex(
              (x) => pitchStep(x.pitch) === pitchStep(h.pitch) && x.pitch.alter === h.pitch.alter,
            );
            if (nh >= 0) {
              next = evs[k];
            }
            break;
          }
          drawTie(systems, e, hi, next, nh);
        });
      });
    }
    // ---- Slurs, matched start to stop by voice and id. They are collected rather than drawn at once:
    // those between staves go first so that the others nest around them.
    const open = new Map<string, { ev: EvL; side?: 'above' | 'below'; id: number }>();
    for (const e of timeOrder) {
      for (const id of e.ev.slurStop ?? []) {
        const k = `${e.voice}|${id}`;
        const st = open.get(k);
        if (st) {
          const ve = must(voiceEvs.get(e.voice));
          const a0 = st.ev;
          const sd = st.side;
          const sid = st.id;
          (a0.staff !== a0.home || e.staff !== a0.home ? crossSlurs : slurs).push(() =>
            drawSlur(systems, sysOf, a0, e, sd, ve, sid),
          );
          open.delete(k);
        }
      }
      for (const ss of e.ev.slurStart ?? []) open.set(`${e.voice}|${ss.id}`, { ev: e, side: ss.side, id: ss.id });
    }
  }
  for (const f of [...crossSlurs, ...slurs]) f();
  // ---- Marks: dynamics, hairpins, pedal, ottava, tempo and text. They come last so that they
  // see the skylines of the slurs and ties and are stacked outside them.
  for (let s = 0; s < nS; s++) drawMarks(systems, sysOf, s);
}

/** The point where a slur on `side` attaches to `e`: at the stem tip when the stem is on that side, else beyond the outermost head; beyond any articulations on that side. */
function headPoint(
  e: EvL,
  side: 'above' | 'below',
  margin: number,
): { x: number; y: number; stemSide: boolean; homed: boolean } {
  const g = must(geomOf.get(e));
  const above = side === 'above';
  const stemSide = e.stem === (above ? 'up' : 'down');
  // Articulations on the same side as the slur: start just beyond them, since a slur that
  // began at the head would run through the articulation.
  const ax = articExtent.get(e);
  const artEdge = ax && ax.above === above ? ax.edge + (above ? -0.5 : 0.5) : undefined;
  if (stemSide)
    return {
      x: g.stemX,
      y: artEdge ?? (above ? g.stemTip - margin * 0.8 : g.stemTip + margin * 0.8),
      stemSide,
      homed: !!g.homed,
    };
  const ref = above
    ? e.heads.reduce((a, h) => (h.pos > a.pos ? h : a))
    : e.heads.reduce((a, h) => (h.pos < a.pos ? h : a));
  return {
    x: e.x + ref.dx + g.hw / 2,
    y: artEdge ?? posToY(ref.pos) + (above ? -margin : margin),
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
  // A tie runs in the space next to a ledger line (the first one past the head, whether the head sits
  // on a line or in a space). When there is one, start and stop the tie beyond that line's extension,
  // so that the arc between the ends can bulge freely.
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
  let x0 = e.x + h.dx + g.hw + 0.12 + (dots ? 0.4 + DOT_STEP * dots : 0);
  if (sibs.some((i) => ledgerNear(e, e.heads[i], tieAbove(e, i))))
    x0 = Math.max(x0, e.x + h.dx + g.hw + ledgerExt + 0.1);
  if (flagged)
    x0 = Math.max(
      x0,
      g.stemX +
        sm.bbox(
          `flag${e.te.ev.dur.base >= 32 ? '32nd' : e.te.ev.dur.base >= 16 ? '16th' : '8th'}${above ? 'Up' : 'Down'}`,
        ).x1 +
        0.1,
    );
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
        : sk.bottom(x - 0.35, x + 0.35, Number.NEGATIVE_INFINITY, false, true); // accidentals are crossed, not avoided
      if (!Number.isFinite(o)) continue;
      const gap = above ? y - (o - 0.25) : o + 0.25 - y;
      if (gap > 0 && gap < 3) hgt = Math.max(hgt, gap / (f * 0.95));
    }
    hgt = Math.min(hgt, 1.6, Math.max(0.4 + len * 0.045, 0.5 + 0.12 * len)); // a short tie never becomes a hump
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
  let x1 = next.x + next.heads[nh].dx - 0.12;
  if (sibs.some((i) => nextOf(i) >= 0 && ledgerNear(next, next.heads[nextOf(i)], tieAbove(e, i))))
    x1 = Math.min(x1, next.x + next.heads[nh].dx - ledgerExt - 0.1);
  const yN = posToY(next.heads[nh].pos) + (above ? -0.38 : 0.38);
  if (sj === si) solo(place(si, x0, x1, y));
  else {
    // A tie broken across systems: the outgoing half runs to the end of the line, the incoming half
    // starts after the next system's prefix (clef, key, time signature).
    const outgoing = place(si, x0, si.width - 0.2, y);
    const incoming = place(sj, Math.max(0.4, Math.min(Math.max(sj.prefix - 0.6, 0.5), x1 - 2.4)), x1, yN); // a continuation is never a stub
    // the halves of a broken tie match in height, except that an obstacle-driven outgoing half does not turn the
    // incoming half into a bowl: that one only follows part of the way
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
  explicit: 'above' | 'below' | undefined,
  voice: EvL[],
  id: number,
): void {
  if (a.ev.kind !== 'note' || b.ev.kind !== 'note') return;
  // Side: an explicit side wins; otherwise by voice when there are several (the first above,
  // the others below); otherwise by the stems of the notes under the slur (see below).
  let side: 'above' | 'below';
  if (explicit) side = explicit;
  else if (a.nVoices > 1) side = a.voiceRank === 0 ? 'above' : 'below';
  else {
    const ia = voice.indexOf(a);
    const ib = voice.indexOf(b);
    const span = voice.slice(ia, ib + 1).filter((x) => x.ev.kind === 'note');
    const ups = span.filter((x) => x.stem === 'up').length;
    const downs = span.filter((x) => x.stem === 'down').length;
    side = ups > 0 && downs === 0 ? 'below' : 'above';
  }
  const above = side === 'above';
  const pa = headPoint(a, side, 0.65);
  const pb = headPoint(b, side, 0.65);
  // A tie starting on the same side as the slur: start the slur beyond the tie, so the slur
  // does not begin inside the tie's arc.
  const tieSide = (e: EvL): 'above' | 'below' | null =>
    e.heads.some((h) => h.tie)
      ? e.nVoices > 1
        ? e.voiceRank === 0
          ? 'above'
          : 'below'
        : e.stem === 'down'
          ? 'above'
          : 'below'
      : null;
  if (tieSide(a) === side && !pa.stemSide) pa.y += above ? -0.7 : 0.7;
  const slurId = oid({});
  const sa = systems[sysOf[a.mi]];
  const sb = systems[sysOf[b.mi]];
  // A slur belongs to the voice's staff; an end on another staff is converted to the voice's coordinates
  // (a stem end that is already in those coordinates is not).
  if (a.staff !== a.home && !(pa.stemSide && pa.homed)) pa.y += staffOffset(sa, a.home, a.staff);
  if (b.staff !== a.home && !(pb.stemSide && pb.homed)) pb.y += staffOffset(sb, a.home, b.staff);
  const thick = D.slurMidpointThickness as number;
  const piece = (
    ctx: SysCtx,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    staff: number,
    openL = false,
    openR = false,
  ): { h: number; L: number; draw: (h: number) => void } | undefined => {
    const L = x1 - x0;
    if (L < 0.5) return undefined;
    // A slur between staves must clear the content of both. Merge their skylines into one, with
    // the other staff's boxes shifted into the voice's coordinates.
    const others = [...new Set([a.staff, b.staff])].filter((q) => q !== staff);
    let sky = ctx.sky[staff];
    if (others.length) {
      sky = new Skyline();
      sky.boxes = [...ctx.sky[staff].boxes];
      for (const q of others) {
        const d = staffOffset(ctx, staff, q);
        for (const bx of ctx.sky[q].boxes) sky.boxes.push({ ...bx, y0: bx.y0 + d, y1: bx.y1 + d });
      }
    }
    const dir = above ? -1 : 1; // direction away from the notes
    const win = 0.7;
    const reach = (a: number, b: number) => (above ? sky.top(a, b, 99) : sky.bottom(a, b, -99));
    // An open (system-break) end has no note to attach to: start it clear of whatever stands within
    // `edge` spaces of the system edge, but at most 3 spaces off the original y.
    const edge = 7;
    const openY = (y: number, o: number): number =>
      above ? Math.max(y - 3, Math.min(y, o - 0.9)) : Math.min(y + 3, Math.max(y, o + 0.9));
    if (openL) {
      const o = reach(x0, x0 + edge);
      if (Math.abs(o) < 90) y0 = openY(y0, o);
    }
    if (openR) {
      const o = reach(x1 - edge, x1);
      if (Math.abs(o) < 90) y1 = openY(y1, o);
    }
    // An attached end sits just beyond whatever stands next to its note (neighbouring notes, beams,
    // dots, articulations - not other slurs), never more than a couple of spaces off the note itself.
    const near = 3.5;
    const maxUp = 2.0;
    const attach = (y: number, xa: number, xb: number): number => {
      const o = above ? sky.top(xa, xb, 99, true) : sky.bottom(xa, xb, -99, true);
      if (Math.abs(o) > 90) return y;
      return above ? Math.max(y - maxUp, Math.min(y, o - 0.45)) : Math.min(y + maxUp, Math.max(y, o + 0.45));
    };
    if (!openL) y0 = attach(y0, x0 - 0.3, x0 + near);
    if (!openR) y1 = attach(y1, x1 - near, x1 + 0.3);
    // Obstacle profile under the arc, sampled once: `o` is the skyline edge at each sampled
    // `t` (0..1 along the span). Sampling once keeps the search for the end points below cheap.
    const samples: { t: number; o: number }[] = [];
    for (let x = x0 + 0.3; x <= x1 - 0.3; x += 0.25) {
      if ((!openL && x < x0 + 0.45) || (!openR && x > x1 - 0.45)) continue; // attached ends: the note itself is there
      const o = reach(x - win / 2, x + win / 2);
      if (Math.abs(o) < 90) samples.push({ t: (x - x0) / L, o });
    }
    const hPref = Math.max(0.7, Math.min(3.0, 0.09 * L + 0.6));
    // Height needed for the arc, with end points at y0/y1, to clear everything underneath. The arc is
    // modelled as a parabola 4t(1-t) of its height over the chord, slightly flattened (0.95).
    const need = (ya: number, yb: number): number => {
      let h = hPref;
      for (const { t, o } of samples) {
        const chord = ya + (yb - ya) * t;
        const gap = above ? chord - (o - 0.4) : o + 0.4 - chord; // positive: the chord is beyond the obstacle edge, the arc must bulge
        if (gap > 0) h = Math.max(h, gap / (4 * t * (1 - t) * 0.95));
      }
      return h;
    };
    // The end points may move away from their notes (each on its own, so the slope can change) when
    // that makes a flatter arc possible; moving costs, and so does a tall arc, so the cheapest wins.
    const hLimit = Math.max(3.5, 0.07 * L); // long slurs may arch higher before the end points are lifted instead
    let best = { cost: Number.POSITIVE_INFINITY, d0: 0, d1: 0, h: hPref };
    for (let d0 = 0; d0 <= 8; d0 += 0.5) {
      for (let d1 = 0; d1 <= 8; d1 += 0.5) {
        const hh = need(y0 + dir * d0, y1 + dir * d1);
        const cost =
          2.5 * (d0 + d1) +
          0.25 * (hh - hPref) +
          (hh > hLimit ? 6 * (hh - hLimit) : 0) +
          0.04 * Math.abs(y1 + dir * d1 - y0 - dir * d0);
        if (cost < best.cost - 1e-9) best = { cost, d0, d1, h: hh };
      }
    }
    y0 += dir * best.d0;
    y1 += dir * best.d1;
    let h = best.h;
    h = Math.min(h, Math.max(7, 0.12 * L));
    return {
      h,
      L,
      draw: (hh: number) => {
        ctx.prims[staff].push({
          t: 'path',
          d: crescent(x0, y0, x1, y1, hh, thick, above, 0.1, 0.2),
          k: 'slur',
          o: slurId,
          r: a.ev,
          n: id,
        });
        const ym = Math.min(y0, y1);
        const yM = Math.max(y0, y1);
        // A slur between staves reaches into the other staff: it is not recorded there, or it would
        // push the staves apart for good.
        sky.add(x0, x1, above ? ym - hh : ym, above ? yM : yM + hh, true);
      },
    };
  };
  if (sa === sb) {
    const p = piece(sa, pa.x, pa.y, pb.x, pb.y, a.home);
    p?.draw(p.h);
  } else {
    // The two halves of a slur broken across systems get the same arch height so that they
    // read as one slur: the higher of the two is used for both...
    const p1 = piece(sa, pa.x, pa.y, sa.width - 0.2, pa.y, a.home, false, true);
    const p2 = piece(sb, Math.max(sb.prefix - 0.3, 0.5), pb.y, pb.x, pb.y, a.home, true, false);
    const hh = Math.max(p1?.h ?? 0, p2?.h ?? 0);
    // ... but a short half must not become a bowl just because the other one is long. `cap`
    // limits a half's height to a multiple of its own length (or its own natural height).
    const cap = (p: typeof p1) => (p ? Math.min(hh, Math.max(0.12 * p.L + 0.35, Math.min(p.h, 0.7))) : hh);
    p1?.draw(cap(p1));
    p2?.draw(cap(p2));
  }
}

// ------------------------------------------------------------------ marks
/** One mark as laid out on a system: extent for stacking and a drawing function taking its reference y. */
interface Item {
  kind: 'dyn' | 'hair' | 'pedal' | 'ott' | 'tempo' | 'text';
  x0: number;
  x1: number;
  side: 'above' | 'below';
  /** Extent above / below the reference line. */
  up: number;
  down: number;
  draw: (ref: number) => Prim[];
  /** The model mark (the start mark of a span). */
  src?: Mark;
  /** Row and order within the stack on one side: lower rows are nearer the staff. */
  row: number;
  order: number;
}

/** Glyphs of a dynamic like `mf`, its advance width, its extent above and below the baseline, and where its ink starts and ends (for centring on the notehead). */
function dynRun(text: string): { names: string[]; w: number; up: number; down: number; ink0: number; ink1: number } {
  const map: Record<string, string> = {
    p: 'dynamicPiano',
    m: 'dynamicMezzo',
    f: 'dynamicForte',
    r: 'dynamicRinforzando',
    s: 'dynamicSforzando',
    z: 'dynamicZ',
    n: 'dynamicNiente',
  };
  const names = text
    .split('')
    .map((c) => map[c])
    .filter(Boolean);
  let w = 0;
  let up = 0;
  let down = 0;
  let ink0 = 0;
  let ink1 = 0;
  names.forEach((n, i) => {
    const b = sm.bbox(n);
    if (i === 0) ink0 = b.x0;
    ink1 = w + b.x1;
    w += sm.adv(n);
    up = Math.max(up, b.y1);
    down = Math.max(down, -b.y0);
  });
  return { names, w, up, down, ink0, ink1 };
}

/** Centre of the notehead(s) sounding at `tick` (falls back to the column x plus half a head). */
function xHeadCentre(evs: EvL[], tick: number, x: number): number {
  const e = evs.find((q) => q.ev.kind === 'note' && q.start === tick);
  const g = e && geomOf.get(e);
  return g ? (g.headL + g.headR) / 2 : x + 0.6;
}

/** A span mark (hairpin, pedal, ottava) from its start mark to the matching stop, which may be in a later measure or system. */
interface Span {
  mark: Mark & { type: string };
  mi: number;
  end?: { mark: Mark; mi: number };
}

/**
 * Places all marks of staff `s` over the whole piece: collects them, splits spans into per-system pieces,
 * then stacks them in rows above/below the staff. Dynamics and hairpins of one side share a baseline over
 * the system; pedal and ottava lines get their own rows; each row clears the skyline and the rows nearer the staff.
 */
function drawMarks(systems: SysCtx[], sysOf: number[], s: number): void {
  const prep = systems[0].prep;
  const staffId = prep.score.staves[s].id;
  void staffId;
  const items: Item[][] = systems.map(() => []);
  // Collect spans: walk the marks in time order and pair every start with its stop. Hairpins
  // match by id, pedal and ottava by being the next stop of their kind; a span without a stop
  // runs to the end of the piece.
  const hairs: Span[] = [];
  const pedals: Span[] = [];
  const otts: Span[] = [];
  const openHair = new Map<number, Span>();
  let openPedal: Span | null = null;
  let openOtt: Span | null = null;
  const lastMi = prep.measures.length - 1;
  for (let mi = 0; mi < prep.measures.length; mi++) {
    for (const m of prep.measures[mi][s].marks) {
      const sys = systems[sysOf[mi]];
      const x = xAtTick(sys, mi, m.tick);
      const si = sysOf[mi];
      switch (m.type) {
        case 'dynamic': {
          const r = dynRun(m.text);
          const cx = xHeadCentre(prep.measures[mi][s].evs, m.tick, x);
          const side = m.placement ?? 'below';
          let left = cx - (r.ink0 + r.ink1) / 2; // origin so that the visible ink is centred on the notehead
          // Never straddle a barline: slide the run beside it, to the left, except for a dynamic at the
          // start of a measure, which stays in that measure.
          for (let k = sys.a; k <= sys.b; k++) {
            const bx = sys.mx[k] + sys.placed[k].endX;
            if (bx > left + r.ink0 - 0.2 && bx < left + r.ink1 + 0.2)
              left = m.tick === 0 && k === mi - 1 ? bx + 0.35 - r.ink0 : bx - 0.35 - r.ink1; // a dynamic at a measure's start stays in that measure
          }
          items[si].push({
            src: m,
            kind: 'dyn',
            x0: left + r.ink0,
            x1: left + r.ink1,
            side,
            up: r.up,
            down: r.down,
            row: 0,
            order: 0,
            draw: (ref) => {
              let px = left;
              return r.names.map((n) => {
                const p: Prim = { t: 'glyph', name: n, x: px, y: ref };
                px += sm.adv(n);
                return p;
              });
            },
          });
          break;
        }
        case 'hairpin': {
          const sp: Span = { mark: m, mi };
          openHair.set(m.id, sp);
          hairs.push(sp);
          break;
        }
        case 'pedal': {
          if (openPedal && !openPedal.end) openPedal.end = { mark: m, mi };
          openPedal = { mark: m, mi };
          pedals.push(openPedal);
          break;
        }
        case 'ottava': {
          openOtt = { mark: m, mi };
          otts.push(openOtt);
          break;
        }
        case 'stop': {
          if (m.of === 'hairpin') {
            const sp = openHair.get(m.id);
            if (sp) {
              sp.end = { mark: m, mi };
              openHair.delete(m.id);
            }
          } else if (m.of === 'pedal') {
            if (openPedal) {
              openPedal.end = { mark: m, mi };
              openPedal = null;
            }
          } else if (openOtt) {
            openOtt.end = { mark: m, mi };
            openOtt = null;
          }
          break;
        }
        case 'tempo': {
          const unit = m.unit === 4 ? 'metNoteQuarterUp' : m.unit === 2 ? 'metNoteHalfUp' : 'metNoteQuarterUp';
          const nb = sm.bbox(unit);
          const label = `= ${m.bpm}`;
          const size = 2.5;
          const wText = label.length * size * 0.55;
          const dotsW = m.dots * 0.5;
          items[si].push({
            src: m,
            kind: 'tempo',
            x0: x,
            x1: x + nb.x1 + dotsW + 0.5 + wText,
            side: 'above',
            up: 1.6,
            down: 0.2,
            row: 0,
            order: 0,
            draw: (ref) => {
              const out: Prim[] = [{ t: 'glyph', name: unit, x, y: ref }];
              for (let k = 0; k < m.dots; k++)
                out.push({ t: 'glyph', name: 'metAugmentationDot', x: x + nb.x1 + 0.2 + k * 0.5, y: ref });
              out.push({ t: 'text', x: x + nb.x1 + dotsW + 0.5, y: ref + 0.5, s: label, size, bold: true });
              return out;
            },
          });
          break;
        }
        case 'text': {
          const side = m.placement ?? 'above';
          const size = 2.0;
          items[si].push({
            src: m,
            kind: 'text',
            x0: x,
            x1: x + m.text.length * size * 0.5,
            side,
            up: 1.5,
            down: 0.5,
            row: 0,
            order: 1,
            draw: (ref) => [{ t: 'text', x, y: ref, s: m.text, size, italic: true }],
          });
          break;
        }
        default:
          break;
      }
    }
  }
  /** x of the stem (head centre if stemless) of the note starting at `tick` ('at') or of the last note before it ('before'), in system coordinates. */
  const stemAt = (
    mi: number,
    tick: number,
    mode: 'at' | 'before',
    what: 'stem' | 'headL' | 'headR' = 'stem',
  ): number | undefined => {
    let e: EvL | undefined;
    let m = mi;
    const notes = (k: number) => prep.measures[k][s].evs.filter((q) => q.ev.kind === 'note');
    if (mode === 'at') e = notes(m).find((q) => q.start === tick);
    else {
      e = notes(m)
        .filter((q) => q.start < tick)
        .pop();
      if (!e && m > 0 && sysOf[m - 1] === sysOf[m]) {
        m -= 1;
        e = notes(m).pop();
      }
    }
    const g = e && geomOf.get(e);
    if (!g) return undefined;
    if (what === 'headL') return g.headL;
    if (what === 'headR') return g.headR;
    return must(e).stem ? g.stemX : (g.headL + g.headR) / 2;
  };
  const endOfPiece = { mi: lastMi, tick: prep.measureLen[lastMi] };
  // Spans -> per-system pieces: a span crossing a system break becomes one piece per system, with
  // `first`/`last` telling which ends are real (the others are open at the break).
  const pieces = (
    sp: Span,
    startOff: number,
    endOff: number,
    snap: boolean | { start: 'stem' | 'headL'; end: 'stem' | 'headR' } = false,
  ): { si: number; x0: number; x1: number; first: boolean; last: boolean }[] => {
    const m0 = sp.mi;
    const t0 = (sp.mark as Mark).tick;
    const m1 = sp.end ? sp.end.mi : endOfPiece.mi;
    const t1 = sp.end ? (sp.end.mark as Mark).tick : endOfPiece.tick;
    const out: { si: number; x0: number; x1: number; first: boolean; last: boolean }[] = [];
    const s0 = sysOf[m0];
    const s1 = sysOf[m1];
    for (let si = s0; si <= s1; si++) {
      const ctx = systems[si];
      const first = si === s0;
      const last = si === s1;
      const sn = snap === true ? { start: 'stem' as const, end: 'stem' as const } : snap;
      const sx = sn && first ? stemAt(m0, t0, 'at', sn.start) : undefined;
      const ex = sn && last && sp.end ? stemAt(m1, t1, 'before', sn.end) : undefined;
      const x0 = first ? (sx ?? xAtTick(ctx, m0, t0) + startOff) : ctx.prefix;
      const x1 = last ? (ex ?? xAtTick(ctx, m1, t1) + endOff) : ctx.width - 0.3;
      if (x1 - x0 > 0.3) out.push({ si, x0, x1, first, last });
    }
    return out;
  };
  // Hairpins: two lines opening (cresc) or closing (dim) over the length. A piece that ends at a
  // system break stays half open there, so that the next piece continues at the same width.
  const W = 1.15;
  for (const sp of hairs) {
    const m = sp.mark as Mark & { type: 'hairpin' };
    // Every hairpin starts at the notehead and ends at the stem (the `snap` option of `pieces`),
    // not at the plain x of the first and last note.
    const ps = pieces(sp, 0, -0.5, { start: 'headL', end: 'stem' });
    for (const p of ps) {
      const wide = W;
      const mid = W * 0.55;
      const o0 = m.kind === 'cresc' ? (p.first ? 0 : mid) : p.first ? wide : mid;
      const o1 = m.kind === 'cresc' ? (p.last ? wide : mid) : p.last ? 0 : mid;
      const th = D.hairpinThickness as number;
      const item: Item = {
        src: sp.mark as Mark,
        kind: 'hair',
        x0: p.x0,
        x1: p.x1,
        side: m.placement ?? 'below',
        up: Math.max(o0, o1) / 2 + th,
        down: Math.max(o0, o1) / 2 + th,
        row: 0,
        order: 0,
        draw: (ref) => [
          { t: 'line', x1: item.x0, y1: ref - o0 / 2, x2: item.x1, y2: ref - o1 / 2, w: th },
          { t: 'line', x1: item.x0, y1: ref + o0 / 2, x2: item.x1, y2: ref + o1 / 2, w: th },
        ],
      };
      items[p.si].push(item);
    }
  }
  // Pedal: `Ped.` at the press and a line to the release (a hook up at a real end). A continuation
  // on a later system starts with `(Ped.)`.
  for (const sp of pedals) {
    const ps = pieces(sp, -0.2, -0.5);
    const pedB = sm.bbox('keyboardPedalPed');
    const pedW = sm.adv('keyboardPedalPed');
    const th = D.pedalLineThickness as number;
    for (const p of ps) {
      const upExt = pedB.y1;
      const downExt = -pedB.y0;
      items[p.si].push({
        src: sp.mark as Mark,
        kind: 'pedal',
        x0: p.x0,
        x1: p.x1,
        side: 'below',
        up: upExt,
        down: downExt,
        row: 1,
        order: 0,
        draw: (ref) => {
          const out: Prim[] = [];
          let lx = p.x0;
          if (p.first) {
            out.push({ t: 'glyph', name: 'keyboardPedalPed', x: p.x0, y: ref });
            lx = p.x0 + pedW + 0.3;
          } else if (p.x1 - p.x0 > pedW + 2) {
            // continuation of a pedal from the previous system: "(Ped.)"
            const lw = sm.adv('keyboardPedalParensLeft');
            out.push({ t: 'glyph', name: 'keyboardPedalParensLeft', x: p.x0, y: ref });
            out.push({ t: 'glyph', name: 'keyboardPedalPed', x: p.x0 + lw, y: ref });
            out.push({ t: 'glyph', name: 'keyboardPedalParensRight', x: p.x0 + lw + pedW, y: ref });
            lx = p.x0 + lw + pedW + sm.adv('keyboardPedalParensRight') + 0.3;
          }
          const ly = ref - 0.25;
          if (p.x1 - lx > 0.2) out.push({ t: 'line', x1: lx, y1: ly, x2: p.x1, y2: ly, w: th });
          if (p.last && sp.end) out.push({ t: 'line', x1: p.x1, y1: ly, x2: p.x1, y2: ly - 0.9, w: th });
          return out;
        },
      });
    }
  }
  // Octave shifts: the `8va`/`8vb` label at the start, a dashed line, and at a real end a hook
  // pointing towards the staff. A continuation on a later system has the line only.
  for (const sp of otts) {
    const m = sp.mark as Mark & { type: 'ottava' };
    const above = m.dir === 'up';
    const gname = above ? 'ottavaAlta' : 'ottavaBassa';
    const gb = sm.bbox(gname);
    const gw = sm.adv(gname);
    const ps = pieces(sp, -0.2, 0.7);
    for (const p of ps) {
      const up = Math.max(gb.y1, 0.8);
      const down = Math.max(-gb.y0, 0.8);
      items[p.si].push({
        src: m,
        kind: 'ott',
        x0: p.x0,
        x1: p.x1,
        side: above ? 'above' : 'below',
        up,
        down,
        row: 0,
        order: -1,
        draw: (ref) => {
          const out: Prim[] = [];
          let lx = p.x0;
          if (p.first) {
            out.push({ t: 'glyph', name: gname, x: p.x0, y: ref });
            lx = p.x0 + gw + 0.3;
          }
          const th = D.octaveLineThickness as number;
          const lineY = ref - (gb.y1 + gb.y0) / 2;
          out.push({ t: 'line', x1: lx, y1: lineY, x2: p.x1, y2: lineY, w: th, dash: [0.5, 0.35] });
          if (p.last && sp.end)
            out.push({ t: 'line', x1: p.x1, y1: lineY, x2: p.x1, y2: lineY + (above ? 0.9 : -0.9), w: th });
          return out;
        },
      });
    }
  }
  // ---- Place per system. The items collected above are laid out one system at a time: first
  // dynamics and hairpins are made not to touch, then the rows are stacked on each side.
  systems.forEach((ctx, si) => {
    const sky = ctx.sky[s];
    const its = items[si];
    // A hairpin stops short of a dynamic that follows it and starts after one that precedes it,
    // leaving 0.3 spaces; the dynamic itself never moves.
    for (const hp of its.filter((i) => i.kind === 'hair')) {
      for (const d of its.filter((i) => i.kind === 'dyn' && i.side === hp.side)) {
        if (d.x0 < hp.x1 + 0.3 && d.x1 > hp.x1 - 1.0 && d.x0 > hp.x0) hp.x1 = Math.min(hp.x1, d.x0 - 0.3);
        else if (d.x1 > hp.x0 - 0.3 && d.x0 < hp.x0 + 1.0 && d.x1 < hp.x1) hp.x0 = Math.max(hp.x0, d.x1 + 0.3);
      }
    }
    const place = (side: 'above' | 'below') => {
      const list = its.filter((i) => i.side === side).sort((a, b) => a.row - b.row || a.order - b.order || a.x0 - b.x0);
      // All dynamics and hairpins of this side share one baseline over the whole system, so that a
      // row of them reads as a line; pedal and ottava rows go outside it.
      const groups: Item[][] = [];
      let dynGroup: Item[] | null = null;
      let pedGroup: Item[] | null = null;
      for (const it of list) {
        if (it.kind === 'dyn' || it.kind === 'hair') {
          if (!dynGroup) {
            dynGroup = [];
            groups.push(dynGroup);
          }
          dynGroup.push(it);
        } else if (it.kind === 'pedal') {
          if (!pedGroup) {
            pedGroup = [];
            groups.push(pedGroup);
          }
          pedGroup.push(it); // all pedal lines of the system share one baseline
        } else groups.push([it]);
      }
      for (const g of groups) {
        const clear = 0.55;
        let ref = side === 'below' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
        for (const it of g) {
          const hairOff = it.kind === 'hair' ? 0.55 : 0; // hairpin centre sits above the dynamic baseline
          if (side === 'below') {
            const b = sky.bottom(it.x0, it.x1, 4);
            ref = Math.max(ref, b + clear + it.up + (it.kind === 'hair' ? 0 : 0) + hairOff);
          } else {
            const t = sky.top(it.x0, it.x1, 0, it.kind === 'dyn'); // a dynamic stays close to the notes, under any slur arching over them
            ref = Math.min(ref, t - clear - it.down + hairOff * 0);
          }
        }
        for (const it of g) {
          const r = it.kind === 'hair' ? ref - 0.55 : ref;
          const kind: Kind = it.kind === 'hair' ? 'hairpin' : it.kind === 'ott' ? 'ottava' : it.kind;
          for (const p of it.draw(r)) {
            p.k = kind;
            p.o = oid(it);
            p.r = it.src;
            if (it.kind === 'dyn' || it.kind === 'hair') p.a = ref;
            ctx.prims[s].push(p);
          }
          sky.add(it.x0, it.x1, r - it.up, r + it.down);
        }
      }
    };
    place('above');
    place('below');
  });
}
