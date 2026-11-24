// The Expression pane's state and logic: what the pane shows (the playback of the score as bars with the expression of
// each note, the tempo and pedal curves), the pointer handling on its canvas and the actions of its toolbar. Everything that
// changes the score goes through the commands of src/editor/expression.ts and src/editor/performance.ts and is committed
// as one undoable step; a drag shows its result in `draft` and commits it when the pointer is released. Drawing is in
// exprDraw.ts and the component in Expression.tsx.

import { computed, signal } from '@preact/signals';
import type { Ref } from '../src/editor/addr.ts';
import { EditError } from '../src/editor/commands.ts';
import type { HeadInfo, HeadRef, RampShape } from '../src/editor/expression.ts';
import * as X from '../src/editor/expression.ts';
import type { CurveName } from '../src/editor/performance.ts';
import * as P from '../src/editor/performance.ts';
import type { Pitch, Score } from '../src/model.ts';
import { beatOf, PPQ, timeAt } from '../src/model.ts';
import type { HeadAt, Note, Sequence } from '../src/playback/sequence.ts';
import { buildSequence, measureStarts } from '../src/playback/sequence.ts';
import { select } from './interact.ts';
import { seek } from './player.ts';
import { commit, exprView, run, say, score, selection } from './state.ts';

// The settings of the pane and what it derives from the score: the value lane that is open, the score as it is
// shown (with the drag in progress), and the bars and curves drawn from it. As in Pianizer, the three curve lanes
// (tempo, sustain, una corda) are always in view under the roll, so that notes and pedals are edited together; the values
// of the notes (velocity, shift, gate) are seen in the roll itself and set with tools (tool windows) on the selection.

/** Every curve lane of the pane. */
type Lane = 'tempo' | 'sustain' | 'soft';

/** The curve lanes under the roll, top to bottom. */
export const CURVE_LANES: { id: Lane; label: string; title: string }[] = [
  { id: 'tempo', label: 'Tempo', title: 'A ratio on the notated tempo over the piece' },
  { id: 'sustain', label: 'Sustain', title: 'The sustain pedal over the piece' },
  { id: 'soft', label: 'Una corda', title: 'Where the soft pedal is down' },
];

/** The score with the change a drag in progress would make; null when nothing is being dragged. */
export const draft = signal<Score | null>(null);

/** The score the pane shows: the draft while there is one. */
const shown = computed(() => draft.value ?? score.value);

/** The playback of the shown score. */
export const seq = computed(() => buildSequence(shown.value));

/** What every head sounds like in the shown score. */
export const infos = computed(() => X.headInfos(shown.value, seq.value));

/** The keys of the selected heads. */
export const selected = computed(() => new Set(X.selectedHeads(score.value, selection.value).map(X.headKey)));

/** The selected curve point or una corda region. */
export const pointSel = signal<{ lane: 'tempo' | 'sustain' | 'soft'; index: number } | null>(null);

/** A sounding note as the roll draws it: from where it is heard to where it ends (ticks). */
export interface Bar {
  key: string;
  head: HeadAt;
  midi: number;
  t0: number;
  t1: number;
  vel: number;
}

/** The bars in order of their start, with the greatest end among the bars before each one (to find the first one in view), and the lowest and highest pitch. */
export interface RollData {
  bars: Bar[];
  maxEnd: number[];
  lo: number;
  hi: number;
}

/** The pitches of a piano's 88 keys, A0 to C8: the roll's rows, more only for notes beyond them. */
const PIANO_LO = 21;

const PIANO_HI = 108;

/** The tick a note is heard at: its notated start moved by its shift at the local tempo. */
function shownTick(s: Sequence, n: Note): number {
  if (!n.shift) return n.start;
  const d = PPQ / 16;
  const secPerTick = (s.tickToSec(n.start + d) - s.tickToSec(n.start)) / d;
  return n.start + n.shift / 1000 / secPerTick;
}

export const roll = computed<RollData>(() => {
  const s = seq.value;
  const bars: Bar[] = [];
  for (const n of s.notes) {
    if (!n.head) continue;
    const t0 = shownTick(s, n);
    bars.push({
      key: X.headKey(n.head),
      head: n.head,
      midi: n.midi,
      t0,
      t1: Math.max(t0 + PPQ / 32, n.end),
      vel: n.vel,
    });
  }
  bars.sort((a, b) => a.t0 - b.t0);
  const maxEnd: number[] = [];
  let reach = 0;
  for (const b of bars) {
    reach = Math.max(reach, b.t1);
    maxEnd.push(reach);
  }
  const midis = bars.map((b) => b.midi);
  return { bars, maxEnd, lo: Math.min(PIANO_LO, ...midis), hi: Math.max(PIANO_HI, ...midis) };
});

/** A measure of the piece: where it starts, its length and the length of its beat (ticks). */
export interface MeasureSpan {
  start: number;
  len: number;
  beat: number;
}

export const measures = computed<MeasureSpan[]>(() => {
  const sc = shown.value;
  const { measureStart, total } = measureStarts(sc);
  return measureStart.map((start, mi) => ({
    start,
    len: (measureStart[mi + 1] ?? total) - start,
    beat: (PPQ * 4) / timeAt(sc, mi).beatType,
  }));
});

/** The curves of the shown score in absolute ticks. */
export const curves = computed(() => ({
  tempo: P.curveTicks(shown.value, 'tempo'),
  sustain: P.curveTicks(shown.value, 'sustain'),
  soft: P.softTicks(shown.value),
}));

/** The total length of the piece in ticks. */
export const total = computed(() => seq.value.totalTicks);

// Geometry: where the parts of the canvas are, and the conversions between ticks and pixels, pitches and rows, values and
// heights. The canvas is the ruler on top, the roll, then the three curve lanes; the labels sit in a
// gutter on the left.

export const GUTTER = 64;
const RULER_H = 22;

/** The heights the lanes have when there is room, top to bottom: tempo, sustain, una corda (as in Pianizer). */
const LANE_HEIGHTS = [150, 75, 24];

/** The least height of the roll; the lanes give way before it does. */
const ROLL_MIN = 80;

/** The spacing scale of the stylesheet (`--sp-1`, `--sp-2`) in pixels: the canvas uses the same margins and paddings as the controls around it. */
export const SP1 = 6;

export const SP2 = 10;

/** The room between the lanes. */
const LANE_GAP = SP1;

/** The room between the parts of the canvas. */
const GAP = SP2;

/** The inner margin of the lane, so that the extreme values are not on its edge. */
const LANE_PAD = SP2;

/** A band of the canvas: its top row and height. */
export interface Rect {
  y: number;
  h: number;
}

export interface Geo {
  w: number;
  h: number;
  ruler: Rect;
  roll: Rect;
  tempo: Rect;
  sustain: Rect;
  soft: Rect;
}

/** The bands that hold lanes, with the lane each one is. */
export const laneRects = (g: Geo): { id: Lane; r: Rect }[] => [
  { id: 'tempo', r: g.tempo },
  { id: 'sustain', r: g.sustain },
  { id: 'soft', r: g.soft },
];

/** The lane at pixel row `y`, if any. */
const laneAt = (g: Geo, y: number): Lane | undefined => laneRects(g).find((l) => y >= l.r.y && y < l.r.y + l.r.h)?.id;

/** The parts of a canvas of `w` by `h` pixels. */
export function geo(w: number, h: number): Geo {
  const want = LANE_HEIGHTS.reduce((a, b) => a + b, 0);
  const room = Math.max(0, h - RULER_H - GAP - ROLL_MIN - 2 * LANE_GAP);
  const k = Math.min(1, Math.max(0.4, room / want));
  const hs = LANE_HEIGHTS.map((x) => Math.round(x * k));
  const top = h - hs.reduce((a, b) => a + b, 0) - 2 * LANE_GAP;
  return {
    w,
    h,
    ruler: { y: 0, h: RULER_H },
    roll: { y: RULER_H, h: Math.max(0, top - RULER_H - GAP) },
    tempo: { y: top, h: hs[0] },
    sustain: { y: top + hs[0] + LANE_GAP, h: hs[1] },
    soft: { y: top + hs[0] + hs[1] + 2 * LANE_GAP, h: hs[2] },
  };
}

/** The tick at pixel `x`. */
const tickAt = (x: number): number => exprView.peek().left + ((x - GUTTER) * PPQ) / exprView.peek().ppq;

/** The pixel of a tick under the view `v`. */
export const xOf = (tick: number, v = exprView.value): number => GUTTER + ((tick - v.left) * v.ppq) / PPQ;

/** The height of a pitch row in pixels. It is fixed, as on a piano roll: zooming changes only the width of the notes. */
export const ROW_H = 17;

/**
 * The gap between the boxes of adjacent rows: a pixel below a box, the pixel of the row line (the one under a C, where
 * there is one) and a pixel above the next box, so that a box has a pixel of room to the C line on both sides.
 */
export const BOX_GAP = 3;

/** The distance of a box from the top of its row: the pixel of the row line and the pixel of room. */
export const BOX_TOP = 2;

/** The size of the velocity numbers in the note boxes, and the padding around them, which is the same on every side (the box is as high as the number and twice the padding). */
export const LABEL_FONT = 10;

export const LABEL_PAD = 4;

/** The scroll of the roll (pixels from its highest pitch) held within what there is to see. */
const clampTop = (g: Geo, data: RollData, top: number): number =>
  Math.max(0, Math.min((data.hi - data.lo + 1) * ROW_H - g.roll.h, top));

/** The pixel row of the top of the roll row of pitch `midi`, with the roll scrolled by `top`; the rows are `ROW_H` high. */
export const rollRow = (g: Geo, data: RollData, top: number, midi: number): number =>
  g.roll.y + (data.hi - midi) * ROW_H - top;

/** The pitch at pixel row `y` of the roll. */
const midiAt = (g: Geo, data: RollData, top: number, y: number): number =>
  data.hi - Math.floor((y - g.roll.y + top) / ROW_H);

/** The lowest and highest pitch that have a row in view. */
export function visiblePitches(g: Geo, data: RollData, top: number): { lo: number; hi: number } {
  return {
    hi: data.hi - Math.floor(top / ROW_H),
    lo: Math.max(data.lo, data.hi - Math.ceil((top + g.roll.h) / ROW_H) + 1),
  };
}

/** The scroll that puts pitch `midi` in the middle of the roll. */
const centeredOn = (g: Geo, data: RollData, midi: number): number =>
  clampTop(g, data, (data.hi - midi + 0.5) * ROW_H - g.roll.h / 2);

/** Scrolls the roll to the middle of the pitches at the start of the piece the first time it has a size (`top` is negative until then). */
export function placeView(g: Geo): void {
  const v = exprView.peek();
  const data = roll.peek();
  if (v.top >= 0 || !g.roll.h || !data.bars.length) return;
  // The middle of the pitches in the first screenful (all of them if that has no notes).
  const right = v.left + ((g.w - GUTTER) * PPQ) / v.ppq;
  const near = data.bars.filter((b) => b.t0 <= right);
  const midis = (near.length ? near : data.bars).map((b) => b.midi);
  exprView.value = { ...v, top: centeredOn(g, data, (Math.min(...midis) + Math.max(...midis)) / 2) };
}

/** What a lane's vertical axis shows: the range, where the labels and lines go, and how a value reads. */
export interface Scale {
  min: number;
  max: number;
  marks: number[];
  /** Where the areas start from. */
  base: number;
  fmt: (v: number) => string;
}

/** The scale of a curve lane. */
export function scaleOf(l: Lane): Scale {
  switch (l) {
    case 'tempo':
      return { min: 0.7, max: 1.3, marks: [0.8, 1, 1.2], base: 1, fmt: (v) => `${Math.round(v * 100)}%` };
    case 'sustain':
      return { min: 0, max: 1, marks: [0, 0.5, 1], base: 0, fmt: (v) => `${Math.round(v * 100)}%` };
    case 'soft':
      return { min: 0, max: 1, marks: [], base: 0, fmt: String };
  }
}

/** The margin inside a band, so that the extreme values are not on its edge: one step of the spacing scale, the smaller one in a low band. */
export const padOf = (r: Rect): number => (r.h >= 48 ? LANE_PAD : SP1);

/** The pixel row of `value` in the band `r`. */
export const yOfValue = (r: Rect, s: Scale, value: number): number =>
  r.y + r.h - padOf(r) - ((value - s.min) / (s.max - s.min)) * (r.h - 2 * padOf(r));

/** The value at pixel row `y` of the band `r`. */
const valueAt = (r: Rect, s: Scale, y: number): number =>
  s.min + ((r.y + r.h - padOf(r) - y) / (r.h - 2 * padOf(r))) * (s.max - s.min);

// What is under the pointer, and the text that goes with it.

export type Hover =
  | { kind: 'bar'; key: string }
  | { kind: 'point'; lane: 'tempo' | 'sustain'; index: number }
  | { kind: 'region'; index: number; edge?: 'from' | 'to' };

export const hover = signal<Hover | null>(null);

/** The tooltip over the canvas: its place in the canvas and its text. */
export const tip = signal<{ x: number; y: number; text: string } | null>(null);

/** The mouse cursor over the canvas. */
export const cursor = signal('default');

/** The rectangle of a selection in progress, in pixels. */
export const marquee = signal<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** The name of a MIDI pitch in capitals, like `C4` or `F#3`; a written pitch gives its own spelling (`Bb3`). */
export const pitchName = (midi: number, written?: Pitch): string => {
  if (!written) return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
  const acc = written.alter > 0 ? '#'.repeat(written.alter) : 'b'.repeat(-written.alter);
  return `${written.step.toUpperCase()}${acc}${written.octave}`;
};

/** A number as short text (at most one decimal). */
const num = (v: number): string => String(Math.round(v * 10) / 10);

/** The text over a head: pitch, place, and what it sounds like with where each value comes from. */
function headTip(i: HeadInfo): string {
  const start = seq.peek().measureStart[i.head.mi] ?? 0;
  const set = (on: boolean) => (on ? '' : ' (from notation)');
  return [
    `${pitchName(i.midi, i.written)} · m. ${i.head.mi + 1} beat ${beatOf(i.at - start)}`,
    `velocity ${i.vel}${set(i.has.vel)}`,
    `shift ${i.shift > 0 ? '+' : ''}${num(i.shift)} ms${set(i.has.shift)}`,
    `gate ${i.gate}${set(i.has.gate)}`,
  ].join(' · ');
}

/** The head with `key` in the shown infos. */
const infoOf = (key: string): HeadInfo | undefined => infos.peek().find((i) => i.key === key);

// The view: panning, zooming and following the playhead.

/** The smallest and largest zoom, in pixels per quarter note. */
const PPQ_MIN = 4;

const PPQ_MAX = 400;

/** Moves the view by `dx` pixels. */
export function panBy(dx: number): void {
  const v = exprView.peek();
  exprView.value = { ...v, left: Math.max(-PPQ, Math.min(total.peek(), v.left + (dx * PPQ) / v.ppq)) };
}

/** Zooms by `factor` around pixel `x` (the tick under it stays there). */
export function zoomAt(factor: number, x: number): void {
  const v = exprView.peek();
  const ppq = Math.max(PPQ_MIN, Math.min(PPQ_MAX, v.ppq * factor));
  const tick = tickAt(x);
  exprView.value = { ...v, ppq, left: tick - ((x - GUTTER) * PPQ) / ppq };
}

/** Scrolls the roll by `dy` pixels (positive: towards lower pitches). */
export function scrollBy(g: Geo, dy: number): void {
  const v = exprView.peek();
  exprView.value = { ...v, top: clampTop(g, roll.peek(), v.top + dy) };
}

/** Moves the view at once so that the tick and pitch of `spot` are in the middle of the roll. */
export function centerOn(g: Geo, spot: { tick: number; midi: number }): void {
  const v = exprView.peek();
  exprView.value = {
    ...v,
    left: spot.tick - (((g.w - GUTTER) / 2) * PPQ) / v.ppq,
    top: centeredOn(g, roll.peek(), spot.midi),
  };
}

/** Moves the view the least that brings `tick` into the middle part of the canvas (width `w`). */
export function reveal(tick: number, w: number): void {
  const v = exprView.peek();
  const x = xOf(tick, v);
  if (x > GUTTER + 24 && x < w - 24) return;
  exprView.value = { ...v, left: tick - ((w - GUTTER) * 0.3 * PPQ) / v.ppq };
}

/** The first selected head's tick and pitch, if any (for bringing it into view). */
export function selectionSpot(): { tick: number; midi: number; ref: Ref } | undefined {
  const keys = selected.peek();
  const first = infos.peek().find((i) => keys.has(i.key));
  return first && { tick: first.note.start, midi: first.midi, ref: refOf(first.head) };
}

// Pointer handling. A press starts a gesture (`drag`), moves update it and the release finishes it. Gestures that change
// the score show the change in `draft` and commit it once at the end.

type Drag =
  | { kind: 'seek' }
  | {
      kind: 'pan';
      x0: number;
      y0: number;
      left0: number;
      top0: number;
      remove?: { lane: Lane; x: number; y: number };
    }
  | { kind: 'marquee'; x0: number; y0: number; additive: boolean; base: Ref[] }
  | { kind: 'point'; lane: CurveName; index: number; base: Score; moved: boolean }
  | {
      kind: 'region';
      mode: 'new' | 'move' | 'from' | 'to';
      index: number;
      base: Score;
      at: number;
      from: number;
      to: number;
      moved: boolean;
    };

let drag: Drag | null = null;

/** The pixel distance within which a point, edge or handle is grabbed. */
const GRAB = 7;

/** The snap grids of the curve lanes in ticks (0: none), as in Pianizer. */
export const SNAPS: { value: number; label: string }[] = [
  { value: PPQ * 4, label: '1/1' },
  { value: PPQ * 2, label: '1/2' },
  { value: PPQ, label: '1/4' },
  { value: PPQ / 2, label: '1/8' },
  { value: (PPQ * 2) / 3, label: '1/8T' },
  { value: PPQ / 4, label: '1/16' },
  { value: PPQ / 3, label: '1/16T' },
  { value: PPQ / 8, label: '1/32' },
  { value: PPQ / 6, label: '1/32T' },
  { value: PPQ / 16, label: '1/64' },
  { value: PPQ / 12, label: '1/64T' },
  { value: 0, label: 'Off' },
];

export const snap = signal(PPQ / 2);

/** The tick at pixel `x`, snapped to the grid (counted from the barline of its measure) unless `free`, within the piece. */
function tickOfX(x: number, free: boolean): number {
  const tick = tickAt(x);
  const g = snap.peek();
  const ms = measures.peek();
  if (free || !g || !ms.length) return Math.max(0, Math.round(tick));
  let lo = 0;
  let hi = ms.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ms[mid].start <= tick) lo = mid;
    else hi = mid - 1;
  }
  const m = ms[lo];
  return Math.max(0, Math.min(m.start + m.len, m.start + Math.round((tick - m.start) / g) * g));
}

/** The value of a curve at a pixel row, snapped to steps (10% for the tempo, 25% for the pedal) unless `free`. */
function curveValueAt(l: CurveName, g: Geo, y: number, free: boolean): number {
  const v = valueAt(g[l], scaleOf(l), y);
  const raw = Math.max(l === 'tempo' ? 0.7 : 0, Math.min(l === 'tempo' ? 1.3 : 1, v));
  if (free) return P.curveValue(l, Math.round(raw * 100) / 100);
  const step = l === 'tempo' ? 0.1 : 0.25;
  return P.curveValue(l, Math.round(Math.round(raw / step) * step * 100) / 100);
}

/** The refs that select a head. */
const refOf = (h: HeadAt | HeadRef): Ref => ({
  t: 'ev',
  mi: h.mi,
  staff: h.staff,
  voice: h.voice,
  idx: h.idx,
  pi: h.pi,
});

/** The bar at pixel (x, y) of the roll: the topmost one. */
function barAt(g: Geo, x: number, y: number): Bar | undefined {
  const data = roll.peek();
  const tick = tickAt(x);
  const slack = (2 * PPQ) / exprView.peek().ppq;
  const midi = midiAt(g, data, exprView.peek().top, y);
  let found: Bar | undefined;
  for (const b of data.bars) {
    if (b.t0 > tick + slack) break;
    if (b.t1 >= tick - slack && b.midi === midi) found = b;
  }
  return found;
}

/** The point of a curve under the pointer. */
function pointAt(g: Geo, l: CurveName, x: number, y: number): number {
  const sc = scaleOf(l);
  let best = -1;
  let bestD = GRAB + 1;
  curves.peek()[l].forEach((p, i) => {
    const d = Math.hypot(xOf(p.tick) - x, yOfValue(g[l], sc, p.value) - y);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

/** The una corda region under the pointer, and whether the pointer is at its start or end. */
function regionAt(x: number): { index: number; edge?: 'from' | 'to' } | undefined {
  const rs = curves.peek().soft;
  for (let i = 0; i < rs.length; i++) {
    const a = xOf(rs[i].from);
    const b = xOf(rs[i].to);
    if (Math.abs(x - a) <= GRAB) return { index: i, edge: 'from' };
    if (Math.abs(x - b) <= GRAB) return { index: i, edge: 'to' };
    if (x > a && x < b) return { index: i };
  }
  return undefined;
}

/** Sets the draft from a recipe on the score the gesture started from; a refusal leaves the draft as it was. */
function setDraft(recipe: () => Score): void {
  try {
    draft.value = recipe();
  } catch (e) {
    if (!(e instanceof EditError)) throw e;
  }
}

/** Ends a gesture that changed the score: commits the draft as one undoable step. */
function finishDraft(): void {
  const d = draft.peek();
  draft.value = null;
  if (d) commit(d);
}

/** Presses in a curve lane: grabs a point, or adds one where the pointer is and starts moving it. */
function pressCurve(l: CurveName, g: Geo, x: number, y: number, free: boolean): void {
  const base = score.peek();
  let index = pointAt(g, l, x, y);
  let from = base;
  if (index < 0) {
    const tick = tickOfX(x, free);
    from = P.setCurvePoint(base, l, tick, curveValueAt(l, g, y, free));
    index = P.curveTicks(from, l).findIndex((p) => Math.abs(p.tick - tick) <= 1);
    draft.value = from;
  }
  pointSel.value = { lane: l, index };
  drag = { kind: 'point', lane: l, index, base: from, moved: false };
}

/** Presses in the una corda lane: grabs an edge or the body of a region, or starts a new one. */
function pressSoft(x: number, free: boolean): void {
  const base = score.peek();
  const at = regionAt(x);
  const tick = tickOfX(x, free);
  if (at) {
    const r = curves.peek().soft[at.index];
    pointSel.value = { lane: 'soft', index: at.index };
    drag = {
      kind: 'region',
      mode: at.edge ?? 'move',
      index: at.index,
      base,
      at: tick,
      from: r.from,
      to: r.to,
      moved: false,
    };
    return;
  }
  drag = { kind: 'region', mode: 'new', index: -1, base, at: tick, from: tick, to: tick, moved: false };
}

/** Handles a press at canvas pixel (x, y). Returns whether the canvas should capture the pointer. */
export function onDown(g: Geo, x: number, y: number, button: number, shift: boolean, free: boolean): boolean {
  if (button !== 0) {
    // A right press that does not move removes the point or region nearest to it in a curve lane (as in Pianizer); one that moves pans.
    const l = x >= GUTTER && button === 2 ? laneAt(g, y) : undefined;
    const remove = l ? { lane: l, x, y } : undefined;
    drag = { kind: 'pan', x0: x, y0: y, left0: exprView.peek().left, top0: exprView.peek().top, remove };
    return true;
  }
  if (x < GUTTER) return false;
  if (y < g.ruler.h) {
    seek(tickOfX(x, free));
    drag = { kind: 'seek' };
    return true;
  }
  if (y < g.roll.y + g.roll.h) {
    const bar = barAt(g, x, y);
    pointSel.value = null;
    if (bar) {
      select([refOf(bar.head)], shift);
      return true;
    }
    drag = { kind: 'marquee', x0: x, y0: y, additive: shift, base: selection.peek() };
    return true;
  }
  const l = laneAt(g, y);
  if (!l) return false;
  if (l === 'soft') pressSoft(x, free);
  else pressCurve(l, g, x, y, free);
  return true;
}

/** The refs of the heads inside a rectangle of the roll. */
function headsIn(g: Geo, x0: number, y0: number, x1: number, y1: number): Ref[] {
  const [xa, xb] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [ya, yb] = [Math.min(y0, y1), Math.max(y0, y1)];
  const out = new Map<string, Ref>();
  const data = roll.peek();
  const top = exprView.peek().top;
  for (const b of data.bars) {
    if (xOf(b.t0) > xb) break;
    const y = rollRow(g, data, top, b.midi);
    if (xOf(b.t1) >= xa && y + ROW_H >= ya && y <= yb) out.set(b.key, refOf(b.head));
  }
  return [...out.values()];
}

/** Handles the pointer moving to canvas pixel (x, y); `buttons` are the buttons held. */
export function onMove(g: Geo, x: number, y: number, buttons: number, free: boolean): void {
  if (!drag) {
    updateHover(g, x, y);
    return;
  }
  if (!buttons) return;
  tip.value = null;
  switch (drag.kind) {
    case 'seek':
      seek(tickOfX(x, free));
      break;
    case 'pan':
      exprView.value = {
        ...exprView.peek(),
        left: drag.left0 - ((x - drag.x0) * PPQ) / exprView.peek().ppq,
        top: clampTop(g, roll.peek(), drag.top0 - (y - drag.y0)),
      };
      break;
    case 'marquee':
      marquee.value = { x0: drag.x0, y0: drag.y0, x1: x, y1: y };
      break;
    case 'point':
      movePoint(drag, g, x, y, free);
      break;
    case 'region':
      moveRegion(drag, x, y, free);
      break;
  }
}

/** Moves the grabbed point of a curve. */
function movePoint(d: Extract<Drag, { kind: 'point' }>, g: Geo, x: number, y: number, free: boolean): void {
  d.moved = true;
  const tick = tickOfX(x, free);
  const value = curveValueAt(d.lane, g, y, free);
  setDraft(() => P.moveCurvePoint(d.base, d.lane, d.index, tick, value));
  tip.value = { x, y, text: `${scaleOf(d.lane).fmt(value)} at ${placeOf(tick)}` };
}

/** Moves, resizes or paints the una corda region of a drag. */
function moveRegion(d: Extract<Drag, { kind: 'region' }>, x: number, y: number, free: boolean): void {
  const tick = tickOfX(x, free);
  if (tick !== d.at) d.moved = true;
  if (!d.moved) return;
  const dt = tick - d.at;
  const [a, b] = {
    new: [d.at, tick],
    move: [d.from + dt, d.to + dt],
    from: [tick, d.to],
    to: [d.from, tick],
  }[d.mode];
  tip.value = { x, y, text: `${placeOf(Math.min(a, b))} – ${placeOf(Math.max(a, b))}` };
  setDraft(() => {
    if (d.mode === 'new') return P.addSoftRegion(d.base, d.at, tick);
    if (d.mode === 'move') return P.setSoftRegion(d.base, d.index, d.from + dt, d.to + dt);
    if (d.mode === 'from') return P.setSoftRegion(d.base, d.index, tick, d.to);
    return P.setSoftRegion(d.base, d.index, d.from, tick);
  });
}

/** Removes the point of a curve lane, or the una corda region, nearest to pixel (x, y), if one is within reach. */
function removeNearest(g: Geo, l: Lane, x: number, y: number): void {
  pointSel.value = null;
  if (l === 'soft') {
    const at = regionAt(x);
    if (at) run((s) => P.removeSoftRegions(s, [at.index]));
    return;
  }
  // The pointer is not on the point itself (a click there would be a grab), so the reach is wider than for a grab.
  const sc = scaleOf(l);
  let best = -1;
  let bestD = GRAB * 3;
  curves.peek()[l].forEach((p, i) => {
    const d = Math.hypot(xOf(p.tick) - x, yOfValue(g[l], sc, p.value) - y);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  });
  if (best >= 0) run((s) => P.removeCurvePoints(s, l, [best]));
}

/** Handles the release of the pointer. */
export function onUp(g: Geo, x: number, y: number): void {
  const d = drag;
  drag = null;
  marquee.value = null;
  tip.value = null;
  if (!d) return;
  if (d.kind === 'pan') {
    if (d.remove && Math.hypot(x - d.x0, y - d.y0) <= 3) removeNearest(g, d.remove.lane, x, y);
    return;
  }
  if (d.kind === 'marquee') {
    const moved = Math.hypot(x - d.x0, y - d.y0) > 3;
    if (!moved) {
      if (!d.additive) selection.value = [];
      return;
    }
    const found = headsIn(g, d.x0, d.y0, x, y);
    selection.value = d.additive ? [...d.base, ...found.filter((f) => !d.base.some((b) => sameRef(b, f)))] : found;
    return;
  }
  if (d.kind === 'region') {
    if (!d.moved && d.mode === 'new') setDraft(() => P.addSoftRegion(d.base, d.at, d.at + (snap.peek() || PPQ / 2)));
    const kept = draft.peek();
    finishDraft();
    if (kept) {
      const at = P.softTicks(score.peek()).findIndex((r) => r.from <= d.at + (d.to - d.from) && r.to >= d.at);
      pointSel.value = at >= 0 ? { lane: 'soft', index: at } : null;
    }
    return;
  }
  if (d.kind === 'point') finishDraft();
}

/** Whether two refs name the same head. */
const sameRef = (a: Ref, b: Ref): boolean =>
  a.t === 'ev' &&
  b.t === 'ev' &&
  a.mi === b.mi &&
  a.staff === b.staff &&
  a.voice === b.voice &&
  a.idx === b.idx &&
  a.pi === b.pi;

/** Ends whatever the pointer was doing without keeping it (Escape). */
export function cancel(): void {
  drag = null;
  marquee.value = null;
  draft.value = null;
}

/** Whether a gesture is under way. */
export const dragging = (): boolean => drag !== null;

/** Sets the hover, the cursor and the tooltip for a pointer at (x, y) with no button down. */
function updateHover(g: Geo, x: number, y: number): void {
  hover.value = null;
  tip.value = null;
  cursor.value = 'default';
  if (x < GUTTER) return;
  if (y < g.ruler.h) {
    cursor.value = 'pointer';
    return;
  }
  if (y < g.roll.y + g.roll.h) {
    const bar = barAt(g, x, y);
    if (!bar) return;
    hover.value = { kind: 'bar', key: bar.key };
    cursor.value = 'pointer';
    const i = infoOf(bar.key);
    if (i) tip.value = { x, y, text: headTip(i) };
    return;
  }
  const l = laneAt(g, y);
  if (!l) return;
  if (l === 'soft') {
    const r = regionAt(x);
    if (r) {
      hover.value = { kind: 'region', ...r };
      cursor.value = r.edge ? 'ew-resize' : 'move';
    } else cursor.value = 'crosshair';
  } else {
    const i = pointAt(g, l, x, y);
    if (i >= 0) {
      hover.value = { kind: 'point', lane: l, index: i };
      cursor.value = 'move';
      const p = curves.peek()[l][i];
      tip.value = { x, y, text: `${scaleOf(l).fmt(p.value)} at ${placeOf(p.tick)}` };
    } else cursor.value = 'crosshair';
  }
}

/** A tick as `m. <N> beat <b>`. */
export function placeOf(tick: number): string {
  const ms = measures.peek();
  let lo = 0;
  let hi = Math.max(0, ms.length - 1);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ms[mid].start <= tick) lo = mid;
    else hi = mid - 1;
  }
  return `m. ${lo + 1} beat ${beatOf(tick - (ms[lo]?.start ?? 0))}`;
}

/** Called when the pointer leaves the canvas. */
export function onLeave(): void {
  if (drag) return;
  hover.value = null;
  tip.value = null;
}

// The actions of the toolbar and the keys, on the selected heads and the selected curve point.

/** The selected heads. */
export const selectedHeads = (): HeadRef[] => X.selectedHeads(score.peek(), selection.peek());

/** Runs `fn` on the selected heads; with none selected, says so. */
function onHeads(fn: (s: Score, heads: HeadRef[]) => Score): void {
  const heads = selectedHeads();
  if (!heads.length) {
    say('Select the notes first', true);
    return;
  }
  run((s) => fn(s, heads));
}

/** Set (or, with null, clear) the velocity of the selected notes. */
export const setVelocity = (v: number | null): void => onHeads((s, h) => X.setVelocity(s, h, v));

/** Set (or, with null, clear) the shift in milliseconds of the selected notes. */
export const setShift = (ms: number | null): void => onHeads((s, h) => X.setShift(s, h, ms));

/** Set (or, with null, clear) the gate factor of the selected notes. */
export const setGate = (g: number | null): void => onHeads((s, h) => X.setGate(s, h, g));

/** Raise or lower the velocity of the selected notes by a delta. */
export const nudgeVelocity = (d: number): void => onHeads((s, h) => X.nudgeVelocity(s, h, d));

/** Move the attack of the selected notes by a delta in milliseconds. */
export const nudgeShift = (d: number): void => onHeads((s, h) => X.nudgeShift(s, h, d));

/** Nudges the gate of the selected heads by `d`. */
export function nudgeGate(d: number): void {
  const keys = selected.peek();
  const entries = infos.peek().filter((i) => keys.has(i.key));
  if (!entries.length) {
    say('Select the notes first', true);
    return;
  }
  run((s) =>
    X.setHeadValues(
      s,
      entries.map((i) => ({ head: i.head, values: { gate: i.gate + d } })),
    ),
  );
}

/** The settings of the velocity ramp and the chord roll. */
export const rampShape = signal<RampShape>('s-curve');

export const rollSpan = signal(60);
export const rollDir = signal<'up' | 'down'>('up');
export const rollAnchor = signal<'first' | 'last'>('first');

/** Gives the selected notes velocities along a ramp from `from` to `to`, in the chosen shape. */
export const applyRamp = (from: number, to: number): void =>
  onHeads((s, h) => X.rampVelocity(s, h, from, to, rampShape.peek()));

/** Rolls the chords among the selected notes. */
export const applyRoll = (): void =>
  onHeads((s, h) => X.rollChord(s, h, { span: rollSpan.peek(), dir: rollDir.peek(), anchor: rollAnchor.peek() }));

/** Takes one value (velocity, shift or gate) off the selected notes, so that the notation decides again. */
export function resetHeads(which: 'vel' | 'shift' | 'gate'): void {
  onHeads((s, h) => X.resetExpression(s, h, [which]));
}

/** Removes the selected curve point or region. */
function removePoint(): boolean {
  const p = pointSel.peek();
  if (!p) return false;
  pointSel.value = null;
  run((s) => (p.lane === 'soft' ? P.removeSoftRegions(s, [p.index]) : P.removeCurvePoints(s, p.lane, [p.index])));
  return true;
}

/** Sets the value of the selected curve point. */
export function setPointValue(v: number): void {
  const p = pointSel.peek();
  if (!p || p.lane === 'soft') return;
  const pt = P.curveTicks(score.peek(), p.lane)[p.index];
  if (pt) run((s) => P.setCurvePoint(s, p.lane as CurveName, pt.tick, v));
}

/** Handles a key pressed on the canvas. Returns whether it was used (then it must not reach the global shortcuts). */
export function onKey(e: KeyboardEvent): boolean {
  const onPoint = pointSel.peek() !== null;
  if (e.key === 'Escape') {
    if (!(drag || pointSel.peek())) return false;
    cancel();
    pointSel.value = null;
    return true;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    return onPoint ? removePoint() : false;
  }
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return false;
  const dir = e.key === 'ArrowUp' ? 1 : -1;
  const big = e.shiftKey ? 10 : 1;
  if (!onPoint) nudgeVelocity(dir * big);
  else {
    const p = pointSel.peek();
    const pt = p && p.lane !== 'soft' ? P.curveTicks(score.peek(), p.lane)[p.index] : undefined;
    if (p && pt && p.lane !== 'soft')
      setPointValue(pt.value + dir * (p.lane === 'tempo' ? 0.01 : 0.05) * (e.shiftKey ? 5 : 1));
  }
  return true;
}

/** The value all selected heads share in the open lane, `'mixed'` when they differ, undefined when none is selected. */
export function sharedValue(which: 'vel' | 'shift' | 'gate'): number | 'mixed' | undefined {
  const keys = selected.value;
  const xs = infos.value.filter((i) => keys.has(i.key)).map((i) => i[which]);
  if (!xs.length) return undefined;
  return xs.every((x) => x === xs[0]) ? xs[0] : 'mixed';
}

/** The value of the selected curve point. */
export function pointValue(): number | undefined {
  const p = pointSel.value;
  return p && p.lane !== 'soft' ? curves.value[p.lane][p.index]?.value : undefined;
}
