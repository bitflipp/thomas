// Clefs, key signatures and time signatures: which glyphs, where on the staff, how wide, and the
// drawing of the signatures that start a system or change inside it.
import type { Clef } from '../model.ts';
import { keyAt, timeAt } from '../model.ts';
import { loadSmufl } from '../smufl.ts';
import type { SysCtx } from './draw.ts';
import { xAtTick } from './draw.ts';
import type { Prepared } from './prep.ts';
import { clefBottomStep, posToY } from './prep.ts';
import type { Prim } from './scene.ts';
import { oid, tagFrom } from './scene.ts';
import { keyChange } from './spacing.ts';

const sm = loadSmufl();

/** Gap between consecutive accidentals of a key signature (staff spaces). */
const KEY_ACCIDENTAL_GAP = 0.12;
/** Left margin of the clef at the start of a system. */
const CLEF_X = 0.9;

/** Staff positions (half spaces above the bottom line) of the sharps and flats of a key signature in the treble clef, in order of fifths; other clefs shift them by whole octaves. */
const SHARP_POS_TREBLE = [8, 5, 9, 6, 3, 7, 4];
const FLAT_POS_TREBLE = [4, 7, 3, 6, 2, 5, 1];

type TimeSignature = { beats: number; beatType: number };

export function clefGlyph(c: Clef, change = false): { name: string; y: number } {
  const y = 4 - (c.line - 1);
  if (c.sign === 'G')
    return { name: change ? 'gClefChange' : c.octave === -1 ? 'gClef8vb' : c.octave === 1 ? 'gClef8va' : 'gClef', y };
  if (c.sign === 'F')
    return { name: change ? 'fClefChange' : c.octave === -1 ? 'fClef8vb' : c.octave === 1 ? 'fClef8va' : 'fClef', y };
  return { name: change ? 'cClefChange' : 'cClef', y };
}

function keyPositions(fifths: number, clef: Clef): number[] {
  // The treble pattern moves by the difference of the bottom lines modulo an octave (a seventh),
  // so e.g. bass clef sharps sit a third lower.
  const shift = (((clefBottomStep({ sign: 'G', line: 2 }) - clefBottomStep(clef)) % 7) + 7) % 7;
  // Use the signed offset (bass: two steps down, not five up) and wrap each kind into its window.
  const d = shift > 3 ? shift - 7 : shift;
  const base = fifths > 0 ? SHARP_POS_TREBLE.slice(0, fifths) : FLAT_POS_TREBLE.slice(0, -fifths);
  // Flats keep the treble window [1, 7] moved by the offset (bass: -1..5, the last flat lowest).
  return base.map((p) => {
    let q = p + d;
    if (fifths > 0) {
      while (q > 9) q -= 7;
    } else {
      while (q < 1 + d) q += 7;
      while (q > 7 + d) q -= 7;
    }
    return q;
  });
}

function keyWidth(fifths: number): number {
  if (!fifths) return 0;
  const g = fifths > 0 ? 'accidentalSharp' : 'accidentalFlat';
  return Math.abs(fifths) * (sm.adv(g) + KEY_ACCIDENTAL_GAP) + 0.9;
}

function timeWidth(ts: TimeSignature): number {
  return Math.max(String(ts.beats).length, String(ts.beatType).length) * sm.adv('timeSig2') + 1.3;
}

/** Width reserved at the left of a system for its clefs, key signature and (on the first system) time signature. */
export function prefixWidth(prep: Prepared, mi: number, first: boolean): number {
  const score = prep.score;
  let cw = 0;
  score.staves.forEach((_, si) => {
    cw = Math.max(cw, sm.adv(clefGlyph(prep.clefAt(si, mi, 0)).name));
  });
  let w = CLEF_X + cw + 1.0;
  w += keyWidth(prep.keyOf[mi]);
  if (first) w += timeWidth(prep.timeOf[mi]);
  return w;
}

/** Draws a time signature as stacked digits, each row centred on the wider one. */
function drawTimeSig(P: Prim[], x: number, y0: number, ts: TimeSignature): void {
  const wn = String(ts.beats).length;
  const wd = String(ts.beatType).length;
  const w = sm.adv('timeSig2');
  const maxw = Math.max(wn, wd) * w;
  const drawNumber = (n: number, y: number, len: number) => {
    const off = (maxw - len * w) / 2;
    let px = x + off;
    for (const ch of String(n)) {
      P.push({ t: 'glyph', name: `timeSig${ch}`, x: px, y });
      px += w;
    }
  };
  const n0 = P.length;
  drawNumber(ts.beats, y0 + 1, wn);
  drawNumber(ts.beatType, y0 + 3, wd);
  tagFrom(P, n0, 'timesig', oid({}));
}

/** Initial clef, then key signature, then (at the start of the piece only) the time signature, left to right. */
export function drawSystemStart(P: Prim[], ctx: SysCtx, s: number, y0: number): void {
  const { score } = ctx.prep;
  const clef = ctx.prep.clefAt(s, ctx.a, 0);
  const cg = clefGlyph(clef);
  P.push({ t: 'glyph', name: cg.name, x: CLEF_X, y: y0 + cg.y, k: 'clef', o: oid({}) });
  let kx = CLEF_X + sm.adv(cg.name) + 1.0;
  const key = keyAt(score, ctx.a);
  if (key) {
    const name = key > 0 ? 'accidentalSharp' : 'accidentalFlat';
    const keyId = oid({});
    for (const pos of keyPositions(key, clef)) {
      P.push({ t: 'glyph', name, x: kx, y: y0 + posToY(pos), k: 'keysig', o: keyId });
      kx += sm.adv(name) + KEY_ACCIDENTAL_GAP;
    }
    kx += 0.9;
  }
  if (ctx.a === 0) drawTimeSig(P, kx, y0, timeAt(score, ctx.a));
}

/** A key change at the start of measure `mi` (naturals for cancelled accidentals, then the new ones); returns the x after it. */
function drawKeyChange(P: Prim[], ctx: SysCtx, mi: number, s: number, y0: number, x: number): number {
  const { score } = ctx.prep;
  const kc = keyChange(score, mi);
  if (!kc) return x;
  const clef = ctx.prep.clefAt(s, ctx.a, 0);
  const id = oid({});
  const put = (name: string, pos: number) => {
    P.push({ t: 'glyph', name, x, y: y0 + posToY(pos), k: 'keysig', o: id });
    x += sm.adv(name) + KEY_ACCIDENTAL_GAP;
  };
  const oldPos = keyPositions(kc.from, clef);
  for (const i of kc.nat) put('accidentalNatural', oldPos[i]);
  for (const pos of keyPositions(kc.to, clef)) put(kc.to > 0 ? 'accidentalSharp' : 'accidentalFlat', pos);
  return x + 0.6;
}

/** Clef changes of one staff-measure, each placed left of the notes of its column (`L` is the column's left extent). */
function drawClefChanges(P: Prim[], ctx: SysCtx, mi: number, s: number, y0: number): void {
  for (const mk of ctx.prep.measures[mi][s].marks) {
    if (mk.type !== 'clef') continue;
    if (mk.tick === 0 && mi === ctx.a) continue;
    const g = clefGlyph(mk.clef, true);
    const cx = xAtTick(ctx, mi, mk.tick);
    const col = ctx.spacing[mi].cols.find((c) => c.tick === mk.tick);
    const L = col ? col.L[s] : 0;
    P.push({ t: 'glyph', name: g.name, x: cx - L + 0.5, y: y0 + g.y, k: 'clef', o: oid(mk), r: mk });
  }
}

/** Changes inside a system: key and time signature at the start of a measure, and clef changes at their column. */
export function drawMidSystemChanges(P: Prim[], ctx: SysCtx, s: number, y0: number): void {
  const { score } = ctx.prep;
  for (let mi = ctx.a; mi <= ctx.b; mi++) {
    if (mi > ctx.a) {
      const x = drawKeyChange(P, ctx, mi, s, y0, ctx.mx[mi] + 0.6);
      if (score.measures[mi].time) drawTimeSig(P, x, y0, timeAt(score, mi));
    }
    drawClefChanges(P, ctx, mi, s, y0);
  }
}
