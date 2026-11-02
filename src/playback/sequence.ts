// Score -> timed MIDI messages. Headless: no browser APIs, so it can be tested with node --test.
//
// Three passes: a tempo map turns score ticks into seconds; each staff's notes are collected as
// sounding intervals (ties merged, ornaments such as graces, tremolo and arpeggio expanded, dynamics
// turned into velocity); finally the intervals become note-on/off messages, plus CC64 for the pedal,
// sorted by time. Every staff gets its own MIDI channel (`channelOf`), so a synth can give the staves
// different instruments.
import type { Grace, NoteEvent, Score, TimedEvent, TremoloGroup, Voice } from '../model.ts';
import { baseTicks, flattenVoice, marksOf, measureTicks, PPQ, pitchMidi, timeAt } from '../model.ts';

export interface Msg {
  sec: number;
  bytes: number[];
}
export interface Sequence {
  /** Sorted by time; at one instant, note-offs and pedal-ups come before note-ons (a repeated note must re-articulate). */
  msgs: Msg[];
  /** MIDI channels in use, for silencing them on stop. */
  channels: number[];
  totalTicks: number;
  /** Absolute tick of each measure start. */
  measureStart: number[];
  tickToSec(tick: number): number;
  secToTick(sec: number): number;
}

/** Every note plays at this velocity: playback is for proofreading, so dynamics are not rendered. */
const VELOCITY = 80;
const STACCATO = 0.5;

/** MIDI channel of the n-th staff: 0..15 without the percussion channel 9. */
export const channelOf = (staffIndex: number): number => {
  const c = staffIndex % 15;
  return c >= 9 ? c + 1 : c;
};

interface Note {
  start: number;
  end: number;
  midi: number;
  vel: number;
  ch: number;
}

interface PedalEvent {
  tick: number;
  ch: number;
  down: boolean;
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

/**
 * Tempo map: a list of segments of constant seconds-per-tick, starting at 120 bpm (quarter) until the
 * first tempo mark. A mark at the same tick as the previous one replaces it.
 */
function tempoMap(score: Score, measureStart: number[]): Pick<Sequence, 'tickToSec' | 'secToTick'> {
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
  const segs: { tick: number; sec: number; spt: number }[] = [];
  for (const t of tempi) {
    const last = segs[segs.length - 1];
    if (last && last.tick === t.tick) {
      last.spt = t.spt;
      continue;
    }
    segs.push({ tick: t.tick, sec: last ? last.sec + (t.tick - last.tick) * last.spt : 0, spt: t.spt });
  }
  return {
    tickToSec: (tick) => {
      let i = segs.length - 1;
      while (i > 0 && segs[i].tick > tick) i--;
      return segs[i].sec + (tick - segs[i].tick) * segs[i].spt;
    },
    secToTick: (sec) => {
      let i = segs.length - 1;
      while (i > 0 && segs[i].sec > sec) i--;
      return segs[i].tick + (sec - segs[i].sec) / segs[i].spt;
    },
  };
}

/**
 * Returns the velocity of a note at a tick (constant, dynamics are ignored) and adds the staff's pedal
 * changes.
 */
function readDynamicsAndPedal(
  score: Score,
  staffId: string,
  ch: number,
  measureStart: number[],
  total: number,
  pedal: PedalEvent[],
): (tick: number) => number {
  let down = false;
  score.measures.forEach((m, mi) => {
    for (const mk of marksOf(m.staves[staffId])) {
      const t = measureStart[mi] + mk.tick;
      if (mk.type === 'pedal') {
        if (down) pedal.push({ tick: t, ch, down: false });
        pedal.push({ tick: t, ch, down: true });
        down = true;
      } else if (mk.type === 'stop' && mk.of === 'pedal' && down) {
        pedal.push({ tick: t, ch, down: false });
        down = false;
      }
    }
  });
  if (down) pedal.push({ tick: total, ch, down: false });
  return () => VELOCITY;
}

/** Collects the sounding notes of one voice, merging ties. */
interface VoiceNotes {
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
  return {
    add(start, end, midi, vel, tie, join, shortened, nominal = start) {
      const cont = join ? open.get(midi) : undefined;
      if (cont && cont.end === nominal) {
        cont.end = end;
        if (!tie) open.delete(midi);
        return;
      }
      const n: Note = { start, end, midi, vel: Math.min(127, vel), ch };
      notes.push(n);
      if (tie && !shortened) open.set(midi, n);
      else open.delete(midi);
    },
  };
}

/** What the note readers of one staff share. */
interface StaffPlayback {
  ch: number;
  notes: Note[];
  velAt: (tick: number) => number;
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
  const count = Math.max(2, Math.round((to - from) / stroke));
  const len = (to - from) / count;
  const vel = sp.velAt(from);
  for (let k = 0; k < count; k++) {
    const who = (k % 2 ? p1 : p0).ev;
    if (who.kind !== 'note') continue;
    const lastOfWho = k >= count - 2;
    const firstOfWho = k < 2;
    for (const np of who.pitches)
      sink.add(
        from + k * len,
        from + (k + 1) * len,
        pitchMidi(np.pitch),
        vel,
        !!np.tie && lastOfWho,
        firstOfWho,
        !lastOfWho,
      );
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
      sp.notes.push({ start: t, end: t + lens[gi], midi: pitchMidi(np.pitch), vel, ch: sp.ch });
    t += lens[gi];
  });
  return mainOn;
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
    sink.add(
      on,
      staccato ? on + (end - on) * STACCATO : end,
      pitchMidi(np.pitch),
      vel,
      !!np.tie,
      true,
      staccato,
      start,
    );
  });
}

function addVoiceNotes(sp: StaffPlayback, sink: VoiceNotes, voice: Voice, measureOffset: number): void {
  const flat = flattenVoice(voice);
  const done = new Set<unknown>();
  for (const te of flat) {
    if (te.ev.kind !== 'note' || done.has(te.ev)) continue;
    if (te.tremolo && addTremolo(sink, sp, flat, te.tremolo, measureOffset, done)) continue;
    addChord(sink, sp, te as TimedEvent & { ev: NoteEvent }, measureOffset + te.start);
  }
}

/** Every note-on/off (and pedal change) as a timed message. At one instant releases come first (`order` 0 before 1), so a repeated pitch is re-struck instead of being cut off by its own note-off arriving after the new note-on. */
function toMessages(notes: Note[], pedal: PedalEvent[], tickToSec: (tick: number) => number) {
  const evs: { sec: number; order: number; bytes: number[] }[] = [];
  const used = new Set<number>();
  for (const n of notes) {
    if (n.midi < 0 || n.midi > 127) continue;
    used.add(n.ch);
    evs.push({ sec: tickToSec(n.start), order: 1, bytes: [0x90 | n.ch, n.midi, n.vel] });
    evs.push({ sec: tickToSec(n.end), order: 0, bytes: [0x80 | n.ch, n.midi, 0] });
  }
  for (const p of pedal) {
    used.add(p.ch);
    evs.push({ sec: tickToSec(p.tick), order: p.down ? 1 : 0, bytes: [0xb0 | p.ch, 64, p.down ? 127 : 0] });
  }
  evs.sort((a, b) => a.sec - b.sec || a.order - b.order);
  return { msgs: evs.map(({ sec, bytes }) => ({ sec, bytes })), channels: [...used].sort((a, b) => a - b) };
}

export function buildSequence(score: Score): Sequence {
  const { measureStart, total } = measureStarts(score);
  const tempo = tempoMap(score, measureStart);
  const notes: Note[] = [];
  const pedal: PedalEvent[] = [];
  score.staves.forEach((staff, si) => {
    const ch = channelOf(si);
    const velAt = readDynamicsAndPedal(score, staff.id, ch, measureStart, total, pedal);
    const sp: StaffPlayback = { ch, notes, velAt };
    const openTies = new Map<number, Map<number, Note>>(); // per voice id
    score.measures.forEach((m, mi) => {
      for (const v of m.staves[staff.id]?.voices ?? []) {
        const open = openTies.get(v.id) ?? new Map<number, Note>();
        openTies.set(v.id, open);
        addVoiceNotes(sp, voiceNotes(notes, open, ch), v, measureStart[mi]);
      }
    });
  });
  const { msgs, channels } = toMessages(notes, pedal, tempo.tickToSec);
  return { msgs, channels, totalTicks: total, measureStart, ...tempo };
}
