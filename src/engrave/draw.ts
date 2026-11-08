// Drawing of notes, rests, stems, beams, tuplets etc. into staff-local primitives.
//
// `drawSystemNotes` draws one system in phases (see the numbered comments there): heads and
// everything attached to them first, since stems and beams need their positions; then stems and
// beams per voice; then what depends on those (articulations, tuplet brackets). Per-event geometry
// (head extents, stem anchor and tip) is kept in `geomOf` for the phases that follow, including the
// spanner pass. Every primitive pushed here is tagged (`tagFrom`) for collision checking and hit testing,
// and its occupied area is added to the staff's skyline (`pushBox`) so that spanners and marks can avoid it.

import type { Articulation, NoteEvent, TupletGroup } from '../model.ts';

import { loadSmufl } from '../smufl.ts';
import { must, round3 } from '../util.ts';
import type { BeamL, EvL, Prepared } from './prep.ts';
import { beamLevels, posToY, staffPos } from './prep.ts';
import type { Prim, Skyline } from './scene.ts';
import { oid, tagFrom } from './scene.ts';
import type { MeasureSpacing, PlacedMeasure } from './spacing.ts';

import {
  DOT_STEP,
  END_CLEF_GAP,
  flagGlyph,
  GRACE_SCALE,
  HEAD_SCALE,
  headGlyph,
  headWidth,
  restGlyph,
  STEM_T,
} from './spacing.ts';

const sm = loadSmufl();
export const D = new Proxy({} as typeof sm.def, { get: (_, k) => sm.def[k as string] }); // The proxy is lazy because the font may not be loaded yet.

export interface SysCtx {
  prep: Prepared;
  index: number;
  a: number;
  b: number; // These are the first and last measure index (inclusive).
  spacing: MeasureSpacing[]; // This is indexed by measure index and holds the variant actually used.
  placed: PlacedMeasure[]; // This is indexed by measure index.
  mx: number[]; // This is the left x of each measure (system-local), indexed by measure index.
  prefix: number; // This is the width before the first measure.
  width: number;
  f: number;
  prims: Prim[][]; // There is one list per staff, in staff-local coordinates.
  sky: Skyline[];
  staffY: number[]; // This is the y of each staff's top line (system-local).
  barlines: { x: number; type: 'single' | 'final' | 'double' | 'repeat-end'; mi: number }[];
  tupletBoxes: [number, number][];
  /** Staff-to-staff gap (bottom of staff s-1 to top of staff s) that cross-staff geometry is drawn for; finalize must keep it */
  gap: number[];
  /** Per staff: gap required by the cross-staff beams drawn with `gap` (may be smaller than `gap`). */
  gapNeed: number[];
  pinned?: boolean; // When set, `gap` is final because the system has cross-staff beams.
  /** The system's content exceeds the line even at the tightest spacing (a warning is due). */
  overflow?: boolean;
  /** What the notes alone occupy, recorded when they are drawn (before spanners and marks are added): `rewindToNotes` returns to it. */
  base?: { prims: number[]; sky: number[] };
  /** What the notes with their ties and slurs occupy (marks come after): where `rewindToSpanners` goes back to. */
  ts?: { prims: number[]; sky: number[] };
  /** Identifies the ties and slurs this system was drawn with (see `planSpanners`). */
  spanSig?: string;
  /** The gap was widened after the notes were drawn (for slurs and marks), so `base` no longer applies. */
  widened?: boolean;
}

export const CROSS_GAP0 = 6;

/** A glyph primitive whose bounding box is centred on (cx, cy). */
function glyphCentered(name: string, cx: number, cy: number): Prim {
  const b = sm.bbox(name);
  return { t: 'glyph', name, x: cx - (b.x0 + b.x1) / 2, y: cy + (b.y0 + b.y1) / 2 };
}

/**
 * The x of tick `tick` of measure `mi` in the system's layout (interpolated between columns, or the measure start
 * for a multi-measure rest).
 */
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
      const t0 = cols[j - 1].tick;
      const t1 = cols[j].tick;
      return base + pl.xs[j - 1] + ((pl.xs[j] - pl.xs[j - 1]) * (tick - t0)) / (t1 - t0);
    }
  }
  const j = cols.length - 1;
  return base + pl.xs[j] + ((pl.endX - pl.xs[j]) * (tick - cols[j].tick)) / (len - cols[j].tick);
}

/** Records an occupied area in the staff's skyline: later passes (slurs, marks, other staves) keep clear of it. */
function pushBox(ctx: SysCtx, s: number, x0: number, x1: number, y0: number, y1: number, acc = false) {
  ctx.sky[s].add(x0, x1, y0, y1, false, acc);
}

/** Stem length in staff spaces for a note with `levels` flags/beams: 3.5, plus 0.75 for every level beyond two. */
function stemLength(levels: number): number {
  return levels <= 2 ? 3.5 : 3.5 + 0.75 * (levels - 2);
}

/**
 * Where an event's parts ended up, staff-local: head columns (`headL`..`headR`), the vertical extent of
 * its heads (`yTop`/`yBot`), the stem's x and its two ends. `homed`: the stem values are in the voice's
 * staff coordinates rather than the heads' (cross-staff beams).
 */
export interface Geom {
  homed?: boolean;
  shift: number;
  x: number;
  hw: number;
  yTop: number;
  yBot: number;
  stemX: number;
  stemTip: number;
  stemBase: number;
  headL: number;
  headR: number;
}

export const geomOf = new WeakMap<EvL, Geom>();

/** Outer edge (y) of the articulation stack of a note and the side it is on; slurs on that side start beyond it. */
export const articExtent = new WeakMap<EvL, { above: boolean; edge: number }>();

/** One ledger line as drawn, with the extent of the head it serves (`hx0`..`hx1`), so that neighbours can be trimmed. */
interface LedgerSeg {
  prim: Prim;
  s: number;
  y: number;
  x0: number;
  x1: number;
  hx0: number;
  hx1: number;
}

let ledgerSegs: LedgerSeg[] = [];

/** Neighbouring notes must not have their ledger lines run into each other: leave a gap, trimming both sides evenly. */
function trimLedgers(ctx: SysCtx): void {
  const GAP = 0.35;
  const groups = new Map<string, LedgerSeg[]>();
  for (const l of ledgerSegs) {
    const k = `${l.s}|${l.y.toFixed(3)}`;
    if (!groups.has(k)) groups.set(k, []);
    must(groups.get(k)).push(l);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.hx0 - b.hx0 || a.x0 - b.x0);
    let a = list[0];
    for (let i = 1; i < list.length; i++) {
      const b = list[i];
      const deficit = GAP - (b.x0 - a.x1);
      if (deficit <= 0) {
        a = b;
        continue;
      }
      // Trim both lines by half the deficit each, but never cut into the head the line serves: what
      // one side cannot give up falls on the other side.
      const ra = Math.max(0, a.x1 - (a.hx1 + 0.05));
      const rb = Math.max(0, b.hx0 - 0.05 - b.x0);
      const ta = Math.min(ra, deficit / 2);
      const tb = Math.min(rb, deficit - ta);
      const ta2 = Math.min(ra, deficit - tb);
      a.x1 -= ta2;
      b.x0 += tb;
      // No room for a gap (heads nearly on top of each other): merge the two lines into one.
      // The second segment is marked dead (NaN) and removed afterwards.
      if (b.x0 < a.x1 + GAP / 2) {
        a.x1 = Math.max(a.x1, b.x1);
        b.x0 = b.x1 = Number.NaN;
      } else a = b;
    }
  }
  const dead = new Set<Prim>();
  for (const l of ledgerSegs) {
    if (Number.isNaN(l.x0)) {
      dead.add(l.prim);
      continue;
    }
    const p = l.prim as { x1: number; x2: number };
    p.x1 = l.x0;
    p.x2 = l.x1;
  }
  if (dead.size)
    ctx.prims.forEach((arr, k) => {
      ctx.prims[k] = arr.filter((q) => !dead.has(q));
    });
}

/** y of the top line of staff `to` relative to that of staff `from`, for the gaps cross-staff geometry is drawn with */
/** y distance from the top line of staff `from` to that of staff `to` (negative upwards), given the gaps in `ctx`. */
export function staffOffset(ctx: SysCtx, from: number, to: number): number {
  let y = 0;
  for (let k = from + 1; k <= to; k++) y += 4 + ctx.gap[k];
  for (let k = to + 1; k <= from; k++) y -= 4 + ctx.gap[k];
  return y;
}

/** Draws the notes, rests, stems, beams, tuplets and articulations of every measure of the system into `ctx.prims`. */
export function drawSystemNotes(ctx: SysCtx): void {
  const nStaves = ctx.prep.score.staves.length;
  ledgerSegs = [];
  for (let mi = ctx.a; mi <= ctx.b; mi++) {
    if (ctx.prep.absorbed?.has(mi)) continue; // A multi-measure rest swallowed this measure.
    // The phases run over all staves in turn: each needs what the previous drew on every staff.
    for (let s = 0; s < nStaves; s++) {
      positionEvents(ctx, mi, s);
      drawHeadsAndRests(ctx, mi, s);
    }
    for (let s = 0; s < nStaves; s++) drawStemsAndBeams(ctx, mi, s);
    for (let s = 0; s < nStaves; s++) {
      drawArticulationsOfStaff(ctx, mi, s);
      drawOrnamentsOfStaff(ctx, mi, s);
      drawTupletsOfStaff(ctx, mi, s);
    }
  }
  trimLedgers(ctx);
}

/** The number of beams (flags) the duration of an event needs. */
const beamLevelsOf = (e: EvL) => beamLevels(e.te.ev.dur.base);

/**
 * Phase 1: positions the events. x comes from the measure's columns, so notes sounding together line
 * up across staves; a whole-measure rest is centred in the bar instead.
 */
function positionEvents(ctx: SysCtx, mi: number, s: number): void {
  const sp = ctx.spacing[mi];
  const pl = ctx.placed[mi];
  const colIndex = new Map(sp.cols.map((c, j) => [c.tick, j]));
  for (const e of ctx.prep.measures[mi][s].evs) {
    if (e.ev.kind === 'rest' && e.ev.style === 'measure') {
      // Centred between the first column and the barline, or the small clef that precedes it.
      const right = sp.endClef[s] ? pl.endX - sm.adv('gClefChange') - 2 * END_CLEF_GAP : pl.endX;
      e.x = ctx.mx[mi] + (sp.lead + right) / 2 - sm.adv('restWhole') / 2;
      continue;
    }
    const j = colIndex.get(e.start);
    e.x = j === undefined ? xAtTick(ctx, mi, e.start) : ctx.mx[mi] + pl.xs[j];
  }
}

/**
 * Phase 2: heads, ledger lines, accidentals, dots, arpeggio, grace notes, and the rests. Everything
 * here is positioned from the head columns alone; stems come in the next phase.
 */
function drawHeadsAndRests(ctx: SysCtx, mi: number, s: number): void {
  const evs = ctx.prep.measures[mi][s].evs;
  for (const e of evs) {
    if (e.ev.kind === 'rest') {
      // A whole-measure rest is not drawn when notes from another staff cross over onto this one:
      // the rest would sit in the middle of those notes and say nothing true about the bar.
      const crossedOver = e.ev.style === 'measure' && evs.some((o) => o.home !== s && o.ev.kind === 'note');
      if (e.ev.style !== 'hidden' && !crossedOver) drawRest(ctx, e, s);
      else if (e.ev.style === 'hidden' && ctx.prep.ghostRests) drawRest(ctx, e, s, true);
      continue;
    }
    drawNoteBasics(ctx, e, s);
    if (e.graces) drawGraces(ctx, e, s);
  }
}

/** The stem of a single note (not beamed, not in a tremolo pair) with the flag it needs. */
function drawSingleStem(ctx: SysCtx, e: EvL): void {
  const g = must(geomOf.get(e));
  let len = stemLength(Math.max(1, beamLevelsOf(e)));
  // A displaced head right of an up-stem would run into the flag: lengthen the stem so that
  // the flag starts clear of it.
  if (e.stem === 'up' && e.te.ev.dur.base >= 8 && e.heads.some((h) => h.dx > g.hw / 2 && !h.shared)) len += 0.6;
  // The flag of a down-stem curls up towards the (wider) head, so it needs a little more
  // length to avoid touching it.
  if (e.stem === 'down' && e.te.ev.dur.base >= 8) len += 0.3;
  setStem(e, g, len);
  drawStem(ctx, e, g, e.staff, true);
}

/**
 * Phase 3: stems and beams per voice. A cross-staff note's stem is drawn on the staff it sits on, but
 * a beam over two staves is drawn once, on the voice's staff, by `drawCrossBeam`.
 */
function drawStemsAndBeams(ctx: SysCtx, mi: number, s: number): void {
  for (const v of ctx.prep.measures[mi][s].voices) {
    const doneBeams = new Set<object>();
    for (const e of v.evs) {
      if (e.ev.kind !== 'note') continue;
      if (e.beam) {
        if (doneBeams.has(e.beam)) continue;
        doneBeams.add(e.beam);
        if (e.beam.cross) drawCrossBeam(ctx, e.beam, s, beamLevelsOf);
        else drawBeamGroup(ctx, e.beam.notes, e.staff, beamLevelsOf);
      } else if (e.tremPair) {
        if (e.tremIsFirst) drawTremoloPair(ctx, e, e.tremPair, e.staff); // The second note of the pair is drawn together with the first.
      } else if (e.stem) drawSingleStem(ctx, e);
    }
  }
}

/**
 * Phase 4: articulations are placed relative to the heads or the stem tip, so they come after the
 * stems. Their outer edge is recorded (`articExtent`) so that slurs start beyond them.
 */
function drawArticulationsOfStaff(ctx: SysCtx, mi: number, s: number): void {
  for (const e of ctx.prep.measures[mi][s].evs)
    if (e.ev.kind === 'note' && e.ev.art?.length) drawArticulations(ctx, e, s);
}

/**
 * Phase 4b: trill marks and fermatas sit above the event, beyond its heads, stem tip and any
 * articulations above (a trill nearest, the fermata beyond it), and never inside the staff.
 */
function drawOrnamentsOfStaff(ctx: SysCtx, mi: number, s: number): void {
  for (const e of ctx.prep.measures[mi][s].evs) {
    const trill = e.ev.kind === 'note' && e.ev.trill;
    if (!(trill || e.ev.fermata)) continue;
    let cx: number;
    let top = -1; // The top edge (y) of whatever is already there; ornaments go above it.
    if (e.ev.kind === 'note') {
      const g = must(geomOf.get(e));
      const dxs = e.heads.map((h) => h.dx);
      cx = e.x + (Math.min(...dxs) + Math.max(...dxs)) / 2 + g.hw / 2;
      top = Math.min(top, g.yTop - 1);
      if (e.stem === 'up') top = Math.min(top, g.stemTip - 0.4);
      const ext = articExtent.get(e);
      if (ext?.above) top = Math.min(top, ext.edge - 0.3);
    } else {
      const b = sm.bbox(restGlyph(e.te.ev.dur.base, e.ev.kind === 'rest' && e.ev.style === 'measure'));
      cx = e.x + (b.x0 + b.x1) / 2;
    }
    for (const [name, on, kind] of [
      ['ornamentTrill', trill, 'trill'],
      ['fermataAbove', e.ev.fermata, 'fermata'],
    ] as const) {
      if (!on) continue;
      const b = sm.bbox(name);
      const h = b.y1 - b.y0;
      const w = b.x1 - b.x0;
      const start = ctx.prims[s].length;
      ctx.prims[s].push(glyphCentered(name, cx, top - h / 2));
      pushBox(ctx, s, cx - w / 2, cx + w / 2, top - h, top);
      if (kind === 'trill' && e.ev.kind === 'note' && e.ev.trillAcc !== undefined) {
        const acc = e.ev.trillAcc > 0 ? 'accidentalSharp' : e.ev.trillAcc < 0 ? 'accidentalFlat' : 'accidentalNatural';
        const ab = sm.bbox(acc);
        const sc = 0.7;
        const ah = (ab.y1 - ab.y0) * sc;
        const ay = top - h - 0.1; // The accidental's bottom edge.
        ctx.prims[s].push({
          t: 'glyph',
          name: acc,
          x: cx - ((ab.x0 + ab.x1) / 2) * sc,
          y: ay + ab.y0 * sc,
          sx: sc,
          sy: sc,
        });
        pushBox(ctx, s, cx - ((ab.x1 - ab.x0) * sc) / 2, cx + ((ab.x1 - ab.x0) * sc) / 2, ay - ah, ay);
        tagFrom(ctx.prims[s], start, kind, e);
        top -= h + ah + 0.4;
        continue;
      }
      tagFrom(ctx.prims[s], start, kind, e);
      top -= h + 0.3;
    }
  }
}

/**
 * Phase 5: tuplets. Brackets and numbers avoid the stems, beams and articulations drawn so far, which
 * is why they come last.
 */
function drawTupletsOfStaff(ctx: SysCtx, mi: number, s: number): void {
  const seen = new Set<TupletGroup>();
  for (const v of ctx.prep.measures[mi][s].voices)
    for (const e of v.evs)
      for (const t of e.tupletKeys) {
        if (seen.has(t)) continue;
        seen.add(t);
        const members = v.evs.filter((x) => x.tupletKeys.includes(t));
        // Over a beam between two staves the bracket cannot avoid the stems in the gap, so it goes
        // above the upper staff's notes. A tuplet whose notes all sit on another staff is drawn there:
        // on the voice's staff its bracket would lie in the gap, and the gap would grow with it
        // (the bracket is drawn in `at`'s coordinates).
        const staves = new Set(members.map((x) => x.staff));
        const at = members.some((x) => x.beam?.cross)
          ? Math.min(...staves)
          : staves.size === 1
            ? Math.min(...staves)
            : s;
        if (at !== s || members.some((x) => x.staff !== s))
          withHomeGeometry(ctx, members, at, () => drawTuplet(ctx, t, members, at));
        else drawTuplet(ctx, t, members, s);
      }
}

/** Runs `fn` with the geometry of members expressed in the coordinates of staff `target`. */
function withHomeGeometry(ctx: SysCtx, evs: EvL[], target: number, fn: () => void): void {
  const saved = new Map<EvL, Geom>();
  for (const e of evs) {
    const g = geomOf.get(e);
    if (!g) continue;
    const dh = staffOffset(ctx, target, e.staff); // Heads are in the coordinates of their own staff.
    const ds = staffOffset(ctx, target, g.homed ? e.home : e.staff); // Stems of cross-staff beams are in the coordinates of the voice's staff.
    if (!(dh || ds)) continue;
    saved.set(e, g);
    geomOf.set(e, { ...g, yTop: g.yTop + dh, yBot: g.yBot + dh, stemBase: g.stemBase + ds, stemTip: g.stemTip + ds });
  }
  fn();
  for (const [e, g] of saved) geomOf.set(e, g);
}

/**
 * A beam between two staves, drawn in the coordinates of the voice's staff. Stems of the upper staff's notes point down,
 * those of the lower staff's up, and the beam (flat) runs in the gap between: when the gap is too small `ctx.gapNeed`
 * says how large it must be.
 */
function drawCrossBeam(ctx: SysCtx, beam: BeamL, home: number, levelsFor: (e: EvL) => number): void {
  const notes = beam.notes;
  const maxLv = Math.max(...notes.map(levelsFor));
  const bt = D.beamThickness as number;
  const bs = D.beamSpacing as number;
  const inner = (maxLv - 1) * (bt + bs) + bt;
  const gs = notes.map((n) => must(geomOf.get(n)));
  const off = notes.map((n) => staffOffset(ctx, home, n.staff));
  const MIN = 3.0;
  /** The admissible range for the y of the beam's top edge, narrowed by every stem below. */
  let lo = Number.NEGATIVE_INFINITY;
  let hi = Number.POSITIVE_INFINITY;
  notes.forEach((n, i) => {
    const g = gs[i];
    g.stemX = n.stem === 'up' ? g.x + g.shift + g.hw - STEM_T / 2 : g.x + g.shift + STEM_T / 2;
    // Stems run to the outer edge of the beam stack (hence `inner`): its bottom for the upper staff's
    // notes, its top for the lower staff's. MIN keeps the stems a sensible minimum length.
    if (n.stem === 'down') lo = Math.max(lo, g.yBot + off[i] + MIN - inner);
    else hi = Math.min(hi, g.yTop + off[i] - MIN);
  });
  // The beam lives in the gap between the staves: centre it in the admissible range so that
  // the stems of both staves have the same slack.
  const a = Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : Number.isFinite(lo) ? lo : hi;
  if (Number.isFinite(lo) && Number.isFinite(hi)) {
    // If lo > hi the gap is too small. Growing the gap between the staves by d raises hi (or lowers
    // lo) by d, so the shortfall lo - hi is exactly how much it must grow (picked up by `system.ts`).
    const low = Math.max(...notes.map((n) => n.staff));
    ctx.gapNeed[low] = Math.max(ctx.gapNeed[low], ctx.gap[low] + (lo - hi));
  }
  notes.forEach((n, i) => {
    const g = gs[i];
    g.homed = true;
    g.stemBase = n.stem === 'up' ? g.yBot + off[i] - 0.168 : g.yTop + off[i] + 0.168;
    g.stemTip = n.stem === 'up' ? a : a + inner;
    drawStem(ctx, n, g, home, false, true);
  });
  beam.crossY = [a, a + inner];
  const n0 = ctx.prims[home].length;
  for (let lv = 1; lv <= maxLv; lv++) {
    const y0 = a + (lv - 1) * (bt + bs);
    let i = 0;
    while (i < notes.length) {
      if (levelsFor(notes[i]) < lv) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < notes.length && levelsFor(notes[j + 1]) >= lv && !restBetween(notes[j], notes[j + 1], beam.evs))
        j++;
      let xa: number;
      let xb: number;
      if (j > i) {
        xa = gs[i].stemX - STEM_T / 2;
        xb = gs[j].stemX + STEM_T / 2;
      } else if (
        i === 0 ||
        (i < notes.length - 1 && notes[i + 1].start - notes[i].start < notes[i].start - notes[i - 1].start)
      ) {
        xa = gs[i].stemX - STEM_T / 2;
        xb = gs[i].stemX + 1.1;
      } else {
        xa = gs[i].stemX - 1.1;
        xb = gs[i].stemX + STEM_T / 2;
      }
      ctx.prims[home].push({
        t: 'path',
        d: `M${xa.toFixed(3)} ${y0.toFixed(3)}L${xb.toFixed(3)} ${y0.toFixed(3)}L${xb.toFixed(3)} ${(y0 + bt).toFixed(3)}L${xa.toFixed(3)} ${(y0 + bt).toFixed(3)}Z`,
      });
      i = j + 1;
    }
  }
  tagFrom(ctx.prims[home], n0, 'beam', beam);
}

/**
 * Sets the stem tip of an event from the head extent `g` and the length `len`; the tip never ends before the
 * middle line.
 */
function setStem(e: EvL, g: Geom, len: number): void {
  const up = e.stem === 'up';
  let tip = up ? g.yTop - len : g.yBot + len;
  if (up) tip = Math.min(tip, 2);
  else tip = Math.max(tip, 2);
  g.stemTip = tip;
}

/** The groups a stem belongs to for collision tagging: its beam, its tremolo pair and its tuplets. */
function stemGroups(e: EvL): (object | undefined)[] {
  return [e.beam, e.tremPair ? (e.tremIsFirst ? e : e.tremPair) : undefined, ...e.tupletKeys];
}

/**
 * Draws the stem of event `e` on staff `s`, with its flag unless `flag` is false; `noSky` keeps it out of the
 * skyline.
 */
function drawStem(ctx: SysCtx, e: EvL, g: Geom, s: number, flag: boolean, noSky = false): void {
  const up = e.stem === 'up';
  const n0 = ctx.prims[s].length;
  ctx.prims[s].push({ t: 'line', x1: g.stemX, y1: g.stemBase, x2: g.stemX, y2: g.stemTip, w: STEM_T });
  tagFrom(ctx.prims[s], n0, 'stem', e, stemGroups(e));
  const base = e.te.ev.dur.base;
  if (flag && base >= 8 && !e.beam) {
    const n = beamLevels(base);
    const name = flagGlyph(n, up);
    ctx.prims[s].push({ t: 'glyph', name, x: g.stemX - STEM_T / 2, y: g.stemTip });
    tagFrom(ctx.prims[s], ctx.prims[s].length - 1, 'flag', e, stemGroups(e));
    const b = sm.bbox(name);
    pushBox(
      ctx,
      s,
      g.stemX,
      g.stemX + b.x1,
      Math.min(g.stemTip, g.stemTip - b.y1),
      Math.max(g.stemTip, g.stemTip - b.y0),
    );
  }
  const lo = Math.min(g.stemBase, g.stemTip);
  const hi = Math.max(g.stemBase, g.stemTip);
  if (!noSky) pushBox(ctx, s, g.stemX - STEM_T / 2, g.stemX + STEM_T / 2, lo, hi);
}

/** The head and accidental of head `hi`, tagged with the head index; the accidental also gets a skyline box. */
function drawHeadWithAccidental(ctx: SysCtx, e: EvL, s: number, hi: number): void {
  const prims = ctx.prims[s];
  const h = e.heads[hi];
  const y = posToY(h.pos);
  prims.push({ t: 'glyph', name: headGlyph(e.te.ev.dur.base), x: e.x + h.dx, y, sx: HEAD_SCALE, sy: 1 });
  tagFrom(prims, prims.length - 1, 'head', e, h.sharers);
  prims[prims.length - 1].n = hi;
  const accStart = prims.length;
  if (h.acc) {
    const ax = e.x + must(h.accX);
    const glyph = h.acc.glyph;
    if (h.acc.cautionary) {
      const parenWidth = sm.adv('accidentalParensLeft');
      prims.push({ t: 'glyph', name: 'accidentalParensLeft', x: ax, y });
      prims.push({ t: 'glyph', name: glyph, x: ax + parenWidth, y });
      prims.push({ t: 'glyph', name: 'accidentalParensRight', x: ax + parenWidth + sm.adv(glyph), y });
      const box = sm.bbox(glyph);
      pushBox(ctx, s, ax, ax + parenWidth * 2 + sm.adv(glyph), y - box.y1 - 0.1, y - box.y0 + 0.1, true);
    } else {
      prims.push({ t: 'glyph', name: glyph, x: ax, y });
      const box = sm.bbox(glyph);
      pushBox(ctx, s, ax + box.x0, ax + box.x1, y - box.y1 - 0.1, y - box.y0 + 0.1, true);
    }
  }
  tagFrom(prims, accStart, 'acc', e);
  for (let i = accStart; i < prims.length; i++) prims[i].n = hi;
}

/**
 * Ledger lines, one per staff line crossed. A line is needed where a head sits on it or beyond it (not
 * for the space just outside the staff) and extends over those heads only (not over displaced heads of
 * the rest of the chord); `trimLedgers` later shortens neighbouring ones so that they do not run together.
 */
function drawLedgerLines(ctx: SysCtx, e: EvL, s: number): void {
  const own = e.heads.filter((h) => !h.shared);
  if (!own.length) return;
  const ledgerExt = D.legerLineExtension as number;
  const hw = headWidth(e.te.ev.dur.base);
  const posMin = Math.min(...own.map((h) => h.pos));
  const posMax = Math.max(...own.map((h) => h.pos));
  const ledger = (p: number, reach: typeof own) => {
    const d0 = Math.min(...reach.map((h) => h.dx));
    const d1 = Math.max(...reach.map((h) => h.dx));
    const lx0 = e.x + d0 - ledgerExt;
    const lx1 = e.x + d1 + hw + ledgerExt;
    const prim: Prim = { t: 'line', x1: lx0, x2: lx1, y1: posToY(p), y2: posToY(p), w: D.legerLineThickness as number };
    prim.k = 'ledger';
    prim.o = oid(e);
    prim.r = e.ev;
    ctx.prims[s].push(prim);
    ledgerSegs.push({ prim, s, y: posToY(p), x0: lx0, x1: lx1, hx0: e.x + d0, hx1: e.x + d1 + hw });
  };
  for (let p = -2; p >= posMin; p -= 2)
    ledger(
      p,
      own.filter((h) => h.pos <= p + 1),
    );
  for (let p = 10; p <= posMax; p += 2)
    ledger(
      p,
      own.filter((h) => h.pos >= p - 1),
    );
}

/** Dots: to the right of the heads, in the space above when the head sits on a line, one set per staff position (a chord with two heads sharing a position gets one set). */
function drawDots(ctx: SysCtx, e: EvL, s: number): void {
  const dots = e.te.ev.dur.dots;
  const start = ctx.prims[s].length;
  if (dots) {
    const x = e.x + Math.max(...e.heads.map((h) => h.dx)) + headWidth(e.te.ev.dur.base) + 0.4;
    const seen = new Set<number>();
    for (const h of e.heads) {
      if (h.shared && h.skipDots) continue;
      const p = h.pos % 2 === 0 ? h.pos + 1 : h.pos; // Dots go in the space above a line.
      if (seen.has(p)) continue;
      seen.add(p);
      for (let k = 0; k < dots; k++)
        ctx.prims[s].push({ t: 'glyph', name: 'augmentationDot', x: x + k * DOT_STEP, y: posToY(p) });
    }
  }
  tagFrom(ctx.prims[s], start, 'dot', e);
}

/** Arpeggio: a vertical wiggle left of the chord's accidentals, spanning from the lowest to the highest head. */
function drawArpeggio(ctx: SysCtx, e: EvL, s: number, yTop: number, yBot: number): void {
  const prims = ctx.prims[s];
  const minDx = Math.min(...e.heads.map((h) => h.dx));
  const accMin = Math.min(0, ...e.heads.map((h) => h.accX ?? 0), minDx);
  const right = e.x + accMin - 0.3;
  const seg = sm.bbox('wiggleArpeggiatoUp');
  const step = sm.adv('wiggleArpeggiatoUp');
  const top = yTop - 0.4;
  const bot = yBot + 0.4;
  const n = Math.max(1, Math.ceil((bot - top) / step));
  const w = seg.y1 - seg.y0;
  // The SMuFL glyph is a short horizontal wiggle: rotate it 90 degrees and stack as many
  // copies as needed upwards from the bottom note.
  const start = prims.length;
  for (let k = 0; k < n; k++)
    prims.push({ t: 'glyph', name: 'wiggleArpeggiatoUp', x: right, y: bot - k * step + seg.x0, rot: -90 });
  tagFrom(prims, start, 'arpeggio', e);
  pushBox(ctx, s, right - w, right, top - 0.2, bot + 0.2);
}

/** Heads, accidentals, ledger lines, dots and arpeggio of a note; records its geometry (`geomOf`) for the later phases. */
function drawNoteBasics(ctx: SysCtx, e: EvL, s: number): void {
  const hw = headWidth(e.te.ev.dur.base);
  const ys = e.heads.map((h) => posToY(h.pos));
  const yTop = Math.min(...ys);
  const yBot = Math.max(...ys);
  const minDx = Math.min(...e.heads.map((h) => h.dx));
  const maxDx = Math.max(...e.heads.map((h) => h.dx));
  e.heads.forEach((h, hi) => {
    if (!h.shared) drawHeadWithAccidental(ctx, e, s, hi);
  });
  drawLedgerLines(ctx, e, s);
  drawDots(ctx, e, s);
  // Stem anchors at the head edge (an up-stem leaves the right side of the head, a down-stem the left side).
  const g: Geom = {
    shift: e.shiftDx,
    x: e.x,
    hw,
    yTop,
    yBot,
    stemX: e.stem === 'up' ? e.x + e.shiftDx + hw - STEM_T / 2 : e.x + e.shiftDx + STEM_T / 2,
    stemTip: 0,
    stemBase: e.stem === 'up' ? yBot - 0.168 * HEAD_SCALE : yTop + 0.168 * HEAD_SCALE,
    headL: e.x + minDx,
    headR: e.x + maxDx + hw,
  };
  geomOf.set(e, g);
  const dots = e.te.ev.dur.dots;
  pushBox(ctx, s, g.headL, g.headR + (dots ? 0.4 + DOT_STEP * dots : 0), yTop - 0.5, yBot + 0.5);
  if (e.stem === null) g.stemTip = g.stemBase;
  if (e.ev.kind === 'note' && e.ev.arpeggio) drawArpeggio(ctx, e, s, yTop, yBot);
}

const GRACE_STEM = 0.1;
const GRACE_STEM_LENGTH = 2.7;

/** What the drawing of the grace notes of one event shares. */
interface GraceDrawing {
  ctx: SysCtx;
  s: number;
  e: EvL;
  graces: NonNullable<EvL['graces']>;
  /** For each grace note, the object shared by the members of its beamed run (undefined for lone notes, which get flags). */
  runOf: (object | undefined)[];
}

/** Where a grace note is: its head x, stem x, extent and where its stem ends. */
interface GraceGeom {
  yTop: number;
  yBot: number;
  x: number;
  stemX: number;
  tip: number;
}

/** Runs of beamed grace notes: consecutive ones of eighth length or shorter, at least two. */
function graceRuns(graces: GraceDrawing['graces']): (object | undefined)[] {
  const runOf: (object | undefined)[] = [];
  for (let i = 0; i < graces.length; ) {
    let j = i;
    while (j < graces.length && graces[j].g.base >= 8) j++;
    if (j - i >= 2) {
      const run = {};
      for (let k = i; k < j; k++) runOf[k] = run;
      i = j;
    } else i = Math.max(j, i + 1);
  }
  return runOf;
}

/** Tags the prims drawn since `from` as part of grace note `i`. */
function tagGrace(
  d: GraceDrawing,
  from: number,
  kind: 'head' | 'acc' | 'ledger' | 'stem' | 'flag' | 'beam',
  i: number,
) {
  const prims = d.ctx.prims[d.s];
  tagFrom(prims, from, kind, d.graces[i].g, d.runOf[i] ? [d.runOf[i]] : undefined);
  for (let q = from; q < prims.length; q++) prims[q].r = d.e.ev;
}

/** Heads, accidentals and ledger lines of grace note `i`. */
function drawGraceHeads(d: GraceDrawing, i: number): GraceGeom {
  const { ctx, s, e } = d;
  const prims = ctx.prims[s];
  const gl = d.graces[i];
  const GS = GRACE_SCALE;
  const ledgerExt = (D.legerLineExtension as number) * GS;
  const ys = gl.heads.map((h) => posToY(h.pos));
  const yTop = Math.min(...ys);
  const yBot = Math.max(...ys);
  const x = e.x + gl.dx;
  for (const h of gl.heads) {
    const n0 = prims.length;
    prims.push({ t: 'glyph', name: headGlyph(gl.g.base), x, y: posToY(h.pos), sx: HEAD_SCALE * GS, sy: GS });
    tagGrace(d, n0, 'head', i);
    if (!h.acc) continue;
    const n1 = prims.length;
    const ax = e.x + must(h.accX);
    prims.push({ t: 'glyph', name: h.acc.glyph, x: ax, y: posToY(h.pos), sx: GS, sy: GS });
    tagGrace(d, n1, 'acc', i);
    const box = sm.bbox(h.acc.glyph);
    pushBox(
      ctx,
      s,
      ax + box.x0 * GS,
      ax + box.x1 * GS,
      posToY(h.pos) - box.y1 * GS - 0.1,
      posToY(h.pos) - box.y0 * GS + 0.1,
      true,
    );
  }
  const ledger = (p: number) => {
    const n0 = prims.length;
    const prim: Prim = {
      t: 'line',
      x1: x - ledgerExt,
      x2: x + gl.hw + ledgerExt,
      y1: posToY(p),
      y2: posToY(p),
      w: D.legerLineThickness as number,
    };
    prims.push(prim);
    tagGrace(d, n0, 'ledger', i);
    ledgerSegs.push({ prim, s, y: posToY(p), x0: x - ledgerExt, x1: x + gl.hw + ledgerExt, hx0: x, hx1: x + gl.hw });
  };
  const posMin = Math.min(...gl.heads.map((h) => h.pos));
  const posMax = Math.max(...gl.heads.map((h) => h.pos));
  for (let p = -2; p >= posMin; p -= 2) ledger(p);
  for (let p = 10; p <= posMax; p += 2) ledger(p);
  return { yTop, yBot, x, stemX: x + gl.hw - GRACE_STEM / 2, tip: Math.min(yTop - GRACE_STEM_LENGTH, 2) };
}

/** Draws the stem of grace note `i` up to `tip` (nothing for whole and half notes). */
function drawGraceStem(d: GraceDrawing, geo: GraceGeom[], i: number, tip: number): void {
  if (d.graces[i].g.base < 2) return;
  const prims = d.ctx.prims[d.s];
  const g = geo[i];
  const n0 = prims.length;
  prims.push({ t: 'line', x1: g.stemX, y1: g.yBot - 0.168 * GRACE_SCALE, x2: g.stemX, y2: tip, w: GRACE_STEM });
  tagGrace(d, n0, 'stem', i);
}

/** A lone grace note: its stem and flag. */
function drawGraceWithFlag(d: GraceDrawing, geo: GraceGeom[], i: number): void {
  const base = d.graces[i].g.base;
  drawGraceStem(d, geo, i, geo[i].tip);
  if (base < 8) return;
  const n = beamLevels(base);
  const name = flagGlyph(n, true);
  const prims = d.ctx.prims[d.s];
  const n0 = prims.length;
  prims.push({ t: 'glyph', name, x: geo[i].stemX - GRACE_STEM / 2, y: geo[i].tip, sx: GRACE_SCALE, sy: GRACE_SCALE });
  tagGrace(d, n0, 'flag', i);
}

/** A run of beamed grace notes i..j-1: the stems end at the highest tip; beams are drawn per level (a primary beam over the whole run, secondary ones for the faster notes). */
function drawGraceRun(d: GraceDrawing, geo: GraceGeom[], i: number, j: number): void {
  const prims = d.ctx.prims[d.s];
  const thickness = (D.beamThickness as number) * 0.8;
  const spacing = (D.beamSpacing as number) * 0.8;
  const levelOf = (k: number) => beamLevels(d.graces[k].g.base);
  const tip = Math.min(...geo.slice(i, j).map((g) => g.tip));
  for (let k = i; k < j; k++) drawGraceStem(d, geo, k, tip);
  const maxLevel = Math.max(...d.graces.slice(i, j).map((_, k) => levelOf(i + k)));
  for (let level = 1; level <= maxLevel; level++) {
    const y0 = tip + (level - 1) * (thickness + spacing);
    let a = i;
    while (a < j) {
      if (levelOf(a) < level) {
        a++;
        continue;
      }
      let b = a;
      while (b + 1 < j && levelOf(b + 1) >= level) b++;
      // A lone note of this level gets a hook towards the rest of the run.
      let xa: number;
      let xb: number;
      if (b > a) {
        xa = geo[a].stemX - GRACE_STEM / 2;
        xb = geo[b].stemX + GRACE_STEM / 2;
      } else if (a === i) {
        xa = geo[a].stemX - GRACE_STEM / 2;
        xb = geo[a].stemX + 0.8;
      } else {
        xa = geo[a].stemX - 0.8;
        xb = geo[a].stemX + GRACE_STEM / 2;
      }
      const n0 = prims.length;
      prims.push({
        t: 'path',
        d: `M${xa.toFixed(3)} ${y0.toFixed(3)}L${xb.toFixed(3)} ${y0.toFixed(3)}L${xb.toFixed(3)} ${(y0 + thickness).toFixed(3)}L${xa.toFixed(3)} ${(y0 + thickness).toFixed(3)}Z`,
      });
      tagGrace(d, n0, 'beam', a);
      a = b + 1;
    }
  }
}

/** The slash of an acciaccatura runs through the stem of the first note of its run (or the lone note). For a run, the tip is taken from the whole run, so that the slash lies on its stems. */
function drawGraceSlashes(d: GraceDrawing, geo: GraceGeom[]): void {
  const { graces, runOf } = d;
  for (let i = 0; i < graces.length; i++) {
    if (!graces[i].g.slash || graces[i].g.base < 8 || (runOf[i] && runOf[i] === runOf[i - 1])) continue;
    const g = geo[i];
    let tip = g.tip;
    if (runOf[i]) {
      let j = i;
      while (runOf[j + 1] === runOf[i]) j++;
      tip = Math.min(...geo.slice(i, j + 1).map((q) => q.tip));
    }
    const prims = d.ctx.prims[d.s];
    const n0 = prims.length;
    prims.push({ t: 'line', x1: g.stemX - 0.9, y1: tip + 1.9, x2: g.stemX + 1.0, y2: tip + 0.5, w: 0.1 });
    tagGrace(d, n0, 'stem', i);
  }
}

/** Grace notes: small heads with their own up-stems, a flag or beams, and a slash for an acciaccatura. */
function drawGraces(ctx: SysCtx, e: EvL, s: number): void {
  const graces = must(e.graces);
  const d: GraceDrawing = { ctx, s, e, graces, runOf: graceRuns(graces) };
  const geo = graces.map((_, i) => drawGraceHeads(d, i));
  // Stems first, then flags for lone notes or beams for runs.
  for (let i = 0; i < graces.length; ) {
    const run = d.runOf[i];
    if (!run) {
      drawGraceWithFlag(d, geo, i);
      i++;
      continue;
    }
    let j = i;
    while (j < graces.length && d.runOf[j] === run) j++;
    drawGraceRun(d, geo, i, j);
    i = j;
  }
  drawGraceSlashes(d, geo);
  const top = Math.min(...geo.map((g) => g.tip));
  const bot = Math.max(...geo.map((g) => g.yBot));
  pushBox(ctx, s, Math.min(...geo.map((g) => g.x)) - 0.3, e.x - 0.2, top - 0.3, bot + 0.5);
}

/** Draws a rest on staff `s` and tags it. A `ghost` rest is the faint editor placeholder of a hidden rest. */
function drawRest(ctx: SysCtx, e: EvL, s: number, ghost = false): void {
  const n0 = ctx.prims[s].length;
  drawRestPrims(ctx, e, s, ghost);
  tagFrom(ctx.prims[s], n0, 'rest', e);
  if (ghost) for (let i = n0; i < ctx.prims[s].length; i++) ctx.prims[s][i].ghost = true;
}

/**
 * A multi-measure rest: a thick bar with a short vertical stroke at each end across the middle of the
 * staff, from the first column to just before the barline, and the number of measures above the staff.
 */
function drawMultiRest(ctx: SysCtx, e: EvL, s: number, count: number): void {
  const sp = ctx.spacing[e.mi];
  const endX = ctx.placed[e.mi].endX;
  const right = sp.endClef[s] ? endX - sm.adv('gClefChange') - 2 * END_CLEF_GAP : endX;
  const x0 = ctx.mx[e.mi] + sp.lead;
  const x1 = ctx.mx[e.mi] + right - 1.2; // This leaves room for a final or double barline.
  const cx = (x0 + x1) / 2;
  const P = ctx.prims[s];
  P.push({ t: 'line', x1: x0, x2: x1, y1: 2, y2: 2, w: 1 });
  for (const x of [x0, x1]) P.push({ t: 'line', x1: x, x2: x, y1: 1, y2: 3, w: 0.16 });
  pushBox(ctx, s, x0, x1, 1, 3);
  const digits = [...String(count)].map((d) => `timeSig${d}`);
  const total = digits.reduce((a, d) => a + sm.adv(d), 0);
  let x = cx - total / 2;
  for (const d of digits) {
    P.push({ t: 'glyph', name: d, x, y: -1.6 });
    x += sm.adv(d);
  }
  pushBox(ctx, s, cx - total / 2, cx + total / 2, -2.7, -0.5);
}

/**
 * The primitives of a rest: a multi-measure rest, a whole-measure rest centred in the bar, or the rest glyph with
 * its dots.
 */
function drawRestPrims(ctx: SysCtx, e: EvL, s: number, ghost: boolean): void {
  const run = e.ev.kind === 'rest' && e.ev.style === 'measure' ? ctx.prep.multi?.get(e.mi) : undefined;
  if (run) {
    drawMultiRest(ctx, e, s, run);
    return;
  }
  const base = e.te.ev.dur.base;
  const name = restGlyph(base, e.ev.kind === 'rest' && e.ev.style === 'measure');
  let y = base === 1 || (e.ev.kind === 'rest' && e.ev.style === 'measure') ? 1 : 2;
  if (e.ev.kind === 'rest' && e.ev.display) {
    const clef = e.clef;
    y = posToY(staffPos(e.ev.display, clef));
  } else if (e.nVoices > 1) {
    y += e.voiceRank === 0 ? -1.5 : 1.5;
    // Keep clear of the heads (and accidentals) of the other voices sounding at the same time: step
    // away from the voice's default row, one space at a time, until nothing is in the way.
    const rb = sm.bbox(name);
    const others = ctx.prep.measures[e.mi][s].evs.filter(
      (o) => o.ev.kind === 'note' && o.voice !== e.voice && o.start < e.start + e.ticks && e.start < o.start + o.ticks,
    );
    const hits = (yy: number) =>
      others.some((o) =>
        o.heads.some((h) => {
          const hy = posToY(h.pos);
          const r = h.acc ? 1.6 : 0.75;
          return hy + r > yy - rb.y1 && hy - r < yy - rb.y0;
        }),
      );
    const stepDir = e.voiceRank === 0 ? -1 : 1;
    for (let k = 0; k < 8 && hits(y); k++) y += stepDir;
  }
  ctx.prims[s].push({ t: 'glyph', name, x: e.x, y });
  const b = sm.bbox(name);
  if (!ghost) pushBox(ctx, s, e.x, e.x + b.x1, y - b.y1, y - b.y0);
  const dots = e.te.ev.dur.dots;
  for (let k = 0; k < dots; k++)
    ctx.prims[s].push({ t: 'glyph', name: 'augmentationDot', x: e.x + b.x1 + 0.4 + k * DOT_STEP, y: y - 0.5 });
  // Rests with a display pitch far outside the staff would need ledger lines of their own.
  // That case is not handled: such rests are drawn without them.
}

// Beams: slope and position of a group's beam line, its levels and stubs, and moving the line clear
// of other things. Stems are shortened or lengthened to meet it.
/** The beam line y = a + m (x - x0) of a group, before it is moved clear of other things. */
interface BeamLine {
  a: number;
  m: number;
  x0: number;
  x1: number;
}

const BEAM_MAX_TILT = 1.25;

/** Height of the stack of all beam levels of a group (from the primary beam's outer edge to the last level's). */
const beamStackHeight = (maxLevel: number) =>
  (maxLevel - 1) * ((D.beamThickness as number) + (D.beamSpacing as number)) + (D.beamThickness as number);

/** The beam line through the stem tips, tilted like the tips but at most half as much and by `BEAM_MAX_TILT`, moved out to the farthest tip. */
function beamLineThroughTips(gs: Geom[], up: boolean, stemLen: number): BeamLine {
  const x0 = gs[0].stemX;
  const x1 = gs[gs.length - 1].stemX;
  const tips = gs.map((g) => (up ? g.yTop - stemLen : g.yBot + stemLen));
  const rise = tips[tips.length - 1] - tips[0];
  const m = (Math.sign(rise) * Math.min(Math.abs(rise) * 0.5, BEAM_MAX_TILT)) / Math.max(0.001, x1 - x0);
  let a = up ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  gs.forEach((g, i) => {
    const v = tips[i] - m * (g.stemX - x0);
    a = up ? Math.min(a, v) : Math.max(a, v);
  });
  return { a, m, x0, x1 };
}

/**
 * Moves the beam line away from the staff until it clears: the noteheads of other voices underneath
 * (or above) the beam, accidentals of any note (including the group's own) which must stay 0.4 clear
 * of the outer beam, and the middle line (stems pointing at the staff reach at least position 2,
 * which keeps beams off the ledger lines of notes far above or below the staff).
 */
function clearBeamLine(ctx: SysCtx, notes: EvL[], s: number, gs: Geom[], line: BeamLine, up: boolean, maxLv: number) {
  const { m, x0, x1 } = line;
  let a = line.a;
  const pull = (v: number) => {
    a = up ? Math.min(a, v) : Math.max(a, v);
  };
  const inner = beamStackHeight(maxLv);
  const evs = ctx.prep.measures[notes[0].mi][s].evs;
  for (const o of evs) {
    if (o.ev.kind !== 'note' || notes.includes(o)) continue;
    const go = geomOf.get(o);
    if (!go || go.headR < x0 - 0.5 || go.headL > x1 + 0.5) continue;
    const xc = (go.headL + go.headR) / 2;
    pull(up ? go.yTop - 0.9 - inner - m * (xc - x0) : go.yBot + 0.9 + inner - m * (xc - x0));
  }
  for (const o of evs) {
    if (o.ev.kind !== 'note') continue;
    for (const h of o.heads) {
      if (!h.acc || h.shared) continue;
      const box = sm.bbox(h.acc.glyph);
      const ax0 = o.x + must(h.accX) + box.x0;
      const ax1 = o.x + must(h.accX) + box.x1;
      if (ax1 < x0 - 0.3 || ax0 > x1 + 0.3) continue;
      const xc = (ax0 + ax1) / 2;
      const yc = posToY(h.pos);
      pull(up ? yc - box.y1 - 0.4 - inner - m * (xc - x0) : yc - box.y0 + 0.4 + inner - m * (xc - x0));
    }
  }
  for (const g of gs) pull(2 - m * (g.stemX - x0));
  return { ...line, a };
}

/** Does the lone note `i` of a beam get its hook (the short stub of a level only it has) to the right? Towards the neighbour it is rhythmically closer to; after a dotted note, towards the left. */
function hookPointsRight(notes: EvL[], i: number): boolean {
  if (i === 0) return true;
  if (i === notes.length - 1) return false;
  if (notes[i + 1].start - notes[i].start < notes[i].start - notes[i - 1].start) return true;
  return !(notes[i - 1].te.ev.dur.dots > 0);
}

/** Draws one beam group on staff `s` (stems, beam polygons, hooks for lone short notes) and records its skyline. */
function drawBeamGroup(ctx: SysCtx, notes: EvL[], s: number, levelsFor: (e: EvL) => number): void {
  const up = must(notes[0].beam).dir === 'up';
  const maxLv = Math.max(...notes.map(levelsFor));
  const gs = notes.map((n) => must(geomOf.get(n)));
  // Every note's stem uses the beam's direction, anchored at the proper side of its chord
  // (right of the heads for up-stems, left for down-stems).
  for (const g of gs) {
    g.stemX = up ? g.x + g.shift + g.hw - STEM_T / 2 : g.x + g.shift + STEM_T / 2;
    g.stemBase = up ? g.yBot - 0.168 : g.yTop + 0.168;
  }
  const line = clearBeamLine(ctx, notes, s, gs, beamLineThroughTips(gs, up, stemLength(maxLv)), up, maxLv);
  const lineY = (x: number) => line.a + line.m * (x - line.x0);
  const thickness = D.beamThickness as number;
  const spacing = D.beamSpacing as number;
  const inward = up ? 1 : -1;
  notes.forEach((n, i) => {
    gs[i].stemTip = lineY(gs[i].stemX);
    drawStem(ctx, n, gs[i], s, false);
  });
  /**
   * Beam polygons: one parallelogram per beam level and run of notes that has that level, offset
   * from the primary beam by `beamSpacing`; the shorter levels may end in a hook.
   */
  const poly = (xa: number, xb: number, off: number) => {
    const ya = lineY(xa) + inward * off;
    const yb = lineY(xb) + inward * off;
    return `M${xa.toFixed(3)} ${ya.toFixed(3)}L${xb.toFixed(3)} ${yb.toFixed(3)}L${xb.toFixed(3)} ${(yb + inward * thickness).toFixed(3)}L${xa.toFixed(3)} ${(ya + inward * thickness).toFixed(3)}Z`;
  };
  const firstBeamPrim = ctx.prims[s].length;
  const hookLength = 1.1;
  for (let level = 1; level <= maxLv; level++) {
    const off = (level - 1) * (thickness + spacing);
    let i = 0;
    while (i < notes.length) {
      if (levelsFor(notes[i]) < level) {
        i++;
        continue;
      }
      let j = i;
      while (
        j + 1 < notes.length &&
        levelsFor(notes[j + 1]) >= level &&
        !restBetween(notes[j], notes[j + 1], must(notes[0].beam).evs)
      )
        j++;
      if (j > i) ctx.prims[s].push({ t: 'path', d: poly(gs[i].stemX - STEM_T / 2, gs[j].stemX + STEM_T / 2, off) });
      else {
        const toRight = hookPointsRight(notes, i);
        const xa = toRight ? gs[i].stemX - STEM_T / 2 : gs[i].stemX - hookLength;
        const xb = toRight ? gs[i].stemX + hookLength : gs[i].stemX + STEM_T / 2;
        ctx.prims[s].push({ t: 'path', d: poly(xa, xb, off) });
      }
      i = j + 1;
    }
  }
  tagFrom(ctx.prims[s], firstBeamPrim, 'beam', notes[0].beam);
  // Skyline: the beam's extent per pair of stems, since a slanted beam occupies a trapezoid, not
  // a box; one box per pair keeps the over-approximation small.
  const inner = beamStackHeight(maxLv);
  for (let i = 0; i + 1 < gs.length; i++) {
    const ya = lineY(gs[i].stemX);
    const yb = lineY(gs[i + 1].stemX);
    pushBox(
      ctx,
      s,
      gs[i].stemX,
      gs[i + 1].stemX,
      Math.min(ya, yb) - (up ? 0 : inner),
      Math.max(ya, yb) + (up ? inner : 0),
    );
  }
}

/** Whether a rest lies between events `a` and `b` of the beam group `all`. */
function restBetween(a: EvL, b: EvL, all: EvL[]): boolean {
  const ia = all.indexOf(a);
  const ib = all.indexOf(b);
  for (let k = ia + 1; k < ib; k++) if (all[k].ev.kind === 'rest') return true;
  return false;
}

/** Draws the beams between the two notes of a tremolo pair `e1` and `e2` on staff `s`. */
function drawTremoloPair(ctx: SysCtx, e1: EvL, e2: EvL, s: number): void {
  const up = e1.stem === 'up';
  const g1 = must(geomOf.get(e1));
  const g2 = must(geomOf.get(e2));
  const L = 3.5;
  for (const [e, g] of [
    [e1, g1],
    [e2, g2],
  ] as [EvL, Geom][]) {
    g.stemX = up ? g.x + g.shift + g.hw - STEM_T / 2 : g.x + g.shift + STEM_T / 2;
    g.stemBase = up ? g.yBot - 0.168 : g.yTop + 0.168;
    setStem(e, g, L);
  }
  // The beams must clear accidentals of the notes between the stems: lengthen the stems (move
  // the tips away from the heads) until the beam stack is clear of every accidental.
  {
    const nb = e1.tremBeams ?? 2;
    const inner0 = (nb - 1) * ((D.beamThickness as number) + (D.beamSpacing as number)) + (D.beamThickness as number);
    for (const e of [e1, e2]) {
      for (const h of e.heads) {
        if (!h.acc || h.shared) continue;
        const ab = sm.bbox(h.acc.glyph);
        const yc = posToY(h.pos);
        const lim = up ? yc - ab.y1 - 0.4 - inner0 : yc - ab.y0 + 0.4 + inner0;
        for (const q of [g1, g2]) q.stemTip = up ? Math.min(q.stemTip, lim) : Math.max(q.stemTip, lim);
      }
    }
  }
  // The beams run from stem end to stem end, so the tilt follows the tips. It is limited to
  // `maxTilt` like ordinary beams, by lengthening the stem that would otherwise fall short.
  const maxTilt = 1.0;
  if (up) {
    const hi = Math.min(g1.stemTip, g2.stemTip);
    g1.stemTip = Math.min(g1.stemTip, hi + maxTilt);
    g2.stemTip = Math.min(g2.stemTip, hi + maxTilt);
  } else {
    const lo = Math.max(g1.stemTip, g2.stemTip);
    g1.stemTip = Math.max(g1.stemTip, lo - maxTilt);
    g2.stemTip = Math.max(g2.stemTip, lo - maxTilt);
  }
  drawStem(ctx, e1, g1, s, false);
  drawStem(ctx, e2, g2, s, false);
  const bt = D.beamThickness as number;
  const bs = D.beamSpacing as number;
  const inward = up ? 1 : -1;
  const n = e1.tremBeams ?? 2;
  const DETACH = 0.3; // Tremolo beams stop short of the stems so that they read differently from ordinary beams.
  const xa = g1.stemX + STEM_T / 2 + DETACH;
  const xb = g2.stemX - STEM_T / 2 - DETACH;
  const slopeAt = (x: number) =>
    g1.stemTip + ((g2.stemTip - g1.stemTip) * (x - g1.stemX)) / Math.max(0.001, g2.stemX - g1.stemX);
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  const nTr = ctx.prims[s].length;
  for (let k = 0; k < n; k++) {
    const off = k * (bt + bs);
    const ya = slopeAt(xa) + inward * off;
    const yb = slopeAt(xb) + inward * off;
    const d = `M${xa.toFixed(3)} ${ya.toFixed(3)}L${xb.toFixed(3)} ${yb.toFixed(3)}L${xb.toFixed(3)} ${(yb + inward * bt).toFixed(3)}L${xa.toFixed(3)} ${(ya + inward * bt).toFixed(3)}Z`;
    ctx.prims[s].push({ t: 'path', d });
    yMin = Math.min(yMin, ya, yb, ya + inward * bt, yb + inward * bt);
    yMax = Math.max(yMax, ya, yb, ya + inward * bt, yb + inward * bt);
  }
  tagFrom(ctx.prims[s], nTr, 'beam', e1);
  pushBox(ctx, s, xa, xb, yMin, yMax);
}

// Tuplets: the bracket and number over (or under) the members of a tuplet group. Their position
// follows the beam if the group is beamed and the stems otherwise.
/** Draws the bracket and/or number of a tuplet over (or under) its member events `evs`. */
function drawTuplet(ctx: SysCtx, t: TupletGroup, evs: EvL[], s: number): void {
  const n0 = ctx.prims[s].length;
  drawTupletPrims(ctx, t, evs, s);
  tagFrom(ctx.prims[s], n0, 'tuplet', t);
}

/** Where a tuplet's bracket and number go: the bracket line from (bx0, ya) to (bx1, yb) in the slope of (x0, ya)-(x1, yb), the number centred at (cx, cy). */
interface TupletPlan {
  bracket: boolean;
  showNum: boolean;
  above: boolean;
  label: string;
  ya: number;
  yb: number;
  x0: number;
  x1: number;
  bx0: number;
  bx1: number;
  cx: number;
  cy: number;
  /** The number sits on staff lines: it gets an opaque box with a border so that it stays readable. */
  box: boolean;
}

/** What the placement of a tuplet's line is computed from. */
interface TupletFrame {
  above: boolean;
  evs: EvL[];
  notes: EvL[];
  /** Per member: how far its stem, beam, heads and attachments reach on the tuplet's side. */
  reach: number[];
  /** Per member: x of its stem (rests: their x). */
  stemXs: number[];
  /** x of the first and last member's stem. */
  x0: number;
  x1: number;
  /** A beam between two staves: the number goes on top of it. */
  crossBeam: boolean;
}

/** Whether staff-local y is within `tolerance` of one of the five staff lines. */
const touchesStaffLine = (y: number, tolerance: number) => [0, 1, 2, 3, 4].some((l) => Math.abs(l - y) < tolerance);

const TUPLET_NUMBER_SIZE = 1.8;
const MAX_TUPLET_SLOPE = 0.5;

/** How far each member reaches on the chosen side: stems, beams and heads, and anything attached to the note (accidentals, articulations; only a note's own accidentals reach to its left). */
function tupletReach(ctx: SysCtx, evs: EvL[], geoms: (Geom | null)[], above: boolean, s: number): number[] {
  const sky = ctx.sky[s];
  return evs.map((e, i) => {
    const g = geoms[i];
    if (!g) return above ? 1.5 : 2.5;
    const stemSide = e.stem === (above ? 'up' : 'down');
    const base = above
      ? stemSide
        ? Math.min(g.stemTip, g.yTop - 0.5)
        : g.yTop - 0.5
      : stemSide
        ? Math.max(g.stemTip, g.yBot + 0.5)
        : g.yBot + 0.5;
    // Whatever the skyline holds at this note's position (accidentals, articulations, ...),
    // so that the bracket also clears what is attached to the note and not only the note.
    const lx = g.headL - (e.heads.some((h) => h.acc) ? 1.6 : 0.2);
    const other = above
      ? sky.top(lx, g.headR, Number.POSITIVE_INFINITY)
      : sky.bottom(lx, g.headR, Number.NEGATIVE_INFINITY);
    return above ? Math.min(base, other) : Math.max(base, other);
  });
}

/**
 * The slope of the beams of a tuplet made of beam groups or tremolo pairs: with several groups their
 * slopes are averaged, weighted by length, so a tuplet made of two beamed halves still gets one
 * straight bracket. Undefined if there is no usable beam.
 */
function beamSlopeOf(notes: EvL[]): number | undefined {
  const groups = new Map<object, EvL[]>();
  for (const n of notes) {
    const key = n.beam ?? (n.tremPair ? (n.tremIsFirst ? n : n.tremPair) : undefined);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(n);
    groups.set(key, list);
  }
  let weighted = 0;
  let length = 0;
  for (const list of groups.values()) {
    const ga = must(geomOf.get(list[0]));
    const gb = must(geomOf.get(list[list.length - 1]));
    const dx = gb.stemX - ga.stemX;
    if (list.length > 1 && dx > 0.5 && !list[0].beam?.cross) {
      weighted += ((gb.stemTip - ga.stemTip) / dx) * dx;
      length += dx;
    }
  }
  return length > 0 ? weighted / length : undefined;
}

/**
 * Over a cross-staff beam the bracket rises or falls with the notes themselves, whatever else stands
 * near its ends: the slope through the heads of the upper staff. The notes of the lower staff are on
 * the other side of the beam and say nothing about it.
 */
function crossBeamHeadSlope(notes: EvL[], above: boolean): number {
  const topStaff = Math.min(...notes.map((n) => n.staff));
  const on = notes.filter((n) => n.staff === topStaff);
  const ga = must(geomOf.get(on[0]));
  const gb = must(geomOf.get(on[on.length - 1]));
  const dx = gb.x - ga.x;
  return dx > 0.5 ? (above ? gb.yTop - ga.yTop : gb.yBot - ga.yBot) / dx : 0;
}

/** The line of the given slope that clears every member (`a` is its y at x0), and `gap`: how far it stays from what it clears, summed over the notes and the two ends (the smaller the closer the bracket hugs the notes). */
function fitTupletLine(f: TupletFrame, slope: number): { a: number; gap: number } {
  const { above, evs, reach, stemXs, x0, x1 } = f;
  let a = above ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  evs.forEach((_, i) => {
    const v = reach[i] - slope * (stemXs[i] - x0);
    a = above ? Math.min(a, v) : Math.max(a, v);
  });
  const end = Math.min(...reach);
  const pts = [...evs.map((_, i) => ({ x: stemXs[i], e: reach[i] })), { x: x0, e: end }, { x: x1, e: end }];
  if (!above) for (const q of pts) q.e = Math.max(...reach);
  let gap = 0;
  for (const q of pts) gap += Math.abs(q.e - (a + slope * (q.x - x0)));
  return { a, gap };
}

/**
 * The bracket line (y at x0 and at x1) of a sloped tuplet: parallel to the beams when there are any;
 * over a cross-staff beam it follows the heads, but only as far as keeps it close to them (ten
 * slopes from the heads' slope down to flat are tried, the one with the smallest gap wins);
 * otherwise through the reach of the first and last member.
 */
function slopedTupletLine(f: TupletFrame, clearance: number): { ya: number; yb: number } {
  const { above, notes, reach, x0, x1, crossBeam } = f;
  const m =
    beamSlopeOf(notes) ??
    (crossBeam ? crossBeamHeadSlope(notes, above) : (reach[reach.length - 1] - reach[0]) / (x1 - x0));
  const headSlope = Math.max(-MAX_TUPLET_SLOPE, Math.min(MAX_TUPLET_SLOPE, m));
  let slope = headSlope;
  let best = fitTupletLine(f, slope);
  if (crossBeam)
    for (let k = 1; k <= 10; k++) {
      const candidate = (headSlope * (10 - k)) / 10;
      const fit = fitTupletLine(f, candidate);
      if (fit.gap < best.gap - 1e-6) {
        best = fit;
        slope = candidate;
      }
    }
  const ya = best.a + (above ? -clearance : clearance);
  return { ya, yb: ya + slope * (x1 - x0) };
}

/**
 * Works out where the bracket and number of a tuplet go, on `forceSide` if given. A number in a bracket
 * that staff lines run through gets a box (`box`).
 */
function planTuplet(
  ctx: SysCtx,
  t: TupletGroup,
  evs: EvL[],
  s: number,
  forceSide: 'above' | 'below' | undefined,
): TupletPlan | undefined {
  if (!evs.length) return;
  const showNum = t.number !== 'none';
  const notes = evs.filter((e) => e.ev.kind === 'note');
  const beamSets = new Set(notes.map((n) => n.beam));
  const fullyBeamed = notes.length > 0 && beamSets.size === 1 && !beamSets.has(undefined);
  let bracket = t.bracket ?? !fullyBeamed;
  if (notes[0]?.beam?.cross && t.bracket !== false) bracket = true; // The number alone would be lost among the stems of a beam between the staves.
  if (!(showNum || bracket)) return;
  const anchor = notes[0] ?? evs[0];
  const crossY = notes[0]?.beam?.crossY;
  const side = forceSide ?? t.placement ?? (crossY ? 'above' : anchor.stem === 'down' ? 'below' : 'above');
  const above = side === 'above';
  // A number on the side away from the beams (where the heads are) always gets a bracket:
  // a bare number there would float among the heads and read as belonging to a single note.
  const beamDir = crossY ? undefined : (notes[0]?.beam?.dir ?? anchor.stem);
  if (showNum && notes.length && beamDir && above !== (beamDir === 'up') && t.bracket !== false) bracket = true;
  // Horizontal extent: from the first head's left to the last head's right. Rests have no
  // geometry and count as one space wide at their x.
  const geoms = evs.map((e) => (e.ev.kind === 'note' ? must(geomOf.get(e)) : null));
  const bx0 = Math.min(...evs.map((e, i) => geoms[i]?.headL ?? e.x));
  const bx1 = Math.max(...evs.map((e, i) => geoms[i]?.headR ?? e.x + 1));
  const stemXs = evs.map((e, i) => geoms[i]?.stemX ?? e.x);
  const frame: TupletFrame = {
    above,
    evs,
    notes,
    reach: tupletReach(ctx, evs, geoms, above, s),
    stemXs,
    x0: geoms[0] ? stemXs[0] : bx0,
    x1: geoms[evs.length - 1] ? stemXs[evs.length - 1] : bx1,
    crossBeam: !!crossY,
  };
  const { x0, x1, reach } = frame;
  const numberHalfHeight = (sm.bbox('tuplet6').y1 - sm.bbox('tuplet6').y0) / 2;
  const clearance = bracket ? 1.1 : numberHalfHeight + 0.5; // The number sits clear of beams and stems.
  // The line follows the beam when the tuplet is fully beamed, or when a bracket is drawn. Otherwise
  // (a bare number) it is flat and only decides where the number goes.
  const sloped = (fullyBeamed || bracket) && x1 > x0 && notes.length > 1;
  const flatY = (above ? Math.min(...reach) : Math.max(...reach)) + (above ? -clearance : clearance);
  let { ya, yb } = sloped ? slopedTupletLine(frame, clearance) : { ya: flatY, yb: flatY };
  // A bare number is centred over the beam (first to last stem), a bracketed one over the
  // whole group including the heads at either end.
  const cx = !bracket && x1 > x0 && notes.length > 1 ? (x0 + x1) / 2 : (bx0 + bx1) / 2;
  let cy = ya + ((yb - ya) * (cx - x0)) / Math.max(0.001, x1 - x0);
  const box = bracket && showNum && touchesStaffLine(cy, 0.7);
  if (box) {
    // The box is taller than the bare digit: keep it off the beam and stems.
    const d = above ? -0.2 : 0.2;
    ya += d;
    yb += d;
    cy += d;
  }
  return { bracket, showNum, above, label: String(t.label ?? t.actual), ya, yb, x0, x1, bx0, bx1, cx, cy, box };
}

/** The tuplet's bracket (a line with a hook at each end, interrupted for the number) and number (plain italic text rather than the font's tuplet figures, which are bolder than the other numerals in the score), and their skyline boxes. */
function paintTuplet(ctx: SysCtx, p: TupletPlan, s: number): void {
  const { bracket, showNum, above, ya, yb, x0, x1, bx0, bx1, cx, cy, box } = p;
  const textWidth = p.label.length * 1.0;
  const boxHalfW = Math.max(0.95, textWidth / 2 + 0.45); // This is the radius of the circle around the number.
  const [boxTop, boxBottom] = [-1.07, 0.89]; // These are relative to cy: the digit (cap height ~1.26) spans -0.72..0.54, with 0.35 padding.
  const hookLen = 0.75 * (above ? 1 : -1);
  const lineWidth = D.tupletBracketThickness as number;
  const yAt = (x: number) => ya + ((yb - ya) * (x - x0)) / Math.max(0.001, x1 - x0);
  if (bracket) {
    const gap = showNum ? (box ? boxHalfW : textWidth / 2 + 0.35) : 0;
    const segments: [number, number][] = showNum
      ? [
          [bx0, cx - gap],
          [cx + gap, bx1],
        ]
      : [[bx0, bx1]];
    for (const [a, b] of segments) ctx.prims[s].push({ t: 'line', x1: a, y1: yAt(a), x2: b, y2: yAt(b), w: lineWidth });
    ctx.prims[s].push({ t: 'line', x1: bx0, y1: yAt(bx0), x2: bx0, y2: yAt(bx0) + hookLen, w: lineWidth });
    ctx.prims[s].push({ t: 'line', x1: bx1, y1: yAt(bx1), x2: bx1, y2: yAt(bx1) + hookLen, w: lineWidth });
  }
  if (box) {
    const [ccy, bw] = [cy + (boxTop + boxBottom) / 2, 0.1];
    const K = 0.5523; // This constant approximates a quarter circle with a cubic Bezier curve.
    const circle = (rad: number, ccw: boolean) => {
      const k = rad * K;
      const pts: [number, number][] = [
        [cx + rad, ccy],
        [cx, ccy + rad],
        [cx - rad, ccy],
        [cx, ccy - rad],
      ];
      if (ccw) pts.reverse().unshift(pts.pop() as [number, number]);
      let d = `M${round3(pts[0][0])} ${round3(pts[0][1])}`;
      for (let i = 0; i < 4; i++) {
        const [p, q] = [pts[i], pts[(i + 1) % 4]];
        const [tx, ty] = [(q[0] - p[0]) / rad, (q[1] - p[1]) / rad];
        // Control points leave p along the tangent, which is perpendicular to the radius at p.
        const rp = [(p[0] - cx) / rad, (p[1] - ccy) / rad];
        const rq = [(q[0] - cx) / rad, (q[1] - ccy) / rad];
        const sgn = tx * -rp[1] + ty * rp[0] > 0 ? 1 : -1; // This is the direction of travel.
        const c1 = [p[0] + sgn * -rp[1] * k, p[1] + sgn * rp[0] * k];
        const c2 = [q[0] - sgn * -rq[1] * k, q[1] - sgn * rq[0] * k];
        d += `C${round3(c1[0])} ${round3(c1[1])} ${round3(c2[0])} ${round3(c2[1])} ${round3(q[0])} ${round3(q[1])}`;
      }
      return `${d}Z`;
    };
    ctx.prims[s].push({ t: 'path', d: circle(boxHalfW, false), fill: '#fff', top: true });
    ctx.prims[s].push({
      t: 'path',
      d: `${circle(boxHalfW + bw / 2, false)}${circle(boxHalfW - bw / 2, true)}`,
      top: true,
    });
  }
  if (showNum)
    ctx.prims[s].push({
      t: 'text',
      top: box,
      x: cx,
      y: cy + TUPLET_NUMBER_SIZE * 0.3,
      s: p.label,
      size: TUPLET_NUMBER_SIZE,
      italic: true,
      anchor: 'middle',
    });
  const yLo = Math.min(ya, yb) - (above ? 1.0 : 0);
  const yHi = Math.max(ya, yb) + (above ? 0 : 1.0);
  if (bracket) pushBox(ctx, s, bx0, bx1, above ? yLo - 0.2 : yLo, above ? yHi : yHi + 0.2); // Without a bracket there is no band.
  if (showNum)
    pushBox(
      ctx,
      s,
      cx - (box ? boxHalfW : textWidth / 2),
      cx + (box ? boxHalfW : textWidth / 2),
      box ? cy + (boxTop + boxBottom) / 2 - boxHalfW : cy - 0.9,
      box ? cy + (boxTop + boxBottom) / 2 + boxHalfW : cy + 0.9,
    );
}

/**
 * Draws the bracket and number of tuplet `t` over its events `evs` on staff `s`, trying the other side if a bare
 * number would sit on staff lines.
 */
function drawTupletPrims(ctx: SysCtx, t: TupletGroup, evs: EvL[], s: number): void {
  let plan = planTuplet(ctx, t, evs, s, undefined);
  if (!plan) return;
  // A bare number that would sit on staff lines moves to the other side of the group, if that is
  // clear of them (found by planning there without moving anything off the lines).
  if (!plan.bracket && plan.showNum && !t.placement && touchesStaffLine(plan.cy, 0.75)) {
    const other = plan.above ? 'below' : 'above';
    const probe = planTuplet(ctx, t, evs, s, other);
    if (probe && !touchesStaffLine(probe.cy, 0.75)) plan = planTuplet(ctx, t, evs, s, other) ?? plan;
  }
  paintTuplet(ctx, plan, s);
}

// Articulations: staccato, accents, tenuto, marcato and so on, placed on the stem side or the head
// side of the note depending on the voice, the stem and an explicit `artSide`.
/**
 * Draws a note's articulations on the side given by `artSide`, else by the voice/stem (marcato goes
 * above). On the stem's side they sit beyond the stem tip; otherwise just beyond the outermost head.
 */
function drawArticulations(ctx: SysCtx, e: EvL, s: number): void {
  const n0 = ctx.prims[s].length;
  drawArticulationPrims(ctx, e, s);
  tagFrom(ctx.prims[s], n0, 'artic', e);
}

/** Does an articulation go above the note? By `artSide`, else a cross-staff beam's stem, the voice, the stem (marcato goes above). */
function articulationsAbove(e: EvL & { ev: NoteEvent }, art: Articulation[]): boolean {
  if (e.ev.artSide) return e.ev.artSide === 'above';
  if (e.beam?.cross) return e.stem === 'down';
  if (e.nVoices > 1) return e.voiceRank === 0;
  return e.stem === 'down' || art.includes('marcato');
}

/** x of the articulations of a note and the y of the one nearest the note: beyond the stem tip on the stem's side, else just beyond the outermost head. */
function articulationAnchor(e: EvL, g: Geom, above: boolean, nearest: Articulation): { cx: number; y: number } {
  if (e.stem === (above ? 'up' : 'down')) {
    const y = above ? g.stemTip - 1.2 : g.stemTip + 1.2;
    return { cx: g.stemX, y: e.beam ? y + (above ? -0.2 : 0.2) : y };
  }
  const ref = above ? Math.max(...e.heads.map((h) => h.pos)) : Math.min(...e.heads.map((h) => h.pos));
  let q = above ? ref + 3 : ref - 3; // A distance of 1.5 spaces from the head centre leaves a clear gap.
  if (q % 2 === 0 && q >= 0 && q <= 8) q += above ? 1 : -1; // Inside the staff the articulation sits in a space, not on a line.
  const y = nearest === 'staccato' ? posToY(ref) + (above ? -1.25 : 1.25) : posToY(q); // Staccato dots hug the head a little closer.
  const head = must(e.heads.find((h) => h.pos === ref));
  return { cx: e.x + head.dx + g.hw / 2, y };
}

/** Draws the articulations of a note, staccato nearest to the head, on the side chosen by `articulationsAbove`. */
function drawArticulationPrims(ctx: SysCtx, e: EvL, s: number): void {
  if (e.ev.kind !== 'note' || !e.ev.art) return;
  const g = must(geomOf.get(e));
  const above = articulationsAbove(e as EvL & { ev: NoteEvent }, e.ev.art);
  const arts = [...e.ev.art].sort((a, b) => (a === 'staccato' ? -1 : b === 'staccato' ? 1 : 0)); // Staccato goes nearest to the head.
  const { cx, y: y0 } = articulationAnchor(e, g, above, arts[0]);
  let y = y0;
  let edge = y;
  for (const a of arts) {
    const name = `artic${a === 'accent' ? 'Accent' : a === 'staccato' ? 'Staccato' : 'Marcato'}${above ? 'Above' : 'Below'}`;
    ctx.prims[s].push(glyphCentered(name, cx, y));
    const b = sm.bbox(name);
    const h = b.y1 - b.y0;
    pushBox(ctx, s, cx - 0.7, cx + 0.7, y - Math.max(0.5, h / 2), y + Math.max(0.5, h / 2));
    edge = above ? y - Math.max(0.2, h / 2) : y + Math.max(0.2, h / 2);
    y += (above ? -1 : 1) * Math.max(0.9, h + 0.3);
  }
  articExtent.set(e, { above, edge });
}
