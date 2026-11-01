// Icons for the palette: SMuFL glyphs from the same font as the score, centred on their ink and
// scaled to fit, plus text labels. Glyph outlines come from the engraver's font access (smufl.ts).
import { loadSmufl } from '../src/smufl.ts';

const bboxCache = new Map<number, { d: string; x0: number; y0: number; x1: number; y1: number }>();
function glyphBox(cp: number) {
  let g = bboxCache.get(cp);
  if (!g) {
    const d = loadSmufl().pathCp(cp);
    const n = d.match(/-?\d*\.?\d+/g)?.map(Number) ?? [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i + 1 < n.length; i += 2) { x0 = Math.min(x0, n[i]); x1 = Math.max(x1, n[i]); y0 = Math.min(y0, n[i + 1]); y1 = Math.max(y1, n[i + 1]); }
    g = { d, x0, y0, x1, y1 };
    bboxCache.set(cp, g);
  }
  return g;
}

/** A SMuFL glyph as an icon: centred on its ink and scaled to fit `max` px (never beyond `cap` px per staff space). */
export function Glyph({ cp, max = 24, cap = 7.5 }: { cp: number; max?: number; cap?: number }) {
  const g = glyphBox(cp);
  const w = g.x1 - g.x0, h = g.y1 - g.y0;
  const k = Math.min(max / Math.max(w, h), cap);
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
      <path d={g.d} transform={`translate(${18 - ((g.x0 + g.x1) / 2) * k} ${18 - ((g.y0 + g.y1) / 2) * k}) scale(${k})`} fill="currentColor" />
    </svg>
  );
}

/** Text icon in one common style. */
export function Label({ children, italic, size = 15 }: { children: preact.ComponentChildren; italic?: boolean; size?: number }) {
  return <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true"><text x="18" y="18" dy=".35em" text-anchor="middle" font-size={size} font-family="Georgia, 'Noto Serif', serif" font-weight="700" font-style={italic ? 'italic' : 'normal'} fill="currentColor">{children}</text></svg>;
}

function Glyph2() { const g = glyphBox(0xE1D5); const k = 5.5; return <path d={g.d} transform={`translate(${-((g.x0 + g.x1) / 2) * k + 6} ${-((g.y0 + g.y1) / 2) * k})`.replace(/translate\(/, 'translate(') + ` scale(${k})`} fill="currentColor" />; }

export const CPS = {
  whole: 0xE1D2, half: 0xE1D3, quarter: 0xE1D5, eighth: 0xE1D7, sixteenth: 0xE1D9, thirty2: 0xE1DB, sixty4: 0xE1DD,
  restQuarter: 0xE4E5, flat: 0xE260, natural: 0xE261, sharp: 0xE262, dsharp: 0xE263, dflat: 0xE264,
  gclef: 0xE050, fclef: 0xE062, cclef: 0xE05C,
  piano: 0xE520, forte: 0xE522, mezzo: 0xE521, ped: 0xE650, ottava: 0xE510, dot: 0xE1E7,
} as const;

export const Icon = {
  select: () => <svg width="36" height="36" viewBox="0 0 40 40"><path d="M13 9l0 20 5-5 4 9 4-2-4-9 7 0z" fill="currentColor" /></svg>,
  slur: () => <svg width="36" height="36" viewBox="0 0 40 40"><path d="M8 26C14 12 26 12 32 26" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" /><circle cx="8" cy="27" r="2.6" fill="currentColor" /><circle cx="32" cy="27" r="2.6" fill="currentColor" /></svg>,
  cresc: () => <svg width="36" height="36" viewBox="0 0 40 40"><path d="M7 20L33 12M7 20L33 28" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" /></svg>,
  dim: () => <svg width="36" height="36" viewBox="0 0 40 40"><path d="M7 12L33 20M7 28L33 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" /></svg>,
  tie: () => <svg width="36" height="36" viewBox="0 0 40 40"><path d="M9 22C14 30 26 30 31 22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" /></svg>,
  text: () => <Label italic>Aa</Label>,
  tempo: () => <svg width="36" height="36" viewBox="0 0 36 36"><g transform="translate(6 18) scale(1)"><Glyph2 /></g><text x="24" y="18" dy=".35em" text-anchor="middle" font-size="17" font-family="Georgia, 'Noto Serif', serif" font-weight="700" fill="currentColor">=</text></svg>,
  tuplet: () => <svg width="36" height="36" viewBox="0 0 40 40"><path d="M8 25v-6h24v6" fill="none" stroke="currentColor" stroke-width="2.4" /><text x="20" y="17" text-anchor="middle" font-size="14" font-weight="700" font-style="italic" font-family="Georgia, serif" fill="currentColor">3</text></svg>,
  rest: () => <Glyph cp={CPS.restQuarter} />,
};
