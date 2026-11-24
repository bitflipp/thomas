// Editing the expression of heads (`NotePitch.vel`, `shift`, `gate`): setting, nudging and ramping velocities, shifting
// attacks, rolling chords, resetting. Pure `Score -> Score` functions like the commands in commands.ts. What a head
// sounds like (its velocity from the dynamics, the onset a notated arpeggio gives it) is read from the playback sequence,
// so these functions build one (`headInfos`) unless the caller passes the one it has.

import type { Draft } from 'immer';
import { produce } from 'immer';
import type { Event, Score } from '../model.ts';
import { flattenVoice } from '../model.ts';
import type { HeadAt, Note, Sequence } from '../playback/sequence.ts';
import { buildSequence } from '../playback/sequence.ts';
import { must } from '../util.ts';
import type { EvAddr, Ref } from './addr.ts';
import { eventOf, voiceOf } from './addr.ts';
import { EditError } from './voice.ts';

/** One pitch of a note or chord: the event's address and the index of the pitch. */
export interface HeadRef extends EvAddr {
  pi: number;
}

/** The identity of a head as a string, for sets and maps. */
export const headKey = (h: HeadAt | HeadRef): string => `${h.mi}/${h.staff}/${h.voice}/${h.idx}/${h.pi}`;

/** The limits of the expression values. */
const VEL_MIN = 1;

const VEL_MAX = 127;
const SHIFT_MAX = 2000;
const GATE_MIN = 0.05;
const GATE_MAX = 4;

/** What a head sounds like now, with whether each value is set on the head or follows from the notation. */
export interface HeadInfo {
  head: HeadRef;
  key: string;
  midi: number;
  /** The first sounding note of the head (a tremolo or trill has many). */
  note: Note;
  /** The absolute tick the event starts at in the notation. */
  at: number;
  /** How many sounding notes the head makes (more than one for a tremolo, a trill or an ornament). */
  strokes: number;
  vel: number;
  /** The attack displacement in milliseconds (0 when unset). */
  shift: number;
  /** The factor on the sounding length (1 when unset). */
  gate: number;
  has: { vel: boolean; shift: boolean; gate: boolean };
}

/** The values a command sets on a head; `null` takes the value off the head (back to what the notation gives). */
export interface HeadValues {
  vel?: number | null;
  shift?: number | null;
  gate?: number | null;
}

/** The heads that the refs select: a note or chord gives all its heads (one when the ref names a head), a measure everything in it. In score order. */
export function selectedHeads(score: Score, refs: readonly Ref[]): HeadRef[] {
  const out = new Map<string, HeadRef>();
  const add = (a: EvAddr, e: Event | undefined, pi?: number) => {
    if (e?.kind !== 'note') return;
    e.pitches.forEach((_, i) => {
      if (pi === undefined || pi === i)
        out.set(headKey({ ...a, pi: i }), { mi: a.mi, staff: a.staff, voice: a.voice, idx: a.idx, pi: i });
    });
  };
  for (const r of refs) {
    if (r.t === 'ev') add(r, eventOf(score, r), r.pi);
    else if (r.t === 'measure') {
      for (const [staff, sm] of Object.entries(score.measures[r.mi]?.staves ?? {}))
        for (const v of sm.voices)
          for (const te of flattenVoice(v)) add({ mi: r.mi, staff, voice: v.id, idx: te.index }, te.ev);
    }
  }
  const staffIndex = (id: string) => score.staves.findIndex((s) => s.id === id);
  return [...out.values()].sort(
    (a, b) =>
      a.mi - b.mi || staffIndex(a.staff) - staffIndex(b.staff) || a.voice - b.voice || a.idx - b.idx || a.pi - b.pi,
  );
}

/** What every head of the score sounds like, in score order of its first note. Pass the playback sequence of `score` if it is at hand. */
export function headInfos(score: Score, seq: Sequence = buildSequence(score)): HeadInfo[] {
  const first = new Map<string, Note>();
  const strokes = new Map<string, number>();
  for (const n of seq.notes) {
    if (!n.head) continue;
    const k = headKey(n.head);
    strokes.set(k, (strokes.get(k) ?? 0) + 1);
    const old = first.get(k);
    if (!old || n.start < old.start) first.set(k, n);
  }
  const out: HeadInfo[] = [];
  const voices = new Map<string, ReturnType<typeof flattenVoice>>();
  for (const [key, note] of first) {
    const h = must(note.head);
    const vk = `${h.mi}/${h.staff}/${h.voice}`;
    let flat = voices.get(vk);
    if (!flat) {
      flat = flattenVoice(voiceOf(score, h) ?? { id: 0, items: [] });
      voices.set(vk, flat);
    }
    const te = flat[h.idx];
    if (te?.ev.kind !== 'note') continue;
    const np = te.ev.pitches[h.pi];
    if (!np) continue;
    out.push({
      head: { mi: h.mi, staff: h.staff, voice: h.voice, idx: h.idx, pi: h.pi },
      key,
      midi: note.midi,
      note,
      at: (seq.measureStart[h.mi] ?? 0) + te.start,
      strokes: strokes.get(key) ?? 1,
      vel: note.vel,
      shift: np.shift ?? 0,
      gate: np.gate ?? 1,
      has: { vel: np.vel !== undefined, shift: np.shift !== undefined, gate: np.gate !== undefined },
    });
  }
  return out.sort((a, b) => a.note.start - b.note.start || a.midi - b.midi);
}

/** The infos of `heads` (those that sound: a tied continuation has none). */
function infosOf(score: Score, heads: readonly HeadRef[], seq?: Sequence): HeadInfo[] {
  const want = new Set(heads.map(headKey));
  return headInfos(score, seq).filter((i) => want.has(i.key));
}

/** Rounds a velocity to the whole numbers MIDI has and keeps it audible. */
const clampVel = (v: number): number => Math.max(VEL_MIN, Math.min(VEL_MAX, Math.round(v)));

/** Rounds a shift to a tenth of a millisecond and keeps it within the limits. */
const clampShift = (v: number): number => Math.max(-SHIFT_MAX, Math.min(SHIFT_MAX, Math.round(v * 10) / 10));

/** Rounds a gate to hundredths and keeps it within the limits. */
const clampGate = (v: number): number => Math.max(GATE_MIN, Math.min(GATE_MAX, Math.round(v * 100) / 100));

/** The note event at the address in the draft. */
function noteIn(d: Draft<Score>, a: EvAddr): Draft<Event> & { kind: 'note' } {
  const v = d.measures[a.mi]?.staves[a.staff]?.voices.find((x) => x.id === a.voice);
  const e = v && flattenVoice(v as never)[a.idx]?.ev;
  if (e?.kind !== 'note') throw new EditError('No such note');
  return e as never;
}

/**
 * Sets the expression of heads, each with its own values. A value of `null` (or one equal to what means "none": a shift of
 * 0, a gate of 1) takes it off the head; a value left out stays.
 */
export function setHeadValues(score: Score, entries: readonly { head: HeadRef; values: HeadValues }[]): Score {
  return produce(score, (d) => {
    for (const { head, values } of entries) {
      const np = noteIn(d, head).pitches[head.pi];
      if (!np) throw new EditError('No such note');
      if (values.vel !== undefined) {
        if (values.vel === null) delete np.vel;
        else np.vel = clampVel(values.vel);
      }
      if (values.shift !== undefined) {
        const s = values.shift === null ? 0 : clampShift(values.shift);
        if (s === 0) delete np.shift;
        else np.shift = s;
      }
      if (values.gate !== undefined) {
        const g = values.gate === null ? 1 : clampGate(values.gate);
        if (g === 1) delete np.gate;
        else np.gate = g;
      }
    }
  });
}

/** Sets one velocity on all of `heads`, or takes it off with `null`. */
export function setVelocity(score: Score, heads: readonly HeadRef[], vel: number | null): Score {
  return setHeadValues(
    score,
    heads.map((head) => ({ head, values: { vel } })),
  );
}

/** Sets one attack shift (milliseconds) on all of `heads`, or takes it off with `null`. */
export function setShift(score: Score, heads: readonly HeadRef[], ms: number | null): Score {
  return setHeadValues(
    score,
    heads.map((head) => ({ head, values: { shift: ms } })),
  );
}

/** Sets one gate on all of `heads`, or takes it off with `null`. */
export function setGate(score: Score, heads: readonly HeadRef[], gate: number | null): Score {
  return setHeadValues(
    score,
    heads.map((head) => ({ head, values: { gate } })),
  );
}

/** Takes the expression (all of it, or the listed values) off `heads`. */
export function resetExpression(
  score: Score,
  heads: readonly HeadRef[],
  which: readonly (keyof HeadValues)[] = ['vel', 'shift', 'gate'],
): Score {
  const values: HeadValues = {};
  for (const w of which) values[w] = null;
  return setHeadValues(
    score,
    heads.map((head) => ({ head, values })),
  );
}

/** Changes the velocity of `heads` by `delta` from what they sound at now. */
export function nudgeVelocity(score: Score, heads: readonly HeadRef[], delta: number, seq?: Sequence): Score {
  return setHeadValues(
    score,
    infosOf(score, heads, seq).map((i) => ({ head: i.head, values: { vel: i.vel + delta } })),
  );
}

/** Changes the attack shift of `heads` by `delta` milliseconds. */
export function nudgeShift(score: Score, heads: readonly HeadRef[], delta: number, seq?: Sequence): Score {
  return setHeadValues(
    score,
    infosOf(score, heads, seq).map((i) => ({ head: i.head, values: { shift: i.shift + delta } })),
  );
}

/** The shapes of a ramp: how far along the way from the first to the last value a note is, by how far along the passage it starts. */
export const RAMP_SHAPES = {
  linear: (t: number) => t,
  'ease-in': (t: number) => t * t,
  'ease-out': (t: number) => t * (2 - t),
  's-curve': (t: number) => t * t * (3 - 2 * t),
};

export type RampShape = keyof typeof RAMP_SHAPES;

/**
 * Gives `heads` velocities along a ramp from `from` (at the earliest attack) to `to` (at the latest), shaped by `shape`.
 * Heads that start together get the same value.
 */
export function rampVelocity(
  score: Score,
  heads: readonly HeadRef[],
  from: number,
  to: number,
  shape: RampShape = 'linear',
  seq?: Sequence,
): Score {
  const infos = infosOf(score, heads, seq);
  if (!infos.length) throw new EditError('Select the notes to shape');
  const t0 = Math.min(...infos.map((i) => i.at));
  const t1 = Math.max(...infos.map((i) => i.at));
  const ease = RAMP_SHAPES[shape];
  return setHeadValues(
    score,
    infos.map((i) => ({
      head: i.head,
      values: { vel: from + (to - from) * ease(t1 > t0 ? (i.at - t0) / (t1 - t0) : 0) },
    })),
  );
}

/** How a chord is rolled: the time from its first to its last note in milliseconds, the direction and which end is on the beat. */
export interface Roll {
  span: number;
  dir: 'up' | 'down';
  /** `first`: the first note to sound is on the beat; `last`: the last one is, and the roll starts before it. */
  anchor: 'first' | 'last';
}

/**
 * Rolls the chords among `heads` (a note that sounds as several, in a tremolo, trill or ornament, is not part of one): the heads that start together (also in other voices or staves, as when one hand's chord
 * continues the other's) get attack shifts that spread them evenly over `span` milliseconds, from the lowest note up (or
 * from the highest down). The shifts are worked out from where the notation puts the notes now, so a notated arpeggio
 * is not rolled twice.
 */
export function rollChord(
  score: Score,
  heads: readonly HeadRef[],
  roll: Roll,
  seq: Sequence = buildSequence(score),
): Score {
  const groups = new Map<number, HeadInfo[]>();
  for (const i of infosOf(score, heads, seq)) if (i.strokes === 1) groups.set(i.at, [...(groups.get(i.at) ?? []), i]);
  const entries: { head: HeadRef; values: HeadValues }[] = [];
  for (const [at, group] of groups) {
    if (group.length < 2) continue;
    group.sort((a, b) => (roll.dir === 'up' ? a.midi - b.midi : b.midi - a.midi));
    const base = seq.tickToSec(at);
    group.forEach((i, k) => {
      const offset = (k * roll.span) / (group.length - 1) - (roll.anchor === 'last' ? roll.span : 0);
      entries.push({ head: i.head, values: { shift: (base - seq.tickToSec(i.note.start)) * 1000 + offset } });
    });
  }
  if (!entries.length) throw new EditError('Select the notes of a chord: at least two notes that start together');
  return setHeadValues(score, entries);
}
