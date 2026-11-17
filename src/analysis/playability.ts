// Playability check for piano music: which passages no pair of hands can play, and which only just.
//
// The notes of the keyboard staves are turned into steps (one per attack time, holding the keys that sound
// then), and the hands are inferred, not read from the staves: a dynamic program over all ways of dividing
// each step's keys between the left and the right hand picks the cheapest path. A division is possible when each
// hand has at most five keys within the player's span (`maxSpan`), and a move between two steps is possible when
// the hand can get there in the time between the attacks. The staves only act as a prior (a note taken by the
// other hand costs a little), so music with crossings or both hands on one staff is judged by what the hands
// could do, not by how it is written. Where no division is possible the findings are errors; where the best
// path still stretches or hurries, they are warnings. Nothing here draws anything: the editor lists and
// colors the notes of the findings (`ui/`), and `thomas check --playability` prints them.
//
// What counts as held: a finger holds a note for its written length (ties merged), except where the pedal
// can carry it (`PedalMode`) or the note is staccato. Not modeled yet: grace notes, trills (the second
// finger), the finger-level costs of a fingering, arpeggiated chords (their notes are left out), repeated
// strikes of a key that is still held, and non-keyboard staves outside the first brace.

import type { EvAddr } from '../editor/addr.ts';
import type { Score } from '../model.ts';
import { flattenVoice, marksOf, pitchMidi } from '../model.ts';
import { measureStarts, tempoMap } from '../playback/sequence.ts';

/** Whether the sustain pedal is assumed to carry held notes: where the score marks it (`explicit`), everywhere (`assumed`), or nowhere (`never`). */
export type PedalMode = 'explicit' | 'assumed' | 'never';

export interface PlayOptions {
  /** The widest span of one hand in semitones, from thumb to little finger (an octave is 12, a ninth 14, a tenth 16). */
  maxSpan: number;
  pedal: PedalMode;
}

export const DEFAULT_PLAY: PlayOptions = { maxSpan: 14, pedal: 'assumed' };

/** What a finding is about: a note off the keyboard, too many keys, a span too wide, a leap too fast, or held notes that keep the hands from the next ones. */
export type PlayKind = 'range' | 'count' | 'span' | 'leap' | 'hold';

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

/** The lowest and highest key of a piano. */
const LOWEST = 21;
const HIGHEST = 108;

/** The most keys one hand can hold down. */
const FINGERS = 5;

/** A leap of `d` semitones needs about `LEAP_BASE_MS + LEAP_MS_PER_SEMITONE * d` milliseconds, counted from one attack of the hand to the next. */
const LEAP_BASE_MS = 30;
const LEAP_MS_PER_SEMITONE = 5;

/** A leap that uses more than this share of the time there is is a warning. */
const LEAP_WARN = 0.7;

/** The weights of the path cost: a note in the other hand's staff, hands that interleave, the squared stretch beyond the comfortable span, the squared share of the leap time used. */
const PRIOR_COST = 1;
const CROSS_COST = 3;
const STRETCH_COST = 0.5;
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
  ev: EvAddr;
  pi: number;
}

/** One key that sounds at a step, with the notes on it (unisons share a key). */
interface Key {
  midi: number;
  notes: PNote[];
  prior: number;
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
export interface Prepared {
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
}

/** The generic name of an interval of `semitones`: "octave", "9th", "10th". */
export function spanName(semitones: number): string {
  if (semitones === 0) return 'unison';
  const generic = [1, 2, 2, 3, 3, 4, 5, 5, 6, 6, 7, 7][semitones % 12] + 7 * Math.floor(semitones / 12);
  return generic === 8 ? 'octave' : `${generic}th`;
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
        attack: ns.some((n) => n.start === t),
        from: prev?.keys.findIndex((k) => k.midi === midi && ns.some((n) => n.start < t)) ?? -1,
      }));
    prev = { tick: t, sec: tickToSec(t), keys };
    steps.push(prev);
  }
  return steps;
}

/** Reads the notes of a score once, so that it can be solved for several settings (`solve`). */
export function prepare(score: Score, pedal: PedalMode): Prepared {
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
  let attacks = 0;
  keys.forEach((k, i) => {
    if (k.prior > 0) wantR |= 1 << i;
    if (k.prior < 0) wantL |= 1 << i;
    if (k.attack) attacks |= 1 << i;
  });
  const out: State[] = [];
  for (let mask = 0; mask <= full; mask++) {
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
    out.push({ mask, cost, prev: -1, n: count, lo, hi, atk: [!!(attacks & sets[0]), !!(attacks & sets[1])] });
  }
  return out;
}

/** The time a leap of `d` semitones needs, as a share of the `sec` seconds there are, for the worse of the two hands, with that hand and distance. */
function leapOf(a: State, b: State, sec: number): { ratio: number; hand: 0 | 1; d: number } {
  let worst = { ratio: 0, hand: 0 as 0 | 1, d: 0 };
  for (const h of [0, 1] as const) {
    if (!(b.atk[h] && a.n[h] && b.n[h])) continue;
    const d = Math.abs((b.lo[h] + b.hi[h]) / 2 - (a.lo[h] + a.hi[h]) / 2);
    const ratio = (LEAP_BASE_MS + LEAP_MS_PER_SEMITONE * d) / (sec * 1000);
    if (ratio > worst.ratio) worst = { ratio, hand: h, d };
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
  return {
    step: k,
    kind: 'span',
    title: `Needs a span of a ${spanName(need.span)}`,
    message: `No way to divide these notes between two hands: one hand would span a ${spanName(need.span)} (${need.span} semitones), the setting allows a ${spanName(maxSpan)}`,
    keys: need.worse,
  };
}

/** How many divisions per step the first attempt of `follow` keeps. */
const BEAM = 40;

/** The divisions of a step reachable from the ones before it (those chosen by index), the number of compatible pairs seen, and the gentlest leap among them. */
function advance(
  before: State[],
  fromIdx: number[],
  fresh: State[],
  toIdx: number[],
  step: Step,
  sec: number,
): { reached: State[]; compatible: number; gentlest: { ratio: number; hand: 0 | 1; d: number } } {
  const reached: State[] = [];
  let compatible = 0;
  let gentlest = { ratio: Number.POSITIVE_INFINITY, hand: 0 as 0 | 1, d: 0 };
  for (const bi of toIdx) {
    const b = fresh[bi];
    let best: State | undefined;
    for (const ai of fromIdx) {
      const a = before[ai];
      if (!consistent(a, b, step)) continue;
      compatible++;
      const leap = leapOf(a, b, sec);
      if (leap.ratio < gentlest.ratio) gentlest = leap;
      if (leap.ratio > 1) continue;
      const cost = a.cost + b.cost + LEAP_COST * leap.ratio ** 2;
      if (!best || cost < best.cost) best = { ...b, cost, prev: ai };
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
    const sec = step.sec - steps[k - 1].sec;
    // The cheapest few divisions on both sides are tried first; only when none of them connects are all of them, so that a failure is exact.
    const cheapest = (states: State[]) =>
      states
        .map((_, i) => i)
        .sort((x, y) => states[x].cost - states[y].cost)
        .slice(0, BEAM);
    let tried = advance(before, cheapest(before), fresh, cheapest(fresh), step, sec);
    if (!tried.reached.length && (before.length > BEAM || fresh.length > BEAM))
      tried = advance(
        before,
        before.map((_, i) => i),
        fresh,
        fresh.map((_, i) => i),
        step,
        sec,
      );
    const { reached, compatible, gentlest } = tried;
    if (reached.length) {
      all.push(reached);
      before = reached;
      return;
    }
    const kind = compatible ? 'leap' : 'hold';
    const hand = gentlest.hand === 0 ? 'L' : 'R';
    failures.push({
      step: k,
      kind,
      hand: kind === 'leap' ? hand : undefined,
      title:
        kind === 'leap'
          ? `Leap of a ${spanName(Math.round(gentlest.d))} in ${Math.round(sec * 1000)} ms`
          : 'Held notes pin the hands',
      message:
        kind === 'leap'
          ? `Leap of a ${spanName(Math.round(gentlest.d))} (${Math.round(gentlest.d)} semitones) in ${Math.round(sec * 1000)} ms; it needs about ${Math.round(LEAP_BASE_MS + LEAP_MS_PER_SEMITONE * gentlest.d)} ms`
          : 'Notes held down keep the hands from reaching the next notes',
      keys: step.keys.filter((key) => kind === 'hold' || key.attack),
    });
    all.push(fresh);
    before = fresh;
  });
  const chosen: (State | undefined)[] = steps.map(() => undefined);
  const linked: boolean[] = steps.map(() => false);
  let idx = -2;
  for (let k = steps.length - 1; k >= 0; k--) {
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
  return { chosen, linked, failures };
}

/** A finding before neighbouring ones are merged, with the step it belongs to. */
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

/** Solves a prepared score for the setting and lists the findings in score order. */
export function solve(prep: Prepared, maxSpan: number): PlayFinding[] {
  const { steps, measureStart } = prep;
  const where = (tick: number) => placeOf(measureStart, tick);
  const raws: Raw[] = [];
  for (const n of prep.outside)
    raws.push({
      severity: 'error',
      kind: 'range',
      title: 'Off the keyboard',
      message: `Outside the keyboard (${n.midi < LOWEST ? 'below A0' : 'above C8'})`,
      notes: [{ ev: n.ev, pi: n.pi }],
      step: -1,
      ...where(n.start),
    });
  const sol = follow(steps, maxSpan);
  for (const f of sol.failures)
    raws.push({
      severity: 'error',
      kind: f.kind,
      hand: f.hand,
      title: f.title,
      message: f.message,
      notes: headsOf(f.keys),
      step: f.step,
      ...where(steps[f.step].tick),
    });
  // Warnings on the chosen path: a hand beyond its comfortable stretch, a leap that takes most of the time there is.
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
    const leap = leapOf(before, st, steps[k].sec - steps[k - 1].sec);
    if (leap.ratio > LEAP_WARN)
      raws.push({
        severity: 'warn',
        kind: 'leap',
        hand: leap.hand === 0 ? 'L' : 'R',
        title: `Fast leap of a ${spanName(Math.round(leap.d))}`,
        message: `Leap of a ${spanName(Math.round(leap.d))} (${Math.round(leap.d)} semitones) in ${Math.round((steps[k].sec - steps[k - 1].sec) * 1000)} ms, using ${Math.round(leap.ratio * 100)}% of the time it needs at most`,
        notes: headsOf(steps[k].keys.filter((key, i) => key.attack && ((st.mask >> i) & 1) === leap.hand)),
        step: k,
        ...where(steps[k].tick),
      });
  });
  return merge(raws)
    .map(({ step: _step, ...f }) => f)
    .sort((a, b) => a.mi - b.mi || a.tick - b.tick);
}

/** The findings of a score for the options (the default span and pedal where left out). */
export function findPlayability(score: Score, options: Partial<PlayOptions> = {}): PlayFinding[] {
  const o = { ...DEFAULT_PLAY, ...options };
  return solve(prepare(score, o.pedal), o.maxSpan);
}

/** The widest span in semitones the piece needs of one hand (what `maxSpan` has to be for no span or hold error), or null when no span helps (too many keys, too fast a leap). */
export function requiredSpan(score: Score, pedal: PedalMode = DEFAULT_PLAY.pedal): number | null {
  const prep = prepare(score, pedal);
  const bad = (span: number) =>
    solve(prep, span).some((f) => f.severity === 'error' && (f.kind === 'span' || f.kind === 'hold'));
  const WIDEST = 36;
  if (bad(WIDEST)) return null;
  let lo = 0;
  let hi = WIDEST;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (bad(mid)) lo = mid;
    else hi = mid;
  }
  return hi;
}
