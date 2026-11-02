// Drawing primitives: what the engraver emits and what render.ts, collide.ts and the editor's hit
// index consume. A page is a flat list of `Prim`s in painting order; there is no scene graph.
// All coordinates are in staff spaces (the distance between two staff lines), y pointing down.
// Staff-local drawing code works with y = 0 at the top staff line and is shifted onto the page
// when a system is placed.
/** What a primitive is, for collision checking (see collide.ts). */
export type Kind =
  | 'staff'
  | 'head'
  | 'acc'
  | 'dot'
  | 'stem'
  | 'beam'
  | 'flag'
  | 'ledger'
  | 'rest'
  | 'artic'
  | 'tie'
  | 'slur'
  | 'link'
  | 'tuplet'
  | 'dyn'
  | 'hairpin'
  | 'pedal'
  | 'ottava'
  | 'tempo'
  | 'text'
  | 'clef'
  | 'keysig'
  | 'timesig'
  | 'barline'
  | 'measurenum'
  | 'arpeggio'
  | 'brace';
/** Metadata attached to a primitive where it is pushed (via `tagFrom`); everything after drawing reads these instead of guessing. */
export interface Tag {
  k?: Kind;
  /** Owner: `oid` of the object this primitive is a part of (event, mark, slur ...). Collisions inside one owner are normal. */
  o?: number;
  /** Dynamics and hairpins: the staff-local baseline they were placed on, so that other staves can align with it. */
  a?: number;
  /** `oid`s of the groups the owner belongs to (beam, tuplet, two-note tremolo); members of a common group may touch. */
  g?: number[];
  /** The model object (Event, TupletGroup, Mark) this primitive depicts. The editor's hit index maps clicks to it. */
  r?: object;
  /** Slur or line id, or tied head index: tells apart several spanners that start at the same event. */
  n?: number;
}

const ids = new WeakMap<object, number>();
const byId = new Map<number, WeakRef<object>>();
/** Inverse of oid (diagnostics). */
export function objOf(id: number): object | undefined {
  return byId.get(id)?.deref();
}
let nextId = 1;
/** Stable numeric identity for any object, used for Tag.o / Tag.g. */
export function oid(x: object): number {
  let i = ids.get(x);
  if (i === undefined) {
    i = nextId++;
    ids.set(x, i);
    byId.set(i, new WeakRef(x));
  }
  return i;
}
/**
 * Tags prims[from..] in place: call it right after the drawing code that pushed them, with the
 * object they belong to (`o`; also gives `r`, the model object they depict) and optional groups.
 */
export function tagFrom(
  prims: Prim[],
  from: number,
  k: Kind,
  o?: object | number,
  g?: (object | number | undefined)[],
): void {
  const oo = o === undefined ? undefined : typeof o === 'number' ? o : oid(o);
  const gg = g?.filter((x): x is object | number => x !== undefined).map((x) => (typeof x === 'number' ? x : oid(x)));
  const rr =
    typeof o === 'object'
      ? ((o as { ev?: object }).ev ??
        ((o as { kind?: string }).kind === 'tuplet' ? o : (o as { notes?: { ev: object }[] }).notes?.[0]?.ev))
      : undefined;
  for (let i = from; i < prims.length; i++) {
    prims[i].k = k;
    if (oo !== undefined) prims[i].o = oo;
    if (gg?.length) prims[i].g = gg;
    if (rr) prims[i].r = rr;
  }
}

export type Prim = Tag &
  (
    | { t: 'glyph'; name: string; x: number; y: number; sx?: number; sy?: number; rot?: number }
    | {
        t: 'line';
        x1: number;
        y1: number;
        x2: number;
        y2: number;
        w: number;
        dash?: [number, number];
        cap?: 'butt' | 'square';
      }
    /** A filled outline; `dx`/`dy` move all of `d` (a path is placed by an offset instead of being rewritten each time it is shifted). */
    | { t: 'path'; d: string; dx?: number; dy?: number; fill?: string; top?: boolean }
    | {
        t: 'text';
        x: number;
        y: number;
        s: string;
        size: number;
        anchor?: 'start' | 'middle' | 'end';
        italic?: boolean;
        bold?: boolean;
        /** Drawn above the lines (staff lines, barlines...) like `path.top`. */
        top?: boolean;
      }
  );

/** One output page: size in staff spaces and its primitives, already in page coordinates. */
export interface Page {
  width: number;
  height: number;
  prims: Prim[];
}

/** Occupied regions, used to place marks without collisions (y down). */
export class Skyline {
  /** `btw`: a dynamic or hairpin placed between the staves, which is centred in the gap later (`centreBetweenMarks`). `o`: the owner tag of a dynamic or hairpin's primitives. */
  boxes: {
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    spanner?: boolean;
    acc?: boolean;
    btw?: boolean;
    o?: number;
  }[] = [];
  /** `spanner`: a slur/tie box (a long rectangle over a curve), ignored when only the notation itself matters. `acc`: an accidental, which ties may cross. */
  add(x0: number, x1: number, y0: number, y1: number, spanner = false, acc = false): void {
    if (x1 < x0) [x0, x1] = [x1, x0];
    if (y1 < y0) [y0, y1] = [y1, y0];
    this.boxes.push({ x0, x1, y0, y1, spanner, acc });
  }
  /** The lowest occupied y (the maximum) within x0..x1, or `fallback` when nothing is there or lower. */
  bottom(x0: number, x1: number, fallback: number, skipSpanners = false, skipAcc = false): number {
    let r = fallback;
    for (const b of this.boxes)
      if (b.x1 > x0 && b.x0 < x1 && b.y1 > r && !(skipSpanners && b.spanner) && !(skipAcc && b.acc)) r = b.y1;
    return r;
  }
  /** The highest occupied y (the minimum) within x0..x1, or `fallback`. */
  top(x0: number, x1: number, fallback: number, skipSpanners = false, skipAcc = false): number {
    let r = fallback;
    for (const b of this.boxes)
      if (b.x1 > x0 && b.x0 < x1 && b.y0 < r && !(skipSpanners && b.spanner) && !(skipAcc && b.acc)) r = b.y0;
    return r;
  }
  /** Vertical extent of everything added, at least the staff itself (0..4); used to space staves apart. */
  extent(): { top: number; bottom: number } {
    let top = 0;
    let bottom = 4;
    for (const b of this.boxes) {
      if (b.y0 < top) top = b.y0;
      if (b.y1 > bottom) bottom = b.y1;
    }
    return { top, bottom };
  }
}

/** A copy of a primitive moved by (dx, dy). */
export function shiftPrim(p: Prim, dx: number, dy: number): Prim {
  switch (p.t) {
    case 'glyph':
      return { ...p, x: p.x + dx, y: p.y + dy };
    case 'line':
      return { ...p, x1: p.x1 + dx, x2: p.x2 + dx, y1: p.y1 + dy, y2: p.y2 + dy };
    case 'text':
      return { ...p, x: p.x + dx, y: p.y + dy };
    case 'path':
      return { ...p, dx: (p.dx ?? 0) + dx, dy: (p.dy ?? 0) + dy };
  }
}
