// Voice-leading check: consecutive perfect intervals (parallel fifths and octaves) in a Score.
//
// A port of the detector of the `conseq` tool, which worked on MusicXML elements, to the Score model:
// there the onsets and offsets of notes come straight from the tick-based voices instead of being
// rebuilt from durations. Nothing here draws or edits anything; the editor colors the notes of the
// groups found (`ui/`), and `thomas check --parallels` lists them.
//
// Rules, as in conseq: a "voice" is a (staff, voice id) stream, and every pair of voices is compared,
// across staves too, as well as the notes of one chord. The same interval between the same two
// voices at two successive attacks is a violation, also across a rest that both voices share
// (rest look-through). Tie continuations are not attacks and tied-over notes are not releases, grace
// notes are not looked at, and an octave between two notes of one voice (a doubling) is allowed.
// Violations that share a note form one group; groups are numbered in score order.

import type { EvAddr } from '../editor/addr.ts';
import type { Score } from '../model.ts';
import { flattenVoice, measureTicks, pitchMidi, timeAt } from '../model.ts';
import { must } from '../util.ts';

export type ParallelKind = 'fifths' | 'octaves';

/** A note in a violation: the head `pi` of the event at `ev`, with its absolute onset in ticks. */
export interface ParallelNote {
  ev: EvAddr;
  pi: number;
  tick: number;
}

/** One independent violation: the notes of all the consecutive intervals that share a note. */
export interface ParallelGroup {
  /** The position in score order, from 1. */
  number: number;
  kinds: ParallelKind[];
  /** How many intervals of each kind the group holds (a run of three fifths is 3); kinds that were not looked for are absent. */
  counts: Partial<Record<ParallelKind, number>>;
  /** The notes by onset, then by voice. */
  notes: ParallelNote[];
  /** The measure and the tick in it of the first note. */
  mi: number;
  tick: number;
}

/** A pitched, non-grace note of the score. */
interface Note {
  id: number;
  start: number;
  /** The onset within its measure. */
  at: number;
  end: number;
  midi: number;
  vk: string;
  ev: EvAddr;
  pi: number;
  tieStart: boolean;
  tieStop: boolean;
}

/** Two notes that sound at one time and form the interval; `voices` names the voices involved. */
interface Pair {
  a: Note;
  b: Note;
  voices: string;
}

/** The voices in the group, such as "rh.1 + lh.1". */
export function voicesOf(g: ParallelGroup): string {
  return [...new Set(g.notes.map((n) => `${n.ev.staff}.${n.ev.voice}`))].join(' + ');
}

const SEMITONES: Record<ParallelKind, number> = { fifths: 7, octaves: 0 };

/** Whether the pitches form the interval: a fifth is 7 semitones modulo 12, an octave a non-zero multiple of 12. */
function forms(midiA: number, midiB: number, semitones: number): boolean {
  const d = Math.abs(midiA - midiB);
  return semitones === 0 ? d > 0 && d % 12 === 0 : d % 12 === semitones;
}

/** The first index in sorted `xs` whose key is greater than `t` (so the entries before it are those with key <= t). */
function upperBound<T>(xs: T[], t: number, key: (x: T) => number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(xs[mid]) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Collects the notes of all voices with their absolute times, tie flags and voice keys. */
function collectNotes(score: Score): Note[] {
  const notes: Note[] = [];
  // The last event of each voice, to tell tie continuations: its pitches that are tied on.
  let tiedInto = new Map<string, Set<number>>();
  let base = 0;
  score.measures.forEach((m, mi) => {
    const next = new Map<string, Set<number>>();
    for (const [staff, sm] of Object.entries(m.staves)) {
      for (const v of sm.voices) {
        const vk = `${staff}/${v.id}`;
        let carried = tiedInto.get(vk);
        for (const te of flattenVoice(v)) {
          const e = te.ev;
          if (e.kind !== 'note') {
            carried = undefined;
            continue;
          }
          const tied = new Set<number>();
          e.pitches.forEach((np, pi) => {
            const midi = pitchMidi(np.pitch);
            notes.push({
              id: notes.length,
              start: base + te.start,
              at: te.start,
              end: base + te.start + te.ticks,
              midi,
              vk,
              ev: { mi, staff, voice: v.id, idx: te.index },
              pi,
              tieStart: !!np.tie,
              tieStop: !!carried?.has(midi),
            });
            if (np.tie) tied.add(midi);
          });
          carried = tied;
        }
        next.set(vk, carried ?? new Set());
      }
    }
    tiedInto = next;
    base += measureTicks(timeAt(score, mi));
  });
  return notes;
}

/** Union-find over note ids, remembering which notes were flagged and by which kind of interval. */
class Flags {
  private parent = new Map<number, number>();
  readonly kinds = new Map<number, Set<ParallelKind>>();
  private intervals = new Map<string, { kind: ParallelKind; id: number }>();

  private find(x: number): number {
    let r = x;
    while (must(this.parent.get(r)) !== r) r = must(this.parent.get(r));
    // Path compression: everything on the way points at the root.
    for (let n = x; n !== r; ) {
      const up = must(this.parent.get(n));
      this.parent.set(n, r);
      n = up;
    }
    return r;
  }

  /** Marks the notes as violating and puts them into one group. `ids` are two intervals: a, b, then a, b of the next. */
  flag(ids: number[], kind: ParallelKind): void {
    for (const [x, y] of [
      [ids[0], ids[1]],
      [ids[2], ids[3]],
    ])
      this.intervals.set(`${kind}:${Math.min(x, y)}:${Math.max(x, y)}`, { kind, id: x });
    for (const id of ids) {
      if (!this.parent.has(id)) this.parent.set(id, id);
      const ks = this.kinds.get(id) ?? new Set();
      ks.add(kind);
      this.kinds.set(id, ks);
    }
    const r = this.find(ids[0]);
    for (const id of ids.slice(1)) this.parent.set(this.find(id), r);
  }

  /** The number of distinct intervals of each kind by group root. */
  countsByRoot(): Map<number, Partial<Record<ParallelKind, number>>> {
    const out = new Map<number, Partial<Record<ParallelKind, number>>>();
    for (const { kind, id } of this.intervals.values()) {
      const r = this.find(id);
      const c = out.get(r) ?? {};
      c[kind] = (c[kind] ?? 0) + 1;
      out.set(r, c);
    }
    return out;
  }

  /** The flagged note ids by group root. */
  components(): Map<number, number[]> {
    const out = new Map<number, number[]>();
    for (const id of this.parent.keys()) {
      const r = this.find(id);
      const list = out.get(r);
      if (list) list.push(id);
      else out.set(r, [id]);
    }
    return out;
  }
}

/** The lookups of the detector: the attacks and releases by time, and per voice the notes by end, the chords and the attacks. */
class VoiceIndex {
  readonly byStart = new Map<number, Note[]>();
  readonly byEnd = new Map<number, Note[]>();
  private readonly endsOf = new Map<string, Note[]>();
  private readonly chordsOf = new Map<string, Note[][]>();
  private readonly attacksOf = new Map<string, number[]>();

  constructor(notes: Note[]) {
    const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
      const list = m.get(k);
      if (list) list.push(v);
      else m.set(k, [v]);
    };
    const chords = new Map<string, Map<string, Note[]>>();
    for (const n of notes) {
      push(this.endsOf, n.vk, n);
      const byKey = chords.get(n.vk) ?? new Map<string, Note[]>();
      chords.set(n.vk, byKey);
      push(byKey, `${n.start}:${n.end}`, n);
      if (!n.tieStop) {
        push(this.byStart, n.start, n);
        push(this.attacksOf, n.vk, n.start);
      }
      if (!n.tieStart) push(this.byEnd, n.end, n);
    }
    for (const list of this.endsOf.values()) list.sort((a, b) => a.end - b.end || a.start - b.start || a.midi - b.midi);
    for (const list of this.attacksOf.values()) list.sort((a, b) => a - b);
    for (const [vk, byKey] of chords)
      this.chordsOf.set(
        vk,
        [...byKey.values()].sort((a, b) => a[0].end - b[0].end || a[0].start - b[0].start),
      );
  }

  /** The most recent note of voice `vk` that stopped sounding at or before `t` and is not tied on. */
  lastSounding(vk: string, t: number): Note | undefined {
    const list = this.endsOf.get(vk);
    if (!list) return undefined;
    for (let i = upperBound(list, t, (n) => n.end) - 1; i >= 0; i--) if (!list[i].tieStart) return list[i];
    return undefined;
  }

  /** The most recent chord of voice `vk` that ended at or before `t` and is not tied on. */
  lastChord(vk: string, t: number): Note[] | undefined {
    const list = this.chordsOf.get(vk);
    if (!list) return undefined;
    for (let i = upperBound(list, t, (c) => c[0].end) - 1; i >= 0; i--)
      if (!list[i].some((n) => n.tieStart)) return list[i];
    return undefined;
  }

  /** Whether voice `vk` attacks a note strictly between `after` and `before`. */
  attackBetween(vk: string, after: number, before: number): boolean {
    const list = this.attacksOf.get(vk);
    if (!list) return false;
    return upperBound(list, after, (x) => x) < upperBound(list, before - 1, (x) => x);
  }
}

/** Whether two notes sounded at the same time at some moment. */
const overlap = (a: Note, b: Note): boolean => a.start < b.end && b.start < a.end;

/** All pairs among `group` (notes sounding together) that form the interval; the octave of one voice with itself is a doubling and does not count. */
function pairsOf(group: Note[], semitones: number): Pair[] {
  const out: Pair[] = [];
  for (let i = 0; i < group.length; i++)
    for (let j = i + 1; j < group.length; j++) {
      const a = group[i];
      const b = group[j];
      if (!forms(a.midi, b.midi, semitones)) continue;
      if (semitones === 0 && a.vk === b.vk) continue;
      out.push({ a, b, voices: a.vk === b.vk ? a.vk : [a.vk, b.vk].sort().join('|') });
    }
  return out;
}

/** Pairs by time of the groups in `byTime` that have at least one. */
function pairsByTime(byTime: Map<number, Note[]>, semitones: number): Map<number, Pair[]> {
  const out = new Map<number, Pair[]>();
  for (const [t, g] of byTime) {
    const ps = pairsOf(g, semitones);
    if (ps.length) out.set(t, ps);
  }
  return out;
}

/**
 * Rest look-through for a new pair in two voices: the previous notes of the two voices formed the
 * interval, overlapped, and neither voice attacked anything since (they rested or held on).
 */
function lookThroughBetween(p: Pair, t: number, semitones: number, idx: VoiceIndex, flags: Flags, kind: ParallelKind) {
  const prevA = idx.lastSounding(p.a.vk, t);
  const prevB = idx.lastSounding(p.b.vk, t);
  if (!(prevA && prevB)) return;
  if (prevA.end === t && prevB.end === t) return; // The direct boundary handles that.
  if (!(forms(prevA.midi, prevB.midi, semitones) && overlap(prevA, prevB))) return;
  if (idx.attackBetween(p.a.vk, prevA.end, t) || idx.attackBetween(p.b.vk, prevB.end, t)) return;
  flags.flag([prevA.id, prevB.id, p.a.id, p.b.id], kind);
}

/** Rest look-through for a new pair inside one voice (two members of a chord): the previous chord of the voice holds a pair of the interval. */
function lookThroughInside(p: Pair, t: number, semitones: number, idx: VoiceIndex, flags: Flags, kind: ParallelKind) {
  const prev = idx.lastChord(p.a.vk, t);
  if (!prev) return;
  const end = prev[0].end;
  if (end === t || idx.attackBetween(p.a.vk, end, t)) return;
  for (let i = 0; i < prev.length; i++)
    for (let j = i + 1; j < prev.length; j++)
      if (forms(prev[i].midi, prev[j].midi, semitones)) flags.flag([prev[i].id, prev[j].id, p.a.id, p.b.id], kind);
}

/**
 * The groups of consecutive fifths and/or octaves in `score`, in score order (earliest first). The
 * default checks both; a note in violations of both kinds joins them into one group.
 */
export function findParallels(score: Score, kinds: ParallelKind[] = ['fifths', 'octaves']): ParallelGroup[] {
  const notes = collectNotes(score);
  const idx = new VoiceIndex(notes);
  const flags = new Flags();
  for (const kind of kinds) {
    const semitones = SEMITONES[kind];
    const ending = pairsByTime(idx.byEnd, semitones);
    const starting = pairsByTime(idx.byStart, semitones);
    // The direct boundary: the interval of two voices ends where the same two voices form it again.
    for (const [t, ends] of ending) {
      const starts = starting.get(t);
      if (starts)
        for (const e of ends)
          for (const s of starts) if (e.voices === s.voices) flags.flag([e.a.id, e.b.id, s.a.id, s.b.id], kind);
    }
    for (const [t, ps] of starting)
      for (const p of ps)
        if (p.a.vk === p.b.vk) lookThroughInside(p, t, semitones, idx, flags, kind);
        else lookThroughBetween(p, t, semitones, idx, flags, kind);
  }
  const order = (a: Note, b: Note) => a.start - b.start || (a.vk < b.vk ? -1 : a.vk > b.vk ? 1 : 0) || a.pi - b.pi;
  const counts = flags.countsByRoot();
  const groups = [...flags.components()].map(([root, ids]) => ({
    root,
    notes: ids.map((id) => notes[id]).sort(order),
  }));
  groups.sort((a, b) => order(a.notes[0], b.notes[0]));
  return groups.map(({ root, notes: g }, i) => {
    const ks = new Set<ParallelKind>();
    for (const n of g) for (const k of must(flags.kinds.get(n.id))) ks.add(k);
    const first = g[0];
    return {
      number: i + 1,
      kinds: kinds.filter((k) => ks.has(k)),
      counts: counts.get(root) ?? {},
      notes: g.map((n) => ({ ev: n.ev, pi: n.pi, tick: n.start })),
      mi: first.ev.mi,
      tick: first.at,
    };
  });
}
