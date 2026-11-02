// SMuFL font access (Bravura): glyph outlines as SVG path data, metrics in staff spaces.
//
// The engraver refers to glyphs by SMuFL name (`noteheadBlack`); `CP` is the only place that knows
// their codepoints, so adding a glyph means adding it there (and running `checkCodepoints`).
// Outlines and metrics come from the font file and its metadata.json, loaded lazily on first use
// (see `loadSmufl`) so that importing the engraver never touches the file system by itself.
import opentype from 'opentype.js';

/** SMuFL glyph name -> codepoint, for exactly the glyphs the engraver uses. */
export const CP: Record<string, number> = {
  brace: 0xe000,
  noteheadWhole: 0xe0a2,
  noteheadHalf: 0xe0a3,
  noteheadBlack: 0xe0a4,
  restDoubleWhole: 0xe4e2,
  restWhole: 0xe4e3,
  restHalf: 0xe4e4,
  restQuarter: 0xe4e5,
  rest8th: 0xe4e6,
  rest16th: 0xe4e7,
  rest32nd: 0xe4e8,
  rest64th: 0xe4e9,
  rest128th: 0xe4ea,
  accidentalFlat: 0xe260,
  accidentalNatural: 0xe261,
  accidentalSharp: 0xe262,
  accidentalDoubleSharp: 0xe263,
  accidentalDoubleFlat: 0xe264,
  accidentalParensLeft: 0xe26a,
  accidentalParensRight: 0xe26b,
  augmentationDot: 0xe1e7,
  flag8thUp: 0xe240,
  flag8thDown: 0xe241,
  flag16thUp: 0xe242,
  flag16thDown: 0xe243,
  flag32ndUp: 0xe244,
  flag32ndDown: 0xe245,
  flag64thUp: 0xe246,
  flag64thDown: 0xe247,
  flag128thUp: 0xe248,
  flag128thDown: 0xe249,
  gClef: 0xe050,
  gClef8vb: 0xe052,
  gClef8va: 0xe053,
  fClef: 0xe062,
  fClef8vb: 0xe064,
  fClef8va: 0xe065,
  cClef: 0xe05c,
  gClefChange: 0xe07a,
  cClefChange: 0xe07b,
  fClefChange: 0xe07c,
  timeSig0: 0xe080,
  timeSig1: 0xe081,
  timeSig2: 0xe082,
  timeSig3: 0xe083,
  timeSig4: 0xe084,
  timeSig5: 0xe085,
  timeSig6: 0xe086,
  timeSig7: 0xe087,
  timeSig8: 0xe088,
  timeSig9: 0xe089,
  articAccentAbove: 0xe4a0,
  articAccentBelow: 0xe4a1,
  articStaccatoAbove: 0xe4a2,
  articStaccatoBelow: 0xe4a3,
  articMarcatoAbove: 0xe4ac,
  articMarcatoBelow: 0xe4ad,
  dynamicPiano: 0xe520,
  dynamicMezzo: 0xe521,
  dynamicForte: 0xe522,
  dynamicRinforzando: 0xe523,
  dynamicSforzando: 0xe524,
  dynamicZ: 0xe525,
  dynamicNiente: 0xe526,
  tuplet0: 0xe880,
  tuplet1: 0xe881,
  tuplet2: 0xe882,
  tuplet3: 0xe883,
  tuplet4: 0xe884,
  tuplet5: 0xe885,
  tuplet6: 0xe886,
  tuplet7: 0xe887,
  tuplet8: 0xe888,
  tuplet9: 0xe889,
  tupletColon: 0xe88a,
  wiggleArpeggiatoUp: 0xeaa9,
  keyboardPedalPed: 0xe650,
  keyboardPedalParensLeft: 0xe676,
  keyboardPedalParensRight: 0xe677,
  keyboardPedalUp: 0xe655,
  ottava: 0xe510,
  ottavaAlta: 0xe511,
  ottavaBassa: 0xe512,
  metNoteHalfUp: 0xe1d3,
  metNoteQuarterUp: 0xe1d5,
  metAugmentationDot: 0xe1fc,
};

/** A glyph's bounding box in staff spaces relative to its origin; y points up here (font convention), unlike the scene. */
export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

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
/** The parts of Bravura's metadata.json that are used. */
export interface FontMeta {
  glyphBBoxes: Record<string, { bBoxNE: [number, number]; bBoxSW: [number, number] }>;
  glyphAdvanceWidths: Record<string, number>;
  glyphsWithAnchors: Record<string, Record<string, [number, number]> | undefined>;
  engravingDefaults: Record<string, number>;
}
let source: { buf: ArrayBuffer; meta: FontMeta } | null = null;

/** Provide the font data explicitly (browser); without it, loadSmufl reads it from node_modules. */
export function setSmuflSource(buf: ArrayBuffer, meta: FontMeta): void {
  source = { buf, meta };
  cached = null;
}

function nodeSource(): { buf: ArrayBuffer; meta: FontMeta } {
  const fs = (process as unknown as { getBuiltinModule(id: 'node:fs'): typeof import('node:fs') }).getBuiltinModule(
    'node:fs',
  );
  const base = new URL('../node_modules/@vexflow-fonts/bravura/', import.meta.url);
  const b = fs.readFileSync(new URL('bravura.otf', base)) as Uint8Array;
  return {
    buf: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
    meta: JSON.parse(fs.readFileSync(new URL('metadata.json', base), 'utf8')),
  };
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
  get def() {
    return real().def;
  },
};

function real(): Smufl {
  if (cached) return cached;
  source ??= nodeSource();
  const { buf, meta } = source;
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
    pathCp(cp) {
      return font.charToGlyph(String.fromCodePoint(cp)).getPath(0, 0, 4).toPathData(3);
    },
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
    anchor(name, key) {
      return meta.glyphsWithAnchors[name]?.[key];
    },
    def: meta.engravingDefaults,
  };
  cached = sm;
  return sm;
}

/** Debugging helper: checks the `CP` table against the advance widths in the font's metadata (a wrong codepoint shows as a mismatch). */
export function checkCodepoints(): string[] {
  source ??= nodeSource();
  const { buf, meta } = source;
  const font = opentype.parse(buf);
  const bad: string[] = [];
  for (const [name, cp] of Object.entries(CP)) {
    const g = font.charToGlyph(String.fromCodePoint(cp));
    const a = meta.glyphAdvanceWidths[name];
    if (a === undefined) {
      bad.push(`${name}: not in metadata`);
      continue;
    }
    const fa = g.advanceWidth / 250;
    if (Math.abs(a - fa) > 0.01)
      bad.push(`${name}: metadata adv ${a} vs font ${fa.toFixed(3)} at U+${cp.toString(16)}`);
  }
  return bad;
}
