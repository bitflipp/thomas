// Drawing primitives. All coordinates are in staff spaces, y pointing down.
/** What a primitive is, for collision checking (see collide.ts). */
export type Kind =
  | 'staff' | 'head' | 'acc' | 'dot' | 'stem' | 'beam' | 'flag' | 'ledger' | 'rest' | 'artic' | 'tie' | 'slur' | 'tuplet'
  | 'dyn' | 'hairpin' | 'pedal' | 'ottava' | 'tempo' | 'text' | 'clef' | 'keysig' | 'timesig' | 'barline' | 'measurenum' | 'arpeggio' | 'brace';
export interface Tag {
  k?: Kind;
  o?: number; // owner: the object this primitive is a part of (event, mark, slur ...)
  a?: number; // dynamics/hairpins: staff-local baseline they were placed on (for alignment across staves)
  g?: number[]; // groups the owner belongs to (beam, tuplet, two-note tremolo)
}

const ids = new WeakMap<object, number>();
const byId = new Map<number, WeakRef<object>>();
/** Inverse of oid (diagnostics). */
export function objOf(id: number): object | undefined { return byId.get(id)?.deref(); }
let nextId = 1;
/** Stable numeric identity for any object, used for Tag.o / Tag.g. */
export function oid(x: object): number {
  let i = ids.get(x);
  if (i === undefined) { i = nextId++; ids.set(x, i); byId.set(i, new WeakRef(x)); }
  return i;
}
/** Tag prims[from..] in place. */
export function tagFrom(prims: Prim[], from: number, k: Kind, o?: object | number, g?: (object | number | undefined)[]): void {
  const oo = o === undefined ? undefined : typeof o === 'number' ? o : oid(o);
  const gg = g?.filter((x): x is object | number => x !== undefined).map((x) => (typeof x === 'number' ? x : oid(x)));
  for (let i = from; i < prims.length; i++) { prims[i].k = k; if (oo !== undefined) prims[i].o = oo; if (gg?.length) prims[i].g = gg; }
}

export type Prim = Tag & (
  | { t: 'glyph'; name: string; x: number; y: number; sx?: number; sy?: number; rot?: number }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; w: number; dash?: [number, number]; cap?: 'butt' | 'square' }
  | { t: 'path'; d: string }
  | { t: 'text'; x: number; y: number; s: string; size: number; anchor?: 'start' | 'middle' | 'end'; italic?: boolean; bold?: boolean });

export interface Page { width: number; height: number; prims: Prim[] }

/** Occupied regions, used to place marks without collisions (y down). */
export class Skyline {
  boxes: { x0: number; x1: number; y0: number; y1: number; spanner?: boolean }[] = [];
  /** `spanner`: a slur/tie box (a long rectangle over a curve), ignored when only the notation itself matters. */
  add(x0: number, x1: number, y0: number, y1: number, spanner = false): void {
    if (x1 < x0) [x0, x1] = [x1, x0];
    if (y1 < y0) [y0, y1] = [y1, y0];
    this.boxes.push({ x0, x1, y0, y1, spanner });
  }
  /** lowest occupied y (max) in [x0,x1], or fallback */
  bottom(x0: number, x1: number, fallback: number, skipSpanners = false): number {
    let r = fallback;
    for (const b of this.boxes) if (b.x1 > x0 && b.x0 < x1 && b.y1 > r && !(skipSpanners && b.spanner)) r = b.y1;
    return r;
  }
  top(x0: number, x1: number, fallback: number, skipSpanners = false): number {
    let r = fallback;
    for (const b of this.boxes) if (b.x1 > x0 && b.x0 < x1 && b.y0 < r && !(skipSpanners && b.spanner)) r = b.y0;
    return r;
  }
  extent(): { top: number; bottom: number } {
    let top = 0, bottom = 4;
    for (const b of this.boxes) { if (b.y0 < top) top = b.y0; if (b.y1 > bottom) bottom = b.y1; }
    return { top, bottom };
  }
}
