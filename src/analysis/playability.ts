// Playability check for piano music: which passages no pair of hands can play, and which only just.
//
// The notes of the keyboard staves are turned into steps (one per attack time, holding the keys that sound
// then), and the hands are inferred, not read from the staves: a dynamic program over all ways of dividing
// each step's keys between the left and the right hand picks the cheapest path. A division is possible when each
// hand has at most five keys within the player's span (`maxSpan`), and a move between two steps is possible when
// the hand can get there in the time between the attacks. The staves only act as a prior (a note taken by the
// other hand costs a little, and a note can be pinned to a hand), so music with crossings or both hands on one
// staff is judged by what the hands could do, not by how it is written. Where no division is possible the findings are errors; where the best
// path still stretches or hurries, or its fingering (`fingering.ts`, worked out per hand afterward) is awkward,
// they are warnings. Nothing here draws anything: the editor lists and
// colors the notes of the findings (`ui/`), and `thomas check --playability` prints them.
//
// What counts as held: a finger holds a note for its written length (ties merged), except where the pedal
// can carry it (`PedalMode`) or the note is staccato. Not modeled yet: grace notes, trills (the second
// finger), arpeggiated chords (their notes are left out), repeated strikes of a key that is still held, and
// non-keyboard staves outside the first brace.

import type { EvAddr } from '../editor/addr.ts';
import type { Score } from '../model.ts';
import { flattenVoice, marksOf, pitchMidi } from '../model.ts';
import { measureStarts, tempoMap } from '../playback/sequence.ts';
import type { FStep } from './fingering.ts';
import { fingerHand } from './fingering.ts';

/** Whether the sustain pedal is assumed to carry held notes: where the score marks it (`explicit`), everywhere (`assumed`), or nowhere (`never`). */
export type PedalMode = 'explicit' | 'assumed' | 'never';

export interface PlayOptions {
  /** The widest span of one hand in semitones, from thumb to little finger (an octave is 12, a ninth 14, a tenth 16). */
  maxSpan: number;
  pedal: PedalMode;
}

export const DEFAULT_PLAY: PlayOptions = { maxSpan: 14, pedal: 'assumed' };

/** What a finding is about: a note off the keyboard, too many keys, a span too wide, a leap too fast, held notes that keep the hands from the next ones, or an awkward fingering. */
export type PlayKind = 'range' | 'count' | 'span' | 'leap' | 'hold' | 'fingering';

/** A head of a note. */
export interface PlayNote {
  ev: EvAddr;
  pi: number;
}

export interface PlayFinding {
  /** An error cannot be played at all (by the setting); a warning is near the limit. */
  severity: 'error' | 'warn';
  kind: PlayKind;
  /** The hand the finding is about, where it is known. */
  hand?: 'L' | 'R';
  /** A few words for a list. */
  title: string;
  /** The explanation, with the numbers. */
  message: string;
  notes: PlayNote[];
  /** The measure and the tick in it where the finding starts. */
  mi: number;
  tick: number;
}

/** A note and the hand that plays it, as the check inferred it. */
export interface HandNote extends PlayNote {
  hand: 'L' | 'R';
}

/** A note and the finger the cheapest fingering puts on it (1 thumb to 5 little finger). */
export interface FingerNote extends PlayNote {
  finger: number;
}

/** What the check found: the findings, which hand plays which note, and the fingers of the notes struck. */
export interface Analysis {
  findings: PlayFinding[];
  hands: HandNote[];
  fingers: FingerNote[];
}

/** The lowest key of a piano (A0). */
const LOWEST = 21;

/** The highest key of a piano (C8). */
const HIGHEST = 108;

/** The most keys one hand can hold down. */
const FINGERS = 5;

/** The fixed part of the time a leap needs, in milliseconds, counted from one attack of the hand to the next. */
const LEAP_BASE_MS = 30;

/** The part of the time a leap needs that grows with its length, in milliseconds per semitone. */
const LEAP_MS_PER_SEMITONE = 3.5;

/** A leap that uses more than this share of the time there is is a warning. */
const LEAP_WARN = 0.7;

/** The cost of a note in the staff of the other hand: more than a hard leap costs, so that a figure written for one hand stays in it unless it cannot be played that way. */
const PRIOR_COST = 4;

/** The cost of hands that interleave (the left hand's top note above the right hand's bottom note). */
const CROSS_COST = 3;

/** The weight of the squared stretch beyond the comfortable span. */
const STRETCH_COST = 0.5;

/** The weight of the squared share of the leap time used. */
const LEAP_COST = 4;

/** The most keys a step can have and still be divided (two full hands). */
const MAX_KEYS = 2 * FINGERS;

/** A note of the keyboard staves, with ties merged into the first one. */
interface PNote {
  /** The absolute tick of the attack and of the end of the written note. */
  start: number;
  end: number;
  /** The absolute tick up to which a finger has to hold the key (the attack itself when the pedal or a staccato lets go). */
  hold: number;
  midi: number;
  /** The hand the staff suggests: 1 right, -1 left, 0 none. */
  prior: number;
  /** The hand the score pins the note to: 1 right, -1 left, 0 none. */
  pin: number;
  ev: EvAddr;
  pi: number;
}

/** One key that sounds at a step, with the notes on it (unisons share a key). */
interface Key {
  midi: number;
  notes: PNote[];
  prior: number;
  /** The hand a note on it is pinned to: 1 right, -1 left, 0 none. */
  pin: number;
  /** Whether a note on it is struck at this step. */
  attack: boolean;
  /** The index of the same key in the previous step when it is held over, else -1. */
  from: number;
}

/** The keys that sound at one attack time. */
interface Step {
  tick: number;
  sec: number;
  /** In ascending pitch. */
  keys: Key[];
}

/** The notes of a score as steps, ready to be solved for any span. */
interface Prepared {
  score: Score;
  measureStart: number[];
  steps: Step[];
  /** The notes off the keyboard. */
  outside: PNote[];
}

/** A way of dividing the keys of a step: bit i set means key i is played by the right hand. */
interface State {
  mask: number;
  cost: number;
  /** The index in the previous step's states, or -1 at the start of a stretch of music. */
  prev: number;
  /** The keys, lowest and highest pitch of the left hand ([0]) and the right ([1]). */
  n: [number, number];
  lo: [number, number];
  hi: [number, number];
  /** Whether the hand attacks a key at this step. */
  atk: [boolean, boolean];
  /** Where each hand was last seen (the middle of its keys) and when, in seconds: its own at this step, else carried over from the steps where only the other hand played. NaN before the hand has played. */
  pos: [number, number];
  at: [number, number];
}

/** The generic name of an interval of `semitones`: "2nd", "3rd", "octave", "9th", "10th". */
export function spanName(semitones: number): string {
  if (semitones === 0) return 'unison';
  const generic = [1, 2, 2, 3, 3, 4, 5, 5, 6, 6, 7, 7][semitones % 12] + 7 * Math.floor(semitones / 12);
  if (generic === 8) return 'octave';
  return `${generic}${generic === 2 ? 'nd' : generic === 3 ? 'rd' : 'th'}`;
}

/** The name of a key with a sharp, such as "C#4" (middle C is C4). */
function midiName(midi: number): string {
  return `${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][midi % 12]}${Math.floor(midi / 12) - 1}`;
}

/** The absolute ticks where the sustain pedal goes down and comes up, as intervals. */
function pedalIntervals(score: Score, measureStart: number[], staves: Set<string>): [number, number][] {
  const events: { tick: number; down: boolean }[] = [];
  score.measures.forEach((m, mi) => {
    for (const [id, sm] of Object.entries(m.staves)) {
      if (!staves.has(id)) continue;
      for (const mk of marksOf(sm)) {
        if (mk.type === 'pedal') events.push({ tick: measureStart[mi] + mk.tick, down: true });
        else if (mk.type === 'stop' && mk.of === 'pedal')
          events.push({ tick: measureStart[mi] + mk.tick, down: false });
      }
    }
  });
  events.sort((a, b) => a.tick - b.tick || Number(b.down) - Number(a.down));
  const out: [number, number][] = [];
  let from = -1;
  for (const e of events) {
    if (e.down && from < 0) from = e.tick;
    else if (!e.down && from >= 0) {
      out.push([from, e.tick]);
      from = -1;
    }
  }
  if (from >= 0) out.push([from, Number.POSITIVE_INFINITY]);
  return out;
}

/** The notes of the keyboard staves (the first brace, else all staves), with ties merged, holds decided by `pedal`, and the hand priors. */
function collectNotes(score: Score, measureStart: number[], pedal: PedalMode): PNote[] {
  const brace = score.groups.find((g) => g.kind === 'brace');
  const ids = new Set(brace ? brace.staves : score.staves.map((s) => s.id));
  const keyboard = score.staves.filter((s) => ids.has(s.id)).map((s) => s.id);
  const mid = (keyboard.length - 1) / 2;
  const priorOf = (staff: string): number => {
    const i = keyboard.indexOf(staff);
    return i < 0 ? 0 : i < mid ? 1 : i > mid ? -1 : 0;
  };
  const down = pedal === 'explicit' ? pedalIntervals(score, measureStart, ids) : [];
  const pedaled = (tick: number) => down.some(([a, b]) => a <= tick && tick < b);
  const notes: PNote[] = [];
  const tremolos = new Map<object, PNote[]>();
  // The notes of the previous event of each voice that are tied on, by pitch, to merge the continuations.
  let tiedInto = new Map<string, Map<number, PNote>>();
  score.measures.forEach((m, mi) => {
    const next = new Map<string, Map<number, PNote>>();
    for (const [staff, sm] of Object.entries(m.staves)) {
      if (!ids.has(staff)) continue;
      for (const v of sm.voices) {
        const vk = `${staff}/${v.id}`;
        let carried = tiedInto.get(vk);
        for (const te of flattenVoice(v)) {
          const e = te.ev;
          if (e.kind !== 'note') {
            carried = undefined;
            continue;
          }
          const start = measureStart[mi] + te.start;
          const end = start + te.ticks;
          const tied = new Map<number, PNote>();
          e.pitches.forEach((np, pi) => {
            const midi = pitchMidi(np.pitch);
            const origin = carried?.get(midi);
            if (origin) {
              origin.end = end;
              if (origin.hold > origin.start) origin.hold = Math.max(origin.hold, end);
              if (np.tie) tied.set(midi, origin);
              return;
            }
            const attack = e.staff ?? staff;
            const hold = te.tremolo || pedal === 'never' || (pedal === 'explicit' && !pedaled(start)) ? end : start;
            const n: PNote = {
              start,
              end,
              hold: e.art?.includes('staccato') ? start : hold,
              midi,
              prior: priorOf(attack),
              pin: np.hand === 'r' ? 1 : np.hand === 'l' ? -1 : 0,
              ev: { mi, staff, voice: v.id, idx: te.index },
              pi,
            };
            if (e.arpeggio) return; // A rolled chord is left out: it is not struck at once.
            notes.push(n);
            if (te.tremolo) tremolos.set(te.tremolo, [...(tremolos.get(te.tremolo) ?? []), n]);
            if (np.tie) tied.set(midi, n);
          });
          carried = tied;
        }
        next.set(vk, carried ?? new Map());
      }
    }
    tiedInto = next;
  });
  // The two notes of a tremolo alternate, so both are down for the whole group.
  for (const group of tremolos.values()) {
    const end = Math.max(...group.map((n) => n.end));
    for (const n of group) n.hold = end;
  }
  return notes;
}

/** The notes sorted by attack, as steps with the keys that sound at each attack time (the held ones and the struck ones). */
function buildSteps(notes: PNote[], tickToSec: (tick: number) => number): Step[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.midi - b.midi);
  const steps: Step[] = [];
  let active: PNote[] = [];
  let i = 0;
  let prev: Step | undefined;
  while (i < sorted.length) {
    const t = sorted[i].start;
    active = active.filter((n) => n.hold > t);
    while (i < sorted.length && sorted[i].start === t) active.push(sorted[i++]);
    const byMidi = new Map<number, PNote[]>();
    for (const n of active) byMidi.set(n.midi, [...(byMidi.get(n.midi) ?? []), n]);
    const keys: Key[] = [...byMidi.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([midi, ns]) => ({
        midi,
        notes: ns,
        prior: Math.sign(ns.reduce((s, n) => s + n.prior, 0)),
        pin: ns.map((n) => n.pin).find((p) => p !== 0) ?? 0,
        attack: ns.some((n) => n.start === t),
        from: prev?.keys.findIndex((k) => k.midi === midi && ns.some((n) => n.start < t)) ?? -1,
      }));
    prev = { tick: t, sec: tickToSec(t), keys };
    steps.push(prev);
  }
  return steps;
}

/** Reads the notes of a score once, so that it can be solved for several settings (`solve`). */
function prepare(score: Score, pedal: PedalMode): Prepared {
  const { measureStart } = measureStarts(score);
  const tm = tempoMap(score, measureStart);
  const all = collectNotes(score, measureStart, pedal);
  const inside = all.filter((n) => n.midi >= LOWEST && n.midi <= HIGHEST);
  return {
    score,
    measureStart,
    steps: buildSteps(inside, tm.tickToSec),
    outside: all.filter((n) => n.midi < LOWEST || n.midi > HIGHEST),
  };
}

/** The measure that holds the absolute tick, and the tick in it. */
function placeOf(measureStart: number[], tick: number): { mi: number; tick: number } {
  let mi = 0;
  while (mi + 1 < measureStart.length && measureStart[mi + 1] <= tick) mi++;
  return { mi, tick: tick - measureStart[mi] };
}

/** The finding about notes of a step: the heads of the notes on `keys`. */
function headsOf(keys: Key[]): PlayNote[] {
  return keys.flatMap((k) => k.notes.map((n) => ({ ev: n.ev, pi: n.pi })));
}

/** The number of set bits of `x`. */
function popcount(x: number): number {
  let c = 0;
  for (let v = x; v; v &= v - 1) c++;
  return c;
}

/** The index of the lowest set bit of `x`. */
const lowBit = (x: number): number => 31 - Math.clz32(x & -x);

/** The index of the highest set bit of `x`. */
const highBit = (x: number): number => 31 - Math.clz32(x);

/** All divisions of the step's keys that no hand overstretches, each with its cost without the moves from the previous step. */
function statesOf(step: Step, maxSpan: number): State[] {
  const keys = step.keys;
  const n = keys.length;
  if (n === 0 || n > MAX_KEYS) return [];
  const comfort = Math.max(2, maxSpan - 2);
  const full = (1 << n) - 1;
  let wantR = 0;
  let wantL = 0;
  let pinR = 0;
  let pinL = 0;
  let attacks = 0;
  keys.forEach((k, i) => {
    if (k.prior > 0) wantR |= 1 << i;
    if (k.prior < 0) wantL |= 1 << i;
    if (k.attack) attacks |= 1 << i;
    if (k.pin > 0) pinR |= 1 << i;
    if (k.pin < 0) pinL |= 1 << i;
  });
  const out: State[] = [];
  for (let mask = 0; mask <= full; mask++) {
    if ((mask & pinR) !== pinR || mask & pinL) continue;
    const sets: [number, number] = [full & ~mask, mask];
    const count: [number, number] = [popcount(sets[0]), popcount(sets[1])];
    if (count[0] > FINGERS || count[1] > FINGERS) continue;
    const lo: [number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    const hi: [number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    let cost = PRIOR_COST * (popcount(wantR & ~mask) + popcount(wantL & mask));
    let ok = true;
    for (const h of [0, 1] as const) {
      if (!count[h]) continue;
      lo[h] = keys[lowBit(sets[h])].midi;
      hi[h] = keys[highBit(sets[h])].midi;
      if (count[h] < 2) continue;
      const span = hi[h] - lo[h];
      if (span > maxSpan) {
        ok = false;
        break;
      }
      cost += STRETCH_COST * Math.max(0, span - comfort) ** 2;
    }
    if (!ok) continue;
    if (count[0] && count[1] && hi[0] > lo[1]) cost += CROSS_COST;
    out.push({
      mask,
      cost,
      prev: -1,
      n: count,
      lo,
      hi,
      atk: [!!(attacks & sets[0]), !!(attacks & sets[1])],
      pos: [count[0] ? (lo[0] + hi[0]) / 2 : Number.NaN, count[1] ? (lo[1] + hi[1]) / 2 : Number.NaN],
      at: [step.sec, step.sec],
    });
  }
  return out;
}

/** The time a leap needs, as a share of the time there is since the hand last played, for the worse of the two hands, with that hand, the distance and the time in seconds. A move within the span of a hand is no leap: the hand reaches it by stretching. The time counts from the hand's own last attack, however many steps of the other hand lie between. */
function leapOf(
  a: State,
  b: State,
  now: number,
  maxSpan: number,
): { ratio: number; hand: 0 | 1; d: number; sec: number } {
  let worst = { ratio: 0, hand: 0 as 0 | 1, d: 0, sec: 0 };
  for (const h of [0, 1] as const) {
    if (!(b.atk[h] && b.n[h]) || Number.isNaN(a.pos[h])) continue;
    const d = Math.abs(b.pos[h] - a.pos[h]);
    if (d <= maxSpan) continue;
    const sec = now - a.at[h];
    const ratio = (LEAP_BASE_MS + LEAP_MS_PER_SEMITONE * d) / (sec * 1000);
    if (ratio > worst.ratio) worst = { ratio, hand: h, d, sec };
  }
  return worst;
}

/** Whether the division `b` of step `to` keeps the held keys with the hands that had them in `a` of the step before. */
function consistent(a: State, b: State, to: Step): boolean {
  for (let i = 0; i < to.keys.length; i++) {
    const from = to.keys[i].from;
    if (from >= 0 && ((a.mask >> from) & 1) !== ((b.mask >> i) & 1)) return false;
  }
  return true;
}

/** What went wrong at a step where the music could not be followed. */
interface Failure {
  step: number;
  kind: 'count' | 'span' | 'leap' | 'hold';
  hand?: 'L' | 'R';
  title: string;
  message: string;
  keys: Key[];
}

/** The smallest span that some division of the step's keys needs (each hand at most five keys), or Infinity when none has few enough keys. */
function neededSpan(keys: Key[]): { span: number; worse: Key[] } {
  let best = { span: Number.POSITIVE_INFINITY, worse: keys };
  for (let s = 0; s <= keys.length; s++) {
    const left = keys.slice(0, s);
    const right = keys.slice(s);
    if (left.length > FINGERS || right.length > FINGERS) continue;
    const spanL = left.length ? left[left.length - 1].midi - left[0].midi : 0;
    const spanR = right.length ? right[right.length - 1].midi - right[0].midi : 0;
    if (Math.max(spanL, spanR) < best.span)
      best = { span: Math.max(spanL, spanR), worse: spanL >= spanR ? left : right };
  }
  return best;
}

/** Explains why step `k` has no division at all. */
function staticFailure(steps: Step[], k: number, maxSpan: number): Failure {
  const keys = steps[k].keys;
  if (keys.length > MAX_KEYS)
    return {
      step: k,
      kind: 'count',
      title: `${keys.length} keys at once`,
      message: `${keys.length} keys sound at once, but two hands play at most ${MAX_KEYS}`,
      keys,
    };
  const need = neededSpan(keys);
  // Dropping a single key would do: those keys are named, with the other way out, rolling the chord.
  const without = keys.filter(
    (_, i) =>
      keys.length <= MAX_KEYS + 1 && statesOf({ ...steps[k], keys: keys.filter((_, j) => j !== i) }, maxSpan).length,
  );
  const fix = without.length
    ? ` It works without ${without
        .slice(0, 3)
        .map((key) => midiName(key.midi))
        .join(' or ')}, or if the chord is rolled.`
    : ' It works only if the chord is rolled.';
  return {
    step: k,
    kind: 'span',
    title: `Needs a span of a ${spanName(need.span)}`,
    message: `No way to divide these notes between two hands: one hand would span a ${spanName(need.span)} (${need.span} semitones), the setting allows a ${spanName(maxSpan)}.${fix}`,
    keys: need.worse,
  };
}

/** How many divisions per step the first attempt of `follow` keeps. */
const BEAM = 40;

/** What `advance` found: the divisions of a step reachable from the ones before it, the number of compatible pairs seen, and the gentlest leap among them. */
interface Connection {
  reached: State[];
  compatible: number;
  gentlest: { ratio: number; hand: 0 | 1; d: number; sec: number };
}

/** The divisions of a step reachable from the ones before it from the divisions `fromIdx` to those `toIdx`. */
function advance(
  before: State[],
  fromIdx: number[],
  fresh: State[],
  toIdx: number[],
  step: Step,
  maxSpan: number,
): Connection {
  const reached: State[] = [];
  let compatible = 0;
  let gentlest = { ratio: Number.POSITIVE_INFINITY, hand: 0 as 0 | 1, d: 0, sec: 0 };
  for (const bi of toIdx) {
    const b = fresh[bi];
    let best: State | undefined;
    for (const ai of fromIdx) {
      const a = before[ai];
      if (!consistent(a, b, step)) continue;
      compatible++;
      const leap = leapOf(a, b, step.sec, maxSpan);
      if (leap.ratio < gentlest.ratio) gentlest = leap;
      if (leap.ratio > 1) continue;
      const cost = a.cost + b.cost + LEAP_COST * leap.ratio ** 2;
      if (!best || cost < best.cost) {
        // A hand that does not play here keeps the place and time it was last seen at.
        const keep = (h: 0 | 1) => b.n[h] > 0;
        best = {
          ...b,
          cost,
          prev: ai,
          pos: [keep(0) ? b.pos[0] : a.pos[0], keep(1) ? b.pos[1] : a.pos[1]],
          at: [keep(0) ? b.at[0] : a.at[0], keep(1) ? b.at[1] : a.at[1]],
        };
      }
    }
    if (best) reached.push(best);
  }
  return { reached, compatible, gentlest };
}

/** The result of following the steps: the division chosen at each step, and where the music could not be followed. */
interface Solution {
  chosen: (State | undefined)[];
  /** Whether the division at a step follows from the one before it. */
  linked: boolean[];
  failures: Failure[];
}

/** Finds the cheapest sequence of divisions; where a step cannot follow the one before it (or has no division at all) the failure is recorded and the music starts afresh there. */
function follow(steps: Step[], maxSpan: number): Solution {
  const all: State[][] = [];
  const failures: Failure[] = [];
  let before: State[] = [];
  steps.forEach((step, k) => {
    const fresh = statesOf(step, maxSpan);
    if (!fresh.length) {
      failures.push(staticFailure(steps, k, maxSpan));
      all.push([]);
      before = [];
      return;
    }
    if (!before.length) {
      all.push(fresh);
      before = fresh;
      return;
    }
    const tried = connect(before, fresh, step, maxSpan);
    if (tried.reached.length) {
      all.push(tried.reached);
      before = tried.reached;
      return;
    }
    failures.push(transitionFailure(k, step, tried));
    all.push(fresh);
    before = fresh;
  });
  return { ...backtrack(all), failures };
}

/** The divisions of a step reachable from the ones before it. The cheapest few divisions on both sides are tried first; only when none of them connects are all of them, so that a failure is exact. */
function connect(before: State[], fresh: State[], step: Step, maxSpan: number): Connection {
  const cheapest = (states: State[]) =>
    states
      .map((_, i) => i)
      .sort((x, y) => states[x].cost - states[y].cost)
      .slice(0, BEAM);
  const tried = advance(before, cheapest(before), fresh, cheapest(fresh), step, maxSpan);
  if (tried.reached.length || !(before.length > BEAM || fresh.length > BEAM)) return tried;
  const every = (states: State[]) => states.map((_, i) => i);
  return advance(before, every(before), fresh, every(fresh), step, maxSpan);
}

/** Explains why no division of step `k` follows from the ones before: when some pair of divisions agrees about the held keys the leap is too fast, else the held notes pin the hands. */
function transitionFailure(k: number, step: Step, tried: Connection): Failure {
  const { compatible, gentlest } = tried;
  const kind = compatible ? 'leap' : 'hold';
  const ms = Math.round(gentlest.sec * 1000);
  const d = Math.round(gentlest.d);
  return {
    step: k,
    kind,
    hand: kind === 'leap' ? (gentlest.hand === 0 ? 'L' : 'R') : undefined,
    title: kind === 'leap' ? `Leap of a ${spanName(d)} in ${ms} ms` : 'Held notes pin the hands',
    message:
      kind === 'leap'
        ? `Leap of a ${spanName(d)} (${d} semitones) in ${ms} ms; it needs about ${Math.round(LEAP_BASE_MS + LEAP_MS_PER_SEMITONE * gentlest.d)} ms`
        : 'Notes held down keep the hands from reaching the next notes',
    keys: step.keys.filter((key) => kind === 'hold' || key.attack),
  };
}

/** Walks back from the end of each stretch of music along the cheapest path: the division chosen at each step, and whether it follows from the one before. */
function backtrack(all: State[][]): Pick<Solution, 'chosen' | 'linked'> {
  const chosen: (State | undefined)[] = all.map(() => undefined);
  const linked: boolean[] = all.map(() => false);
  let idx = -2;
  for (let k = all.length - 1; k >= 0; k--) {
    if (!all[k].length) {
      idx = -2;
      continue;
    }
    if (idx === -2) idx = all[k].reduce((best, s, i) => (s.cost < all[k][best].cost ? i : best), 0);
    chosen[k] = all[k][idx];
    linked[k] = all[k][idx].prev >= 0;
    idx = all[k][idx].prev;
    if (idx === -1) idx = -2;
  }
  return { chosen, linked };
}

/** A finding before neighboring ones are merged, with the step it belongs to. */
type Raw = PlayFinding & { step: number };

/** Joins findings of the same kind, severity and hand at successive steps into one, with all their notes. */
function merge(raws: Raw[]): Raw[] {
  const out: Raw[] = [];
  const last = new Map<string, Raw>();
  for (const f of raws.sort((a, b) => a.step - b.step)) {
    const id = `${f.severity}/${f.kind}/${f.hand ?? ''}`;
    const prev = last.get(id);
    if (prev && prev.step === f.step - 1) {
      prev.notes.push(
        ...f.notes.filter(
          (n) => !prev.notes.some((p) => p.pi === n.pi && JSON.stringify(p.ev) === JSON.stringify(n.ev)),
        ),
      );
      prev.step = f.step;
      continue;
    }
    const copy = { ...f, notes: [...f.notes] };
    out.push(copy);
    last.set(id, copy);
  }
  return out;
}

/** Maps an absolute tick to its measure and the tick in it. */
type Where = (tick: number) => { mi: number; tick: number };

/** The errors about notes off the keyboard. */
function rangeErrors(prep: Prepared, where: Where): Raw[] {
  return prep.outside.map(
    (n): Raw => ({
      severity: 'error',
      kind: 'range',
      title: 'Off the keyboard',
      message: `Outside the keyboard (${n.midi < LOWEST ? 'below A0' : 'above C8'})`,
      notes: [{ ev: n.ev, pi: n.pi }],
      step: -1,
      ...where(n.start),
    }),
  );
}

/** The errors where the music could not be followed (see `Failure`). */
function failureErrors(steps: Step[], sol: Solution, where: Where): Raw[] {
  return sol.failures.map(
    (f): Raw => ({
      severity: 'error',
      kind: f.kind,
      hand: f.hand,
      title: f.title,
      message: f.message,
      notes: headsOf(f.keys),
      step: f.step,
      ...where(steps[f.step].tick),
    }),
  );
}

/** The warnings on the chosen path: a hand beyond its comfortable stretch, a leap that takes most of the time there is. */
function pathWarnings(steps: Step[], sol: Solution, maxSpan: number, where: Where): Raw[] {
  const raws: Raw[] = [];
  const comfort = Math.max(2, maxSpan - 2);
  sol.chosen.forEach((st, k) => {
    if (!st) return;
    for (const h of [0, 1] as const) {
      const keys = steps[k].keys.filter((_, i) => ((st.mask >> i) & 1) === h);
      if (st.n[h] >= 2 && st.hi[h] - st.lo[h] > comfort)
        raws.push({
          severity: 'warn',
          kind: 'span',
          hand: h === 0 ? 'L' : 'R',
          title: `Stretch of a ${spanName(st.hi[h] - st.lo[h])}`,
          message: `Stretch of a ${spanName(st.hi[h] - st.lo[h])} (${st.hi[h] - st.lo[h]} semitones) in one hand, close to the limit of a ${spanName(maxSpan)}`,
          notes: headsOf(keys),
          step: k,
          ...where(steps[k].tick),
        });
    }
    const before = sol.chosen[k - 1];
    if (!(sol.linked[k] && before)) return;
    const leap = leapOf(before, st, steps[k].sec, maxSpan);
    if (leap.ratio > LEAP_WARN)
      raws.push({
        severity: 'warn',
        kind: 'leap',
        hand: leap.hand === 0 ? 'L' : 'R',
        title: `Fast leap of a ${spanName(Math.round(leap.d))}`,
        message: `Leap of a ${spanName(Math.round(leap.d))} (${Math.round(leap.d)} semitones) in ${Math.round(leap.sec * 1000)} ms, using ${Math.round(leap.ratio * 100)}% of the time it needs at most`,
        notes: headsOf(steps[k].keys.filter((key, i) => key.attack && ((st.mask >> i) & 1) === leap.hand)),
        step: k,
        ...where(steps[k].tick),
      });
  });
  return raws;
}

/** The hand of every note struck, from the divisions chosen. */
function handsOf(steps: Step[], sol: Solution): HandNote[] {
  const hands: HandNote[] = [];
  sol.chosen.forEach((st, k) => {
    if (!st) return;
    steps[k].keys.forEach((key, i) => {
      if (!key.attack) return;
      for (const n of key.notes)
        if (n.start === steps[k].tick) hands.push({ ev: n.ev, pi: n.pi, hand: (st.mask >> i) & 1 ? 'R' : 'L' });
    });
  });
  return hands;
}

/** Solves a prepared score for the setting: the findings in score order, the hand of every note and the fingers of the notes struck. Without `fingering` the fingers are not worked out (the span a piece needs does not depend on them). */
function solve(prep: Prepared, maxSpan: number, fingering = true): Analysis {
  const { steps, measureStart } = prep;
  const where: Where = (tick) => placeOf(measureStart, tick);
  const sol = follow(steps, maxSpan);
  const raws = [
    ...rangeErrors(prep, where),
    ...failureErrors(steps, sol, where),
    ...pathWarnings(steps, sol, maxSpan, where),
  ];
  const fingers: FingerNote[] = [];
  if (fingering)
    for (const h of [0, 1] as const) {
      const r = fingeringOf(prep, sol, h, maxSpan, where);
      raws.push(...r.raws);
      fingers.push(...r.fingers);
    }
  return {
    findings: merge(raws)
      .map(({ step: _step, ...f }) => f)
      .sort((a, b) => a.mi - b.mi || a.tick - b.tick),
    hands: handsOf(steps, sol),
    fingers,
  };
}

/** The fingering of one hand along the chosen path: the finger of each struck note, and the awkward places as findings that name the cheapest fingering around them. */
function fingeringOf(
  prep: Prepared,
  sol: Solution,
  h: 0 | 1,
  maxSpan: number,
  where: Where,
): { raws: Raw[]; fingers: FingerNote[] } {
  const { steps } = prep;
  const fsteps: FStep[] = [];
  /** The step of the score and the indexes of the hand's keys in it, for each step of the hand. */
  const at: { k: number; keys: number[] }[] = [];
  for (let k = 0; k < steps.length; k++) {
    const st = sol.chosen[k];
    if (!st) continue;
    const idx = steps[k].keys.map((_, i) => i).filter((i) => (((st.mask >> i) & 1) as 0 | 1) === h);
    if (!idx.length) continue;
    const prev = at[at.length - 1];
    const adjacent = !!prev && prev.k === k - 1 && sol.linked[k];
    // The hand carries on from its last step unless the music had to start afresh somewhere since: steps where only the other hand plays do not interrupt it.
    let continues = !!prev;
    for (let j = (prev?.k ?? k) + 1; j <= k && continues; j++) continues = !!sol.chosen[j] && sol.linked[j];
    fsteps.push({
      sec: steps[k].sec,
      fresh: !continues,
      keys: idx.map((i) => ({
        midi: steps[k].keys[i].midi,
        attack: steps[k].keys[i].attack,
        held: adjacent ? prev.keys.indexOf(steps[k].keys[i].from) : -1,
      })),
    });
    at.push({ k, keys: idx });
  }
  const hand = h === 0 ? 'L' : 'R';
  const result = fingerHand(fsteps, hand, maxSpan);
  const fingers: FingerNote[] = [];
  at.forEach(({ k, keys }, j) => {
    keys.forEach((ki, n) => {
      const key = steps[k].keys[ki];
      const finger = result.fingers[j][n];
      if (!key.attack || finger === undefined) return;
      for (const note of key.notes)
        if (note.start === steps[k].tick) fingers.push({ ev: note.ev, pi: note.pi, finger });
    });
  });
  const raws = result.issues.map((issue): Raw => {
    const { k, keys } = at[issue.step];
    const around = result.fingers
      .slice(Math.max(0, issue.step - 2), issue.step + 3)
      .filter((f) => f.length)
      .map((f) => f.join('-'))
      .join(' ');
    const who = h === 0 ? 'left hand' : 'right hand';
    return {
      severity: 'warn',
      kind: 'fingering',
      hand,
      title: Number.isFinite(issue.cost) ? `Awkward fingering: ${issue.why}` : 'No comfortable fingering',
      message: Number.isFinite(issue.cost)
        ? `The cheapest fingering for the ${who} still has ${issue.why} here (fingers ${around}).`
        : `No fingering of this chord keeps every pair of fingers within comfortable reach for the ${who}.`,
      notes: headsOf(keys.map((i) => steps[k].keys[i]).filter((key) => key.attack)),
      step: k,
      ...where(steps[k].tick),
    };
  });
  return { raws, fingers };
}

/** The findings of a score for the options (the default span and pedal where left out). */
export function findPlayability(score: Score, options: Partial<PlayOptions> = {}): PlayFinding[] {
  return analyzePlayability(score, options).findings;
}

/** The findings and the hand of every note of a score for the options. */
export function analyzePlayability(score: Score, options: Partial<PlayOptions> = {}): Analysis {
  const o = { ...DEFAULT_PLAY, ...options };
  return solve(prepare(score, o.pedal), o.maxSpan);
}

/** The widest span in semitones the piece needs of one hand (what `maxSpan` has to be for no span or hold error), or null when no span helps (too many keys, too fast a leap). */
export function requiredSpan(score: Score, pedal: PedalMode = DEFAULT_PLAY.pedal): number | null {
  const prep = prepare(score, pedal);
  const bad = (span: number) =>
    solve(prep, span, false).findings.some((f) => f.severity === 'error' && (f.kind === 'span' || f.kind === 'hold'));
  const WIDEST = 36;
  if (bad(WIDEST)) return null;
  if (!bad(0)) return 0;
  let lo = 0;
  let hi = WIDEST;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (bad(mid)) lo = mid;
    else hi = mid;
  }
  return hi;
}
