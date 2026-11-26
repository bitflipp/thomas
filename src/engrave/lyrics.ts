// Lyrics: syllables under the notes, one row per verse below a staff, with hyphens between the
// syllables of a word and extender lines for melismas. Spacing reserves the room a syllable needs
// (`lyricWidth`, used by `spaceMeasure`); the rows are drawn after the ties and slurs and before the
// other marks, so that dynamics and hairpins are stacked outside them.

import type { Syllable } from '../model.ts';
import { must } from '../util.ts';
import type { SysCtx } from './draw.ts';
import { geomOf } from './draw.ts';
import type { EvL } from './prep.ts';
import { oid, tagFrom } from './scene.ts';
import { STAFF_HEIGHT } from './staffgap.ts';
import { textWidth } from './textmetrics.ts';

/** Text size of a syllable, in staff spaces. */
const LYRIC_SIZE = 2.2;

/** Clear space between two syllables of different words, and the room a hyphen needs between those of one word. */
export const LYRIC_GAP = 0.4;

export const HYPHEN_ROOM = 1.1;

/** The distance from one verse's baseline to the next. */
const VERSE_STEP = 2.9;

/** The width of a syllable in staff spaces. */
export function lyricWidth(text: string): number {
  return textWidth(text, LYRIC_SIZE);
}

/** A syllable placed on a staff: its note, its position in the system and its extent. */
interface Placed {
  e: EvL;
  y: Syllable;
  ctx: SysCtx;
  cx: number;
  w: number;
}

/** The notes of staff `s` with a syllable of each verse, in time order over the whole piece. */
function syllablesByVerse(systems: SysCtx[], sysOf: number[], s: number): Map<number, Placed[]> {
  const verses = new Map<number, Placed[]>();
  const { prep } = systems[0];
  prep.measures.forEach((measure, mi) => {
    const ctx = systems[sysOf[mi]];
    const evs = measure[s].evs
      .filter((e) => e.home === s && e.ev.kind === 'note' && e.ev.lyrics)
      .sort((a, b) => a.start - b.start || a.voice - b.voice);
    for (const e of evs) {
      if (e.ev.kind !== 'note') continue;
      const hw = geomOf.get(e)?.hw ?? 1.2;
      const cx = e.x + (e.heads[0]?.dx ?? 0) + hw / 2;
      for (const y of e.ev.lyrics ?? []) {
        const list = verses.get(y.verse) ?? [];
        verses.set(y.verse, list);
        list.push({ e, y, ctx, cx, w: lyricWidth(y.text) });
      }
    }
  });
  return verses;
}

/** Draws the lyrics of every staff in every system. */
export function drawLyrics(systems: SysCtx[], sysOf: number[]): void {
  const nStaves = systems[0].prep.score.staves.length;
  for (let s = 0; s < nStaves; s++) {
    const verses = syllablesByVerse(systems, sysOf, s);
    if (!verses.size) continue;
    const order = [...verses.keys()].sort((a, b) => a - b);
    systems.forEach((ctx) => {
      const rows = order.filter((v) => must(verses.get(v)).some((p) => p.ctx === ctx));
      if (!rows.length) return;
      const all = rows.flatMap((v) => must(verses.get(v)).filter((p) => p.ctx === ctx));
      const x0 = Math.min(...all.map((p) => p.cx - p.w / 2));
      const x1 = Math.max(...all.map((p) => p.cx + p.w / 2));
      let base = ctx.sky[s].bottom(x0, x1, STAFF_HEIGHT) + 0.6 + LYRIC_SIZE * 0.75;
      for (const v of rows) {
        drawVerse(ctx, s, base, must(verses.get(v)), ctx);
        base += VERSE_STEP;
      }
      ctx.sky[s].add(x0, x1, ctx.sky[s].bottom(x0, x1, STAFF_HEIGHT), base - VERSE_STEP + LYRIC_SIZE * 0.3);
    });
  }
}

/** Half the width of a hyphen and the clear space kept between it and a barline. */
const HYPHEN_HALF = 0.25;

const BAR_CLEAR = 0.3;

/**
 * A hyphen centered at `x` between `from` and `to` is moved beside a barline it would touch: to the
 * left of the barline if that fits between the syllables, else to the right.
 */
function clearOfBarlines(ctx: SysCtx, x: number, from: number, to: number): number {
  let hx = x;
  for (let mi = ctx.a; mi <= ctx.b; mi++) {
    const bar = ctx.mx[mi] + ctx.placed[mi].endX;
    if (Math.abs(hx - bar) >= HYPHEN_HALF + BAR_CLEAR) continue;
    const left = bar - HYPHEN_HALF - BAR_CLEAR;
    const right = bar + HYPHEN_HALF + BAR_CLEAR;
    const fits = (c: number) => c - HYPHEN_HALF >= from && c + HYPHEN_HALF <= to;
    hx = fits(left) ? left : fits(right) ? right : hx;
  }
  return hx;
}

/** One verse of one system: the syllables, then the hyphens and extenders that join them. */
function drawVerse(ctx: SysCtx, s: number, base: number, list: Placed[], here: SysCtx): void {
  const P = ctx.prims[s];
  list.forEach((p, i) => {
    if (p.ctx !== here) return;
    const n0 = P.length;
    P.push({ t: 'text', x: p.cx, y: base, s: p.y.text, size: LYRIC_SIZE, anchor: 'middle' });
    const next = list[i + 1];
    const sameSystem = next?.ctx === ctx;
    const from = p.cx + p.w / 2;
    if (p.y.syllabic === 'begin' || p.y.syllabic === 'middle') {
      const to = sameSystem ? next.cx - next.w / 2 : from + 2 * LYRIC_GAP + 0.6;
      const n = Math.max(1, Math.floor((to - from) / 6));
      for (let k = 0; k < n; k++) {
        const hx = clearOfBarlines(ctx, from + ((to - from) * (k + 0.5)) / n, from, to);
        const hy = base - LYRIC_SIZE * 0.18; // The hyphen sits at about the middle of a lowercase letter.
        P.push({ t: 'line', x1: hx - 0.25, x2: hx + 0.25, y1: hy, y2: hy, w: 0.1 });
      }
    }
    if (p.y.extend) {
      const measureEnd = ctx.mx[p.e.mi] + ctx.placed[p.e.mi].endX - 0.3;
      const to = sameSystem ? next.cx - next.w / 2 - LYRIC_GAP : measureEnd;
      if (to - from > 0.5) P.push({ t: 'line', x1: from + 0.15, x2: to, y1: base + 0.1, y2: base + 0.1, w: 0.1 });
    }
    tagFrom(P, n0, 'lyric', oid(p.y));
  });
}
