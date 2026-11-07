// Generates the app icon: build/icon.svg (a staff with a treble and a bass clef on a dark rounded square, drawn with the
// engraver's own Leland glyph) and, through rsvg-convert, build/icon.png for electron-builder.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadSmufl } from '../src/smufl.ts';

const SIZE = 1024;
const S = 74; // One staff space in pixels.
const CX = SIZE / 2;
const TOP = SIZE / 2 - 2 * S; // The top staff line.
const G_LINE = TOP + 3 * S; // The treble clef curls around the second line from the bottom.
const F_LINE = TOP + S; // The bass clef sits on the second line from the top.
const GAP = 0.7; // The space between the clefs, in staff spaces.
const X0 = 150;
const X1 = SIZE - 150;

const lines = [0, 1, 2, 3, 4]
  .map((i) => `<line x1="${X0}" x2="${X1}" y1="${TOP + i * S}" y2="${TOP + i * S}"/>`)
  .join('');

const smufl = loadSmufl();
const gAdv = smufl.adv('gClef');
const x0 = CX - ((gAdv + GAP + smufl.adv('fClef')) * S) / 2; // The pair is centred on the icon.

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b3a8f"/><stop offset="1" stop-color="#15153f"/></linearGradient>
<radialGradient id="glow" cx="0.3" cy="0.2" r="0.8"><stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
<linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe9a8"/><stop offset="1" stop-color="#f2b84b"/></linearGradient>
</defs>
<rect x="40" y="40" width="${SIZE - 80}" height="${SIZE - 80}" rx="210" fill="url(#bg)"/>
<rect x="40" y="40" width="${SIZE - 80}" height="${SIZE - 80}" rx="210" fill="url(#glow)"/>
<g stroke="#f4efe2" stroke-opacity="0.85" stroke-width="7" stroke-linecap="round">${lines}</g>
<g fill="url(#gold)">
<path transform="translate(${x0} ${G_LINE}) scale(${S})" d="${smufl.path('gClef')}"/>
<path transform="translate(${x0 + (gAdv + GAP) * S} ${F_LINE}) scale(${S})" d="${smufl.path('fClef')}"/>
</g>
</svg>
`;

mkdirSync('build', { recursive: true });
writeFileSync('build/icon.svg', svg);
execFileSync('rsvg-convert', ['-w', '1024', '-h', '1024', 'build/icon.svg', '-o', 'build/icon.png']);
