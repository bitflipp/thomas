// Icons for the palette: SMuFL glyphs from the same font as the score, plus a few drawn shapes and text
// labels. All music glyphs are drawn at one scale with the noteheads of the note values on one line, so
// that the icons keep the proportions of the engraving and read as one set; the drawn shapes use one thin
// stroke that matches the weight of the glyphs. Glyph outlines come from the engraver's font access
// (smufl.ts), the letters of a dynamic are spaced by the engraver (`dynRun`).

import { useLayoutEffect, useRef } from 'preact/hooks';
import { dynRun } from '../src/engrave/marks.ts';
import { CP, loadSmufl } from '../src/smufl.ts';

/** Pixels per staff space of note values, accidentals, dots and noteheads (in the 36-unit icon square). */
export const NOTE_SP = 5.8;

/** Pixels per staff space of signs (accidentals, dynamics, pedal, trill, ottava, tuplet number, grace note), a little larger than the notes so that the small ones do not get lost in their cells. */
export const MARK_SP = 7;

/**
 * The y of the noteheads of the stemmed note values (and of the augmentation dot). A quarter centered on its ink
 * would put it at 26.6, a 64th at 31; this is midway, so both are about 2 units off center and the 64th's flags
 * still fit.
 */
export const HEAD_Y = 28.8;

/** The stroke width of the drawn icons, about the weight of Leland's stems and hairpins at this size. */
const LW = 1.5;

const bboxCache = new Map<number, { d: string; x0: number; y0: number; x1: number; y1: number }>();

/** The outline path of a SMuFL glyph and its bounding box (staff spaces, y down), cached per code point. */
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

/** A run of glyphs: code points with their x offsets in staff spaces. */
type Run = [cp: number, x: number][];

/** Glyph paths of `run` at `k` px per staff space, centered on their ink at x = `cx`; the origin line at `y`, or centered on the ink at `cy` when `y` is not given. */
function RunPaths({ run, k, cx = 18, cy = 18, y }: { run: Run; k: number; cx?: number; cy?: number; y?: number }) {
  let x0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const [cp, x] of run) {
    const g = glyphBox(cp);
    x0 = Math.min(x0, x + g.x0);
    x1 = Math.max(x1, x + g.x1);
    y0 = Math.min(y0, g.y0);
    y1 = Math.max(y1, g.y1);
  }
  const tx = cx - ((x0 + x1) / 2) * k;
  const ty = y ?? cy - ((y0 + y1) / 2) * k;
  return (
    <>
      {run.map(([cp, x]) => (
        <path d={glyphBox(cp).d} transform={`translate(${tx + x * k} ${ty}) scale(${k})`} fill="currentColor" />
      ))}
    </>
  );
}

/** The 36-unit square every palette icon is drawn in. */
function Square({ children }: { children: preact.ComponentChildren }) {
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" overflow="visible" aria-hidden="true">
      {children}
    </svg>
  );
}

/**
 * A SMuFL glyph as an icon, centered sideways on its ink. `y` puts its origin line there (note values and dots
 * at `HEAD_Y`, so their heads line up), else it is centered on its ink. `k` is px per staff space.
 */
export function Glyph({ cp, k = NOTE_SP, y }: { cp: number; k?: number; y?: number }) {
  return (
    <Square>
      <RunPaths run={[[cp, 0]]} k={k} y={y} />
    </Square>
  );
}

/** A quarter note with one or two augmentation dots on the notehead line, as the dot button shows them. */
export function Dots({ n }: { n: number }) {
  const run: Run = [
    [CPS.quarter, 0],
    [CPS.dot, 1.75],
  ];
  if (n === 2) run.push([CPS.dot, 2.5]);
  return (
    <Square>
      <RunPaths run={run} k={NOTE_SP} y={HEAD_Y} />
    </Square>
  );
}

/** A dynamic (`mf`, `pp` ...) from Leland's dynamic glyphs, spaced as the engraver spaces them. */
export function Dynamic({ text }: { text: string }) {
  const r = dynRun(text);
  return (
    <Square>
      <RunPaths run={r.names.map((n, i) => [CP[n], r.xs[i]])} k={MARK_SP} />
    </Square>
  );
}

/** A mark glyph (pedal, trill, ottava, grace note) at the scale of marks. */
export function Mark({ cp, k = MARK_SP }: { cp: number; k?: number }) {
  return <Glyph cp={cp} k={k} />;
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

/** A black notehead at the note scale, centered at (`x`, `y`). */
const Head = ({ x, y }: { x: number; y: number }) => <RunPaths run={[[CPS.head, 0]]} k={NOTE_SP} cx={x} cy={y} />;

let measureCtx: CanvasRenderingContext2D | null | undefined;

/** The ink box of a text in a font: distances from the baseline origin (left, right, ascent, descent). */
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

/** Text icon (upright, regular weight), centered on its ink (not on its line box). */
export function Label({ children, size = 14 }: { children: preact.ComponentChildren; size?: number }) {
  const text = [children].flat().join('');
  const family = "Georgia, 'Noto Serif', serif";
  const ink = inkOf(text, `${size}px ${family}`);
  return (
    <Square>
      <text
        x={ink ? 18 + (ink.l - ink.r) / 2 : 18}
        y={ink ? 18 + (ink.a - ink.d) / 2 : 18}
        dy={ink ? undefined : '.35em'}
        text-anchor={ink ? 'start' : 'middle'}
        font-size={size}
        font-family={family}
        fill="currentColor"
      >
        {children}
      </text>
    </Square>
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
  ottavaAlta: 0xe511,
  ottavaBassaVb: 0xe51c,
  trill: 0xe566,
  grace: 0xe560,
  tuplet3: 0xe883,
  head: 0xe0a4,
  dot: 0xe1e7,
} as const;

const line = { fill: 'none', stroke: 'currentColor', 'stroke-width': LW, 'stroke-linecap': 'round' } as const;

export const Icon = {
  select: () => (
    <Centered vb={36} size={36}>
      <path d="M13 7.5v19l4.6-4.4 3.5 7.8 3.3-1.5-3.5-7.6h6.4z" fill="currentColor" />
    </Centered>
  ),
  // Two noteheads under a slur, which tapers to its ends as an engraved one does.
  slur: () => (
    <Centered vb={36} size={36}>
      <Head x={9} y={25} />
      <Head x={27} y={25} />
      <path d="M7 20.5C11 10.5 25 10.5 29 20.5C25 13 11 13 7 20.5z" fill="currentColor" />
    </Centered>
  ),
  link: () => (
    <Centered vb={36} size={36}>
      <Head x={9} y={25} />
      <Head x={27} y={11} />
      <path d="M11.5 23L24.5 13" {...line} />
    </Centered>
  ),
  cresc: () => (
    <Centered vb={36} size={36}>
      <path d="M28 12L8 18L28 24" {...line} stroke-linejoin="round" />
    </Centered>
  ),
  dim: () => (
    <Centered vb={36} size={36}>
      <path d="M8 12L28 18L8 24" {...line} stroke-linejoin="round" />
    </Centered>
  ),
  text: () => <Label>Aa</Label>,
  tempo: () => (
    <Centered vb={36} size={36}>
      <RunPaths run={[[CPS.quarter, 0]]} k={NOTE_SP} cx={12} y={25} />
      <path d="M19.5 19h8M19.5 23h8" {...line} />
    </Centered>
  ),
  tuplet: () => (
    <Centered vb={36} size={36}>
      <path d="M7 27v-5h6.5M22.5 22H29v5" {...line} stroke-linejoin="round" />
      <RunPaths run={[[CPS.tuplet3, 0]]} k={MARK_SP} cy={20.5} />
    </Centered>
  ),
  rest: () => <Glyph cp={CPS.restQuarter} />,
};

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
