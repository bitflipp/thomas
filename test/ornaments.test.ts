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
