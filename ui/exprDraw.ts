// Drawing of the Expression pane's canvas: the ruler, the roll of bars, the lane with the values or curves, the gutter with
// the labels and the playhead. A pure function of a `Frame` (what to show) and the theme's colors, which are read from the
// stylesheet's custom properties so that the canvas follows the light and dark themes like the rest of the UI. The pointer
// handling that goes with it is in expression.ts.

import { PPQ } from '../src/model.ts';
import { linearAt, ratioFunction } from '../src/playback/curves.ts';
import { must } from '../src/util.ts';
import type { Geo, Hover, MeasureSpan, Rect, RollData, Scale } from './expression.ts';

import {
  BOX_GAP,
  BOX_TOP,
  CURVE_LANES,
  GUTTER,
  LABEL_FONT,
  LABEL_PAD,
  laneRects,
  padOf,
  pitchName,
  ROW_H,
  rollRow,
  SP1,
  SP2,
  scaleOf,
  visiblePitches,
  xOf,
  yOfValue,
} from './expression.ts';

/** The theme colors and text sizes the canvas uses. */
export interface Colors {
  bg: string;
  panel: string;
  line: string;
  fg: string;
  muted: string;
  accent: string;
  accentSoft: string;
  /** The hue of each curve lane. */
  lane: Record<'tempo' | 'sustain' | 'soft', string>;
  play: string;
  fsXs: number;
}

/** The color of the playhead, as in the overview strip. */
const PLAYHEAD = '#e8590c';

/** Reads the colors from the document's custom properties. */
export function readColors(): Colors {
  const st = getComputedStyle(document.documentElement);
  const get = (name: string) => st.getPropertyValue(name).trim();
  return {
    bg: get('--bg'),
    panel: get('--panel'),
    line: get('--line'),
    fg: get('--fg'),
    muted: get('--muted'),
    accent: get('--accent'),
    accentSoft: get('--accent-soft'),
    lane: { tempo: get('--lane-tempo'), sustain: get('--lane-sustain'), soft: get('--lane-soft') },
    play: PLAYHEAD,
    fsXs: Number.parseFloat(get('--fs-xs')) || 11,
  };
}

/** A `#rrggbb` color as its three channels (black if it is not in that form). */
function rgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [Number.parseInt(m[1], 16), Number.parseInt(m[2], 16), Number.parseInt(m[3], 16)] : [0, 0, 0];
}

/** The color a fraction `t` of the way from `a` to `b`. */
function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  const f = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `rgb(${f(r1, r2)},${f(g1, g2)},${f(b1, b2)})`;
}

/** The colors of the velocity ramp, from the softest to the loudest: blue, teal, amber, red. Between any two the blend stays clean, and all four read on the light and the dark theme alike. */
const VELOCITY_RAMP: [number, number, number][] = [
  [58, 104, 196],
  [24, 164, 158],
  [236, 172, 36],
  [214, 44, 38],
];

/** The color of a velocity (1 to 127) on the ramp, with how light it is (0 to 1) for choosing the text color on it. */
export function velocityColor(vel: number): { css: string; light: number } {
  const t = Math.max(0, Math.min(1, (vel - 1) / 126)) * (VELOCITY_RAMP.length - 1);
  const i = Math.min(VELOCITY_RAMP.length - 2, Math.floor(t));
  const f = t - i;
  const [r, g, b] = VELOCITY_RAMP[i].map((v, k) => Math.round(v + (VELOCITY_RAMP[i + 1][k] - v) * f));
  return { css: `rgb(${r},${g},${b})`, light: (0.299 * r + 0.587 * g + 0.114 * b) / 255 };
}

/** Everything a painting shows. */
export interface Frame {
  g: Geo;
  view: { left: number; ppq: number; top: number };
  roll: RollData;
  measures: MeasureSpan[];
  curves: {
    tempo: { tick: number; value: number }[];
    sustain: { tick: number; value: number }[];
    soft: { from: number; to: number }[];
  };
  selected: Set<string>;
  hover: Hover | null;
  pointSel: { lane: string; index: number } | null;
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;
  playTick: number | null;
}

/** Index of the first of the sorted `values` that is not less than `x` (binary search). */
function lowerBound(values: number[], x: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Draws a text with the canvas default baseline, at (x, y). */
function text(
  ctx: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  color: string,
  align: CanvasTextAlign = 'left',
) {
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(s, x, y);
}

/** Draws a text with its glyphs (digits and capitals, which have no descenders) centered on height `cy`, whatever the font. */
function centeredText(
  ctx: CanvasRenderingContext2D,
  s: string,
  x: number,
  cy: number,
  color: string,
  align: CanvasTextAlign = 'left',
): void {
  text(ctx, s, x, cy + ctx.measureText('8').actualBoundingBoxAscent / 2, color, align);
}

/** Runs `fn` with drawing clipped to a rectangle of the canvas right of the gutter. */
function clipped(ctx: CanvasRenderingContext2D, f: Frame, y: number, h: number, fn: () => void): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(GUTTER, y, f.g.w - GUTTER, h);
  ctx.clip();
  fn();
  ctx.restore();
}

/** A measure with its index. */
type NumberedMeasure = MeasureSpan & { mi: number };

/** The measures that reach into the visible ticks. */
function visibleMeasures(f: Frame, leftTick: number, rightTick: number): NumberedMeasure[] {
  const starts = f.measures.map((m) => m.start);
  const first = Math.max(0, lowerBound(starts, leftTick + 1) - 1);
  const out: NumberedMeasure[] = [];
  for (let mi = first; mi < f.measures.length && f.measures[mi].start <= rightTick; mi++)
    out.push({ ...f.measures[mi], mi });
  return out;
}

/** The ruler: measure lines with their numbers (not every one when they are close), beat marks when there is room. */
function drawRuler(ctx: CanvasRenderingContext2D, f: Frame, c: Colors, ms: NumberedMeasure[]): void {
  const { g } = f;
  ctx.fillStyle = c.panel;
  ctx.fillRect(0, 0, g.w, g.ruler.h);
  ctx.fillStyle = c.line;
  ctx.fillRect(0, g.ruler.h - 1, g.w, 1);
  clipped(ctx, f, 0, g.ruler.h, () => {
    let lastLabel = Number.NEGATIVE_INFINITY;
    for (const m of ms) {
      const x = xOf(m.start, f.view);
      ctx.fillStyle = c.muted;
      ctx.fillRect(Math.round(x), SP1, 1, g.ruler.h - SP1 - 1);
      if (x - lastLabel >= 34) {
        centeredText(ctx, String(m.mi + 1), x + SP1, g.ruler.h / 2, c.muted);
        lastLabel = x;
      }
      const beatPx = (m.beat * f.view.ppq) / PPQ;
      if (beatPx >= 12)
        for (let t = m.start + m.beat; t < m.start + m.len - 1; t += m.beat) {
          ctx.fillStyle = c.line;
          ctx.fillRect(Math.round(xOf(t, f.view)), g.ruler.h - 6, 1, 5);
        }
    }
  });
}

/** The measure lines and beat lines through the roll and the lane. */
function drawGrid(ctx: CanvasRenderingContext2D, f: Frame, c: Colors, ms: NumberedMeasure[]): void {
  const { g } = f;
  for (const { y, h } of [g.roll, g.tempo, g.sustain, g.soft]) {
    clipped(ctx, f, y, h, () => {
      for (const m of ms) {
        ctx.fillStyle = mix(c.bg, c.muted, 0.35);
        ctx.fillRect(Math.round(xOf(m.start, f.view)), y, 1, h);
        if ((m.beat * f.view.ppq) / PPQ < 20) continue;
        ctx.fillStyle = mix(c.bg, c.muted, 0.12);
        for (let t = m.start + m.beat; t < m.start + m.len - 1; t += m.beat)
          ctx.fillRect(Math.round(xOf(t, f.view)), y, 1, h);
      }
    });
  }
}

/** Whether a pitch is a black key. */
const isBlack = (midi: number): boolean => [1, 3, 6, 8, 10].includes(midi % 12);

/**
 * The roll: a shaded row for each black key and a line under each C, and a bar for each sounding note, colored by its
 * velocity (blue, orange, red) with the number inside when the bar has room. A selected bar has an accent outline.
 */
function drawRoll(ctx: CanvasRenderingContext2D, f: Frame, c: Colors, leftTick: number, rightTick: number): void {
  const { g, roll } = f;
  const range = visiblePitches(g, roll, f.view.top);
  ctx.fillStyle = c.bg;
  ctx.fillRect(GUTTER, g.roll.y, g.w - GUTTER, g.roll.h);
  clipped(ctx, f, g.roll.y, g.roll.h, () => {
    for (let m = range.lo; m <= range.hi; m++) {
      const y = rollRow(g, roll, f.view.top, m);
      if (isBlack(m)) {
        ctx.fillStyle = mix(c.bg, c.muted, 0.1);
        ctx.fillRect(GUTTER, y, g.w - GUTTER, ROW_H);
      }
      if (m % 12 !== 0) continue;
      ctx.fillStyle = mix(c.bg, c.muted, 0.3);
      ctx.fillRect(GUTTER, Math.round(y + ROW_H), g.w - GUTTER, 1);
    }
  });
  drawGrid(ctx, f, c, visibleMeasures(f, leftTick, rightTick));
  clipped(ctx, f, g.roll.y, g.roll.h, () => {
    // The numbers have the same padding on every side of the box: left of them, and above and below their digits.
    ctx.font = `${LABEL_FONT}px system-ui, sans-serif`;
    const digits = ctx.measureText('8').width;
    // The boxes in view, each with its edges on whole pixels so that they sit on the grid lines (a line is the pixel at
    // `round(x)`, so a box starts on it and ends right before the line of its end tick).
    const boxes: { b: RollData['bars'][number]; x0: number; x1: number; y: number }[] = [];
    for (let i = lowerBound(roll.maxEnd, leftTick); i < roll.bars.length; i++) {
      const b = roll.bars[i];
      if (b.t0 > rightTick) break;
      if (b.midi < range.lo || b.midi > range.hi) continue;
      const x0 = Math.round(xOf(b.t0, f.view));
      const x1 = Math.max(x0 + 2, Math.round(xOf(b.t1, f.view)));
      if (x1 < GUTTER) continue;
      boxes.push({ b, x0, x1, y: Math.round(rollRow(g, roll, f.view.top, b.midi)) + BOX_TOP });
    }
    // Longer boxes are drawn first, so that a shorter one of the same pitch (a unison in another voice) stays visible on top.
    boxes.sort((p, q) => q.x1 - q.x0 - (p.x1 - p.x0) || p.b.t0 - q.b.t0);
    // The boxes of each pitch in drawing order: those after a box cover it where they overlap.
    const byPitch = new Map<number, typeof boxes>();
    const rank = new Map<unknown, number>();
    for (const bx of boxes) {
      const list = byPitch.get(bx.b.midi) ?? [];
      rank.set(bx, list.length);
      byPitch.set(bx.b.midi, list);
      list.push(bx);
    }
    // A box ends right at the line of its end tick, but a note of the same pitch that starts there is told apart by a gap.
    for (const list of byPitch.values())
      for (const bx of list) if (bx.x1 - bx.x0 > 2 && list.some((o) => o.x0 === bx.x1)) bx.x1 -= 1;
    const h = ROW_H - BOX_GAP;
    for (const box of boxes) {
      const { b, x0, x1, y } = box;
      const w = x1 - x0;
      const color = velocityColor(b.vel);
      ctx.fillStyle = color.css;
      ctx.fillRect(x0, y, w, h);
      // The number goes where the box is not covered by a box drawn later (the shorter unison notes): the widest free stretch.
      const label = String(b.vel);
      const need = label.length * digits + 2 * LABEL_PAD;
      const covers = must(byPitch.get(b.midi))
        .slice(must(rank.get(box)) + 1)
        .filter((o) => o.x0 < x1 && o.x1 > x0)
        .sort((p, q) => p.x0 - q.x0);
      let best = { from: x0, to: x0 };
      let at = x0;
      for (const o of [...covers, { x0: x1, x1 }]) {
        if (o.x0 - at > best.to - best.from) best = { from: at, to: o.x0 };
        at = Math.max(at, o.x1);
      }
      if (best.to - best.from >= need)
        centeredText(ctx, label, best.from + LABEL_PAD - 1, y + h / 2, color.light > 0.6 ? '#1d1d22' : '#ffffff');
      const sel = f.selected.has(b.key);
      const hot = f.hover?.kind === 'bar' && f.hover.key === b.key;
      if (sel || hot) {
        ctx.strokeStyle = c.accent;
        ctx.lineWidth = sel ? 2 : 1.5;
        ctx.strokeRect(x0 + 0.5, y + 0.5, w - 1, h - 1);
        if (sel) {
          ctx.strokeStyle = c.panel;
          ctx.lineWidth = 1;
          ctx.strokeRect(x0 - 0.5, y - 0.5, w + 1, h + 1);
        }
      }
    }
    ctx.font = `${c.fsXs}px system-ui, sans-serif`;
  });
}

/** The axis of a lane: a line at each mark of the scale (the value at the base a little stronger). */
function drawAxis(ctx: CanvasRenderingContext2D, f: Frame, c: Colors, r: Rect, scale: Scale): void {
  const { g } = f;
  clipped(ctx, f, r.y, r.h, () => {
    for (const v of scale.marks) {
      const y = Math.round(yOfValue(r, scale, v));
      ctx.fillStyle = mix(c.bg, c.muted, v === scale.base ? 0.5 : 0.2);
      ctx.fillRect(GUTTER, y, g.w - GUTTER, 1);
    }
  });
}

/** A curve as a line through its samples across the visible width; `at` gives the value at a tick. */
function drawCurveLine(
  ctx: CanvasRenderingContext2D,
  f: Frame,
  r: Rect,
  scale: Scale,
  color: string,
  at: (tick: number) => number,
  fill: boolean,
): void {
  const { g } = f;
  clipped(ctx, f, r.y, r.h, () => {
    ctx.beginPath();
    const base = yOfValue(r, scale, scale.base);
    let first = true;
    for (let x = GUTTER; x <= g.w; x += 2) {
      const tick = f.view.left + ((x - GUTTER) * PPQ) / f.view.ppq;
      const y = yOfValue(r, scale, Math.max(scale.min, Math.min(scale.max, at(tick))));
      if (first) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      first = false;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (fill) {
      ctx.lineTo(g.w, base);
      ctx.lineTo(GUTTER, base);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.18;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  });
}

/** The tempo or sustain curve with its points. */
function drawCurve(ctx: CanvasRenderingContext2D, f: Frame, c: Colors, name: 'tempo' | 'sustain'): void {
  const r = f.g[name];
  const scale = scaleOf(name);
  const pts = f.curves[name];
  const color = c.lane[name];
  drawAxis(ctx, f, c, r, scale);
  if (name === 'tempo') drawCurveLine(ctx, f, r, scale, color, ratioFunction(pts), false);
  else drawCurveLine(ctx, f, r, scale, color, (t) => (pts.length && t >= pts[0].tick ? linearAt(pts, t, 0) : 0), true);
  clipped(ctx, f, r.y, r.h, () => {
    pts.forEach((p, i) => {
      const x = xOf(p.tick, f.view);
      const y = yOfValue(r, scale, Math.max(scale.min, Math.min(scale.max, p.value)));
      const sel = f.pointSel?.lane === name && f.pointSel.index === i;
      const hot = f.hover?.kind === 'point' && f.hover.lane === name && f.hover.index === i;
      ctx.beginPath();
      ctx.arc(x, y, sel || hot ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = sel ? color : c.panel;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  });
}

/** The una corda regions as bands across the lane. */
function drawSoft(ctx: CanvasRenderingContext2D, f: Frame, c: Colors): void {
  const r = f.g.soft;
  clipped(ctx, f, r.y, r.h, () => {
    f.curves.soft.forEach((reg, i) => {
      const x0 = xOf(reg.from, f.view);
      const x1 = xOf(reg.to, f.view);
      const sel = f.pointSel?.lane === 'soft' && f.pointSel.index === i;
      const hot = f.hover?.kind === 'region' && f.hover.index === i;
      const y = r.y + padOf(r);
      const h = r.h - 2 * padOf(r);
      ctx.fillStyle = c.lane.soft;
      ctx.globalAlpha = sel ? 0.55 : 0.22;
      ctx.fillRect(x0, y, Math.max(2, x1 - x0), h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = c.lane.soft;
      ctx.lineWidth = hot || sel ? 2 : 1;
      ctx.strokeRect(x0 + 0.5, y + 0.5, Math.max(2, x1 - x0) - 1, h - 1);
    });
  });
}

/** The lanes under the roll: tempo, sustain and una corda. */
function drawLanes(ctx: CanvasRenderingContext2D, f: Frame, c: Colors, leftTick: number, rightTick: number): void {
  const { g } = f;
  for (const { r } of laneRects(g)) {
    ctx.fillStyle = c.bg;
    ctx.fillRect(GUTTER, r.y, g.w - GUTTER, r.h);
  }
  drawGrid(ctx, f, c, visibleMeasures(f, leftTick, rightTick));
  drawCurve(ctx, f, c, 'tempo');
  drawCurve(ctx, f, c, 'sustain');
  drawSoft(ctx, f, c);
}

/** The gutter: the pitch of each C in the roll, and for each lane its name and the marks of its axis. */
function drawGutter(ctx: CanvasRenderingContext2D, f: Frame, c: Colors): void {
  const { g, roll } = f;
  ctx.fillStyle = c.panel;
  ctx.fillRect(0, g.ruler.h, GUTTER, g.h - g.ruler.h);
  ctx.fillStyle = c.line;
  ctx.fillRect(GUTTER - 1, 0, 1, g.h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, g.roll.y, GUTTER, g.roll.h);
  ctx.clip();
  const range = visiblePitches(g, roll, f.view.top);
  for (let m = range.lo; m <= range.hi; m++) {
    if (m % 12 !== 0) continue;
    centeredText(
      ctx,
      pitchName(m),
      GUTTER - SP2,
      rollRow(g, roll, f.view.top, m) + BOX_TOP + (ROW_H - BOX_GAP) / 2,
      c.muted,
      'right',
    );
  }
  ctx.restore();
  const lanes = CURVE_LANES.map((l) => ({ r: g[l.id], name: l.label, scale: scaleOf(l.id), color: c.lane[l.id] }));
  for (const { r, name, scale, color } of lanes) {
    if (r.h >= 44) {
      ctx.save();
      ctx.translate(SP1 + c.fsXs / 2, r.y + r.h / 2);
      ctx.rotate(-Math.PI / 2);
      centeredText(ctx, name.toUpperCase(), 0, 0, color, 'center');
      ctx.restore();
    } else centeredText(ctx, name, SP1, r.y + r.h / 2, color);
    for (const v of scale.marks) centeredText(ctx, scale.fmt(v), GUTTER - SP2, yOfValue(r, scale, v), c.muted, 'right');
  }
}

/** Paints the whole canvas for `f`. */
export function paint(ctx: CanvasRenderingContext2D, f: Frame, c: Colors): void {
  const { g } = f;
  ctx.clearRect(0, 0, g.w, g.h);
  ctx.fillStyle = c.panel;
  ctx.fillRect(0, 0, g.w, g.h);
  ctx.font = `${c.fsXs}px system-ui, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  const leftTick = f.view.left;
  const rightTick = f.view.left + ((g.w - GUTTER) * PPQ) / f.view.ppq;
  drawRoll(ctx, f, c, leftTick, rightTick);
  drawLanes(ctx, f, c, leftTick, rightTick);
  drawRuler(ctx, f, c, visibleMeasures(f, leftTick, rightTick));
  drawGutter(ctx, f, c);
  if (f.playTick !== null) {
    const x = Math.round(xOf(f.playTick, f.view));
    if (x >= GUTTER) {
      ctx.fillStyle = c.play;
      ctx.fillRect(x, 0, 2, g.h);
    }
  }
  if (f.marquee) {
    const { x0, y0, x1, y1 } = f.marquee;
    ctx.fillStyle = c.accent;
    ctx.globalAlpha = 0.15;
    ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.globalAlpha = 1;
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
  }
}
