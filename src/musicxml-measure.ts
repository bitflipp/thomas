// MusicXML measure reader: one measure of one part -> raw notes (per staff and source voice) and
// timed marks, with absolute ticks inside the measure. Voices are built from them later.

import type {
  Articulation,
  Clef,
  Dur,
  Grace,
  Measure,
  NoteEvent,
  NotePitch,
  Pitch,
  RestEvent,
  StaffDef,
  Step,
  TimedMark,
} from './model.ts';

import { PPQ, STEPS } from './model.ts';
import type { RawNote, TupletStart } from './musicxml-raw.ts';
import { TYPE_BASE, ticksToDur } from './musicxml-raw.ts';
import { must } from './util.ts';
import type { XNode } from './xml.ts';
import { child, children, text } from './xml.ts';

export interface ReadEnv {
  keepStems?: boolean;
  keepBreaks?: boolean;
  warn: (msg: string) => void;
  /** The staves of the score being built; the clef at the start of the piece is written into them. */
  staves: StaffDef[];
}

/** A part of the file; its `divisions` (ticks per quarter in the source) can change from measure to measure. */
export interface PartState {
  index: number;
  staffIds: string[];
  divisions: number;
}

export interface RawMark {
  staffId: string;
  mark: TimedMark;
}

/** Where a measure's readings go. */
export interface MeasureSink {
  measure: Measure;
  /** Raw notes keyed `staffId|sourceVoice`. */
  raws: Map<string, RawNote[]>;
  marks: RawMark[];
}

/** The state of reading one measure of one part. */
interface Reader {
  env: ReadEnv;
  part: PartState;
  sink: MeasureSink;
  /** 0-based measure index. */
  mi: number;
  /** Position in the measure in source divisions. */
  cursor: number;
  prev?: RawNote;
  /** Per source voice: grace notes read but not yet attached, because they come before the note they belong to. */
  pendingGraces: Map<number, Grace[]>;
  /**
   * Per source voice: the staff of its first note. A later note on another staff is a cross-staff
   * note: it stays in its voice (stem, beam, slurs) and only its heads are drawn on the other staff.
   */
  homeStaff: Map<number, number>;
}

/** Reads one measure of a part into `sink`. */
export function readPartMeasure(mx: XNode, part: PartState, mi: number, sink: MeasureSink, env: ReadEnv): void {
  const r: Reader = { env, part, sink, mi, cursor: 0, pendingGraces: new Map(), homeStaff: new Map() };
  if (part.index === 0 && mx.attrs.implicit === 'yes')
    env.warn(`m${mi + 1}: implicit (pickup) measure not specially handled`);
  for (const el of mx.children) {
    switch (el.tag) {
      case 'attributes':
        readAttributes(r, el);
        break;
      case 'backup':
        r.cursor -= Number(text(el, 'duration'));
        break;
      case 'forward':
        r.cursor += Number(text(el, 'duration'));
        break;
      case 'print':
        readPrint(r, el);
        break;
      case 'barline':
        readBarline(r, el);
        break;
      case 'direction':
        readDirection(r, el);
        break;
      case 'note':
        readNote(r, el);
        break;
    }
  }
  if (r.pendingGraces.size) env.warn(`m${mi + 1}: grace notes at the end of a measure dropped`);
}

const isFirstPart = (r: Reader) => r.part.index === 0;
const staffIdOf = (r: Reader, n: number) => r.part.staffIds[Math.max(0, n - 1)];

/** Source divisions -> ticks. */
function ticksOf(r: Reader, div: number): number {
  const x = (div * PPQ) / r.part.divisions;
  if (!Number.isInteger(x)) throw new Error(`m${r.mi + 1}: duration ${div}/${r.part.divisions} not representable`);
  return x;
}

function readAttributes(r: Reader, el: XNode): void {
  const { measure, marks } = r.sink;
  const divisions = text(el, 'divisions');
  if (divisions) r.part.divisions = Number(divisions);
  const key = child(el, 'key');
  if (key && isFirstPart(r)) measure.key = Number(text(key, 'fifths') ?? 0);
  const time = child(el, 'time');
  if (time && isFirstPart(r))
    measure.time = { beats: Number(text(time, 'beats')), beatType: Number(text(time, 'beat-type')) };
  for (const c of children(el, 'clef')) {
    const clef: Clef = { sign: text(c, 'sign') as Clef['sign'], line: Number(text(c, 'line') ?? 2) };
    const octaveChange = text(c, 'clef-octave-change');
    if (octaveChange) clef.octave = Number(octaveChange);
    const id = staffIdOf(r, Number(c.attrs.number ?? 1));
    if (r.mi === 0 && r.cursor === 0) must(r.env.staves.find((s) => s.id === id)).clef = clef;
    else marks.push({ staffId: id, mark: { type: 'clef', clef, tick: ticksOf(r, r.cursor) } });
  }
}

/** Page and system breaks, only when asked for. */
function readPrint(r: Reader, el: XNode): void {
  if (!(isFirstPart(r) && r.env.keepBreaks)) return;
  if (el.attrs['new-page'] === 'yes') r.sink.measure.breakBefore = 'page';
  else if (el.attrs['new-system'] === 'yes' && r.mi > 0) r.sink.measure.breakBefore = 'system';
}

function readBarline(r: Reader, el: XNode): void {
  if (!isFirstPart(r)) return;
  const style = text(el, 'bar-style');
  if (style === 'light-heavy') r.sink.measure.barline = 'final';
  else if (style === 'light-light') r.sink.measure.barline = 'double';
}

/** The marks a <direction-type> child stands for; null if it is not supported (`<sound>` is ignored silently). */
function directionMarks(d: XNode, placement: 'above' | 'below' | undefined, tick: number): TimedMark[] | null {
  const above = placement === 'above' ? 'above' : undefined;
  switch (d.tag) {
    case 'dynamics': {
      const name = d.children[0]?.tag;
      if (!name) return [];
      return [
        { type: 'dynamic', text: name === 'other-dynamics' ? d.children[0].text.trim() : name, placement: above, tick },
      ];
    }
    case 'wedge': {
      const id = Number(d.attrs.number ?? 1);
      if (d.attrs.type === 'stop') return [{ type: 'stop', of: 'hairpin', id, tick }];
      return [{ type: 'hairpin', kind: d.attrs.type === 'crescendo' ? 'cresc' : 'dim', id, placement: above, tick }];
    }
    case 'pedal': {
      const ty = d.attrs.type;
      const marks: TimedMark[] = [];
      if (ty === 'stop' || ty === 'change') marks.push({ type: 'stop', of: 'pedal', tick });
      if (ty === 'start' || ty === 'change') marks.push({ type: 'pedal', tick });
      return marks;
    }
    case 'octave-shift':
      if (d.attrs.size && d.attrs.size !== '8') throw new Error(`octave-shift size ${d.attrs.size} unsupported`);
      if (d.attrs.type === 'stop') return [{ type: 'stop', of: 'ottava', tick }];
      return [{ type: 'ottava', dir: d.attrs.type === 'down' ? 'up' : 'down', tick }];
    case 'metronome': {
      const unit = TYPE_BASE[text(d, 'beat-unit') ?? 'quarter'];
      const dots = children(d, 'beat-unit-dot').length;
      const bpm = Number(text(d, 'per-minute'));
      return unit && bpm ? [{ type: 'tempo', unit, dots, bpm, tick }] : [];
    }
    case 'words':
      return [{ type: 'text', text: d.text.trim(), placement: placement === 'below' ? 'below' : undefined, tick }];
    case 'sound':
      return [];
    default:
      return null;
  }
}

function readDirection(r: Reader, el: XNode): void {
  const staffId = staffIdOf(r, Number(text(el, 'staff') ?? 1));
  const tick = ticksOf(r, r.cursor);
  const placement = el.attrs.placement as 'above' | 'below' | undefined;
  for (const directionType of children(el, 'direction-type'))
    for (const d of directionType.children) {
      const marks = directionMarks(d, placement, tick);
      if (!marks) r.env.warn(`m${r.mi + 1}: unsupported direction <${d.tag}>`);
      else for (const mark of marks) r.sink.marks.push({ staffId, mark });
    }
}

/** A grace note is collected and attached to the next note of its voice. */
function readGraceNote(r: Reader, el: XNode, slash: boolean, voice: number): void {
  if (!child(el, 'pitch')) return;
  const graces = r.pendingGraces.get(voice) ?? [];
  r.pendingGraces.set(voice, graces);
  if (child(el, 'chord') && graces.length) {
    graces[graces.length - 1].pitches.push(readPitch(el, r.mi));
    return;
  }
  const typeName = text(el, 'type');
  graces.push({
    pitches: [readPitch(el, r.mi)],
    base: typeName && TYPE_BASE[typeName] ? TYPE_BASE[typeName] : 8,
    ...(slash ? { slash: true } : {}),
  });
}

/** The written duration of a note: from its <type> if there is one, else from the sounding duration. */
function writtenDur(r: Reader, el: XNode, soundingDivisions: number): Dur {
  const typeName = text(el, 'type');
  if (typeName && TYPE_BASE[typeName]) return { base: TYPE_BASE[typeName], dots: children(el, 'dot').length };
  return ticksToDur(ticksOf(r, soundingDivisions)) ?? { base: 1, dots: 0 };
}

function restEvent(rest: XNode, dur: Dur): RestEvent {
  const ev: RestEvent = { kind: 'rest', style: rest.attrs.measure === 'yes' ? 'measure' : 'normal', dur };
  const step = text(rest, 'display-step');
  const octave = text(rest, 'display-octave');
  if (step && octave) ev.display = { step: step.toLowerCase() as Step, alter: 0, octave: Number(octave) };
  return ev;
}

/** Tuplets: <tuplet type=start/stop> notations say where a tuplet begins and ends and how it is displayed; the ratio itself comes from <time-modification> on each member note. */
function readTupletNotations(el: XNode): Pick<RawNote, 'tupStart' | 'tupStop'> {
  const out: Pick<RawNote, 'tupStart' | 'tupStop'> = { tupStop: 0 };
  for (const tup of children(child(el, 'notations'), 'tuplet')) {
    if (tup.attrs.type !== 'start') {
      out.tupStop++;
      continue;
    }
    const o: TupletStart = {};
    if (tup.attrs.bracket) o.bracket = tup.attrs.bracket === 'yes';
    if (tup.attrs['show-number'] === 'none') o.number = 'none';
    if (tup.attrs.placement) o.placement = tup.attrs.placement as 'above' | 'below';
    const label = text(child(tup, 'tuplet-actual'), 'tuplet-number');
    if (label) o.label = Number(label);
    out.tupStart ??= [];
    out.tupStart.push(o);
  }
  return out;
}

function readNote(r: Reader, el: XNode): void {
  const duration = Number(text(el, 'duration') ?? 0);
  const staffN = Number(text(el, 'staff') ?? 1);
  const voice = Number(text(el, 'voice') ?? 1);
  if (!r.homeStaff.has(voice)) r.homeStaff.set(voice, staffN);
  const graceEl = child(el, 'grace');
  if (graceEl) {
    readGraceNote(r, el, graceEl.attrs.slash === 'yes', voice);
    return;
  }
  const isChord = !!child(el, 'chord');
  if (isChord && r.prev) {
    const ev = r.prev.ev as NoteEvent;
    ev.pitches.push(readPitch(el, r.mi));
    readNotations(el, ev, true);
    return;
  }
  const homeId = staffIdOf(r, must(r.homeStaff.get(voice)));
  const rest = child(el, 'rest');
  const dur = writtenDur(r, el, duration);
  const raw: RawNote = {
    tick: ticksOf(r, r.cursor),
    ticks: ticksOf(r, duration),
    staff: staffN,
    voice,
    ev: undefined as unknown as RawNote['ev'],
    ...readTupletNotations(el),
  };
  if (rest) raw.ev = restEvent(rest, dur);
  else {
    const ev: NoteEvent = { kind: 'note', dur, pitches: [readPitch(el, r.mi)] };
    const graces = r.pendingGraces.get(voice);
    if (graces) {
      ev.graces = graces;
      r.pendingGraces.delete(voice);
    }
    raw.trem = readNotations(el, ev, false);
    raw.ev = ev;
  }
  const timeModification = child(el, 'time-modification');
  if (timeModification)
    raw.tmRatio = [Number(text(timeModification, 'actual-notes')), Number(text(timeModification, 'normal-notes'))];
  if (!isChord && staffIdOf(r, staffN) !== homeId) raw.ev.staff = staffIdOf(r, staffN); // This note is a cross-staff note.
  const stem = text(el, 'stem');
  if (r.env.keepStems && (stem === 'up' || stem === 'down')) raw.ev.stem = stem;
  raw.beam1 = children(el, 'beam')
    .find((b) => b.attrs.number === '1')
    ?.text.trim();
  const key = `${homeId}|${voice}`;
  const list = r.sink.raws.get(key) ?? [];
  list.push(raw);
  r.sink.raws.set(key, list);
  r.prev = raw;
  r.cursor += duration;
}

/** The pitch of a <note>; a `cautionary` accidental in the source becomes a forced one. */
function readPitch(el: XNode, mi: number): NotePitch {
  const p = child(el, 'pitch');
  if (!p) throw new Error(`m${mi + 1}: unpitched notes not supported`);
  const step = must(text(p, 'step')).toLowerCase() as Step;
  if (!STEPS.includes(step)) throw new Error('bad step');
  const pitch: Pitch = { step, alter: Number(text(p, 'alter') ?? 0), octave: Number(text(p, 'octave')) };
  if (!Number.isInteger(pitch.alter)) throw new Error(`m${mi + 1}: microtones unsupported`);
  const np: NotePitch = { pitch };
  if (children(el, 'tie').some((t) => t.attrs.type === 'start')) np.tie = true;
  const acc = child(el, 'accidental');
  if (acc?.attrs.cautionary === 'yes') np.acc = 'force';
  return np;
}

function readSlurs(notations: XNode, ev: NoteEvent): void {
  for (const s of children(notations, 'slur')) {
    const id = Number(s.attrs.number ?? 1);
    if (s.attrs.type === 'start') {
      const side = (s.attrs.placement ??
        (s.attrs.orientation === 'over' ? 'above' : s.attrs.orientation === 'under' ? 'below' : undefined)) as
        | 'above'
        | 'below'
        | undefined;
      ev.slurStart ??= [];
      ev.slurStart.push(side ? { id, side } : { id });
    } else if (s.attrs.type === 'stop') {
      ev.slurStop ??= [];
      ev.slurStop.push(id);
    }
  }
}

const ARTICULATION_TAGS: Record<string, Articulation> = {
  accent: 'accent',
  'strong-accent': 'marcato',
  staccato: 'staccato',
};

function readArticulations(articulations: XNode, ev: NoteEvent): void {
  const list = articulations.children.flatMap((a) =>
    Object.hasOwn(ARTICULATION_TAGS, a.tag) ? [ARTICULATION_TAGS[a.tag]] : [],
  );
  if (!list.length) return;
  ev.art = list;
  const side = articulations.children.map((a) => a.attrs.placement).find((x) => x === 'above' || x === 'below');
  if (side) ev.artSide = side as 'above' | 'below';
}

/** Reads slurs, arpeggio, articulations and tremolo from <notations> into `ev`. Only the first note of a chord carries slurs and articulations. Returns a two-note tremolo's role, if any. */
function readNotations(el: XNode, ev: NoteEvent | RestEvent, isChord: boolean): RawNote['trem'] {
  if (ev.kind !== 'note') return;
  const notations = child(el, 'notations');
  if (!notations) return;
  if (!isChord) readSlurs(notations, ev);
  if (child(notations, 'arpeggiate')) ev.arpeggio = true;
  const articulations = child(notations, 'articulations');
  if (articulations && !isChord) readArticulations(articulations, ev);
  const tremolo = child(child(notations, 'ornaments'), 'tremolo');
  if (tremolo && (tremolo.attrs.type === 'start' || tremolo.attrs.type === 'stop') && !isChord)
    return { role: tremolo.attrs.type, beams: Number(tremolo.text.trim() || 2) };
}
