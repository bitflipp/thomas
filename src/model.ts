import { must } from './util.ts';
// Core score model. The model (plain JSON-serialisable data) is the source of truth; the text format
// (textformat.ts) and the MusicXML importer produce and consume it, the engraver and playback read it,
// and the editor changes it only through pure functions (src/editor/commands.ts).
//
// Time is measured in integer ticks so that no rounding ever happens in rhythm arithmetic. Structure:
// Score > Measure > StaffMeasure (per staff id) > Voice > Item tree. Marks (dynamics, hairpins, pedal,
// ...) are not stored with ticks but hang on the events they start at; see `marksOf`.

/** Ticks per quarter note: divisible by 2^5, 3, 5 and 7, so undotted 128th notes and tuplets up to septuplets are exact integers (a dotted 128th would be 157.5 ticks: not allowed). */
export const PPQ = 3360;

export type Step = 'c' | 'd' | 'e' | 'f' | 'g' | 'a' | 'b';
export const STEPS: Step[] = ['c', 'd', 'e', 'f', 'g', 'a', 'b'];

export interface Pitch {
  step: Step;
  alter: number; // -2..2 (semitones)
  octave: number; // scientific pitch notation, c4 = middle C
}

export type BaseDur = 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128;
export interface Dur {
  base: BaseDur;
  dots: number;
}

export type AccOverride = 'force' | 'cautionary';
export interface NotePitch {
  pitch: Pitch;
  tie?: boolean; // tied to the next note of the same pitch
  acc?: AccOverride;
}

export type Articulation = 'accent' | 'marcato' | 'staccato';
export interface SlurStart {
  id: number;
  side?: 'above' | 'below';
}

/** A grace note (or chord) played just before the note it is attached to; takes no time in the measure. */
export interface Grace {
  pitches: NotePitch[];
  base: BaseDur; // written value: 8 = one flag, 16 = two ...
  slash?: boolean; // acciaccatura (struck through) rather than appoggiatura
}

export interface EventBase {
  dur: Dur;
  stem?: 'up' | 'down';
  staff?: string; // cross-staff: drawn on this other staff (default: the staff of the voice); stem and beam stay with the voice
  slurStart?: SlurStart[];
  slurStop?: number[];
  marks?: MarkBody[]; // dynamics, hairpin/pedal/ottava starts and stops, clef changes, tempo, text: at the start of this event
}
export interface NoteEvent extends EventBase {
  kind: 'note';
  pitches: NotePitch[]; // ordered low -> high
  art?: Articulation[];
  artSide?: 'above' | 'below'; // forced side of the articulations (default: by stem / voice)
  arpeggio?: boolean;
  graces?: Grace[]; // grace notes in front of this note, in playing order
  noBeam?: boolean; // stays unbeamed although the automatic beaming would join it to its neighbours
}
export type RestStyle = 'normal' | 'hidden' | 'measure'; // hidden = spacer; measure = whole-measure rest (dur is informational)
export interface RestEvent extends EventBase {
  kind: 'rest';
  style: RestStyle;
  display?: Pitch; // forced vertical position
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

export type Placement = 'above' | 'below';
/** Dynamics, hairpins and text can also sit `between` their staff and its neighbour (below the upper one, above the lower one), centred in the gap: for piano parts, where one dynamic serves both hands. */
export type MarkPlacement = Placement | 'between';
export type MarkBody =
  | { type: 'dynamic'; text: string; placement?: MarkPlacement }
  | { type: 'hairpin'; kind: 'cresc' | 'dim'; id: number; placement?: MarkPlacement }
  /** Pedal press; a press while the pedal is down is a change (release and press again). */
  | { type: 'pedal' }
  /** `up` = 8va: written an octave lower than it sounds, line above the staff. */
  | { type: 'ottava'; dir: 'up' | 'down' }
  | { type: 'stop'; of: 'pedal' | 'ottava' }
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
  /** Key signature in fifths (negative: flats); set where it changes. */
  key?: number;
  breakBefore?: 'system' | 'page';
  barline?: 'single' | 'final' | 'double';
  staves: Record<string, StaffMeasure>;
}

export interface StaffDef {
  id: string;
  clef: Clef;
  name?: string;
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
  /** Page size and margin in millimetres. */
  width: number;
  height: number;
  margin: number;
  /** Millimetres per staff space: the global engraving scale. */
  staffSpace: number;
  /** Undefined: number the first measure of every system but the first. */
  measureNumbers?: 'all' | 'none';
}

export interface Score {
  meta: Meta;
  page: PageSetup;
  staves: StaffDef[];
  groups: StaffGroup[];
  measures: Measure[];
}

// ---------------------------------------------------------------- helpers: durations, flattening, marks

export function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : Math.abs(a);
}

export function baseTicks(d: Dur): number {
  let t = (PPQ * 4) / d.base;
  let add = t;
  for (let i = 0; i < d.dots; i++) {
    add /= 2;
    t += add;
  }
  return t;
}

export function measureTicks(t: TimeSig): number {
  return (t.beats * PPQ * 4) / t.beatType;
}

export function isTuplet(i: Item): i is TupletGroup {
  return i.kind === 'tuplet';
}
export function isBeam(i: Item): i is BeamGroup {
  return i.kind === 'beam';
}
export function isTremolo(i: Item): i is TremoloGroup {
  return i.kind === 'tremolo';
}
export function isEvent(i: Item): i is Event {
  return i.kind === 'note' || i.kind === 'rest';
}

export interface TimedEvent {
  ev: Event;
  start: number; // ticks from measure start
  ticks: number;
  tm: { actual: number; normal: number }[]; // enclosing tuplets, outermost first
  tuplets: TupletGroup[]; // enclosing tuplets, outermost first
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

export function voiceTicks(v: Voice): number {
  const f = flattenVoice(v);
  return f.length ? f[f.length - 1].start + f[f.length - 1].ticks : 0;
}

export function pitchMidi(p: Pitch): number {
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[p.step];
  return (p.octave + 1) * 12 + base + p.alter;
}
/** Diatonic position: c0 = 0, d0 = 1, ... */
export function pitchStep(p: Pitch): number {
  return p.octave * 7 + STEPS.indexOf(p.step);
}

export function timeAt(score: Score, mi: number): TimeSig {
  for (let i = mi; i >= 0; i--) if (score.measures[i].time) return must(score.measures[i].time);
  return { beats: 4, beatType: 4 };
}
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
  for (const te of flattenVoice(v))
    if (te.ev.staff !== undefined && (!staffIds.has(te.ev.staff) || te.ev.staff === sid))
      errs.push(`${here}: bad cross-staff target ${te.ev.staff}`);
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

/** Structural checks; returns a list of problems. */
export function validate(score: Score): string[] {
  const errs: string[] = [];
  const staffIds = new Set(score.staves.map((s) => s.id));
  score.measures.forEach((m, mi) => {
    const len = measureTicks(timeAt(score, mi));
    for (const [sid, sm] of Object.entries(m.staves)) {
      const at = `m${mi + 1} ${sid}`;
      if (!staffIds.has(sid)) errs.push(`m${mi + 1}: unknown staff ${sid}`);
      for (const v of sm.voices) errs.push(...voiceProblems(v, sid, at, len, staffIds));
      for (const v of sm.voices)
        for (const b of v.end ?? [])
          if (b.type !== 'stop') errs.push(`${at}.${v.id}: only stops can sit at the end of a measure`);
    }
  });
  return errs;
}
