// Lines between notes (`&` and `;`): pairing, editing, engraving and the text format.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as C from '../src/editor/commands.ts';
import { dependentNotes } from '../src/editor/hit.ts';
import { createEngraveCache, engrave } from '../src/engrave/system.ts';
import type { Score } from '../src/model.ts';
import { lineEnds, pairLines, validate } from '../src/model.ts';
import { parseText, writeText } from '../src/textformat.ts';

const base = `page 210x297 margin=10 space=1.75
staff rh clef=G2
staff lh clef=F4
brace rh lh
m1 time=4/4
  rh.1: c5:4 d5 e5 f5
  rh.2: g4:2 a4
  lh.1: c3:2 e3
m2
  rh.1: c5:1
  lh.1: c3:1
`;

const load = (t = base): Score => parseText(t);
const links = (s: Score) => engrave(s).pages.flatMap((p) => p.prims.filter((x) => x.k === 'link'));
const a = (staff: string, voice: number, idx: number, mi = 0) => ({ mi, staff, voice, idx });

test('lines: text format round trip', () => {
  const t = base
    .replace('rh.1: c5:4', 'rh.1: &c5:4')
    .replace('lh.1: c3:2 e3', 'lh.1: c3:2;  e3')
    .replace('g4:2 a4', '&2.g4:2 a4;2');
  const s = load(t);
  const e = s.measures[0].staves.rh.voices[0].items[0] as { lineStart?: unknown };
  assert.deepEqual(e.lineStart, [{ id: 1 }]);
  assert.equal(writeText(parseText(writeText(s))), writeText(s));
  assert.deepEqual(parseText(writeText(s)), s);
  assert.match(writeText(s), /&c5:4/);
  assert.match(writeText(s), /&2\.g4/);
});

test('lines: addLine pairs notes of different voices and staves, removeLine drops both ends', () => {
  let s = C.addLine(load(), a('rh', 1, 1), a('lh', 1, 0));
  assert.deepEqual(validate(s), []);
  const { pairs, loose } = pairLines(lineEnds(s));
  assert.equal(pairs.length, 1);
  assert.equal(loose.length, 0);
  assert.equal(pairs[0].start.ref.staff, 'rh');
  assert.equal(pairs[0].stop.ref.staff, 'lh');
  assert.deepEqual(parseText(writeText(s)), s);
  // An overlapping line gets another number, a later one reuses the first.
  s = C.addLine(s, a('rh', 2, 0), a('lh', 1, 1), true);
  assert.deepEqual(
    pairLines(lineEnds(s))
      .pairs.map((p) => p.start.id)
      .sort(),
    [1, 2],
  );
  s = C.removeLine(s, a('rh', 1, 1), 1);
  assert.equal(pairLines(lineEnds(s)).pairs.length, 1);
  assert.equal(lineEnds(s).length, 2);
});

test('lines: deleting an end note removes the whole line; notes only; two different notes', () => {
  let s = C.addLine(load(), a('rh', 1, 0), a('rh', 2, 0));
  s = C.deleteEvents(s, [a('rh', 2, 0)]);
  assert.equal(lineEnds(s).length, 0);
  assert.throws(() => C.addLine(load(), a('rh', 1, 0), a('rh', 1, 0)), C.EditError);
  assert.throws(() => C.addLine(load(), a('rh', 1, 0), a('rh', 1, 0)), /different/);
});

test('lines: setLineDashed and dependentNotes', () => {
  let s = C.addLine(load(), a('rh', 1, 2), a('lh', 1, 1));
  s = C.setLineDashed(s, a('rh', 1, 2), 1, true);
  assert.match(writeText(s), /&\.c5|&\.e5/);
  assert.deepEqual(dependentNotes(s, { t: 'line', id: 1, ...a('rh', 1, 2) }), [a('rh', 1, 2), a('lh', 1, 1)]);
});

test('lines: engraved as one straight segment between the notes, dashed on request', () => {
  let s = C.addLine(load(), a('rh', 1, 1), a('lh', 1, 1));
  let [p] = links(s);
  assert.equal(links(s).length, 1);
  assert.equal(p.t, 'line');
  if (p.t !== 'line') return;
  assert.ok(!p.dash);
  assert.ok(Math.hypot(p.x2 - p.x1, p.y2 - p.y1) > 2);
  assert.ok(p.y2 > p.y1, 'runs from the upper staff down to the lower');
  s = C.setLineDashed(s, a('rh', 1, 1), 1, true);
  [p] = links(s);
  assert.ok(p.t === 'line' && p.dash);
});

test('lines: drawn only when both notes are in one system; incremental engraving agrees', () => {
  const across = (t: string) => C.addLine(load(t), a('rh', 1, 3), a('lh', 1, 0, 1));
  assert.equal(links(across(base)).length, 1);
  const split = across(base.replace('m2', 'm2 break=system'));
  assert.equal(links(split).length, 0);
  assert.equal(lineEnds(split).length, 2, 'the line stays in the score');
  // The incremental engraver keeps up with lines (see also test/incremental.test.ts, whose random edits include them).
  const cache = createEngraveCache();
  const before = load();
  engrave(before, { cache });
  const after = C.addLine(before, a('rh', 1, 1), a('lh', 1, 1));
  assert.equal(links(after).length, 1);
  assert.equal(engrave(after, { cache }).pages[0].prims.filter((x) => x.k === 'link').length, 1);
});
