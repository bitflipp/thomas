// MusicXML (partwise) -> Score
//
// Import runs in stages: (1) metadata, page and the part/staff structure; (2) per measure and part,
// notes, rests and marks are read into flat `RawNote`s with absolute ticks, one list per staff and
// source voice; (3) each list becomes a voice item tree (`buildVoice`: gap filling, tuplet, tremolo
// and beam ranges nested into groups), with beams and brackets that the engraver's automatic choice
// reproduces left out again; (4) timed marks are hung on events (`anchorMarks`).
// Everything MuseScore-specific that is only a position or an automatic break is dropped on purpose.

import { beatTicks, simplifyBeams, simplifyTupletBrackets } from './beams.ts';

import type { Measure, NoteEvent, Score, StaffDef, TimedMark, TimeSig } from './model.ts';
import { anchorMarks, baseTicks, measureTicks } from './model.ts';
import type { MeasureSink, PartState, RawMark, ReadEnv } from './musicxml-measure.ts';
import { readPartMeasure } from './musicxml-measure.ts';
import type { RawNote } from './musicxml-raw.ts';
import { buildVoice, decomposeGap } from './musicxml-voice.ts';
import { must } from './util.ts';
import type { XNode } from './xml.ts';
import { child, children, parseXml, text } from './xml.ts';

export interface ImportOptions {
  /** Keep the stem directions of the source (by default they are left to the engraver). */
  keepStems?: boolean;
  /** Keep the source's system and page breaks (by default they are dropped). */
  keepBreaks?: boolean;
  /** Receives non-fatal problems (inconsistent durations, unsupported features). */
  warn?: (msg: string) => void;
}

export function importMusicXml(xml: string, opts: ImportOptions = {}): Score {
  const warn = opts.warn ?? (() => undefined);
  const root = parseXml(xml);
  if (root.tag !== 'score-partwise') throw new Error('only score-partwise MusicXML is supported');
  const meta = readMeta(root);
  const page = readPage(root);
  const { staves, groups, parts } = readParts(root);
  const read = readMeasures(parts, { keepStems: opts.keepStems, keepBreaks: opts.keepBreaks, warn, staves });
  const measures = buildMeasures(read, warn);
  return { meta, page, staves, groups, measures };
}

/** The visible <credit> texts first, <work>/<identification> as fallback. */
function readMeta(root: XNode): Score['meta'] {
  const meta: Score['meta'] = {};
  for (const c of children(root, 'credit')) {
    const type = text(c, 'credit-type');
    const words = children(c, 'credit-words')
      .map((w) => w.text.trim())
      .join(' ');
    if (!words) continue;
    if (type === 'title' && !meta.title) meta.title = words;
    else if (type === 'subtitle' && !meta.subtitle) meta.subtitle = words;
    else if (type === 'composer' && !meta.composer) meta.composer = words;
    else if (type === 'rights' && !meta.rights) meta.rights = words;
  }
  meta.title ??= text(child(root, 'work'), 'work-title');
  meta.composer ??= root.children
    .find((c) => c.tag === 'identification')
    ?.children.find((c) => c.tag === 'creator' && c.attrs.type === 'composer')
    ?.text.trim();
  meta.rights ??= text(child(root, 'identification'), 'rights');
  return meta;
}

/** Page size and staff space (mm per staff space) from <defaults>, converted from tenths. */
function readPage(root: XNode): Score['page'] {
  const defaults = child(root, 'defaults');
  const mm = Number(text(child(defaults, 'scaling'), 'millimeters') ?? 7);
  const tenths = Number(text(child(defaults, 'scaling'), 'tenths') ?? 40);
  const mmPerTenth = mm / tenths;
  const layout = child(defaults, 'page-layout');
  const width = Number(text(layout, 'page-width') ?? 1100);
  const height = Number(text(layout, 'page-height') ?? 1550);
  const margins = child(layout, 'page-margins');
  const margin = margins ? Number(text(margins, 'left-margin') ?? 50) * mmPerTenth : 10;
  return {
    width: round(width * mmPerTenth, 1),
    height: round(height * mmPerTenth, 1),
    margin: round(margin, 1),
    staffSpace: round(10 * mmPerTenth, 3),
  };
}

/** A part of the file with its measures. */
interface PartSource {
  state: PartState;
  measures: XNode[];
}

/**
 * A part with several staves (piano) becomes several staves of ours, joined by a brace (a bracket
 * unless it is a keyboard or harp); staff ids are generated in part order.
 */
function readParts(root: XNode): { staves: StaffDef[]; groups: Score['groups']; parts: PartSource[] } {
  const scoreParts = children(child(root, 'part-list'), 'score-part');
  const staves: StaffDef[] = [];
  const groups: Score['groups'] = [];
  const parts = children(root, 'part').map((p, index): PartSource => {
    const scorePart = scoreParts.find((s) => s.attrs.id === p.attrs.id);
    const sound = text(child(scorePart, 'score-instrument'), 'instrument-sound') ?? '';
    const staffCount = Number(text(child(child(p, 'measure'), 'attributes'), 'staves') ?? 1);
    const staffIds: string[] = [];
    for (let k = 0; k < staffCount; k++) {
      const id = `s${staves.length + 1}`;
      staffIds.push(id);
      staves.push({ id, clef: { sign: 'G', line: 2 }, name: text(scorePart, 'part-name') });
    }
    if (staffCount > 1)
      groups.push({ kind: sound.startsWith('keyboard') || /harp/.test(sound) ? 'brace' : 'bracket', staves: staffIds });
    return { state: { index, staffIds, divisions: 1 }, measures: children(p, 'measure') };
  });
  return { staves, groups, parts };
}

/** What the measure reader found, per measure. */
interface ReadMeasures {
  sinks: MeasureSink[];
}

/**
 * Every measure of every part is read into raw notes and timed marks. Voices are built from them
 * later, once all source voice numbers are known.
 */
function readMeasures(parts: PartSource[], env: ReadEnv): ReadMeasures {
  const count = Math.max(...parts.map((p) => p.measures.length));
  const sinks: MeasureSink[] = [];
  for (let mi = 0; mi < count; mi++) {
    const sink: MeasureSink = { measure: { staves: {} }, raws: new Map(), marks: [] };
    sinks.push(sink);
    for (const part of parts) {
      const mx = part.measures[mi];
      if (mx) readPartMeasure(mx, part.state, mi, sink, env);
    }
  }
  return { sinks };
}

/** Source voice numbers used per staff id, ascending; voices are renumbered 1..n per staff in this order (the source's numbers need not start at 1 on every staff). */
function voiceNumbers(sinks: MeasureSink[]): Map<string, number[]> {
  const numbers = new Map<string, number[]>();
  for (const { raws } of sinks)
    for (const key of raws.keys()) {
      const [staffId, voice] = key.split('|');
      const list = numbers.get(staffId) ?? [];
      if (!list.includes(Number(voice))) list.push(Number(voice));
      numbers.set(staffId, list);
    }
  for (const list of numbers.values()) list.sort((a, b) => a - b);
  return numbers;
}

/** Hangs the timed marks of a measure on the events they start at (`anchorMarks`), which is how marks are stored in the model. */
function anchorTimedMarks(measure: Measure, rawMarks: RawMark[]): void {
  const byStaff = new Map<string, TimedMark[]>();
  for (const { staffId, mark } of rawMarks) {
    const list = byStaff.get(staffId) ?? [];
    list.push(mark);
    byStaff.set(staffId, list);
  }
  for (const [staffId, marks] of byStaff)
    if (measure.staves[staffId])
      anchorMarks(
        measure.staves[staffId],
        marks.sort((a, b) => a.tick - b.tick),
      );
}

/** A note that crosses a cut becomes tied notes (rests: several rests), each inside one measure. */
function cutAcross(n: RawNote, mlen: number, number: number, warn: (msg: string) => void): RawNote[] {
  const cut = (Math.floor(n.tick / mlen) + 1) * mlen;
  if (n.tick + n.ticks <= cut) return [n];
  if (n.tmRatio || n.tupStart?.length || n.tupStop || n.trem) {
    warn(`m${number}: tuplet or tremolo note at tick ${n.tick} crosses the cut at ${cut}`);
    return [n];
  }
  const pieces: RawNote[] = [];
  let tick = n.tick;
  const end = n.tick + n.ticks;
  while (tick < end) {
    const len = Math.min(end, (Math.floor(tick / mlen) + 1) * mlen) - tick;
    for (const dur of decomposeGap(len)) {
      const first = tick === n.tick;
      const ticks = baseTicks(dur);
      const last = tick + ticks === end;
      const ev = structuredClone(n.ev);
      ev.dur = dur;
      if (!first) {
        delete ev.marks;
        delete ev.slurStart;
        delete ev.graces;
        delete (ev as { art?: unknown }).art;
        delete (ev as { arpeggio?: unknown }).arpeggio;
      }
      if (!last) delete ev.slurStop;
      if (ev.kind === 'note') {
        if (!last) for (const p of ev.pitches) p.tie = true;
        else if (!first)
          for (let i = 0; i < ev.pitches.length; i++) ev.pitches[i].tie = (n.ev as NoteEvent).pitches[i].tie;
      }
      const beam1 = first && n.beam1 === 'continue' ? 'end' : undefined;
      const piece: RawNote = { ...n, tick, ticks, ev };
      delete piece.tupStart;
      if (beam1) piece.beam1 = beam1;
      else delete piece.beam1;
      pieces.push(piece);
      tick += ticks;
    }
  }
  return pieces;
}

/**
 * A source measure longer than its time signature (an irregular bar, e.g. MuseScore's "actual duration")
 * cannot be a single model measure: it is cut into several at the nominal length. Notes must not cross
 * a cut; one that does is reported and dropped from the later piece.
 */
function splitOverfull(sink: MeasureSink, mlen: number, number: number, warn: (msg: string) => void): MeasureSink[] {
  let end = 0;
  for (const notes of sink.raws.values()) for (const n of notes) end = Math.max(end, n.tick + n.ticks);
  if (end <= mlen) return [sink];
  const count = Math.ceil(end / mlen);
  warn(`m${number}: ${end} ticks in a ${mlen}-tick measure, split into ${count} measures`);
  const parts: MeasureSink[] = Array.from({ length: count }, (_x, k) => ({
    measure: k === 0 ? sink.measure : { staves: {} },
    raws: new Map(),
    marks: [],
  }));
  // The barline belongs to the end of the source measure.
  const last = parts[count - 1].measure;
  if (sink.measure.barline) {
    last.barline = sink.measure.barline;
    delete sink.measure.barline;
  }
  for (const [key, notes] of sink.raws)
    for (const n of notes)
      for (const piece of cutAcross(n, mlen, number, warn)) {
        const k = Math.floor(piece.tick / mlen);
        const list = parts[k].raws.get(key) ?? [];
        parts[k].raws.set(key, list);
        list.push({ ...piece, tick: piece.tick - k * mlen });
      }
  for (const m of sink.marks) {
    const k = Math.min(Math.floor(m.mark.tick / mlen), count - 1);
    parts[k].marks.push({ ...m, mark: { ...m.mark, tick: m.mark.tick - k * mlen } });
  }
  return parts;
}

/** Raw notes become item trees, then the timed marks are hung on events. */
function buildMeasures(read: ReadMeasures, warn: (msg: string) => void): Measure[] {
  const numbers = voiceNumbers(read.sinks);
  let timeNow: TimeSig = { beats: 4, beatType: 4 };
  const sinks: MeasureSink[] = [];
  for (const sink of read.sinks) {
    if (sink.measure.time) timeNow = sink.measure.time;
    sinks.push(...splitOverfull(sink, measureTicks(timeNow), sinks.length + 1, warn));
  }
  timeNow = { beats: 4, beatType: 4 };
  const measures = sinks.map(({ measure, raws, marks }, mi) => {
    if (measure.time) timeNow = measure.time;
    const mlen = measureTicks(timeNow);
    for (const [key, notes] of raws) {
      const [staffId, sourceVoice] = key.split('|');
      const id = must(numbers.get(staffId)).indexOf(Number(sourceVoice)) + 1;
      const voice = { id, items: buildVoice(notes, mlen, mi + 1, warn) };
      // Leave out what the engraver's automatic beaming and bracket choice does anyway, so the text
      // format only states deliberate deviations.
      simplifyBeams(voice, beatTicks(timeNow));
      simplifyTupletBrackets(voice, beatTicks(timeNow));
      measure.staves[staffId] ??= { voices: [] };
      measure.staves[staffId].voices.push(voice);
    }
    for (const sm of Object.values(measure.staves)) sm.voices.sort((a, b) => a.id - b.id);
    anchorTimedMarks(measure, marks);
    return measure;
  });
  if (!measures[0].time) measures[0].time = timeNow;
  return measures;
}

/** Rounds to `d` decimals. */
function round(x: number, d: number): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
