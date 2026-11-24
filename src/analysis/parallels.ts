// Voice-leading check: consecutive perfect intervals (parallel fifths and octaves) in a Score.
//
// The onsets and offsets of notes come straight from the tick-based voices of the Score model.
// Nothing here draws or edits anything; the editor colors the notes of the groups found (`ui/`),
// and `thomas check --parallels` lists them.
//
// Rules: a "voice" is a (staff, voice id) stream, and every pair of voices is compared,
// across staves too, as well as the notes of one chord. The same interval between the same two
// voices at two successive attacks is a violation, also across a rest that both voices share
// (rest look-through). Tie continuations are not attacks and tied-over notes are not releases, grace
// notes are not looked at, and an octave between two notes of one voice (a doubling) is allowed. The lower
// note of an octave doubling within a staff is left out altogether (`markDoublings`).
// Violations that share a note form one group; groups are numbered in score order.
//
// A chord does not say which of its notes goes to which note of the next chord, but separate voices do. So a
// violation has a level: `certain` when every note in it continues into the note of the next interval in every
// reasonable reading of the voice-leading (separate voices, notes of chords of equal size, the outer notes of a
// chord), `possible` when it only appears in some of them (`readings`): in a chord of four that goes on to a chord
// of three, one pair of notes merges, and which pair is left open. Groups are formed per level, so that a possible
// violation does not color a certain one.

import type { EvAddr } from '../editor/addr.ts';
import type { Score } from '../model.ts';
import { flattenVoice, measureTicks, pitchMidi, timeAt } from '../model.ts';
import { must } from '../util.ts';

export type ParallelKind = 'fifths' | 'octaves';

/** How sure a violation is: it is there in every reading of the voice-leading, or only in some. */
export type ParallelLevel = 'certain' | 'possible';

/** A note in a violation: the head `pi` of the event at `ev`, with its absolute onset in ticks. */
export interface ParallelNote {
  ev: EvAddr;
  pi: number;
  tick: number;
}

/** One parallel interval: two voices form `kind` at one attack and again at the next. */
export interface ParallelInterval {
  kind: ParallelKind;
  /** The corners in drawing order: the first voice then the second voice at the first attack, the second then the first voice at the next, so that the outline does not cross itself. */
  notes: [ParallelNote, ParallelNote, ParallelNote, ParallelNote];
}

/** One independent violation: the notes of all the consecutive intervals that share a note. */
export interface ParallelGroup {
  /** The position in score order, from 1. */
  number: number;
  level: ParallelLevel;
  kinds: ParallelKind[];
  /** How many intervals of each kind the group holds (a run of three fifths is 3); kinds that were not looked for are absent. */
  counts: Partial<Record<ParallelKind, number>>;
  /** The notes by onset, then by voice. */
  notes: ParallelNote[];
  /** The intervals of the group, each with its four notes, by onset. */
  intervals: ParallelInterval[];
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
  /** Whether it is the lower note of an octave doubling (`markDoublings`): it takes no part in intervals, but is part of its chord. */
  doubled: boolean;
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
              doubled: false,
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
  dropDanglingTies(notes);
  markDoublings(notes);
  return notes;
}

/**
 * Clears `tieStart` on notes whose tie leads nowhere: the voice goes on with other pitches (or ends), so the note is
 * released at its end like an untied one.
 */
function dropDanglingTies(notes: Note[]): void {
  const continued = new Set<string>();
  for (const n of notes) if (n.tieStop) continued.add(`${n.vk}|${n.start}|${n.midi}`);
  for (const n of notes) if (n.tieStart && !continued.has(`${n.vk}|${n.end}|${n.midi}`)) n.tieStart = false;
}

/** The part of a note that a result carries. */
const asNote = (n: Note): ParallelNote => ({ ev: n.ev, pi: n.pi, tick: n.start });

/**
 * Marks the lower note of an octave doubling: a note with another note on the same staff, attacked at the same
 * time, one or more octaves above it. A piano setting doubles lines at the octave, and both notes form the same
 * intervals with any other voice, so keeping both would report every violation twice. Notes of other staves
 * do not count: an octave between the hands is a real octave. A marked note still counts as a note of its chord
 * when the voice-leading is read (b-e-b going to c#-e-g# is three lines, not two).
 */
function markDoublings(notes: Note[]): void {
  const higher = new Map<string, number[]>();
  for (const n of notes) {
    const k = `${n.ev.staff}:${n.start}`;
    const list = higher.get(k);
    if (list) list.push(n.midi);
    else higher.set(k, [n.midi]);
  }
  for (const n of notes)
    n.doubled = must(higher.get(`${n.ev.staff}:${n.start}`)).some((m) => m > n.midi && (m - n.midi) % 12 === 0);
}

/** Union-find over note ids, remembering which notes were flagged and by which kind of interval. */
class Flags {
  private parent = new Map<number, number>();

  private readonly notes: Note[];

  constructor(notes: Note[]) {
    this.notes = notes;
  }

  readonly kinds = new Map<number, Set<ParallelKind>>();
  private intervals = new Map<string, { kind: ParallelKind; id: number }>();
  /** The corners of every interval flagged, by key, so that one found twice counts once. */
  readonly quads = new Map<string, { kind: ParallelKind; ids: [number, number, number, number] }>();

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
    const notes = this.notes;
    // The second interval's notes in the order of the first's (same voice, else same side), so that the corners go around.
    const [a1, b1] = [notes[ids[0]], notes[ids[1]]];
    let [a2, b2] = [notes[ids[2]], notes[ids[3]]];
    const swap = a1.vk === b1.vk ? a1.midi < b1.midi !== a2.midi < b2.midi : a2.vk !== a1.vk;
    if (swap) [a2, b2] = [b2, a2];
    // Both lines keep their pitch classes, only the octave may change: a repetition, an octave leap over a held note
    // (oblique motion) or both lines shifting register, not parallel motion.
    if (a1.midi % 12 === a2.midi % 12 && b1.midi % 12 === b2.midi % 12) return;
    this.quads.set(`${kind}:${[a1.id, b1.id, a2.id, b2.id].join(':')}`, { kind, ids: [a1.id, b1.id, b2.id, a2.id] });
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

  /** The root of the group that note `id` belongs to. */
  rootOf(id: number): number {
    return this.find(id);
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
  /** The notes of a voice that were attacked / released at a time (`voice|tick`), by pitch; tie continuations are neither. */
  private readonly attackedAt = new Map<string, Note[]>();
  private readonly releasedAt = new Map<string, Note[]>();

  constructor(notes: Note[]) {
    const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
      const list = m.get(k);
      if (list) list.push(v);
      else m.set(k, [v]);
    };
    const chords = new Map<string, Map<string, Note[]>>();
    for (const n of notes) {
      if (!n.tieStop) push(this.attackedAt, `${n.vk}|${n.start}`, n);
      if (!n.tieStart) push(this.releasedAt, `${n.vk}|${n.end}`, n);
      if (n.doubled) continue;
      push(this.endsOf, n.vk, n);
      const byKey = chords.get(n.vk) ?? new Map<string, Note[]>();
      chords.set(n.vk, byKey);
      push(byKey, `${n.start}:${n.end}`, n);
      if (!n.tieStop) {
        push(this.byStart, n.start, n);
        push(this.attacksOf, n.vk, n.start);
      }
      if (!n.tieStart) {
        push(this.byEnd, n.end, n);
      }
    }
    for (const list of [...this.attackedAt.values(), ...this.releasedAt.values()]) list.sort((a, b) => a.midi - b.midi);
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

  /** Whether the note `from` of a voice continues into the note `to` of its next chord: in every reading, in some, or in none. */
  continuation(from: Note, to: Note): ParallelLevel | undefined {
    const before = this.releasedAt.get(`${from.vk}|${from.end}`) ?? [];
    const after = this.attackedAt.get(`${to.vk}|${to.start}`) ?? [];
    const i = before.indexOf(from);
    const j = after.indexOf(to);
    if (i < 0 || j < 0) return undefined;
    const r = readings(before.length, after.length);
    const hits = r.hits[i][j];
    return hits === 0 ? undefined : hits === r.total ? 'certain' : 'possible';
  }

  /** Whether voice `vk` attacks a note strictly between `after` and `before`. */
  attackBetween(vk: string, after: number, before: number): boolean {
    const list = this.attacksOf.get(vk);
    if (!list) return false;
    return upperBound(list, after, (x) => x) < upperBound(list, before - 1, (x) => x);
  }
}

/** The readings of a chord of `m` notes going on to a chord of `n` notes, as cached by size: see `readings`. */
const readingCache = new Map<string, { hits: number[][]; total: number }>();

/**
 * The readings of the voice-leading from a chord of `m` notes (by pitch) to one of `n`: each note goes on to a
 * note, the lines do not cross, the lowest goes to the lowest and the highest to the highest, and no more
 * notes merge or split than the sizes force (equal sizes: note `i` to note `i`). Four notes into three have three
 * readings, one for each place where two notes merge. `hits[i][j]` is in how many readings note `i` goes to
 * note `j`, `total` how many readings there are.
 */
function readings(m: number, n: number): { hits: number[][]; total: number } {
  const key = `${m}:${n}`;
  const known = readingCache.get(key);
  if (known) return known;
  const hits = Array.from({ length: m }, () => new Array<number>(n).fill(0));
  let total = 0;
  const path: [number, number][] = [];
  const walk = (i: number, j: number) => {
    path.push([i, j]);
    const rows = m - 1 - i;
    const cols = n - 1 - j;
    if (rows === 0 && cols === 0) {
      total++;
      for (const [x, y] of path) hits[x][y]++;
    } else {
      if (rows > 0 && cols > 0) walk(i + 1, j + 1);
      if (rows > cols) walk(i + 1, j);
      if (cols > rows) walk(i, j + 1);
    }
    path.pop();
  };
  walk(0, 0);
  const out = { hits, total };
  readingCache.set(key, out);
  return out;
}

/** The weaker of two levels; undefined if either is. */
const weaker = (x?: ParallelLevel, y?: ParallelLevel): ParallelLevel | undefined =>
  !(x && y) ? undefined : x === 'certain' && y === 'certain' ? 'certain' : 'possible';

/** The better of two levels, undefined if both are. */
const better = (x?: ParallelLevel, y?: ParallelLevel): ParallelLevel | undefined =>
  x === 'certain' || !y ? x : y === 'certain' ? y : (x ?? y);

/** Collects the intervals found with their levels, once each, and then sorts them into one `Flags` per level. */
class Candidates {
  private readonly found = new Map<string, { ids: number[]; kind: ParallelKind; level: ParallelLevel }>();

  private readonly notes: Note[];

  private readonly idx: VoiceIndex;

  constructor(notes: Note[], idx: VoiceIndex) {
    this.notes = notes;
    this.idx = idx;
  }

  /** The level of the notes `ids`: an interval (a, b) and the one (a, b) of the next attack; undefined if the voices do not lead from one to the other. */
  private levelOf([a1, b1, a2, b2]: Note[]): ParallelLevel | undefined {
    const c = (x: Note, y: Note) => this.idx.continuation(x, y);
    const straight = weaker(c(a1, a2), c(b1, b2));
    // Two voices: the notes of a voice go on in that voice. Inside one voice either note may go to either.
    if (a1.vk !== b1.vk) return a1.vk === a2.vk ? straight : weaker(c(a1, b2), c(b1, a2));
    return better(straight, weaker(c(a1, b2), c(b1, a2)));
  }

  /** Records an interval of `kind` by `ids` (the notes of the first attack, then those of the next); one the voice-leading rules out is dropped. */
  flag(ids: number[], kind: ParallelKind): void {
    const level = this.levelOf(ids.map((id) => this.notes[id]));
    if (!level) return;
    const key = `${kind}:${[...ids].sort((a, b) => a - b).join(':')}`;
    const old = this.found.get(key);
    if (!old || (level === 'certain' && old.level === 'possible')) this.found.set(key, { ids, kind, level });
  }

  /** The intervals of each level, grouped. */
  split(): Record<ParallelLevel, Flags> {
    const out = { certain: new Flags(this.notes), possible: new Flags(this.notes) };
    for (const { ids, kind, level } of this.found.values()) out[level].flag(ids, kind);
    return out;
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
function lookThroughBetween(
  p: Pair,
  t: number,
  semitones: number,
  idx: VoiceIndex,
  flags: Candidates,
  kind: ParallelKind,
) {
  const prevA = idx.lastSounding(p.a.vk, t);
  const prevB = idx.lastSounding(p.b.vk, t);
  if (!(prevA && prevB)) return;
  if (prevA.end === t && prevB.end === t) return; // The direct boundary handles that.
  if (!(forms(prevA.midi, prevB.midi, semitones) && overlap(prevA, prevB))) return;
  if (idx.attackBetween(p.a.vk, prevA.end, t) || idx.attackBetween(p.b.vk, prevB.end, t)) return;
  flags.flag([prevA.id, prevB.id, p.a.id, p.b.id], kind);
}

/** Rest look-through for a new pair inside one voice (two members of a chord): the previous chord of the voice holds a pair of the interval. */
function lookThroughInside(
  p: Pair,
  t: number,
  semitones: number,
  idx: VoiceIndex,
  flags: Candidates,
  kind: ParallelKind,
) {
  const prev = idx.lastChord(p.a.vk, t);
  if (!prev) return;
  const end = prev[0].end;
  if (end === t || idx.attackBetween(p.a.vk, end, t)) return;
  for (let i = 0; i < prev.length; i++)
    for (let j = i + 1; j < prev.length; j++)
      if (forms(prev[i].midi, prev[j].midi, semitones)) flags.flag([prev[i].id, prev[j].id, p.a.id, p.b.id], kind);
}

/** The groups of the violations in `flags`, each with its first note (for the order) and the level. */
function groupsOf(
  flags: Flags,
  notes: Note[],
  kinds: ParallelKind[],
  level: ParallelLevel,
): { first: Note; group: ParallelGroup }[] {
  const counts = flags.countsByRoot();
  const intervalsByRoot = new Map<number, ParallelInterval[]>();
  for (const q of flags.quads.values()) {
    const r = flags.rootOf(q.ids[0]);
    const list = intervalsByRoot.get(r) ?? [];
    intervalsByRoot.set(r, list);
    list.push({ kind: q.kind, notes: q.ids.map((id) => asNote(notes[id])) as ParallelInterval['notes'] });
  }
  return [...flags.components()].map(([root, ids]) => {
    const g = ids.map((id) => notes[id]).sort(noteOrder);
    const ks = new Set<ParallelKind>();
    for (const n of g) for (const k of must(flags.kinds.get(n.id))) ks.add(k);
    const first = g[0];
    return {
      first,
      group: {
        number: 0,
        level,
        kinds: kinds.filter((k) => ks.has(k)),
        counts: counts.get(root) ?? {},
        notes: g.map(asNote),
        intervals: (intervalsByRoot.get(root) ?? []).sort((a, b) => a.notes[0].tick - b.notes[0].tick),
        mi: first.ev.mi,
        tick: first.at,
      },
    };
  });
}

/** Notes by onset, then voice, then head. */
const noteOrder = (a: Note, b: Note) => a.start - b.start || (a.vk < b.vk ? -1 : a.vk > b.vk ? 1 : 0) || a.pi - b.pi;

/**
 * The groups of consecutive fifths and/or octaves in `score`, in score order (earliest first). The
 * default checks both; a note in violations of both kinds joins them into one group.
 */
export function findParallels(score: Score, kinds: ParallelKind[] = ['fifths', 'octaves']): ParallelGroup[] {
  const notes = collectNotes(score);
  const idx = new VoiceIndex(notes);
  const found = new Candidates(notes, idx);
  for (const kind of kinds) {
    const semitones = SEMITONES[kind];
    const ending = pairsByTime(idx.byEnd, semitones);
    const starting = pairsByTime(idx.byStart, semitones);
    // The direct boundary: the interval of two voices ends where the same two voices form it again.
    for (const [t, ends] of ending) {
      const starts = starting.get(t);
      if (starts)
        for (const e of ends)
          for (const s of starts) if (e.voices === s.voices) found.flag([e.a.id, e.b.id, s.a.id, s.b.id], kind);
    }
    for (const [t, ps] of starting)
      for (const p of ps)
        if (p.a.vk === p.b.vk) lookThroughInside(p, t, semitones, idx, found, kind);
        else lookThroughBetween(p, t, semitones, idx, found, kind);
  }
  const flags = found.split();
  const groups = [
    ...groupsOf(flags.certain, notes, kinds, 'certain'),
    ...groupsOf(flags.possible, notes, kinds, 'possible'),
  ];
  groups.sort((a, b) => noteOrder(a.first, b.first));
  return groups.map(({ group }, i) => ({ ...group, number: i + 1 }));
}
