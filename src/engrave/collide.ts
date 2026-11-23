// Collision checking on the finished pages.
//
// Policy: no two tagged primitives may overlap, except for the pairs in ALLOW. Staff lines are crossed by everything
// and are never checked; untagged primitives (title, page number ...) are ignored.
//
// Every primitive is turned into a shape (outline polygons + bounding box). Per pair we pick the cheaper exact test:
//  - both shapes are "box-like" (axis-aligned lines, text, glyphs/paths that fill their box): the bounding boxes are
//    exact, so box overlap decides;
//  - otherwise (slanted beams, slurs, hairpins, most glyphs) the bounding boxes only serve as a broad phase and the
//    outlines are intersected.

import { loadSmufl } from '../smufl.ts';

import { must } from '../util.ts';
import type { Kind, Page, Prim } from './scene.ts';
import { textWidth } from './textmetrics.ts';

export type Scope = 'own' | 'any';

/** Pairs of element kinds that may overlap. `own`: only when both belong to the same object / group. */
const ALLOW: readonly [Kind, Kind, Scope][] = [
  // Parts of one note: heads, stems, dots, flags and beams are drawn to touch each other,
  // so only collisions with *other* objects are meaningful. Scope `own` ensures that.
  ['head', 'stem', 'own'],
  ['head', 'dot', 'own'],
  ['head', 'head', 'own'],
  ['stem', 'beam', 'own'],
  ['stem', 'flag', 'own'],
  // The hooks of a tuplet bracket end on the stems of its group (scope `own`: a bracket touching
  // the stem of some other voice is still reported).
  ['stem', 'tuplet', 'own'],
  // Ledger lines run through the heads (and across stems) they serve. Scope `any` because a
  // ledger line also serves the heads of other voices at that position.
  ['ledger', 'head', 'any'],
  ['ledger', 'stem', 'any'],
  // A tie may run through the accidental of the note it ends on (or of another voice) rather than bulge around it.
  ['acc', 'tie', 'any'],
  // Staff furniture: the barline at the start of a system meets the brace; neither belongs
  // to any note, so there is no owner to scope it by.
  ['barline', 'brace', 'any'],
  // Slurs, ties, hairpins, pedal and ottava lines legitimately run across barlines; no other
  // kind may touch one.
  ['barline', 'slur', 'any'],
  ['barline', 'tie', 'any'],
  ['barline', 'hairpin', 'any'],
  ['barline', 'pedal', 'any'],
  ['barline', 'ottava', 'any'],
  ['barline', 'trill', 'any'],
  // A volta bracket starts and ends on barlines.
  ['barline', 'volta', 'any'],
  // A line between notes is drawn where the user wants it, across whatever lies between the notes.
  ...(['barline', 'stem', 'flag', 'beam', 'ledger', 'tie', 'slur', 'link'] as const).map((k): [Kind, Kind, Scope] => [
    'link',
    k,
    'any',
  ]),
];

const allowed = new Map<string, Scope>();

for (const [a, b, s] of ALLOW) {
  allowed.set(`${a}|${b}`, s);
  allowed.set(`${b}|${a}`, s);
}

/** Overlaps thinner than this (staff spaces) count as touching: engraving routinely butts shapes together exactly, and Leland's noteheads are 1.06 spaces tall, so heads on adjacent positions overlap by 0.06. */
const EPS = 0.07;

interface Shape {
  p: Prim;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Outline polygons, each a flat [x, y, x, y, ...] list that is closed implicitly (glyphs have several rings, e.g. a notehead's hole). */
  rings: number[][];
  /** The shape fills its bounding box exactly, so a box test is already exact. */
  boxy: boolean;
}

export interface Collision {
  page: number;
  a: Prim;
  b: Prim;
  /** The overlapping region (of the two bounding boxes), in page staff spaces. */
  x: number;
  y: number;
  w: number;
  h: number;
  mode: 'box' | 'outline';
}

const sm = loadSmufl();

// Path flattening: the collision check works on polygons.
// Glyph and curve outlines come as SVG path data; to intersect them they are approximated by polygons
// (Béziers sampled at 6-8 points, which is plenty at the 0.07 tolerance). Rings of a glyph are cached by name.
const glyphRings = new Map<string, number[][]>();

/** Appends 8 points of the cubic Bézier from (x0, y0) with control points (x1, y1), (x2, y2) to (x3, y3) to `out`. */
function sampleCubic(
  out: number[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
): void {
  for (let t = 1; t <= 8; t++) {
    const u = t / 8;
    const v = 1 - u;
    out.push(
      v * v * v * x0 + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x3,
      v * v * v * y0 + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y3,
    );
  }
}

/** Appends 6 points of the quadratic Bézier from (x0, y0) with control point (x1, y1) to (x2, y2) to `out`. */
function sampleQuad(out: number[], x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): void {
  for (let t = 1; t <= 6; t++) {
    const u = t / 6;
    const v = 1 - u;
    out.push(v * v * x0 + 2 * v * u * x1 + u * u * x2, v * v * y0 + 2 * v * u * y1 + u * u * y2);
  }
}

/**
 * Flattens SVG path data (M, L, H, V, C, Q, Z, absolute and relative) into one polygon ring per subpath, as flat
 * [x, y, ...] arrays.
 */
export function flattenPath(d: string): number[][] {
  const tok = d.match(/[MLHVCQZmlhvcqz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const rings: number[][] = [];
  let cur: number[] = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let i = 0;
  const num = () => Number.parseFloat(tok[i++]);
  const close = () => {
    if (cur.length >= 6) rings.push(cur);
    cur = [];
  };
  let cmd = '';
  while (i < tok.length) {
    if (/[A-Za-z]/.test(tok[i])) cmd = tok[i++];
    switch (cmd) {
      case 'M':
        close();
        cx = sx = num();
        cy = sy = num();
        cur = [cx, cy];
        cmd = 'L';
        break;
      case 'L':
        cx = num();
        cy = num();
        cur.push(cx, cy);
        break;
      case 'H':
        cx = num();
        cur.push(cx, cy);
        break;
      case 'V':
        cy = num();
        cur.push(cx, cy);
        break;
      case 'C': {
        const [x1, y1, x2, y2, x3, y3] = [num(), num(), num(), num(), num(), num()];
        sampleCubic(cur, cx, cy, x1, y1, x2, y2, x3, y3);
        cx = x3;
        cy = y3;
        break;
      }
      case 'Q': {
        const [x1, y1, x2, y2] = [num(), num(), num(), num()];
        sampleQuad(cur, cx, cy, x1, y1, x2, y2);
        cx = x2;
        cy = y2;
        break;
      }
      case 'Z':
      case 'z':
        close();
        cx = sx;
        cy = sy;
        break;
      default:
        throw new Error(`collide: unsupported path command ${cmd}`);
    }
  }
  close();
  return rings;
}

/** The signed area of a polygon ring (shoelace formula). */
function ringArea(r: number[]): number {
  let a = 0;
  for (let i = 0, n = r.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += r[2 * i] * r[2 * j + 1] - r[2 * j] * r[2 * i + 1];
  }
  return a / 2;
}

/**
 * Completes a shape: its bounding box, and whether it fills at least 90% of it (then boxes are compared) unless
 * `forceBoxy` decides.
 */
function finish(p: Prim, rings: number[][], forceBoxy?: boolean): Shape {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const r of rings)
    for (let i = 0; i < r.length; i += 2) {
      x0 = Math.min(x0, r[i]);
      x1 = Math.max(x1, r[i]);
      y0 = Math.min(y0, r[i + 1]);
      y1 = Math.max(y1, r[i + 1]);
    }
  let boxy = forceBoxy;
  if (boxy === undefined) {
    const area = Math.abs(rings.reduce((a, r) => a + ringArea(r), 0));
    boxy = area >= 0.9 * (x1 - x0) * (y1 - y0);
  }
  return { p, x0, y0, x1, y1, rings, boxy };
}

/** The ring of an axis-aligned rectangle. */
function rect(x0: number, y0: number, x1: number, y1: number): number[] {
  return [x0, y0, x1, y0, x1, y1, x0, y1];
}

/** The collision shape of a primitive, or `null` for one that cannot collide (a zero-length line, an empty glyph). */
function shapeOf(p: Prim): Shape | null {
  switch (p.t) {
    case 'line': {
      const dx = p.x2 - p.x1;
      const dy = p.y2 - p.y1;
      const len = Math.hypot(dx, dy);
      if (len === 0) return null;
      const h = p.w / 2;
      if (dx === 0) return finish(p, [rect(p.x1 - h, Math.min(p.y1, p.y2), p.x1 + h, Math.max(p.y1, p.y2))], true);
      if (dy === 0) return finish(p, [rect(Math.min(p.x1, p.x2), p.y1 - h, Math.max(p.x1, p.x2), p.y1 + h)], true);
      const nx = (-dy / len) * h;
      const ny = (dx / len) * h;
      return finish(
        p,
        [[p.x1 + nx, p.y1 + ny, p.x2 + nx, p.y2 + ny, p.x2 - nx, p.y2 - ny, p.x1 - nx, p.y1 - ny]],
        false,
      );
    }
    case 'path': {
      const rings = flattenPath(p.d);
      if (p.dx || p.dy)
        for (const r of rings)
          for (let i = 0; i < r.length; i += 2) {
            r[i] += p.dx ?? 0;
            r[i + 1] += p.dy ?? 0;
          }
      return finish(p, rings);
    }
    case 'glyph': {
      let base = glyphRings.get(p.name);
      if (!base) {
        base = flattenPath(sm.path(p.name));
        glyphRings.set(p.name, base);
      }
      const sx = p.sx ?? 1;
      const sy = p.sy ?? 1;
      const th = ((p.rot ?? 0) * Math.PI) / 180;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const rings = base.map((r) => {
        const o = new Array<number>(r.length);
        for (let i = 0; i < r.length; i += 2) {
          const X = r[i] * sx;
          const Y = r[i + 1] * sy;
          o[i] = p.x + X * c - Y * s;
          o[i + 1] = p.y + X * s + Y * c;
        }
        return o;
      });
      return finish(p, rings);
    }
    case 'text': {
      const w = textWidth(p.s, p.size);
      const x0 = p.anchor === 'middle' ? p.x - w / 2 : p.anchor === 'end' ? p.x - w : p.x;
      return finish(p, [rect(x0, p.y - p.size * 0.75, x0 + w, p.y + p.size * 0.25)], true);
    }
  }
}

// Outline intersection: the geometric test behind the collision check. Two polygon sets overlap if any
// pair of edges crosses, or if one lies entirely inside the other (no edge crossing then). Edges outside
// the bounding-box overlap of the two shapes are skipped quickly.

/** Whether segment a-b properly crosses segment c-d. */
function segCross(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Whether the point (x, y) lies inside the rings by the even-odd rule. */
function inside(rings: number[][], x: number, y: number): boolean {
  let c = false;
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[2 * i];
      const yi = r[2 * i + 1];
      const xj = r[2 * j];
      const yj = r[2 * j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}

/** Whether two outlines overlap: some edges cross, or one outline lies inside the other. */
function outlinesIntersect(a: Shape, b: Shape): boolean {
  if (edgesCross(a, b)) return true;
  // No crossing edges. The outlines may still overlap if one lies completely inside the other, which
  // one vertex of each tested against the other's rings (even-odd rule) detects.
  return inside(b.rings, a.rings[0][0], a.rings[0][1]) || inside(a.rings, b.rings[0][0], b.rings[0][1]);
}

// Pair policy: which overlaps are accepted and which are reported.

/** Whether two primitives are *meant* to touch: parts of one note, members of one beam or tuplet group, ... */
function related(a: Prim, b: Prim): boolean {
  if (a.o !== undefined && a.o === b.o) return true;
  if (a.o !== undefined && b.g?.includes(a.o)) return true;
  if (b.o !== undefined && a.g?.includes(b.o)) return true;
  return !!a.g && !!b.g && a.g.some((x) => must(b.g).includes(x));
}

/**
 * Whether two overlapping primitives are allowed to overlap: parts of one object, or a pair of kinds listed in
 * `ALLOW` (within its scope).
 */
function permitted(a: Prim, b: Prim): boolean {
  if (a.k === b.k && a.o !== undefined && a.o === b.o) return true; // These are parts of one object.
  const scope = allowed.get(`${a.k}|${b.k}`);
  if (scope === undefined) return false;
  return scope === 'any' || related(a, b);
}

/** Do any edges of the two outlines cross? Edges are first rejected by the bounding box of the overlap. */
function edgesCross(a: Shape, b: Shape): boolean {
  const lx0 = Math.max(a.x0, b.x0);
  const lx1 = Math.min(a.x1, b.x1);
  const ly0 = Math.max(a.y0, b.y0);
  const ly1 = Math.min(a.y1, b.y1);
  for (const ra of a.rings) {
    const na = ra.length / 2;
    for (let i = 0; i < na; i++) {
      const j = (i + 1) % na;
      const ax = ra[2 * i];
      const ay = ra[2 * i + 1];
      const bx = ra[2 * j];
      const by = ra[2 * j + 1];
      if (Math.max(ax, bx) < lx0 || Math.min(ax, bx) > lx1 || Math.max(ay, by) < ly0 || Math.min(ay, by) > ly1)
        continue;
      for (const rb of b.rings) {
        const nb = rb.length / 2;
        for (let k = 0; k < nb; k++) {
          const l = (k + 1) % nb;
          if (segCross(ax, ay, bx, by, rb[2 * k], rb[2 * k + 1], rb[2 * l], rb[2 * l + 1])) return true;
        }
      }
    }
  }
  return false;
}

/** The shapes of a page that take part in collision checks (staff lines and untagged prims do not), sorted by left edge. */
function pageShapes(page: Page): Shape[] {
  const shapes: Shape[] = [];
  for (const p of page.prims) {
    if (!p.k || p.k === 'staff') continue;
    const s = shapeOf(p);
    if (s) shapes.push(s);
  }
  return shapes.sort((a, b) => a.x0 - b.x0);
}

/** The collision of two shapes whose bounding boxes overlap, unless it is permitted or only their boxes (not outlines) touch. */
function collisionOf(a: Shape, b: Shape, page: number): Collision | undefined {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= EPS || h <= EPS || permitted(a.p, b.p)) return undefined;
  const mode = a.boxy && b.boxy ? 'box' : 'outline';
  if (mode === 'outline' && !outlinesIntersect(a, b)) return undefined;
  return { page, a: a.p, b: b.p, x: Math.max(a.x0, b.x0), y: Math.max(a.y0, b.y0), w, h, mode };
}

/** Reports every overlap on the pages that is not permitted. Shapes are swept in order of their left edge. */
export function findCollisions(pages: Page[]): Collision[] {
  const out: Collision[] = [];
  pages.forEach((page, pi) => {
    const shapes = pageShapes(page);
    for (let i = 0; i < shapes.length; i++)
      for (let j = i + 1; j < shapes.length && shapes[j].x0 < shapes[i].x1 - EPS; j++) {
        const c = collisionOf(shapes[i], shapes[j], pi + 1);
        if (c) out.push(c);
      }
  });
  return out;
}

/** A one-line description of a collision for messages and test failures. */
export function describe(c: Collision): string {
  return `page ${c.page} (${c.x.toFixed(1)}, ${c.y.toFixed(1)}) ${c.a.k} x ${c.b.k} [${c.mode}] ${c.w.toFixed(2)}x${c.h.toFixed(2)}`;
}
