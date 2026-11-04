import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PPQ } from '../src/model.ts';
import { buildSequence, channelOf } from '../src/playback/sequence.ts';
import { parseText } from '../src/textformat.ts';

const HEAD = `page 210x297 margin=10 space=1.75
staff rh clef=G2
`;

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

test('the whole piece builds, with tempo changes and increasing time', () => {
  const sc = parseText(readFileSync(new URL('../examples/gewitter.txt', import.meta.url), 'utf8'));
  const s = buildSequence(sc);
  assert.ok(on(s).length > 100);
  for (let i = 1; i < s.msgs.length; i++) assert.ok(s.msgs[i].sec >= s.msgs[i - 1].sec);
  assert.equal(s.measureStart.length, sc.measures.length);
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
