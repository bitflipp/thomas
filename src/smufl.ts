// SMuFL font access (Bravura): glyph outlines as SVG path data, metrics in staff spaces.
//
// The engraver refers to glyphs by SMuFL name (`noteheadBlack`); `CP` is the only place that knows
// their codepoints, so adding a glyph means adding it there (and running `checkCodepoints`).
// Outlines and metrics come from the font file and its metadata.json, loaded lazily on first use
// (see `loadSmufl`) so that importing the engraver never touches the file system by itself.
import opentype from 'opentype.js';

/** SMuFL glyph name -> codepoint, for exactly the glyphs the engraver uses. */
export const CP: Record<string, number> = {
  brace: 0xE000,
  noteheadWhole: 0xE0A2, noteheadHalf: 0xE0A3, noteheadBlack: 0xE0A4,
  restDoubleWhole: 0xE4E2, restWhole: 0xE4E3, restHalf: 0xE4E4, restQuarter: 0xE4E5, rest8th: 0xE4E6,
  rest16th: 0xE4E7, rest32nd: 0xE4E8, rest64th: 0xE4E9,
  accidentalFlat: 0xE260, accidentalNatural: 0xE261, accidentalSharp: 0xE262, accidentalDoubleSharp: 0xE263,
  accidentalDoubleFlat: 0xE264, accidentalParensLeft: 0xE26A, accidentalParensRight: 0xE26B,
  augmentationDot: 0xE1E7,
  flag8thUp: 0xE240, flag8thDown: 0xE241, flag16thUp: 0xE242, flag16thDown: 0xE243,
  flag32ndUp: 0xE244, flag32ndDown: 0xE245, flag64thUp: 0xE246, flag64thDown: 0xE247,
  gClef: 0xE050, gClef8vb: 0xE052, gClef8va: 0xE053, fClef: 0xE062, fClef8vb: 0xE064, fClef8va: 0xE065, cClef: 0xE05C,
  gClefChange: 0xE07A, cClefChange: 0xE07B, fClefChange: 0xE07C,
  timeSig0: 0xE080, timeSig1: 0xE081, timeSig2: 0xE082, timeSig3: 0xE083, timeSig4: 0xE084,
  timeSig5: 0xE085, timeSig6: 0xE086, timeSig7: 0xE087, timeSig8: 0xE088, timeSig9: 0xE089,
  articAccentAbove: 0xE4A0, articAccentBelow: 0xE4A1, articStaccatoAbove: 0xE4A2, articStaccatoBelow: 0xE4A3,
  articMarcatoAbove: 0xE4AC, articMarcatoBelow: 0xE4AD,
  dynamicPiano: 0xE520, dynamicMezzo: 0xE521, dynamicForte: 0xE522, dynamicRinforzando: 0xE523,
  dynamicSforzando: 0xE524, dynamicZ: 0xE525, dynamicNiente: 0xE526,
  tuplet0: 0xE880, tuplet1: 0xE881, tuplet2: 0xE882, tuplet3: 0xE883, tuplet4: 0xE884,
  tuplet5: 0xE885, tuplet6: 0xE886, tuplet7: 0xE887, tuplet8: 0xE888, tuplet9: 0xE889, tupletColon: 0xE88A,
  wiggleArpeggiatoUp: 0xEAA9,
  keyboardPedalPed: 0xE650, keyboardPedalParensLeft: 0xE676, keyboardPedalParensRight: 0xE677, keyboardPedalUp: 0xE655,
  ottava: 0xE510, ottavaAlta: 0xE511, ottavaBassa: 0xE512,
  metNoteHalfUp: 0xE1D3, metNoteQuarterUp: 0xE1D5, metAugmentationDot: 0xE1FC,
};

/** A glyph's bounding box in staff spaces relative to its origin; y points up here (font convention), unlike the scene. */
export interface BBox { x0: number; y0: number; x1: number; y1: number }

export interface Smufl {
  has(name: string): boolean;
  /** Path data of any codepoint of the font, not only those in `CP` (used for UI icons). */
  pathCp(cp: number): string;
  /** Path data of a named glyph in staff spaces, origin at the glyph origin, y down. */
  path(name: string): string;
  bbox(name: string): BBox;
  adv(name: string): number;
  /** A named SMuFL anchor point (`stemUpSE`, `cutOutNE`, ...) in staff spaces, y up. */
  anchor(name: string, key: string): [number, number] | undefined;
  def: Record<string, number>;
}

let cached: Smufl | null = null;
let source: { buf: ArrayBuffer; meta: any } | null = null;

/** Provide the font data explicitly (browser); without it, loadSmufl reads it from node_modules. */
export function setSmuflSource(buf: ArrayBuffer, meta: unknown): void { source = { buf, meta }; cached = null; }

function nodeSource(): { buf: ArrayBuffer; meta: any } {
  const fs = (process as any).getBuiltinModule('node:fs');
  const base = new URL('../node_modules/@vexflow-fonts/bravura/', import.meta.url);
  const b = fs.readFileSync(new URL('bravura.otf', base)) as Uint8Array;
  return { buf: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, meta: JSON.parse(fs.readFileSync(new URL('metadata.json', base), 'utf8')) };
}

/** A facade that reads the font on first use, so modules may call this at import time (before a browser has fetched the font). */
export function loadSmufl(): Smufl {
  return facade;
}
const facade: Smufl = {
  has: (n) => n in CP,
  path: (n) => real().path(n),
  pathCp: (cp) => real().pathCp(cp),
  bbox: (n) => real().bbox(n),
  adv: (n) => real().adv(n),
  anchor: (n, k) => real().anchor(n, k),
  get def() { return real().def; },
};

function real(): Smufl {
  if (cached) return cached;
  const { buf, meta } = (source ??= nodeSource());
  const font = opentype.parse(buf);
  const paths = new Map<string, string>();
  const sm: Smufl = {
    has: (n) => n in CP,
    path(name) {
      let p = paths.get(name);
      if (p === undefined) {
        const cp = CP[name];
        if (cp === undefined) throw new Error(`unknown glyph ${name}`);
        const g = font.charToGlyph(String.fromCodePoint(cp));
        p = g.getPath(0, 0, 4).toPathData(3);
        paths.set(name, p);
      }
      return p;
    },
    pathCp(cp) { return font.charToGlyph(String.fromCodePoint(cp)).getPath(0, 0, 4).toPathData(3); },
    bbox(name) {
      const b = meta.glyphBBoxes[name];
      if (!b) throw new Error(`no bbox for ${name}`);
      return { x0: b.bBoxSW[0], y0: b.bBoxSW[1], x1: b.bBoxNE[0], y1: b.bBoxNE[1] };
    },
    adv(name) {
      const a = meta.glyphAdvanceWidths[name];
      if (a === undefined) throw new Error(`no advance for ${name}`);
      return a;
    },
    anchor(name, key) { return meta.glyphsWithAnchors[name]?.[key]; },
    def: meta.engravingDefaults,
  };
  cached = sm;
  return sm;
}

/** Debugging helper: checks the `CP` table against the advance widths in the font's metadata (a wrong codepoint shows as a mismatch). */
export function checkCodepoints(): string[] {
  const { buf, meta } = (source ??= nodeSource());
  const font = opentype.parse(buf);
  const bad: string[] = [];
  for (const [name, cp] of Object.entries(CP)) {
    const g = font.charToGlyph(String.fromCodePoint(cp));
    const a = meta.glyphAdvanceWidths[name];
    if (a === undefined) { bad.push(`${name}: not in metadata`); continue; }
    const fa = g.advanceWidth / 250;
    if (Math.abs(a - fa) > 0.01) bad.push(`${name}: metadata adv ${a} vs font ${fa.toFixed(3)} at U+${cp.toString(16)}`);
  }
  return bad;
}
