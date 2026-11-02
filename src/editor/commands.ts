// Edit commands: pure `Score -> Score` functions (Immer), each leaving every voice exactly as long as its measure.
// Failures throw EditError with a message fit for the user; the score is then unchanged.
//
// Every command goes through `edit`, which runs it on an Immer draft and then `tidy`s the measures it
// touched. Commands therefore only have to do the main change; consequences such as a slur that lost
// its end note or a beam group that lost a note are cleaned up in one place. Events are addressed by
// `EvAddr` (see addr.ts), never by object, because the draft replaces objects.
import type { Draft } from 'immer';
import { produce } from 'immer';
import type {
  Articulation,
  Clef,
  Dur,
  Event,
  Item,
  MarkBody,
  NoteEvent,
  NotePitch,
  Pitch,
  Score,
  StaffMeasure,
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
  marksOf,
  measureTicks,
  timeAt,
} from '../model.ts';
import { must } from '../util.ts';
import type { EvAddr, MarkAddr } from './addr.ts';
import { voiceOf } from './addr.ts';
import { comparePitch, transposeSemis, transposeSteps } from './context.ts';
import { durOfTicks, EditError, eventAtTick, itemsTicks, putEvent, rest, restsFor, splitTicks } from './voice.ts';

export { EditError };

export interface Loc {
  mi: number;
  staff: string;
  voice: number;
}

// ------------------------------------------------------------------ plumbing

/** Runs `fn` on a draft of the score and tidies what it touched (`tidy` re-establishes the invariants). Returns the same score if nothing changed. */
function edit(score: Score, fn: (d: Draft<Score>) => void): Score {
  const next = produce(score, fn);
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

function staffMeasure(d: Draft<Score>, mi: number, staff: string): Draft<StaffMeasure> {
  if (!d.staves.some((s) => s.id === staff)) throw new EditError(`Unknown staff ${staff}`);
  const m = d.measures[mi];
  if (!m) throw new EditError('No such measure');
  m.staves[staff] ??= { voices: [] };
  return m.staves[staff];
}

function voiceIn(d: Draft<Score>, loc: Loc, create = false): Draft<Voice> {
  const sm = staffMeasure(d, loc.mi, loc.staff);
  let v = sm.voices.find((x) => x.id === loc.voice);
  if (!v) {
    if (!create) throw new EditError('No such voice');
    sm.voices.push({ id: loc.voice, items: measureRest(measureTicks(timeAt(d as Score, loc.mi))) });
    sm.voices.sort((a, b) => a.id - b.id);
    v = must(sm.voices.find((x) => x.id === loc.voice));
  }
  return v;
}

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
  for (const staff of touched.staves) dropUnpairedHairpins(d, staff);
}

/** Slur ids of a voice's events in time order (starts and stops of one event together), for events that have any. Voices are never changed in place, so this is kept per object. */
const slurTokens = new WeakMap<Voice, { stops: number[]; starts: number[] }[]>();
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
          if (!open.has(id)) return true; // a stop with no start
          open.delete(id);
        }
        for (const id of t.starts) open.add(id);
      }
    }
    if (open.size) return true; // a start never stopped
  }
  for (const sid of staves) if (hasUnpairedHairpins(s, sid)) return true;
  return false;
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

// ------------------------------------------------------------------ notes and rests

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
function replaceInPlace(v: Draft<Voice>, target: Event, repl: Event): void {
  const walk = (items: Draft<Item>[]): boolean => {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it === (target as unknown)) {
        items[i] = repl as Draft<Item>;
        return true;
      }
      if (!isEvent(it as Item) && walk((it as Draft<TupletGroup>).items)) return true;
    }
    return false;
  };
  walk(v.items);
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
        else replaceInPlace(v, at.ev, toRest(n));
      } else insertPitch(n, np);
      return;
    }
    if (tick + baseTicks(dur) > measureTicks(timeAt(d as Score, loc.mi)) && !at?.inTuplet)
      throw new EditError('The note does not fit into the measure');
    v.items = putEvent(
      v.items as Item[],
      tick,
      { kind: 'note', dur: { ...dur }, pitches: [np] },
      o.descend ?? true,
    ) as Draft<Item>[];
  });
}

export function enterRest(score: Score, loc: Loc, tick: number, dur: Dur, descend = true): Score {
  return edit(score, (d) => {
    const v = voiceIn(d, loc, true);
    if (
      tick + baseTicks(dur) > measureTicks(timeAt(d as Score, loc.mi)) &&
      !eventAtTick(v.items as Item[], tick)?.inTuplet
    )
      throw new EditError('The rest does not fit into the measure');
    v.items = putEvent(v.items as Item[], tick, rest(dur), descend) as Draft<Item>[];
  });
}

/** Notes become rests of the same value (a chord pitch `pi` is removed instead). */
export function deleteEvents(score: Score, addrs: (EvAddr & { pi?: number })[]): Score {
  return edit(score, (d) => {
    for (const a of addrs) {
      const e = eventIn(d, a);
      if (e.kind !== 'note') continue;
      if (a.pi !== undefined && e.pitches.length > 1) {
        e.pitches.splice(a.pi, 1);
        continue;
      }
      replaceInPlace(voiceIn(d, a), e as Event, toRest(e));
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
    if (te.start + baseTicks(dur) > measureTicks(timeAt(d as Score, a.mi)))
      throw new EditError('The note does not fit into the measure');
    const copy = JSON.parse(JSON.stringify(te.ev)) as Event;
    copy.dur = { ...dur };
    // A whole-measure rest given a shorter value becomes an ordinary rest; `putEvent` fills the rest of
    // the bar with more rests.
    if (copy.kind === 'rest' && copy.style === 'measure' && baseTicks(dur) !== measureTicks(timeAt(d as Score, a.mi)))
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
export function updateNotes(score: Score, addrs: EvAddr[], fn: (e: Draft<NoteEvent>) => void): Score {
  return updateEvents(score, addrs, (e) => {
    if (e.kind === 'note') fn(e);
  });
}

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

export function toggleArticulation(score: Score, addrs: EvAddr[], art: Articulation): Score {
  return updateNotes(score, addrs, (n) => {
    const cur = n.art ?? [];
    const on = !addrs.every((a) => {
      const e = flattenEv(score, a);
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
function flattenEv(score: Score, a: EvAddr): Event | undefined {
  const v = voiceOf(score, a);
  return v ? flattenVoice(v)[a.idx]?.ev : undefined;
}

// ------------------------------------------------------------------ slurs

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

export function removeSlur(score: Score, from: EvAddr, id: number): Score {
  return edit(score, (d) => {
    const e = eventIn(d, from);
    if (e.slurStart) {
      const k = e.slurStart.filter((s) => s.id !== id);
      if (k.length) e.slurStart = k;
      else delete e.slurStart;
    }
  }); // the matching stop is removed by tidy()
}

export function setSlurSide(score: Score, from: EvAddr, id: number, side: 'above' | 'below' | undefined): Score {
  return updateEvents(score, [from], (e) => {
    const s = e.slurStart?.find((x) => x.id === id);
    if (s) {
      if (side) s.side = side;
      else delete s.side;
    }
  });
}

// ------------------------------------------------------------------ marks

/** Hang a mark on the event `at` (the one under the cursor); a dynamic, tempo or clef replaces its kind already there. */
export function addMark(score: Score, at: EvAddr, body: MarkBody): Score {
  return edit(score, (d) => {
    hang(d, at, body);
  });
}
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

export function updateMark(
  score: Score,
  a: MarkAddr,
  patch: Partial<MarkBody> | ((m: Draft<MarkBody>) => void),
): Score {
  return edit(score, (d) => {
    const m = markList(d, a)?.[a.k];
    if (!m) throw new EditError('No such mark');
    if (typeof patch === 'function') patch(m);
    else Object.assign(m, patch);
    for (const k of Object.keys(m))
      if ((m as Record<string, unknown>)[k] === undefined) delete (m as Record<string, unknown>)[k];
  });
}

/** Remove a mark; the start of a hairpin takes its end with it. */
export function removeMark(score: Score, a: MarkAddr): Score {
  return removeMarks(score, [a]);
}
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

export type SpanKind = 'cresc' | 'dim' | 'pedal' | '8va' | '8vb';

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

// ------------------------------------------------------------------ tuplets

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

// ------------------------------------------------------------------ measures and score

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

function emptyMeasure(score: Score, at: number): Score['measures'][number] {
  const len = measureTicks(timeAt(score, Math.max(0, Math.min(at, score.measures.length - 1))));
  return {
    staves: Object.fromEntries(score.staves.map((s) => [s.id, { voices: [{ id: 1, items: measureRest(len) }] }])),
  };
}

export function insertMeasures(score: Score, at: number, count = 1): Score {
  return edit(score, (d) => {
    const fresh = Array.from({ length: count }, () => emptyMeasure(score, Math.max(at - 1, 0)));
    d.measures.splice(at, 0, ...(fresh as Draft<Score['measures'][number]>[]));
    if (at === 0 && d.measures.length > count && d.measures[count].time) {
      // the new first measure carries the time and key
      d.measures[0].time = d.measures[count].time;
      if (d.measures[count].key !== undefined) d.measures[0].key = d.measures[count].key;
    }
  });
}

export function deleteMeasures(score: Score, from: number, to: number): Score {
  if (to - from + 1 >= score.measures.length) throw new EditError('A score needs at least one measure');
  return edit(score, (d) => {
    const gone = d.measures.splice(from, to - from + 1);
    const next = d.measures[from];
    if (next) {
      // keep time/key changes that were in force
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
    for (let mi = 0; mi < d.measures.length; mi++) refit(d, mi, measureTicks(timeAt(d as Score, mi)));
  });
}

export function setTimeSig(score: Score, mi: number, ts: TimeSig | undefined): Score {
  if (ts && (ts.beats < 1 || ![1, 2, 4, 8, 16, 32].includes(ts.beatType)))
    throw new EditError('Invalid time signature');
  return edit(score, (d) => {
    if (mi === 0 && !ts) throw new EditError('The first measure needs a time signature');
    if (ts) d.measures[mi].time = { ...ts };
    else delete d.measures[mi].time;
    for (let m = mi; m < d.measures.length; m++) {
      if (m > mi && d.measures[m].time) break;
      refit(d, m, measureTicks(timeAt(d as Score, m)));
    }
  });
}

export function setKeySig(score: Score, mi: number, fifths: number | undefined): Score {
  return edit(score, (d) => {
    if (fifths === undefined && mi > 0) delete d.measures[mi].key;
    else d.measures[mi].key = fifths ?? 0;
  });
}
export function setBarline(score: Score, mi: number, b: 'single' | 'double' | 'final' | undefined): Score {
  return edit(score, (d) => {
    if (!b || b === 'single') delete d.measures[mi].barline;
    else d.measures[mi].barline = b;
  });
}
export function setBreak(score: Score, mi: number, b: 'system' | 'page' | undefined): Score {
  return edit(score, (d) => {
    if (b) d.measures[mi].breakBefore = b;
    else delete d.measures[mi].breakBefore;
  });
}
export function setStaffClef(score: Score, staff: string, clef: Clef): Score {
  return edit(score, (d) => {
    const s = d.staves.find((x) => x.id === staff);
    if (s) s.clef = { ...clef };
  });
}
export function setMeta(score: Score, patch: Partial<Score['meta']>): Score {
  return edit(score, (d) => {
    for (const [k, v] of Object.entries(patch)) {
      if (v) (d.meta as Record<string, string>)[k] = v;
      else delete (d.meta as Record<string, string>)[k];
    }
  });
}

// ------------------------------------------------------------------ staves

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
export function addStaff(score: Score, o: { clef: Clef; name?: string; at?: number }): Score {
  return edit(score, (d) => {
    let n = d.staves.length + 1;
    while (d.staves.some((s) => s.id === `s${n}`)) n++;
    const id = `s${n}`;
    const at = Math.max(0, Math.min(o.at ?? d.staves.length, d.staves.length));
    const conn = connections(score);
    d.staves.splice(at, 0, { id, clef: { ...o.clef }, ...(o.name ? { name: o.name } : {}) });
    // Inserting between two joined staves splits the join: both neighbouring connections become
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
      m.staves[id] = { voices: [{ id: 1, items: measureRest(measureTicks(timeAt(d as Score, mi))) as Draft<Item>[] }] };
    });
  });
}

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

/** Swap a staff with its neighbour; the joins stay where they are (between the same two positions). */
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
  const withNew = addStaff(score, { clef: src.clef, ...(src.name ? { name: src.name } : {}), at: i + 1 });
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
  staves: { clef: Clef; name?: string }[];
  join?: 'brace' | 'bracket';
}
export const INSTRUMENTS: InstrumentPreset[] = [
  { key: 'treble', label: 'Treble staff', staves: [{ clef: G }] },
  { key: 'bass', label: 'Bass staff', staves: [{ clef: F }] },
  {
    key: 'piano',
    label: 'Piano (grand staff)',
    staves: [
      { clef: G, name: 'Piano' },
      { clef: F, name: 'Piano' },
    ],
    join: 'brace',
  },
  { key: 'voice', label: 'Voice', staves: [{ clef: G, name: 'Voice' }] },
  { key: 'violin', label: 'Violin', staves: [{ clef: G, name: 'Violin' }] },
  { key: 'viola', label: 'Viola', staves: [{ clef: C3, name: 'Viola' }] },
  { key: 'cello', label: 'Cello', staves: [{ clef: F, name: 'Cello' }] },
  {
    key: 'satb',
    label: 'SATB choir',
    staves: [
      { clef: G, name: 'Soprano' },
      { clef: G, name: 'Alto' },
      { clef: G8, name: 'Tenor' },
      { clef: F, name: 'Bass' },
    ],
    join: 'bracket',
  },
  {
    key: 'quartet',
    label: 'String quartet',
    staves: [
      { clef: G, name: 'Violin I' },
      { clef: G, name: 'Violin II' },
      { clef: C3, name: 'Viola' },
      { clef: F, name: 'Cello' },
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
    sc = addStaff(sc, { clef: st.clef, name: st.name, at: base + k });
  });
  if (p.join) for (let k = 0; k + 1 < p.staves.length; k++) sc = setConnection(sc, base + k, p.join);
  return sc;
}

export function setStaffName(score: Score, id: string, name: string): Score {
  return edit(score, (d) => {
    const s = d.staves.find((x) => x.id === id);
    if (s) {
      if (name) s.name = name;
      else delete s.name;
    }
  });
}

export function setMeasureNumbers(score: Score, mode: 'all' | 'none' | undefined): Score {
  return edit(score, (d) => {
    if (mode) d.page.measureNumbers = mode;
    else delete d.page.measureNumbers;
  });
}

export function setPage(score: Score, patch: Partial<Score['page']>): Score {
  return edit(score, (d) => {
    Object.assign(d.page, patch);
  });
}

/** Remove a (non-first) voice that holds nothing but rests. */
export function removeVoice(score: Score, loc: Loc): Score {
  return edit(score, (d) => {
    const sm = staffMeasure(d, loc.mi, loc.staff);
    if (loc.voice === 1) {
      const v = sm.voices.find((x) => x.id === 1);
      if (v) v.items = measureRest(measureTicks(timeAt(d as Score, loc.mi))) as Draft<Item>[];
      return;
    }
    sm.voices = sm.voices.filter((v) => v.id !== loc.voice);
  });
}

/** Paste events (as copied from a voice) one after another from `tick`; slur flags are not carried over. */
export function pasteEvents(score: Score, loc: Loc, tick: number, evs: Event[]): Score {
  return edit(score, (d) => {
    const v = voiceIn(d, loc, true);
    const len = measureTicks(timeAt(d as Score, loc.mi));
    let t = tick;
    for (const e of evs) {
      const c = JSON.parse(JSON.stringify(e)) as Event;
      delete c.slurStart;
      delete c.slurStop;
      delete c.staff;
      delete c.marks;
      const w = baseTicks(c.dur);
      if (t + w > len) {
        if (t === tick) throw new EditError('Does not fit into the measure');
        break;
      }
      v.items = putEvent(v.items as Item[], t, c) as Draft<Item>[];
      t += w;
    }
  });
}

// ------------------------------------------------------------------ beams and tremolos

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
    // notes, and anything longer is refused (the user must ungroup first).
    const inBeam = (items: Draft<Item>[]): boolean => {
      for (let i = 0; i < items.length; i++) {
        const it = items[i] as Item;
        if (isEvent(it)) continue;
        if (isBeam(it)) {
          const evs = flattenVoice({ id: 0, items: it.items }).map((t) => t.ev as unknown);
          if (!(evs.includes(ea as unknown) || evs.includes(eb as unknown))) continue;
          if (evs.length !== 2 || !evs.includes(ea as unknown) || !evs.includes(eb as unknown))
            throw new EditError('Notes in a longer beam group cannot become a tremolo: ungroup them first');
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
