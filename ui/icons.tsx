// Icons for the palette: SMuFL glyphs from the same font as the score, centred on their ink and
// scaled to fit, plus text labels. Glyph outlines come from the engraver's font access (smufl.ts).
import { loadSmufl } from '../src/smufl.ts';

const bboxCache = new Map<number, { d: string; x0: number; y0: number; x1: number; y1: number }>();
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

/** A SMuFL glyph as an icon: centred on its ink and scaled to fit `max` px (never beyond `cap` px per staff space). */
export function Glyph({ cp, max = 24, cap = 7.5 }: { cp: number; max?: number; cap?: number }) {
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

/** Text icon in one common style. */
export function Label({
  children,
  italic,
  size = 15,
}: {
  children: preact.ComponentChildren;
  italic?: boolean;
  size?: number;
}) {
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
      <text
        x="18"
        y="18"
        dy=".35em"
        text-anchor="middle"
        font-size={size}
        font-family="Georgia, 'Noto Serif', serif"
        font-weight="700"
        font-style={italic ? 'italic' : 'normal'}
        fill="currentColor"
      >
        {children}
      </text>
    </svg>
  );
}

function Glyph2() {
  const g = glyphBox(0xe1d5);
  const k = 5.5;
  return (
    <path
      d={g.d}
      transform={
        `translate(${-((g.x0 + g.x1) / 2) * k + 6} ${-((g.y0 + g.y1) / 2) * k})`.replace(/translate\(/, 'translate(') +
        ` scale(${k})`
      }
      fill="currentColor"
    />
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
    <svg aria-hidden="true" width="36" height="36" viewBox="0 0 40 40">
      <path d="M13 9l0 20 5-5 4 9 4-2-4-9 7 0z" fill="currentColor" />
    </svg>
  ),
  slur: () => (
    <svg aria-hidden="true" width="36" height="36" viewBox="0 0 40 40">
      <path d="M8 26C14 12 26 12 32 26" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
      <circle cx="8" cy="27" r="2.6" fill="currentColor" />
      <circle cx="32" cy="27" r="2.6" fill="currentColor" />
    </svg>
  ),
  cresc: () => (
    <svg aria-hidden="true" width="36" height="36" viewBox="0 0 40 40">
      <path d="M7 20L33 12M7 20L33 28" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
    </svg>
  ),
  dim: () => (
    <svg aria-hidden="true" width="36" height="36" viewBox="0 0 40 40">
      <path d="M7 12L33 20M7 28L33 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
    </svg>
  ),
  tie: () => (
    <svg aria-hidden="true" width="36" height="36" viewBox="0 0 40 40">
      <path d="M9 22C14 30 26 30 31 22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
    </svg>
  ),
  text: () => <Label italic>Aa</Label>,
  tempo: () => (
    <svg aria-hidden="true" width="36" height="36" viewBox="0 0 36 36">
      <g transform="translate(6 18) scale(1)">
        <Glyph2 />
      </g>
      <text
        x="24"
        y="18"
        dy=".35em"
        text-anchor="middle"
        font-size="17"
        font-family="Georgia, 'Noto Serif', serif"
        font-weight="700"
        fill="currentColor"
      >
        =
      </text>
    </svg>
  ),
  tuplet: () => (
    <svg aria-hidden="true" width="36" height="36" viewBox="0 0 40 40">
      <path d="M8 25v-6h24v6" fill="none" stroke="currentColor" stroke-width="2.4" />
      <text
        x="20"
        y="17"
        text-anchor="middle"
        font-size="14"
        font-weight="700"
        font-style="italic"
        font-family="Georgia, serif"
        fill="currentColor"
      >
        3
      </text>
    </svg>
  ),
  rest: () => <Glyph cp={CPS.restQuarter} />,
};

/** Small line icons for toolbar and inspector buttons (24 px grid, drawn in the text colour; sized by CSS). */
const S = (d: preact.ComponentChildren, fill = false) => (
  <svg
    viewBox="0 0 24 24"
    fill={fill ? 'currentColor' : 'none'}
    stroke={fill ? 'none' : 'currentColor'}
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {d}
  </svg>
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
  stop: () => S(<rect x="6" y="6" width="12" height="12" rx="1" />, true),
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
  accent: () => S(<path d="M5 8l14 4-14 4" />),
  marcato: () => S(<path d="M6 18l6-12 6 12" />),
  staccato: () => S(<circle cx="12" cy="12" r="2.6" />, true),
  tie: () => S(<path d="M4 10c3 8 13 8 16 0" />),
  arpeggio: () => S(<path d="M12 3q3 2 0 4t0 4 0 4 0 4 0 4" />),
};
