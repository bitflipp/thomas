import assert from 'node:assert/strict';
import { test } from 'node:test';
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
