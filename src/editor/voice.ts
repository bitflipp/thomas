// Editing the item tree of a voice: put an event at a tick (overwriting what is there), fill gaps with rests.
// All functions work on plain objects or Immer drafts and return new item lists; they never leave a voice too short or long.
import { baseTicks, isEvent, isTuplet, isBeam, type Dur, type BaseDur, type Event, type Item, type RestEvent, type TupletGroup } from '../model.ts';

export class EditError extends Error {}

const BASES: BaseDur[] = [1, 2, 4, 8, 16, 32, 64];
const CANDS = BASES.flatMap((base) => [0, 1].map((dots) => ({ dur: { base, dots } as Dur, ticks: baseTicks({ base, dots }) }))).sort((a, b) => b.ticks - a.ticks);

export function durOfTicks(t: number): Dur | undefined { return CANDS.find((c) => c.ticks === t)?.dur; }

/** Decompose a span into legal durations, largest first, keeping each aligned to its own length where possible. */
export function splitTicks(ticks: number, start = 0): Dur[] {
  const out: Dur[] = [];
  let pos = start, rem = ticks;
  while (rem > 0) {
    const u = (c: (typeof CANDS)[number]) => baseTicks({ base: c.dur.base, dots: 0 });
    // a dotted value must start on a multiple of twice its undotted length (a dotted quarter on a beat pair, not off-beat)
    const pick = CANDS.find((c) => c.ticks <= rem && pos % (c.dur.dots ? 2 * u(c) : u(c)) === 0) ?? CANDS.find((c) => c.ticks <= rem && !c.dur.dots);
    if (!pick) throw new EditError('That span cannot be written as note values');
    out.push({ ...pick.dur }); pos += pick.ticks; rem -= pick.ticks;
  }
  return out;
}

export const rest = (dur: Dur): RestEvent => ({ kind: 'rest', style: 'normal', dur: { ...dur } });
export const restsFor = (ticks: number, start: number): RestEvent[] => splitTicks(ticks, start).map(rest);

/** Ticks of an item as written at its own level (tuplet contents are in written ticks, the tuplet itself is scaled). */
export function itemTicks(it: Item): number {
  if (isEvent(it)) return baseTicks(it.dur);
  const inner = it.items.reduce((a, x) => a + itemTicks(x), 0);
  return isTuplet(it) ? (inner * it.normal) / it.actual : inner;
}
export const itemsTicks = (items: Item[]): number => items.reduce((a, x) => a + itemTicks(x), 0);

/** The pieces of event `e` (which spans [a, b)) that remain over [from, to): rests, except the head of a note which stays a (tied) note. */
function pieces(e: Event, a: number, from: number, to: number, head: boolean): Event[] {
  if (e.kind === 'rest' || !head) return restsFor(to - from, from);
  const durs = splitTicks(to - from, from);
  return durs.map((d, i) => {
    const n = { ...e, dur: d, pitches: e.pitches.map((p) => ({ ...p, tie: i < durs.length - 1 ? true : undefined })) };
    if (i > 0) { delete n.marks; delete n.slurStart; delete n.art; delete n.artSide; delete n.arpeggio; delete n.graces; delete n.stem; }
    if (i < durs.length - 1) delete n.slurStop;
    for (const p of n.pitches) if (p.tie === undefined) delete p.tie;
    void a;
    return n;
  });
}

/** Replace [t0, t1) at one level by `insert`; what sticks out of the range on either side becomes rests (note heads stay notes). */
export function overwrite(items: Item[], t0: number, t1: number, insert: Item[]): Item[] {
  const flat: Item[] = [];
  let pos = 0;
  for (const it of items) { // explicit beam groups touched by the edit dissolve (the automatic beaming applies)
    const len = itemTicks(it);
    if (isBeam(it) && pos < t1 && pos + len > t0) flat.push(...it.items); else flat.push(it);
    pos += len;
  }
  const out: Item[] = [];
  let placed = false;
  pos = 0;
  for (const it of flat) {
    const len = itemTicks(it), a = pos, b = pos + len;
    pos = b;
    if (b <= t0) { out.push(it); continue; }
    if (a >= t1) { if (!placed) { out.push(...insert); placed = true; } out.push(it); continue; }
    // what hangs on the event that starts where the new one goes stays with the new one
    if (isEvent(it) && a === t0 && it.marks?.length && isEvent(insert[0]) && !insert[0].marks) insert[0] = { ...insert[0], marks: it.marks.map((m) => JSON.parse(JSON.stringify(m))) };
    if (!isEvent(it)) {
      if (a >= t0 && b <= t1) continue; // fully replaced
      throw new EditError('That would cut through a tuplet or tremolo (hold Alt to replace it as a whole)');
    }
    if (a < t0) out.push(...pieces(it, a, a, t0, true));
    if (!placed) { out.push(...insert); placed = true; }
    if (b > t1) out.push(...pieces(it, a, t1, b, false));
  }
  if (!placed) out.push(...insert);
  return out;
}

/**
 * Put `ev` (its `dur` is the written value at the level where it lands) at `tick` of the voice.
 * A tick inside a tuplet descends into it, unless `descend` is false (then the tuplet is replaced like any other item).
 */
export function putEvent(items: Item[], tick: number, ev: Event, descend = true): Item[] {
  let pos = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const len = itemTicks(it), a = pos;
    pos += len;
    if (isEvent(it) || tick < a || tick >= a + len) continue;
    if (isBeam(it)) { const un = [...items.slice(0, i), ...it.items, ...items.slice(i + 1)]; return putEvent(un, tick, ev, descend); }
    if (isTuplet(it) && descend) {
      const inner = ((tick - a) * it.actual) / it.normal;
      if (!Number.isInteger(inner)) throw new EditError('Not on a position of the tuplet');
      const total = itemsTicks(it.items);
      if (inner + baseTicks(ev.dur) > total) throw new EditError('Does not fit in the tuplet (hold Alt to replace the tuplet)');
      const sub = putEvent(it.items, inner, ev, true);
      const nt: TupletGroup = { ...it, items: sub };
      return [...items.slice(0, i), nt, ...items.slice(i + 1)];
    }
    if (!isTuplet(it) && !isBeam(it)) throw new EditError('Tremolo: remove it first to change its notes');
  }
  return overwrite(items, tick, tick + baseTicks(ev.dur), [ev]);
}

/** The deepest list of items in which an event starts at `tick`, with its index there: used to edit that event in place. */
export function eventAtTick(items: Item[], tick: number): { ev: Event; start: number; ticks: number; inTuplet: boolean } | undefined {
  let pos = 0;
  const walk = (list: Item[], base: number, k: number, inT: boolean): ReturnType<typeof eventAtTick> => {
    let p = 0;
    for (const it of list) {
      if (isEvent(it)) {
        const t = (baseTicks(it.dur) * k);
        if (tick >= base + p * k && tick < base + p * k + t) return { ev: it, start: base + p * k, ticks: t, inTuplet: inT };
        p += baseTicks(it.dur);
      } else if (isTuplet(it)) {
        const inner = itemsTicks(it.items);
        const r = walk(it.items, base + p * k, (k * it.normal) / it.actual, true);
        if (r) return r;
        p += (inner * it.normal) / it.actual;
      } else {
        const inner = itemsTicks(it.items);
        const r = walk(it.items, base + p * k, k, inT);
        if (r) return r;
        p += inner;
      }
    }
    return undefined;
  };
  void pos;
  return walk(items, 0, 1, false);
}
