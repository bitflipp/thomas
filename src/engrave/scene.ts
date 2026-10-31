// Drawing primitives. All coordinates are in staff spaces, y pointing down.
export type Prim =
  | { t: 'glyph'; name: string; x: number; y: number; sx?: number; sy?: number; rot?: number }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; w: number; dash?: [number, number]; cap?: 'butt' | 'square' }
  | { t: 'path'; d: string }
  | { t: 'text'; x: number; y: number; s: string; size: number; anchor?: 'start' | 'middle' | 'end'; italic?: boolean; bold?: boolean };

export interface Page { width: number; height: number; prims: Prim[] }

/** Occupied regions, used to place marks without collisions (y down). */
export class Skyline {
  boxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
  add(x0: number, x1: number, y0: number, y1: number): void {
    if (x1 < x0) [x0, x1] = [x1, x0];
    if (y1 < y0) [y0, y1] = [y1, y0];
    this.boxes.push({ x0, x1, y0, y1 });
  }
  /** lowest occupied y (max) in [x0,x1], or fallback */
  bottom(x0: number, x1: number, fallback: number): number {
    let r = fallback;
    for (const b of this.boxes) if (b.x1 > x0 && b.x0 < x1 && b.y1 > r) r = b.y1;
    return r;
  }
  top(x0: number, x1: number, fallback: number): number {
    let r = fallback;
    for (const b of this.boxes) if (b.x1 > x0 && b.x0 < x1 && b.y0 < r) r = b.y0;
    return r;
  }
  extent(): { top: number; bottom: number } {
    let top = 0, bottom = 4;
    for (const b of this.boxes) { if (b.y0 < top) top = b.y0; if (b.y1 > bottom) bottom = b.y1; }
    return { top, bottom };
  }
}
