// Score -> timed MIDI messages. Headless: no browser APIs, so it can be tested with node --test.
//
// Three passes: a tempo map (the notated tempi, the fermatas and the performance's tempo curve) turns
// score ticks into seconds; each staff's notes are collected as sounding intervals (ties merged,
// ornaments such as graces, tremolo and arpeggio expanded, dynamics and hairpins turned into velocity,
// then the expression of the heads: velocity, gate); finally the intervals become note-on/off messages
// (a head's shift moves its attack in milliseconds), plus the pedals, sorted by time. The pedals come
// only from the score's performance (`Score.performance`): the pedal marks of the notation are never
// played. Every staff gets its own MIDI channel (`channelOf`), so a synth can give the staves
// different instruments.

import { keyAlter } from '../engrave/prep.ts';

import type {
  CurvePoint,
  Grace,
  NoteEvent,
  Ornament,
  Pitch,
  Pos,
  Score,
  TimedEvent,
  TremoloGroup,
  Voice,
} from '../model.ts';

import { baseTicks, flattenVoice, keyAt, marksOf, measureTicks, PPQ, pitchMidi, STEPS, timeAt } from '../model.ts';
import type { CurvePt } from './curves.ts';
import { rampEvents, ratioFunction, simpson } from './curves.ts';

interface Msg {
  sec: number;
  bytes: number[];
}

/** The head of a score a sounding note comes from (`pi` indexes the pitches of the event). */
export interface HeadAt {
  mi: number;
  staff: string;
  voice: number;
  idx: number;
  pi: number;
}

/** A sounding note before it becomes messages: ticks are absolute, `shift` is in milliseconds. */
export interface Note {
  start: number;
  end: number;
  midi: number;
  vel: number;
  ch: number;
  /** The displacement of the attack in milliseconds. */
  shift: number;
  /** The head that started the note (absent for graces); ornaments, trills and tremolos give several notes the same head. */
  head?: HeadAt;
  /** A gate above 1 made the note longer than written, so it must not run into a new attack of the same key. */
  stretched?: boolean;
}

export interface Sequence {
  /** Sorted by time; at one instant, note-offs and pedal-ups come before note-ons (a repeated note must re-articulate). */
  msgs: Msg[];
  /** MIDI channels in use, for silencing them on stop. */
  channels: number[];
  totalTicks: number;
  /** The sounding notes, before the messages. */
  notes: Note[];
  /** Absolute tick of each measure start. */
  measureStart: number[];
  tickToSec(tick: number): number;
  secToTick(sec: number): number;
}

/** The velocity before the first dynamic mark of a staff (mezzo forte). */
const VELOCITY = 80;

/** The velocity a dynamic text stands for; a text that is not listed leaves the velocity as it is. */
const DYNAMIC_VELOCITY: Record<string, number> = {
  pppp: 16,
  ppp: 28,
  pp: 40,
  p: 52,
  mp: 66,
  mf: 80,
  f: 96,
  ff: 112,
  fff: 122,
  ffff: 127,
  sf: 104,
  sfz: 104,
  fz: 104,
  rf: 100,
  rfz: 100,
  fp: 52,
  sfp: 52,
};

/** How far a hairpin that no dynamic follows goes up or down. */
const HAIRPIN_SPAN = 20;

const STACCATO = 0.5;

/** MIDI channel of the n-th staff: 0..15 without the percussion channel 9. */
export const channelOf = (staffIndex: number): number => {
  const c = staffIndex % 15;
  return c >= 9 ? c + 1 : c;
};

/** A controller change at an absolute tick, sent on every channel in use. */
interface Control {
  tick: number;
  cc: number;
  value: number;
}

/** Absolute tick of each measure start, and the length of the piece. */
export function measureStarts(score: Score): { measureStart: number[]; total: number } {
  const measureStart: number[] = [];
  let total = 0;
  score.measures.forEach((_, mi) => {
    measureStart.push(total);
    total += measureTicks(timeAt(score, mi));
  });
  return { measureStart, total };
}

/** How much longer a fermata event lasts, by shape: short ones hold less, long ones more. */
const FERMATA_STRETCH = { normal: 2, short: 1.5, long: 3 };

/** The absolute tick spans [start, end) of all events with a fermata, in any staff, with the stretch of the longest fermata there. */
function fermataSpans(score: Score, measureStart: number[]): [number, number, number][] {
  const spans: [number, number, number][] = [];
  score.measures.forEach((m, mi) => {
    for (const st of Object.values(m.staves))
      for (const v of st.voices)
        for (const te of flattenVoice(v))
          if (te.ev.fermata)
            spans.push([
              measureStart[mi] + te.start,
              measureStart[mi] + te.start + te.ticks,
              FERMATA_STRETCH[te.ev.fermataShape ?? 'normal'],
            ]);
  });
  return spans;
}

/**
 * Tempo map: a list of segments of constant seconds-per-tick, starting at 120 bpm (quarter) until the
 * first tempo mark. A mark at the same tick as the previous one replaces it. A tempo `curve` (ratios at
 * absolute ticks) divides the seconds per tick by its spline; the time within a segment is then integrated
 * numerically, and the inverse is found by bisection.
 */
function tempoMap(
  score: Score,
  measureStart: number[],
  curve: CurvePt[] = [],
): Pick<Sequence, 'tickToSec' | 'secToTick'> {
  const tempi: { tick: number; spt: number }[] = [{ tick: 0, spt: 60 / 120 / PPQ }];
  score.measures.forEach((m, mi) => {
    for (const st of Object.values(m.staves))
      for (const mk of marksOf(st)) {
        if (mk.type !== 'tempo') continue;
        const beatTicks = baseTicks({ base: mk.unit, dots: mk.dots });
        tempi.push({ tick: measureStart[mi] + mk.tick, spt: 60 / (mk.bpm * (beatTicks / PPQ)) / PPQ });
      }
  });
  tempi.sort((a, b) => a.tick - b.tick);
  const holds = fermataSpans(score, measureStart);
  // A fermata doubles the time per tick over its event. Every start and end of a hold is a tempo
  // boundary, and the tempo in force there (without the hold) is carried over.
  const baseAt = (tick: number) => {
    let spt = tempi[0].spt;
    for (const t of tempi) if (t.tick <= tick) spt = t.spt;
    return spt;
  };
  const stretchAt = (tick: number) =>
    Math.max(1, ...holds.filter(([a, b]) => a <= tick && tick < b).map(([, , stretch]) => stretch));
  const cuts = [
    ...new Set([...tempi.map((t) => t.tick), ...holds.flatMap((h) => [h[0], h[1]]), ...curve.map((c) => c.tick)]),
  ].sort((a, b) => a - b);
  const ratio = ratioFunction(curve);
  const inverse = (tick: number) => 1 / ratio(tick);
  // The time per tick of a segment is `spt` times this integral, per tick, over the part of it that is covered.
  const span = (a: number, b: number) => (curve.length ? simpson(inverse, a, b) : b - a);
  const lastCurveTick = curve.length ? curve[curve.length - 1].tick : -1;
  const pieces = cuts.map((tick) => ({ tick, spt: baseAt(tick) * stretchAt(tick) }));
  const segs: { tick: number; sec: number; spt: number }[] = [];
  for (const t of pieces) {
    const last = segs[segs.length - 1];
    if (last && last.tick === t.tick) {
      last.spt = t.spt;
      continue;
    }
    segs.push({ tick: t.tick, sec: last ? last.sec + last.spt * span(last.tick, t.tick) : 0, spt: t.spt });
  }
  const tickToSec = (tick: number) => {
    let i = segs.length - 1;
    while (i > 0 && segs[i].tick > tick) i--;
    return segs[i].sec + segs[i].spt * span(segs[i].tick, tick);
  };
  return {
    tickToSec,
    secToTick: (sec) => {
      let i = segs.length - 1;
      while (i > 0 && segs[i].sec > sec) i--;
      const seg = segs[i];
      // Beyond the last curve point the ratio is constant, so the segment is a straight line again.
      if (!curve.length) return seg.tick + (sec - seg.sec) / seg.spt;
      if (seg.tick >= lastCurveTick) return seg.tick + ((sec - seg.sec) / seg.spt) * ratio(seg.tick);
      let lo = seg.tick;
      let hi = segs[i + 1].tick;
      for (let k = 0; k < 60; k++) {
        const mid = (lo + hi) / 2;
        if (tickToSec(mid) < sec) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    },
  };
}

/**
 * Returns the velocity of a note at a tick. A dynamic sets the velocity from its text; a hairpin ramps
 * linearly to the next dynamic after its end (or by `HAIRPIN_SPAN` if there is none). Pedal marks are not read.
 */
function readDynamics(score: Score, staffId: string, measureStart: number[]): (tick: number) => number {
  const dyn: { tick: number; vel: number }[] = [];
  const open = new Map<number, { tick: number; dir: 1 | -1 }>();
  const ramps: { from: number; to: number; dir: 1 | -1 }[] = [];
  score.measures.forEach((m, mi) => {
    for (const mk of marksOf(m.staves[staffId])) {
      const t = measureStart[mi] + mk.tick;
      if (mk.type === 'dynamic') {
        const vel = DYNAMIC_VELOCITY[mk.text];
        if (vel !== undefined) dyn.push({ tick: t, vel });
      } else if (mk.type === 'hairpin') {
        open.set(mk.id, { tick: t, dir: mk.kind === 'cresc' ? 1 : -1 });
      } else if (mk.type === 'stop' && mk.of === 'hairpin') {
        const o = open.get(mk.id);
        open.delete(mk.id);
        if (o) ramps.push({ from: o.tick, to: t, dir: o.dir });
      }
    }
  });
  dyn.sort((a, b) => a.tick - b.tick);
  const level = (tick: number) => {
    let v = VELOCITY;
    for (const d of dyn) if (d.tick <= tick) v = d.vel;
    return v;
  };
  const clamp = (v: number) => Math.max(1, Math.min(127, Math.round(v)));
  return (tick) => {
    const r = ramps.find((x) => x.from <= tick && tick < x.to);
    if (!r) return level(tick);
    const a = level(r.from);
    const next = dyn.find((d) => d.tick >= r.to);
    const b = next ? next.vel : clamp(a + r.dir * HAIRPIN_SPAN);
    return clamp(a + ((b - a) * (tick - r.from)) / (r.to - r.from));
  };
}

/** The tick spans of the trill lines of a staff; a line without a stop runs to the end of the piece, a new start ends the previous line. */
function trillLinesOf(score: Score, staffId: string, measureStart: number[], total: number): [number, number][] {
  const spans: [number, number][] = [];
  let from: number | undefined;
  score.measures.forEach((m, mi) => {
    for (const mk of marksOf(m.staves[staffId])) {
      const t = measureStart[mi] + mk.tick;
      if (mk.type === 'trill') {
        if (from !== undefined) spans.push([from, t]);
        from = t;
      } else if (mk.type === 'stop' && mk.of === 'trill' && from !== undefined) {
        spans.push([from, t]);
        from = undefined;
      }
    }
  });
  if (from !== undefined) spans.push([from, total]);
  return spans;
}

/** Collects the sounding notes of one voice, merging ties. */
interface VoiceNotes {
  /** The head the notes added next come from, their attack displacement (ms) and whether they may outlast the written length: set per head before `add`. */
  head?: HeadAt;
  shift: number;
  stretch: boolean;
  /**
   * Adds one sounding note. With `join` set, a note whose `nominal` start equals the end of the open
   * note of the same pitch extends that note instead (a tie); `shortened` (staccato) notes are never
   * tied into, since their end no longer meets the next start.
   */
  add(
    start: number,
    end: number,
    midi: number,
    vel: number,
    tie: boolean,
    join: boolean,
    shortened: boolean,
    nominal?: number,
  ): void;
}

/** `open` remembers the sounding note of each pitch that a tie may continue into the next event, so tied notes become one long MIDI note instead of two. */
function voiceNotes(notes: Note[], open: Map<number, Note>, ch: number): VoiceNotes {
  const sink: VoiceNotes = {
    shift: 0,
    stretch: false,
    add(start, end, midi, vel, tie, join, shortened, nominal = start) {
      const cont = join ? open.get(midi) : undefined;
      if (cont && cont.end === nominal) {
        cont.end = end;
        if (!tie) open.delete(midi);
        return;
      }
      const n: Note = { start, end, midi, vel: Math.min(127, vel), ch, shift: sink.shift };
      if (sink.head) n.head = sink.head;
      if (sink.stretch) n.stretched = true;
      notes.push(n);
      if (tie && !shortened) open.set(midi, n);
      else open.delete(midi);
    },
  };
  return sink;
}

/** What the note readers of one staff share. */
interface StaffPlayback {
  ch: number;
  notes: Note[];
  velAt: (tick: number) => number;
  /** Absolute tick spans [from, to) of the staff's trill lines; every note starting inside one is trilled. */
  trillLines: [number, number][];
  /** The key signature (fifths) of the measure being read; the upper note of a trill without accidental follows it. */
  key: number;
  /** Where the voice being read is: its staff and measure (set by `buildSequence`) and its id (by `addVoiceNotes`). */
  staff: string;
  mi: number;
  voice: number;
}

/**
 * Two-note tremolo: the two notes alternate over the whole span of both, in strokes of the beam value
 * (one beam = eighths, two = sixteenths, ...). Returns false if the group is not a complete pair.
 */
function addTremolo(
  sink: VoiceNotes,
  sp: StaffPlayback,
  flat: TimedEvent[],
  trem: TremoloGroup,
  measureOffset: number,
  done: Set<unknown>,
): boolean {
  const pair = flat.filter((x) => x.tremolo === trem && x.ev.kind === 'note');
  if (pair.length !== 2) return false;
  const [p0, p1] = pair;
  done.add(p0.ev);
  done.add(p1.ev);
  const from = measureOffset + p0.start;
  const to = measureOffset + p1.start + p1.ticks;
  const stroke = (PPQ * 4) / 2 ** (trem.beams + 2);
  // A tuplet wrapping the pair with a displayed number (`label=6`) says how many strokes it holds.
  const wrap = p0.tuplets.findLast((t) => p1.tuplets.includes(t) && t.label && t.label >= 2);
  const count = wrap?.label ?? Math.max(2, Math.round((to - from) / stroke));
  const len = (to - from) / count;
  const vel = sp.velAt(from);
  for (let k = 0; k < count; k++) {
    const who = (k % 2 ? p1 : p0).ev;
    if (who.kind !== 'note') continue;
    const lastOfWho = k >= count - 2;
    const firstOfWho = k < 2;
    const idx = (k % 2 ? p1 : p0).index;
    who.pitches.forEach((np, pi) => {
      sink.head = { mi: sp.mi, staff: sp.staff, voice: sp.voice, idx, pi };
      sink.shift = np.shift ?? 0;
      sink.stretch = false;
      sink.add(
        from + k * len,
        from + (k + 1) * len,
        pitchMidi(np.pitch),
        np.vel ?? vel,
        !!np.tie && lastOfWho,
        firstOfWho,
        !lastOfWho,
      );
    });
  }
  return true;
}

/**
 * Plays the grace notes of an event and returns when its main note starts. Slashed ones
 * (acciaccature) are quick and end exactly on the beat. The others (and any at the very start of the
 * piece, where there is no earlier time to borrow) take their time from the main note, which then
 * starts later.
 */
function addGraces(sp: StaffPlayback, graces: Grace[], start: number, ticks: number): number {
  let mainOn = start;
  let lens = graces.map((g) => baseTicks({ base: g.base, dots: 0 }));
  const quick = graces.every((g) => g.slash);
  if (quick) lens = lens.map((l) => Math.min(l, PPQ / 8));
  let total = lens.reduce((a, b) => a + b, 0);
  let t = start - total;
  if (!quick || t < 0) {
    if (total > ticks / 2) {
      const f = ticks / 2 / total;
      lens = lens.map((l) => l * f);
      total = ticks / 2;
    }
    t = start;
    mainOn = start + total;
  }
  const vel = sp.velAt(start);
  graces.forEach((g, gi) => {
    for (const np of g.pitches)
      sp.notes.push({ start: t, end: t + lens[gi], midi: pitchMidi(np.pitch), vel, ch: sp.ch, shift: 0 });
    t += lens[gi];
  });
  return mainOn;
}

/** The pitch one letter name above (the alteration is replaced by the caller). */
function transposeStep(p: Pitch): Pitch {
  const i = STEPS.indexOf(p.step) + 1;
  return { step: STEPS[i % 7], octave: p.octave + (i >= 7 ? 1 : 0), alter: p.alter };
}

/** The pitch one letter name below (the alteration is replaced by the caller). */
function transposeStepDown(p: Pitch): Pitch {
  const i = STEPS.indexOf(p.step) - 1;
  return { step: STEPS[(i + 7) % 7], octave: p.octave - (i < 0 ? 1 : 0), alter: p.alter };
}

/**
 * A mordent or turn: a few quick notes (32nds) on the start of the note, which then sounds on its main pitch for the rest of its
 * time. The neighbors are the diatonic ones in the key. The quick notes shrink for short notes so that the main note keeps
 * at least a quarter of the time.
 */
function addOrnament(
  sink: VoiceNotes,
  pitch: Pitch,
  ornament: Ornament,
  key: number,
  vel: number,
  start: number,
  end: number,
): void {
  const main = pitchMidi(pitch);
  const upP = transposeStep(pitch);
  const loP = transposeStepDown(pitch);
  const up = pitchMidi({ ...upP, alter: keyAlter(key, upP.step) });
  const low = pitchMidi({ ...loP, alter: keyAlter(key, loP.step) });
  const seq =
    ornament === 'mordent'
      ? [main, low]
      : ornament === 'mordent-inverted'
        ? [main, up]
        : ornament === 'turn'
          ? [up, main, low]
          : [low, main, up];
  const step = Math.min(PPQ / 8, ((end - start) * 3) / 4 / seq.length);
  seq.forEach((midi, i) => {
    sink.add(start + i * step, start + (i + 1) * step, midi, vel, false, false, true);
  });
  sink.add(start + seq.length * step, end, main, vel, false, false, true);
}

/** A trill: the pitch alternates with the diatonic upper neighbor (by the key, or `upAcc`), in 32nds, starting on the main note and ending on it. */
function addTrill(
  sink: VoiceNotes,
  pitch: Pitch,
  upAcc: number | undefined,
  key: number,
  vel: number,
  start: number,
  end: number,
): void {
  const midi = pitchMidi(pitch);
  const above = transposeStep(pitch);
  const up = pitchMidi({ ...above, alter: upAcc ?? keyAlter(key, above.step) });
  const step = PPQ / 8;
  const count = Math.max(1, Math.floor((end - start) / step));
  for (let i = 0; i < count; i++) {
    const on = start + i * step;
    const off = i === count - 1 ? end : on + step;
    sink.add(on, off, i % 2 === 0 ? midi : up, vel, false, false, true);
  }
}

/**
 * The notes of a chord event. A rolled chord (arpeggio) enters one note after the other from the
 * bottom, all ending together; the delay between notes is at most a 32nd and shrinks for short chords.
 */
function addChord(sink: VoiceNotes, sp: StaffPlayback, te: TimedEvent & { ev: NoteEvent }, start: number): void {
  const end = start + te.ticks;
  const staccato = !!te.ev.art?.includes('staccato');
  const vel = sp.velAt(start);
  const mainOn = te.ev.graces?.length ? addGraces(sp, te.ev.graces, start, te.ticks) : start;
  const n = te.ev.pitches.length;
  const step = te.ev.arpeggio && n > 1 ? Math.min(PPQ / 8, (end - mainOn) / (3 * (n - 1))) : 0;
  te.ev.pitches.forEach((np, k) => {
    const on = mainOn + k * step;
    const trilled = te.ev.trill || sp.trillLines.some(([a, b]) => a <= start && start < b);
    // The expression of the head: its velocity, the displacement of its attack and the gate on its length. A tied
    // head keeps its written length, so that it joins the head it is tied to.
    const headVel = np.vel ?? vel;
    const gate = np.tie ? 1 : (np.gate ?? 1);
    sink.head = { mi: sp.mi, staff: sp.staff, voice: sp.voice, idx: te.index, pi: k };
    sink.shift = np.shift ?? 0;
    sink.stretch = gate > 1;
    if (te.ev.ornament && !trilled && k === n - 1) {
      addOrnament(sink, np.pitch, te.ev.ornament, sp.key, headVel, on, on + (end - on) * gate);
      return;
    }
    if (trilled && k === n - 1) {
      addTrill(sink, np.pitch, te.ev.trillAcc, sp.key, headVel, on, on + (end - on) * gate);
      return;
    }
    const written = staccato ? on + (end - on) * STACCATO : end;
    sink.add(
      on,
      gate === 1 ? written : on + (written - on) * gate,
      pitchMidi(np.pitch),
      headVel,
      !!np.tie,
      true,
      staccato || gate !== 1,
      start,
    );
  });
}

/**
 * Adds the notes of a voice to `sink`, tremolos as repeated notes and everything else as chords. `measureOffset`
 * is the start of the measure in ticks.
 */
function addVoiceNotes(sp: StaffPlayback, sink: VoiceNotes, voice: Voice, measureOffset: number): void {
  sp.voice = voice.id;
  const flat = flattenVoice(voice);
  const done = new Set<unknown>();
  for (const te of flat) {
    if (te.ev.kind !== 'note' || done.has(te.ev)) continue;
    if (te.tremolo && addTremolo(sink, sp, flat, te.tremolo, measureOffset, done)) continue;
    addChord(sink, sp, te as TimedEvent & { ev: NoteEvent }, measureOffset + te.start);
  }
}

/** The shortest a displaced note may sound, in seconds. */
const MIN_LENGTH = 0.01;

/** The gap left before a new attack of the same key when a note was lengthened by its gate, in seconds. */
const KEY_GAP = 0.001;

/**
 * Every note-on/off and controller change as a timed message. At one instant releases come first, then the
 * controllers, then attacks (`order` 0, 1, 2), so a repeated pitch is re-struck instead of being cut off by
 * its own note-off arriving after the new note-on, and a pedal change comes before the notes it is meant for.
 * The attack of a note is displaced by its `shift` (never before the start of the piece); a note whose gate made
 * it longer than written ends before the next attack of the same key.
 */
function toMessages(notes: Note[], controls: Control[], tickToSec: (tick: number) => number) {
  const evs: { sec: number; order: number; bytes: number[] }[] = [];
  const used = new Set<number>();
  const timed = notes
    .filter((n) => n.midi >= 0 && n.midi <= 127)
    .map((n) => {
      const on = Math.max(0, tickToSec(n.start) + n.shift / 1000);
      const off = tickToSec(n.end);
      return { n, on, off: n.shift !== 0 ? Math.max(off, on + MIN_LENGTH) : off };
    });
  const nextOn = new Map<number, number[]>();
  for (const t of timed) {
    const key = t.n.ch * 128 + t.n.midi;
    nextOn.set(key, [...(nextOn.get(key) ?? []), t.on]);
  }
  for (const list of nextOn.values()) list.sort((a, b) => a - b);
  for (const t of timed) {
    if (!t.n.stretched) continue;
    const next = nextOn.get(t.n.ch * 128 + t.n.midi)?.find((x) => x > t.on);
    if (next !== undefined) t.off = Math.max(t.on + MIN_LENGTH, Math.min(t.off, next - KEY_GAP));
  }
  // A unison written in several voices is one key struck once: the notes that attack the same key at the same
  // instant are sounded as one, with the loudest velocity and the latest end (two note-ons would layer in the synth).
  const struck = new Map<string, (typeof timed)[number]>();
  const single: typeof timed = [];
  for (const t of timed) {
    const key = `${t.n.ch}:${t.n.midi}:${t.on.toFixed(6)}`;
    const first = struck.get(key);
    if (!first) {
      const copy = { n: { ...t.n }, on: t.on, off: t.off };
      struck.set(key, copy);
      single.push(copy);
    } else {
      first.n.vel = Math.max(first.n.vel, t.n.vel);
      first.off = Math.max(first.off, t.off);
    }
  }
  // A key that is struck while it still sounds (a unison entering later in another voice) would be cut off by the
  // first note's release. A note inside an earlier one's span is absorbed; one that outlasts it is a re-strike, and
  // the earlier note ends just before it, so that the longest sounding is kept.
  const byKey = new Map<number, typeof timed>();
  for (const t of single) byKey.set(t.n.ch * 128 + t.n.midi, [...(byKey.get(t.n.ch * 128 + t.n.midi) ?? []), t]);
  const absorbed = new Set<(typeof timed)[number]>();
  for (const list of byKey.values()) {
    list.sort((a, b) => a.on - b.on);
    let cur = list[0];
    for (const t of list.slice(1)) {
      if (t.on >= cur.off) cur = t;
      else if (t.off <= cur.off) absorbed.add(t);
      else {
        cur.off = Math.max(cur.on + MIN_LENGTH, t.on - KEY_GAP);
        cur = t;
      }
    }
  }
  for (const { n, on, off } of single.filter((t) => !absorbed.has(t))) {
    used.add(n.ch);
    evs.push({ sec: on, order: 2, bytes: [0x90 | n.ch, n.midi, n.vel] });
    evs.push({ sec: off, order: 0, bytes: [0x80 | n.ch, n.midi, 0] });
  }
  for (const c of controls)
    for (const ch of used) evs.push({ sec: tickToSec(c.tick), order: 1, bytes: [0xb0 | ch, c.cc, c.value] });
  evs.sort((a, b) => a.sec - b.sec || a.order - b.order);
  return { msgs: evs.map(({ sec, bytes }) => ({ sec, bytes })), channels: [...used].sort((a, b) => a - b) };
}

/** The absolute tick of a position of the performance (the end of the piece for one beyond the last measure). */
function absoluteTick(pos: Pos, measureStart: number[], total: number): number {
  return pos.mi < measureStart.length ? measureStart[pos.mi] + pos.tick : total;
}

/** The pedal controller changes of the performance: the sustain curve (CC64, with a release at the end of the piece if it is still down) and the una corda regions (CC67). */
function pedalControls(score: Score, measureStart: number[], total: number): Control[] {
  const perf = score.performance;
  const controls: Control[] = [];
  const pts = (c: CurvePoint[] | undefined): CurvePt[] =>
    (c ?? []).map((p) => ({ tick: absoluteTick(p.pos, measureStart, total), value: p.value }));
  const sustain = rampEvents(pts(perf?.sustain));
  for (const e of sustain) controls.push({ tick: e.tick, cc: 64, value: e.value });
  if (sustain.length && sustain[sustain.length - 1].value > 0) controls.push({ tick: total, cc: 64, value: 0 });
  for (const r of perf?.soft ?? []) {
    controls.push({ tick: absoluteTick(r.from, measureStart, total), cc: 67, value: 127 });
    controls.push({ tick: absoluteTick(r.to, measureStart, total), cc: 67, value: 0 });
  }
  return controls;
}

/**
 * Turns a score into timed MIDI messages (see `Sequence`): the notes of every staff on its own channel, the
 * pedals of the performance and the tempo map (with the performance's tempo curve).
 */
export function buildSequence(score: Score): Sequence {
  const { measureStart, total } = measureStarts(score);
  const curve = (score.performance?.tempo ?? []).map((p) => ({
    tick: absoluteTick(p.pos, measureStart, total),
    value: p.value,
  }));
  const tempo = tempoMap(score, measureStart, curve);
  const notes: Note[] = [];
  score.staves.forEach((staff, si) => {
    const ch = channelOf(si);
    const sp: StaffPlayback = {
      ch,
      notes,
      velAt: readDynamics(score, staff.id, measureStart),
      key: 0,
      trillLines: trillLinesOf(score, staff.id, measureStart, total),
      staff: staff.id,
      mi: 0,
      voice: 0,
    };
    const openTies = new Map<number, Map<number, Note>>(); // The map is keyed by voice id.
    score.measures.forEach((m, mi) => {
      sp.key = keyAt(score, mi);
      sp.mi = mi;
      for (const v of m.staves[staff.id]?.voices ?? []) {
        const open = openTies.get(v.id) ?? new Map<number, Note>();
        openTies.set(v.id, open);
        addVoiceNotes(sp, voiceNotes(notes, open, ch), v, measureStart[mi]);
      }
    });
  });
  const { msgs, channels } = toMessages(notes, pedalControls(score, measureStart, total), tempo.tickToSec);
  return { msgs, channels, notes, totalTicks: total, measureStart, ...tempo };
}
