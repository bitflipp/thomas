// Beaming: explicit groups (`BeamGroup`) plus automatic grouping of everything else.
// Shared by the engraver (prep.ts) and the importer, which uses it to leave out explicit groups
// that the automatic rules would produce anyway.
import {
  PPQ, flattenVoice, isBeam, isEvent, isTuplet,
  type Event, type Item, type TimeSig, type TupletGroup, type Voice,
} from './model.ts';

export function beatTicks(ts: TimeSig): number {
  if (ts.beatType === 8 && ts.beats % 3 === 0 && ts.beats > 3) return (PPQ * 3) / 2;
  return (PPQ * 4) / ts.beatType;
}

const members = (items: Item[]): Event[] => items.flatMap((i) => (isEvent(i) ? [i] : members(i.items)));

/** Beam groups of a voice (events incl. the rests inside, in order); only groups with at least two notes. */
export function beamGroups(v: Voice, beatLen: number): Event[][] {
  const flat = flattenVoice(v);
  const grouped = new Set<Event>();
  const out: Event[][] = [];
  const walk = (items: Item[]) => {
    for (const it of items) {
      if (isEvent(it)) continue;
      if (isBeam(it)) {
        const ems = members(it.items);
        for (const m of ems) grouped.add(m);
        if (ems.filter((e) => e.kind === 'note').length >= 2) out.push(ems);
      }
      walk(it.items);
    }
  };
  walk(v.items);
  // automatic grouping of the rest: eighths and shorter, per beat, not across tuplet boundaries or rests
  let run: Event[] = [];
  const flush = () => { if (run.length >= 2) out.push(run); run = []; };
  let prev: (typeof flat)[number] | undefined;
  for (const te of flat) {
    const e = te.ev;
    if (grouped.has(e) || e.kind !== 'note' || e.dur.base < 8 || e.noBeam) { flush(); prev = undefined; continue; }
    if (prev) {
      const sameTuplets = prev.tuplets.length === te.tuplets.length && prev.tuplets.every((t, i) => t === te.tuplets[i]);
      const beatCross = Math.floor(prev.start / beatLen) !== Math.floor(te.start / beatLen);
      if (beatCross || (!sameTuplets && prev.tuplets.length + te.tuplets.length > 0 && !prev.tuplets.some((t) => te.tuplets.includes(t)))) flush();
    }
    run.push(e);
    prev = te;
  }
  flush();
  return out;
}

function partitionKey(v: Voice, beatLen: number): string {
  const idx = new Map(flattenVoice(v).map((t) => [t.ev, t.index]));
  return beamGroups(v, beatLen).map((g) => g.map((e) => idx.get(e)).join(',')).sort().join('|');
}

/**
 * Rewrites a voice so that it states only what automatic beaming cannot do: explicit groups and `noBeam`
 * flags are dropped when the result is the same beaming; single-note groups become `noBeam`.
 */
export function simplifyBeams(v: Voice, beatLen: number): void {
  const unwrapSingles = (items: Item[]) => {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (isEvent(it)) continue;
      unwrapSingles(it.items);
      if (isBeam(it) && members(it.items).filter((e) => e.kind === 'note').length < 2) {
        for (const e of members(it.items)) if (e.kind === 'note') e.noBeam = true;
        items.splice(i, 1, ...it.items);
      }
    }
  };
  unwrapSingles(v.items);
  const target = partitionKey(v, beatLen);
  const dropGroups = (items: Item[]) => {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (isEvent(it)) continue;
      if (isBeam(it)) {
        items.splice(i, 1, ...it.items);
        if (partitionKey(v, beatLen) === target) { i--; continue; } // re-examine what moved into slot i
        items.splice(i, it.items.length, it);
      }
      dropGroups(it.items);
    }
  };
  dropGroups(v.items);
  const clearFlags = (items: Item[]) => {
    for (const it of items) {
      if (!isEvent(it)) { clearFlags(it.items); continue; }
      if (it.kind === 'note' && it.noBeam) {
        delete it.noBeam;
        if (partitionKey(v, beatLen) !== target) it.noBeam = true;
      }
    }
  };
  clearFlags(v.items);
}

/**
 * Drops the explicit `bracket` of tuplets when it equals what the engraver chooses on its own
 * (bracket unless the whole tuplet is under one beam). Run after `simplifyBeams`.
 */
export function simplifyTupletBrackets(v: Voice, beatLen: number): void {
  const groupOf = new Map<Event, object>();
  for (const g of beamGroups(v, beatLen)) for (const e of g) groupOf.set(e, g);
  const walk = (items: Item[]) => {
    for (const it of items) {
      if (isEvent(it)) continue;
      if (isTuplet(it)) dropBracket(it);
      walk(it.items);
    }
  };
  const dropBracket = (t: TupletGroup) => {
    const notes = members(t.items).filter((e) => e.kind === 'note');
    const sets = new Set(notes.map((n) => groupOf.get(n)));
    const fullyBeamed = notes.length > 0 && sets.size === 1 && !sets.has(undefined);
    if (t.bracket === !fullyBeamed) delete t.bracket;
  };
  walk(v.items);
}
