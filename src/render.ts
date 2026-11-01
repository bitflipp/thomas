// Scene -> SVG
import { loadSmufl } from './smufl.ts';
import type { Page, Prim } from './engrave/scene.ts';

const FONT = "'Liberation Serif', 'Noto Serif CJK KR', 'Noto Serif', serif";

function esc(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
const f3 = (n: number) => (Math.round(n * 1000) / 1000).toString();

export interface SvgOptions { color?: (p: Prim) => string | undefined } // per-primitive colour override (selection highlight)

export function pageToSvg(page: Page, staffSpaceMm: number, opts: SvgOptions = {}): string {
  const sm = loadSmufl();
  const used = new Set<string>();
  const body: string[] = [];
  for (const p of page.prims) {
    const col = opts.color?.(p);
    const fa = col ? ` fill="${col}"` : '', sa = col ? ` stroke="${col}"` : '';
    switch (p.t) {
      case 'glyph': {
        used.add(p.name);
        if (p.rot) body.push(`<use href="#g-${p.name}" transform="translate(${f3(p.x)} ${f3(p.y)}) rotate(${p.rot})"${fa}/>`);
        else if (p.sx !== undefined || p.sy !== undefined) body.push(`<use href="#g-${p.name}" transform="translate(${f3(p.x)} ${f3(p.y)}) scale(${f3(p.sx ?? 1)} ${f3(p.sy ?? 1)})"${fa}/>`);
        else body.push(`<use href="#g-${p.name}" x="${f3(p.x)}" y="${f3(p.y)}"${fa}/>`);
        break;
      }
      case 'line':
        body.push(`<line x1="${f3(p.x1)}" y1="${f3(p.y1)}" x2="${f3(p.x2)}" y2="${f3(p.y2)}" stroke-width="${f3(p.w)}"${sa}${p.dash ? ` stroke-dasharray="${p.dash[0]} ${p.dash[1]}"` : ''}/>`);
        break;
      case 'path': body.push(`<path d="${p.d}" fill="${col ?? '#000'}" stroke="none"/>`); break;
      case 'text':
        body.push(`<text x="${f3(p.x)}" y="${f3(p.y)}" font-size="${f3(p.size)}" text-anchor="${p.anchor ?? 'start'}"${fa}${p.italic ? ' font-style="italic"' : ''}${p.bold ? ' font-weight="bold"' : ''}>${esc(p.s)}</text>`);
        break;
    }
  }
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
