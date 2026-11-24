// Playback: the MIDI sequence built from a score (tempo map, ties, pedal, channels).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PPQ } from '../src/model.ts';
import { buildSequence, channelOf } from '../src/playback/sequence.ts';
import { parseText } from '../src/textformat.ts';

const HEAD = `page 210x297 margin=10 space=1.75
staff rh clef=G2
`;

/** The note-on messages of a sequence. */
const on = (s: ReturnType<typeof buildSequence>) => s.msgs.filter((m) => (m.bytes[0] & 0xf0) === 0x90);

test('quarter notes at 120 bpm are half a second apart', () => {
  const s = buildSequence(parseText(`${HEAD}m1 time=4/4 key=0\n  rh.1: c4:4 d4:4 e4:4 f4:4\n`));
  const n = on(s);
  assert.deepEqual(
    n.map((m) => m.bytes[1]),
    [60, 62, 64, 65],
  );
  for (const [i, m] of n.entries()) assert.ok(Math.abs(m.sec - i / 2) < 1e-9);
  assert.equal(s.tickToSec(PPQ), 0.5);
  assert.equal(Math.round(s.secToTick(1)), 2 * PPQ);
});

test('a tied note sounds once; releases precede attacks at the same instant', () => {
  const s = buildSequence(parseText(`${HEAD}m1 time=4/4 key=0\n  rh.1: c4:2~ c4:4 d4:4\n`));
  assert.equal(on(s).length, 2);
  const c = s.msgs.filter((m) => m.bytes[1] === 60);
  assert.ok(Math.abs(c[1].sec - 1.5) < 1e-9);
  const i = s.msgs.findIndex((m) => m.bytes[1] === 62 && m.bytes[0] === 0x90);
  assert.equal(s.msgs[i - 1].bytes[0], 0x80);
});

test('the study fixture builds, with tempo changes and increasing time', () => {
  const sc = parseText(readFileSync(new URL('./fixtures/study.txt', import.meta.url), 'utf8'));
  const s = buildSequence(sc);
  assert.ok(on(s).length > 60);
  for (let i = 1; i < s.msgs.length; i++) assert.ok(s.msgs[i].sec >= s.msgs[i - 1].sec);
  assert.equal(s.measureStart.length, sc.measures.length);
  const dur = (i: number) => s.tickToSec(s.measureStart[i + 1]) - s.tickToSec(s.measureStart[i]);
  assert.ok(dur(0) < dur(9)); // The tempo drops from 124 to 96 in measure 9.
  const t = s.totalTicks / 2;
  assert.ok(Math.abs(s.secToTick(s.tickToSec(t)) - t) < 1e-6);
  assert.ok(!s.channels.includes(9) && s.channels.every((c) => c < 16));
  assert.equal(channelOf(9), 10);
});

test('a two-note tremolo alternates in strokes of the beam value', () => {
  const s = buildSequence(parseText(`${HEAD}m1 time=4/4 key=0\n  rh.1: trem2{ c4:2 e4:2 } c4:2\n`));
  const n = on(s).filter((m) => m.sec < 2);
  assert.equal(n.length, 16); // This is a whole note of 16th strokes.
  assert.deepEqual(
    n.slice(0, 4).map((m) => m.bytes[1]),
    [60, 64, 60, 64],
  );
  assert.ok(Math.abs(n[1].sec - 0.125) < 1e-9);
});

test('a rolled chord enters from the bottom and ends together', () => {
  const s = buildSequence(parseText(`${HEAD}m1 time=4/4 key=0\n  rh.1: \\arp <c4 e4 g4>:2 R:2\n`));
  const ons = s.msgs.filter((m) => m.bytes[0] === 0x90);
  const offs = s.msgs.filter((m) => m.bytes[0] === 0x80);
  assert.equal(ons.length, 3);
  assert.ok(ons[0].sec < ons[1].sec && ons[1].sec < ons[2].sec);
  assert.ok(offs.every((m) => Math.abs(m.sec - 1) < 1e-9));
});

test('dynamics set the velocity and a hairpin ramps to the next dynamic', () => {
  const s = buildSequence(
    parseText(
      `${HEAD}m1 time=4/4 key=0\n  rh.1: \\p c4:4 \\< d4:4 e4:4 \\! f4:4\nm2 time=4/4\n  rh.1: \\f c4:4 d4:4 e4:4 f4:4\n`,
    ),
  );
  const v = on(s).map((m) => m.bytes[2]);
  assert.equal(v[0], 52);
  assert.ok(v[1] === 52 && v[2] > 52 && v[2] < 96);
  assert.deepEqual(v.slice(4), [96, 96, 96, 96]);
});

test('a trill without accidental follows the key signature', () => {
  const ups = (key: number) =>
    on(buildSequence(parseText(`${HEAD}m1 time=4/4 key=${key}\n  rh.1: e4:2+tr r:2\n`)))
      .slice(0, 2)
      .map((m) => m.bytes[1]);
  assert.deepEqual(ups(0), [64, 65]);
  assert.deepEqual(ups(1), [64, 66]);
});

test('a unison written in two voices is struck once, at the louder velocity and the later end', () => {
  const s = buildSequence(parseText(`${HEAD}m1 time=4/4 key=0\n  rh.1: c4:2 r:2\n  rh.2: c4{v=100}:4 r:4 r:2\n`));
  const n = on(s).filter((m) => m.bytes[1] === 60);
  assert.equal(n.length, 1);
  assert.equal(n[0].bytes[2], 100);
  const off = s.msgs.filter((m) => (m.bytes[0] & 0xf0) === 0x80 && m.bytes[1] === 60);
  assert.equal(off.length, 1);
  assert.ok(Math.abs(off[0].sec - 1) < 1e-9);
});

test('a unison entering while the key sounds keeps the longest sounding', () => {
  const key = (src: string) => {
    const s = buildSequence(parseText(`${HEAD}m1 time=4/4 key=0\n${src}`));
    return s.msgs.filter((m) => m.bytes[1] === 60);
  };
  // The later, shorter note is absorbed by the long one.
  const inner = key('  rh.1: c4:1\n  rh.2: r:4 c4:4 r:2\n');
  assert.deepEqual(
    inner.map((m) => m.bytes[0] & 0xf0),
    [0x90, 0x80],
  );
  assert.ok(Math.abs(inner[1].sec - 2) < 1e-9);
  // The later, longer note re-strikes and carries the end; the first is released just before it.
  const outer = key('  rh.1: c4:4 r:4 r:2\n  rh.2: r:8 c4:2 r:4\n');
  assert.deepEqual(
    outer.map((m) => m.bytes[0] & 0xf0),
    [0x90, 0x80, 0x90, 0x80],
  );
  assert.ok(outer[1].sec <= outer[2].sec);
  assert.ok(outer[3].sec > outer[2].sec);
});
