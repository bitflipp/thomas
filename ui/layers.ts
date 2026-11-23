// Layers: analyses that look at the score and point at places in it (consecutive fifths and octaves).
//
// One layer or none is chosen in the toolbar's Layers menu (`activeLayer`; the layers are independent analyses, and
// one at a time lets them share colors). The chosen layer contributes `Finding`s: places in the score with
// outlines and the notes involved. Everything that shows findings is written against this one shape: the score pane
// paints the notes in the color of their severity (`layerNotes`) and draws each finding as outlines,
// F8 / Shift+F8 (`Findings.tsx`) walk through the findings of the chosen layer, and the Overview strip marks their
// measures. Display options that do not analyze anything (voice colors, ...) stay in the View menu.
//
// The findings of the parallels layer are a pure function of the score (a computed signal), so
// they follow edits without any bookkeeping. Nothing here touches the engraving or its cache.

import type { ReadonlySignal } from '@preact/signals';
import { computed, signal } from '@preact/signals';

import { findParallels } from '../src/analysis/parallels.ts';
import type { Ref } from '../src/editor/addr.ts';
import { eventOf, refKey } from '../src/editor/addr.ts';
import { headCenter } from '../src/editor/hit.ts';
import { must } from '../src/util.ts';
import { hit, score } from './state.ts';

/** One place a layer points at. */
export interface Finding {
  /** The id of the layer that found it. */
  layer: string;
  /** The measure and the tick in it where the finding starts. */
  mi: number;
  tick: number;
  /** The notes involved, as head refs. */
  refs: Ref[];
  /** Outlines to draw in the score: the heads at the corners of each, in drawing order. */
  shapes: Ref[][];
  /** An error is drawn in red, a warning in orange (for the parallels: a certain violation, and one that only some readings of the voice-leading give). */
  severity: 'error' | 'warn';
}

/** A layer: a title, and the findings it contributes while it is the chosen one. */
export interface Layer {
  id: string;
  /** The name in the Layers menu. */
  label: string;
  /** The tooltip of the menu entry. */
  title: string;
  /** Whether this is the chosen layer. */
  on: ReadonlySignal<boolean>;
  /** The findings, in score order; empty while the layer is off. */
  findings: ReadonlySignal<Finding[]>;
}

// The parallels layer: consecutive fifths and octaves.

/** The id of the chosen layer, or null for none. */
export const activeLayer = signal<string | null>(null);

const parallelsOn = computed(() => activeLayer.value === 'parallels');

/** The groups of consecutive fifths and octaves of the score as findings. */
const parallelFindings = computed<Finding[]>(() => {
  if (!parallelsOn.value) return [];
  return findParallels(score.value).map((g) => ({
    layer: 'parallels',
    mi: g.mi,
    tick: g.tick,
    refs: g.notes.map((n) => ({ t: 'ev', ...n.ev, pi: n.pi })),
    shapes: g.intervals.map((iv) => iv.notes.map((n) => ({ t: 'ev' as const, ...n.ev, pi: n.pi }))),
    severity: g.level === 'certain' ? ('error' as const) : ('warn' as const),
  }));
});

/** Whether the Layers menu is open. */
export const layersOpen = signal(false);

/** All layers, in the order of the Layers menu. */
export const layers: Layer[] = [
  {
    id: 'parallels',
    label: 'Parallels',
    title: 'Consecutive fifths and octaves',
    on: parallelsOn,
    findings: parallelFindings,
  },
];

/** The findings of all layers that are on, in score order. */
export const findings = computed<Finding[]>(() =>
  layers.flatMap((l) => l.findings.value).sort((a, b) => a.mi - b.mi || a.tick - b.tick),
);

/** Whether any layer is chosen. */
export const anyLayerOn = computed(() => layers.some((l) => l.on.value));

/** The colors the layers paint notes with: errors and warnings. */
export const LAYER_COLORS = { error: '#d6361f', warn: '#e08a00' };

/** What a note is painted for; an error wins over a warning. */
type Paint = keyof typeof LAYER_COLORS;

const RANK: Record<Paint, number> = { error: 2, warn: 1 };

/** The notes the layers paint, as `refKey`s with their color: the heads, and the events whose heads are all painted alike or by a finding (which are drawn whole, stem and flags too). */
export const layerNotes = computed(() => {
  const paint = new Map<string, Paint>();
  const put = (k: string, p: Paint) => {
    const old = paint.get(k);
    if (!old || RANK[p] > RANK[old]) paint.set(k, p);
  };
  for (const f of findings.value) for (const r of f.refs) put(refKey(r), f.severity);
  const sc = score.value;
  const heads = new Map<string, string>();
  const wholeEvents = new Map<string, string>();
  for (const [k, p] of paint) heads.set(k, LAYER_COLORS[p]);
  const seen = new Set<string>();
  for (const f of findings.value.flatMap((x) => x.refs)) {
    if (f.t !== 'ev') continue;
    const evKey = refKey({ ...f, pi: undefined });
    if (seen.has(evKey)) continue;
    seen.add(evKey);
    const e = eventOf(sc, f);
    if (e?.kind !== 'note') continue;
    const ps = e.pitches.map((_, pi) => paint.get(refKey({ ...f, pi })));
    if (ps.some((p) => !p)) continue;
    const top = ps.reduce((a, b) => (RANK[b as Paint] > RANK[a as Paint] ? b : a)) as Paint;
    if (top === 'error' || ps.every((p) => p === top)) wholeEvents.set(evKey, LAYER_COLORS[top]);
  }
  return { heads, wholeEvents };
});

// The outlines of the findings on the pages, and which one the pointer is over. The score pane draws the outlines and
// recolors the notes of the hovered one; hit-testing is done here, from the pointer handler, because the overlay
// does not take pointer events (it must not get in the way of selecting notes).

/** A point on a page, in staff spaces. */
type Pt = { x: number; y: number };

/** The part of an outline on one page: four corners, or the two heads of one attack when the outline runs over a system break. */
export interface ShapePart {
  /** The outline: the index of the finding and of the shape in it. */
  id: string;
  page: number;
  pts: Pt[];
  severity: Finding['severity'];
}

/** The parts of all outlines, where the heads are drawn. */
export const shapeParts = computed<ShapePart[]>(() => {
  const h = hit.value;
  if (!h) return [];
  const pageOf = (mi: number) => h.layout.measures.find((m) => m.mi === mi)?.page;
  const systemOf = (mi: number) => h.layout.systems.findIndex((s) => mi >= s.a && mi <= s.b);
  const out: ShapePart[] = [];
  findings.value.forEach((f, fi) => {
    f.shapes.forEach((sh, si) => {
      const ev = sh.flatMap((r) => (r.t === 'ev' ? [r] : []));
      if (ev.length !== 4) return;
      const centers = ev.map((r) => {
        const page = pageOf(r.mi);
        return page === undefined ? undefined : { page, at: headCenter(h, page, r, r.pi ?? 0) };
      });
      // A shape whose heads are in one system is drawn whole; one that runs over a break is drawn as the segments between the pairs of heads.
      const whole = ev.every((r) => systemOf(r.mi) === systemOf(ev[0].mi));
      const groups = whole
        ? [[0, 1, 2, 3]]
        : [
            [0, 1],
            [2, 3],
          ];
      for (const g of groups) {
        const cs = g.map((i) => centers[i]);
        const page = cs[0]?.page;
        if (page === undefined || !cs.every((c) => c?.at && c.page === page)) continue;
        out.push({ id: `${fi}:${si}`, page, pts: cs.map((c) => must(c?.at)), severity: f.severity });
      }
    });
  });
  return out;
});

/** The outline that the hovered position belongs to, as `${finding}:${shape}`, or null. */
export const hoverShape = signal<string | null>(null);

/** The outline with id `id`. */
export function shapeById(id: string): Ref[] | undefined {
  const [fi, si] = id.split(':').map(Number);
  return findings.peek()[fi]?.shapes[si];
}

/** The distance from `p` to the segment `a`-`b`. */
function segmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** The area of a polygon (shoelace formula); two points have none. */
function areaOf(pts: Pt[]): number {
  let s = 0;
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length];
    s += p.x * q.y - q.x * p.y;
  });
  return Math.abs(s) / 2;
}

/** Whether `p` is inside the polygon (even-odd rule). */
function inside(p: Pt, pts: Pt[]): boolean {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
    if (
      pts[i].y > p.y !== pts[j].y > p.y &&
      p.x < ((pts[j].x - pts[i].x) * (p.y - pts[i].y)) / (pts[j].y - pts[i].y) + pts[i].x
    )
      c = !c;
  return c;
}

/** How close to an outline (staff spaces) still counts as on it, so that thin outlines can be hit. */
const REACH = 0.4;

/** The outlines under the position, the smallest first: the one on top in a stack, since the larger ones around it are what stack under it. */
function shapesAt(page: number, x: number, y: number): string[] {
  const p = { x, y };
  const found: { id: string; area: number; d: number }[] = [];
  for (const part of shapeParts.peek()) {
    if (part.page !== page) continue;
    const pts = part.pts;
    const edges = pts.length === 2 ? [[pts[0], pts[1]]] : pts.map((a, i) => [a, pts[(i + 1) % pts.length]]);
    const d = inside(p, pts) ? 0 : Math.min(...edges.map(([a, b]) => segmentDistance(p, a, b)));
    if (d <= REACH) found.push({ id: part.id, area: areaOf(pts), d });
  }
  found.sort((a, b) => a.area - b.area || a.d - b.d);
  return found.map((f) => f.id);
}

// The outlines under the pointer and which of them is the hovered one. The smallest is chosen first; Alt + wheel
// steps through the others, so that an outline covered by smaller ones can still be reached. The choice is
// forgotten when the set of outlines under the pointer changes.

let under: string[] = [];
let cycle = 0;

/** Sets the hovered outline from `under` and `cycle`. */
function chooseHover(): void {
  const id = under.length ? under[cycle % under.length] : null;
  if (hoverShape.peek() !== id) hoverShape.value = id;
}

// A wheel gesture sends many events (high-resolution wheels and trackpads send several per notch), so the movement
// is added up and one step is taken per `WHEEL_STEP`, with a short pause after each step.

const WHEEL_STEP = 100;
const WHEEL_PAUSE = 150;
let wheelSum = 0;
let wheelLast = 0;

/** Takes a wheel movement `delta` (pixels) of a cycling gesture; returns false when there is no choice to cycle. */
export function wheelFinding(delta: number, now: number): boolean {
  if (under.length < 2) return false;
  if (now - wheelLast < WHEEL_PAUSE) return true;
  wheelSum += delta;
  if (Math.abs(wheelSum) >= WHEEL_STEP) {
    cycleFinding(wheelSum);
    wheelSum = 0;
    wheelLast = now;
  }
  return true;
}

/** Steps the hovered outline to the next (`dir` > 0) or previous one under the pointer; false when there is no choice. */
export function cycleFinding(dir: number): boolean {
  if (under.length < 2) return false;
  cycle = (cycle + (dir > 0 ? 1 : -1) + under.length) % under.length;
  chooseHover();
  return true;
}

/** Updates the hovered outline for a pointer over `at` (undefined when it is over no page). */
export function hoverFinding(at: { page: number; x: number; y: number } | undefined): void {
  const next = anyLayerOn.peek() && at ? shapesAt(at.page, at.x, at.y) : [];
  if (next.join() !== under.join()) cycle = 0;
  under = next;
  chooseHover();
}
