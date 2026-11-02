// Beaming: explicit groups (`BeamGroup`) plus automatic grouping of everything else.
// Shared by the engraver (prep.ts) and the importer, which uses it to leave out explicit groups
// that the automatic rules would produce anyway.
import type { Event, Item, TimeSig, TupletGroup, Voice } from './model.ts';
import { flattenVoice, isBeam, isEvent, isTuplet, PPQ } from './model.ts';
import { must } from './util.ts';

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
  out.push(...autoGroups(flat, beatLen, grouped, (e) => !!e.noBeam));
  return out;
}

/**
 * Automatic grouping of the events in `flat` that are not in `skip`. A run is a sequence of consecutive
 * notes of eighth length or shorter; it is cut (flush) at a rest or non-beamable event, at a beat
 * boundary, and where the tuplet nesting changes without one note sequence containing the other
 * (so a tuplet never shares a beam with the notes next to it). Runs of one note are not groups.
 */
function autoGroups(
  flat: ReturnType<typeof flattenVoice>,
  beatLen: number,
  skip: Set<Event>,
  isFlagged: (e: Event) => boolean,
): Event[][] {
  const out: Event[][] = [];
  let run: Event[] = [];
  const flush = () => {
    if (run.length >= 2) out.push(run);
    run = [];
  };
  let prev: (typeof flat)[number] | undefined;
  for (const te of flat) {
    const e = te.ev;
    if (skip.has(e) || e.kind !== 'note' || e.dur.base < 8 || isFlagged(e)) {
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

// ------------------------------------------------------------------ per-note beam modes
//
// The model states beaming as explicit groups plus `noBeam` flags (see above). The editor offers the
// MuseScore view instead: every note has a mode, which is derived from the model and turned back into
// groups and flags by `planBeams` (+ `setBeamMode` in editor/commands.ts).
//   auto   the automatic rules decide whether the note is beamed to the previous one
//   none   the note is beamed to neither neighbour
//   break  the note starts a new beam (not beamed to the previous note)
//   join   the note continues the beam of the previous note

export type BeamMode = 'auto' | 'none' | 'break' | 'join';

/** Which events are beamed to their predecessor (`links[i]`: events i-1 and i are in one group). */
export function beamLinks(v: Voice, beatLen: number): boolean[] {
  const flat = flattenVoice(v);
  const at = new Map(flat.map((t) => [t.ev, t.index]));
  const links = flat.map(() => false);
  for (const g of beamGroups(v, beatLen)) for (let k = 1; k < g.length; k++) links[must(at.get(g[k]))] = true;
  return links;
}

/** The same for the automatic rules alone, with explicit groups ignored and `flags[i]` standing for `noBeam` of event i. */
export function autoLinks(v: Voice, beatLen: number, flags: boolean[]): boolean[] {
  const flat = flattenVoice(v);
  const at = new Map(flat.map((t) => [t.ev, t.index]));
  const links = flat.map(() => false);
  for (const g of autoGroups(flat, beatLen, new Set(), (e) => flags[must(at.get(e))]))
    for (let k = 1; k < g.length; k++) links[must(at.get(g[k]))] = true;
  return links;
}

const noBeamFlags = (v: Voice): boolean[] => flattenVoice(v).map((t) => t.ev.kind === 'note' && !!t.ev.noBeam);

/** Can event `i` be beamed to its predecessor at all? Both must be notes of eighth length or shorter, outside a tremolo. */
export function canJoin(flat: ReturnType<typeof flattenVoice>, i: number): string | undefined {
  const a = flat[i - 1];
  const b = flat[i];
  if (!a) return 'The first note of a measure cannot be beamed to the previous measure (beams stay within a measure)';
  if (a.ev.kind !== 'note' || b.ev.kind !== 'note') return 'A rest breaks a beam';
  if (a.ev.dur.base < 8 || b.ev.dur.base < 8) return 'Only eighth notes and shorter can be beamed';
  if (a.tremolo || b.tremolo) return 'The notes of a tremolo are not beamed';
  return undefined;
}

/** The mode of every event of a voice (rests count as `auto`). */
export function beamModes(v: Voice, beatLen: number): BeamMode[] {
  const flags = noBeamFlags(v);
  const eff = beamLinks(v, beatLen);
  const auto = autoLinks(v, beatLen, flags);
  return flags.map((f, i) => (f ? 'none' : eff[i] === auto[i] ? 'auto' : eff[i] ? 'join' : 'break'));
}

/** What the beaming of a voice should look like: `links[i]` event i is beamed to event i-1, `flags[i]` event i carries `noBeam`. */
export interface BeamPlan {
  links: boolean[];
  flags: boolean[];
}

/**
 * Applies per-note modes (`changes`: event index -> mode) to the current beaming of a voice. A string (a
 * message for the user) says why a note cannot be joined. The result is realised by `setBeamMode`.
 */
export function planBeams(v: Voice, beatLen: number, changes: Map<number, BeamMode>): BeamPlan | string {
  const flat = flattenVoice(v);
  const links = beamLinks(v, beatLen);
  const flags = noBeamFlags(v);
  const cleared = new Set<number>();
  const clear = (i: number) => {
    if (flags[i]) {
      flags[i] = false;
      cleared.add(i);
    }
  };
  for (const [i, mode] of changes) {
    if (flat[i].ev.kind !== 'note') continue;
    if (mode === 'none') flags[i] = true;
    else {
      clear(i);
      if (mode === 'join') {
        const why = canJoin(flat, i);
        if (why) return why;
        clear(i - 1);
      }
    }
  }
  // A note that lost its flag was cut off from both neighbours by it: they go back to the automatic choice.
  const auto = autoLinks(v, beatLen, flags);
  for (const i of cleared) {
    links[i] = auto[i];
    if (i + 1 < links.length) links[i + 1] = auto[i + 1];
  }
  for (const [i, mode] of changes) {
    if (flat[i].ev.kind !== 'note') continue;
    if (mode === 'none') {
      links[i] = false;
      if (i + 1 < links.length) links[i + 1] = false;
    } else if (mode === 'auto') links[i] = auto[i];
    else links[i] = mode === 'join';
  }
  return { links, flags };
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
