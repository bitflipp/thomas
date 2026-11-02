// The incremental engraver (an `EngraveCache` carried from edit to edit) must produce exactly what a
// fresh engraving of the same score does. Each test applies a series of edits and compares after every one.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { EvAddr } from '../src/editor/addr.ts';
import { indexScore, refKey } from '../src/editor/addr.ts';
import * as C from '../src/editor/commands.ts';
import { buildHitIndex, hitTest } from '../src/editor/hit.ts';
import type { Engraved } from '../src/engrave/system.ts';
import { createEngraveCache, engrave } from '../src/engrave/system.ts';
import type { Score } from '../src/model.ts';
import { parseText } from '../src/textformat.ts';

const load = (name: string): Score =>
  parseText(readFileSync(new URL(`../examples/${name}.txt`, import.meta.url), 'utf8'));

/** The primitive tags `o` and `g` number objects in the order they were first seen, which differs between runs; renumber by first appearance. */
function normalize(res: Engraved): unknown {
  const ids = new Map<number, number>();
  const id = (n: number) => {
    if (!ids.has(n)) ids.set(n, ids.size);
    return ids.get(n);
  };
  const pages = res.pages.map((p) => ({
    ...p,
    prims: p.prims.map((q) => ({ ...q, o: q.o === undefined ? undefined : id(q.o), g: q.g?.map(id) })),
  }));
  return { ...res, pages, placed: undefined }; // `placed` holds the same prims as `pages`
}

const opts = { respectBreaks: true, measureNumbers: 'system' as const };

function same(score: Score, cache: ReturnType<typeof createEngraveCache>, what: string): void {
  const inc = engrave(score, { ...opts, cache });
  const fresh = engrave(score, opts);
  assert.equal(inc.systems, fresh.systems, `${what}: system count`);
  assert.deepEqual(normalize(inc), normalize(fresh), what);
  // The hit index built from the incremental result (per-system targets are kept between runs) answers like a fresh one.
  const hInc = buildHitIndex(score, inc);
  const hFresh = buildHitIndex(score, fresh);
  for (const t of hFresh.targets) {
    if (t.k !== 'head' && t.k !== 'rest') continue;
    const b = t.boxes[0];
    const x = (b.x0 + b.x1) / 2;
    const y = (b.y0 + b.y1) / 2;
    const want = hitTest(hFresh, t.page, x, y, 0.05);
    const got = hitTest(hInc, t.page, x, y, 0.05);
    assert.equal(got && refKey(got.ref), want && refKey(want.ref), `${what}: hit at ${x.toFixed(1)},${y.toFixed(1)}`);
  }
}

/** A small deterministic generator, so a failure can be reproduced. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function events(score: Score): { a: EvAddr; note: boolean }[] {
  const out: { a: EvAddr; note: boolean }[] = [];
  for (const [ev, a] of indexScore(score).ev) out.push({ a, note: ev.kind === 'note' });
  return out;
}

function randomEdit(score: Score, rand: () => number): { score: Score; what: string } {
  const evs = events(score);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const notes = evs.filter((e) => e.note);
  const kind = Math.floor(rand() * 13);
  switch (kind) {
    case 0: {
      const e = pick(notes);
      return {
        score: C.transpose(score, [e.a], { semis: rand() < 0.5 ? 1 : -2 }),
        what: `transpose ${JSON.stringify(e.a)}`,
      };
    }
    case 1: {
      const e = pick(notes);
      return { score: C.toggleTie(score, [e.a]), what: `tie ${JSON.stringify(e.a)}` };
    }
    case 2: {
      const e = pick(notes);
      return { score: C.toggleArticulation(score, [e.a], 'staccato'), what: `staccato ${JSON.stringify(e.a)}` };
    }
    case 3: {
      const e = pick(evs);
      return { score: C.addMark(score, e.a, { type: 'dynamic', text: 'mf' }), what: `dynamic ${JSON.stringify(e.a)}` };
    }
    case 4: {
      const mi = Math.floor(rand() * score.measures.length);
      return { score: C.insertMeasures(score, mi, 1), what: `insert measure ${mi}` };
    }
    case 5: {
      const mi = Math.floor(rand() * score.measures.length);
      return { score: C.deleteMeasures(score, mi, mi), what: `delete measure ${mi}` };
    }
    case 6: {
      const mi = Math.floor(rand() * score.measures.length);
      return { score: C.setKeySig(score, mi, Math.floor(rand() * 5) - 2), what: `key ${mi}` };
    }
    case 7: {
      const mi = 1 + Math.floor(rand() * (score.measures.length - 1));
      return { score: C.setBreak(score, mi, rand() < 0.5 ? 'system' : undefined), what: `break ${mi}` };
    }
    case 9: {
      // a slur between two notes of one voice, close enough to cross a barline or a system break now and then
      const a = pick(notes);
      const same = notes.filter(
        (e) =>
          e.a.staff === a.a.staff && e.a.voice === a.a.voice && e.a.mi >= a.a.mi && e.a.mi <= a.a.mi + 3 && e !== a,
      );
      const b = pick(same.length ? same : notes);
      return { score: C.addSlur(score, a.a, b.a), what: `slur ${JSON.stringify(a.a)} ${JSON.stringify(b.a)}` };
    }
    case 10: {
      const a = pick(notes);
      return { score: C.deleteEvents(score, [a.a]), what: `delete ${JSON.stringify(a.a)}` };
    }
    case 11: {
      const a = pick(notes);
      const same = notes.filter((e) => e.a.staff === a.a.staff && e.a.mi >= a.a.mi && e.a.mi <= a.a.mi + 4);
      const b = pick(same);
      return {
        score: C.addSpanOver(score, 'cresc', a.a, b.a),
        what: `hairpin ${JSON.stringify(a.a)} ${JSON.stringify(b.a)}`,
      };
    }
    default: {
      const e = pick(evs);
      return { score: C.addMark(score, e.a, { type: 'pedal' }), what: `pedal ${JSON.stringify(e.a)}` };
    }
  }
}

for (const name of ['gewitter', 'tango']) {
  test(`incremental engraving of ${name} equals a fresh one after random edits`, () => {
    const rand = rng(name.length * 7919);
    const cache = createEngraveCache();
    let score = load(name);
    same(score, cache, 'initial');
    same(score, cache, 'same score again');
    let applied = 0;
    for (let i = 0; i < 60; i++) {
      let next: { score: Score; what: string };
      try {
        next = randomEdit(score, rand);
      } catch (e) {
        if (e instanceof C.EditError) continue; // the command refused (nothing to do there)
        throw e;
      }
      score = next.score;
      applied++;
      same(score, cache, `edit ${i}: ${next.what}`);
    }
    assert.ok(applied > 20, `only ${applied} edits applied`);
  });
}

test('changing the staves or the page drops what was cached', () => {
  const cache = createEngraveCache();
  const score = load('tango');
  same(score, cache, 'initial');
  same({ ...score, page: { ...score.page, staffSpace: score.page.staffSpace * 1.1 } }, cache, 'bigger staff space');
  same(C.setStaffClef(score, score.staves[0].id, { sign: 'F', line: 4 }), cache, 'clef of the first staff');
});
