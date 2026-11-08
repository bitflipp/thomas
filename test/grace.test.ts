// Grace notes: text format, MusicXML import, engraving and playback.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe, findCollisions } from '../src/engrave/collide.ts';
import { engrave } from '../src/engrave/system.ts';
import type { NoteEvent } from '../src/model.ts';
import { flattenVoice, voiceTicks } from '../src/model.ts';
import { importMusicXml } from '../src/musicxml.ts';
import { buildSequence } from '../src/playback/sequence.ts';
import { parseText, writeText } from '../src/textformat.ts';

const HEAD = `page 210x297 margin=10 space=1.75
staff rh clef=G2 name="Piano"
staff lh clef=F4 name="Piano"
brace rh lh
`;

const SRC =
  HEAD +
  `
m1 time=4/4 key=0
  rh.1: \\acc{ d5:8 } c5:4 \\grace{ e5:16 f#5:16 g5:16 } e5:4 \\acc{ b4:16 c5:16 } d5:4 \\grace{ <c5 e5>:8 } c5:4
  lh.1: R:1
m2 barline=final
  rh.1: \\acc{ c#6:8 } a5:2 \\acc{ a3:8 b3:8 } c5:2
  lh.1: R:1
`;

test('grace notes round-trip through the text format and take no time', () => {
  const sc = parseText(SRC);
  assert.equal(writeText(parseText(writeText(sc))), writeText(sc));
  assert.deepEqual(parseText(writeText(sc)), sc);
  const v = sc.measures[0].staves.rh.voices[0];
  assert.equal(voiceTicks(v), 4 * 3360);
  const e = flattenVoice(v)[0].ev as NoteEvent;
  assert.deepEqual(e.graces, [{ pitches: [{ pitch: { step: 'd', alter: 0, octave: 5 } }], base: 8, slash: true }]);
});

test('grace notes before a rest are refused', () => {
  assert.throws(() => parseText(`${HEAD}m1 time=4/4 key=0\n  rh.1: \\acc{ d5:8 } r:1\n`), /grace notes belong/);
});

test('engraved grace notes collide with nothing', () => {
  const cs = findCollisions(engrave(parseText(SRC), { respectBreaks: true }).pages);
  assert.deepEqual(cs.map(describe), []);
});

test('an acciaccatura sounds before the beat, an appoggiatura on it', () => {
  const sc = parseText(`${HEAD}m1 time=4/4 key=0\n  rh.1: c5:4 \\acc{ b4:8 } c5:4 \\grace{ d5:8 } e5:4 r:4\n`);
  const s = buildSequence(sc);
  const ons = s.msgs.filter((m) => m.bytes[0] === 0x90);
  assert.deepEqual(
    ons.map((m) => m.bytes[1]),
    [72, 71, 72, 74, 76],
  );
  assert.ok(ons[1].sec < 0.5 && ons[2].sec === 0.5); // A slashed grace note sounds before the second beat, with the main note on it.
  assert.ok(ons[3].sec === 1 && ons[4].sec > 1); // A plain grace note starts on the beat, and the main note follows.
});

test('MusicXML grace notes are attached to the following note', () => {
  const xml = `<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>x</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
<note><grace slash="yes"/><pitch><step>D</step><octave>5</octave></pitch><voice>1</voice><type>eighth</type></note>
<note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note></measure></part></score-partwise>`;
  const sc = importMusicXml(xml, { warn: () => undefined });
  const e = flattenVoice(sc.measures[0].staves[sc.staves[0].id].voices[0])[0].ev as NoteEvent;
  assert.equal(e.graces?.length, 1);
  assert.equal(e.graces![0].slash, true);
  assert.equal(e.graces![0].base, 8);
});
