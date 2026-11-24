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
import type { Score } from '../src/model.ts';
import { beatOf, PPQ, timeAt } from '../src/model.ts';
import type { HeadAt, Note, Sequence } from '../src/playback/sequence.ts';
import { buildSequence, measureStarts } from '../src/playback/sequence.ts';
import { select } from './interact.ts';
import { seek } from './player.ts';
import { commit, exprView, run, say, score, selection } from './state.ts';

// The settings of the pane and what it derives from the score: the lane that is open, the snap grid, the score as it is
// shown (with the drag in progress), and the bars, stems and curves drawn from it.

/** The lane below the roll: the value of the notes' velocity, shift or gate, or one of the three curves. */
export type Lane = 'velocity' | 'shift' | 'gate' | 'tempo' | 'sustain' | 'soft';

export const LANES: { id: Lane; label: string; title: string }[] = [
  { id: 'velocity', label: 'Velocity', title: 'The MIDI velocity of each note' },
  { id: 'shift', label: 'Shift', title: 'How much earlier or later each note is struck than written, in milliseconds' },
  { id: 'gate', label: 'Gate', title: 'How long each note sounds, as a factor of the length the notation gives' },
  { id: 'tempo', label: 'Tempo', title: 'A ratio on the notated tempo over the piece' },
  { id: 'sustain', label: 'Sustain', title: 'The sustain pedal over the piece' },
  { id: 'soft', label: 'Una corda', title: 'Where the soft pedal is down' },
];

export const lane = signal<Lane>('velocity');

/** The snap grids of the curve lanes in ticks (0: none). */
export const SNAPS: { value: number; label: string }[] = [
  { value: PPQ, label: '1/4' },
  { value: PPQ / 2, label: '1/8' },
  { value: PPQ / 4, label: '1/16' },
  { value: PPQ / 8, label: '1/32' },
  { value: 0, label: 'Off' },
];

export const snap = signal(PPQ / 2);

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

/** A head's stem in a value lane: where its attack is drawn (the heard tick, or the written one in the shift lane). */
export interface Stem {
  info: HeadInfo;
  heard: number;
}

/** The stems, in order of the written start. */
export const stems = computed<Stem[]>(() => {
  const s = seq.value;
  return infos.value.map((info) => ({ info, heard: shownTick(s, info.note) }));
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
// heights. The canvas is the ruler on top, the roll, then one lane with the values; the labels sit in a gutter on the left.

export const GUTTER = 64;
export const RULER_H = 22;
export const LANE_H = 96;

/** The spacing scale of the stylesheet (`--sp-1`, `--sp-2`) in pixels: the canvas uses the same margins and paddings as the controls around it. */
export const SP1 = 6;

export const SP2 = 10;

/** The room between the parts of the canvas. */
const GAP = SP2;

/** The inner margin of the lane, so that the extreme values are not on its edge. */
export const LANE_PAD = SP2;

export interface Geo {
  w: number;
  h: number;
  ruler: { y: number; h: number };
  roll: { y: number; h: number };
  lane: { y: number; h: number };
}

/** The parts of a canvas of `w` by `h` pixels. */
export function geo(w: number, h: number): Geo {
  const laneH = Math.min(LANE_H, Math.max(48, h * 0.4));
  return {
    w,
    h,
    ruler: { y: 0, h: RULER_H },
    roll: { y: RULER_H, h: Math.max(0, h - RULER_H - laneH - GAP) },
    lane: { y: h - laneH, h: laneH },
  };
}

/** The tick at pixel `x`. */
export const tickAt = (x: number): number => exprView.peek().left + ((x - GUTTER) * PPQ) / exprView.peek().ppq;

/** The pixel of a tick under the view `v`. */
export const xOf = (tick: number, v = exprView.value): number => GUTTER + ((tick - v.left) * v.ppq) / PPQ;

/** The height of a pitch row in pixels. It is fixed, as on a piano roll: zooming changes only the width of the notes. */
export const ROW_H = 16;

/** The gap between the boxes of adjacent rows. */
export const BOX_GAP = 1;

/** The size of the velocity numbers in the note boxes, and the padding around them, which is the same on every side (the box is as high as the number and twice the padding). */
export const LABEL_FONT = 10;

export const LABEL_PAD = 4;

/** The scroll of the roll (pixels from its highest pitch) held within what there is to see. */
export const clampTop = (g: Geo, data: RollData, top: number): number =>
  Math.max(0, Math.min((data.hi - data.lo + 1) * ROW_H - g.roll.h, top));

/** The pixel row of the top of the roll row of pitch `midi`, with the roll scrolled by `top`; the rows are `ROW_H` high. */
export const rollRow = (g: Geo, data: RollData, top: number, midi: number): number =>
  g.roll.y + (data.hi - midi) * ROW_H - top;

/** The pitch at pixel row `y` of the roll. */
export const midiAt = (g: Geo, data: RollData, top: number, y: number): number =>
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
  /** Where the stems and areas start from. */
  base: number;
  fmt: (v: number) => string;
}

/** The ladder the range of the shift lane climbs. */
const SHIFT_RANGES = [50, 100, 200, 500, 1000, 2000];

/** The scale of a lane. The shift lane widens to hold the largest shift of `heads`. */
export function scaleOf(l: Lane, heads: HeadInfo[]): Scale {
  switch (l) {
    case 'velocity':
      return { min: 0, max: 127, marks: [0, 32, 64, 96, 127], base: 0, fmt: (v) => String(Math.round(v)) };
    case 'shift': {
      const big = Math.max(0, ...heads.map((i) => Math.abs(i.shift)));
      const r = SHIFT_RANGES.find((x) => x >= big * 1.1) ?? 2000;
      return {
        min: -r,
        max: r,
        marks: [-r, 0, r],
        base: 0,
        fmt: (v) => `${v > 0 ? '+' : ''}${Math.round(v * 10) / 10}`,
      };
    }
    case 'gate':
      return { min: 0, max: 2, marks: [0, 0.5, 1, 1.5, 2], base: 0, fmt: (v) => `${Math.round(v * 100) / 100}` };
    case 'tempo':
      return { min: 0.7, max: 1.3, marks: [0.8, 1, 1.2], base: 1, fmt: (v) => `${Math.round(v * 100)}%` };
    case 'sustain':
      return { min: 0, max: 1, marks: [0, 0.5, 1], base: 0, fmt: (v) => `${Math.round(v * 100)}%` };
    case 'soft':
      return { min: 0, max: 1, marks: [], base: 0, fmt: String };
  }
}

/** The scale kept while a drag is under way, so that the axis does not move under the pointer. */
export const frozenScale = signal<Scale | null>(null);

/** The scale of the open lane. */
export const laneScale = (): Scale => frozenScale.value ?? scaleOf(lane.value, infos.value);

/** The pixel row of `value` in the lane. */
export const yOfValue = (g: Geo, s: Scale, value: number): number =>
  g.lane.y + g.lane.h - LANE_PAD - ((value - s.min) / (s.max - s.min)) * (g.lane.h - 2 * LANE_PAD);

/** The value at pixel row `y` of the lane. */
export const valueAt = (g: Geo, s: Scale, y: number): number =>
  s.min + ((g.lane.y + g.lane.h - LANE_PAD - y) / (g.lane.h - 2 * LANE_PAD)) * (s.max - s.min);

// What is under the pointer, and the text that goes with it.

export type Hover =
  | { kind: 'bar'; key: string }
  | { kind: 'stem'; key: string }
  | { kind: 'point'; lane: 'tempo' | 'sustain'; index: number }
  | { kind: 'region'; index: number; edge?: 'from' | 'to' };

export const hover = signal<Hover | null>(null);

/** The tooltip over the canvas: its place in the canvas and its text. */
export const tip = signal<{ x: number; y: number; text: string } | null>(null);

/** The mouse cursor over the canvas. */
export const cursor = signal('default');

/** The rectangle of a selection in progress, in pixels. */
export const marquee = signal<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

const NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];

/** The name of a MIDI pitch, like `c4` or `f#3`. */
export const pitchName = (midi: number): string => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

/** A number as short text (at most one decimal). */
const num = (v: number): string => String(Math.round(v * 10) / 10);

/** The text over a head: pitch, place, and what it sounds like with where each value comes from. */
function headTip(i: HeadInfo): string {
  const start = seq.peek().measureStart[i.head.mi] ?? 0;
  const set = (on: boolean) => (on ? '' : ' (from the notation)');
  return [
    `${pitchName(i.midi)} · m${i.head.mi + 1} beat ${beatOf(i.at - start)}`,
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

/** Zooms so that the whole piece fits in `w` pixels. */
export function fitAll(w: number): void {
  const ppq = Math.max(PPQ_MIN, Math.min(PPQ_MAX, ((w - GUTTER - 8) * PPQ) / Math.max(PPQ, total.peek())));
  exprView.value = { ...exprView.peek(), ppq, left: 0 };
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
  | { kind: 'pan'; x0: number; y0: number; left0: number; top0: number }
  | { kind: 'marquee'; x0: number; y0: number; additive: boolean; base: Ref[]; area: 'roll' | 'lane' }
  | { kind: 'stem'; start: Map<string, number>; y0: number; lane: 'velocity' | 'shift' | 'gate'; scale: Scale }
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

/** Snaps a tick to the grid (to a barline too, which the grid is counted from); `free` leaves it alone. */
export function snapTick(tick: number, free = false): number {
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

/** The value of a curve at a pixel row, snapped to the usual values (1 for the tempo; 0, a half and 1 for the pedal) unless `free`. */
function curveValueAt(l: CurveName, g: Geo, y: number, free: boolean): number {
  const v = valueAt(g, scaleOf(l, []), y);
  const raw = Math.max(l === 'tempo' ? 0.7 : 0, Math.min(l === 'tempo' ? 1.3 : 1, v));
  if (free) return P.curveValue(l, raw);
  const stops = l === 'tempo' ? [1] : [0, 0.25, 0.5, 0.75, 1];
  const near = stops.find((s) => Math.abs(s - raw) < (l === 'tempo' ? 0.015 : 0.03));
  return P.curveValue(l, near ?? Math.round(raw * 100) / 100);
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

/** The stem whose handle or line is nearest to pixel (x, y) of the lane, within reach. */
function stemAt(g: Geo, x: number, y: number): Stem | undefined {
  const l = lane.peek();
  if (l !== 'velocity' && l !== 'shift' && l !== 'gate') return undefined;
  const sc = laneScale();
  let best: Stem | undefined;
  let bestD = GRAB + 1;
  for (const s of stems.peek()) {
    const sx = xOf(l === 'shift' ? s.info.note.start : s.heard);
    if (sx < x - GRAB - 1) continue;
    if (sx > x + GRAB + 1) continue;
    const top = yOfValue(g, sc, s.info[l === 'velocity' ? 'vel' : l]);
    const base = yOfValue(g, sc, sc.base);
    const onLine = y >= Math.min(top, base) - 2 && y <= Math.max(top, base) + 2 && Math.abs(sx - x) <= 3;
    const d = onLine ? Math.abs(sx - x) : Math.hypot(sx - x, top - y);
    if (d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/** The point of a curve under the pointer. */
function pointAt(g: Geo, l: CurveName, x: number, y: number): number {
  const sc = scaleOf(l, []);
  let best = -1;
  let bestD = GRAB + 1;
  curves.peek()[l].forEach((p, i) => {
    const d = Math.hypot(xOf(p.tick) - x, yOfValue(g, sc, p.value) - y);
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
  frozenScale.value = null;
  if (d) commit(d);
}

/** Starts a drag of the stems under a press: the selected ones when the pressed one is among them, else only it. */
function pressStem(g: Geo, x: number, y: number, shift: boolean): boolean {
  const hit = stemAt(g, x, y);
  const l = lane.peek();
  if (!hit || (l !== 'velocity' && l !== 'shift' && l !== 'gate')) return false;
  if (!selected.peek().has(hit.info.key)) select([refOf(hit.info.head)], shift);
  const keys = selected.peek().has(hit.info.key) ? selected.peek() : new Set([hit.info.key]);
  const start = new Map<string, number>();
  for (const i of infos.peek()) if (keys.has(i.key)) start.set(i.key, i[l === 'velocity' ? 'vel' : l]);
  const scale = laneScale();
  frozenScale.value = scale;
  drag = { kind: 'stem', start, y0: y, lane: l, scale };
  return true;
}

/** The values the stems of a drag take when the pointer is at row `y`. */
function dragStems(d: Extract<Drag, { kind: 'stem' }>, g: Geo, y: number, fine: boolean): void {
  const delta = valueAt(g, d.scale, y) - valueAt(g, d.scale, d.y0);
  const entries = [...d.start].flatMap(([key, v0]) => {
    const i = infoOf(key);
    if (!i) return [];
    const v = v0 + delta;
    const values = {
      velocity: { vel: Math.round(v) },
      shift: { shift: fine ? Math.round(v * 10) / 10 : Math.round(v) },
      gate: { gate: fine ? Math.round(v * 100) / 100 : Math.round(v * 20) / 20 },
    }[d.lane];
    return [{ head: i.head, values }];
  });
  setDraft(() => X.setHeadValues(score.peek(), entries));
}

/** Presses in a curve lane: grabs a point, or adds one where the pointer is and starts moving it. */
function pressCurve(l: CurveName, g: Geo, x: number, y: number, free: boolean): void {
  const base = score.peek();
  let index = pointAt(g, l, x, y);
  let from = base;
  if (index < 0) {
    const tick = snapTick(tickAt(x), free);
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
  const tick = snapTick(tickAt(x), free);
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
    drag = { kind: 'pan', x0: x, y0: y, left0: exprView.peek().left, top0: exprView.peek().top };
    return true;
  }
  if (x < GUTTER) return false;
  if (y < g.ruler.h) {
    seek(snapTick(tickAt(x), free));
    drag = { kind: 'seek' };
    return true;
  }
  if (y < g.roll.y + g.roll.h) {
    const bar = barAt(g, x, y);
    if (bar) {
      select([refOf(bar.head)], shift);
      return true;
    }
    drag = { kind: 'marquee', x0: x, y0: y, additive: shift, base: selection.peek(), area: 'roll' };
    return true;
  }
  if (y < g.lane.y) return false;
  const l = lane.peek();
  if (l === 'velocity' || l === 'shift' || l === 'gate') {
    if (!pressStem(g, x, y, shift))
      drag = { kind: 'marquee', x0: x, y0: y, additive: shift, base: selection.peek(), area: 'lane' };
  } else if (l === 'soft') pressSoft(x, free);
  else pressCurve(l, g, x, y, free);
  return true;
}

/** The refs of the heads inside a rectangle of the roll or the lane. */
function headsIn(g: Geo, area: 'roll' | 'lane', x0: number, y0: number, x1: number, y1: number): Ref[] {
  const [xa, xb] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [ya, yb] = [Math.min(y0, y1), Math.max(y0, y1)];
  const out = new Map<string, Ref>();
  if (area === 'roll') {
    const data = roll.peek();
    const top = exprView.peek().top;
    for (const b of data.bars) {
      const bx0 = xOf(b.t0);
      if (bx0 > xb) break;
      const y = rollRow(g, data, top, b.midi);
      if (xOf(b.t1) >= xa && y + ROW_H >= ya && y <= yb) out.set(b.key, refOf(b.head));
    }
    return [...out.values()];
  }
  const l = lane.peek();
  if (l !== 'velocity' && l !== 'shift' && l !== 'gate') return [];
  const sc = laneScale();
  for (const s of stems.peek()) {
    const sx = xOf(l === 'shift' ? s.info.note.start : s.heard);
    const sy = yOfValue(g, sc, s.info[l === 'velocity' ? 'vel' : l]);
    if (sx >= xa && sx <= xb && sy >= ya && sy <= yb) out.set(s.info.key, refOf(s.info.head));
  }
  return [...out.values()];
}

/** Handles the pointer moving to canvas pixel (x, y); `buttons` are the buttons held. */
export function onMove(g: Geo, x: number, y: number, buttons: number, free: boolean, fine: boolean): void {
  if (!drag) {
    updateHover(g, x, y);
    return;
  }
  if (!buttons) return;
  tip.value = null;
  switch (drag.kind) {
    case 'seek':
      seek(snapTick(tickAt(x), free));
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
    case 'stem':
      dragStems(drag, g, y, fine);
      break;
    case 'point':
      movePoint(drag, g, x, y, free);
      break;
    case 'region':
      moveRegion(drag, x, free);
      break;
  }
}

/** Moves the grabbed point of a curve. */
function movePoint(d: Extract<Drag, { kind: 'point' }>, g: Geo, x: number, y: number, free: boolean): void {
  d.moved = true;
  const tick = snapTick(tickAt(x), free);
  setDraft(() => P.moveCurvePoint(d.base, d.lane, d.index, tick, curveValueAt(d.lane, g, y, free)));
}

/** Moves, resizes or paints the una corda region of a drag. */
function moveRegion(d: Extract<Drag, { kind: 'region' }>, x: number, free: boolean): void {
  const tick = snapTick(tickAt(x), free);
  if (tick !== d.at) d.moved = true;
  if (!d.moved) return;
  const dt = tick - d.at;
  setDraft(() => {
    if (d.mode === 'new') return P.addSoftRegion(d.base, d.at, tick);
    if (d.mode === 'move') return P.setSoftRegion(d.base, d.index, d.from + dt, d.to + dt);
    if (d.mode === 'from') return P.setSoftRegion(d.base, d.index, tick, d.to);
    return P.setSoftRegion(d.base, d.index, d.from, tick);
  });
}

/** Handles the release of the pointer. */
export function onUp(g: Geo, x: number, y: number): void {
  const d = drag;
  drag = null;
  marquee.value = null;
  if (!d) return;
  if (d.kind === 'marquee') {
    const moved = Math.hypot(x - d.x0, y - d.y0) > 3;
    if (!moved) {
      if (!d.additive) selection.value = [];
      return;
    }
    const found = headsIn(g, d.area, d.x0, d.y0, x, y);
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
  if (d.kind === 'point' || d.kind === 'stem') finishDraft();
  if (d.kind === 'stem') frozenScale.value = null;
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
  frozenScale.value = null;
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
  if (y < g.lane.y) return;
  const l = lane.peek();
  if (l === 'velocity' || l === 'shift' || l === 'gate') {
    const s = stemAt(g, x, y);
    if (!s) return;
    hover.value = { kind: 'stem', key: s.info.key };
    cursor.value = 'ns-resize';
    tip.value = { x, y, text: headTip(s.info) };
  } else if (l === 'soft') {
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
      tip.value = { x, y, text: `${scaleOf(l, []).fmt(p.value)} at ${placeOf(p.tick)}` };
    } else cursor.value = 'crosshair';
  }
}

/** A tick as `m<N> beat <b>`. */
export function placeOf(tick: number): string {
  const ms = measures.peek();
  let lo = 0;
  let hi = Math.max(0, ms.length - 1);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ms[mid].start <= tick) lo = mid;
    else hi = mid - 1;
  }
  return `m${lo + 1} beat ${beatOf(tick - (ms[lo]?.start ?? 0))}`;
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

export const setVelocity = (v: number | null): void => onHeads((s, h) => X.setVelocity(s, h, v));
export const setShift = (ms: number | null): void => onHeads((s, h) => X.setShift(s, h, ms));
export const setGate = (g: number | null): void => onHeads((s, h) => X.setGate(s, h, g));
export const nudgeVelocity = (d: number): void => onHeads((s, h) => X.nudgeVelocity(s, h, d));
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
export const rampFrom = signal(40);

export const rampTo = signal(100);
export const rampShape = signal<RampShape>('linear');
export const rollSpan = signal(60);
export const rollDir = signal<'up' | 'down'>('up');
export const rollAnchor = signal<'first' | 'last'>('first');

/** Gives the selected notes velocities along the ramp. */
export const applyRamp = (): void =>
  onHeads((s, h) => X.rampVelocity(s, h, rampFrom.peek(), rampTo.peek(), rampShape.peek()));

/** Rolls the chords among the selected notes. */
export const applyRoll = (): void =>
  onHeads((s, h) => X.rollChord(s, h, { span: rollSpan.peek(), dir: rollDir.peek(), anchor: rollAnchor.peek() }));

/** Takes the open lane's value off the selected notes (all three with `all`). */
export function resetHeads(all = false): void {
  const l = lane.peek();
  const which: ('vel' | 'shift' | 'gate')[] =
    all || (l !== 'velocity' && l !== 'shift' && l !== 'gate')
      ? ['vel', 'shift', 'gate']
      : [l === 'velocity' ? 'vel' : l];
  onHeads((s, h) => X.resetExpression(s, h, which));
}

/** Removes the selected curve point or region. */
export function removePoint(): boolean {
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

/** Takes everything off the open curve lane. */
export function clearLane(): void {
  const l = lane.peek();
  if (l === 'tempo' || l === 'sustain' || l === 'soft') {
    pointSel.value = null;
    run((s) => P.clearCurve(s, l));
  }
}

/** Handles a key pressed on the canvas. Returns whether it was used (then it must not reach the global shortcuts). */
export function onKey(e: KeyboardEvent): boolean {
  const l = lane.peek();
  if (e.key === 'Escape') {
    if (!(drag || pointSel.peek())) return false;
    cancel();
    pointSel.value = null;
    return true;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (l === 'tempo' || l === 'sustain' || l === 'soft') removePoint();
    else resetHeads();
    return true;
  }
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return false;
  const dir = e.key === 'ArrowUp' ? 1 : -1;
  const big = e.shiftKey ? 10 : 1;
  if (l === 'velocity') nudgeVelocity(dir * big);
  else if (l === 'shift') nudgeShift(dir * big);
  else if (l === 'gate') nudgeGate(dir * 0.05 * big);
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
