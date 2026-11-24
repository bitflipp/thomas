// Icons for the palette: SMuFL glyphs from the same font as the score, centered on their ink and
// scaled to fit, plus text labels. Glyph outlines come from the engraver's font access (smufl.ts).

import { useLayoutEffect, useRef } from 'preact/hooks';
import { loadSmufl } from '../src/smufl.ts';

const bboxCache = new Map<number, { d: string; x0: number; y0: number; x1: number; y1: number }>();

/** The outline path of a SMuFL glyph and its bounding box, cached per code point. */
function glyphBox(cp: number) {
  let g = bboxCache.get(cp);
  if (!g) {
    const d = loadSmufl().pathCp(cp);
    const n = d.match(/-?\d*\.?\d+/g)?.map(Number) ?? [];
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (let i = 0; i + 1 < n.length; i += 2) {
      x0 = Math.min(x0, n[i]);
      x1 = Math.max(x1, n[i]);
      y0 = Math.min(y0, n[i + 1]);
      y1 = Math.max(y1, n[i + 1]);
    }
    g = { d, x0, y0, x1, y1 };
    bboxCache.set(cp, g);
  }
  return g;
}

/** A SMuFL glyph as an icon: centered on its ink and scaled to fit `max` px (never beyond `cap` px per staff space). */
export function Glyph({ cp, max = 24, cap = 10 }: { cp: number; max?: number; cap?: number }) {
  const g = glyphBox(cp);
  const w = g.x1 - g.x0;
  const h = g.y1 - g.y0;
  const k = Math.min(max / Math.max(w, h), cap);
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
      <path
        d={g.d}
        transform={`translate(${18 - ((g.x0 + g.x1) / 2) * k} ${18 - ((g.y0 + g.y1) / 2) * k}) scale(${k})`}
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * An icon whose drawing is centered on its ink: the content is measured after rendering and moved
 * so that the middle of its bounding box is the middle of the `vb` square. `size` (px) is the
 * attribute size; CSS may override it.
 */
function Centered({ vb, size, children }: { vb: number; size?: number; children: preact.ComponentChildren }) {
  const ref = useRef<SVGGElement>(null);
  useLayoutEffect(() => {
    const g = ref.current;
    if (!g) return;
    g.removeAttribute('transform');
    const b = g.getBBox();
    if (b.width > 0 || b.height > 0) {
      g.setAttribute('transform', `translate(${vb / 2 - (b.x + b.width / 2)} ${vb / 2 - (b.y + b.height / 2)})`);
    }
  });
  return (
    <svg width={size} height={size} viewBox={`0 0 ${vb} ${vb}`} aria-hidden="true">
      <g ref={ref}>{children}</g>
    </svg>
  );
}

/** A glyph outline scaled by `k` and centered on its ink at the origin. */
function GlyphPath({ cp, k }: { cp: number; k: number }) {
  const g = glyphBox(cp);
  return (
    <path
      d={g.d}
      transform={`translate(${-((g.x0 + g.x1) / 2) * k} ${-((g.y0 + g.y1) / 2) * k}) scale(${k})`}
      fill="currentColor"
    />
  );
}

let measureCtx: CanvasRenderingContext2D | null | undefined;

/** The ink box of a text in the label font: distances from the baseline origin (left, right, ascent, descent). */
function inkOf(text: string, font: string) {
  if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return null;
  measureCtx.font = font;
  const m = measureCtx.measureText(text);
  return {
    l: m.actualBoundingBoxLeft,
    r: m.actualBoundingBoxRight,
    a: m.actualBoundingBoxAscent,
    d: m.actualBoundingBoxDescent,
  };
}

/** Text icon in one common style, centered on its ink (not on its line box). */
export function Label({
  children,
  italic,
  size = 15,
}: {
  children: preact.ComponentChildren;
  italic?: boolean;
  size?: number;
}) {
  const text = [children].flat().join('');
  const family = "Georgia, 'Noto Serif', serif";
  const ink = inkOf(text, `${italic ? 'italic ' : ''}700 ${size}px ${family}`);
  const x = ink ? 18 + (ink.l - ink.r) / 2 : 18;
  const y = ink ? 18 + (ink.a - ink.d) / 2 : 18;
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
      <text
        x={x}
        y={y}
        dy={ink ? undefined : '.35em'}
        text-anchor={ink ? 'start' : 'middle'}
        font-size={size}
        font-family={family}
        font-weight="700"
        font-style={italic ? 'italic' : 'normal'}
        fill="currentColor"
      >
        {children}
      </text>
    </svg>
  );
}

export const CPS = {
  whole: 0xe1d2,
  half: 0xe1d3,
  quarter: 0xe1d5,
  eighth: 0xe1d7,
  sixteenth: 0xe1d9,
  thirty2: 0xe1db,
  sixty4: 0xe1dd,
  hundred28: 0xe1df,
  restQuarter: 0xe4e5,
  flat: 0xe260,
  natural: 0xe261,
  sharp: 0xe262,
  dsharp: 0xe263,
  dflat: 0xe264,
  gclef: 0xe050,
  fclef: 0xe062,
  cclef: 0xe05c,
  piano: 0xe520,
  forte: 0xe522,
  mezzo: 0xe521,
  ped: 0xe650,
  ottava: 0xe510,
  dot: 0xe1e7,
} as const;

export const Icon = {
  select: () => (
    <Centered vb={40} size={36}>
      <path
        d="M13 9l0 20 5-5 4 9 4-2-4-9 7 0z"
        fill="currentColor"
        stroke="currentColor"
        stroke-width="1"
        stroke-linejoin="round"
      />
    </Centered>
  ),
  slur: () => (
    <Centered vb={40} size={36}>
      <path d="M8 26C14 12 26 12 32 26" fill="none" stroke="currentColor" stroke-width={LW} stroke-linecap="round" />
      <circle cx="8" cy="27" r="2.8" fill="currentColor" />
      <circle cx="32" cy="27" r="2.8" fill="currentColor" />
    </Centered>
  ),
  link: () => (
    <Centered vb={40} size={36}>
      <path d="M9 12L31 28" fill="none" stroke="currentColor" stroke-width={LW} stroke-linecap="round" />
      <circle cx="8" cy="11" r="2.8" fill="currentColor" />
      <circle cx="32" cy="29" r="2.8" fill="currentColor" />
    </Centered>
  ),
  cresc: () => (
    <Centered vb={40} size={36}>
      <path
        d="M7 20L33 12M7 20L33 28"
        fill="none"
        stroke="currentColor"
        stroke-width={LW}
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </Centered>
  ),
  dim: () => (
    <Centered vb={40} size={36}>
      <path
        d="M7 12L33 20M7 28L33 20"
        fill="none"
        stroke="currentColor"
        stroke-width={LW}
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </Centered>
  ),
  tie: () => (
    <Centered vb={40} size={36}>
      <path d="M9 22C14 30 26 30 31 22" fill="none" stroke="currentColor" stroke-width={LW} stroke-linecap="round" />
    </Centered>
  ),
  text: () => <Label italic>Aa</Label>,
  tempo: () => (
    <Centered vb={40} size={36}>
      <g transform="translate(11 20)">
        <GlyphPath cp={0xe1d5} k={6} />
      </g>
      <path d="M22 17h10M22 23h10" fill="none" stroke="currentColor" stroke-width={LW} stroke-linecap="round" />
    </Centered>
  ),
  tuplet: () => (
    <Centered vb={40} size={36}>
      <path
        d="M8 28v-6h24v6"
        fill="none"
        stroke="currentColor"
        stroke-width={LW}
        stroke-linejoin="round"
        stroke-linecap="round"
      />
      <g transform="translate(20 13)">
        <GlyphPath cp={0xe883} k={9} />
      </g>
    </Centered>
  ),
  rest: () => <Glyph cp={CPS.restQuarter} />,
};

/** The stroke width of the palette's line icons (in the 40-unit drawing grid). */
const LW = 2.6;

/** Small line icons for toolbar and Properties panel buttons (24 px grid, drawn in the text color; sized by CSS). */
const S = (d: preact.ComponentChildren, fill = false) => (
  <Centered vb={24}>
    <g
      fill={fill ? 'currentColor' : 'none'}
      stroke={fill ? 'none' : 'currentColor'}
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {d}
    </g>
  </Centered>
);

export const Ui = {
  undo: () =>
    S(
      <>
        <path d="M9 14L4 9l5-5" />
        <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
      </>,
    ),
  redo: () =>
    S(
      <>
        <path d="M15 14l5-5-5-5" />
        <path d="M20 9H10a6 6 0 0 0 0 12h3" />
      </>,
    ),
  plus: () => S(<path d="M12 5v14M5 12h14" />),
  minus: () => S(<path d="M5 12h14" />),
  play: () => S(<path d="M7 4.5v15l12-7.5z" />, true),
  stop: () => S(<rect x="6" y="6" width="12" height="12" />, true),
  help: () =>
    S(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.6 9.5a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2.9-1.2 1.8" />
        <path d="M12 17h.01" />
      </>,
    ),
  up: () => S(<path d="M12 19V5M6 11l6-6 6 6" />),
  down: () => S(<path d="M12 5v14M6 13l6 6 6-6" />),
  barSingle: () => S(<path d="M12 4v16" />),
  barDouble: () => S(<path d="M9 4v16M15 4v16" />),
  barFinal: () =>
    S(
      <>
        <path d="M8 4v16" />
        <path d="M15 4v16" stroke-width="4" />
      </>,
    ),
  barRepeatEnd: () =>
    S(
      <>
        <path d="M13 4v16" />
        <path d="M18 4v16" stroke-width="4" />
        <circle cx="7" cy="10" r="1.2" />
        <circle cx="7" cy="14" r="1.2" />
      </>,
    ),
  accent: () => S(<path d="M5 8l14 4-14 4" />),
  marcato: () => S(<path d="M6 18l6-12 6 12" />),
  staccato: () => S(<circle cx="12" cy="12" r="2.6" />, true),
  fermata: () =>
    S(
      <>
        <path d="M3 18a9 9 0 0118 0" />
        <path d="M12 15h.01" stroke-width="4" />
      </>,
    ),
  trill: () => S(<GlyphPath cp={0xe566} k={3.2} />, true),
  tie: () => S(<path d="M4 10c3 8 13 8 16 0" />),
  arpeggio: () => S(<path d="M12 3q3 2 0 4t0 4 0 4 0 4 0 4" />),
};
