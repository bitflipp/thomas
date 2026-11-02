// Raw notes of one voice in one measure -> the voice's item tree.
//
// Steps: (1) hidden rests fill gaps and pad the voice to the measure length; (2) tuplets, tremolos and
// beams become ranges of event indices; (3) ranges are sorted outermost first and (4) nested into
// groups with a stack.
import type { BaseDur, BeamGroup, Dur, Event, Item, TremoloGroup, TupletGroup } from './model.ts';
import { baseTicks } from './model.ts';
import type { RawNote, TupletStart } from './musicxml-raw.ts';
import { ALL_BASES } from './musicxml-raw.ts';

type Warn = (m: string) => void;

/** An event of the voice with what the source says about its grouping. */
interface VoiceEvent {
  ev: Event;
  tm?: [number, number];
  tupStart?: TupletStart[];
  tupStop: number;
  beam1?: string;
  trem?: RawNote['trem'];
}

/** A group over events a..b (inclusive); `rank` orders groups with identical extents, outermost (highest) first. */
interface Range {
  a: number;
  b: number;
  make: () => Item;
  rank: number;
}

const RANK_BEAM = 1;
const RANK_TREMOLO = 2;
const RANK_TUPLET = 3;
const BEAM_OF_ONE_NOTE_MIN_BASE: BaseDur = 8;

/** Splits a gap into the fewest legal durations (largest first), to fill it with hidden rests. */
export function decomposeGap(ticks: number): Dur[] {
  const out: Dur[] = [];
  while (ticks > 0) {
    let found: Dur | null = null;
    for (const base of ALL_BASES)
      for (const dots of [2, 1, 0]) {
        const bt = baseTicks({ base, dots });
        if (!Number.isInteger(bt)) continue;
        if (bt <= ticks && (!found || bt > baseTicks(found))) found = { base, dots };
      }
    if (!found) throw new Error(`cannot represent gap of ${ticks} ticks`);
    out.push(found);
    ticks -= baseTicks(found);
  }
  return out;
}

function hiddenRests(ticks: number): VoiceEvent[] {
  return decomposeGap(ticks).map((d) => ({ ev: { kind: 'rest', style: 'hidden', dur: d }, tupStop: 0 }));
}

/**
 * Fills gaps with hidden rests and checks continuity: a note starting before the previous one ends is
 * an error (overlap inside one voice), a note starting later leaves a gap. A voice that stops early is
 * padded with hidden rests (MuseScore does the same implicitly), so every voice has exactly the length
 * of its measure.
 */
function fillGaps(notes: RawNote[], mlen: number, mnum: number, warn: Warn): VoiceEvent[] {
  const evs: VoiceEvent[] = [];
  let pos = 0;
  for (const n of notes) {
    if (n.tick < pos) throw new Error(`m${mnum}: overlapping events in one voice`);
    if (n.tick > pos) evs.push(...hiddenRests(n.tick - pos));
    evs.push({ ev: n.ev, tm: n.tmRatio, tupStart: n.tupStart, tupStop: n.tupStop, beam1: n.beam1, trem: n.trem });
    pos = n.tick + n.ticks;
    // The notated duration (with the tuplet ratio applied) must equal the sounding one; a
    // mismatch usually means a feature we do not model, so warn about it.
    let expect = baseTicks(n.ev.dur);
    if (n.tmRatio) expect = (expect * n.tmRatio[1]) / n.tmRatio[0];
    if (expect !== n.ticks && !(n.ev.kind === 'rest' && n.ev.style === 'measure'))
      warn(`m${mnum}: notated duration ${expect} != sounding ${n.ticks}`);
  }
  if (pos > mlen) warn(`m${mnum}: voice longer than measure`);
  if (pos < mlen) evs.push(...hiddenRests(mlen - pos));
  return evs;
}

/** Tuplet group for a tuplet with explicit display options. */
function explicitTuplet(ratio: [number, number], o: TupletStart): TupletGroup {
  const g: TupletGroup = { kind: 'tuplet', actual: ratio[0], normal: ratio[1], items: [] };
  if (o.bracket !== undefined) g.bracket = o.bracket;
  if (o.number) g.number = o.number;
  if (o.placement) g.placement = o.placement;
  if (o.label !== undefined && o.label !== ratio[0]) g.label = o.label;
  return g;
}

/**
 * Tuplet ranges: explicit start/stop notations, plus implicit tuplets for notes that carry a
 * <time-modification> but no tuplet notation. Those are tuplets in timing only, with
 * `bracket: false` and `number: 'none'`, so that nothing is drawn for them.
 */
function tupletRanges(evs: VoiceEvent[], mnum: number, warn: Warn): Range[] {
  const ranges: Range[] = [];
  const open: { a: number; o: TupletStart; ratio: [number, number] }[] = [];
  let implicit: { a: number; ratio: [number, number] } | null = null;
  const closeImplicit = (b: number) => {
    if (!implicit) return;
    const { a, ratio } = implicit;
    ranges.push({
      a,
      b,
      rank: RANK_TUPLET,
      make: () => ({ kind: 'tuplet', actual: ratio[0], normal: ratio[1], bracket: false, number: 'none', items: [] }),
    });
    implicit = null;
  };
  evs.forEach((e, i) => {
    if (e.tupStart) {
      closeImplicit(i - 1);
      for (const o of e.tupStart) {
        if (!e.tm) {
          warn(`m${mnum}: tuplet without time-modification`);
          continue;
        }
        open.push({ a: i, o, ratio: e.tm });
      }
    } else if (e.tm) {
      if (!open.length) {
        if (implicit && (implicit.ratio[0] !== e.tm[0] || implicit.ratio[1] !== e.tm[1])) closeImplicit(i - 1);
        implicit ??= { a: i, ratio: e.tm };
      }
    } else closeImplicit(i - 1);
    for (let k = 0; k < e.tupStop; k++) {
      const t = open.pop();
      if (t) ranges.push({ a: t.a, b: i, rank: RANK_TUPLET, make: () => explicitTuplet(t.ratio, t.o) });
    }
  });
  closeImplicit(evs.length - 1);
  if (open.length) warn(`m${mnum}: unterminated tuplet`);
  return ranges;
}

/** Two-note tremolos: a start note and the matching stop note delimit the group. A start without a stop is dropped with a warning. */
function tremoloRanges(evs: VoiceEvent[], mnum: number, warn: Warn): Range[] {
  const ranges: Range[] = [];
  let start: { i: number; beams: number } | null = null;
  evs.forEach((e, i) => {
    if (e.trem?.role === 'start') start = { i, beams: e.trem.beams };
    else if (e.trem?.role === 'stop' && start) {
      const { i: a, beams } = start;
      ranges.push({ a, b: i, rank: RANK_TREMOLO, make: () => ({ kind: 'tremolo', beams, items: [] }) });
      start = null;
    }
  });
  if (start) warn(`m${mnum}: tremolo without end`);
  return ranges;
}

/**
 * Beam ranges from the first beam level. A beamable note without beam (the source says it stands
 * alone) gets a one-note range so that `simplifyBeams` can turn it into `noBeam`.
 */
function beamRanges(evs: VoiceEvent[]): Range[] {
  const ranges: Range[] = [];
  const beam = (a: number, b: number): Range => ({ a, b, rank: RANK_BEAM, make: () => ({ kind: 'beam', items: [] }) });
  let start = -1;
  evs.forEach((e, i) => {
    if (e.beam1 === 'begin') start = i;
    else if (e.beam1 === 'end' && start >= 0) {
      ranges.push(beam(start, i));
      start = -1;
    } else if (!e.beam1 && start < 0 && e.ev.kind === 'note' && e.ev.dur.base >= BEAM_OF_ONE_NOTE_MIN_BASE)
      ranges.push(beam(i, i));
  });
  return ranges;
}

/**
 * A beam that starts or ends inside a tuplet but continues outside it would cross the tuplet's edge.
 * When the part of the tuplet outside the beam is only rests (the source starts the beam at the first
 * note after a rest), the beam is widened over those rests so that the tuplet nests inside it.
 */
function widenBeam(beam: Range, tuplets: Range[], evs: VoiceEvent[]): Range {
  const rests = (a: number, b: number) => evs.slice(a, b).every((e) => e.ev.kind === 'rest');
  let { a, b } = beam;
  for (const t of tuplets) {
    if (t.a < a && a <= t.b && b > t.b && rests(t.a, a)) a = t.a;
    if (t.a <= b && b < t.b && a < t.a && rests(b + 1, t.b + 1)) b = t.b;
  }
  return a === beam.a && b === beam.b ? beam : { ...beam, a, b };
}

function groupName(rank: number): string {
  return rank === RANK_TUPLET ? 'tuplet' : rank === RANK_TREMOLO ? 'tremolo' : 'beam';
}

/**
 * Nests the events into the groups. Walk the events; a stack holds the groups currently open, each
 * closing after its last event. Because the ranges are sorted outermost first (earlier start, then
 * later end; for identical extents tuplet outside tremolo outside beam), a group opening at an
 * event is always placed inside the innermost one still open.
 */
function nest(evs: VoiceEvent[], ranges: Range[], mnum: number, warn: Warn): Item[] {
  const sorted = [...ranges].sort((x, y) => x.a - y.a || y.b - x.b || y.rank - x.rank);
  interface Open {
    b: number;
    node: { items: Item[] };
  }
  const rootItems: Item[] = [];
  const stack: Open[] = [{ b: Number.POSITIVE_INFINITY, node: { items: rootItems } }];
  let next = 0;
  for (let i = 0; i < evs.length; i++) {
    while (stack.length > 1 && stack[stack.length - 1].b < i) stack.pop();
    while (next < sorted.length && sorted[next].a === i) {
      const r = sorted[next++];
      const parent = stack[stack.length - 1];
      let b = r.b;
      if (b > parent.b) {
        warn(`m${mnum}: ${groupName(r.rank)} crosses group boundary, truncated`);
        b = parent.b;
      }
      const node = r.make() as TupletGroup | BeamGroup | TremoloGroup;
      parent.node.items.push(node);
      stack.push({ b, node });
    }
    stack[stack.length - 1].node.items.push(evs[i].ev);
  }
  return rootItems;
}

/** Builds a voice's item tree from its raw notes (in time order). */
export function buildVoice(notes: RawNote[], mlen: number, mnum: number, warn: Warn): Item[] {
  const evs = fillGaps(notes, mlen, mnum, warn);
  const tuplets = tupletRanges(evs, mnum, warn);
  const ranges = [
    ...tuplets,
    ...tremoloRanges(evs, mnum, warn),
    ...beamRanges(evs).map((b) => widenBeam(b, tuplets, evs)),
  ];
  return nest(evs, ranges, mnum, warn);
}
