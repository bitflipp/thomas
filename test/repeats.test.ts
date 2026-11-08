// Repeats and voltas: text format, editing and engraving.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as C from '../src/editor/commands.ts';
import { findCollisions } from '../src/engrave/collide.ts';
import { engrave } from '../src/engrave/system.ts';
import { parseText, writeText } from '../src/textformat.ts';

const SRC = `# music typesetter score
page 210x297 margin=10 space=1.75
staff rh clef=G2
staff lh clef=F4
brace rh lh

m1 time=4/4 key=0 start=repeat
  rh.1: c5:1
  lh.1: c3:1
m2 barline=repeat-end
  rh.1: d5:1
  lh.1: d3:1
m3 start=repeat
  rh.1: e5:1
  lh.1: e3:1
m4 barline=final
  rh.1: f5:1
  lh.1: f3:1
`;

const dots = (src: string) =>
  engrave(parseText(src)).pages[0].prims.filter((p) => p.t === 'glyph' && p.name === 'repeatDot');

test('repeat signs survive the text round trip', () => {
  const score = parseText(SRC);
  assert.equal(score.measures[0].repeatStart, true);
  assert.equal(score.measures[1].barline, 'repeat-end');
  assert.equal(writeText(score), SRC);
});

test('repeat signs draw two dots per staff and side', () => {
  // Start of m1 and m3 (2 staves x 2 dots each), end of m2 (the same).
  assert.equal(dots(SRC).length, 12);
  assert.equal(dots(SRC.replace('start=repeat', '').replace(/m3 start=repeat/, 'm3')).length, 4);
});

test('repeat signs do not collide with the music', () => {
  assert.deepEqual(findCollisions(engrave(parseText(SRC)).pages), []);
});

test('the editor sets and removes repeat signs', () => {
  let s = parseText(SRC);
  s = C.setRepeatStart(s, 0, false);
  s = C.setBarline(s, 1, 'single');
  assert.equal(dots(writeText(s)).length, 4);
});

const VOLTA = `# music typesetter score
page 210x297 margin=10 space=1.75
staff rh clef=G2

m1 time=4/4 key=0 start=repeat
  rh.1: c5:1
m2 barline=repeat-end ending=1
  rh.1: d5:1
m3 ending=2,3
  rh.1: e5:1
m4 barline=final ending=2,3
  rh.1: f5:1
`;

test('voltas survive the text round trip and are editable', () => {
  const score = parseText(VOLTA);
  assert.deepEqual(score.measures[2].ending, [2, 3]);
  assert.equal(writeText(score), VOLTA);
  assert.equal(C.setEnding(score, 2, undefined).measures[2].ending, undefined);
  assert.deepEqual(C.setEnding(score, 0, [2, 1]).measures[0].ending, [1, 2]);
});

test('a volta is one bracket per run, with hooks where it opens and where a repeat closes it', () => {
  const prims = engrave(parseText(VOLTA)).pages[0].prims.filter((p) => p.k === 'volta');
  const texts = prims.filter((p) => p.t === 'text').map((p) => (p.t === 'text' ? p.s : ''));
  assert.deepEqual(texts, ['1.', '2., 3.']);
  const lines = prims.filter((p) => p.t === 'line');
  // Bracket 1: top + 2 hooks; bracket 2: top + left hook (open at the end).
  assert.equal(lines.length, 5);
  assert.deepEqual(findCollisions(engrave(parseText(VOLTA)).pages), []);
});
