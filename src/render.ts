// Scene -> SVG: one page of primitives becomes one standalone SVG document.
//
// Glyphs are not text: each distinct SMuFL glyph is emitted once as a <path> in <defs> (outline data
// from smufl.ts) and referenced with <use>, so the SVG renders identically everywhere and converts
// to PDF with rsvg-convert without needing the music font installed. Only the plain text primitives
// (tempo marks, tuplet text, ...) use a font family.

import type { Page, Prim } from './engrave/scene.ts';
import { loadSmufl } from './smufl.ts';
import { round3 } from './util.ts';

const FONT = "'Liberation Serif', 'Noto Serif CJK KR', 'Noto Serif', serif";

/** Escapes the characters that are special in XML text. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface SvgOptions {
  /** Per-primitive color override, used by the editor to highlight the selection. */
  color?: (p: Prim) => string | undefined;
  /** Tag each element with `data-p` = its index in `page.prims`, so an editor can recolor single primitives in the DOM. */
  index?: boolean;
  /** Keep the editor-only ghost primitives (hidden rests); they are left out by default. */
  ghosts?: boolean;
  /** Show only this region (staff spaces) of the page instead of all of it. */
  crop?: { x: number; y: number; w: number; h: number };
}

/** Renders `page` (sizes in staff spaces) at `staffSpaceMm` millimetres per staff space. Lines are emitted after fills so that they stay on top. */
export function pageToSvg(page: Page, staffSpaceMm: number, opts: SvgOptions = {}): string {
  const sm = loadSmufl();
  const used = new Set<string>();
  const body: string[] = [];
  page.prims.forEach((p, i) => {
    if (p.ghost && !opts.ghosts) return;
    const col = opts.color?.(p);
    const ix = opts.index ? ` data-p="${i}"` : '';
    const fa = col ? ` fill="${col}"` : '';
    const sa = col ? ` stroke="${col}"` : '';
    switch (p.t) {
      case 'glyph': {
        used.add(p.name);
        if (p.rot)
          body.push(
            `<use href="#g-${p.name}" transform="translate(${round3(p.x)} ${round3(p.y)}) rotate(${p.rot})"${fa}${ix}/>`,
          );
        else if (p.sx !== undefined || p.sy !== undefined)
          body.push(
            `<use href="#g-${p.name}" transform="translate(${round3(p.x)} ${round3(p.y)}) scale(${round3(p.sx ?? 1)} ${round3(p.sy ?? 1)})"${fa}${ix}/>`,
          );
        else body.push(`<use href="#g-${p.name}" x="${round3(p.x)}" y="${round3(p.y)}"${fa}${ix}/>`);
        break;
      }
      case 'line':
        body.push(
          `<line x1="${round3(p.x1)}" y1="${round3(p.y1)}" x2="${round3(p.x2)}" y2="${round3(p.y2)}" stroke-width="${round3(p.w)}"${sa}${ix}${p.dash ? ` stroke-dasharray="${p.dash[0]} ${p.dash[1]}"` : ''}/>`,
        );
        break;
      case 'path':
        body.push(
          `<path d="${p.d}"${p.dx || p.dy ? ` transform="translate(${round3(p.dx ?? 0)} ${round3(p.dy ?? 0)})"` : ''} fill="${p.fill ?? col ?? '#000'}" stroke="none"${ix}${p.top ? ' data-top="1"' : ''}/>`,
        );
        break;
      case 'text':
        body.push(
          `<text x="${round3(p.x)}" y="${round3(p.y)}" font-size="${round3(p.size)}" text-anchor="${p.anchor ?? 'start'}"${fa}${ix}${p.top ? ' data-top="1"' : ''}${p.italic ? ' font-style="italic"' : ''}${p.bold ? ' font-weight="bold"' : ''}>${esc(p.s)}</text>`,
        );
        break;
    }
  });
  const defs = [...used].map((n) => `<path id="g-${n}" d="${sm.path(n)}"/>`).join('');
  const { x, y, w, h } = opts.crop ?? { x: 0, y: 0, w: page.width, h: page.height };
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${round3(w * staffSpaceMm)}mm" height="${round3(h * staffSpaceMm)}mm" viewBox="${round3(x)} ${round3(y)} ${round3(w)} ${round3(h)}">
<defs>${defs}</defs>
<rect x="${round3(x)}" y="${round3(y)}" width="${round3(w)}" height="${round3(h)}" fill="#fff"/>
<g fill="#000" stroke="#000" stroke-linecap="butt" font-family="${FONT}">
<g stroke="none">
${body.filter((b) => !(b.startsWith('<line') || b.includes(' data-top="1"'))).join('\n')}
</g>
${body.filter((b) => b.startsWith('<line')).join('\n')}
<g stroke="none">
${body.filter((b) => b.includes(' data-top="1"')).join('\n')}
</g>
</g>
</svg>
`;
}
