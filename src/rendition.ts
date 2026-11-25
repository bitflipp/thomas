// Import of a rendition made with Pianizer (the piano roll editor that this expression layer replaces)
// into a score. A Pianizer project is the notes of the same piece with velocities and moved or resized
// notes, plus a sustain curve, a tempo ratio curve and una corda regions. The import is best effort: the
// notes of the project are matched to the heads of the score by pitch and time, the differences become the
// `vel`, `shift` and `gate` of the heads, and the three curves become the score's `performance`. The
// result is exactly what the project sounded like, as far as the score has the same notes. Headless, so
// that it can be tested; `cli.ts` reads and writes the files.

import type { CurvePoint, Event, Pos, Score, SoftRegion } from './model.ts';
import { flattenVoice, lengthOf, PPQ, validate } from './model.ts';
import type { HeadAt, Note } from './playback/sequence.ts';
import { buildSequence, measureStarts } from './playback/sequence.ts';
import { must } from './util.ts';

/** The parts of a Pianizer project file that the import reads (`saveProject` in Pianizer's `engine/state.js`). */
export interface PianizerProject {
  version: number;
  ticksPerBeat: number;
  notes: { pitch: number; velocity: number; startTick: number; endTick: number; muted?: boolean }[];
  pedalPoints?: { tick: number; value: number }[];
  tempoPoints?: { tick: number; value: number }[];
  softPedalRegions?: { startTick: number; endTick: number }[];
}

export interface RenditionOptions {
  /** How far (in quarter notes) a note of the project may be from the head of the score it is matched to. Default: a half quarter. */
  tolerance?: number;
}

/** What the import did, for the person to judge whether it found the right notes. */
export interface RenditionReport {
  /** The notes of the project that were considered (muted ones are left out). */
  notes: number;
  /** How many of them were matched to a note of the score. */
  matched: number;
  /** Notes of the project without a note in the score nearby, as `m<N> beat <b> <midi>` (the first few). */
  unmatchedNotes: string[];
  unmatchedCount: number;
  /** The heads of the score (first sounding note of each) that no note of the project matched. */
  headsWithoutNote: number;
  heads: number;
  /** Heads without a note of their own that were given the expression of a unison head at the same instant (counted among those with a note). */
  headsCopied: number;
  /** Muted notes of the project, which sound in the score all the same. */
  muted: number;
  /** How many heads got a velocity, a shift and a gate. */
  velocities: number;
  shifts: number;
  gates: number;
  /** Points of the curves taken over. */
  tempoPoints: number;
  sustainPoints: number;
  softRegions: number;
}

/** The start and end of a note, in ticks of the score. */
interface Span {
  at: number;
  end: number;
}

/**
 * The sorted pairs of an optimal one-to-one matching of two lists sorted by start, where a pair starts at most
 * `tol` apart; it matches as many as possible, then the ones with the nearest starts, and of equal starts the
 * ones with the nearest ends.
 */
function matchSorted(a: Span[], b: Span[], tol: number): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (!(n && m)) return [];
  const pairs: [number, number][] = [];
  if (n * m > 4e7) {
    // Too large for the table: pair neighbors greedily.
    let j = 0;
    for (let i = 0; i < n; i++) {
      while (j < m && b[j].at < a[i].at - tol) j++;
      if (j < m && Math.abs(b[j].at - a[i].at) <= tol) pairs.push([i, j++]);
    }
    return pairs;
  }
  const w = m + 1;
  const cost = new Float64Array((n + 1) * w);
  const how = new Uint8Array((n + 1) * w); // 1: a[i] unmatched, 2: b[j] unmatched, 3: matched.
  for (let i = 1; i <= n; i++) {
    cost[i * w] = i * tol;
    how[i * w] = 1;
  }
  for (let j = 1; j <= m; j++) {
    cost[j] = j * tol;
    how[j] = 2;
  }
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      let best = cost[(i - 1) * w + j] + tol;
      let h = 1;
      const left = cost[i * w + j - 1] + tol;
      if (left < best) {
        best = left;
        h = 2;
      }
      const d = Math.abs(a[i - 1].at - b[j - 1].at);
      if (d <= tol) {
        const c = cost[(i - 1) * w + j - 1] + d + 0.01 * Math.min(tol, Math.abs(a[i - 1].end - b[j - 1].end));
        if (c <= best) {
          best = c;
          h = 3;
        }
      }
      cost[i * w + j] = best;
      how[i * w + j] = h;
    }
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const h = how[i * w + j];
    if (h === 3) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (h === 1) i--;
    else j--;
  }
  return pairs.reverse();
}

/** The position of an absolute tick of the score: the measure it falls in and the tick within it (the end of the last measure for a tick beyond the piece). */
function posOf(score: Score, measureStart: number[], total: number, abs: number): Pos {
  const tick = Math.max(0, Math.min(total, Math.round(abs)));
  let mi = measureStart.length - 1;
  while (mi > 0 && measureStart[mi] > tick) mi--;
  if (tick >= total) return { mi, tick: lengthOf(score, mi) };
  return { mi, tick: tick - measureStart[mi] };
}

/** Whether position `a` is the same as `b`. */
const samePos = (a: Pos, b: Pos) => a.mi === b.mi && a.tick === b.tick;

/** A curve of the project as points of the score; points at one position keep the last value, and values are clamped to the range. */
function curveOf(
  pts: { tick: number; value: number }[],
  at: (tick: number) => Pos,
  lo: number,
  hi: number,
): CurvePoint[] {
  const out: CurvePoint[] = [];
  for (const p of [...pts].sort((x, y) => x.tick - y.tick)) {
    const pos = at(p.tick);
    const point = { pos, value: Math.max(lo, Math.min(hi, p.value)) };
    if (out.length && samePos(out[out.length - 1].pos, pos)) out[out.length - 1] = point;
    else out.push(point);
  }
  return out;
}

/** Removes the expression of every head of the score (in place). */
function stripExpression(score: Score): void {
  for (const m of score.measures)
    for (const sm of Object.values(m.staves))
      for (const v of sm.voices)
        for (const te of flattenVoice(v))
          if (te.ev.kind === 'note')
            for (const np of te.ev.pitches) {
              delete np.vel;
              delete np.shift;
              delete np.gate;
            }
}

/** The key of a head in maps. */
const headKey = (h: HeadAt) => `${h.mi}/${h.staff}/${h.voice}/${h.idx}/${h.pi}`;

/** A readable place of a tick of the score, `m<N> beat <b>`. */
function placeOf(score: Score, measureStart: number[], total: number, abs: number): string {
  const p = posOf(score, measureStart, total, abs);
  return `m. ${p.mi + 1} beat ${Math.round((p.tick / PPQ + 1) * 100) / 100}`;
}

/** The note of the project that a head of the score was matched to. */
interface Match {
  /** The first sounding note of the head. */
  note: Note;
  /** The note of the project it was matched to. */
  theirs: PianizerProject['notes'][number];
  /** All notes of the project matched to the notes of the head (a tremolo has many). */
  all: PianizerProject['notes'];
  /** Set when the head is a unison twin that only copies the note of another head. */
  twin?: true;
}

/** Where the curves of the project end up in the score: the three curves with their point and region counts. */
function importCurves(
  out: Score,
  project: PianizerProject,
  at: (tick: number) => Pos,
): { tempo: CurvePoint[]; sustain: CurvePoint[]; soft: SoftRegion[] } {
  const perf: NonNullable<Score['performance']> = {};
  const tempo = curveOf(project.tempoPoints ?? [], at, 0.1, 10);
  if (tempo.length) perf.tempo = tempo;
  const sustain = curveOf(project.pedalPoints ?? [], at, 0, 1);
  // The project holds the first value of a curve before its first point; the score has the pedal up there.
  if (sustain.length && sustain[0].value > 0 && (sustain[0].pos.mi > 0 || sustain[0].pos.tick > 0))
    sustain.unshift({ pos: { mi: 0, tick: 0 }, value: sustain[0].value });
  if (sustain.length) perf.sustain = sustain;
  const soft: SoftRegion[] = [];
  for (const r of project.softPedalRegions ?? []) {
    const region = { from: at(r.startTick), to: at(r.endTick) };
    if (!samePos(region.from, region.to)) soft.push(region);
  }
  if (soft.length) perf.soft = soft;
  if (Object.keys(perf).length) out.performance = perf;
  else delete out.performance;
  return { tempo, sustain, soft };
}

/**
 * Matches the notes of the project to the sounding notes of the score that have a head, one pitch at a time, and counts
 * what was matched in `report`. Returns the match of each head by `headKey`.
 */
function matchHeads(
  out: Score,
  seq: ReturnType<typeof buildSequence>,
  heard: PianizerProject['notes'],
  scale: number,
  tol: number,
  report: RenditionReport,
): Map<string, Match> {
  const { measureStart, total } = measureStarts(out);
  const byPitch = new Map<number, { mine: Note[]; theirs: PianizerProject['notes'] }>();
  const entry = (pitch: number) => {
    const e = byPitch.get(pitch) ?? { mine: [], theirs: [] };
    byPitch.set(pitch, e);
    return e;
  };
  for (const n of seq.notes) if (n.head) entry(n.midi).mine.push(n);
  for (const n of heard) entry(n.pitch).theirs.push(n);
  const matches = new Map<string, Match>();
  const headsSeen = new Set<string>();
  for (const [pitch, e] of byPitch) {
    e.mine.sort((a, b) => a.start - b.start || a.end - b.end);
    e.theirs.sort((a, b) => a.startTick - b.startTick || a.endTick - b.endTick);
    // Of heads that start together (a unison written in several voices) the longest one is matched: the project keeps
    // one note for them, and it is the one that sounds longest. The others copy it below.
    const leaders = e.mine.flatMap((n, i) => {
      const longer = e.mine.some(
        (o) =>
          o !== n && Math.abs(o.start - n.start) < 1 && (o.end > n.end || (o.end === n.end && e.mine.indexOf(o) < i)),
      );
      return longer ? [] : [i];
    });
    const pairs = matchSorted(
      leaders.map((i) => ({ at: e.mine[i].start, end: e.mine[i].end })),
      e.theirs.map((n) => ({ at: n.startTick * scale, end: n.endTick * scale })),
      tol,
    );
    const matchedTheirs = new Set<number>();
    const pairedMine = new Set<number>();
    const partner = new Map<number, number>(); // The note of the project of a note of the score.
    let pairCount = 0;
    const pair = (i: number, j: number) => {
      pairCount++;
      matchedTheirs.add(j);
      pairedMine.add(i);
      partner.set(i, j);
      const note = e.mine[i];
      const key = headKey(must(note.head));
      const prior = matches.get(key);
      if (!prior) matches.set(key, { note, theirs: e.theirs[j], all: [e.theirs[j]] });
      else {
        prior.all.push(e.theirs[j]);
        if (note.start < prior.note.start) Object.assign(prior, { note, theirs: e.theirs[j] });
      }
    };
    for (const [li, j] of pairs) pair(leaders[li], j);
    // A project that kept every note of a unison has a note left for the other heads.
    e.mine.forEach((note, i) => {
      if (pairedMine.has(i)) return;
      let best = -1;
      e.theirs.forEach((n, j) => {
        if (matchedTheirs.has(j) || Math.abs(n.startTick * scale - note.start) > tol) return;
        const d = Math.abs(n.endTick * scale - note.end);
        if (best < 0 || d < Math.abs(e.theirs[best].endTick * scale - note.end)) best = j;
      });
      if (best >= 0) pair(i, best);
    });
    // A unison of two voices at one instant is one note in the project: the other head sounds like it.
    e.mine.forEach((note, i) => {
      if (pairedMine.has(i)) return;
      const twin = e.mine.findIndex((o, k) => partner.has(k) && Math.abs(o.start - note.start) < 1);
      const key = headKey(must(note.head));
      if (twin >= 0 && !matches.has(key)) {
        const theirs = e.theirs[must(partner.get(twin))];
        matches.set(key, { note, theirs, all: [theirs], twin: true });
        report.headsCopied++;
      }
    });
    report.matched += pairCount;
    e.theirs.forEach((n, j) => {
      if (matchedTheirs.has(j)) return;
      report.unmatchedCount++;
      if (report.unmatchedNotes.length < 20)
        report.unmatchedNotes.push(`${placeOf(out, measureStart, total, n.startTick * scale)} midi ${pitch}`);
    });
  }
  for (const n of seq.notes) if (n.head) headsSeen.add(headKey(n.head));
  report.heads = headsSeen.size;
  report.headsWithoutNote = headsSeen.size - matches.size;
  return matches;
}

/** Writes the differences between each matched pair of notes into the heads of `out` as `vel`, `shift` and `gate`. */
function applyDifferences(
  out: Score,
  seq: ReturnType<typeof buildSequence>,
  matches: Map<string, Match>,
  scale: number,
  report: RenditionReport,
): void {
  const events = new Map<string, Event[]>();
  const headOf = (h: HeadAt) => {
    const k = `${h.mi}/${h.staff}/${h.voice}`;
    const voice = out.measures[h.mi].staves[h.staff].voices.find((v) => v.id === h.voice);
    const evs = events.get(k) ?? flattenVoice(must(voice)).map((t) => t.ev);
    events.set(k, evs);
    const ev = evs[h.idx];
    return ev.kind === 'note' ? ev.pitches[h.pi] : undefined;
  };
  for (const { note, theirs, all, twin } of matches.values()) {
    const np = headOf(must(note.head));
    if (!np) continue;
    // A head has one velocity: the mean of the strokes of a tremolo.
    const mean = all.reduce((sum, n) => sum + n.velocity, 0) / all.length;
    const vel = Math.max(1, Math.min(127, Math.round(mean)));
    if (vel !== note.vel) {
      np.vel = vel;
      report.velocities++;
    }
    const shift = Math.round((seq.tickToSec(theirs.startTick * scale) - seq.tickToSec(note.start)) * 1000);
    if (shift !== 0) {
      np.shift = Math.max(-2000, Math.min(2000, shift));
      report.shifts++;
    }
    // The end of the note, when it is more than 20 ms from the one the notation gives (a tied head keeps its length).
    const end = theirs.endTick * scale;
    const length = note.end - note.start;
    if (!(twin || np.tie) && length > 0 && Math.abs(seq.tickToSec(end) - seq.tickToSec(note.end)) > 0.02) {
      const gate = Math.round(((end - note.start) / length) * 100) / 100;
      if (gate > 0 && gate <= 4) {
        np.gate = gate;
        report.gates++;
      }
    }
  }
}

/**
 * Takes the rendition of a Pianizer project over into (a copy of) `score`, replacing any expression and performance the
 * score had. Throws when the project is not one.
 */
export function importRendition(
  score: Score,
  project: PianizerProject,
  opts: RenditionOptions = {},
): { score: Score; report: RenditionReport } {
  if (!project || typeof project.version !== 'number' || !Array.isArray(project.notes))
    throw new Error('not a Pianizer project (version and notes expected)');
  const tpb = project.ticksPerBeat > 0 ? project.ticksPerBeat : 480;
  const scale = PPQ / tpb;
  const tol = (opts.tolerance ?? 0.5) * PPQ;
  const out = structuredClone(score);
  stripExpression(out);
  const { measureStart, total } = measureStarts(out);
  const at = (tick: number) => posOf(out, measureStart, total, tick * scale);

  // The curves come first: the times of the notes below are those of the score played with them.
  const { tempo, sustain, soft } = importCurves(out, project, at);
  const seq = buildSequence(out);
  const heard = project.notes.filter((n) => !n.muted);
  const report: RenditionReport = {
    notes: heard.length,
    matched: 0,
    unmatchedNotes: [],
    unmatchedCount: 0,
    headsWithoutNote: 0,
    heads: 0,
    headsCopied: 0,
    muted: project.notes.length - heard.length,
    velocities: 0,
    shifts: 0,
    gates: 0,
    tempoPoints: tempo.length,
    sustainPoints: sustain.length,
    softRegions: soft.length,
  };
  const matches = matchHeads(out, seq, heard, scale, tol, report);
  applyDifferences(out, seq, matches, scale, report);
  const problems = validate(out);
  if (problems.length) throw new Error(`the rendition does not fit the score: ${problems.slice(0, 3).join('; ')}`);
  return { score: out, report };
}
