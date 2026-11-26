// Horizontal spacing: per measure, derive columns (distinct onset times), their natural widths and
// minimum distances. A system is justified by scaling the "ideal" part.
//
// Model: column j sits at x_j = max(x_{j-1} + f * ideal_j, collision constraints), where the ideal
// distance grows with the time since the previous column (`idealSpace`, a power law so that long notes
// get more but not proportionally more room), and the constraints keep the left extent of a column
// clear of the right extent of the previous one on every staff. The stretch factor `f` is solved for a
// whole system in system.ts; `COMPRESS` bounds how far a measure may be squeezed below its ideal.

import type { Score } from '../model.ts';

import { keyAt, PPQ, timeChangeAt } from '../model.ts';
import { loadSmufl } from '../smufl.ts';
import { must } from '../util.ts';
import { HYPHEN_ROOM, LYRIC_GAP, lyricWidth } from './lyrics.ts';
import type { EvL, HeadL, Prepared } from './prep.ts';
import { clefAtStart } from './prep.ts';

const sm = loadSmufl();

/** The notehead glyph for a note value (`base`: 1 whole, 2 half, else filled). */
export function headGlyph(base: number): string {
  return base === 1 ? 'noteheadWhole' : base === 2 ? 'noteheadHalf' : 'noteheadBlack';
}

/** Notehead width factor (Leland's heads are already MuseScore's full size). */
export const HEAD_SCALE = 1;

/** The width of a notehead for a note value. */
export function headWidth(base: number): number {
  return sm.adv(headGlyph(base)) * HEAD_SCALE;
}

/** Stem thickness. */
export const STEM_T = 0.12;

/** Grace notes are drawn at this fraction of the normal size. */
export const GRACE_SCALE = 0.7;

/** Distance between successive augmentation dots of a multiply dotted note (the first dot sits 0.4 right of the head). */
export const DOT_STEP = 0.55;

/** Least distance between an up-stem and the following down-stem of a cross-staff beam. */
const CROSS_STEM_SEP = 2.0;

/** Minimum stretch factor allowed when fitting measures on a line (0.55: at most 45 % tighter than ideal). */
export const COMPRESS = 0.55;

/** Ideal distance (staff spaces) between two columns `dt` ticks apart: a fixed part plus a power law (a quarter apart: 3.0). */
function idealSpace(dt: number): number {
  return 1.1 + 1.9 * (dt / PPQ) ** 0.6;
}

/** All events starting at one tick of a measure, across staves. Columns of one tick are aligned vertically. */
/** Key change at the start of measure `mi` (not the first): the naturals canceling the old key
 *  (indices into the old key's accidental order) and the number of new accidentals. */
export function keyChange(
  score: Score,
  mi: number,
): { from: number; to: number; nat: number[]; add: number } | undefined {
  if (mi === 0 || score.measures[mi].key === undefined) return undefined;
  const from = keyAt(score, mi - 1);
  const to = keyAt(score, mi);
  if (from === to) return undefined;
  const keep = Math.sign(from) === Math.sign(to) ? Math.abs(to) : 0;
  const nat: number[] = [];
  for (let i = keep; i < Math.abs(from); i++) nat.push(i);
  return { from, to, nat, add: Math.abs(to) };
}

/**
 * The width of the key signature change at measure `mi`: naturals canceling the old key, then the new
 * accidentals.
 */
function keyChangeWidth(score: Score, mi: number): number {
  const kc = keyChange(score, mi);
  if (!kc) return 0;
  const n = kc.nat.length + kc.add;
  if (!n) return 0;
  return n * (sm.adv(kc.add ? (kc.to > 0 ? 'accidentalSharp' : 'accidentalFlat') : 'accidentalNatural') + 0.12) + 0.6;
}

/** Clear space on each side of a small clef at the end of a measure. */
export const END_CLEF_GAP = 0.5;

export interface Column {
  tick: number;
  evs: EvL[]; // These are the events starting here (all staves).
  ideal: number; // This is the ideal distance from the previous column (or from the measure start for the first).
  L: number[]; // This is the left extent per staff.
  R: number[]; // This is the right extent per staff.
  has: boolean[]; // This says per staff whether the column is occupied.
  clefChange: boolean[]; // This says per staff whether the column has a clef change.
  clefW: number[]; // This is the width reserved per staff for a clef change (added to `L`).
  minFrom: { j: number; d: number }[]; // Each entry requires at least `d` to the right of column `j` (the stems of a cross-staff beam).
}

/** Width a repeat sign takes beside its barline: the thick and thin lines and the dots. */
export const REPEAT_WIDTH = 1.4;

/** What system layout needs to know about one measure: its columns and how narrow or wide it can get. */
export interface MeasureSpacing {
  mi: number;
  cols: Column[];
  endIdeal: number;
  open: number; // This is where the room of the notes starts: after a key or time change and a repeat sign.
  lead: number; // This is the x of the first column at minimum.
  endTrail: number; // This is the required distance from the last column to the barline (the maximum over staves).
  endReq: number[]; // This is the right extent of the last occupied column, per staff.
  endClef: boolean[]; // This says per staff whether the next measure starts with a clef change, which is drawn small before the barline.
  prefix: number; // This is extra leading width (for a time signature change).
  timeSig?: { beats: number; beatType: number };
  minWidth: number;
  compWidth: number; // This is the width when the measure is compressed to `COMPRESS`.
  restOnly: boolean;
  multi?: number; // This measure is the first of a multi-measure rest of this many measures.
  absorbed?: boolean; // This measure is swallowed by the multi-measure rest before it: it has no width.
}

/** An empty spacing column at `tick` for a score with `nStaves` staves. */
function newColumn(tick: number, nStaves: number): Column {
  return {
    tick,
    evs: [],
    ideal: 0,
    L: new Array(nStaves).fill(0),
    R: new Array(nStaves).fill(0),
    has: new Array(nStaves).fill(false),
    clefChange: new Array(nStaves).fill(false),
    clefW: new Array(nStaves).fill(0),
    minFrom: [],
  };
}

/** Groups the visible events and clef changes of a measure into columns by tick, in time order. */
function collectColumns(prep: Prepared, mi: number): { cols: Column[]; restOnly: boolean } {
  const nStaves = prep.score.staves.length;
  const byTick = new Map<number, Column>();
  const columnAt = (tick: number): Column => {
    const existing = byTick.get(tick);
    if (existing) return existing;
    const c = newColumn(tick, nStaves);
    byTick.set(tick, c);
    return c;
  };
  let anyVisible = false;
  for (let s = 0; s < nStaves; s++) {
    const sml = prep.measures[mi][s];
    for (const e of sml.evs) {
      if (e.ev.kind === 'rest' && e.ev.style === 'hidden') continue;
      if (e.ev.kind === 'rest' && e.ev.style === 'measure') {
        columnAt(e.start).evs.push(e);
        continue;
      }
      anyVisible = true;
      const c = columnAt(e.start);
      c.evs.push(e);
      c.has[s] = true;
    }
    for (const m of sml.marks)
      if (m.type === 'clef' && m.tick > 0) {
        const c = columnAt(m.tick);
        c.clefChange[s] = true;
        c.has[s] = true;
      }
  }
  return { cols: [...byTick.values()].sort((a, b) => a.tick - b.tick), restOnly: !anyVisible };
}

/**
 * How far each column reaches left and right of its x on each staff (heads, accidentals, dots,
 * graces, a clef change), which decides the minimum distance to its neighbors.
 */
function measureColumnExtents(cols: Column[], nStaves: number): void {
  for (let s = 0; s < nStaves; s++) {
    for (const c of cols) {
      const evs = c.evs.filter((e) => e.staff === s);
      if (c.clefChange[s]) c.clefW[s] = sm.adv('gClefChange') + 1.4; // The clef comes first, then clear space before the notes (and their accidentals).
      if (evs.length) layoutColumnStaff(c, s, evs);
      c.L[s] += c.clefW[s];
    }
  }
}

/**
 * Syllables must not run into each other: per staff and verse, a column with a syllable is kept
 * clear of the previous column's syllable (`minFrom`, with room for a hyphen where the word goes
 * on), and the first and last syllables of the measure may reach beyond their columns.
 */
function separateLyrics(cols: Column[]): void {
  const prev = new Map<string, { j: number; w: number; joins: boolean; staff: number; hw: number }>();
  const first = new Set<string>();
  cols.forEach((c, j) => {
    for (const e of c.evs) {
      if (e.ev.kind !== 'note') continue;
      for (const y of e.ev.lyrics ?? []) {
        const key = `${e.home}|${y.verse}`;
        const w = lyricWidth(y.text);
        const hw = headWidth(e.ev.dur.base);
        const p = prev.get(key);
        if (p) c.minFrom.push({ j: p.j, d: p.w / 2 + w / 2 + (p.joins ? HYPHEN_ROOM : LYRIC_GAP) });
        else if (!first.has(key)) {
          first.add(key);
          c.L[e.staff] = Math.max(c.L[e.staff], w / 2 - hw / 2);
        }
        prev.set(key, { j, w, joins: y.syllabic === 'begin' || y.syllabic === 'middle', staff: e.staff, hw });
        c.R[e.staff] = Math.max(c.R[e.staff], j === cols.length - 1 ? w / 2 + hw / 2 : 0);
      }
    }
  });
  // A word that goes on in the next measure puts its hyphen between the last syllable and the barline
  // (never on the barline), so the measure must end that much after the syllable.
  for (const p of prev.values())
    if (p.joins && p.j === cols.length - 1)
      cols[p.j].R[p.staff] = Math.max(cols[p.j].R[p.staff], p.w / 2 + p.hw / 2 + HYPHEN_ROOM);
}

/**
 * A cross-staff beam has up-stems on the right of their heads followed by down-stems on the left of
 * theirs; the columns involved are pushed apart (`minFrom`) so the two stems do not merge.
 */
function separateCrossStaffStems(cols: Column[]): void {
  const colAt = new Map(cols.map((c, j) => [c.tick, j]));
  const seen = new Set<object>();
  for (const c of cols)
    for (const e of c.evs) {
      if (!e.beam?.cross || seen.has(e.beam)) continue;
      seen.add(e.beam);
      const ns = e.beam.notes;
      for (let k = 1; k < ns.length; k++) {
        const a = ns[k - 1];
        const b = ns[k];
        const ja = colAt.get(a.start);
        const jb = colAt.get(b.start);
        if (a.stem === 'up' && b.stem === 'down' && ja !== undefined && jb !== undefined && ja < jb)
          cols[jb].minFrom.push({ j: ja, d: headWidth(a.te.ev.dur.base) + CROSS_STEM_SEP });
      }
    }
}

/** Width taken at the start of a measure by a key change and a time signature change. */
function measurePrefix(prep: Prepared, mi: number): { prefix: number; timeSig?: { beats: number; beatType: number } } {
  const timeSig = timeChangeAt(prep.score, mi);
  const digitWidth = sm.adv('timeSig2');
  const timeSigWidth = timeSig
    ? Math.max(digitWidth * String(timeSig.beats).length, digitWidth * String(timeSig.beatType).length) + 1.2
    : 0;
  return { prefix: keyChangeWidth(prep.score, mi) + timeSigWidth, timeSig };
}

/**
 * Builds the columns of measure `mi` and measures it at minimum and compressed width. A clef change at
 * tick 0 takes no column: it is a small clef at the end of the previous measure (`endClef`). May run more
 * than once per measure, so everything it writes onto the `EvL`s must be idempotent.
 */
export function spaceMeasure(prep: Prepared, mi: number): MeasureSpacing {
  const nStaves = prep.score.staves.length;
  const { cols, restOnly } = collectColumns(prep, mi);
  measureColumnExtents(cols, nStaves);
  separateCrossStaffStems(cols);
  separateLyrics(cols);
  // Ideal distances: from each column to the previous one by elapsed time. `endIdeal` is the
  // distance from the last column to the barline, by the time left in the measure.
  let prevTick = 0;
  cols.forEach((c, i) => {
    c.ideal = i === 0 ? 0 : idealSpace(c.tick - prevTick);
    prevTick = c.tick;
  });
  const lastTick = cols.length ? cols[cols.length - 1].tick : 0;
  const endIdeal = idealSpace(prep.measureLen[mi] - lastTick);
  const { prefix, timeSig } = measurePrefix(prep, mi);
  const endReq: number[] = new Array(nStaves).fill(0);
  for (let s = 0; s < nStaves; s++) for (const c of cols) if (c.has[s]) endReq[s] = c.R[s];
  const open = prefix + (prep.score.measures[mi].repeatStart ? REPEAT_WIDTH : 0);
  const sp: MeasureSpacing = {
    mi,
    cols,
    endIdeal,
    open,
    lead: open + 0.9 + Math.max(0, ...cols.slice(0, 1).flatMap((c) => c.L)),
    endTrail: 0.75 + (prep.score.measures[mi].barline === 'repeat-end' ? REPEAT_WIDTH : 0),
    endReq,
    endClef: clefAtStart(prep.score, mi + 1).map((c) => c !== undefined),
    prefix,
    timeSig,
    minWidth: 0,
    compWidth: 0,
    restOnly,
  };
  sp.minWidth = placeMeasure(sp, 1).width;
  sp.compWidth = placeMeasure(sp, COMPRESS, PLANNED_CLEARANCE).width;
  return sp;
}

/** `spaceMeasure` runs more than once per measure and writes onto shared EvL/HeadL objects, so start from a clean state each time. */
function resetColumnLayout(evs: EvL[]): void {
  for (const e of evs) {
    e.shiftDx = 0;
    for (const h of e.heads) {
      h.dx = 0;
      h.shared = false;
      h.skipDots = false;
      h.accX = undefined;
      h.sharers = undefined;
    }
  }
}

/** The staff-position range a voice's heads and stem cover. */
function stemSpan(x: EvL): [number, number] {
  const ps = x.heads.map((q) => q.pos);
  const lo = Math.min(...ps);
  const hi = Math.max(...ps);
  return x.stem === 'up' ? [lo, hi + 7] : x.stem === 'down' ? [lo - 7, hi] : [lo, hi];
}

/**
 * A head of a later voice that sits on the same position as one of the first voice (a unison) shares
 * it when the two are indistinguishable or have opposite stems and the same head shape.
 */
function shareUnisonHeads(e: EvL, first: EvL[]): void {
  const d = e.te.ev.dur;
  for (const h of e.heads)
    for (const f of first) {
      const fd = f.te.ev.dur;
      const sameDur = fd.base === d.base && fd.dots === d.dots;
      // Distinguishable by opposite stems and the same head shape: one head serves both voices
      // (the two stems attach to it), which is how unisons between voices are usually written.
      const distinct = !!f.stem && !!e.stem && f.stem !== e.stem && headGlyph(fd.base) === headGlyph(d.base);
      const host =
        sameDur || distinct
          ? f.heads.find((g) => g.pos === h.pos && g.pitch.alter === h.pitch.alter && !g.shared)
          : undefined;
      if (host) {
        h.shared = true;
        h.skipDots = fd.dots >= d.dots;
        host.sharers ??= [];
        host.sharers.push(e);
      }
    }
}

/** Whether a later voice has heads a step or less from the first voice's, or heads on the other voice's stem (or the other way round). */
function clashesWithFirstVoice(e: EvL, first: EvL[]): boolean {
  for (const h of e.heads)
    if (!h.shared) for (const f of first) for (const g of f.heads) if (Math.abs(h.pos - g.pos) <= 1) return true;
  for (const f of first) {
    const [fl, fh] = stemSpan(f);
    const [el, eh] = stemSpan(e);
    if (f.stem && e.heads.some((h) => !h.shared && h.pos > fl && h.pos <= fh)) return true;
    if (e.stem && f.heads.some((g) => g.pos >= el && g.pos < eh)) return true;
  }
  return false;
}

/** Voice collisions: shared unisons, and the later voice shifted to the right where it clashes with the first. */
function resolveVoiceCollisions(evs: EvL[]): void {
  const notes = evs.filter((e) => e.ev.kind === 'note');
  if (notes.length < 2) return;
  const first = notes.filter((e) => e.voiceRank === 0);
  for (const e of notes.filter((x) => x.voiceRank > 0)) {
    shareUnisonHeads(e, first);
    if (!clashesWithFirstVoice(e, first)) continue;
    e.shiftDx = headWidth(e.te.ev.dur.base);
    for (const h of e.heads) if (!h.shared) h.dx += e.shiftDx;
  }
}

/** The width of `dots` augmentation dots. */
const dotsWidth = (dots: number) => (dots ? 0.4 + DOT_STEP * dots : 0);

/** The heads that take their own place in a column (not shared ones) with the extent to the left and right of the column x of all events. */
function headExtents(evs: EvL[]): { heads: { h: HeadL; e: EvL }[]; L: number; R: number } {
  const heads: { h: HeadL; e: EvL }[] = [];
  let L = 0;
  let R = 0;
  for (const e of evs) {
    if (e.ev.kind === 'rest') {
      if (e.ev.style === 'hidden') continue;
      const measureRest = e.ev.style === 'measure';
      const glyph = restGlyph(e.te.ev.dur.base, measureRest);
      R = Math.max(R, measureRest ? 0 : sm.adv(glyph) + dotsWidth(e.te.ev.dur.dots));
      continue;
    }
    const w = headWidth(e.te.ev.dur.base);
    for (const h of e.heads) {
      if (h.shared) continue;
      if (h.displaced) h.dx += e.stem === 'down' ? -(w - STEM_T) : w - STEM_T;
      heads.push({ h, e });
      L = Math.max(L, -h.dx);
      let r = h.dx + w;
      if (h.pos <= -2 || h.pos >= 10) r += sm.def.legerLineExtension as number; // The head's ledger line reaches beyond the head.
      R = Math.max(R, r + dotsWidth(e.te.ev.dur.dots));
    }
    if (e.stem === 'up' && e.te.ev.dur.base >= 8 && !e.beam && !e.tremPair)
      R = Math.max(R, Math.max(...e.heads.map((h) => h.dx)) + w + 0.9);
  }
  return { heads, L, R };
}

const ACCIDENTAL_GAP = 0.12;

/** Clearance (staff positions) that two accidentals need between their glyph boxes to share a column. */
const ACCIDENTAL_STACK_GAP = 1;

/** Whether a head at staff position `pos` needs ledger lines. */
const hasLedgerLine = (pos: number) => pos <= -2 || pos >= 10;

/** Width (with parentheses) and height (staff positions) of an accidental's glyph. */
function accidentalSize(acc: { glyph: string; cautionary: boolean }): { w: number; hh: number } {
  const w = sm.adv(acc.glyph) + (acc.cautionary ? sm.adv('accidentalParensLeft') + sm.adv('accidentalParensRight') : 0);
  const hh =
    acc.glyph === 'accidentalSharp' || acc.glyph === 'accidentalNatural'
      ? 6
      : acc.glyph === 'accidentalDoubleSharp'
        ? 4
        : 5;
  return { w, hh };
}

/**
 * Accidental stacking: all heads of this staff column together. Accidentals are placed in columns to
 * the left of the heads, the highest first, each in the first column where it does not overlap one
 * already there (the usual zig-zag). Returns how far the leftmost reaches left of the column x.
 */
function stackAccidentals(heads: { h: HeadL; e: EvL }[]): number {
  const accHeads = heads.filter((x) => x.h.acc).sort((a, b) => b.h.pos - a.h.pos);
  if (!accHeads.length) return 0;
  const info = accHeads.map((x) => ({ head: x.h, ...accidentalSize(must(x.h.acc)) }));
  const stacks: { pos: number; h: number; w: number }[][] = [];
  const colOf = info.map((it) => {
    let k = 0;
    while (!(stacks[k] ?? []).every((q) => Math.abs(q.pos - it.head.pos) >= (q.h + it.hh) / 2 + ACCIDENTAL_STACK_GAP))
      k++;
    stacks[k] ??= [];
    stacks[k].push({ pos: it.head.pos, h: it.hh, w: it.w });
    return k;
  });
  // An accidental level with a ledger line must clear the line's extension as well: the ledger
  // line sticks out to the left of the head by `legerLineExtension`, and the accidental would
  // otherwise sit on it.
  const positions = heads.map((x) => x.h.pos);
  const pMin = Math.min(...positions);
  const pMax = Math.max(...positions);
  const ledgerHit = info.some((it) => {
    const half = it.hh / 2 + 0.3;
    for (let p = -2; p >= pMin; p -= 2) if (Math.abs(p - it.head.pos) < half) return true;
    for (let p = 10; p <= pMax; p += 2) if (Math.abs(p - it.head.pos) < half) return true;
    return false;
  });
  let edge = Math.min(...heads.map((x) => x.h.dx)) - 0.2 - (ledgerHit ? (sm.def.legerLineExtension as number) : 0);
  const colRight = stacks.map((st) => {
    const right = edge;
    edge -= Math.max(...st.map((q) => q.w)) + ACCIDENTAL_GAP;
    return right;
  });
  info.forEach((it, idx) => {
    it.head.accX = colRight[colOf[idx]] - it.w; // This is the left edge of the (possibly parenthesized) glyph.
  });
  return -(edge + ACCIDENTAL_GAP);
}

/** The arpeggio wiggle sits left of everything, including accidentals: a fixed width (wiggle plus the space between it and the accidentals). */
const ARPEGGIO_WIDTH = 0.5 + 0.9;

const GRACE_SPACING = 0.45;

/**
 * Grace notes stand to the left of the note (and its accidentals) they belong to. This reserves their
 * width in the column's left extent (`L0` is the extent without them, returned is the extent with
 * them); `drawGraces` draws them at that place.
 */
function placeGraces(evs: EvL[], L0: number): number {
  let L = L0;
  for (const e of evs) {
    if (e.ev.kind !== 'note' || !e.graces?.length) continue;
    const graces = e.graces;
    // Right edge of the nearest grace note (a lone flag reaches out to the right).
    let x = -(L0 + 0.3 + (graces.length === 1 && graces[0].g.base >= 8 ? 0.7 : 0));
    for (let k = graces.length - 1; k >= 0; k--) {
      const gl = graces[k];
      gl.hw = headWidth(gl.g.base) * GRACE_SCALE;
      gl.dx = x - gl.hw;
      let left = gl.dx;
      const accs = gl.heads.filter((h) => h.acc);
      if (accs.length) {
        const aw = Math.max(...accs.map((h) => sm.adv(must(h.acc).glyph))) * GRACE_SCALE;
        const clearOfLedgerLine = gl.heads.some((h) => h.acc && hasLedgerLine(h.pos))
          ? (sm.def.legerLineExtension as number) * GRACE_SCALE
          : 0;
        left = gl.dx - (0.1 + clearOfLedgerLine) - aw;
        for (const h of accs) h.accX = left;
      }
      L = Math.max(L, -left);
      x = left - GRACE_SPACING;
    }
  }
  return L;
}

/** The extent to the left and right of the column x that the events of one staff need (written onto `c`), and the offsets of their heads. */
function layoutColumnStaff(c: Column, s: number, evs: EvL[]): void {
  resetColumnLayout(evs);
  resolveVoiceCollisions(evs);
  const { heads, L: headsL, R } = headExtents(evs);
  let L = Math.max(headsL, stackAccidentals(heads));
  if (evs.some((e) => e.ev.kind === 'note' && e.ev.arpeggio)) L += ARPEGGIO_WIDTH;
  L = placeGraces(evs, L);
  c.L[s] = Math.max(c.L[s], L);
  c.R[s] = Math.max(c.R[s], R);
  c.has[s] = true;
}

/** The flag glyph for `levels` flags (1 = eighth ... 5 = 128th). */
export function flagGlyph(levels: number, up: boolean): string {
  const n = ['8th', '16th', '32nd', '64th', '128th'][Math.min(Math.max(levels, 1), 5) - 1];
  return `flag${n}${up ? 'Up' : 'Down'}`;
}

/** The glyph for a rest of a note value (`base`), or the whole rest for a whole measure. */
export function restGlyph(base: number, measure?: boolean): string {
  if (measure) return 'restWhole';
  return base === 1
    ? 'restWhole'
    : base === 2
      ? 'restHalf'
      : base === 4
        ? 'restQuarter'
        : base === 8
          ? 'rest8th'
          : base === 16
            ? 'rest16th'
            : base === 32
              ? 'rest32nd'
              : base === 64
                ? 'rest64th'
                : 'rest128th';
}

export interface PlacedMeasure {
  xs: number[];
  width: number;
  endX: number;
}

/** Clearance scale a line may be planned with (squeezing the clearances is otherwise a last resort down to MIN_CLEARANCE). */
const PLANNED_CLEARANCE = 0.9;

/** Least scale of the clearances between neighboring columns (see `placeMeasure`'s `z`). */
export const MIN_CLEARANCE = 0.75;

/**
 * Place columns for stretch factor f (f=1 natural). x = 0 at the measure's left edge. `z` scales the
 * clearances (head/accidental extents plus gap) between neighboring columns; it is below 1 only
 * for a measure so dense that it does not fit a line even when compressed (`justifySystem`).
 */
export function placeMeasure(sp: MeasureSpacing, f: number, z = 1): PlacedMeasure {
  if (sp.absorbed) return { xs: [], width: 0, endX: 0 };
  const nS = sp.endReq.length;
  const xs: number[] = [];
  const lastOcc: number[] = new Array(nS).fill(-1);
  sp.cols.forEach((c, j) => {
    let x = j === 0 ? sp.lead : xs[j - 1] + f * c.ideal;
    for (let s = 0; s < nS; s++) {
      if (!c.has[s]) continue;
      const i = lastOcc[s];
      if (i >= 0) x = Math.max(x, xs[i] + z * (sp.cols[i].R[s] + c.L[s] + 0.47));
      lastOcc[s] = j;
    }
    for (const m of c.minFrom) x = Math.max(x, xs[m.j] + m.d);
    if (j === 0) x = Math.max(x, sp.lead);
    xs.push(x);
  });
  const last = xs.length ? xs[xs.length - 1] : sp.lead;
  let endX = last + f * sp.endIdeal;
  if (sp.cols.length === 0 || sp.restOnly) {
    const room = sp.multi ? 5.5 + 0.7 * Math.min(sp.multi - 1, 7) : 5.5; // A multi-measure rest grows a little with its length.
    endX = Math.max(endX, sp.lead + room * Math.min(1.5, f));
  }
  for (let s = 0; s < nS; s++)
    if (lastOcc[s] >= 0) endX = Math.max(endX, xs[lastOcc[s]] + z * (sp.cols[lastOcc[s]].R[s] + sp.endTrail));
  const clefW = sm.adv('gClefChange') + 2 * END_CLEF_GAP;
  for (let s = 0; s < nS; s++)
    if (sp.endClef[s])
      endX = Math.max(endX, (lastOcc[s] >= 0 ? xs[lastOcc[s]] + z * sp.cols[lastOcc[s]].R[s] : sp.lead) + z * clefW);
  return { xs, width: endX, endX };
}

export type { Score };
