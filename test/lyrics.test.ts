// Lyrics: text format, MusicXML import, editing commands and engraving.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as C from '../src/editor/commands.ts';
import { neighbourNote } from '../src/editor/lyrics.ts';
import { findCollisions } from '../src/engrave/collide.ts';
import { engrave } from '../src/engrave/system.ts';
import type { NoteEvent } from '../src/model.ts';
import { importMusicXml } from '../src/musicxml.ts';
import { parseText, writeText } from '../src/textformat.ts';

const SRC = `# music typesetter score
page 210x297 margin=10 space=1.75
staff rh clef=G2

m1 time=4/4 key=0
  rh.1: (c5:4"Ly-"v2"Wor-"_ d5"-ri-" e5:2"-cs"v2"-d"))
m2
  rh.1: c5:1"word"
`;

test('lyrics survive the text round trip', () => {
  const score = parseText(SRC);
  const evs = score.measures[0].staves.rh.voices[0].items as NoteEvent[];
  assert.deepEqual(evs[0].lyrics, [
    { verse: 1, text: 'Ly', syllabic: 'begin' },
    { verse: 2, text: 'Wor', syllabic: 'begin', extend: true },
  ]);
  assert.equal(evs[1].lyrics?.[0].syllabic, 'middle');
  assert.equal(evs[2].lyrics?.[0].syllabic, 'end');
  assert.equal(writeText(score), SRC);
});

test('MusicXML lyrics become syllables per verse', () => {
  const xml = `<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>x</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
<note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><type>half</type>
<lyric number="1"><syllabic>begin</syllabic><text>Ly</text></lyric><lyric number="2"><syllabic>single</syllabic><text>la</text><extend/></lyric></note>
<note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration><type>half</type><lyric number="1"><syllabic>end</syllabic><text>ric</text></lyric></note>
</measure></part></score-partwise>`;
  const score = importMusicXml(xml, {});
  const evs = score.measures[0].staves[score.staves[0].id].voices[0].items as NoteEvent[];
  assert.deepEqual(evs[0].lyrics, [
    { verse: 1, text: 'Ly', syllabic: 'begin' },
    { verse: 2, text: 'la', syllabic: 'single', extend: true },
  ]);
  assert.equal(evs[1].lyrics?.[0].syllabic, 'end');
});

const SCORE = `# music typesetter score
page 210x297 margin=10 space=1.75
staff rh clef=G2
staff lh clef=F4

m1 time=4/4 key=0
  rh.1: c5:4"Hel-"v2"Wor-" d5:4"-lo"v2"-ld," e5:2"is"_
  lh.1: c3:1
m2 barline=final
  rh.1: c5:8"Lon-" d5:8"-ger" e5:4"than" f5:4"a" g5:4"very"
  lh.1: c3:1
`;

test('lyrics are drawn in one row per verse below the staff, without collisions', () => {
  const out = engrave(parseText(SCORE));
  const prims = out.pages[0].prims.filter((p) => p.k === 'lyric');
  const texts = prims.filter((p) => p.t === 'text');
  assert.equal(texts.length, 10);
  const ys = (verseTexts: string[]) =>
    new Set(texts.filter((p) => p.t === 'text' && verseTexts.includes(p.s)).map((p) => (p.t === 'text' ? p.y : 0)));
  assert.equal(ys(['Hel', 'lo', 'is', 'Lon']).size, 1);
  assert.equal(ys(['Wor', 'ld,']).size, 1);
  assert.ok([...ys(['Wor'])][0] > [...ys(['Hel'])][0]);
  // Hyphens: Hel-lo, Wor-ld, Lon-ger; one extender under "is".
  assert.equal(prims.filter((p) => p.t === 'line').length, 4);
  assert.deepEqual(findCollisions(out.pages), []);
});

test('a long syllable pushes its neighbours apart', () => {
  const tight = SCORE.replace('"is"', '"is"').replace('"than"', '"than"');
  const wide = SCORE.replace('"than"', '"thanksgiving"');
  const x = (src: string, s: string) => {
    const p = engrave(parseText(src)).pages[0].prims.find((q) => q.k === 'lyric' && q.t === 'text' && q.s === s);
    return p?.t === 'text' ? p.x : 0;
  };
  assert.ok(x(wide, 'a') - x(wide, 'thanksgiving') > x(tight, 'a') - x(tight, 'than'));
});

const EDIT = `# music typesetter score
page 210x297 margin=10 space=1.75
staff rh clef=G2

m1 time=4/4 key=0
  rh.1: c5:4~ c5 r d5 e5
m2
  rh.1: f5:1
`;

test('setSyllable chains hyphens and keeps syllabic consistent', () => {
  const at = (mi: number, idx: number) => ({ mi, staff: 'rh', voice: 1, idx });
  let s = parseText(EDIT);
  s = C.setSyllable(s, at(0, 0), 1, { text: 'Ly', joinNext: true });
  s = C.setSyllable(s, at(0, 3), 1, { text: 'ric', joinNext: true });
  s = C.setSyllable(s, at(0, 4), 1, { text: 'al' });
  const ys = () => writeText(s).match(/"[^"]*"/g);
  assert.deepEqual(ys(), ['"Ly-"', '"-ric-"', '"-al"']);
  // Ending the word at the first syllable turns the middle one into the start of a new word.
  s = C.setSyllable(s, at(0, 0), 1, { text: 'Ly' });
  assert.deepEqual(ys(), ['"Ly"', '"ric-"', '"-al"']);
  // An empty text removes a syllable; a word left open at the end stays open for the next one.
  s = C.setSyllable(s, at(0, 4), 1, { text: '' });
  assert.deepEqual(ys(), ['"Ly"', '"ric-"']);
  assert.throws(() => C.setSyllable(s, at(0, 2), 1, { text: 'x' }), /note/);
});

test('neighbourNote skips rests and tied notes, across measures', () => {
  const s = parseText(EDIT);
  const at = (mi: number, idx: number) => ({ mi, staff: 'rh', voice: 1, idx });
  assert.deepEqual(neighbourNote(s, at(0, 0), 1), at(0, 3));
  assert.deepEqual(neighbourNote(s, at(0, 4), 1), at(1, 0));
  assert.deepEqual(neighbourNote(s, at(1, 0), -1), at(0, 4));
  assert.equal(neighbourNote(s, at(1, 0), 1), undefined);
});

test('a hyphen across a barline stays clear of it', () => {
  const src = `# music typesetter score
page 210x297 margin=10 space=1.75
staff rh clef=G2

m1 time=4/4 key=0
  rh.1: c5:4"a" d5"b" e5"c" f5"Won-"
m2
  rh.1: g5:4"-der" a5"x" b5"y" c6"z"
m3 barline=final
  rh.1: c5:1
`;
  const out = engrave(parseText(src));
  const bars = out.pages[0].prims
    .filter((p) => p.k === 'barline' && p.t === 'line')
    .map((p) => (p.t === 'line' ? p.x1 : 0));
  const hyphens = out.pages[0].prims.filter(
    (p) => p.k === 'lyric' && p.t === 'line' && p.y1 === p.y2 && p.x2 - p.x1 < 1,
  );
  assert.equal(hyphens.length, 1);
  for (const h of hyphens) {
    if (h.t !== 'line') continue;
    for (const b of bars) assert.ok(b < h.x1 - 0.2 || b > h.x2 + 0.2, `barline ${b} touches hyphen ${h.x1}..${h.x2}`);
  }
});
