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

/** Text size of a syllable, in staff spaces. */
export const LYRIC_SIZE = 1.7;

/** Clear space between two syllables of different words, and the room a hyphen needs between those of one word. */
export const LYRIC_GAP = 0.4;

export const HYPHEN_ROOM = 1.1;

/** The distance from one verse's baseline to the next. */
const VERSE_STEP = 2.3;

const NARROW = new Set("ijlft.,;:!'-rI");

const WIDE = new Set('mwMW');

/** An estimate of the width of a syllable in staff spaces (the renderer has no font metrics). */
export function lyricWidth(text: string): number {
  let w = 0;
  for (const ch of text)
    w += ch === ' ' ? 0.3 : NARROW.has(ch) ? 0.32 : WIDE.has(ch) ? 0.85 : /[A-Z]/.test(ch) ? 0.68 : 0.5;
  return w * LYRIC_SIZE;
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
      const n = Math.max(1, Math.floor((to - from) / 4));
      for (let k = 0; k < n; k++) {
        const hx = from + ((to - from) * (k + 0.5)) / n;
        P.push({ t: 'line', x1: hx - 0.25, x2: hx + 0.25, y1: base - 0.3, y2: base - 0.3, w: 0.1 });
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
