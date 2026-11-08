// Step entry from a MIDI keyboard: spelling, entering at a cursor, chords and moving on.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceCursor, enterMidi, spellMidi } from '../src/editor/stepentry.ts';
import { pitchMidi, validate } from '../src/model.ts';
import { parseText, writeText } from '../src/textformat.ts';

const SRC = 'page 210x297 margin=10 space=1.75\nstaff rh clef=G2\n\nm1 time=4/4 key=0\n  rh.1: R\n';
const Q = { base: 4, dots: 0 } as const;

test('every MIDI key is spelled as a pitch that sounds the same, with flats in flat keys', () => {
  for (let m = 0; m < 128; m++) {
    assert.equal(pitchMidi(spellMidi(m, 0)), m);
    assert.equal(pitchMidi(spellMidi(m, -3)), m);
  }
  assert.deepEqual(spellMidi(61, 0), { step: 'c', octave: 4, alter: 1 });
  assert.deepEqual(spellMidi(61, -2), { step: 'd', octave: 4, alter: -1 });
  assert.deepEqual(spellMidi(60, 0), { step: 'c', octave: 4, alter: 0 });
});

test('notes are entered at the cursor, which moves on and adds measures at the end', () => {
  let s = parseText(SRC);
  let cur = { mi: 0, staff: 'rh', voice: 1, tick: 0 };
  for (const midi of [60, 62, 64, 65, 67]) {
    s = enterMidi(s, cur, Q, midi);
    ({ score: s, cursor: cur } = advanceCursor(s, cur, Q));
  }
  assert.equal(cur.mi, 1);
  assert.equal(cur.tick, 3360);
  assert.equal(s.measures.length, 2);
  assert.match(writeText(s), /c4:4 d4 e4 f4\nm2\n {2}rh\.1: g4:4 r/);
  assert.equal(validate(s).length, 0);
  // Entering at the cursor past the last measure adds it.
  const past = enterMidi(s, { mi: 2, staff: 'rh', voice: 1, tick: 0 }, Q, 72);
  assert.equal(past.measures.length, 3);
});

test('keys pressed together make a chord on the note just entered', () => {
  const cur = { mi: 0, staff: 'rh', voice: 1, tick: 0 };
  let s = enterMidi(parseText(SRC), cur, Q, 60);
  s = enterMidi(s, cur, Q, 64, true);
  s = enterMidi(s, cur, Q, 67, true);
  assert.match(writeText(s), /<c4 e4 g4>:4/);
});

test('a flat key spells black keys with flats', () => {
  const s = enterMidi(parseText(SRC.replace('key=0', 'key=-2')), { mi: 0, staff: 'rh', voice: 1, tick: 0 }, Q, 70);
  assert.match(writeText(s), /bb4:4/);
});
