// Analysis pass: turns the Score into per-event layout records (written pitch positions,
// accidentals, stem directions, beam groups ...) before any horizontal/vertical layout.
//
// The `EvL` records made here are shared by every later phase; spacing and drawing write their
// results back onto the same objects (x, head offsets, stem tips). `prepare` works one measure at a
// time but carries state across measures where notation does (clefs, ottava, ties into the next measure).

import { beamGroups, beatPhase, beatTicks } from '../beams.ts';

import type {
  Clef,
  Event,
  Grace,
  Mark,
  Measure,
  NoteEvent,
  Pitch,
  Score,
  StaffDef,
  StaffMeasure,
  TimedEvent,
  TimeSig,
  TremoloGroup,
  TupletGroup,
  Voice,
} from '../model.ts';

import { carriedFrom, flattenVoice, marksOf, measureTicks, pitchStep, STEPS } from '../model.ts';
import { must } from '../util.ts';
import type { MeasureSpacing } from './spacing.ts';

/** The diatonic step number (octave * 7 + step) of the bottom line of a staff with clef `c`. */
export function clefBottomStep(c: Clef): number {
  const sign = c.sign === 'G' ? { s: 'g', o: 4 } : c.sign === 'F' ? { s: 'f', o: 3 } : { s: 'c', o: 4 };
  const signStep = sign.o * 7 + STEPS.indexOf(sign.s as never);
  return signStep - 2 * (c.line - 1) + 7 * (c.octave ?? 0);
}

/** Staff position (half-spaces above bottom line) for a written pitch. */
export function staffPos(p: Pitch, c: Clef): number {
  return pitchStep(p) - clefBottomStep(c);
}

/**
 * Converts a staff position (half-spaces above the bottom line) to the staff-local y, where 0 is the top line and
 * y grows downward.
 */
export function posToY(pos: number): number {
  return 4 - pos / 2;
}

export interface HeadL {
  pos: number; // This is the written staff position.
  pitch: Pitch; // This is the sounding pitch.
  tie: boolean;
  tieSide?: 'above' | 'below'; // The side the tie is forced to, if any.
  acc?: { glyph: string; cautionary: boolean };
  displaced: boolean; // The head is moved to the other side of the stem.
  dx: number; // This is the x offset relative to the event's notehead x (set during layout).
  accX?: number; // This is the x offset of the accidental glyph's left edge.
  shared?: boolean; // The head is a unison with a head of the first voice that can serve both, so it is drawn only once.
  sharers?: EvL[]; // These are the events of other voices whose stems attach to this head, so they share it.
  skipDots?: boolean; // The first voice already draws at least as many dots here.
}

/** A grace note (or chord) in front of an event: its heads and, once spaced, where it stands relative to the event's x. */
export interface GraceL {
  g: Grace;
  heads: HeadL[];
  dx: number; // This is the left edge of the heads, relative to the event's notehead x (set during spacing).
  hw: number; // This is the head width.
}

export interface EvL {
  id: number;
  mi: number; // This is the measure index.
  staff: number; // This is the staff index the heads are drawn on (it differs from `home` for cross-staff notes).
  home: number; // This is the staff index of the voice, to which stems, beams, tuplets and slurs belong.
  voice: number; // This is the voice id.
  voiceRank: number; // This is the 0-based rank among the sounding voices in this staff-measure.
  nVoices: number;
  te: TimedEvent;
  ev: Event;
  start: number; // This is the tick within the measure.
  ticks: number;
  clef: Clef;
  heads: HeadL[];
  graces?: GraceL[]; // Grace notes in front of the note are drawn small to its left.
  stem: 'up' | 'down' | null;
  beam?: BeamL;
  tremPair?: EvL; // This is the partner of a two-note tremolo (set on both notes).
  tremIsFirst?: boolean;
  tremBeams?: number;
  tupletKeys: TupletGroup[];
  // Everything below is filled in by spacing and drawing, not by `prepare`. (This is why
  // `spaceMeasure` must reset what it writes before it writes: it runs more than once.)
  /** Absolute x within the system of the normal notehead's left edge. */
  x: number;
  stemX?: number;
  /** Stem end farthest from the heads, and the end at the heads (staff-local y). */
  stemTip?: number;
  stemBase?: number;
  /** -1 = under an 8va (written lower than sounding), +1 = under an 8vb. */
  ottavaShift: number;
  /** Sideways shift of the whole event to avoid clashing with another voice's heads. */
  shiftDx: number;
}

export interface BeamL {
  evs: EvL[]; // These are all members, including rests.
  notes: EvL[]; // These are the members that are notes.
  dir: 'up' | 'down';
  cross?: boolean; // The members sit on different staves, so the beam runs between them and the stems point toward it.
  crossY?: [number, number]; // For a cross-staff beam these are the top and bottom edge (y in the voice's staff, set when drawn).
}

export interface StaffMeasureL {
  evs: EvL[]; // These are the events drawn on this staff (all voices, including cross-staff arrivals), sorted by start and voice.
  voices: { id: number; evs: EvL[] }[]; // These are the voices of this staff, with all their events wherever they are drawn.
  byTime: EvL[]; // These are the events of the voices of this staff (wherever drawn), sorted by start and then voice.
  marks: Mark[];
}

export interface Prepared {
  score: Score;
  measures: StaffMeasureL[][]; // The list is indexed by measure, then by staff.
  clefAt: (staff: number, mi: number, tick: number) => Clef;
  measureLen: number[];
  /** The key (fifths) and time signature in force at each measure: `keyAt` and `timeAt` of the score, found once. */
  keyOf: number[];
  timeOf: TimeSig[];
  /** The cache entry of every measure when `prepare` ran with a cache (see `PrepCache`). */
  entries?: MeasureEntry[];
  /** Editor aid: hidden rests are drawn as faint, tagged `ghost` glyphs (not in the skyline), so that they can be clicked. */
  ghostRests?: boolean;
  /** Multi-measure rests (see `multirest.ts`): the length of the run starting at a measure, and the measures that a run swallows after its first. */
  multi?: Map<number, number>;
  absorbed?: Set<number>;
}

/**
 * Everything computed for one measure that depends only on the measure itself and on what is carried
 * into it (`sig`): its layout records and, once asked for, its spacing. An entry is valid as long as the
 * `Measure` object is the same (the editor's commands keep untouched measures identical) and `sig` matches.
 */
export interface MeasureEntry {
  mi: number;
  m: Measure;
  sig: string;
  row: StaffMeasureL[];
  /** Per staff: the tie keys carried into the next measure. */
  tiedOut: string[][];
  spN?: MeasureSpacing;
  spF?: MeasureSpacing;
}

/** Results kept from one engraving to the next; passed to `prepare` (and `engrave`) to redo only what an edit touched. */
export interface PrepCache {
  staves?: StaffDef[];
  entries: MeasureEntry[];
  nextId: number;
}

const ACC_GLYPH: Record<number, string> = {
  [-2]: 'accidentalDoubleFlat',
  [-1]: 'accidentalFlat',
  0: 'accidentalNatural',
  1: 'accidentalSharp',
  2: 'accidentalDoubleSharp',
};

const SHARP_ORDER = ['f', 'c', 'g', 'd', 'a', 'e', 'b'];

/** The alteration (-1, 0, 1) that a key signature of `fifths` fifths gives to `step`. */
export function keyAlter(fifths: number, step: string): number {
  if (fifths > 0) return SHARP_ORDER.slice(0, fifths).includes(step) ? 1 : 0;
  if (fifths < 0) return [...SHARP_ORDER].reverse().slice(0, -fifths).includes(step) ? -1 : 0;
  return 0;
}

/** The number of beams (flags) of a note value: 1 for eighths, 2 for sixteenths, and so on. */
function levels(base: number): number {
  return base >= 8 ? Math.log2(base) - 2 : 0;
}

export { levels as beamLevels };

type VoiceL = { id: number; evs: EvL[] };

/** Calls `visit` for every mark of every staff-measure, with the staff index and measure index. */
function forEachMark(score: Score, visit: (staff: number, mi: number, mark: Mark) => void): void {
  const staffIdx = new Map(score.staves.map((s, i) => [s.id, i]));
  score.measures.forEach((m, mi) => {
    for (const [sid, sm] of Object.entries(m.staves))
      for (const mk of marksOf(sm)) visit(must(staffIdx.get(sid)), mi, mk);
  });
}

/** `clefAt(staff, mi, tick)`: starts from the staff's initial clef and applies the clef changes up to the position. */
function clefTimeline(score: Score): Prepared['clefAt'] {
  const changes: { mi: number; tick: number; clef: Clef }[][] = score.staves.map(() => []);
  forEachMark(score, (s, mi, mk) => {
    if (mk.type === 'clef') changes[s].push({ mi, tick: mk.tick, clef: mk.clef });
  });
  return (s, mi, tick) => {
    let c = score.staves[s].clef;
    for (const ch of changes[s])
      if (ch.mi < mi || (ch.mi === mi && ch.tick <= tick)) c = ch.clef;
      else break;
    return c;
  };
}

/**
 * Ottava timeline per staff, built like the clef timeline: -1 for 8va (written an octave lower than
 * it sounds), +1 for 8vb and 0 where the line stops. A stop at a tick ends the line before the notes there
 * (the line is drawn up to the previous note), a start at a tick applies to them when `startIncl`.
 */
function ottavaTimeline(score: Score): (staff: number, mi: number, tick: number, startIncl: boolean) => number {
  const changes: { mi: number; tick: number; shift: number }[][] = score.staves.map(() => []);
  forEachMark(score, (s, mi, mk) => {
    if (mk.type === 'ottava') changes[s].push({ mi, tick: mk.tick, shift: mk.dir === 'up' ? -1 : 1 });
    else if (mk.type === 'stop' && mk.of === 'ottava') changes[s].push({ mi, tick: mk.tick, shift: 0 });
  });
  return (s, mi, tick, startIncl) => {
    let shift = 0;
    for (const o of changes[s]) {
      const before = o.mi < mi || (o.mi === mi && (o.tick < tick || (o.tick === tick && (o.shift === 0 || startIncl))));
      if (before) shift = o.shift;
      else break;
    }
    return shift;
  };
}

/** What the per-measure passes need to know about the score as a whole. */
interface PrepEnv {
  score: Score;
  staffIdx: Map<string, number>;
  clefAt: Prepared['clefAt'];
  ottavaAt: ReturnType<typeof ottavaTimeline>;
  keyOf: number[];
  timeOf: TimeSig[];
  /** Next event id. */
  nextId: number;
  /** Per display staff: voice|pitch keys of notes tied into the current measure. */
  tiedFromPrev: Map<string, boolean>[];
}

/** Identifies a tied pitch within a voice, so that a tie can be matched to the note it continues. */
const tieKey = (voice: number, p: Pitch) => `${voice}|${pitchStep(p)}|${p.alter}`;

/** The layout record of one event of a voice of staff `home`. A cross-staff event takes the clef, octave shift and accidentals of the staff it is displayed on, not of its voice's staff. */
function layoutEvent(
  env: PrepEnv,
  te: TimedEvent,
  mi: number,
  home: number,
  voiceId: number,
  rank: number,
  nVoices: number,
): EvL {
  const crossTo = te.ev.kind === 'note' && te.ev.staff !== undefined ? env.staffIdx.get(te.ev.staff) : undefined;
  const display = crossTo ?? home;
  const clef = env.clefAt(display, mi, te.start);
  const shift = env.ottavaAt(display, mi, te.start, true);
  const e: EvL = {
    id: env.nextId++,
    mi,
    staff: display,
    home,
    voice: voiceId,
    voiceRank: Math.max(0, rank),
    nVoices,
    te,
    ev: te.ev,
    start: te.start,
    ticks: te.ticks,
    clef,
    heads: [],
    stem: null,
    x: 0,
    tupletKeys: te.tuplets,
    ottavaShift: shift,
    shiftDx: 0,
  };
  if (te.ev.kind === 'note') {
    const mkHead = (np: NoteEvent['pitches'][number]): HeadL => ({
      pitch: np.pitch,
      tie: !!np.tie,
      ...(np.tie && np.tieSide ? { tieSide: np.tieSide } : {}),
      displaced: false,
      dx: 0,
      pos: staffPos({ ...np.pitch, octave: np.pitch.octave + shift }, clef),
    });
    e.heads = te.ev.pitches.map(mkHead);
    if (te.ev.graces?.length) e.graces = te.ev.graces.map((g) => ({ g, heads: g.pitches.map(mkHead), dx: 0, hw: 0 }));
  }
  return e;
}

/** The layout records of every voice of the measure, per staff. */
function layoutVoices(env: PrepEnv, mi: number): VoiceL[][] {
  const m = env.score.measures[mi];
  return env.score.staves.map((staff, si) => {
    const voices = m.staves[staff.id]?.voices ?? [];
    const sounding = voices.filter((v) =>
      flattenVoice(v).some((e) => e.ev.kind === 'note' || (e.ev.kind === 'rest' && e.ev.style === 'normal')),
    );
    return voices.map((v) => {
      const rank = sounding.findIndex((x) => x.id === v.id);
      return { id: v.id, evs: flattenVoice(v).map((te) => layoutEvent(env, te, mi, si, v.id, rank, sounding.length)) };
    });
  });
}

/**
 * Accidentals per display staff. The state is per staff for the whole measure, all voices together in
 * time order (an accidental in one voice still applies to the same pitch in another).
 */
function assignAccidentals(env: PrepEnv, voicesOf: VoiceL[][], key: number): void {
  for (let si = 0; si < env.score.staves.length; si++) {
    /** Alteration in force per "step+octave" so far in this measure. */
    const state = new Map<string, number>();
    const shown = (np: NoteEvent['pitches'][number], head: HeadL, tiedIn: boolean | undefined, atStart: boolean) => {
      const k = `${np.pitch.step}${np.pitch.octave}`;
      const inForce = state.get(k) ?? keyAlter(key, np.pitch.step);
      const cautionary = np.acc === 'cautionary';
      let show = np.pitch.alter !== inForce || np.acc === 'force' || cautionary;
      if (tiedIn && atStart && np.acc === undefined) show = false;
      if (show) head.acc = { glyph: ACC_GLYPH[np.pitch.alter], cautionary };
      state.set(k, np.pitch.alter);
    };
    const onStaff = voicesOf
      .flatMap((vs) => vs.flatMap((v) => v.evs))
      .filter((e) => e.staff === si)
      .sort((a, b) => a.start - b.start || a.voice - b.voice);
    for (const e of onStaff) {
      if (e.ev.kind !== 'note') continue;
      // Grace notes come first.
      for (const gl of e.graces ?? [])
        for (const [i, np] of gl.g.pitches.entries()) shown(np, gl.heads[i], false, e.start === 0);
      for (const [i, np] of e.ev.pitches.entries())
        shown(np, e.heads[i], env.tiedFromPrev[si].get(tieKey(e.voice, np.pitch)), e.start === 0);
    }
  }
}

/** Ties carry into the next measure: a tied note's pitch is not given an accidental again there. Keyed by the staff the tied note is drawn on. */
function carryTies(env: PrepEnv, voicesOf: VoiceL[][]): void {
  for (const t of env.tiedFromPrev) t.clear();
  for (const voices of voicesOf)
    for (const v of voices) {
      const last = v.evs[v.evs.length - 1];
      if (last && last.ev.kind === 'note')
        for (const np of last.ev.pitches) if (np.tie) env.tiedFromPrev[last.staff].set(tieKey(v.id, np.pitch), true);
    }
}

/** Links the two notes of a two-note tremolo group, so the stem direction and drawing can treat them as a pair (the first is flagged `tremIsFirst`). */
function linkTremoloPairs(v: VoiceL): void {
  const pairs = new Map<TremoloGroup, EvL[]>();
  for (const e of v.evs) {
    if (!e.te.tremolo || e.ev.kind !== 'note') continue;
    const list = pairs.get(e.te.tremolo) ?? [];
    list.push(e);
    pairs.set(e.te.tremolo, list);
  }
  for (const [g, [a, b]] of pairs)
    if (b) {
      a.tremPair = b;
      b.tremPair = a;
      a.tremIsFirst = true;
      a.tremBeams = b.tremBeams = g.beams;
    }
}

/**
 * Stem directions (`decideDir`): a beam group or tremolo pair shares one direction; with several
 * voices on a staff the first points up and the others down; a lone voice goes by which side of the
 * middle line its heads are farther from. An explicit `stem` on the event overrides afterward.
 */
function decideStems(v: VoiceL): void {
  const decidedBeams = new Set<BeamL>();
  for (const e of v.evs) {
    if (e.ev.kind !== 'note' || e.te.ev.dur.base === 1) continue;
    if (e.beam) {
      if (!decidedBeams.has(e.beam)) {
        decidedBeams.add(e.beam);
        e.beam.dir = decideDir(e.beam.notes, e.voiceRank, e.nVoices);
      }
      e.stem = e.beam.dir;
    } else if (e.tremPair && !e.tremIsFirst) e.stem = e.tremPair.stem;
    else if (e.tremPair) e.stem = decideDir([e, e.tremPair], e.voiceRank, e.nVoices);
    else e.stem = decideDir([e], e.voiceRank, e.nVoices);
  }
  for (const e of v.evs) {
    if (e.ev.kind !== 'note' || !e.ev.stem || e.te.ev.dur.base === 1) continue;
    e.stem = e.ev.stem;
    if (e.beam) e.beam.dir = e.ev.stem;
  }
}

/** A beam over two staves lies between them: the stems of the upper staff's notes point down and those of the lower staff's up. */
function markCrossStaffBeams(v: VoiceL): void {
  const seen = new Set<BeamL>();
  for (const e of v.evs) {
    if (!e.beam || seen.has(e.beam)) continue;
    seen.add(e.beam);
    const staves = new Set(e.beam.notes.map((n) => n.staff));
    if (staves.size < 2) continue;
    e.beam.cross = true;
    const top = Math.min(...staves);
    for (const n of e.beam.notes) n.stem = n.staff === top ? 'down' : 'up';
  }
}

/** Beams, tremolo pairs, stem directions and chord head displacement for the voices of one staff. */
function prepareStaffVoices(voices: VoiceL[], sm: StaffMeasure, beatLen: number, phase: number): void {
  // Explicit groups plus the automatic grouping of src/beams.ts become `BeamL`s attached to their
  // member events; direction and cross-staff handling come in the later steps.
  for (const v of voices) assignBeams(v, must(sm.voices.find((x) => x.id === v.id)), beatLen, phase);
  for (const v of voices) linkTremoloPairs(v);
  for (const v of voices) decideStems(v);
  // A beam's direction wins over its notes' own.
  for (const v of voices)
    for (const e of v.evs) if (e.beam?.dir) e.stem = e.stem && e.ev.kind === 'note' ? e.beam.dir : e.stem;
  for (const v of voices) markCrossStaffBeams(v);
  // A second (heads on adjacent positions) cannot sit on one side of the stem, so one of the two
  // moves to the other side. Needs the stem direction.
  for (const v of voices) for (const e of v.evs) if (e.ev.kind === 'note') displaceHeads(e);
}

/**
 * Builds the layout records (`EvL`) of every measure, reusing the measures of `cache` whose object and carried-in
 * state are unchanged.
 */
export function prepare(score: Score, cache?: PrepCache): Prepared {
  const clefAt = clefTimeline(score);
  if (cache && cache.staves !== score.staves) {
    cache.entries = [];
    cache.staves = score.staves;
  }
  const env: PrepEnv = {
    score,
    staffIdx: new Map(score.staves.map((s, i) => [s.id, i])),
    clefAt,
    ottavaAt: ottavaTimeline(score),
    keyOf: [],
    timeOf: [],
    nextId: cache?.nextId ?? 0,
    tiedFromPrev: score.staves.map(() => new Map()),
  };
  const { keyOf, timeOf } = signaturesOf(score);
  env.keyOf = keyOf;
  env.timeOf = timeOf;
  const measureLen = timeOf.map((t, mi) => score.measures[mi].length ?? measureTicks(t));
  const measures: StaffMeasureL[][] = [];
  const entries: MeasureEntry[] = [];
  score.measures.forEach((m, mi) => {
    // What the measure's records depend on besides the measure itself: the state carried into it.
    const sig = cache ? measureSignature(env, mi) : '';
    const old = cache?.entries[mi];
    let entry: MeasureEntry;
    if (old && old.m === m && old.sig === sig) {
      entry = old;
      for (let si = 0; si < env.tiedFromPrev.length; si++) {
        env.tiedFromPrev[si].clear();
        for (const k of old.tiedOut[si]) env.tiedFromPrev[si].set(k, true);
      }
    } else {
      const row = prepareMeasure(env, m, mi);
      entry = { mi, m, sig, row, tiedOut: env.tiedFromPrev.map((t) => [...t.keys()]) };
    }
    entries.push(entry);
    measures.push(entry.row);
  });
  if (cache) {
    cache.entries = entries;
    cache.nextId = env.nextId;
  }
  return { score, measures, clefAt, measureLen, keyOf, timeOf, entries: cache ? entries : undefined };
}

/** The clef change at tick 0 of measure `mi` on staff `si`, if any. It is drawn at the end of the previous measure (as a small clef), not at the start of its own. */
export function clefAtStart(score: Score, mi: number): (Clef | undefined)[] {
  const m = score.measures[mi];
  return score.staves.map((st) => {
    if (!m) return undefined;
    const mk = marksOf(m.staves[st.id] ?? { voices: [] }).find((x) => x.type === 'clef' && x.tick === 0);
    return mk?.type === 'clef' ? mk.clef : undefined;
  });
}

/** The key and time signature in force at every measure (what `keyAt` and `timeAt` return, without searching back each time). */
function signaturesOf(score: Score): { keyOf: number[]; timeOf: TimeSig[] } {
  const keyOf: number[] = [];
  const timeOf: TimeSig[] = [];
  let key = 0;
  for (const [mi, m] of score.measures.entries()) {
    if (m.key !== undefined) key = m.key;
    const from = carriedFrom(score.measures, mi);
    keyOf.push(key);
    timeOf.push(m.time ?? (from < 0 ? { beats: 4, beatType: 4 } : timeOf[from]));
  }
  return { keyOf, timeOf };
}

/** The state carried into measure `mi` that its layout records depend on: clefs, octave lines, ties, key and time. */
function measureSignature(env: PrepEnv, mi: number): string {
  const { score } = env;
  const staves = score.staves.map((_, si) => si);
  // The key and time of the measure before count too: a change is printed (and takes room) where they differ, and a
  // later volta can restore a time without giving it (`timeChangeAt`).
  return JSON.stringify([
    mi,
    env.keyOf[mi],
    mi > 0 ? env.keyOf[mi - 1] : 0,
    env.timeOf[mi],
    mi > 0 ? env.timeOf[mi - 1] : 0,
    staves.map((si) => env.clefAt(si, mi, -1)),
    clefAtStart(score, mi + 1),
    staves.map((si) => env.ottavaAt(si, mi, -1, false)),
    env.tiedFromPrev.map((t) => [...t.keys()].sort()),
  ]);
}

/** The layout records of one measure, per staff; leaves the ties it carries on to the next measure in `env`. */
function prepareMeasure(env: PrepEnv, m: Measure, mi: number): StaffMeasureL[] {
  const { score } = env;
  const voicesOf = layoutVoices(env, mi);
  assignAccidentals(env, voicesOf, env.keyOf[mi]);
  carryTies(env, voicesOf);
  const row: StaffMeasureL[] = score.staves.map((staff, si) => {
    const sm = m.staves[staff.id] ?? { voices: [] };
    prepareStaffVoices(voicesOf[si], sm, beatTicks(env.timeOf[mi]), beatPhase(score, mi));
    const byTime = voicesOf[si].flatMap((v) => v.evs).sort((p, q) => p.start - q.start || p.voice - q.voice);
    return { evs: [], voices: voicesOf[si], byTime, marks: marksOf(sm) };
  });
  // `evs` lists what is drawn on a staff, which for cross-staff notes is not the voice's staff.
  for (const r of row) for (const v of r.voices) for (const e of v.evs) row[e.staff].evs.push(e);
  for (const r of row) r.evs.sort((a, b) => a.start - b.start || a.voice - b.voice);
  return row;
}

/**
 * The stem direction of a voice at one event or chord: fixed by rank when the staff has several voices, else away
 * from the middle line.
 */
function decideDir(notes: EvL[], rank: number, nVoices: number): 'up' | 'down' {
  if (nVoices > 1) return rank === 0 ? 'up' : 'down';
  let hi = Number.NEGATIVE_INFINITY;
  let lo = Number.POSITIVE_INFINITY;
  for (const n of notes)
    for (const h of n.heads) {
      hi = Math.max(hi, h.pos);
      lo = Math.min(lo, h.pos);
    }
  if (hi === Number.NEGATIVE_INFINITY) return 'up';
  const above = hi - 4;
  const below = 4 - lo; // This is the distance from the middle line (position 4).
  return above > below ? 'down' : above < below ? 'up' : (hi + lo) / 2 >= 4 ? 'down' : 'up';
}

/** Moves the heads of a chord that sit a second apart to the other side of the stem. */
function displaceHeads(e: EvL): void {
  const hs = e.heads;
  if (hs.length < 2) return;
  const order = hs.map((_, i) => i).sort((a, b) => hs[a].pos - hs[b].pos);
  const down = e.stem === 'down';
  const seq = down ? [...order].reverse() : order;
  let prev: number | null = null;
  for (const i of seq) {
    if (prev !== null && Math.abs(hs[i].pos - hs[prev].pos) === 1 && !hs[prev].displaced) hs[i].displaced = true;
    prev = i;
  }
}

/** Attaches the beam groups of a voice (explicit and automatic) to its events. */
function assignBeams(vl: { id: number; evs: EvL[] }, voice: Voice, beatLen: number, phase: number): void {
  const byEv = new Map(vl.evs.map((e) => [e.ev, e]));
  for (const g of beamGroups(voice, beatLen, phase)) {
    const ems = g.map((ev) => must(byEv.get(ev)));
    const b: BeamL = { evs: ems, notes: ems.filter((x) => x.ev.kind === 'note'), dir: 'up' };
    for (const x of ems) x.beam = b;
  }
}
