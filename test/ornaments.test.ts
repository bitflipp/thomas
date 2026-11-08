// Fermata and trill: text format, engraving and playback.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findCollisions } from '../src/engrave/collide.ts';
import { engrave } from '../src/engrave/system.ts';
import { flattenVoice } from '../src/model.ts';
import { buildSequence } from '../src/playback/sequence.ts';
import { parseText, writeText } from '../src/textformat.ts';

const SRC = `page 210x297 margin=10 space=1.75
staff rh clef=G2 name="Piano"

m1 time=4/4 key=0
  rh.1: c5:4+tr d5->+fm r+fm e5:4+tr+fm
`;

test('fermatas and trills round-trip through the text format', () => {
  const sc = parseText(SRC);
  const evs = flattenVoice(sc.measures[0].staves.rh.voices[0]);
  assert.deepEqual(
    evs.map(({ ev }) => [ev.kind === 'note' && ev.trill, ev.fermata]),
    [
      [true, undefined],
      [undefined, true],
      [false, true],
      [true, true],
    ],
  );
  assert.equal(writeText(parseText(writeText(sc))), writeText(sc));
});

test('fermatas and trills are drawn above the staff without collisions', () => {
  const out = engrave(parseText(SRC));
  const prims = out.pages[0].prims;
  assert.equal(prims.filter((p) => p.k === 'trill').length, 2);
  assert.equal(prims.filter((p) => p.k === 'fermata').length, 3);
  assert.deepEqual(findCollisions(out.pages), []);
});

test('a trill alternates with the note above and a fermata lengthens its event', () => {
  const plain = buildSequence(parseText(SRC.replace(/\+tr|\+fm/g, '')));
  const orn = buildSequence(parseText(SRC));
  const ons = (s: typeof plain) => s.msgs.filter((m) => (m.bytes[0] & 0xf0) === 0x90);
  assert.equal(ons(plain).length, 3);
  assert.ok(ons(orn).length > 10);
  const first = ons(orn)
    .slice(0, 4)
    .map((m) => m.bytes[1]);
  assert.deepEqual(first, [72, 74, 72, 74]);
  assert.ok(orn.tickToSec(orn.totalTicks) > plain.tickToSec(plain.totalTicks) + 1);
  assert.ok(Math.abs(orn.secToTick(orn.tickToSec(5000)) - 5000) < 1e-6);
});

test('a trill accidental round-trips, is drawn and sets the upper note', () => {
  const src = SRC.replace('c5:4+tr', 'c5:4+tr#');
  assert.match(writeText(parseText(src)), /c5:4\+tr#/);
  for (const [t, up] of [
    ['#', 75],
    ['=', 74],
    ['b', 73],
  ] as const) {
    const s = parseText(SRC.replace('c5:4+tr', `c5:4+tr${t}`));
    assert.equal(writeText(parseText(writeText(s))), writeText(s));
    const ons = buildSequence(s).msgs.filter((m) => (m.bytes[0] & 0xf0) === 0x90);
    assert.equal(ons[1].bytes[1], up);
  }
  const out = engrave(parseText(src));
  assert.ok(out.pages[0].prims.some((p) => p.k === 'trill' && p.t === 'glyph' && p.name === 'accidentalSharp'));
  assert.deepEqual(findCollisions(out.pages), []);
});

const ONE = SRC.replace(/\+fm|\+tr/g, '').replace('d5->', 'd5->+fm');

test('fermata shape and side round-trip, import from MusicXML, draw the right glyph and stretch playback', () => {
  const src = SRC.replace(/\+fm/g, '+fms_');
  assert.match(writeText(parseText(src)), /\+fms_/);
  for (const t of ['+fm', '+fms', '+fml', '+fm_', '+fml_']) {
    const s = parseText(ONE.replace('+fm', t));
    assert.equal(writeText(parseText(writeText(s))), writeText(s));
    assert.deepEqual(parseText(writeText(s)), s);
  }
  const names = (text: string) =>
    engrave(parseText(text))
      .pages[0].prims.filter((p) => p.k === 'fermata')
      .map((p) => (p.t === 'glyph' ? p.name : ''));
  assert.deepEqual(names(ONE.replace('+fm', '+fml_')), ['fermataLongBelow']);
  assert.deepEqual(names(ONE.replace('+fm', '+fms')), ['fermataShortAbove']);
  assert.deepEqual(findCollisions(engrave(parseText(ONE.replace('+fm', '+fml_'))).pages), []);
  const len = (t: string) => {
    const s = buildSequence(parseText(t));
    return s.tickToSec(s.totalTicks);
  };
  assert.ok(len(ONE.replace('+fm', '+fms')) < len(ONE) && len(ONE) < len(ONE.replace('+fm', '+fml')));
});

test('mordents and turns: text round trip, drawing and playback', () => {
  const src = SRC.replace('c5:4+tr d5->+fm r+fm e5:4+tr+fm', 'c5:4+mo d5:4+mi e5:4+tu f5:4+ti+fm');
  for (const [code, o] of [
    ['+mo', 'mordent'],
    ['+mi', 'mordent-inverted'],
    ['+tu', 'turn'],
    ['+ti', 'turn-inverted'],
  ] as const) {
    const s = parseText(src);
    assert.deepEqual(parseText(writeText(s)), s);
    assert.ok(writeText(s).includes(code));
    assert.ok(
      flattenVoice(s.measures[0].staves.rh.voices[0]).some((te) => te.ev.kind === 'note' && te.ev.ornament === o),
    );
  }
  const out = engrave(parseText(src));
  assert.deepEqual(
    out.pages[0].prims.filter((p) => p.k === 'ornament').map((p) => (p.t === 'glyph' ? p.name : '')),
    ['ornamentMordent', 'ornamentShortTrill', 'ornamentTurn', 'ornamentTurnInverted'],
  );
  assert.deepEqual(findCollisions(out.pages), []);
  const pitches = (text: string) =>
    buildSequence(parseText(text))
      .msgs.filter((m) => (m.bytes[0] & 0xf0) === 0x90)
      .map((m) => m.bytes[1]);
  const one = (o: string) => `${SRC.split('m1')[0]}m1 time=4/4 key=0\n  rh.1: e5:2${o} r:2\n`;
  assert.deepEqual(pitches(one('+mo')), [76, 74, 76]);
  assert.deepEqual(pitches(one('+mi')), [76, 77, 76]);
  assert.deepEqual(pitches(one('+tu')), [77, 76, 74, 76]);
  assert.deepEqual(pitches(one('+ti')), [74, 76, 77, 76]);
});

const LINE = `page 210x297 margin=10 space=1.75
staff rh clef=G2 name="Piano"

m1 time=4/4 key=0
  rh.1: \\trill e5:4 f5:4 e5:4 \\trilloff g5:4
`;

test('a trill line round-trips, is drawn as a sign and wavy segments, and trills the notes under it', () => {
  const sc = parseText(LINE);
  assert.ok(writeText(sc).includes('\\trill e5:4 f5 e5 \\trilloff g5'));
  assert.deepEqual(parseText(writeText(sc)), sc);
  const out = engrave(sc);
  const prims = out.pages[0].prims.filter((p) => p.k === 'trill');
  assert.equal(prims.filter((p) => p.t === 'glyph' && p.name === 'ornamentTrill').length, 1);
  assert.ok(prims.filter((p) => p.t === 'glyph' && p.name === 'wiggleTrill').length >= 3);
  assert.deepEqual(findCollisions(out.pages), []);
  const ons = buildSequence(sc).msgs.filter((m) => (m.bytes[0] & 0xf0) === 0x90);
  // Three trilled quarter notes make many notes; the last, plain quarter note is one.
  assert.equal(ons.length, 25);
  assert.equal(ons[ons.length - 1].bytes[1], 79);
  const plain = buildSequence(parseText(LINE.replace('\\trill ', '').replace('\\trilloff ', '')));
  assert.equal(plain.msgs.filter((m) => (m.bytes[0] & 0xf0) === 0x90).length, 4);
});

test('a trill line continues over a system break', () => {
  const notes = Array.from({ length: 40 }, (_, i) =>
    i === 0 ? '\\trill c5:4' : i === 39 ? '\\trilloff c5:4' : 'c5:4',
  );
  const bar = (n: number) => `m${n} time=4/4\n  rh.1: ${notes.slice((n - 1) * 4, n * 4).join(' ')}\n`;
  const text = `page 100x297 margin=10 space=1.75\nstaff rh clef=G2\n\n${Array.from({ length: 10 }, (_, i) => bar(i + 1)).join('')}`;
  const out = engrave(parseText(text));
  assert.ok(out.layout.systems.length > 1);
  const signs = out.pages.flatMap((p) => p.prims).filter((p) => p.k === 'trill' && p.t === 'glyph');
  assert.equal(signs.filter((p) => p.t === 'glyph' && p.name === 'ornamentTrill').length, 1);
  assert.deepEqual(findCollisions(out.pages), []);
});
