// Scene -> SVG: one page of primitives becomes one standalone SVG document.
//
// Glyphs are not text: each distinct SMuFL glyph is emitted once as a <path> in <defs> (outline data
// from smufl.ts) and referenced with <use>, so the SVG renders identically everywhere and converts
// to PDF with rsvg-convert without needing the music font installed. Only the plain text primitives
// (tempo marks, tuplet text, ...) use a font family.
import { loadSmufl } from './smufl.ts';
import type { Page, Prim } from './engrave/scene.ts';

const FONT = "'Liberation Serif', 'Noto Serif CJK KR', 'Noto Serif', serif";

function esc(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
const f3 = (n: number) => (Math.round(n * 1000) / 1000).toString();

export interface SvgOptions {
  /** Per-primitive colour override, used by the editor to highlight the selection. */
  color?: (p: Prim) => string | undefined;
  /** Tag each element with `data-p` = its index in `page.prims`, so an editor can recolour single primitives in the DOM. */
  index?: boolean;
}


/** Renders `page` (sizes in staff spaces) at `staffSpaceMm` millimetres per staff space. Lines are emitted after fills so that they stay on top. */
export function pageToSvg(page: Page, staffSpaceMm: number, opts: SvgOptions = {}): string {
  const sm = loadSmufl();
  const used = new Set<string>();
  const body: string[] = [];
  page.prims.forEach((p, i) => {
    const col = opts.color?.(p);
    const ix = opts.index ? ` data-p="${i}"` : '';
    const fa = col ? ` fill="${col}"` : '', sa = col ? ` stroke="${col}"` : '';
    switch (p.t) {
      case 'glyph': {
        used.add(p.name);
        if (p.rot) body.push(`<use href="#g-${p.name}" transform="translate(${f3(p.x)} ${f3(p.y)}) rotate(${p.rot})"${fa}${ix}/>`);
        else if (p.sx !== undefined || p.sy !== undefined) body.push(`<use href="#g-${p.name}" transform="translate(${f3(p.x)} ${f3(p.y)}) scale(${f3(p.sx ?? 1)} ${f3(p.sy ?? 1)})"${fa}${ix}/>`);
        else body.push(`<use href="#g-${p.name}" x="${f3(p.x)}" y="${f3(p.y)}"${fa}${ix}/>`);
        break;
      }
      case 'line':
        body.push(`<line x1="${f3(p.x1)}" y1="${f3(p.y1)}" x2="${f3(p.x2)}" y2="${f3(p.y2)}" stroke-width="${f3(p.w)}"${sa}${ix}${p.dash ? ` stroke-dasharray="${p.dash[0]} ${p.dash[1]}"` : ''}/>`);
        break;
      case 'path': body.push(`<path d="${p.d}" fill="${col ?? '#000'}" stroke="none"${ix}/>`); break;
      case 'text':
        body.push(`<text x="${f3(p.x)}" y="${f3(p.y)}" font-size="${f3(p.size)}" text-anchor="${p.anchor ?? 'start'}"${fa}${ix}${p.italic ? ' font-style="italic"' : ''}${p.bold ? ' font-weight="bold"' : ''}>${esc(p.s)}</text>`);
        break;
    }
  });
  const defs = [...used].map((n) => `<path id="g-${n}" d="${sm.path(n)}"/>`).join('');
  const wmm = page.width * staffSpaceMm, hmm = page.height * staffSpaceMm;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${f3(wmm)}mm" height="${f3(hmm)}mm" viewBox="0 0 ${f3(page.width)} ${f3(page.height)}">
<defs>${defs}</defs>
<rect width="100%" height="100%" fill="#fff"/>
<g fill="#000" stroke="#000" stroke-linecap="butt" font-family="${FONT}">
<g stroke="none">
${body.filter((b) => !b.startsWith('<line')).join('\n')}
</g>
${body.filter((b) => b.startsWith('<line')).join('\n')}
</g>
</svg>
`;
}
