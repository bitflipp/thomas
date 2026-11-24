// Curve mathematics for the performance layer: the monotone cubic spline of the tempo ratio, its
// integration, and the straight-line interpolation of the sustain pedal. Pure functions on points in
// absolute ticks; `sequence.ts` converts the score's positions before it calls them. The spline and
// its numeric integration follow the ones of the tool this layer replaces, so imported renditions keep
// their timing.

/** A point of a curve at an absolute tick. */
export interface CurvePt {
  tick: number;
  value: number;
}

/** Simpson panels per piece for the numeric integration: within a piece the ratio is one cubic, so this is accurate to well below a millisecond over musical spans. */
const PANELS = 16;

/** Composite Simpson's rule for the integral of `f` from `a` to `b` (0 when `b <= a`). Exact for constants. */
export function simpson(f: (x: number) => number, a: number, b: number, panels = PANELS): number {
  if (b <= a) return 0;
  const h = (b - a) / panels;
  let s = f(a) + f(b);
  for (let k = 1; k < panels; k++) s += (k % 2 ? 4 : 2) * f(a + k * h);
  return (s * h) / 3;
}

/** One-sided, non-overshooting endpoint slope (the pchip edge formula). */
function edgeTangent(h0: number, h1: number, d0: number, d1: number): number {
  let m = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
  if (Math.sign(m) !== Math.sign(d0)) m = 0;
  else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(m) > 3 * Math.abs(d0)) m = 3 * d0;
  return m;
}

/**
 * Monotone cubic (Fritsch-Carlson, "pchip") tangents of a curve sorted by tick, one per point. Local extrema
 * and equal-valued runs get a zero slope, so flat parts stay flat and the spline never leaves the range of
 * its points.
 */
export function monotoneTangents(pts: CurvePt[]): number[] {
  const n = pts.length;
  if (n < 2) return n ? [0] : [];
  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(pts[i + 1].tick - pts[i].tick);
    d.push(h[i] > 0 ? (pts[i + 1].value - pts[i].value) / h[i] : 0);
  }
  const m = new Array<number>(n).fill(0);
  if (n === 2) return [d[0], d[0]];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) continue;
    const w1 = 2 * h[i] + h[i - 1];
    const w2 = h[i] + 2 * h[i - 1];
    m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); // The weighted harmonic mean.
  }
  m[0] = edgeTangent(h[0], h[1], d[0], d[1]);
  m[n - 1] = edgeTangent(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
  return m;
}

/** The ratio function of a curve: the monotone cubic spline through its points, flat beyond the first and last (1 for no points). */
export function ratioFunction(pts: CurvePt[]): (tick: number) => number {
  const n = pts.length;
  if (n === 0) return () => 1;
  const m = monotoneTangents(pts);
  return (tick) => {
    if (tick <= pts[0].tick) return pts[0].value;
    if (tick >= pts[n - 1].tick) return pts[n - 1].value;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].tick <= tick) lo = mid;
      else hi = mid;
    }
    const h = pts[lo + 1].tick - pts[lo].tick;
    const t = (tick - pts[lo].tick) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * pts[lo].value +
      (t3 - 2 * t2 + t) * h * m[lo] +
      (-2 * t3 + 3 * t2) * pts[lo + 1].value +
      (t3 - t2) * h * m[lo + 1]
    );
  };
}

/** The value of a curve at a tick by straight lines between its points, held beyond the first and last; `fallback` for no points. */
export function linearAt(pts: CurvePt[], tick: number, fallback: number): number {
  if (pts.length === 0) return fallback;
  if (tick <= pts[0].tick) return pts[0].value;
  const last = pts[pts.length - 1];
  if (tick >= last.tick) return last.value;
  let i = 1;
  while (pts[i].tick < tick) i++;
  const span = pts[i].tick - pts[i - 1].tick;
  const u = span > 0 ? (tick - pts[i - 1].tick) / span : 0;
  return pts[i - 1].value + u * (pts[i].value - pts[i - 1].value);
}

/**
 * The controller events of a straight-line curve with values 0 to 1, as (tick, value 0..127): the points, and
 * between two points one event for each step of the controller that the line crosses, so that a slow ramp is
 * not played as a single jump. An event that repeats the value before it is left out.
 */
export function rampEvents(pts: CurvePt[]): { tick: number; value: number }[] {
  const out: { tick: number; value: number }[] = [];
  const cc = (v: number) => Math.max(0, Math.min(127, Math.round(v * 127)));
  const push = (tick: number, value: number) => {
    const v = cc(value);
    if (out.length === 0 || out[out.length - 1].value !== v) out.push({ tick, value: v });
  };
  pts.forEach((p, i) => {
    if (i > 0) {
      const p0 = pts[i - 1];
      const steps = Math.abs(cc(p.value) - cc(p0.value));
      for (let s = 1; s < steps; s++) {
        const f = s / steps;
        push(p0.tick + (p.tick - p0.tick) * f, p0.value + (p.value - p0.value) * f);
      }
    }
    push(p.tick, p.value);
  });
  return out;
}
