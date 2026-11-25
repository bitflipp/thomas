// Edit commands: pure `Score -> Score` functions (Immer), each leaving every voice exactly as long as its measure.
// Failures throw EditError with a message fit for the user; the score is then unchanged.
//
// Every command goes through `edit`, which runs it on an Immer draft and then `tidy`s the measures it
// touched. Commands therefore only have to do the main change; consequences such as a slur that lost
// its end note or a beam group that lost a note are cleaned up in one place. Events are addressed by
// `EvAddr` (see addr.ts), never by object, because the draft replaces objects.

import type { Draft } from 'immer';

import { produce } from 'immer';
import type { BeamMode, BeamPlan } from '../beams.ts';
import { beamGroups, beamLinks, beatPhase, beatTicks, planBeams } from '../beams.ts';

import type {
  Articulation,
  Clef,
  Dur,
  Event,
  FermataShape,
  Grace,
  Item,
  LineEnd,
  MarkBody,
  NoteEvent,
  NotePitch,
  Ornament,
  Pitch,
  Score,
  StaffMeasure,
  Syllable,
  TimeSig,
  TupletGroup,
  Voice,
} from '../model.ts';

import {
  baseTicks,
  collectMarks,
  flattenVoice,
  isBeam,
  isEvent,
  isTremolo,
  keyAt,
  lengthOf,
  lineEnds,
  marksOf,
  measureTicks,
  pairLines,
  timeAt,
} from '../model.ts';

import { must } from '../util.ts';
import type { EvAddr, MarkAddr } from './addr.ts';
import { eventOf, markOf } from './addr.ts';
import { comparePitch, transposeSemis, transposeSteps } from './context.ts';
import { fitPerformance, moveAnchorsOnDelete, moveAnchorsOnInsert } from './performance.ts';
import { durOfTicks, EditError, eventAtTick, itemsTicks, putEvent, rest, restsFor, splitTicks } from './voice.ts';

export { EditError };

export interface Loc {
  mi: number;
  staff: string;
  voice: number;
}

// Shared plumbing of the commands below: `edit` runs a recipe on an Immer draft and re-establishes
// the model's invariants afterward, and the helpers locate voices, events and measures by address.

/** Runs `fn` on a draft of the score and tidies what it touched (`tidy` re-establishes the invariants). Returns the same score if nothing changed. */
function edit(score: Score, fn: (d: Draft<Score>) => void): Score {
  const next = fitPerformance(produce(score, fn));
  if (next === score) return next;
  // Only the measures the edit touched need tidying (a whole score is hundreds of measures); Immer
  // keeps untouched measures identical by reference, so a reference comparison finds them. Adding or
  // removing measures shifts everything, so that case tidies the whole score.
  const only = new Set<number>();
  const n = Math.max(next.measures.length, score.measures.length);
  for (let i = 0; i < n; i++) if (next.measures[i] !== score.measures[i]) only.add(i);
  const all = next.measures.length !== score.measures.length;
  // Looking for something to fix on the plain score is much cheaper than a draft over all of it: Immer
  // wraps every object that is read, and slurs and hairpins are checked across the whole piece.
  if (!needsTidy(next, all ? undefined : only)) return next;
  return produce(next, (d) => {
    tidy(d as Score, all ? undefined : only);
  });
}

/** One rest of the whole measure when it can be written so, else several. */
export function measureRest(len: number): Event[] {
  const d = durOfTicks(len);
  return d ? [{ kind: 'rest', style: 'measure', dur: d }] : restsFor(len, 0);
}

/**
 * The staff-measure of staff `staff` in measure `mi`, created empty if the measure lacks it. Throws for an unknown
 * staff or measure.
 */
function staffMeasure(d: Draft<Score>, mi: number, staff: string): Draft<StaffMeasure> {
  if (!d.staves.some((s) => s.id === staff)) throw new EditError(`Unknown staff ${staff}`);
  const m = d.measures[mi];
  if (!m) throw new EditError('No such measure');
  m.staves[staff] ??= { voices: [] };
  return m.staves[staff];
}

/**
 * The voice at `loc` in the draft. With `create` a missing voice is added, filled with a measure rest; otherwise
 * it is an error.
 */
function voiceIn(d: Draft<Score>, loc: Loc, create = false): Draft<Voice> {
  const sm = staffMeasure(d, loc.mi, loc.staff);
  let v = sm.voices.find((x) => x.id === loc.voice);
  if (!v) {
    if (!create) throw new EditError('No such voice');
    sm.voices.push({ id: loc.voice, items: measureRest(lengthOf(d as Score, loc.mi)) });
    sm.voices.sort((a, b) => a.id - b.id);
    v = must(sm.voices.find((x) => x.id === loc.voice));
  }
  return v;
}

/** The event at address `a` in the draft. Throws if there is no such event. */
function eventIn(d: Draft<Score>, a: EvAddr): Draft<Event> {
  const v = voiceIn(d, a);
  const te = flattenVoice(v as Voice)[a.idx];
  if (!te) throw new EditError('No such note');
  return te.ev as Draft<Event>;
}

/** Dissolve broken groups, drop dangling slurs: the invariants that edits tend to violate. Only writes where something is wrong. */
function tidy(d: Score, only?: Set<number>): void {
  const touched = dissolveBrokenGroups(d, only);
  dropDanglingSlurs(d, only ? touched.voices : undefined);
  dropLooseLines(d);
  for (const staff of touched.staves) dropUnpairedHairpins(d, staff);
}

/** Slur ids of a voice's events in time order (starts and stops of one event together), for events that have any. Voices are never changed in place, so this is kept per object. */
const slurTokens = new WeakMap<Voice, { stops: number[]; starts: number[] }[]>();

/** Per event of `v`, the slur ids that stop and start there; cached per voice object. */
function slurTokensOf(v: Voice): { stops: number[]; starts: number[] }[] {
  let t = slurTokens.get(v);
  if (!t) {
    t = [];
    for (const te of flattenVoice(v)) {
      const e = te.ev;
      if (e.slurStop || e.slurStart) t.push({ stops: e.slurStop ?? [], starts: (e.slurStart ?? []).map((s) => s.id) });
    }
    slurTokens.set(v, t);
  }
  return t;
}

/** Line ids of a voice's events in time order, for events that have any. Kept per voice object like `slurTokens`. */
const lineTokens = new WeakMap<Voice, { tick: number; starts: number[]; stops: number[] }[]>();

/** Per event of `v`, its tick and the line ids that start and stop there; cached per voice object. */
function lineTokensOf(v: Voice): { tick: number; starts: number[]; stops: number[] }[] {
  let t = lineTokens.get(v);
  if (!t) {
    t = [];
    for (const te of flattenVoice(v)) {
      const e = te.ev;
      if (e.lineStart || e.lineStop)
        t.push({
          tick: te.start,
          starts: (e.lineStart ?? []).map((x) => x.id),
          stops: (e.lineStop ?? []).map((x) => x.id),
        });
    }
    lineTokens.set(v, t);
  }
  return t;
}

/** Is a line start without its stop (or the reverse) left in the score? Reads only. */
function hasLooseLines(s: Score): boolean {
  const ends: LineEnd<null>[] = [];
  s.measures.forEach((m, mi) => {
    s.staves.forEach((st, si) => {
      for (const v of m.staves[st.id]?.voices ?? [])
        for (const t of lineTokensOf(v)) {
          const at = { mi, tick: t.tick, ord: si * 1000 + v.id, ref: null };
          for (const id of t.starts) ends.push({ ...at, role: 'start', id });
          for (const id of t.stops) ends.push({ ...at, role: 'stop', id });
        }
    });
  });
  return ends.length > 0 && pairLines(ends).loose.length > 0;
}

/** Lines whose other end went away with its note are removed. */
function dropLooseLines(d: Score): void {
  for (const l of pairLines(lineEnds(d)).loose) {
    const e = l.ref.ev;
    if (l.role === 'start') {
      const keep = (e.lineStart ?? []).filter((x) => x.id !== l.id);
      if (keep.length) e.lineStart = keep;
      else delete e.lineStart;
    } else {
      const keep = (e.lineStop ?? []).filter((x) => x.id !== l.id);
      if (keep.length) e.lineStop = keep;
      else delete e.lineStop;
    }
  }
}

/** Does `tidy` have anything to do? The same checks as `tidy`, reading only. */
function needsTidy(s: Score, only?: Set<number>): boolean {
  const staves = new Set<string>();
  const voices = new Set<string>();
  s.measures.forEach((m, mi) => {
    if (only && !only.has(mi)) return;
    for (const [sid, sm] of Object.entries(m.staves))
      for (const v of sm.voices) {
        staves.add(sid);
        voices.add(`${sid}|${v.id}`);
      }
  });
  for (const key of voices) {
    const [sid, vid] = [key.slice(0, key.lastIndexOf('|')), Number(key.slice(key.lastIndexOf('|') + 1))];
    const open = new Set<number>();
    for (const [mi, m] of s.measures.entries()) {
      const v = m.staves[sid]?.voices.find((x) => x.id === vid);
      if (!v) continue;
      if ((!only || only.has(mi)) && withoutBrokenGroups(v.items)) return true;
      for (const t of slurTokensOf(v)) {
        for (const id of t.stops) {
          if (!open.has(id)) return true; // This is a stop with no start.
          open.delete(id);
        }
        for (const id of t.starts) open.add(id);
      }
    }
    if (open.size) return true; // This is a start that is never stopped.
  }
  for (const sid of staves) if (hasUnpairedHairpins(s, sid)) return true;
  return hasLooseLines(s);
}

/** Is a hairpin start without its stop, or a stop without its start, left on the staff? (matching is by id across measures) */
function hasUnpairedHairpins(s: Score, staffId: string): boolean {
  const open = new Set<number>();
  for (const m of s.measures) {
    const sm = m.staves[staffId];
    if (!sm) continue;
    for (const mk of marksOf(sm)) {
      if (mk.type === 'hairpin') {
        if (open.has(mk.id)) return true;
        open.add(mk.id);
      } else if (mk.type === 'stop' && mk.of === 'hairpin') {
        if (!open.delete(mk.id)) return true;
      }
    }
  }
  return open.size > 0;
}

/**
 * The items of a voice with the groups dissolved that lost their meaning (a beam with fewer than two
 * notes, a tremolo that is not exactly a pair); undefined if nothing changed.
 */
function withoutBrokenGroups(items: Item[]): Item[] | undefined {
  let changed = false;
  const out: Item[] = [];
  for (const it of items) {
    if (isEvent(it)) {
      out.push(it);
      continue;
    }
    const sub = withoutBrokenGroups(it.items);
    const kids = sub ?? it.items;
    const rebuilt: Item = sub ? ({ ...it, items: sub } as Item) : it;
    if (sub) changed = true;
    const flat = flattenVoice({ id: 0, items: kids });
    const notes = flat.filter((t) => t.ev.kind === 'note').length;
    if ((isBeam(rebuilt) && notes < 2) || (isTremolo(rebuilt) && (notes !== 2 || flat.length !== 2))) {
      out.push(...kids);
      changed = true;
    } else out.push(rebuilt);
  }
  return changed ? out : undefined;
}

/** Dissolves broken groups in the voices of the measures in `only` (all if absent); returns which staves and voices (`staff|voice`) were looked at. */
function dissolveBrokenGroups(d: Score, only?: Set<number>): { staves: Set<string>; voices: Set<string> } {
  const staves = new Set<string>();
  const voices = new Set<string>();
  d.measures.forEach((m, mi) => {
    if (only && !only.has(mi)) return;
    for (const [sid, sm] of Object.entries(m.staves))
      for (const v of sm.voices) {
        staves.add(sid);
        voices.add(`${sid}|${v.id}`);
        const fixed = withoutBrokenGroups(v.items);
        if (fixed) v.items = fixed;
      }
  });
  return { staves, voices };
}

/** Slurs of one voice in time order: a stop with no open start, or a start never stopped, is dropped (a note it hung on may have been deleted or overwritten). */
function dropDanglingSlursOf(evs: Event[]): void {
  const open = new Set<number>();
  for (const e of evs) {
    if (e.slurStop) {
      const keep = e.slurStop.filter((id) => open.has(id));
      for (const id of keep) open.delete(id);
      if (keep.length !== e.slurStop.length) {
        if (keep.length) e.slurStop = keep;
        else delete e.slurStop;
      }
    }
    for (const s of e.slurStart ?? []) open.add(s.id);
  }
  for (const e of evs) {
    if (!e.slurStart?.some((s) => open.has(s.id))) continue;
    const keep = e.slurStart.filter((s) => !open.has(s.id));
    if (keep.length) e.slurStart = keep;
    else delete e.slurStart;
  }
}

/** Drops dangling slurs per staff and voice; with `only`, just the voices named (`staff|voice`). */
function dropDanglingSlurs(d: Score, only?: Set<string>): void {
  for (const st of d.staves) {
    const voiceIds = new Set<number>();
    for (const m of d.measures) for (const v of m.staves[st.id]?.voices ?? []) voiceIds.add(v.id);
    for (const vid of voiceIds) {
      if (only && !only.has(`${st.id}|${vid}`)) continue;
      const evs: Event[] = [];
      for (const m of d.measures) {
        const v = m.staves[st.id]?.voices.find((x) => x.id === vid);
        if (v) for (const te of flattenVoice(v)) evs.push(te.ev);
      }
      dropDanglingSlursOf(evs);
    }
  }
}

/** A hairpin start without its stop (or the reverse) went away with the note that carried it, so the surviving half is removed too (matching is by id across measures). */
function dropUnpairedHairpins(d: Score, staffId: string): void {
  const open = new Map<number, MarkAt>();
  const dead: MarkAt[] = [];
  d.measures.forEach((m, mi) => {
    const sm = m.staves[staffId];
    if (!sm) return;
    for (const mk of collectMarks(sm as StaffMeasure)) {
      const at: MarkAt = { mi, staff: staffId, voice: mk.voice, idx: mk.idx, k: mk.k };
      if (mk.type === 'hairpin') {
        const old = open.get(mk.id);
        if (old) dead.push(old);
        open.set(mk.id, at);
      } else if (mk.type === 'stop' && mk.of === 'hairpin') {
        if (open.has(mk.id)) open.delete(mk.id);
        else dead.push(at);
      }
    }
  });
  dead.push(...open.values());
  dropMarks(d, dead);
}

type MarkAt = MarkAddr;

/** The list a mark lives in: the marks of an event, or the end marks of a voice (`idx` -1). */
function markList(d: Draft<Score>, a: MarkAddr): Draft<MarkBody>[] | undefined {
  const v = d.measures[a.mi]?.staves[a.staff]?.voices.find((x) => x.id === a.voice);
  if (!v) return undefined;
  return a.idx < 0 ? v.end : flattenVoice(v as Voice)[a.idx]?.ev.marks;
}

/**
 * Replaces the mark list of the event addressed by `a` (`idx < 0` means the voice's end marks), deleting the field
 * when `list` is empty.
 */
function setMarkList(d: Draft<Score>, a: MarkAddr, list: Draft<MarkBody>[]): void {
  const v = must(d.measures[a.mi].staves[a.staff].voices.find((x) => x.id === a.voice));
  const target = a.idx < 0 ? v : (flattenVoice(v as Voice)[a.idx].ev as Draft<Event>);
  const key = a.idx < 0 ? 'end' : 'marks';
  if (list.length) (target as Record<string, unknown>)[key] = list;
  else delete (target as Record<string, unknown>)[key];
}

/** Remove marks by address (any order; addresses are resolved before anything is removed). */
function dropMarks(d: Draft<Score>, addrs: MarkAddr[]): void {
  const groups = new Map<string, MarkAddr[]>();
  for (const a of addrs) {
    const key = `${a.mi}|${a.staff}|${a.voice}|${a.idx}`;
    (groups.get(key) ?? must(groups.set(key, []).get(key))).push(a);
  }
  for (const g of groups.values()) {
    const list = markList(d, g[0]);
    if (!list) continue;
    const gone = new Set(g.map((a) => a.k));
    setMarkList(
      d,
      g[0],
      list.filter((_, k) => !gone.has(k)),
    );
  }
}

// Commands that create, change and remove notes, chords and rests: input at a position, duration,
// pitch and transposition, moving notes to another staff, ties and articulations. Each leaves every
// voice as long as its measure.

/** Adds a pitch to a chord, keeping the pitches ordered low to high as the model requires. */
function insertPitch(n: Draft<NoteEvent>, p: NotePitch): void {
  n.pitches.push(p);
  n.pitches.sort((a, b) => comparePitch(a.pitch, b.pitch));
}

/** The rest that replaces `e`: same duration, and its marks (dynamics etc.) stay in place. */
function toRest(e: Draft<Event>): Event {
  return {
    kind: 'rest',
    style: 'normal',
    dur: { ...e.dur },
    ...(e.marks ? { marks: JSON.parse(JSON.stringify(e.marks)) } : {}),
  };
}

/**
 * Enter a note at `tick`. With `chord`, a note already starting there gets the pitch added (or loses it, when present);
 * otherwise whatever is at that span is replaced. `descend: false` replaces a tuplet as a whole instead of entering it.
 */
export function enterNote(
  score: Score,
  loc: Loc,
  tick: number,
  dur: Dur,
  pitch: Pitch,
  o: { chord?: boolean; descend?: boolean; acc?: 'force' | 'cautionary' } = {},
): Score {
  return edit(score, (d) => {
    const v = voiceIn(d, loc, true);
    const at = eventAtTick(v.items as Item[], tick);
    const np: NotePitch = { pitch: { ...pitch } };
    if (o.acc) np.acc = o.acc;
    if (o.chord && at && at.start === tick && at.ev.kind === 'note') {
      const n = at.ev as Draft<NoteEvent>;
      const i = n.pitches.findIndex((x) => comparePitch(x.pitch, pitch) === 0);
      if (i >= 0) {
        if (n.pitches.length > 1) n.pitches.splice(i, 1);
        else replaceItem(v.items as Draft<Item>[], at.ev, toRest(n));
      } else insertPitch(n, np);
      return;
    }
    if (tick + baseTicks(dur) > lengthOf(d as Score, loc.mi) && !at?.inTuplet)
      throw new EditError('The note does not fit into the measure');
    v.items = putEvent(
      v.items as Item[],
      tick,
      { kind: 'note', dur: { ...dur }, pitches: [np] },
      o.descend ?? true,
    ) as Draft<Item>[];
  });
}

/**
 * Writes a rest of duration `dur` at `tick`, overwriting what is there. `descend` allows entering a tuplet at that
 * tick.
 */
export function enterRest(score: Score, loc: Loc, tick: number, dur: Dur, descend = true): Score {
  return edit(score, (d) => {
    const v = voiceIn(d, loc, true);
    if (tick + baseTicks(dur) > lengthOf(d as Score, loc.mi) && !eventAtTick(v.items as Item[], tick)?.inTuplet)
      throw new EditError('The rest does not fit into the measure');
    v.items = putEvent(v.items as Item[], tick, rest(dur), descend) as Draft<Item>[];
  });
}

/**
 * Notes become rests of the same value (a chord pitch `pi` is removed instead). When every event of a voice in a
 * measure is selected, even if they are all rests, that part of the measure is cleared to one whole-measure rest.
 */
export function deleteEvents(score: Score, addrs: (EvAddr & { pi?: number })[]): Score {
  return edit(score, (d) => {
    const whole = new Map<string, Set<number>>();
    for (const a of addrs) {
      if (a.pi !== undefined) continue;
      const key = `${a.mi}/${a.staff}/${a.voice}`;
      const set = whole.get(key) ?? new Set<number>();
      whole.set(key, set);
      set.add(a.idx);
    }
    const cleared = new Set<string>();
    for (const [key, idxs] of whole) {
      const a = must(addrs.find((x) => x.pi === undefined && `${x.mi}/${x.staff}/${x.voice}` === key));
      const v = voiceIn(d, a);
      const n = flattenVoice(v as Voice).length;
      if (idxs.size < n) continue;
      v.items = measureRest(lengthOf(d as Score, a.mi)) as Draft<Item>[];
      cleared.add(key);
    }
    for (const a of addrs) {
      if (cleared.has(`${a.mi}/${a.staff}/${a.voice}`)) continue;
      const e = eventIn(d, a);
      if (e.kind !== 'note') continue;
      if (a.pi !== undefined && e.pitches.length > 1) {
        e.pitches.splice(a.pi, 1);
        continue;
      }
      replaceItem(voiceIn(d, a).items as Draft<Item>[], e as Event, toRest(e));
    }
  });
}

/** Give the event a new written duration; what follows shifts into (or out of) the gap, rests fill what is left. */
export function setDuration(score: Score, a: EvAddr, dur: Dur): Score {
  return edit(score, (d) => {
    const v = voiceIn(d, a);
    const te = flattenVoice(v as Voice)[a.idx];
    if (!te) throw new EditError('No such note');
    if (te.tuplets.length || te.tremolo) {
      if (te.tuplets.length && !te.tremolo) {
        const e = te.ev as Draft<Event>;
        v.items = putEvent(v.items as Item[], te.start, {
          ...(JSON.parse(JSON.stringify(e)) as Event),
          dur: { ...dur },
        }) as Draft<Item>[];
        return;
      }
      throw new EditError('Cannot change the duration inside a tremolo');
    }
    if (te.start + baseTicks(dur) > lengthOf(d as Score, a.mi))
      throw new EditError('The note does not fit into the measure');
    const copy = JSON.parse(JSON.stringify(te.ev)) as Event;
    copy.dur = { ...dur };
    // A whole-measure rest given a shorter value becomes an ordinary rest; `putEvent` fills the rest of
    // the bar with more rests.
    if (copy.kind === 'rest' && copy.style === 'measure' && baseTicks(dur) !== lengthOf(d as Score, a.mi))
      copy.style = 'normal';
    v.items = putEvent(v.items as Item[], te.start, copy) as Draft<Item>[];
  });
}

/** Applies `fn` to the events at `addrs`: the generic way to change a field on a selection. */
export function updateEvents(score: Score, addrs: EvAddr[], fn: (e: Draft<Event>) => void): Score {
  return edit(score, (d) => {
    for (const a of addrs) fn(eventIn(d, a));
  });
}

/** Applies `fn` to the note events at `addrs`; rests are skipped. */
export function updateNotes(score: Score, addrs: EvAddr[], fn: (e: Draft<NoteEvent>) => void): Score {
  return updateEvents(score, addrs, (e) => {
    if (e.kind === 'note') fn(e);
  });
}

/**
 * Exchanges the contents of voices `a` and `b` of one staff in the measures `mis` (events, tuplets and end marks;
 * the voice ids and their order stay). A voice missing from a measure counts as a measure of rests.
 */
export function flipVoices(score: Score, staff: string, a: number, b: number, mis: number[]): Score {
  if (a === b) throw new EditError('Flipping needs two different voices');
  return edit(score, (d) => {
    for (const mi of mis) {
      const va = voiceIn(d, { mi, staff, voice: a }, true);
      const vb = voiceIn(d, { mi, staff, voice: b }, true);
      const items = va.items;
      const end = va.end;
      va.items = vb.items;
      vb.items = items;
      if (vb.end) va.end = vb.end;
      else delete va.end;
      if (end) vb.end = end;
      else delete vb.end;
    }
  });
}

/** Sets pitch number `pi` of the chord at `a` and keeps the chord sorted by pitch. */
export function setPitch(score: Score, a: EvAddr, pi: number, pitch: Pitch): Score {
  return updateNotes(score, [a], (n) => {
    const old = n.pitches[pi];
    if (!old) return;
    old.pitch = { ...pitch };
    n.pitches.sort((x, y) => comparePitch(x.pitch, y.pitch));
  });
}

/** Move pitches: chromatically (`semis`) or by letter names (`steps`). Without `pi` all pitches of the event move. */
export function transpose(
  score: Score,
  targets: (EvAddr & { pi?: number })[],
  by: { semis?: number; steps?: number },
): Score {
  return edit(score, (d) => {
    for (const t of targets) {
      const e = eventIn(d, t);
      if (e.kind !== 'note') continue;
      e.pitches.forEach((np, i) => {
        if (t.pi !== undefined && t.pi !== i) return;
        np.pitch =
          by.semis !== undefined ? transposeSemis(np.pitch, by.semis) : transposeSteps(np.pitch, by.steps ?? 0);
      });
      e.pitches.sort((x, y) => comparePitch(x.pitch, y.pitch));
    }
  });
}

/** Cross-staff: draw the event on another staff (undefined: back to its own). Pitches are kept. */
export function setStaffOf(score: Score, addrs: EvAddr[], staff: string | undefined): Score {
  return updateNotes(score, addrs, (n) => {
    if (staff === undefined || staff === addrs[0]?.staff) delete n.staff;
    else n.staff = staff;
  });
}

/**
 * Ties the addressed notes to their successors, or removes the ties if all of them are tied already. With `pi`
 * only that pitch of a chord is meant.
 */
export function toggleTie(score: Score, addrs: (EvAddr & { pi?: number })[]): Score {
  return edit(score, (d) => {
    for (const a of addrs) {
      const e = eventIn(d, a);
      if (e.kind !== 'note') continue;
      const sel = e.pitches.filter((_, i) => a.pi === undefined || i === a.pi);
      const on = !sel.every((p) => p.tie);
      for (const p of sel) {
        if (on) p.tie = true;
        else delete p.tie;
      }
    }
  });
}

/**
 * Flips the side the ties of the addressed notes arch to (`pi` picks one pitch of a chord). The side the engraver
 * chose is not known here, so `current` says it for each tie; a tie flips to the other side and stays forced.
 */
export function flipTie(
  score: Score,
  addrs: (EvAddr & { pi?: number })[],
  current: (a: EvAddr, pi: number) => 'above' | 'below',
): Score {
  return edit(score, (d) => {
    for (const a of addrs) {
      const e = eventIn(d, a);
      if (e.kind !== 'note') continue;
      e.pitches.forEach((p, pi) => {
        if (!p.tie || (a.pi !== undefined && a.pi !== pi)) return;
        p.tieSide = (p.tieSide ?? current(a, pi)) === 'above' ? 'below' : 'above';
      });
    }
  });
}

/** Forces the ties of the addressed notes above or below; `undefined` returns them to the automatic side. */
export function setTieSide(
  score: Score,
  addrs: (EvAddr & { pi?: number })[],
  side: 'above' | 'below' | undefined,
): Score {
  return edit(score, (d) => {
    for (const a of addrs) {
      const e = eventIn(d, a);
      if (e.kind !== 'note') continue;
      e.pitches.forEach((p, pi) => {
        if (!p.tie || (a.pi !== undefined && a.pi !== pi)) return;
        if (side) p.tieSide = side;
        else delete p.tieSide;
      });
    }
  });
}

/** Adds articulation `art` to the addressed notes, or removes it if all of them have it already. */
export function toggleArticulation(score: Score, addrs: EvAddr[], art: Articulation): Score {
  return updateNotes(score, addrs, (n) => {
    const cur = n.art ?? [];
    const on = !addrs.every((a) => {
      const e = eventOf(score, a);
      return e?.kind === 'note' && e.art?.includes(art);
    });
    const next = on ? [...cur.filter((x) => x !== art), art] : cur.filter((x) => x !== art);
    if (next.length) n.art = next;
    else {
      delete n.art;
      delete n.artSide;
    }
  });
}

/** Toggles a fermata on the events at `addrs` (notes and rests): off if all have one, else on for all. */
export function toggleFermata(score: Score, addrs: EvAddr[]): Score {
  const on = !addrs.every((a) => eventOf(score, a)?.fermata);
  return updateEvents(score, addrs, (e) => {
    if (on) e.fermata = true;
    else {
      delete e.fermata;
      delete e.fermataShape;
      delete e.fermataBelow;
    }
  });
}

/** Toggles a trill on the notes at `addrs`; rests cannot trill. */
export function toggleTrill(score: Score, addrs: EvAddr[]): Score {
  const notes = addrs.filter((a) => eventOf(score, a)?.kind === 'note');
  if (!notes.length) throw new EditError('Only notes can have a trill');
  const on = !notes.every((a) => (eventOf(score, a) as NoteEvent).trill);
  return updateNotes(score, notes, (n) => {
    if (on) n.trill = true;
    else {
      delete n.trill;
      delete n.trillAcc;
    }
  });
}

/** Sets the shape and side of the fermatas at `addrs` (undefined shape: the normal one); events without a fermata are left alone. */
export function setFermataStyle(score: Score, addrs: EvAddr[], shape: FermataShape | undefined, below: boolean): Score {
  return updateEvents(score, addrs, (e) => {
    if (!e.fermata) return;
    if (shape) e.fermataShape = shape;
    else delete e.fermataShape;
    if (below) e.fermataBelow = true;
    else delete e.fermataBelow;
  });
}

/** Sets the mordent or turn of the notes at `addrs` (undefined: none); rests are left alone. */
export function setOrnament(score: Score, addrs: EvAddr[], ornament: Ornament | undefined): Score {
  const notes = addrs.filter((a) => eventOf(score, a)?.kind === 'note');
  if (!notes.length) throw new EditError('Only notes can have a mordent or turn');
  return updateNotes(score, notes, (n) => {
    if (ornament) n.ornament = ornament;
    else delete n.ornament;
  });
}

/** Sets the accidental shown above the trill mark of the trilled notes at `addrs` (undefined: none). */
export function setTrillAcc(score: Score, addrs: EvAddr[], acc: -1 | 0 | 1 | undefined): Score {
  return updateNotes(score, addrs, (n) => {
    if (!n.trill) return;
    if (acc === undefined) delete n.trillAcc;
    else n.trillAcc = acc;
  });
}

// Grace notes belong to the note that follows them and take no time, so these commands never
// change a voice's length. A grace is addressed by its note and its index in `graces`.

// Lyrics: a syllable is entered per note and verse. `syllabic` is never given by the caller: it follows
// from the hyphens (`joinNext` for the new syllable, the previous syllable's join for the start), and
// `normalizeVerse` repairs the chain of the verse after every change.

/**
 * Sets the syllable of `verse` on the note at `a`, or removes it (`input` undefined or an empty text).
 * Hyphens at the ends of `text` are taken as `joinNext`/join to the previous one.
 */
export function setSyllable(
  score: Score,
  a: EvAddr,
  verse: number,
  input: { text: string; joinNext?: boolean; extend?: boolean } | undefined,
): Score {
  const e = eventOf(score, a);
  if (e?.kind !== 'note') throw new EditError('Lyrics belong under a note');
  return edit(score, (d) => {
    const n = eventIn(d, a);
    if (n.kind !== 'note') return;
    const text = input?.text.replace(/^-+|-+$/g, '').trim();
    const rest = (n.lyrics ?? []).filter((y) => y.verse !== verse);
    if (input && text) {
      const joinNext = !!input.joinNext || (input.text.length > 1 && input.text.endsWith('-'));
      const y: Syllable = { verse, text, syllabic: joinNext ? 'begin' : 'single' };
      if (input.extend) y.extend = true;
      rest.push(y);
      rest.sort((p, q) => p.verse - q.verse);
    }
    if (rest.length) n.lyrics = rest;
    else delete n.lyrics;
    normalizeVerse(d as Score, a.staff, a.voice, verse);
  });
}

/** Recomputes `syllabic` along one verse of a voice: a syllable is joined to the previous one exactly when that one is joined to the next. */
function normalizeVerse(d: Score, staff: string, voiceId: number, verse: number): void {
  const list: Syllable[] = [];
  for (const m of d.measures) {
    const v = m.staves[staff]?.voices.find((x) => x.id === voiceId);
    if (!v) continue;
    for (const t of flattenVoice(v)) {
      if (t.ev.kind !== 'note') continue;
      const y = t.ev.lyrics?.find((q) => q.verse === verse);
      if (y) list.push(y);
    }
  }
  let prevJoins = false;
  for (const y of list) {
    const joinsNext = y.syllabic === 'begin' || y.syllabic === 'middle';
    y.syllabic = prevJoins ? (joinsNext ? 'middle' : 'end') : joinsNext ? 'begin' : 'single';
    prevJoins = joinsNext;
  }
}

/** Adds a grace note before the note at `a`, after its existing graces (or at `index`). It starts as a single pitch, given or a step above the note's lowest. */
export function addGrace(score: Score, a: EvAddr, grace: Grace, index?: number): Score {
  const e = eventOf(score, a);
  if (e?.kind !== 'note') throw new EditError('Grace notes belong in front of a note');
  return updateNotes(score, [a], (n) => {
    n.graces ??= [];
    n.graces.splice(index ?? n.graces.length, 0, structuredClone(grace));
  });
}

/** Removes grace note number `index` of the note at `a`. */
export function removeGrace(score: Score, a: EvAddr, index: number): Score {
  return updateNotes(score, [a], (n) => {
    n.graces?.splice(index, 1);
    if (!n.graces?.length) delete n.graces;
  });
}

/** Changes the written value, the slash or the pitches of one grace note. */
export function updateGrace(score: Score, a: EvAddr, index: number, patch: Partial<Grace>): Score {
  return updateNotes(score, [a], (n) => {
    const g = n.graces?.[index];
    if (!g) return;
    Object.assign(g, structuredClone(patch));
    if (!g.slash) delete g.slash;
    g.pitches.sort((x, y) => comparePitch(x.pitch, y.pitch));
  });
}

/** Adds a tone a third above the top of grace note `index` of the note at `a` (a chord grace note). */
export function addGraceTone(score: Score, a: EvAddr, index: number): Score {
  return updateNotes(score, [a], (n) => {
    const g = n.graces?.[index];
    if (!g) return;
    g.pitches.push({ pitch: transposeSteps(g.pitches[g.pitches.length - 1].pitch, 2) });
    g.pitches.sort((x, y) => comparePitch(x.pitch, y.pitch));
  });
}

/** Removes the top tone of grace note `index` of the note at `a`; a single tone cannot be removed (remove the grace note instead). */
export function removeGraceTone(score: Score, a: EvAddr, index: number): Score {
  const g = (eventOf(score, a) as NoteEvent | undefined)?.graces?.[index];
  if (g && g.pitches.length < 2) throw new EditError('A grace note needs at least one pitch');
  return updateNotes(score, [a], (n) => {
    n.graces?.[index]?.pitches.pop();
  });
}

/** Moves every pitch of a grace note by letter-name steps. */
export function transposeGrace(score: Score, a: EvAddr, index: number, steps: number): Score {
  return updateNotes(score, [a], (n) => {
    const g = n.graces?.[index];
    if (g) for (const p of g.pitches) p.pitch = transposeSteps(p.pitch, steps);
  });
}

// Slurs join two notes of one voice, possibly across measures. A slur is a start/stop pair of marks
// sharing an id; the commands pick ids so that overlapping slurs stay distinguishable.

/** Slur between two notes of the same voice (they may be in different measures). */
export function addSlur(score: Score, from: EvAddr, to: EvAddr, side?: 'above' | 'below'): Score {
  if (from.staff !== to.staff || from.voice !== to.voice) throw new EditError('A slur joins notes of one voice');
  return edit(score, (d) => {
    // The slur's id is the lowest number not used by a slur overlapping the new one in this voice,
    // so crossing slurs stay distinguishable in the text format and the engraver.
    const evs: { e: Draft<Event>; k: number }[] = [];
    let k = 0;
    let ka = -1;
    let kb = -1;
    d.measures.forEach((m, mi) => {
      const v = m.staves[from.staff]?.voices.find((x) => x.id === from.voice);
      if (v)
        for (const te of flattenVoice(v as Voice)) {
          if (mi === from.mi && te.index === from.idx) ka = k;
          if (mi === to.mi && te.index === to.idx) kb = k;
          evs.push({ e: te.ev as Draft<Event>, k: k++ });
        }
    });
    if (ka < 0 || kb < 0) throw new EditError('No such note');
    if (ka > kb) [ka, kb] = [kb, ka];
    if (ka === kb) throw new EditError('A slur needs two different notes');
    const first = evs[ka].e;
    const last = evs[kb].e;
    if (first.kind !== 'note' || last.kind !== 'note') throw new EditError('A slur starts and ends on notes');
    const spans: [number, number, number][] = [];
    const open = new Map<number, number>();
    for (const { e, k: kk } of evs) {
      for (const id of e.slurStop ?? []) {
        if (open.has(id)) {
          spans.push([must(open.get(id)), kk, id]);
          open.delete(id);
        }
      }
      for (const s of e.slurStart ?? []) open.set(s.id, kk);
    }
    let id = 1;
    while (spans.some(([s0, s1, i]) => i === id && s0 <= kb && s1 >= ka)) id++;
    first.slurStart ??= [];
    first.slurStart.push(side ? { id, side } : { id });
    last.slurStop ??= [];
    last.slurStop.push(id);
  });
}

// Lines (straight connections between two notes, possibly in different voices or staves) are matched
// score-wide by id, unlike slurs, which are matched per voice.

/** A line between two notes, which may be in different voices or staves (it is drawn only when they are in one system, which the engraver decides). */
export function addLine(
  score: Score,
  from: EvAddr & { pi?: number },
  to: EvAddr & { pi?: number },
  dashed = false,
): Score {
  if (from.mi === to.mi && from.staff === to.staff && from.voice === to.voice && from.idx === to.idx)
    throw new EditError('A line needs two different notes');
  return edit(score, (d) => {
    const a = eventIn(d, from);
    const b = eventIn(d, to);
    if (a.kind !== 'note' || b.kind !== 'note') throw new EditError('A line joins notes');
    // The lowest number not used by a line that overlaps the new one in time, so that lines stay distinguishable in the text format.
    const at = (x: EvAddr) => x.mi * 1e7 + flattenVoice(voiceIn(d, x) as Voice)[x.idx].start;
    const [t0, t1] = [at(from), at(to)].sort((p, q) => p - q);
    const spans = pairLines(lineEnds(d as Score)).pairs.map(({ start, stop }) => ({
      id: start.id,
      t0: Math.min(start.mi * 1e7 + start.tick, stop.mi * 1e7 + stop.tick),
      t1: Math.max(start.mi * 1e7 + start.tick, stop.mi * 1e7 + stop.tick),
    }));
    let id = 1;
    while (spans.some((s) => s.id === id && s.t0 <= t1 && s.t1 >= t0)) id++;
    a.lineStart ??= [];
    // A head is recorded only for a chord, and only when the end was given one.
    const headOf = (e: typeof a, pi: number | undefined) =>
      e.kind === 'note' && e.pitches.length > 1 && pi !== undefined && pi < e.pitches.length ? { head: pi } : {};
    a.lineStart.push({ id, ...(dashed ? { dashed } : {}), ...headOf(a, from.pi) });
    b.lineStop ??= [];
    b.lineStop.push({ id, ...headOf(b, to.pi) });
  });
}

/** Removes the line with id `id` that starts at `from`; `tidy` drops the orphaned end. */
export function removeLine(score: Score, from: EvAddr, id: number): Score {
  return edit(score, (d) => {
    const e = eventIn(d, from);
    if (e.lineStart) {
      const k = e.lineStart.filter((s) => s.id !== id);
      if (k.length) e.lineStart = k;
      else delete e.lineStart;
    }
  }); // Tidy removes the matching stop.
}

/** Sets or clears the dashed style of the line with id `id` that starts at `from`. */
export function setLineDashed(score: Score, from: EvAddr, id: number, dashed: boolean): Score {
  return updateEvents(score, [from], (e) => {
    const s = e.lineStart?.find((x) => x.id === id);
    if (s) {
      if (dashed) s.dashed = true;
      else delete s.dashed;
    }
  });
}

/** Removes the slur with id `id` that starts at `from`; `tidy` drops the orphaned end. */
export function removeSlur(score: Score, from: EvAddr, id: number): Score {
  return edit(score, (d) => {
    const e = eventIn(d, from);
    if (e.slurStart) {
      const k = e.slurStart.filter((s) => s.id !== id);
      if (k.length) e.slurStart = k;
      else delete e.slurStart;
    }
  }); // Tidy removes the matching stop.
}

/**
 * Forces the slur with id `id` that starts at `from` above or below the notes; `undefined` returns it to the
 * automatic side.
 */
export function setSlurSide(score: Score, from: EvAddr, id: number, side: 'above' | 'below' | undefined): Score {
  return updateEvents(score, [from], (e) => {
    const s = e.slurStart?.find((x) => x.id === id);
    if (s) {
      if (side) s.side = side;
      else delete s.side;
    }
  });
}

/** Lets the slur with id `id` that starts at `from` be skewed by the engraver; `false` returns it to the symmetric default. */
export function setSlurSkewed(score: Score, from: EvAddr, id: number, skewed: boolean): Score {
  return updateEvents(score, [from], (e) => {
    const s = e.slurStart?.find((x) => x.id === id);
    if (s) {
      if (skewed) s.skewed = true;
      else delete s.skewed;
    }
  });
}

// Marks (dynamics, hairpins, pedal, ottava, clef changes, tempo, text) hang on events; the commands
// below attach, move, update and remove them, including spans drawn over a range of notes.

/** Hang a mark on the event `at` (the one under the cursor); a dynamic, tempo or clef replaces its kind already there. */
export function addMark(score: Score, at: EvAddr, body: MarkBody): Score {
  return edit(score, (d) => {
    hang(d, at, body);
  });
}

/**
 * Attaches mark `body` to the event at `at` (or to the voice end for stops), replacing a mark of the same kind
 * where only one can exist.
 */
function hang(d: Draft<Score>, at: EvAddr, body: MarkBody): void {
  const sm = staffMeasure(d, at.mi, at.staff);
  const v = sm.voices.find((x) => x.id === at.voice);
  const te = v && flattenVoice(v as Voice)[at.idx];
  if (!(v && te)) throw new EditError('Nothing to attach the mark to');
  if (body.type === 'dynamic' || body.type === 'tempo' || body.type === 'clef') {
    dropMarks(
      d,
      collectMarks(sm as StaffMeasure)
        .filter((m) => m.type === body.type && m.tick === te.start)
        .map((m) => ({ mi: at.mi, staff: at.staff, voice: m.voice, idx: m.idx, k: m.k })),
    );
  }
  te.ev.marks ??= [];
  te.ev.marks.push(body as Draft<MarkBody>);
}

/** Move a mark onto another event of its staff. */
export function moveMark(score: Score, a: MarkAddr, at: EvAddr): Score {
  return edit(score, (d) => {
    const m = markList(d, a)?.[a.k];
    if (!m) return;
    const body = JSON.parse(JSON.stringify(m)) as MarkBody;
    dropMarks(d, [a]);
    hang(d, at, body);
  });
}

/** Patches the mark at `a`, either with a partial body or by mutating the draft body. */
export function updateMark(
  score: Score,
  a: MarkAddr,
  patch: Partial<MarkBody> | ((m: Draft<MarkBody>) => void),
): Score {
  return updateMarks(score, [a], patch);
}

/** Apply one change to several marks at once (a single edit, so a single undo step). */
export function updateMarks(
  score: Score,
  addrs: MarkAddr[],
  patch: Partial<MarkBody> | ((m: Draft<MarkBody>) => void),
): Score {
  return edit(score, (d) => {
    for (const a of addrs) {
      const m = markList(d, a)?.[a.k];
      if (!m) throw new EditError('No such mark');
      if (typeof patch === 'function') patch(m);
      else Object.assign(m, patch);
      for (const k of Object.keys(m))
        if ((m as Record<string, unknown>)[k] === undefined) delete (m as Record<string, unknown>)[k];
    }
  });
}

/** Remove a mark; the start of a hairpin takes its end with it. */
export function removeMark(score: Score, a: MarkAddr): Score {
  return removeMarks(score, [a]);
}

/** Removes the marks at `addrs`, together with the partner of each hairpin so that no half hairpin stays behind. */
export function removeMarks(score: Score, addrs: MarkAddr[]): Score {
  return edit(score, (d) => {
    const gone: MarkAddr[] = [...addrs];
    for (const a of addrs) {
      const m = markList(d, a)?.[a.k];
      if (m?.type !== 'hairpin') continue;
      const start = collectMarks(d.measures[a.mi].staves[a.staff] as StaffMeasure).find(
        (x) => x.voice === a.voice && x.idx === a.idx && x.k === a.k,
      );
      scan: for (let mi = a.mi; mi < d.measures.length; mi++) {
        const sm = d.measures[mi].staves[a.staff];
        if (!sm) continue;
        for (const x of collectMarks(sm as StaffMeasure)) {
          if (x.type === 'stop' && x.of === 'hairpin' && x.id === m.id && (mi > a.mi || x.tick > (start?.tick ?? 0))) {
            gone.push({ mi, staff: a.staff, voice: x.voice, idx: x.idx, k: x.k });
            break scan;
          }
        }
      }
    }
    dropMarks(d, gone);
  });
}

export type SpanKind = 'cresc' | 'dim' | 'pedal' | 'trill' | '8va' | '8vb';

/** The start and stop marks of a line; a hairpin gets the lowest id not used on the staff. */
function spanBodies(
  d: Draft<Score>,
  staff: string,
  kind: SpanKind,
  placement?: 'above' | 'below',
): { start: MarkBody; stop: MarkBody } {
  if (kind === 'cresc' || kind === 'dim') {
    const used = new Set<number>();
    for (const m of d.measures) {
      const sm = m.staves[staff];
      if (sm) for (const mk of collectMarks(sm as StaffMeasure)) if (mk.type === 'hairpin') used.add(mk.id);
    }
    let id = 1;
    while (used.has(id)) id++;
    return {
      start: { type: 'hairpin', kind, id, ...(placement ? { placement } : {}) },
      stop: { type: 'stop', of: 'hairpin', id },
    };
  }
  if (kind === 'pedal') return { start: { type: 'pedal' }, stop: { type: 'stop', of: 'pedal' } };
  if (kind === 'trill') return { start: { type: 'trill' }, stop: { type: 'stop', of: 'trill' } };
  return { start: { type: 'ottava', dir: kind === '8va' ? 'up' : 'down' }, stop: { type: 'stop', of: 'ottava' } };
}

/**
 * The same line from the start of event `from` to the end of event `to` (either may come first; one staff).
 * The stop hangs on the event after `to` in its voice, or on the end of the measure when `to` is the voice's last.
 */
export function addSpanOver(
  score: Score,
  kind: SpanKind,
  from: EvAddr,
  to: EvAddr,
  placement?: 'above' | 'below',
): Score {
  if (from.staff !== to.staff) throw new EditError('A line stays on one staff');
  return edit(score, (d) => {
    const te = (a: EvAddr) => {
      const t = flattenVoice(voiceIn(d, a) as Voice)[a.idx];
      if (!t) throw new EditError('No such note');
      return t;
    };
    const key = (a: EvAddr) => a.mi * 1e9 + te(a).start;
    const [first, last] = key(from) <= key(to) ? [from, to] : [to, from];
    const { start, stop } = spanBodies(d, from.staff, kind, placement);
    const firstEv = te(first).ev;
    firstEv.marks ??= [];
    firstEv.marks.push(start as Draft<MarkBody>);
    const v = voiceIn(d, last);
    const flat = flattenVoice(v as Voice);
    const next = flat[last.idx + 1];
    if (!next) {
      v.end ??= [];
      v.end.push(stop as Draft<MarkBody>);
      return;
    }
    // The stop goes before the marks that start something at the same position: a pedal change is a
    // release followed by a press, in that order.
    next.ev.marks ??= [];
    const marks = next.ev.marks as Draft<MarkBody>[];
    const i = marks.findIndex((m) => m.type !== 'stop');
    marks.splice(i < 0 ? marks.length : i, 0, stop as Draft<MarkBody>);
  });
}

// Tuplets: turning an event into a tuplet that fills its span, and changing or dissolving one again.
// Positions inside a tuplet are counted in written ticks of that tuplet's level.

/** Turn the event at `a` into a tuplet filling its span: the event keeps the first slot, the others are rests. */
export function makeTuplet(score: Score, a: EvAddr, actual: number, normal: number): Score {
  return edit(score, (d) => {
    const v = voiceIn(d, a);
    const te = flattenVoice(v as Voice)[a.idx];
    if (!te) throw new EditError('No such note');
    if (te.tremolo) throw new EditError('Not inside a tremolo');
    // The span of the new tuplet is the event's duration at its own level, i.e. as written:
    // inside another tuplet that is not the sounding length.
    const span = baseTicks(te.ev.dur);
    const w = durOfTicks(span / normal);
    if (!(w && Number.isInteger(span / normal)))
      throw new EditError(`A ${actual}:${normal} tuplet does not fit this note value`);
    const first = JSON.parse(JSON.stringify(te.ev)) as Event;
    first.dur = { ...w };
    const items: Item[] = [first, ...Array.from({ length: actual - 1 }, () => rest(w))];
    const g: TupletGroup = { kind: 'tuplet', actual, normal, items };
    replaceItem(v.items as Draft<Item>[], te.ev as Event, g);
  });
}

/** Replaces the event `target` by the single item `repl` somewhere in `items`; returns whether it was found. */
function replaceItem(items: Draft<Item>[], target: Event, repl: Item): boolean {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if ((it as unknown) === (target as unknown)) {
      items[i] = repl as Draft<Item>;
      return true;
    }
    if (!isEvent(it as Item) && replaceItem((it as Draft<TupletGroup>).items, target, repl)) return true;
  }
  return false;
}

/** Dissolve a tuplet; its notes keep their written values, which changes the length: the voice is refitted with rests. */
export function removeTuplet(score: Score, a: EvAddr & { depth: number }): Score {
  return edit(score, (d) => {
    const v = voiceIn(d, a);
    const te = flattenVoice(v as Voice)[a.idx];
    const g = te?.tuplets[a.depth] as Draft<TupletGroup> | undefined;
    if (!g) throw new EditError('No such tuplet');
    const span = (itemsTicks(g.items as Item[]) * g.normal) / g.actual;
    // Dissolving a tuplet: keep its events if they fit in the span unscaled (padding with rests),
    // else replace it by the span's worth of rests, the simplest well-defined result.
    const repl = splitTicks(span, 0).length ? (restsFor(span, 0) as Item[]) : [];
    const kept = (g.items as Item[]).filter(isEvent);
    const fits = kept.reduce((s, e) => s + baseTicks(e.dur), 0);
    const flat = fits <= span ? [...kept, ...(span - fits ? restsFor(span - fits, fits) : [])] : repl;
    spliceItem(v.items as Draft<Item>[], g, flat as Draft<Item>[]);
  });
}

/** Replaces `target` (an event or a group) by the items `repl` somewhere in `items`; returns whether it was found. */
function spliceItem(items: Draft<Item>[], target: Item, repl: Draft<Item>[]): boolean {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if ((it as unknown) === (target as unknown)) {
      items.splice(i, 1, ...repl);
      return true;
    }
    if (!isEvent(it as Item) && spliceItem((it as Draft<TupletGroup>).items, target, repl)) return true;
  }
  return false;
}

/** Patches the display fields (bracket, number, label, placement) of the tuplet at `a`. */
export function updateTuplet(
  score: Score,
  a: EvAddr & { depth: number },
  patch: Partial<Pick<TupletGroup, 'bracket' | 'number' | 'label' | 'placement'>>,
): Score {
  return edit(score, (d) => {
    const g = flattenVoice(voiceIn(d, a) as Voice)[a.idx]?.tuplets[a.depth] as Draft<TupletGroup> | undefined;
    if (!g) throw new EditError('No such tuplet');
    for (const [k, val] of Object.entries(patch)) {
      if (val === undefined) delete (g as Record<string, unknown>)[k];
      else (g as Record<string, unknown>)[k] = val;
    }
  });
}

// Measure-level and score-level commands: inserting and deleting measures, time and key signatures
// (a new length pads voices with rests or cuts them to fit), barlines, breaks, metadata and clefs.

/** Fit every voice of measure `mi` to `len` ticks: pad with rests or cut. */
function refit(d: Draft<Score>, mi: number, len: number): void {
  for (const sm of Object.values(d.measures[mi].staves))
    for (const v of sm.voices) {
      const total = itemsTicks(v.items as Item[]);
      if (total === len) continue;
      const only =
        (v.items as Item[]).length === 1 &&
        isEvent((v.items as Item[])[0]) &&
        ((v.items as Item[])[0] as Event).kind === 'rest' &&
        ((v.items as Item[])[0] as { style: string }).style === 'measure';
      if (only) {
        v.items = measureRest(len) as Draft<Item>[];
        continue;
      }
      if (total < len) {
        v.items = [...(v.items as Item[]), ...restsFor(len - total, total)] as Draft<Item>[];
        continue;
      }
      try {
        v.items = putEvent(v.items as Item[], len, rest({ base: 64, dots: 0 }), false).slice() as Draft<Item>[];
      } catch {
        /* fall through to the blunt cut */
      }
      if (itemsTicks(v.items as Item[]) !== len) v.items = measureRest(len) as Draft<Item>[];
    }
}

/** Removes the own length of measure `mi` when it is no longer shorter than the time signature in force. */
function dropLongLength(d: Draft<Score>, mi: number): void {
  const m = d.measures[mi];
  if (m.length !== undefined && m.length >= measureTicks(timeAt(d as Score, mi))) delete m.length;
}

/**
 * Gives measure `mi` its own length in ticks (a pickup, or a short measure), or with `undefined` the full length of
 * the time signature again; the voices are padded with rests or cut to fit. A pickup is the first measure with a
 * length and is numbered 0.
 */
export function setMeasureLength(score: Score, mi: number, length: number | undefined): Score {
  return edit(score, (d) => {
    const full = measureTicks(timeAt(d as Score, mi));
    if (length === undefined || length === full) delete d.measures[mi].length;
    else {
      if (!Number.isInteger(length) || length <= 0 || length > full)
        throw new EditError('A measure cannot be longer than its time signature');
      d.measures[mi].length = length;
    }
    refit(d, mi, lengthOf(d as Score, mi));
  });
}

/**
 * A measure of whole-measure rests on every staff, as long as the time signature in force at (or before) measure
 * `at`.
 */
function emptyMeasure(score: Score, at: number): Score['measures'][number] {
  const len = measureTicks(timeAt(score, Math.max(0, Math.min(at, score.measures.length - 1))));
  return {
    staves: Object.fromEntries(score.staves.map((s) => [s.id, { voices: [{ id: 1, items: measureRest(len) }] }])),
  };
}

/**
 * Inserts `count` empty measures before measure `at`. At the start they take over the time and key signature of
 * the old first measure.
 */
export function insertMeasures(score: Score, at: number, count = 1): Score {
  return edit(score, (d) => {
    const fresh = Array.from({ length: count }, () => emptyMeasure(score, Math.max(at - 1, 0)));
    d.measures.splice(at, 0, ...(fresh as Draft<Score['measures'][number]>[]));
    moveAnchorsOnInsert(d, at, count);
    if (at === 0 && d.measures.length > count && d.measures[count].time) {
      // The new first measure carries the time and key.
      d.measures[0].time = d.measures[count].time;
      if (d.measures[count].key !== undefined) d.measures[0].key = d.measures[count].key;
    }
  });
}

/** Copied measures: the staff contents of a run of measures (not their time, key, barline or repeat signs). */
export interface MeasureClip {
  measures: Record<string, StaffMeasure>[];
  /** The length of each copied measure in ticks. */
  lengths: number[];
}

/** Copies the staves of measures `from` to `to` (inclusive). */
export function copyMeasures(score: Score, from: number, to: number): MeasureClip {
  if (from < 0 || to >= score.measures.length || from > to) throw new EditError('No such measures');
  const ms = score.measures.slice(from, to + 1);
  return {
    measures: JSON.parse(JSON.stringify(ms.map((m) => m.staves))),
    lengths: ms.map((_, i) => lengthOf(score, from + i)),
  };
}

/**
 * Empties measures `from` to `to` (inclusive): every staff gets one voice holding a whole-measure rest. Time and key
 * signature, barline, repeat signs, volta and breaks stay; hairpins whose other end was cleared are dropped by `tidy`.
 */
export function clearMeasures(score: Score, from: number, to: number): Score {
  if (from < 0 || to >= score.measures.length || from > to) throw new EditError('No such measures');
  return edit(score, (d) => {
    for (let mi = from; mi <= to; mi++)
      d.measures[mi].staves = emptyMeasure(score, mi).staves as Draft<Score['measures'][number]>['staves'];
  });
}

/** Every mark body of a staff measure, in the events and in the voice ends. */
function marksInMeasure(sm: StaffMeasure): MarkBody[] {
  const out: MarkBody[] = [];
  for (const v of sm.voices) {
    for (const te of flattenVoice(v)) out.push(...(te.ev.marks ?? []));
    out.push(...(v.end ?? []));
  }
  return out;
}

/**
 * Pastes copied measures over the measures from `at` on (more measures are added at the end of the score when they do not
 * fit); each target measure must have the length of the copied one. Hairpins get ids that the rest of the staff does not use.
 */
export function pasteMeasures(score: Score, at: number, clip: MeasureClip): Score {
  if (at < 0 || at >= score.measures.length) throw new EditError('No such measure');
  clip.lengths.forEach((len, i) => {
    const mi = at + i;
    if (mi < score.measures.length && lengthOf(score, mi) !== len)
      throw new EditError(`Measure ${mi + 1} has a different length than the copied one`);
  });
  const copy: MeasureClip = JSON.parse(JSON.stringify(clip));
  return edit(score, (d) => {
    const extra = at + copy.measures.length - d.measures.length;
    for (let i = 0; i < extra; i++)
      d.measures.push(emptyMeasure(d as Score, d.measures.length - 1) as Draft<Score['measures'][number]>);
    for (const st of d.staves) {
      const used = new Set<number>();
      d.measures.forEach((m, mi) => {
        const sm = m.staves[st.id];
        if (sm && (mi < at || mi >= at + copy.measures.length))
          for (const mk of marksInMeasure(sm as StaffMeasure)) if (mk.type === 'hairpin') used.add(mk.id);
      });
      const map = new Map<number, number>();
      const fresh = (id: number) => {
        let n = map.get(id);
        if (n === undefined) {
          n = 1;
          while (used.has(n)) n++;
          used.add(n);
          map.set(id, n);
        }
        return n;
      };
      copy.measures.forEach((staves, i) => {
        const sm = staves[st.id];
        if (!sm) return;
        for (const mk of marksInMeasure(sm))
          if (mk.type === 'hairpin' || (mk.type === 'stop' && mk.of === 'hairpin')) mk.id = fresh(mk.id);
        d.measures[at + i].staves[st.id] = sm as Draft<StaffMeasure>;
      });
    }
  });
}

/**
 * Sets the key signature (in fifths) for measures `from` to `to`: a change at `from`, the later changes inside the run
 * removed, and the key that was in force after the run restored where it would otherwise change.
 */
export function setKeySigRange(score: Score, from: number, to: number, fifths: number): Score {
  return edit(score, (d) => {
    const after = to + 1 < d.measures.length ? keyAt(score, to + 1) : undefined;
    d.measures[from].key = fifths;
    for (let m = from + 1; m <= to; m++) delete d.measures[m].key;
    if (after !== undefined && after !== fifths && d.measures[to + 1].key === undefined) d.measures[to + 1].key = after;
  });
}

/** The same for the time signature of measures `from` to `to`; the measures are refitted to their new length. */
export function setTimeSigRange(score: Score, from: number, to: number, ts: TimeSig): Score {
  if (ts.beats < 1 || ![1, 2, 4, 8, 16, 32].includes(ts.beatType)) throw new EditError('Invalid time signature');
  return edit(score, (d) => {
    const after = to + 1 < d.measures.length ? timeAt(score, to + 1) : undefined;
    d.measures[from].time = { ...ts };
    for (let m = from + 1; m <= to; m++) delete d.measures[m].time;
    const same = after && after.beats === ts.beats && after.beatType === ts.beatType;
    if (after && !same && !d.measures[to + 1].time) d.measures[to + 1].time = { ...after };
    for (let m = from; m < d.measures.length; m++) {
      if (m > to + 1) break;
      dropLongLength(d, m);
      refit(d, m, lengthOf(d as Score, m));
    }
  });
}

/**
 * Deletes measures `from` to `to` (inclusive), handing a deleted time or key change on to the next measure. The
 * last measure cannot go.
 */
export function deleteMeasures(score: Score, from: number, to: number): Score {
  if (to - from + 1 >= score.measures.length) throw new EditError('A score needs at least one measure');
  return edit(score, (d) => {
    const gone = d.measures.splice(from, to - from + 1);
    moveAnchorsOnDelete(d, from, to);
    const next = d.measures[from];
    if (next) {
      // Keep time/key changes that were in force.
      const t = gone
        .map((m) => m.time)
        .filter(Boolean)
        .pop();
      const k = gone
        .map((m) => m.key)
        .filter((x) => x !== undefined)
        .pop();
      if (t && !next.time) next.time = t;
      if (k !== undefined && next.key === undefined) next.key = k;
    }
    if (from === 0 && !d.measures[0].time) d.measures[0].time = gone[0].time ?? { beats: 4, beatType: 4 };
    // A measure that lost its time change now has the length of the previous time signature, so
    // every measure is refitted.
    for (let mi = 0; mi < d.measures.length; mi++) refit(d, mi, lengthOf(d as Score, mi));
  });
}

/**
 * Sets (or, with `undefined`, removes) the time signature that starts at measure `mi`; the first measure always
 * keeps one.
 */
export function setTimeSig(score: Score, mi: number, ts: TimeSig | undefined): Score {
  if (ts && (ts.beats < 1 || ![1, 2, 4, 8, 16, 32].includes(ts.beatType)))
    throw new EditError('Invalid time signature');
  return edit(score, (d) => {
    if (mi === 0 && !ts) throw new EditError('The first measure needs a time signature');
    if (ts) d.measures[mi].time = { ...ts };
    else delete d.measures[mi].time;
    for (let m = mi; m < d.measures.length; m++) {
      if (m > mi && d.measures[m].time) break;
      dropLongLength(d, m);
      refit(d, m, lengthOf(d as Score, m));
    }
  });
}

/**
 * Sets the key signature (in fifths) that starts at measure `mi`; `undefined` removes a change after the first
 * measure.
 */
export function setKeySig(score: Score, mi: number, fifths: number | undefined): Score {
  return edit(score, (d) => {
    if (fifths === undefined && mi > 0) delete d.measures[mi].key;
    else d.measures[mi].key = fifths ?? 0;
  });
}

/** Sets the barline at the end of measure `mi`; `single` or `undefined` clears it. */
export function setBarline(
  score: Score,
  mi: number,
  b: 'single' | 'double' | 'final' | 'repeat-end' | undefined,
): Score {
  return edit(score, (d) => {
    if (!b || b === 'single') delete d.measures[mi].barline;
    else d.measures[mi].barline = b;
  });
}

/** Puts a repeat sign at the start of measure `mi`, or takes it away. */
export function setRepeatStart(score: Score, mi: number, on: boolean): Score {
  return edit(score, (d) => {
    if (on) d.measures[mi].repeatStart = true;
    else delete d.measures[mi].repeatStart;
  });
}

/** Puts measure `mi` under the volta for these passes, or takes it out of one. */
export function setEnding(score: Score, mi: number, numbers: number[] | undefined): Score {
  return edit(score, (d) => {
    if (numbers?.length) d.measures[mi].ending = [...numbers].sort((a, b) => a - b);
    else delete d.measures[mi].ending;
  });
}

/** Forces a system or page break before measure `mi`, or clears it with `undefined`. */
export function setBreak(score: Score, mi: number, b: 'system' | 'page' | undefined): Score {
  return edit(score, (d) => {
    if (b) d.measures[mi].breakBefore = b;
    else delete d.measures[mi].breakBefore;
  });
}

/** Sets the clef a staff starts with. */
export function setStaffClef(score: Score, staff: string, clef: Clef): Score {
  return edit(score, (d) => {
    const s = d.staves.find((x) => x.id === staff);
    if (s) s.clef = { ...clef };
  });
}

/** Merges title, composer and the other metadata fields into the score; an empty value removes the field. */
export function setMeta(score: Score, patch: Partial<Score['meta']>): Score {
  return edit(score, (d) => {
    for (const [k, v] of Object.entries(patch)) {
      if (v) (d.meta as Record<string, string>)[k] = v;
      else delete (d.meta as Record<string, string>)[k];
    }
  });
}

// Staff commands: adding, removing, moving and duplicating staves, names, measure numbering and
// page settings, and brace/bracket groups (`connections` presents the groups as the kind of link
// between neighboring staves).

export type Connection = 'brace' | 'bracket' | undefined;

/** Which kind of group joins staff i with staff i+1 (the natural way to edit groups). */
export function connections(score: Score): Connection[] {
  const ids = score.staves.map((s) => s.id);
  const out: Connection[] = ids.slice(1).map(() => undefined);
  for (const g of score.groups) {
    const idx = g.staves
      .map((id) => ids.indexOf(id))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b);
    for (let j = 0; j + 1 < idx.length; j++) if (idx[j + 1] === idx[j] + 1) out[idx[j]] = g.kind;
  }
  return out;
}

/**
 * Rebuilds the staff groups from the connection kind between each pair of neighboring staves `ids`: a run of
 * equal kinds is one group, a missing kind joins nothing.
 */
function groupsFrom(ids: string[], conn: Connection[]): Score['groups'] {
  const groups: Score['groups'] = [];
  for (let i = 0; i < conn.length; i++) {
    const k = conn[i];
    if (!k) continue;
    const last = groups[groups.length - 1];
    if (last && last.kind === k && last.staves[last.staves.length - 1] === ids[i]) last.staves.push(ids[i + 1]);
    else groups.push({ kind: k, staves: [ids[i], ids[i + 1]] });
  }
  return groups;
}

/** Sets how the staves on both sides of `boundary` are joined (brace, bracket, ...) and rebuilds the groups. */
export function setConnection(score: Score, boundary: number, kind: Connection): Score {
  return edit(score, (d) => {
    const conn = connections(score);
    if (boundary < 0 || boundary >= conn.length) throw new EditError('No such pair of staves');
    conn[boundary] = kind;
    d.groups = groupsFrom(
      d.staves.map((s) => s.id),
      conn,
    ) as Draft<Score['groups']>;
  });
}

/** A new staff (empty: rests throughout) at position `at` (default: last). */
export function addStaff(score: Score, o: { clef: Clef; name?: string; abbr?: string; at?: number }): Score {
  return edit(score, (d) => {
    let n = d.staves.length + 1;
    while (d.staves.some((s) => s.id === `s${n}`)) n++;
    const id = `s${n}`;
    const at = Math.max(0, Math.min(o.at ?? d.staves.length, d.staves.length));
    const conn = connections(score);
    d.staves.splice(at, 0, {
      id,
      clef: { ...o.clef },
      ...(o.name ? { name: o.name } : {}),
      ...(o.abbr ? { abbr: o.abbr } : {}),
    });
    // Inserting between two joined staves splits the join: both neighboring connections become
    // unconnected (`nc` lists the connection after each staff).
    const nc = [
      ...conn.slice(0, Math.max(0, at - 1)),
      ...(at > 0 && at < score.staves.length ? [undefined, undefined] : [undefined]),
      ...conn.slice(at),
    ];
    d.groups = groupsFrom(
      d.staves.map((s) => s.id),
      nc.slice(0, d.staves.length - 1),
    ) as Draft<Score['groups']>;
    d.measures.forEach((m, mi) => {
      m.staves[id] = { voices: [{ id: 1, items: measureRest(lengthOf(d as Score, mi)) as Draft<Item>[] }] };
    });
  });
}

/**
 * Removes staff `id` with its music from every measure, repairs the groups around it and drops cross-staff
 * notes that pointed to it. The last staff cannot go.
 */
export function removeStaff(score: Score, id: string): Score {
  const i = score.staves.findIndex((s) => s.id === id);
  if (i < 0) throw new EditError('No such staff');
  if (score.staves.length === 1) throw new EditError('A score needs at least one staff');
  return edit(score, (d) => {
    const conn = connections(score);
    const merged = i > 0 && i < conn.length + 0 && conn[i - 1] === conn[i] ? conn[i] : undefined;
    d.staves.splice(i, 1);
    const nc = [
      ...conn.slice(0, Math.max(0, i - 1)),
      ...(i > 0 && i < score.staves.length - 1 ? [merged] : []),
      ...conn.slice(i + 1),
    ];
    d.groups = groupsFrom(
      d.staves.map((s) => s.id),
      nc,
    ) as Draft<Score['groups']>;
    for (const m of d.measures) {
      delete m.staves[id];
      for (const sm of Object.values(m.staves))
        for (const v of sm.voices)
          for (const te of flattenVoice(v as Voice))
            if (te.ev.kind === 'note' && te.ev.staff === id) delete (te.ev as Draft<NoteEvent>).staff;
    }
  });
}

/** Swap a staff with its neighbor; the joins stay where they are (between the same two positions). */
export function moveStaff(score: Score, id: string, dir: -1 | 1): Score {
  const i = score.staves.findIndex((s) => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= score.staves.length) return score;
  return edit(score, (d) => {
    const conn = connections(score);
    [d.staves[i], d.staves[j]] = [d.staves[j], d.staves[i]];
    d.groups = groupsFrom(
      d.staves.map((s) => s.id),
      conn,
    ) as Draft<Score['groups']>;
  });
}

/** Move a staff to index `to`; the joins stay where they are (between the same positions). */
export function moveStaffTo(score: Score, id: string, to: number): Score {
  const i = score.staves.findIndex((s) => s.id === id);
  if (i < 0) throw new EditError('No such staff');
  to = Math.max(0, Math.min(to, score.staves.length - 1));
  if (i === to) return score;
  return edit(score, (d) => {
    const conn = connections(score);
    const [st] = d.staves.splice(i, 1);
    d.staves.splice(to, 0, st);
    d.groups = groupsFrom(
      d.staves.map((s) => s.id),
      conn,
    ) as Draft<Score['groups']>;
  });
}

/** A copy of a staff (same clef, name and music) directly below it. */
export function duplicateStaff(score: Score, id: string): Score {
  const i = score.staves.findIndex((s) => s.id === id);
  if (i < 0) throw new EditError('No such staff');
  const src = score.staves[i];
  const withNew = addStaff(score, {
    clef: src.clef,
    ...(src.name ? { name: src.name } : {}),
    ...(src.abbr ? { abbr: src.abbr } : {}),
    at: i + 1,
  });
  const nid = withNew.staves[i + 1].id;
  return edit(withNew, (d) => {
    d.measures.forEach((m, mi) => {
      m.staves[nid] = JSON.parse(JSON.stringify(score.measures[mi].staves[id]));
    });
  });
}

const G: Clef = { sign: 'G', line: 2 };
const F: Clef = { sign: 'F', line: 4 };
const C3: Clef = { sign: 'C', line: 3 };
const C4: Clef = { sign: 'C', line: 4 };
const G8: Clef = { sign: 'G', line: 2, octave: -1 };

export interface InstrumentPreset {
  key: string;
  label: string;
  staves: { clef: Clef; name?: string; abbr?: string }[];
  join?: 'brace' | 'bracket';
}

export const INSTRUMENTS: InstrumentPreset[] = [
  { key: 'treble', label: 'Treble staff', staves: [{ clef: G }] },
  { key: 'bass', label: 'Bass staff', staves: [{ clef: F }] },
  {
    key: 'piano',
    label: 'Piano (grand staff)',
    staves: [{ clef: G, name: 'Piano', abbr: 'Pno.' }, { clef: F }],
    join: 'brace',
  },
  { key: 'voice', label: 'Voice', staves: [{ clef: G, name: 'Voice', abbr: 'Vo.' }] },
  { key: 'violin', label: 'Violin', staves: [{ clef: G, name: 'Violin', abbr: 'Vl.' }] },
  { key: 'viola', label: 'Viola', staves: [{ clef: C3, name: 'Viola', abbr: 'Va.' }] },
  { key: 'cello', label: 'Cello', staves: [{ clef: F, name: 'Cello', abbr: 'Vc.' }] },
  {
    key: 'satb',
    label: 'SATB choir',
    staves: [
      { clef: G, name: 'Soprano', abbr: 'S.' },
      { clef: G, name: 'Alto', abbr: 'A.' },
      { clef: G8, name: 'Tenor', abbr: 'T.' },
      { clef: F, name: 'Bass', abbr: 'B.' },
    ],
    join: 'bracket',
  },
  {
    key: 'quartet',
    label: 'String quartet',
    staves: [
      { clef: G, name: 'Violin I', abbr: 'Vl. I' },
      { clef: G, name: 'Violin II', abbr: 'Vl. II' },
      { clef: C3, name: 'Viola', abbr: 'Va.' },
      { clef: F, name: 'Cello', abbr: 'Vc.' },
    ],
    join: 'bracket',
  },
];

void C4;

/** Insert the staves of a preset (with names and joins) at position `at` (default: last), as one edit. */
export function addInstrument(score: Score, key: string, at?: number): Score {
  const p = INSTRUMENTS.find((x) => x.key === key);
  if (!p) throw new EditError('Unknown instrument');
  const base = Math.max(0, Math.min(at ?? score.staves.length, score.staves.length));
  let sc = score;
  p.staves.forEach((st, k) => {
    sc = addStaff(sc, { clef: st.clef, name: st.name, abbr: st.abbr, at: base + k });
  });
  if (p.join) for (let k = 0; k + 1 < p.staves.length; k++) sc = setConnection(sc, base + k, p.join);
  return sc;
}

/** Sets the name printed at the start of a staff; an empty name removes it. */
export function setStaffName(score: Score, id: string, name: string): Score {
  return edit(score, (d) => {
    const s = d.staves.find((x) => x.id === id);
    if (s) {
      if (name) s.name = name;
      else delete s.name;
    }
  });
}

/** Sets the abbreviation printed at the start of the later systems of a staff; an empty one removes it. */
export function setStaffAbbr(score: Score, id: string, abbr: string): Score {
  return edit(score, (d) => {
    const s = d.staves.find((x) => x.id === id);
    if (s) {
      if (abbr) s.abbr = abbr;
      else delete s.abbr;
    }
  });
}

/** Sets what the first and the other systems show before their staves (`undefined`: nothing) and the label size. */
export function setStaffLabels(
  score: Score,
  o: { first?: 'full' | 'abbr' | undefined; later?: 'full' | 'abbr' | undefined; size?: number | undefined },
): Score {
  return edit(score, (d) => {
    const set = <K extends 'labelsFirst' | 'labelsLater' | 'labelSize'>(k: K, v: Score['page'][K] | undefined) => {
      if (v === undefined) delete d.page[k];
      else d.page[k] = v;
    };
    if ('first' in o) set('labelsFirst', o.first);
    if ('later' in o) set('labelsLater', o.later);
    if ('size' in o) set('labelSize', o.size);
  });
}

/** Sets which measure numbers are printed (`undefined` is the default). */
export function setMeasureNumbers(score: Score, mode: 'all' | 'none' | undefined): Score {
  return edit(score, (d) => {
    if (mode) d.page.measureNumbers = mode;
    else delete d.page.measureNumbers;
  });
}

/** Switches the engraving of runs of empty measures as multi-measure rests on or off. */
export function setMultiRests(score: Score, on: boolean): Score {
  return edit(score, (d) => {
    if (on) d.page.multiRests = true;
    else delete d.page.multiRests;
  });
}

/** Merges `patch` into the page setup (size, margins, staff space, ...). */
export function setPage(score: Score, patch: Partial<Score['page']>): Score {
  return edit(score, (d) => {
    Object.assign(d.page, patch);
  });
}

/**
 * What copying events takes along: the events (with graces, ornaments and lyrics, which are fields of the event) and their marks
 * that stay complete: dynamics, text, tempo, and spans whose start and stop are both in the copy. A span that starts in the copy and
 * stops after it brings that stop in `tail`, to hang on whatever follows the pasted events.
 */
export interface Clip {
  events: Event[];
  tail: MarkBody[];
}

/** The key that pairs the start of a span with its stop (hairpins by id; pedal, ottava and trill lines by kind). */
function spanKey(m: MarkBody): string | undefined {
  if (m.type === 'hairpin') return `hairpin:${m.id}`;
  if (m.type === 'stop') return m.of === 'hairpin' ? `hairpin:${m.id}` : m.of;
  return m.type === 'pedal' || m.type === 'ottava' || m.type === 'trill' ? m.type : undefined;
}

/** Whether a mark opens a span (as opposed to closing one or being a point mark). */
const opensSpan = (m: MarkBody): boolean =>
  m.type === 'hairpin' || m.type === 'pedal' || m.type === 'ottava' || m.type === 'trill';

/** The first stops after event `last` in its voice, for the span keys in `want`; a span without one is not in the result. */
function stopsAfter(score: Score, last: EvAddr, want: Set<string>): Map<string, MarkBody> {
  const found = new Map<string, MarkBody>();
  const take = (m: MarkBody) => {
    const key = m.type === 'stop' ? spanKey(m) : undefined;
    if (key && want.has(key) && !found.has(key)) found.set(key, JSON.parse(JSON.stringify(m)) as MarkBody);
  };
  for (let mi = last.mi; mi < score.measures.length && found.size < want.size; mi++) {
    const v = score.measures[mi].staves[last.staff]?.voices.find((x) => x.id === last.voice);
    if (!v) continue;
    for (const te of flattenVoice(v).slice(mi === last.mi ? last.idx + 1 : 0))
      for (const m of te.ev.marks ?? []) take(m);
    for (const m of v.end ?? []) take(m);
  }
  return found;
}

/** Copies the events at `refs` (in score order, one voice) with the marks that stay complete (see `Clip`). */
export function copyEvents(score: Score, refs: EvAddr[]): Clip {
  const evs = refs.map((r) => eventOf(score, r)).filter((e): e is Event => !!e);
  if (!evs.length) throw new EditError('Nothing to copy');
  const events = JSON.parse(JSON.stringify(evs)) as Event[];
  const open = new Map<string, { ev: Event; mark: MarkBody }>();
  for (const e of events) {
    const kept: MarkBody[] = [];
    for (const m of e.marks ?? []) {
      const key = spanKey(m);
      if (m.type === 'clef') continue;
      if (!key) kept.push(m);
      else if (opensSpan(m)) {
        open.set(key, { ev: e, mark: m });
        kept.push(m);
      } else if (open.delete(key)) kept.push(m);
    }
    if (kept.length) e.marks = kept;
    else delete e.marks;
  }
  const tail: MarkBody[] = [];
  const stops = open.size
    ? stopsAfter(score, refs[refs.length - 1], new Set(open.keys()))
    : new Map<string, MarkBody>();
  for (const [key, { ev, mark }] of open) {
    const stop = stops.get(key);
    if (stop) tail.push(stop);
    else {
      ev.marks = ev.marks?.filter((m) => m !== mark);
      if (!ev.marks?.length) delete ev.marks;
    }
  }
  return { events, tail };
}

/** The point marks (dynamics, text, tempo) at `addrs`, to paste onto other events; spans and clefs cannot be copied alone. */
export function copyMarks(score: Score, addrs: MarkAddr[]): MarkBody[] {
  const out: MarkBody[] = [];
  for (const a of addrs) {
    const m = markOf(score, a);
    if (!(m && (m.type === 'dynamic' || m.type === 'text' || m.type === 'tempo'))) continue;
    const { tick: _t, voice: _v, idx: _i, k: _k, ...body } = m;
    out.push(JSON.parse(JSON.stringify(body)) as MarkBody);
  }
  if (!out.length) throw new EditError('Only dynamics, text and tempo marks can be copied on their own');
  return out;
}

/** Hangs copies of `marks` on each event at `addrs` (a dynamic or tempo replaces the one already there). */
export function pasteMarks(score: Score, addrs: EvAddr[], marks: MarkBody[]): Score {
  return edit(score, (d) => {
    for (const a of addrs) for (const m of marks) hang(d, a, JSON.parse(JSON.stringify(m)) as MarkBody);
  });
}

/** Hairpin ids of the clip renumbered to ids not used by the staff, so that a pasted hairpin cannot pair with another one. */
function renumberHairpins(d: Draft<Score>, staff: string, clip: Clip): void {
  const used = new Set<number>();
  for (const m of d.measures) {
    const sm = m.staves[staff];
    if (sm) for (const mk of collectMarks(sm as StaffMeasure)) if (mk.type === 'hairpin') used.add(mk.id);
  }
  const map = new Map<number, number>();
  const fresh = (id: number) => {
    let n = map.get(id);
    if (n === undefined) {
      n = 1;
      while (used.has(n)) n++;
      used.add(n);
      map.set(id, n);
    }
    return n;
  };
  const fix = (m: MarkBody) => {
    if (m.type === 'hairpin' || (m.type === 'stop' && m.of === 'hairpin')) m.id = fresh(m.id);
  };
  for (const e of clip.events) for (const m of e.marks ?? []) fix(m);
  for (const m of clip.tail) fix(m);
}

/**
 * Paste events (as copied from a voice) one after another from `tick`; slur flags are not carried over. A `Clip` brings its marks
 * (hairpins get fresh ids) and hangs the stops of spans that run past the copy on the event after the pasted ones, or on the
 * voice end. Plain events come without marks.
 */
export function pasteEvents(score: Score, loc: Loc, tick: number, source: Event[] | Clip): Score {
  const clip: Clip = JSON.parse(
    JSON.stringify(
      Array.isArray(source) ? { events: source.map((e) => ({ ...e, marks: undefined })), tail: [] } : source,
    ),
  );
  return edit(score, (d) => {
    const v = voiceIn(d, loc, true);
    const len = lengthOf(d as Score, loc.mi);
    renumberHairpins(d, loc.staff, clip);
    let t = tick;
    let all = true;
    for (const c of clip.events) {
      delete c.slurStart;
      delete c.slurStop;
      delete c.lineStart;
      delete c.lineStop;
      delete c.staff;
      const w = baseTicks(c.dur);
      if (t + w > len) {
        if (t === tick) throw new EditError('Does not fit into the measure');
        all = false;
        break;
      }
      v.items = putEvent(v.items as Item[], t, c) as Draft<Item>[];
      t += w;
    }
    if (!(all && clip.tail.length)) return;
    const next = flattenVoice(v as Voice).find((te) => te.start === t);
    for (const stop of clip.tail) {
      if (!next) {
        v.end ??= [];
        v.end.push(stop as Draft<MarkBody>);
        continue;
      }
      // The stop goes before the marks that start something at the same position.
      next.ev.marks ??= [];
      const marks = next.ev.marks as Draft<MarkBody>[];
      const i = marks.findIndex((m) => m.type !== 'stop');
      marks.splice(i < 0 ? marks.length : i, 0, stop as Draft<MarkBody>);
    }
  });
}

// Beam and tremolo groups wrap a run of sibling events of one voice (the same tuplet or the voice
// itself); the commands below create and dissolve them, set the per-note beam modes and make
// tremolos.

/** Wrap the events from `a` to `b` (flat indices, siblings in one list: same tuplet or the voice itself) in a group. */
function wrapRange(d: Draft<Score>, loc: Loc, a: number, b: number, make: (items: Item[]) => Item): void {
  const v = voiceIn(d, loc);
  const flat = flattenVoice(v as Voice);
  const ea = flat[a]?.ev;
  const eb = flat[b]?.ev;
  if (!(ea && eb)) throw new EditError('No such note');
  const find = (items: Draft<Item>[]): boolean => {
    const ia = items.findIndex((x) => (x as unknown) === (ea as unknown));
    const ib = items.findIndex((x) => (x as unknown) === (eb as unknown));
    if (ia >= 0 && ib >= 0) {
      const grp = make(items.slice(ia, ib + 1) as Item[]);
      items.splice(ia, ib - ia + 1, grp as Draft<Item>);
      return true;
    }
    for (const it of items) if (!isEvent(it as Item) && find((it as Draft<TupletGroup>).items)) return true;
    return false;
  };
  if (!find(v.items as Draft<Item>[]))
    throw new EditError('These notes are not in the same group: select notes in one beat or one tuplet');
}

/** Beam the selected run of notes together, whatever the automatic rules say. */
export function makeBeam(score: Score, loc: Loc, from: number, to: number): Score {
  return edit(score, (d) => wrapRange(d, loc, from, to, (items) => ({ kind: 'beam', items })));
}

/** The first and last event below an item. */
const edgeEvents = (it: Item): [Event, Event] => {
  const flat = flattenVoice({ id: 0, items: [it] });
  return [flat[0].ev, flat[flat.length - 1].ev];
};

/** Wraps the events from `ea` to `eb` in a beam group, at the innermost level where both are siblings (or whole children of siblings). */
function wrapEvents(items: Draft<Item>[], ea: Event, eb: Event): boolean {
  const holds = (it: Draft<Item>, e: Event) =>
    (it as unknown) === (e as unknown) ||
    (!isEvent(it as Item) &&
      flattenVoice({ id: 0, items: (it as Draft<TupletGroup>).items as Item[] }).some(
        (t) => (t.ev as unknown) === (e as unknown),
      ));
  const ia = items.findIndex((it) => holds(it, ea));
  const ib = items.findIndex((it) => holds(it, eb));
  if (ia < 0 || ib < 0) return false;
  if (ia === ib) {
    const g = items[ia] as Draft<TupletGroup>;
    if (isEvent(g as unknown as Item)) return false;
    if (isTremolo(g as unknown as Item)) throw new EditError('The notes of a tremolo are not beamed');
    return wrapEvents(g.items as Draft<Item>[], ea, eb);
  }
  if (
    (edgeEvents(items[ia] as Item)[0] as unknown) !== (ea as unknown) ||
    (edgeEvents(items[ib] as Item)[1] as unknown) !== (eb as unknown)
  )
    throw new EditError('A beam cannot start or end in the middle of a tuplet');
  items.splice(ia, ib - ia + 1, { kind: 'beam', items: items.slice(ia, ib + 1) as Item[] } as Draft<Item>);
  return true;
}

/**
 * Rewrites the explicit beam groups and `noBeam` flags of a voice so that it is beamed as `plan` says:
 * all groups are dissolved, then a group is written for every wanted beam that the automatic rules
 * would not produce, and a flag for every note that is wanted alone but would be beamed to a neighbor.
 */
function realizeBeams(v: Draft<Voice>, beatLen: number, phase: number, plan: BeamPlan, preferred: Set<number>): void {
  const dissolve = (items: Draft<Item>[]) => {
    for (let i = 0; i < items.length; i++) {
      const it = items[i] as Item;
      if (isEvent(it)) continue;
      dissolve((it as Draft<TupletGroup>).items);
      if (isBeam(it)) {
        const kids = it.items as unknown as Draft<Item>[];
        items.splice(i, 1, ...kids);
        i += kids.length - 1;
      }
    }
  };
  dissolve(v.items as Draft<Item>[]);
  const flat = flattenVoice(v as Voice);
  const at = new Map(flat.map((t) => [t.ev, t.index]));
  flat.forEach((t, i) => {
    const e = t.ev as Draft<Event>;
    if (e.kind !== 'note') return;
    if (plan.flags[i]) e.noBeam = true;
    else if (e.noBeam) delete e.noBeam;
  });
  const auto = new Set(beamGroups(v as Voice, beatLen, phase).map((g) => g.map((e) => at.get(e)).join(',')));
  const wanted = new Set<number>();
  for (let i = 0; i < flat.length; ) {
    let j = i;
    while (j + 1 < flat.length && plan.links[j + 1]) j++;
    let a = i;
    let b = j;
    while (a <= b && flat[a].ev.kind === 'rest') a++;
    while (b >= a && flat[b].ev.kind === 'rest') b--;
    if (flat.slice(a, b + 1).filter((t) => t.ev.kind === 'note').length >= 2) {
      for (let k = a; k <= b; k++) wanted.add(k);
      const key = flat
        .slice(a, b + 1)
        .map((t) => t.index)
        .join(',');
      if (!(auto.has(key) || wrapEvents(v.items as Draft<Item>[], flat[a].ev, flat[b].ev)))
        throw new EditError('These notes cannot be beamed together');
    }
    i = j + 1;
  }
  // Notes that should stand alone but that the automatic rules would join to a neighbor now get a
  // flag, one at a time (the flag of one often frees its partner), the notes the user chose first.
  for (;;) {
    const joined = beamGroups(v as Voice, beatLen, phase)
      .flat()
      .filter((e) => e.kind === 'note' && !wanted.has(must(at.get(e))));
    if (!joined.length) break;
    const pick = joined.find((e) => preferred.has(must(at.get(e)))) ?? joined[0];
    (pick as Draft<Event> & { noBeam?: boolean }).noBeam = true;
  }
  const got = beamLinks(v as Voice, beatLen, phase);
  flat.forEach((t, i) => {
    if (i > 0 && t.ev.kind === 'note' && flat[i - 1].ev.kind === 'note' && got[i] !== plan.links[i])
      throw new EditError('These notes cannot be beamed that way');
  });
}

/**
 * The beam mode of each addressed note (see beams.ts): `auto` leaves the choice to the rules, `none`
 * keeps the note out of any beam, `break` starts a new beam at it and `join` continues the beam of the
 * previous note. A beam stays within one measure.
 */
export function setBeamMode(score: Score, addrs: EvAddr[], mode: BeamMode): Score {
  return edit(score, (d) => {
    const byVoice = new Map<string, EvAddr[]>();
    for (const a of addrs) {
      const k = `${a.mi}|${a.staff}|${a.voice}`;
      byVoice.set(k, [...(byVoice.get(k) ?? []), a]);
    }
    for (const list of byVoice.values()) {
      const v = voiceIn(d, list[0]);
      const beatLen = beatTicks(timeAt(d as Score, list[0].mi));
      const phase = beatPhase(d as Score, list[0].mi);
      const plan = planBeams(v as Voice, beatLen, new Map(list.map((a) => [a.idx, mode])), phase);
      if (typeof plan === 'string') throw new EditError(plan);
      const links = beamLinks(v as Voice, beatLen, phase);
      const same =
        plan.links.every((l, i) => l === links[i]) &&
        flattenVoice(v as Voice).every((t, i) => plan.flags[i] === (t.ev.kind === 'note' && !!t.ev.noBeam));
      if (!same) realizeBeams(v, beatLen, phase, plan, new Set(list.map((a) => a.idx)));
    }
  });
}

/** Two-note tremolo with `beams` beams between exactly two notes. */
export function makeTremolo(score: Score, loc: Loc, from: number, to: number, beams = 2): Score {
  if (to - from !== 1) throw new EditError('A tremolo joins exactly two notes');
  return edit(score, (d) => {
    // Already a tremolo over exactly these two notes: change its number of beams instead of
    // nesting another tremolo inside it (this is what the tremolo buttons do on a second press).
    const v = voiceIn(d, loc);
    const flat = flattenVoice(v as Voice);
    const ea = flat[from]?.ev;
    const eb = flat[to]?.ev;
    const again = (items: Draft<Item>[]): boolean => {
      for (const it of items) {
        if (isEvent(it as Item)) continue;
        const g = it as Draft<TupletGroup>;
        if (isTremolo(g as unknown as Item)) {
          const evs = flattenVoice({ id: 0, items: g.items as Item[] }).map((t) => t.ev as unknown);
          if (evs.includes(ea as unknown) && evs.includes(eb as unknown)) {
            (g as unknown as { beams: number }).beams = beams;
            return true;
          }
        }
        if (again(g.items as Draft<Item>[])) return true;
      }
      return false;
    };
    if (again(v.items as Draft<Item>[])) return;
    // A tremolo does not go inside a beam group: it replaces a beam group over exactly these two
    // notes; a longer group is dissolved (its other notes go back to automatic beaming).
    const inBeam = (items: Draft<Item>[]): boolean => {
      for (let i = 0; i < items.length; i++) {
        const it = items[i] as Item;
        if (isEvent(it)) continue;
        if (isBeam(it)) {
          const evs = flattenVoice({ id: 0, items: it.items }).map((t) => t.ev as unknown);
          if (!(evs.includes(ea as unknown) || evs.includes(eb as unknown))) continue;
          if (evs.length !== 2 || !evs.includes(ea as unknown) || !evs.includes(eb as unknown)) {
            items.splice(i, 1, ...(it.items as unknown as Draft<Item>[]));
            return false;
          }
          items[i] = { kind: 'tremolo', beams, items: it.items } as Draft<Item>;
          return true;
        }
        if (inBeam((it as Draft<TupletGroup>).items)) return true;
      }
      return false;
    };
    if (!inBeam(v.items as Draft<Item>[])) wrapRange(d, loc, from, to, (items) => ({ kind: 'tremolo', beams, items }));
  });
}

/** Dissolve the beam group or tremolo that holds the event. */
export function ungroup(score: Score, a: EvAddr): Score {
  return edit(score, (d) => {
    const v = voiceIn(d, a);
    const target = flattenVoice(v as Voice)[a.idx]?.ev;
    const walk = (items: Draft<Item>[]): boolean => {
      for (let i = 0; i < items.length; i++) {
        const it = items[i] as Item;
        if (isEvent(it)) continue;
        if (
          (isBeam(it) || isTremolo(it)) &&
          flattenVoice({ id: 0, items: it.items }).some((t) => (t.ev as unknown) === (target as unknown))
        ) {
          items.splice(i, 1, ...(it.items as unknown as Draft<Item>[]));
          return true;
        }
        if (walk((it as Draft<TupletGroup>).items)) return true;
      }
      return false;
    };
    if (!walk(v.items as Draft<Item>[])) throw new EditError('Not in a beam group or tremolo');
  });
}
