// Repeats and voltas: text format, editing and engraving.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as C from '../src/editor/commands.ts';
import { findCollisions } from '../src/engrave/collide.ts';
import { engrave } from '../src/engrave/system.ts';
import { lengthOf, timeAt } from '../src/model.ts';
import { importMusicXml } from '../src/musicxml.ts';
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

const VOLTA_TIME = `staff s1 clef=G2

m1 time=4/4
  s1.1: c5:1
m2 start=repeat
  s1.1: d5:1
m3 ending=1 time=3/4
  s1.1: e5:2.
m4 ending=1 barline=repeat-end
  s1.1: f5:2.
m5 ending=2
  s1.1: g5:1
m6
  s1.1: a5:1
`;

test('a time change in the first volta does not carry into the second', () => {
  const score = parseText(VOLTA_TIME);
  assert.deepEqual(timeAt(score, 3), { beats: 3, beatType: 4 });
  assert.deepEqual(timeAt(score, 4), { beats: 4, beatType: 4 });
  assert.deepEqual(timeAt(score, 5), { beats: 4, beatType: 4 });
  assert.equal(lengthOf(score, 4), lengthOf(score, 0));
  // The restored 4/4 is printed at the start of the second volta: 4/4 in m1 and m5, 3/4 in m3.
  const fours = engrave(score).pages[0].prims.filter((p) => p.t === 'glyph' && p.name === 'timeSig4');
  assert.equal(fours.length, 5);
  // Changing the time in the first volta leaves the second alone.
  const edited = C.setTimeSig(score, 2, { beats: 2, beatType: 4 });
  assert.deepEqual(timeAt(edited, 4), { beats: 4, beatType: 4 });
  assert.equal(lengthOf(edited, 4), lengthOf(score, 4));
});

test('a third volta skips the first two', () => {
  const src = VOLTA_TIME.replace('m5 ending=2', 'm5 ending=2 time=2/4')
    .replace('g5:1', 'g5:2')
    .replace('m6\n', 'm6 ending=3\n');
  const score = parseText(src);
  assert.deepEqual(timeAt(score, 5), { beats: 4, beatType: 4 });
});

test("MusicXML keeps the earlier volta's time in a later volta that does not restate it", () => {
  const m = (n: number, extra: string, beats: number) =>
    `<measure number="${n}">${extra}<note><pitch><step>C</step><octave>5</octave></pitch><duration>${beats}</duration><type>whole</type></note></measure>`;
  const xml = `<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>A</part-name></score-part></part-list><part id="P1">
${m(1, '<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>', 4)}
${m(2, '<barline location="left"><ending number="1" type="start"/></barline><attributes><time><beats>3</beats><beat-type>4</beat-type></time></attributes>', 3).replace('</measure>', '<barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline></measure>')}
${m(3, '<barline location="left"><ending number="2" type="start"/></barline>', 3).replace('</measure>', '<barline location="right"><ending number="2" type="discontinue"/></barline></measure>')}
</part></score-partwise>`;
  const score = importMusicXml(xml);
  assert.deepEqual(score.measures[2].ending, [2]);
  assert.deepEqual(timeAt(score, 2), { beats: 3, beatType: 4 });
});
