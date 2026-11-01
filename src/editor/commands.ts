// Edit commands: pure `Score -> Score` functions (Immer), each leaving every voice exactly as long as its measure.
// Failures throw EditError with a message fit for the user; the score is then unchanged.
import { produce, type Draft } from 'immer';
import {
  PPQ, baseTicks, flattenVoice, isBeam, isEvent, isTremolo, isTuplet, measureTicks, timeAt,
  type Clef, type Dur, type Event, type Item, type Mark, type MarkBody, type NoteEvent, type NotePitch, type Pitch, type Score, type StaffMeasure,
  type TimeSig, type TupletGroup, type Voice, type Articulation,
} from '../model.ts';
import { EditError, durOfTicks, eventAtTick, itemsTicks, itemTicks, putEvent, rest, restsFor, splitTicks } from './voice.ts';
import { comparePitch, transposeSemis, transposeSteps } from './context.ts';
import { voiceOf, type EvAddr, type MarkAddr } from './addr.ts';

export { EditError };

export interface Loc { mi: number; staff: string; voice: number }

// ------------------------------------------------------------------ plumbing

function edit(score: Score, fn: (d: Draft<Score>) => void): Score {
  const next = produce(score, fn);
  if (next === score) return next;
  // only what the edit touched needs tidying (a whole score is hundreds of measures)
  const only = new Set<number>();
  const n = Math.max(next.measures.length, score.measures.length);
  for (let i = 0; i < n; i++) if (next.measures[i] !== score.measures[i]) only.add(i);
  if (next.measures.length !== score.measures.length) return produce(next, (d) => { tidy(d as Score); });
  return produce(next, (d) => { tidy(d as Score, only); });
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
  return (m.staves[staff] ??= { voices: [], marks: [] });
}

function voiceIn(d: Draft<Score>, loc: Loc, create = false): Draft<Voice> {
  const sm = staffMeasure(d, loc.mi, loc.staff);
  let v = sm.voices.find((x) => x.id === loc.voice);
  if (!v) {
    if (!create) throw new EditError('No such voice');
    sm.voices.push({ id: loc.voice, items: measureRest(measureTicks(timeAt(d as Score, loc.mi))) });
    sm.voices.sort((a, b) => a.id - b.id);
    v = sm.voices.find((x) => x.id === loc.voice)!;
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
  const norm = (items: Item[]): Item[] | undefined => {
    let changed = false;
    const out: Item[] = [];
    for (const it of items) {
      if (isEvent(it)) { out.push(it); continue; }
      const sub = norm(it.items);
      const kids = sub ?? it.items;
      let it2: Item = it;
      if (sub) { it2 = { ...it, items: sub } as Item; changed = true; }
      const notes = flattenVoice({ id: 0, items: kids }).filter((t) => t.ev.kind === 'note').length;
      const all = flattenVoice({ id: 0, items: kids }).length;
      if ((isBeam(it2) && notes < 2) || (isTremolo(it2) && (notes !== 2 || all !== 2))) { out.push(...kids); changed = true; } else out.push(it2);
    }
    return changed ? out : undefined;
  };
  const voicesTouched = new Set<string>();
  d.measures.forEach((m, mi) => {
    if (only && !only.has(mi)) return;
    for (const [sid, sm] of Object.entries(m.staves)) for (const v of sm.voices) {
      voicesTouched.add(`${sid}|${v.id}`);
      const n = norm(v.items);
      if (n) v.items = n;
    }
  });
  // slurs: per staff and voice, in time order
  for (const st of d.staves) {
    const voices = new Set<number>();
    for (const m of d.measures) for (const v of m.staves[st.id]?.voices ?? []) voices.add(v.id);
    for (const vid of voices) {
      if (only && !voicesTouched.has(`${st.id}|${vid}`)) continue;
      const open = new Set<number>();
      const evs: Event[] = [];
      for (const m of d.measures) { const v = m.staves[st.id]?.voices.find((x) => x.id === vid); if (v) for (const te of flattenVoice(v)) evs.push(te.ev); }
      for (const e of evs) {
        if (e.slurStop) {
          const keep = e.slurStop.filter((id) => open.has(id));
          for (const id of keep) open.delete(id);
          if (keep.length !== e.slurStop.length) { if (keep.length) e.slurStop = keep; else delete e.slurStop; }
        }
        for (const s of e.slurStart ?? []) open.add(s.id);
      }
      if (open.size) for (const e of evs) if (e.slurStart?.some((s) => open.has(s.id))) {
        const keep = e.slurStart.filter((s) => !open.has(s.id));
        if (keep.length) e.slurStart = keep; else delete e.slurStart;
      }
    }
  }
}

const sortMarks = (marks: Mark[]): void => { marks.sort((a, b) => a.tick - b.tick); };

// ------------------------------------------------------------------ notes and rests

function insertPitch(n: Draft<NoteEvent>, p: NotePitch): void {
  n.pitches.push(p);
  n.pitches.sort((a, b) => comparePitch(a.pitch, b.pitch));
}

function toRest(e: Draft<Event>): Event {
  return { kind: 'rest', style: 'normal', dur: { ...e.dur } };
}
function replaceInPlace(v: Draft<Voice>, target: Event, repl: Event): void {
  const walk = (items: Draft<Item>[]): boolean => {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it === (target as unknown)) { items[i] = repl as Draft<Item>; return true; }
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
export function enterNote(score: Score, loc: Loc, tick: number, dur: Dur, pitch: Pitch, o: { chord?: boolean; descend?: boolean; acc?: 'force' | 'cautionary' } = {}): Score {
  return edit(score, (d) => {
    const v = voiceIn(d, loc, true);
    const at = eventAtTick(v.items as Item[], tick);
    const np: NotePitch = { pitch: { ...pitch } };
    if (o.acc) np.acc = o.acc;
    if (o.chord && at && at.start === tick && at.ev.kind === 'note') {
      const n = at.ev as Draft<NoteEvent>;
      const i = n.pitches.findIndex((x) => comparePitch(x.pitch, pitch) === 0);
      if (i >= 0) {
        if (n.pitches.length > 1) n.pitches.splice(i, 1); else replaceInPlace(v, at.ev, toRest(n));
      } else insertPitch(n, np);
      return;
    }
    if (tick + baseTicks(dur) > measureTicks(timeAt(d as Score, loc.mi)) && !(at?.inTuplet)) throw new EditError('The note does not fit into the measure');
    v.items = putEvent(v.items as Item[], tick, { kind: 'note', dur: { ...dur }, pitches: [np] }, o.descend ?? true) as Draft<Item>[];
  });
}

export function enterRest(score: Score, loc: Loc, tick: number, dur: Dur, descend = true): Score {
  return edit(score, (d) => {
    const v = voiceIn(d, loc, true);
    if (tick + baseTicks(dur) > measureTicks(timeAt(d as Score, loc.mi)) && !eventAtTick(v.items as Item[], tick)?.inTuplet) throw new EditError('The rest does not fit into the measure');
    v.items = putEvent(v.items as Item[], tick, rest(dur), descend) as Draft<Item>[];
  });
}

/** Notes become rests of the same value (a chord pitch `pi` is removed instead). */
export function deleteEvents(score: Score, addrs: (EvAddr & { pi?: number })[]): Score {
  return edit(score, (d) => {
    for (const a of addrs) {
      const e = eventIn(d, a);
      if (e.kind !== 'note') continue;
      if (a.pi !== undefined && e.pitches.length > 1) { e.pitches.splice(a.pi, 1); continue; }
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
        v.items = putEvent(v.items as Item[], te.start, { ...(JSON.parse(JSON.stringify(e)) as Event), dur: { ...dur } }) as Draft<Item>[];
        return;
      }
      throw new EditError('Cannot change the duration inside a tremolo');
    }
    if (te.start + baseTicks(dur) > measureTicks(timeAt(d as Score, a.mi))) throw new EditError('The note does not fit into the measure');
    const copy = JSON.parse(JSON.stringify(te.ev)) as Event;
    copy.dur = { ...dur };
    v.items = putEvent(v.items as Item[], te.start, copy) as Draft<Item>[];
  });
}

export function updateEvents(score: Score, addrs: EvAddr[], fn: (e: Draft<Event>) => void): Score {
  return edit(score, (d) => { for (const a of addrs) fn(eventIn(d, a)); });
}
export function updateNotes(score: Score, addrs: EvAddr[], fn: (e: Draft<NoteEvent>) => void): Score {
  return updateEvents(score, addrs, (e) => { if (e.kind === 'note') fn(e); });
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
export function transpose(score: Score, targets: (EvAddr & { pi?: number })[], by: { semis?: number; steps?: number }): Score {
  return edit(score, (d) => {
    for (const t of targets) {
      const e = eventIn(d, t);
      if (e.kind !== 'note') continue;
      e.pitches.forEach((np, i) => {
        if (t.pi !== undefined && t.pi !== i) return;
        np.pitch = by.semis !== undefined ? transposeSemis(np.pitch, by.semis) : transposeSteps(np.pitch, by.steps ?? 0);
      });
      e.pitches.sort((x, y) => comparePitch(x.pitch, y.pitch));
    }
  });
}

/** Cross-staff: draw the event on another staff (undefined: back to its own). Pitches are kept. */
export function setStaffOf(score: Score, addrs: EvAddr[], staff: string | undefined): Score {
  return updateNotes(score, addrs, (n) => { if (staff === undefined || staff === addrs[0]?.staff) delete n.staff; else n.staff = staff; });
}

export function toggleTie(score: Score, addrs: (EvAddr & { pi?: number })[]): Score {
  return edit(score, (d) => {
    for (const a of addrs) {
      const e = eventIn(d, a);
      if (e.kind !== 'note') continue;
      const sel = e.pitches.filter((_, i) => a.pi === undefined || i === a.pi);
      const on = !sel.every((p) => p.tie);
      for (const p of sel) { if (on) p.tie = true; else delete p.tie; }
    }
  });
}

export function toggleArticulation(score: Score, addrs: EvAddr[], art: Articulation): Score {
  return updateNotes(score, addrs, (n) => {
    const cur = n.art ?? [];
    const on = !addrs.every((a) => { const e = flattenEv(score, a); return e?.kind === 'note' && e.art?.includes(art); });
    const next = on ? [...cur.filter((x) => x !== art), art] : cur.filter((x) => x !== art);
    if (next.length) n.art = next; else { delete n.art; delete n.artSide; }
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
    // number: the lowest not used by a slur overlapping the new one in this voice
    const evs: { e: Draft<Event>; k: number }[] = [];
    let k = 0, ka = -1, kb = -1;
    d.measures.forEach((m, mi) => {
      const v = m.staves[from.staff]?.voices.find((x) => x.id === from.voice);
      if (v) for (const te of flattenVoice(v as Voice)) {
        if (mi === from.mi && te.index === from.idx) ka = k;
        if (mi === to.mi && te.index === to.idx) kb = k;
        evs.push({ e: te.ev as Draft<Event>, k: k++ });
      }
    });
    if (ka < 0 || kb < 0) throw new EditError('No such note');
    if (ka > kb) [ka, kb] = [kb, ka];
    if (ka === kb) throw new EditError('A slur needs two different notes');
    const first = evs[ka].e, last = evs[kb].e;
    if (first.kind !== 'note' || last.kind !== 'note') throw new EditError('A slur starts and ends on notes');
    const spans: [number, number, number][] = [];
    const open = new Map<number, number>();
    for (const { e, k: kk } of evs) {
      for (const id of e.slurStop ?? []) { if (open.has(id)) { spans.push([open.get(id)!, kk, id]); open.delete(id); } }
      for (const s of e.slurStart ?? []) open.set(s.id, kk);
    }
    let id = 1;
    while (spans.some(([s0, s1, i]) => i === id && s0 <= kb && s1 >= ka)) id++;
    (first.slurStart ??= []).push(side ? { id, side } : { id });
    (last.slurStop ??= []).push(id);
  });
}

export function removeSlur(score: Score, from: EvAddr, id: number): Score {
  return edit(score, (d) => {
    const e = eventIn(d, from);
    if (e.slurStart) { const k = e.slurStart.filter((s) => s.id !== id); if (k.length) e.slurStart = k; else delete e.slurStart; }
  }); // the matching stop is removed by tidy()
}

export function setSlurSide(score: Score, from: EvAddr, id: number, side: 'above' | 'below' | undefined): Score {
  return updateEvents(score, [from], (e) => { const s = e.slurStart?.find((x) => x.id === id); if (s) { if (side) s.side = side; else delete s.side; } });
}

// ------------------------------------------------------------------ marks

export function addMark(score: Score, staff: string, mi: number, tick: number, body: MarkBody): Score {
  return edit(score, (d) => {
    const sm = staffMeasure(d, mi, staff);
    // one dynamic, tempo or clef per position
    if (body.type === 'dynamic' || body.type === 'tempo' || body.type === 'clef') {
      const i = sm.marks.findIndex((m) => m.type === body.type && m.tick === tick);
      if (i >= 0) sm.marks.splice(i, 1);
    }
    sm.marks.push({ ...body, tick } as Draft<Mark>);
    sortMarks(sm.marks as Mark[]);
  });
}

export function updateMark(score: Score, a: MarkAddr, patch: Partial<Mark> | ((m: Draft<Mark>) => void)): Score {
  return edit(score, (d) => {
    const m = staffMeasure(d, a.mi, a.staff).marks[a.i];
    if (!m) throw new EditError('No such mark');
    if (typeof patch === 'function') patch(m); else Object.assign(m, patch);
    for (const k of Object.keys(m)) if ((m as Record<string, unknown>)[k] === undefined) delete (m as Record<string, unknown>)[k];
  });
}

/** Remove a mark; the start of a hairpin takes its end with it. */
export function removeMark(score: Score, a: MarkAddr): Score {
  return edit(score, (d) => {
    const marks = staffMeasure(d, a.mi, a.staff).marks;
    const m = marks[a.i];
    if (!m) return;
    marks.splice(a.i, 1);
    if (m.type === 'hairpin') {
      for (let mi = a.mi; mi < d.measures.length; mi++) {
        const ms = d.measures[mi].staves[a.staff]?.marks;
        const j = ms?.findIndex((x) => x.type === 'stop' && x.of === 'hairpin' && x.id === m.id) ?? -1;
        if (j >= 0) { ms!.splice(j, 1); break; }
      }
    }
  });
}

export function moveMark(score: Score, a: MarkAddr, mi: number, tick: number): Score {
  return edit(score, (d) => {
    const from = staffMeasure(d, a.mi, a.staff).marks;
    const [m] = from.splice(a.i, 1);
    if (!m) return;
    m.tick = tick;
    const to = staffMeasure(d, mi, a.staff).marks;
    to.push(m);
    sortMarks(to as Mark[]);
  });
}

export type SpanKind = 'cresc' | 'dim' | 'pedal' | '8va' | '8vb';
/** A hairpin, pedal line or octave shift between two positions of a staff. */
export function addSpan(score: Score, staff: string, kind: SpanKind, a: { mi: number; tick: number }, b: { mi: number; tick: number }, placement?: 'above' | 'below'): Score {
  if (b.mi < a.mi || (b.mi === a.mi && b.tick <= a.tick)) throw new EditError('The end must come after the start');
  return edit(score, (d) => {
    let start: MarkBody, stop: MarkBody;
    if (kind === 'cresc' || kind === 'dim') {
      const used = new Set<number>();
      for (const m of d.measures) for (const mk of m.staves[staff]?.marks ?? []) if (mk.type === 'hairpin') used.add(mk.id);
      let id = 1; while (used.has(id)) id++;
      start = { type: 'hairpin', kind, id, ...(placement ? { placement } : {}) }; stop = { type: 'stop', of: 'hairpin', id };
    } else if (kind === 'pedal') { start = { type: 'pedal' }; stop = { type: 'stop', of: 'pedal' }; }
    else { start = { type: 'ottava', dir: kind === '8va' ? 'up' : 'down' }; stop = { type: 'stop', of: 'ottava' }; }
    for (const [pt, body] of [[a, start], [b, stop]] as const) {
      const sm = staffMeasure(d, pt.mi, staff);
      sm.marks.push({ ...body, tick: pt.tick } as Draft<Mark>);
      sortMarks(sm.marks as Mark[]);
    }
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
    const span = baseTicks(te.ev.dur); // at its own level
    const w = durOfTicks(span / normal);
    if (!w || !Number.isInteger(span / normal)) throw new EditError(`A ${actual}:${normal} tuplet does not fit this note value`);
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
    if ((it as unknown) === (target as unknown)) { items[i] = repl as Draft<Item>; return true; }
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
    // replace by the real span's worth of rests: simplest well-defined result
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
    if ((it as unknown) === (target as unknown)) { items.splice(i, 1, ...repl); return true; }
    if (!isEvent(it as Item) && spliceItem((it as Draft<TupletGroup>).items, target, repl)) return true;
  }
  return false;
}

export function updateTuplet(score: Score, a: EvAddr & { depth: number }, patch: Partial<Pick<TupletGroup, 'bracket' | 'number' | 'label' | 'placement'>>): Score {
  return edit(score, (d) => {
    const g = flattenVoice(voiceIn(d, a) as Voice)[a.idx]?.tuplets[a.depth] as Draft<TupletGroup> | undefined;
    if (!g) throw new EditError('No such tuplet');
    for (const [k, val] of Object.entries(patch)) { if (val === undefined) delete (g as Record<string, unknown>)[k]; else (g as Record<string, unknown>)[k] = val; }
  });
}

// ------------------------------------------------------------------ measures and score

/** Fit every voice of measure `mi` to `len` ticks: pad with rests or cut. */
function refit(d: Draft<Score>, mi: number, len: number): void {
  for (const sm of Object.values(d.measures[mi].staves)) for (const v of sm.voices) {
    const total = itemsTicks(v.items as Item[]);
    if (total === len) continue;
    const only = (v.items as Item[]).length === 1 && isEvent((v.items as Item[])[0]) && ((v.items as Item[])[0] as Event).kind === 'rest' && ((v.items as Item[])[0] as { style: string }).style === 'measure';
    if (only) { v.items = measureRest(len) as Draft<Item>[]; continue; }
    if (total < len) { v.items = [...(v.items as Item[]), ...restsFor(len - total, total)] as Draft<Item>[]; continue; }
    try { v.items = putEvent(v.items as Item[], len, rest({ base: 64, dots: 0 }), false).slice() as Draft<Item>[]; void 0; }
    catch { /* fall through to the blunt cut */ }
    if (itemsTicks(v.items as Item[]) !== len) v.items = measureRest(len) as Draft<Item>[];
  }
}

function emptyMeasure(score: Score, at: number): Score['measures'][number] {
  const len = measureTicks(timeAt(score, Math.max(0, Math.min(at, score.measures.length - 1))));
  return { staves: Object.fromEntries(score.staves.map((s) => [s.id, { voices: [{ id: 1, items: measureRest(len) }], marks: [] }])) };
}

export function insertMeasures(score: Score, at: number, count = 1): Score {
  return edit(score, (d) => {
    const fresh = Array.from({ length: count }, () => emptyMeasure(score, at - 1 >= 0 ? at - 1 : 0));
    d.measures.splice(at, 0, ...(fresh as Draft<Score['measures'][number]>[]));
    if (at === 0 && d.measures.length > count && d.measures[count].time) { // the new first measure carries the time and key
      d.measures[0].time = d.measures[count].time; if (d.measures[count].key !== undefined) d.measures[0].key = d.measures[count].key;
    }
  });
}

export function deleteMeasures(score: Score, from: number, to: number): Score {
  if (to - from + 1 >= score.measures.length) throw new EditError('A score needs at least one measure');
  return edit(score, (d) => {
    const gone = d.measures.splice(from, to - from + 1);
    const next = d.measures[from];
    if (next) { // keep time/key changes that were in force
      const t = gone.map((m) => m.time).filter(Boolean).pop(), k = gone.map((m) => m.key).filter((x) => x !== undefined).pop();
      if (t && !next.time) next.time = t;
      if (k !== undefined && next.key === undefined) next.key = k;
    }
    if (from === 0 && !d.measures[0].time) d.measures[0].time = gone[0].time ?? { beats: 4, beatType: 4 };
    // a measure that lost its time change: lengths may differ now
    d.measures.forEach((_, mi) => refit(d, mi, measureTicks(timeAt(d as Score, mi))));
  });
}

export function setTimeSig(score: Score, mi: number, ts: TimeSig | undefined): Score {
  if (ts && (ts.beats < 1 || ![1, 2, 4, 8, 16, 32].includes(ts.beatType))) throw new EditError('Invalid time signature');
  return edit(score, (d) => {
    if (mi === 0 && !ts) throw new EditError('The first measure needs a time signature');
    if (ts) d.measures[mi].time = { ...ts }; else delete d.measures[mi].time;
    for (let m = mi; m < d.measures.length; m++) {
      if (m > mi && d.measures[m].time) break;
      refit(d, m, measureTicks(timeAt(d as Score, m)));
    }
  });
}

export function setKeySig(score: Score, mi: number, fifths: number | undefined): Score {
  return edit(score, (d) => { if (fifths === undefined && mi > 0) delete d.measures[mi].key; else d.measures[mi].key = fifths ?? 0; });
}
export function setBarline(score: Score, mi: number, b: 'single' | 'double' | 'final' | undefined): Score {
  return edit(score, (d) => { if (!b || b === 'single') delete d.measures[mi].barline; else d.measures[mi].barline = b; });
}
export function setBreak(score: Score, mi: number, b: 'system' | 'page' | undefined): Score {
  return edit(score, (d) => { if (b) d.measures[mi].breakBefore = b; else delete d.measures[mi].breakBefore; });
}
export function setStaffClef(score: Score, staff: string, clef: Clef): Score {
  return edit(score, (d) => { const s = d.staves.find((x) => x.id === staff); if (s) s.clef = { ...clef }; });
}
export function setMeta(score: Score, patch: Partial<Score['meta']>): Score {
  return edit(score, (d) => { for (const [k, v] of Object.entries(patch)) { if (v) (d.meta as Record<string, string>)[k] = v; else delete (d.meta as Record<string, string>)[k]; } });
}
// ------------------------------------------------------------------ staves

export type Connection = 'brace' | 'bracket' | undefined;
/** Which kind of group joins staff i with staff i+1 (the natural way to edit groups). */
export function connections(score: Score): Connection[] {
  const ids = score.staves.map((s) => s.id);
  const out: Connection[] = ids.slice(1).map(() => undefined);
  for (const g of score.groups) {
    const idx = g.staves.map((id) => ids.indexOf(id)).filter((i) => i >= 0).sort((a, b) => a - b);
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
    d.groups = groupsFrom(d.staves.map((s) => s.id), conn) as Draft<Score['groups']>;
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
    // inserting between two joined staves splits the join
    const nc = [...conn.slice(0, Math.max(0, at - 1)), ...(at > 0 && at < score.staves.length ? [undefined, undefined] : at > 0 ? [undefined] : [undefined]), ...conn.slice(at)];
    d.groups = groupsFrom(d.staves.map((s) => s.id), nc.slice(0, d.staves.length - 1)) as Draft<Score['groups']>;
    d.measures.forEach((m, mi) => { m.staves[id] = { voices: [{ id: 1, items: measureRest(measureTicks(timeAt(d as Score, mi))) as Draft<Item>[] }], marks: [] }; });
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
    const nc = [...conn.slice(0, Math.max(0, i - 1)), ...(i > 0 && i < score.staves.length - 1 ? [merged] : []), ...conn.slice(i + 1)];
    d.groups = groupsFrom(d.staves.map((s) => s.id), nc) as Draft<Score['groups']>;
    for (const m of d.measures) {
      delete m.staves[id];
      for (const sm of Object.values(m.staves)) for (const v of sm.voices) for (const te of flattenVoice(v as Voice)) if (te.ev.kind === 'note' && te.ev.staff === id) delete (te.ev as Draft<NoteEvent>).staff;
    }
  });
}

/** Swap a staff with its neighbour; the joins stay where they are (between the same two positions). */
export function moveStaff(score: Score, id: string, dir: -1 | 1): Score {
  const i = score.staves.findIndex((s) => s.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= score.staves.length) return score;
  return edit(score, (d) => {
    const conn = connections(score);
    [d.staves[i], d.staves[j]] = [d.staves[j], d.staves[i]];
    d.groups = groupsFrom(d.staves.map((s) => s.id), conn) as Draft<Score['groups']>;
  });
}

export function setStaffName(score: Score, id: string, name: string): Score {
  return edit(score, (d) => { const s = d.staves.find((x) => x.id === id); if (s) { if (name) s.name = name; else delete s.name; } });
}

export function setMeasureNumbers(score: Score, mode: 'all' | 'none' | undefined): Score {
  return edit(score, (d) => { if (mode) d.page.measureNumbers = mode; else delete d.page.measureNumbers; });
}

export function setPage(score: Score, patch: Partial<Score['page']>): Score {
  return edit(score, (d) => { Object.assign(d.page, patch); });
}

/** Remove a (non-first) voice that holds nothing but rests. */
export function removeVoice(score: Score, loc: Loc): Score {
  return edit(score, (d) => {
    const sm = staffMeasure(d, loc.mi, loc.staff);
    if (loc.voice === 1) { const v = sm.voices.find((x) => x.id === 1); if (v) v.items = measureRest(measureTicks(timeAt(d as Score, loc.mi))) as Draft<Item>[]; return; }
    sm.voices = sm.voices.filter((v) => v.id !== loc.voice);
  });
}

void PPQ; void isTuplet; void itemTicks;

/** Paste events (as copied from a voice) one after another from `tick`; slur flags are not carried over. */
export function pasteEvents(score: Score, loc: Loc, tick: number, evs: Event[]): Score {
  return edit(score, (d) => {
    const v = voiceIn(d, loc, true);
    const len = measureTicks(timeAt(d as Score, loc.mi));
    let t = tick;
    for (const e of evs) {
      const c = JSON.parse(JSON.stringify(e)) as Event;
      delete c.slurStart; delete c.slurStop; delete c.staff;
      const w = baseTicks(c.dur);
      if (t + w > len) { if (t === tick) throw new EditError('Does not fit into the measure'); break; }
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
  const ea = flat[a]?.ev, eb = flat[b]?.ev;
  if (!ea || !eb) throw new EditError('No such note');
  const find = (items: Draft<Item>[]): boolean => {
    const ia = items.findIndex((x) => (x as unknown) === (ea as unknown)), ib = items.findIndex((x) => (x as unknown) === (eb as unknown));
    if (ia >= 0 && ib >= 0) { const grp = make(items.slice(ia, ib + 1) as Item[]); items.splice(ia, ib - ia + 1, grp as Draft<Item>); return true; }
    for (const it of items) if (!isEvent(it as Item) && find((it as Draft<TupletGroup>).items)) return true;
    return false;
  };
  if (!find(v.items as Draft<Item>[])) throw new EditError('These notes are not in the same group: select notes in one beat or one tuplet');
}

/** Beam the selected run of notes together, whatever the automatic rules say. */
export function makeBeam(score: Score, loc: Loc, from: number, to: number): Score {
  return edit(score, (d) => wrapRange(d, loc, from, to, (items) => ({ kind: 'beam', items })));
}
/** Two-note tremolo with `beams` beams between exactly two notes. */
export function makeTremolo(score: Score, loc: Loc, from: number, to: number, beams = 2): Score {
  if (to - from !== 1) throw new EditError('A tremolo joins exactly two notes');
  return edit(score, (d) => wrapRange(d, loc, from, to, (items) => ({ kind: 'tremolo', beams, items })));
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
        if ((isBeam(it) || isTremolo(it)) && flattenVoice({ id: 0, items: it.items }).some((t) => (t.ev as unknown) === (target as unknown))) { items.splice(i, 1, ...((it.items as unknown) as Draft<Item>[])); return true; }
        if (walk((it as Draft<TupletGroup>).items)) return true;
      }
      return false;
    };
    if (!walk(v.items as Draft<Item>[])) throw new EditError('Not in a beam group or tremolo');
  });
}
