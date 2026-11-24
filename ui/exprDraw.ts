// Drawing of the Expression pane's canvas: the ruler, the roll of bars, the lane with the values or curves, the gutter with
// the labels and the playhead. A pure function of a `Frame` (what to show) and the theme's colors, which are read from the
// stylesheet's custom properties so that the canvas follows the light and dark themes like the rest of the UI. The pointer
// handling that goes with it is in expression.ts.

import { PPQ } from '../src/model.ts';
import { linearAt, ratioFunction } from '../src/playback/curves.ts';
import type { Geo, Hover, Lane, MeasureSpan, RollData, Scale, Stem } from './expression.ts';
import { GUTTER, pitchName, ROW_H, rollRow, visiblePitches, xOf, yOfValue } from './expression.ts';

/** The theme colors and text sizes the canvas uses. */
export interface Colors {
  bg: string;
  panel: string;
  line: string;
  fg: string;
  muted: string;
  accent: string;
  accentSoft: string;
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

/** The ramp as a CSS gradient, for the legend in the toolbar. */
export const RAMP_GRADIENT = `linear-gradient(to right, ${VELOCITY_RAMP.map((c) => `rgb(${c.join(',')})`).join(', ')})`;

/** The color of a velocity (1 to 127) on the ramp, with how light it is (0 to 1) for choosing the text color on it. */
function velocityColor(vel: number): { css: string; light: number } {
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
  stems: Stem[];
  measures: MeasureSpan[];
  curves: {
    tempo: { tick: number; value: number }[];
    sustain: { tick: number; value: number }[];
    soft: { from: number; to: number }[];
  };
  lane: Lane;
  scale: Scale;
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
      ctx.fillRect(Math.round(x), 4, 1, g.ruler.h - 5);
      if (x - lastLabel >= 34) {
        text(ctx, String(m.mi + 1), x + 3, g.ruler.h - 8, c.muted);
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
  for (const [y, h] of [
    [g.roll.y, g.roll.h],
    [g.lane.y, g.lane.h],
  ]) {
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
    // The numbers are as large as the rows allow.
    const size = Math.min(c.fsXs, Math.floor(ROW_H - 1.5));
    ctx.font = `${size}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    for (let i = lowerBound(roll.maxEnd, leftTick); i < roll.bars.length; i++) {
      const b = roll.bars[i];
      if (b.t0 > rightTick) break;
      if (b.midi < range.lo || b.midi > range.hi) continue;
      const x0 = xOf(b.t0, f.view);
      const x1 = xOf(b.t1, f.view);
      if (x1 < GUTTER) continue;
      const y = rollRow(g, roll, f.view.top, b.midi);
      const color = velocityColor(b.vel);
      const h = ROW_H - 1;
      const w = Math.max(2, x1 - x0 - 1);
      ctx.fillStyle = color.css;
      ctx.fillRect(x0, y, w, h);
      if (size >= 7 && w >= 22) {
        ctx.fillStyle = color.light > 0.6 ? '#1d1d22' : '#ffffff';
        ctx.textAlign = 'left';
        ctx.fillText(String(b.vel), x0 + 3, y + h / 2 + 0.5);
      }
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
    ctx.textBaseline = 'alphabetic';
    ctx.font = `${c.fsXs}px system-ui, sans-serif`;
  });
}

/** The axis of the lane: a line at each mark of the scale (the value at the base a little stronger). */
function drawAxis(ctx: CanvasRenderingContext2D, f: Frame, c: Colors): void {
  const { g, scale } = f;
  clipped(ctx, f, g.lane.y, g.lane.h, () => {
    for (const v of scale.marks) {
      const y = Math.round(yOfValue(g, scale, v));
      ctx.fillStyle = mix(c.bg, c.muted, v === scale.base ? 0.5 : 0.2);
      ctx.fillRect(GUTTER, y, g.w - GUTTER, 1);
    }
  });
}

/** The stems of the heads in the velocity, shift or gate lane: a line from the base to the value with a handle on top. */
function drawStems(ctx: CanvasRenderingContext2D, f: Frame, c: Colors, leftTick: number, rightTick: number): void {
  const { g, scale, lane } = f;
  const which = lane === 'velocity' ? 'vel' : (lane as 'shift' | 'gate');
  const base = yOfValue(g, scale, scale.base);
  clipped(ctx, f, g.lane.y, g.lane.h, () => {
    for (const s of f.stems) {
      const t = lane === 'shift' ? s.info.note.start : s.heard;
      if (t < leftTick - PPQ || t > rightTick + PPQ) continue;
      const x = Math.round(xOf(t, f.view)) + 0.5;
      const v = s.info[which];
      const y = yOfValue(g, scale, Math.max(scale.min, Math.min(scale.max, v)));
      const sel = f.selected.has(s.info.key);
      const hot = f.hover?.kind === 'stem' && f.hover.key === s.info.key;
      const set = s.info.has[which];
      const ramp = lane === 'velocity' ? velocityColor(v).css : undefined;
      const color = sel || hot ? c.accent : (ramp ?? (set ? c.fg : c.muted));
      ctx.strokeStyle = color;
      ctx.globalAlpha = sel || set ? 1 : 0.55;
      ctx.lineWidth = sel ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, base);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.fillStyle = set || sel ? color : c.bg;
      ctx.fillRect(x - 3, y - 3, 6, 6);
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 2.5, y - 2.5, 5, 5);
      ctx.globalAlpha = 1;
    }
  });
}

/** A curve as a line through its samples across the visible width; `at` gives the value at a tick. */
function drawCurveLine(
  ctx: CanvasRenderingContext2D,
  f: Frame,
  c: Colors,
  at: (tick: number) => number,
  fill: boolean,
): void {
  const { g, scale } = f;
  clipped(ctx, f, g.lane.y, g.lane.h, () => {
    ctx.beginPath();
    const base = yOfValue(g, scale, scale.base);
    let first = true;
    for (let x = GUTTER; x <= g.w; x += 2) {
      const tick = f.view.left + ((x - GUTTER) * PPQ) / f.view.ppq;
      const y = yOfValue(g, scale, Math.max(scale.min, Math.min(scale.max, at(tick))));
      if (first) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      first = false;
    }
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (fill) {
      ctx.lineTo(g.w, base);
      ctx.lineTo(GUTTER, base);
      ctx.closePath();
      ctx.fillStyle = c.accentSoft;
      ctx.globalAlpha = 0.6;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  });
}

/** The tempo or sustain curve with its points. */
function drawCurve(ctx: CanvasRenderingContext2D, f: Frame, c: Colors, name: 'tempo' | 'sustain'): void {
  const { g, scale } = f;
  const pts = f.curves[name];
  if (name === 'tempo') drawCurveLine(ctx, f, c, ratioFunction(pts), false);
  else drawCurveLine(ctx, f, c, (t) => (pts.length && t >= pts[0].tick ? linearAt(pts, t, 0) : 0), true);
  clipped(ctx, f, g.lane.y, g.lane.h, () => {
    pts.forEach((p, i) => {
      const x = xOf(p.tick, f.view);
      const y = yOfValue(g, scale, Math.max(scale.min, Math.min(scale.max, p.value)));
      const sel = f.pointSel?.lane === name && f.pointSel.index === i;
      const hot = f.hover?.kind === 'point' && f.hover.lane === name && f.hover.index === i;
      ctx.beginPath();
      ctx.arc(x, y, sel || hot ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = sel ? c.accent : c.panel;
      ctx.fill();
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  });
}

/** The una corda regions as bands across the lane. */
function drawSoft(ctx: CanvasRenderingContext2D, f: Frame, c: Colors): void {
  const { g } = f;
  clipped(ctx, f, g.lane.y, g.lane.h, () => {
    f.curves.soft.forEach((r, i) => {
      const x0 = xOf(r.from, f.view);
      const x1 = xOf(r.to, f.view);
      const sel = f.pointSel?.lane === 'soft' && f.pointSel.index === i;
      const hot = f.hover?.kind === 'region' && f.hover.index === i;
      const y = g.lane.y + 8;
      const h = g.lane.h - 16;
      ctx.fillStyle = sel ? c.accent : c.accentSoft;
      ctx.globalAlpha = sel ? 0.55 : 1;
      ctx.fillRect(x0, y, Math.max(2, x1 - x0), h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = hot || sel ? 2 : 1;
      ctx.strokeRect(x0 + 0.5, y + 0.5, Math.max(2, x1 - x0) - 1, h - 1);
    });
  });
}

/** The lane under the roll. */
function drawLane(ctx: CanvasRenderingContext2D, f: Frame, c: Colors, leftTick: number, rightTick: number): void {
  const { g } = f;
  ctx.fillStyle = c.bg;
  ctx.fillRect(GUTTER, g.lane.y, g.w - GUTTER, g.lane.h);
  drawGrid(ctx, f, c, visibleMeasures(f, leftTick, rightTick));
  drawAxis(ctx, f, c);
  if (f.lane === 'soft') drawSoft(ctx, f, c);
  else if (f.lane === 'tempo' || f.lane === 'sustain') drawCurve(ctx, f, c, f.lane);
  else drawStems(ctx, f, c, leftTick, rightTick);
}

/** The gutter: the pitch of each C in the roll and the marks of the lane's axis, with the lane's name. */
function drawGutter(ctx: CanvasRenderingContext2D, f: Frame, c: Colors, laneName: string): void {
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
    text(ctx, pitchName(m), GUTTER - 6, rollRow(g, roll, f.view.top, m) + ROW_H - 2, c.muted, 'right');
  }
  ctx.restore();
  ctx.save();
  ctx.translate(c.fsXs + 2, g.lane.y + g.lane.h / 2);
  ctx.rotate(-Math.PI / 2);
  text(ctx, laneName.toUpperCase(), 0, 0, c.muted, 'center');
  ctx.restore();
  for (const v of f.scale.marks) text(ctx, f.scale.fmt(v), GUTTER - 6, yOfValue(g, f.scale, v) + 4, c.muted, 'right');
}

/** Paints the whole canvas for `f`. `laneName` is the label of the open lane. */
export function paint(ctx: CanvasRenderingContext2D, f: Frame, c: Colors, laneName: string): void {
  const { g } = f;
  ctx.clearRect(0, 0, g.w, g.h);
  ctx.fillStyle = c.panel;
  ctx.fillRect(0, 0, g.w, g.h);
  ctx.font = `${c.fsXs}px system-ui, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  const leftTick = f.view.left;
  const rightTick = f.view.left + ((g.w - GUTTER) * PPQ) / f.view.ppq;
  drawRoll(ctx, f, c, leftTick, rightTick);
  drawLane(ctx, f, c, leftTick, rightTick);
  drawRuler(ctx, f, c, visibleMeasures(f, leftTick, rightTick));
  drawGutter(ctx, f, c, laneName);
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
