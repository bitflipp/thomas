// Beaming: explicit groups (`BeamGroup`) plus automatic grouping of everything else.
// Shared by the engraver (prep.ts) and the importer, which uses it to leave out explicit groups
// that the automatic rules would produce anyway.
import type { Event, Item, TimeSig, TupletGroup, Voice } from './model.ts';
import { flattenVoice, isBeam, isEvent, isTuplet, PPQ } from './model.ts';

/** Length of one beaming unit: the beat, except that compound meters (6/8, 9/8, ...) beam in dotted quarters. */
export function beatTicks(ts: TimeSig): number {
  if (ts.beatType === 8 && ts.beats % 3 === 0 && ts.beats > 3) return (PPQ * 3) / 2;
  return (PPQ * 4) / ts.beatType;
}

/** All events below `items`, descending into tuplets and beam groups. */
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
  // Automatic grouping of everything not in an explicit group. A run is a sequence of consecutive
  // notes of eighth length or shorter; it is cut (flush) at a rest or non-beamable event, at a beat
  // boundary, and where the tuplet nesting changes without one note sequence containing the other
  // (so a tuplet never shares a beam with the notes next to it). Runs of one note are not groups.
  let run: Event[] = [];
  const flush = () => {
    if (run.length >= 2) out.push(run);
    run = [];
  };
  let prev: (typeof flat)[number] | undefined;
  for (const te of flat) {
    const e = te.ev;
    if (grouped.has(e) || e.kind !== 'note' || e.dur.base < 8 || e.noBeam) {
      flush();
      prev = undefined;
      continue;
    }
    if (prev) {
      const sameTuplets =
        prev.tuplets.length === te.tuplets.length && prev.tuplets.every((t, i) => t === te.tuplets[i]);
      const beatCross = Math.floor(prev.start / beatLen) !== Math.floor(te.start / beatLen);
      // `sameTuplets` is the cheap case. Otherwise the run is cut unless the two notes share some
      // tuplet (one side nested inside the other), so a tuplet's beam never extends to a neighbour.
      if (
        beatCross ||
        (!sameTuplets &&
          prev.tuplets.length + te.tuplets.length > 0 &&
          !prev.tuplets.some((t) => te.tuplets.includes(t)))
      )
        flush();
    }
    run.push(e);
    prev = te;
  }
  flush();
  return out;
}

/** A canonical string for "which events are beamed together" (flat event indices), to compare two beamings. */
function partitionKey(v: Voice, beatLen: number): string {
  const idx = new Map(flattenVoice(v).map((t) => [t.ev, t.index]));
  return beamGroups(v, beatLen)
    .map((g) => g.map((e) => idx.get(e)).join(','))
    .sort()
    .join('|');
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
        // The group's members now sit in slots i.. instead of it: if the beaming is unchanged the
        // group was redundant, so re-examine slot i (it holds a member now, possibly a nested group).
        if (partitionKey(v, beatLen) === target) {
          i--;
          continue;
        }
        // The group mattered (removing it changed the beaming): put it back, in the same place,
        // and carry on with its members, which may contain more groups to examine.
        items.splice(i, it.items.length, it);
      }
      dropGroups(it.items);
    }
  };
  dropGroups(v.items);
  const clearFlags = (items: Item[]) => {
    for (const it of items) {
      if (!isEvent(it)) {
        clearFlags(it.items);
        continue;
      }
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
