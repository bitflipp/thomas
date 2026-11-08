import assert from 'node:assert/strict';
import { test } from 'node:test';
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
