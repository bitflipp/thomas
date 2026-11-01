// Core score model. The model (JSON-serialisable) is the source of truth;
// the text format (textformat.ts) and MusicXML import produce/consume it.

export const PPQ = 3360; // ticks per quarter note (divisible by 2^5, 3, 5, 7)

export type Step = 'c' | 'd' | 'e' | 'f' | 'g' | 'a' | 'b';
export const STEPS: Step[] = ['c', 'd', 'e', 'f', 'g', 'a', 'b'];

export interface Pitch {
  step: Step;
  alter: number; // -2..2 (semitones)
  octave: number; // scientific pitch notation, c4 = middle C
}

export type BaseDur = 1 | 2 | 4 | 8 | 16 | 32 | 64;
export interface Dur { base: BaseDur; dots: number }

export type AccOverride = 'force' | 'cautionary';
export interface NotePitch {
  pitch: Pitch;
  tie?: boolean; // tied to the next note of the same pitch
  acc?: AccOverride;
}

export type Articulation = 'accent' | 'marcato' | 'staccato';
export interface SlurStart { id: number; side?: 'above' | 'below' }

export interface EventBase {
  dur: Dur;
  stem?: 'up' | 'down';
  slurStart?: SlurStart[];
  slurStop?: number[];
}
export interface NoteEvent extends EventBase {
  kind: 'note';
  pitches: NotePitch[]; // ordered low -> high
  art?: Articulation[];
  artSide?: 'above' | 'below'; // forced side of the articulations (default: by stem / voice)
  arpeggio?: boolean;
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
  bracket?: boolean; // undefined = automatic
  number?: 'actual' | 'none';
  label?: number; // displayed number if different from `actual`
  placement?: 'above' | 'below';
  items: Item[];
}
// Explicit beam group (events must be consecutive in the voice, possibly inside tuplets) with at least two notes.
// Events outside explicit groups are beamed automatically (see beams.ts); `noBeam` opts a note out.
export interface BeamGroup { kind: 'beam'; items: Item[] }
// Two-note (fingered) tremolo: exactly two notes, drawn as `beams` beams between them.
export interface TremoloGroup { kind: 'tremolo'; beams: number; items: Item[] }
export type Item = Event | TupletGroup | BeamGroup | TremoloGroup;

export interface Voice { id: number; items: Item[] }

export type Placement = 'above' | 'below';
export type MarkBody =
  | { type: 'dynamic'; text: string; placement?: Placement }
  | { type: 'hairpin'; kind: 'cresc' | 'dim'; id: number; placement?: Placement }
  | { type: 'pedal' } // press; a press while the pedal is down is a change
  | { type: 'ottava'; dir: 'up' | 'down' } // up = 8va (written lower than sounding, line above the staff)
  | { type: 'stop'; of: 'pedal' | 'ottava' }
  | { type: 'stop'; of: 'hairpin'; id: number }
  | { type: 'clef'; clef: Clef }
  | { type: 'tempo'; unit: BaseDur; dots: number; bpm: number; text?: string }
  | { type: 'text'; text: string; placement?: Placement };
export type Mark = MarkBody & { tick: number }; // tick within the measure

export interface StaffMeasure { voices: Voice[]; marks: Mark[] }

export interface TimeSig { beats: number; beatType: number }
export interface Clef { sign: 'G' | 'F' | 'C'; line: number; octave?: number }

export interface Measure {
  time?: TimeSig; // set when changed (always set on first measure)
  key?: number; // fifths; set when changed
  breakBefore?: 'system' | 'page';
  barline?: 'single' | 'final' | 'double';
  staves: Record<string, StaffMeasure>;
}

export interface StaffDef { id: string; clef: Clef; name?: string }
export interface StaffGroup { kind: 'brace' | 'bracket'; staves: string[] }

export interface Meta { title?: string; subtitle?: string; composer?: string; rights?: string }
export interface PageSetup {
  width: number; height: number; // mm
  margin: number; // mm
  staffSpace: number; // mm per staff space
}

export interface Score {
  meta: Meta;
  page: PageSetup;
  staves: StaffDef[];
  groups: StaffGroup[];
  measures: Measure[];
}

// ---------------------------------------------------------------- helpers

export function gcd(a: number, b: number): number { return b ? gcd(b, a % b) : Math.abs(a); }

export function baseTicks(d: Dur): number {
  let t = (PPQ * 4) / d.base;
  let add = t;
  for (let i = 0; i < d.dots; i++) { add /= 2; t += add; }
  return t;
}

export function measureTicks(t: TimeSig): number { return (t.beats * PPQ * 4) / t.beatType; }

export function isTuplet(i: Item): i is TupletGroup { return i.kind === 'tuplet'; }
export function isBeam(i: Item): i is BeamGroup { return i.kind === 'beam'; }
export function isTremolo(i: Item): i is TremoloGroup { return i.kind === 'tremolo'; }
export function isEvent(i: Item): i is Event { return i.kind === 'note' || i.kind === 'rest'; }

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
        out.push({ ev: it, start: t, ticks, tm: tuplets.map((x) => ({ actual: x.actual, normal: x.normal })), tuplets, beamGroup: bg, tremolo: tr, index: out.length });
        t += ticks;
      } else if (isTuplet(it)) walk(it.items, [...tuplets, it], bg, tr);
      else if (isBeam(it)) walk(it.items, tuplets, it, tr);
      else walk(it.items, tuplets, bg, it);
    }
  };
  walk(v.items, []);
  return out;
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
export function pitchStep(p: Pitch): number { return p.octave * 7 + STEPS.indexOf(p.step); }

export function timeAt(score: Score, mi: number): TimeSig {
  for (let i = mi; i >= 0; i--) if (score.measures[i].time) return score.measures[i].time!;
  return { beats: 4, beatType: 4 };
}
export function keyAt(score: Score, mi: number): number {
  for (let i = mi; i >= 0; i--) if (score.measures[i].key !== undefined) return score.measures[i].key!;
  return 0;
}

/** Structural checks; returns a list of problems. */
export function validate(score: Score): string[] {
  const errs: string[] = [];
  const ids = new Set(score.staves.map((s) => s.id));
  const groupErrs = (items: Item[], where: string) => {
    for (const it of items) {
      if (isEvent(it)) continue;
      const flat = flattenVoice({ id: 0, items: it.items });
      const notes = flat.filter((t) => t.ev.kind === 'note').length;
      if (isBeam(it) && notes < 2) errs.push(`${where}: beam group needs at least two notes (use \\nobeam to keep a note unbeamed)`);
      if (isTremolo(it) && (notes !== 2 || flat.length !== 2)) errs.push(`${where}: tremolo must contain exactly two notes`);
      groupErrs(it.items, where);
    }
  };
  score.measures.forEach((m, mi) => {
    const len = measureTicks(timeAt(score, mi));
    for (const [sid, sm] of Object.entries(m.staves)) {
      const at = `m${mi + 1} ${sid}`;
      if (!ids.has(sid)) errs.push(`m${mi + 1}: unknown staff ${sid}`);
      for (const v of sm.voices) {
        let t: number;
        try { t = voiceTicks(v); } catch (e) { errs.push(`${at}.${v.id}: ${(e as Error).message}`); continue; }
        if (t > len) errs.push(`${at}.${v.id}: voice too long (${t} > ${len})`);
        else if (t < len && t > 0) errs.push(`${at}.${v.id}: voice too short (${t} < ${len})`);
        groupErrs(v.items, `${at}.${v.id}`);
      }
      for (const mk of sm.marks) if (mk.tick < 0 || mk.tick > len) errs.push(`${at}: mark outside measure`);
    }
  });
  return errs;
}
