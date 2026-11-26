// Core score model. The model (plain JSON-serializable data) is the source of truth; the text format
// (textformat.ts) and the MusicXML importer produce and consume it, the engraver and playback read it,
// and the editor changes it only through pure functions (src/editor/commands.ts).
//
// Time is measured in integer ticks so that no rounding ever happens in rhythm arithmetic. Structure:
// Score > Measure > StaffMeasure (per staff id) > Voice > Item tree. Marks (dynamics, hairpins, pedal,
// ...) are not stored with ticks but hang on the events they start at; see `marksOf`.

import { must } from './util.ts';

/** Ticks per quarter note: divisible by 2^5, 3, 5 and 7, so undotted 128th notes and tuplets up to septuplets are exact integers (a dotted 128th would be 157.5 ticks: not allowed). */
export const PPQ = 3360;

/** The beat of a tick within its measure as shown to people: counted from 1 (the downbeat), rounded to hundredths. */
export function beatOf(tick: number): number {
  return Math.round((tick / PPQ + 1) * 100) / 100;
}

export type Step = 'c' | 'd' | 'e' | 'f' | 'g' | 'a' | 'b';
export const STEPS: Step[] = ['c', 'd', 'e', 'f', 'g', 'a', 'b'];

export interface Pitch {
  step: Step;
  alter: number; // The alteration ranges from -2 to 2 semitones.
  octave: number; // The octave uses scientific pitch notation, where c4 is middle C.
}

export type BaseDur = 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128;

export interface Dur {
  base: BaseDur;
  dots: number;
}

export type AccOverride = 'force' | 'cautionary';

export interface NotePitch {
  pitch: Pitch;
  tie?: boolean; // The note is tied to the next note of the same pitch.
  tieSide?: 'above' | 'below'; // The tie arches to this side instead of the automatic one.
  acc?: AccOverride;
  /** The MIDI velocity (1 to 127) of this head; absent: it follows the dynamics. Only the first head of a tie chain counts. */
  vel?: number;
  /** The displacement of the attack in milliseconds (negative: earlier), applied after the tempo map; absent: none. Only the first head of a tie chain counts. */
  shift?: number;
  /** The factor on the sounding length that the notation gives (1: as written, below 1: shorter), counted from the played attack; absent: 1. Ignored on a tied head. */
  gate?: number;
}

export type Articulation = 'accent' | 'marcato' | 'staccato';

export interface SlurStart {
  id: number;
  side?: 'above' | 'below';
  skewed?: boolean; // The engraver may skew the slur to hug a low side; otherwise it is a symmetric arc (unless an obstacle forces a skew).
}

/**
 * A line drawn between two notes (a voicing aid): the start is on one event, the stop (same id) on another, which may be in
 * another voice or staff. Both must be in one system to be drawn. Matching is score-wide by id, see `pairLines`.
 */
export interface LineStart {
  id: number;
  dashed?: boolean;
  head?: number; // The index of the chord pitch the line is attached to; absent: the chord as a whole (always absent for a single note).
}

export interface LineStop {
  id: number;
  head?: number; // The index of the chord pitch the line is attached to; absent: the chord as a whole (always absent for a single note).
}

/** A grace note (or chord) played just before the note it is attached to; takes no time in the measure. */
export interface Grace {
  pitches: NotePitch[];
  base: BaseDur; // This is the written value: 8 has one flag, 16 has two, and so on.
  slash?: boolean; // The grace note is an acciaccatura (struck through) rather than an appoggiatura.
}

export interface EventBase {
  dur: Dur;
  stem?: 'up' | 'down';
  staff?: string; // For a cross-staff note this is the other staff it is drawn on (default: the staff of the voice); stem and beam stay with the voice.
  slurStart?: SlurStart[];
  slurStop?: number[];
  lineStart?: LineStart[];
  lineStop?: LineStop[];
  fermata?: boolean; // A fermata sits above the event (a note, chord or rest).
  fermataShape?: FermataShape; // The fermata's shape; absent: the normal round one. Only with `fermata`.
  fermataBelow?: true; // The fermata sits below the event, upside down. Only with `fermata`.
  marks?: MarkBody[]; // These marks (dynamics, hairpin/pedal/ottava starts and stops, clef changes, tempo, text) sit at the start of this event.
}

/** One syllable of a lyric verse under a note. */
export interface Syllable {
  verse: number; // This is the verse number, from 1.
  text: string;
  /** Whether the syllable is a whole word or joins its neighbors with a hyphen (`begin`: more follows, `end`: the last of a word). */
  syllabic: 'single' | 'begin' | 'middle' | 'end';
  extend?: boolean; // An extender line follows the syllable (a melisma over the next notes).
}

export interface NoteEvent extends EventBase {
  kind: 'note';
  pitches: NotePitch[]; // The pitches are ordered from low to high.
  art?: Articulation[];
  artSide?: 'above' | 'below'; // This forces the side of the articulations (default: by stem and voice).
  arpeggio?: boolean;
  ornament?: Ornament; // A mordent or turn sign above the note.
  trill?: boolean; // A trill mark (tr) sits above the note.
  trillAcc?: -1 | 0 | 1; // The alteration of the trill's upper note, shown as a small accidental above the mark (flat, natural, sharp); absent: none shown, a whole tone up.
  lyrics?: Syllable[]; // These are the syllables sung on this note, one per verse, in ascending verse order.
  graces?: Grace[]; // These are the grace notes in front of this note, in playing order.
  noBeam?: boolean; // The note stays unbeamed although the automatic beaming would join it to its neighbors.
}

export type RestStyle = 'normal' | 'hidden' | 'measure'; // A hidden rest is a spacer, and a measure rest is a whole-measure rest (its `dur` is informational).

export interface RestEvent extends EventBase {
  kind: 'rest';
  style: RestStyle;
  display?: Pitch; // This forces the vertical position.
}

export type Event = NoteEvent | RestEvent;

export interface TupletGroup {
  kind: 'tuplet';
  actual: number;
  normal: number;
  /** Draw a bracket? Undefined: automatic (a bracket unless the whole tuplet is under one beam). */
  bracket?: boolean;
  number?: 'actual' | 'none';
  /** The displayed number, if it differs from `actual`. */
  label?: number;
  placement?: 'above' | 'below';
  items: Item[];
}

/**
 * Explicit beam group: at least two notes, consecutive in the voice (possibly inside tuplets).
 * Events outside explicit groups are beamed automatically (see beams.ts); `noBeam` opts a note out.
 * A group exists only where the automatic choice would be different.
 */
export interface BeamGroup {
  kind: 'beam';
  items: Item[];
}

/** Two-note (fingered) tremolo: exactly two notes, drawn with `beams` beams between them. */
export interface TremoloGroup {
  kind: 'tremolo';
  beams: number;
  items: Item[];
}

export type Item = Event | TupletGroup | BeamGroup | TremoloGroup;

export interface Voice {
  id: number;
  items: Item[];
  /** Marks at the end of the measure: the stops of spans (hairpin, pedal, ottava) that run up to the barline. */
  end?: MarkBody[];
}

/** A mordent or turn: `mordent` has the vertical line (main, lower neighbor, main), `mordent-inverted` has none (main, upper neighbor, main); a `turn` plays upper, main, lower, main and an inverted one lower, main, upper, main. */
export type Ornament = 'mordent' | 'mordent-inverted' | 'turn' | 'turn-inverted';

/** A fermata's shape besides the normal round one: short (angled, MusicXML `angled`) and long (square). */
export type FermataShape = 'short' | 'long';

export type Placement = 'above' | 'below';

/** Dynamics, hairpins and text can also sit `between` their staff and its neighbor (below the upper one, above the lower one), centered in the gap: for piano parts, where one dynamic serves both hands. */
export type MarkPlacement = Placement | 'between';

export type MarkBody =
  | { type: 'dynamic'; text: string; placement?: MarkPlacement }
  | { type: 'hairpin'; kind: 'cresc' | 'dim'; id: number; placement?: MarkPlacement }
  /** Pedal press; a press while the pedal is down is a change (release and press again). */
  | { type: 'pedal' }
  /** `up` = 8va: written an octave lower than it sounds, line above the staff. */
  | { type: 'ottava'; dir: 'up' | 'down' }
  /** A trill line: the `tr` sign and a wavy line to the matching stop; every note under it is trilled. */
  | { type: 'trill' }
  | { type: 'stop'; of: 'pedal' | 'ottava' | 'trill' }
  | { type: 'stop'; of: 'hairpin'; id: number }
  | { type: 'clef'; clef: Clef }
  | { type: 'tempo'; unit: BaseDur; dots: number; bpm: number; text?: string }
  | { type: 'text'; text: string; placement?: MarkPlacement };

/** A mark with a position, as in MusicXML or on a text-format mark line; `anchorMarks` hangs it on an event. */
export type TimedMark = MarkBody & { tick: number };

/**
 * A mark as the engraver and playback see it, derived from the events carrying it (`marksOf`): `tick` within the measure,
 * `voice`/`idx`/`k` its address (event index in the voice, -1 for the voice's `end` list; position in that list).
 */
export type Mark = TimedMark & { voice: number; idx: number; k: number };

export interface StaffMeasure {
  voices: Voice[];
}

export interface TimeSig {
  beats: number;
  beatType: number;
}

export interface Clef {
  sign: 'G' | 'F' | 'C';
  line: number;
  octave?: number;
}

export interface Measure {
  /** Set where the time signature changes (always on the first measure). */
  time?: TimeSig;
  /**
   * The written length in ticks when it differs from the time signature's: a pickup (anacrusis) at the start of the
   * piece or a short measure elsewhere. Absent: the full length. A pickup is the first measure with a length; it is
   * numbered 0.
   */
  length?: number;
  /** Key signature in fifths (negative: flats); set where it changes. */
  key?: number;
  breakBefore?: 'system' | 'page';
  /** The barline at the end of the measure; `repeat-end` closes a repeated section (dots on its left). */
  barline?: 'single' | 'final' | 'double' | 'repeat-end';
  /** A repeat sign at the start of the measure (dots on the right of a thick-thin barline). */
  repeatStart?: true;
  /**
   * The volta (first, second ending ...) the measure belongs to: the numbers of the passes it is played
   * in. Neighboring measures with the same numbers share one bracket, which is closed at the right
   * (a hook) when the last of them ends in a repeat sign.
   */
  ending?: number[];
  staves: Record<string, StaffMeasure>;
}

export interface StaffDef {
  id: string;
  clef: Clef;
  /** The full name printed before the first system (`labelsFirst`), e.g. "Violin I". */
  name?: string;
  /** The abbreviated name printed before the other systems, e.g. "Vl. I". */
  abbr?: string;
}

export interface StaffGroup {
  kind: 'brace' | 'bracket';
  staves: string[];
}

export interface Meta {
  title?: string;
  subtitle?: string;
  composer?: string;
  rights?: string;
}

export interface PageSetup {
  /** Page size and margin in millimeters. */
  width: number;
  height: number;
  margin: number;
  /** Millimeters per staff space: the global engraving scale. */
  staffSpace: number;
  /** Undefined: number the first measure of every system but the first. */
  measureNumbers?: 'all' | 'none';
  /** Collapse runs of two or more empty measures into one multi-measure rest (engraving only; the measures stay in the model). */
  multiRests?: boolean;
  /** What the first system shows before its staves: the full names or the abbreviations (undefined: nothing). */
  labelsFirst?: 'full' | 'abbr';
  /** What every other system shows before its staves (undefined: nothing). */
  labelsLater?: 'full' | 'abbr';
  /** Font size of the staff labels in staff spaces (undefined: the default, 2). */
  labelSize?: number;
}

/** A position in the score: a measure (0-based index) and the tick within it (0 up to the measure's length). */
export interface Pos {
  mi: number;
  tick: number;
}

/** A control point of a performance curve. */
export interface CurvePoint {
  pos: Pos;
  value: number;
}

/** A stretch of the score during which the una corda pedal is down. */
export interface SoftRegion {
  from: Pos;
  to: Pos;
}

/**
 * How the score is played, as opposed to how it is written. The pedals are only found here: the pedal marks of the
 * notation are never played. The points of a curve are in score order.
 */
export interface Performance {
  /** A tempo ratio curve (a factor on the tempo, 1: as notated), a monotone cubic spline through the points, held flat beyond the first and last. */
  tempo?: CurvePoint[];
  /** The sustain pedal (CC64) from 0 (up) to 1 (down), a straight line between the points; up before the first point and held after the last. */
  sustain?: CurvePoint[];
  /** The una corda pedal (CC67): down inside each region. */
  soft?: SoftRegion[];
}

export interface Score {
  meta: Meta;
  page: PageSetup;
  staves: StaffDef[];
  groups: StaffGroup[];
  measures: Measure[];
  performance?: Performance;
}

/** Indices (into `score.staves`) of the staves of a group, ascending; staves that do not exist are skipped. */
export function groupStaffIndices(score: Score, g: StaffGroup): number[] {
  return g.staves
    .map((id) => score.staves.findIndex((s) => s.id === id))
    .filter((i) => i >= 0)
    .sort((x, y) => x - y);
}

// Helpers on the model: conversions between durations and ticks, flattening a voice's item tree
// into a list of events with their positions, and deriving the tick-based marks from the marks
// that hang on events.

/** The length of a duration in ticks, with its augmentation dots (each adds half of the previous part). */
export function baseTicks(d: Dur): number {
  let t = (PPQ * 4) / d.base;
  let add = t;
  for (let i = 0; i < d.dots; i++) {
    add /= 2;
    t += add;
  }
  return t;
}

/** The length of a measure of time signature `t` in ticks. */
export function measureTicks(t: TimeSig): number {
  return (t.beats * PPQ * 4) / t.beatType;
}

/** The length of measure `mi` in ticks: its own `length` (a pickup or short measure), else that of the time signature. */
export function lengthOf(score: Score, mi: number): number {
  return score.measures[mi].length ?? measureTicks(timeAt(score, mi));
}

/** The number printed for measure `mi`: a pickup in the first measure is number 0, the next measure is 1. */
export function measureLabel(score: Score, mi: number): number {
  return mi + (score.measures[0].length === undefined ? 1 : 0);
}

/** Type guard: whether an item is a tuplet group. */
export function isTuplet(i: Item): i is TupletGroup {
  return i.kind === 'tuplet';
}

/** Type guard: whether an item is an explicit beam group. */
export function isBeam(i: Item): i is BeamGroup {
  return i.kind === 'beam';
}

/** Type guard: whether an item is a tremolo group. */
export function isTremolo(i: Item): i is TremoloGroup {
  return i.kind === 'tremolo';
}

/** Type guard: whether an item is a note or rest. */
export function isEvent(i: Item): i is Event {
  return i.kind === 'note' || i.kind === 'rest';
}

export interface TimedEvent {
  ev: Event;
  start: number; // This is the number of ticks from the measure start.
  ticks: number;
  tm: { actual: number; normal: number }[]; // These are the enclosing tuplets, outermost first.
  tuplets: TupletGroup[]; // These are the enclosing tuplets, outermost first.
  beamGroup?: BeamGroup;
  tremolo?: TremoloGroup;
  index: number;
}

/** Flatten a voice into timed events (resolving tuplets). */
export function flattenVoice(v: Voice): TimedEvent[] {
  const out: TimedEvent[] = [];
  let t = 0;
  const walk = (items: Item[], tuplets: TupletGroup[], bg?: BeamGroup, tr?: TremoloGroup) => {
    for (const it of items) {
      if (isEvent(it)) {
        let ticks = baseTicks(it.dur);
        for (const tg of tuplets) ticks = (ticks * tg.normal) / tg.actual;
        if (!Number.isInteger(ticks)) throw new Error(`non-integer duration ${ticks}`);
        out.push({
          ev: it,
          start: t,
          ticks,
          tm: tuplets.map((x) => ({ actual: x.actual, normal: x.normal })),
          tuplets,
          beamGroup: bg,
          tremolo: tr,
          index: out.length,
        });
        t += ticks;
      } else if (isTuplet(it)) walk(it.items, [...tuplets, it], bg, tr);
      else if (isBeam(it)) walk(it.items, tuplets, it, tr);
      else walk(it.items, tuplets, bg, it);
    }
  };
  walk(v.items, []);
  return out;
}

/** The marks of a staff-measure with their ticks, in time order (ties: voice, then event). Uncached: use on drafts. */
export function collectMarks(sm: StaffMeasure): Mark[] {
  const out: Mark[] = [];
  for (const v of sm.voices) {
    const fl = flattenVoice(v);
    for (const te of fl)
      for (const [k, b] of (te.ev.marks ?? []).entries()) {
        out.push({ ...b, tick: te.start, voice: v.id, idx: te.index, k } as Mark);
      }
    const last = fl[fl.length - 1];
    const len = last ? last.start + last.ticks : 0;
    for (const [k, b] of (v.end ?? []).entries()) out.push({ ...b, tick: len, voice: v.id, idx: -1, k } as Mark);
  }
  return out.sort((a, b) => a.tick - b.tick);
}

const marksCache = new WeakMap<StaffMeasure, Mark[]>();

/** `collectMarks`, cached per staff-measure object (edits replace the objects they change), so mark objects are stable for hit testing. Never call it on an Immer draft. */
export function marksOf(sm: StaffMeasure | undefined): Mark[] {
  if (!sm) return [];
  let r = marksCache.get(sm);
  if (!r) {
    r = collectMarks(sm);
    marksCache.set(sm, r);
  }
  return r;
}

/**
 * Hang timed marks on events: the first voice with an event starting at the tick takes it, else the end of the first voice,
 * else (inside an event) the next event start. Mutates `sm`.
 */
export function anchorMarks(sm: StaffMeasure, marks: TimedMark[]): void {
  for (const { tick, ...b } of marks) {
    const body = b as MarkBody;
    let done = false;
    for (const v of sm.voices) {
      const te = flattenVoice(v).find((t) => t.start === tick);
      if (te) {
        te.ev.marks ??= [];
        te.ev.marks.push(body);
        done = true;
        break;
      }
    }
    if (done) continue;
    const v = sm.voices.find((x) => x.items.length > 0);
    if (!v) continue;
    const fl = flattenVoice(v);
    const next = fl.find((t) => t.start > tick);
    if (next) {
      next.ev.marks ??= [];
      next.ev.marks.push(body);
    } else {
      v.end ??= [];
      v.end.push(body);
    }
  }
}

/** One end of a line, positioned for pairing: `ord` orders the voices at one tick (staff index, then voice id); `ref` is whatever the caller wants back. */
export interface LineEnd<T> {
  mi: number;
  tick: number;
  ord: number;
  role: 'start' | 'stop';
  id: number;
  ref: T;
}

/**
 * Pairs the starts and stops of lines: in time order, an end meets an open end of the same id and the opposite role.
 * Ends that find no partner (or are replaced by another end of the same role and id) are `loose`.
 */
export function pairLines<T>(ends: LineEnd<T>[]): {
  pairs: { start: LineEnd<T>; stop: LineEnd<T> }[];
  loose: LineEnd<T>[];
} {
  const sorted = [...ends].sort((a, b) => a.mi - b.mi || a.tick - b.tick || a.ord - b.ord);
  const open = new Map<number, LineEnd<T>>();
  const pairs: { start: LineEnd<T>; stop: LineEnd<T> }[] = [];
  const loose: LineEnd<T>[] = [];
  for (const e of sorted) {
    const o = open.get(e.id);
    if (o && o.role !== e.role) {
      pairs.push(e.role === 'stop' ? { start: o, stop: e } : { start: e, stop: o });
      open.delete(e.id);
      continue;
    }
    if (o) loose.push(o);
    open.set(e.id, e);
  }
  loose.push(...open.values());
  return { pairs, loose };
}

/** Where a line end sits, as an event address. */
export interface LineAt {
  ev: Event;
  mi: number;
  staff: string;
  voice: number;
  idx: number;
}

/** Every start and stop of a line in the score, with the event it hangs on. */
export function lineEnds(score: Score): LineEnd<LineAt>[] {
  const out: LineEnd<LineAt>[] = [];
  score.measures.forEach((m, mi) => {
    score.staves.forEach((st, si) => {
      for (const v of m.staves[st.id]?.voices ?? [])
        for (const te of flattenVoice(v)) {
          const at = {
            mi,
            tick: te.start,
            ord: si * 1000 + v.id,
            ref: { ev: te.ev, mi, staff: st.id, voice: v.id, idx: te.index },
          };
          for (const x of te.ev.lineStart ?? []) out.push({ ...at, role: 'start', id: x.id });
          for (const x of te.ev.lineStop ?? []) out.push({ ...at, role: 'stop', id: x.id });
        }
    });
  });
  return out;
}

/** The total length of a voice in ticks (the end of its last event). */
export function voiceTicks(v: Voice): number {
  const f = flattenVoice(v);
  return f.length ? f[f.length - 1].start + f[f.length - 1].ticks : 0;
}

/** The MIDI note number of a pitch (c4 is 60). */
export function pitchMidi(p: Pitch): number {
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[p.step];
  return (p.octave + 1) * 12 + base + p.alter;
}

/** Diatonic position: c0 = 0, d0 = 1, ... */
export function pitchStep(p: Pitch): number {
  return p.octave * 7 + STEPS.indexOf(p.step);
}

/**
 * The measure whose time signature carries into measure `mi`: `mi - 1`, except at the start of a later volta,
 * which is played after the measure before the earlier voltas of its group, not after them. A volta continues the
 * group of the one before it when its numbers are all higher; -1 before the first measure.
 */
export function carriedFrom(measures: readonly Measure[], mi: number): number {
  const first = (e: number[]) => Math.min(...e);
  const last = (e: number[]) => Math.max(...e);
  let i = mi;
  let e = measures[i]?.ending;
  // Step back over whole voltas of the same group, from the start of one to the start of the one before.
  while (e && i > 0 && measures[i - 1].ending && !sameEnding(measures[i - 1].ending, e)) {
    const before = must(measures[i - 1].ending);
    if (first(e) <= last(before)) break;
    i--;
    while (i > 0 && sameEnding(measures[i - 1].ending, before)) i--;
    e = before;
  }
  return i === mi ? mi - 1 : i - 1;
}

/** Whether two `Measure.ending`s name the same passes. */
function sameEnding(a: number[] | undefined, b: number[] | undefined): boolean {
  return !!a && !!b && a.length === b.length && a.every((x, k) => x === b[k]);
}

/** The time signature in force at measure `mi` (4/4 before any is given); a later volta ignores the earlier ones. */
export function timeAt(score: Score, mi: number): TimeSig {
  for (let i = mi; i >= 0; i = carriedFrom(score.measures, i))
    if (score.measures[i].time) return must(score.measures[i].time);
  return { beats: 4, beatType: 4 };
}

/**
 * The time signature printed at the start of measure `mi` (not the first): one given there, or the one in force
 * when it differs from the one at the end of the measure before (the start of a later volta after an earlier
 * one that changed it).
 */
export function timeChangeAt(score: Score, mi: number): TimeSig | undefined {
  if (mi === 0) return undefined;
  const ts = timeAt(score, mi);
  if (score.measures[mi].time) return ts;
  const prev = timeAt(score, mi - 1);
  return prev.beats === ts.beats && prev.beatType === ts.beatType ? undefined : ts;
}

/** The key signature, in fifths, in force at measure `mi` (0 before any is given). */
export function keyAt(score: Score, mi: number): number {
  for (let i = mi; i >= 0; i--) if (score.measures[i].key !== undefined) return must(score.measures[i].key);
  return 0;
}

/** Problems with the groups (beams, tremolos) among `items`, recursively. */
function groupProblems(items: Item[], where: string): string[] {
  const errs: string[] = [];
  for (const it of items) {
    if (isEvent(it)) continue;
    const flat = flattenVoice({ id: 0, items: it.items });
    const notes = flat.filter((t) => t.ev.kind === 'note').length;
    if (isBeam(it) && notes < 2)
      errs.push(`${where}: beam group needs at least two notes (use \\nobeam to keep a note unbeamed)`);
    if (isTremolo(it) && (notes !== 2 || flat.length !== 2))
      errs.push(`${where}: tremolo must contain exactly two notes`);
    errs.push(...groupProblems(it.items, where));
  }
  return errs;
}

/** Problems with one voice of staff `sid` in a measure of `len` ticks. */
function voiceProblems(v: Voice, sid: string, at: string, len: number, staffIds: Set<string>): string[] {
  const errs: string[] = [];
  const here = `${at}.${v.id}`;
  for (const te of flattenVoice(v)) {
    if (te.ev.staff !== undefined && (!staffIds.has(te.ev.staff) || te.ev.staff === sid))
      errs.push(`${here}: bad cross-staff target ${te.ev.staff}`);
    errs.push(...expressionProblems(te.ev, here));
  }
  let ticks: number;
  try {
    ticks = voiceTicks(v);
  } catch (e) {
    return [...errs, `${here}: ${(e as Error).message}`];
  }
  if (ticks > len) errs.push(`${here}: voice too long (${ticks} > ${len})`);
  else if (ticks < len && ticks > 0) errs.push(`${here}: voice too short (${ticks} < ${len})`);
  errs.push(...groupProblems(v.items, here));
  return errs;
}

/** Whether a position lies inside the score. */
function posOk(score: Score, p: Pos): boolean {
  return (
    Number.isInteger(p.mi) &&
    p.mi >= 0 &&
    p.mi < score.measures.length &&
    Number.isInteger(p.tick) &&
    p.tick >= 0 &&
    p.tick <= lengthOf(score, p.mi)
  );
}

/** Whether position `a` is strictly before `b`. */
const posBefore = (a: Pos, b: Pos) => a.mi < b.mi || (a.mi === b.mi && a.tick < b.tick);

/** The label of a position in messages. */
const posLabel = (p: Pos) => `m. ${p.mi + 1}+${p.tick}`;

/** Problems with one performance curve: positions, order (strictly increasing) and the range of the values. */
function curveProblems(score: Score, name: string, pts: CurvePoint[], lo: number, hi: number): string[] {
  const errs: string[] = [];
  let prev: Pos | undefined;
  for (const pt of pts) {
    if (!posOk(score, pt.pos)) errs.push(`${name}: bad position ${posLabel(pt.pos)}`);
    else if (prev && !posBefore(prev, pt.pos))
      errs.push(`${name}: point ${posLabel(pt.pos)} is not after ${posLabel(prev)}`);
    if (!(pt.value >= lo && pt.value <= hi)) errs.push(`${name}: value ${pt.value} outside ${lo}..${hi}`);
    prev = pt.pos;
  }
  return errs;
}

/** Problems with the performance: curves in order and in range, soft regions inside the score, ordered and apart. */
function performanceProblems(score: Score, perf: Performance): string[] {
  const errs = [
    ...curveProblems(score, 'tempo curve', perf.tempo ?? [], 0.1, 10),
    ...curveProblems(score, 'sustain', perf.sustain ?? [], 0, 1),
  ];
  let prev: Pos | undefined;
  for (const r of perf.soft ?? []) {
    if (!(posOk(score, r.from) && posOk(score, r.to))) errs.push(`soft: bad region ${posLabel(r.from)}`);
    else if (!posBefore(r.from, r.to)) errs.push(`soft: region ${posLabel(r.from)} is empty`);
    else if (prev && posBefore(r.from, prev)) errs.push(`soft: region ${posLabel(r.from)} overlaps the one before`);
    else prev = r.to;
  }
  return errs;
}

/** Problems with the expression of the heads of an event (`vel`, `shift`, `gate`). */
function expressionProblems(ev: Event, at: string): string[] {
  const errs: string[] = [];
  if (ev.kind !== 'note') return errs;
  for (const np of ev.pitches) {
    if (np.vel !== undefined && !(Number.isInteger(np.vel) && np.vel >= 1 && np.vel <= 127))
      errs.push(`${at}: bad velocity ${np.vel}`);
    if (np.shift !== undefined && !(Number.isFinite(np.shift) && Math.abs(np.shift) <= 2000))
      errs.push(`${at}: bad shift ${np.shift}`);
    if (np.gate !== undefined && !(np.gate > 0 && np.gate <= 4)) errs.push(`${at}: bad gate ${np.gate}`);
  }
  return errs;
}

/** Structural checks; returns a list of problems. */
export function validate(score: Score): string[] {
  const errs: string[] = [];
  if (score.performance) errs.push(...performanceProblems(score, score.performance));
  const staffIds = new Set(score.staves.map((s) => s.id));
  score.measures.forEach((m, mi) => {
    const len = lengthOf(score, mi);
    if (m.length !== undefined && !(Number.isInteger(m.length) && m.length > 0))
      errs.push(`m. ${mi + 1}: invalid length ${m.length}`);
    for (const [sid, sm] of Object.entries(m.staves)) {
      const at = `m. ${mi + 1} ${sid}`;
      if (!staffIds.has(sid)) errs.push(`m. ${mi + 1}: unknown staff ${sid}`);
      for (const v of sm.voices) errs.push(...voiceProblems(v, sid, at, len, staffIds));
      for (const v of sm.voices)
        for (const b of v.end ?? [])
          if (b.type !== 'stop') errs.push(`${at}.${v.id}: only stops can sit at the end of a measure`);
    }
  });
  return errs;
}
