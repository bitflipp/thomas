// Expression: the velocity, shift and gate of heads, and the performance (tempo curve, pedals) of a score.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PPQ, validate } from '../src/model.ts';
import { buildSequence } from '../src/playback/sequence.ts';
import { parseText, writeText } from '../src/textformat.ts';

const HEAD = `page 210x297 margin=10 space=1.75
staff rh clef=G2
`;

/** The messages of a sequence with the given status nibble (0x90 note-on, 0x80 note-off, 0xb0 controller). */
const kind = (s: ReturnType<typeof buildSequence>, status: number) =>
  s.msgs.filter((m) => (m.bytes[0] & 0xf0) === status);

const seq = (body: string, extra = '') => buildSequence(parseText(`${HEAD}${extra}m1 time=4/4 key=0\n${body}\n`));

test('the expression of heads and the performance round-trip in the text format', () => {
  const text = `# music typesetter score\n${HEAD}tempocurve m1@0=1 m2@3/2=1.05\nsustain m1@0=0 m1@1=1 m2@0=0\nsoft m1@1-m2@1/2\n\nm1 time=4/4 key=0
  rh.1: c4{v=64,s=-12.5,g=0.8}:4 <c4{s=7} e4!{v=90}~ g4> d4:2
m2 time=4/4
  rh.1: e4:1
`;
  const s = parseText(text);
  assert.equal(writeText(s), text);
  assert.deepEqual(validate(s), []);
  const ev = s.measures[0].staves.rh.voices[0].items[0];
  assert.ok('pitches' in ev);
  assert.deepEqual(ev.pitches[0], { pitch: { step: 'c', alter: 0, octave: 4 }, vel: 64, shift: -12.5, gate: 0.8 });
  assert.deepEqual(s.performance?.soft, [{ from: { mi: 0, tick: PPQ }, to: { mi: 1, tick: PPQ / 2 } }]);
  assert.deepEqual(s.performance?.tempo?.[1], { pos: { mi: 1, tick: (PPQ * 3) / 2 }, value: 1.05 });
});

test('validate rejects expression out of range and curves out of order', () => {
  const bad = parseText(
    `${HEAD}sustain m1@2=0.5 m1@1=1\nsoft m1@1-m1@1\ntempocurve m3@0=1\n\nm1 time=4/4 key=0\n  rh.1: c4{v=200}:4 d4{g=9} e4{s=5000} f4\n`,
  );
  const errs = validate(bad).join('\n');
  for (const word of ['not after', 'is empty', 'bad position', 'bad velocity', 'bad gate', 'bad shift'])
    assert.ok(errs.includes(word), `${word} in ${errs}`);
});

test('a velocity on a head replaces the one of the dynamics, per head of a chord', () => {
  const s = seq('  rh.1: \\f <c4{v=40} e4 g4{v=127}>:2 R:2');
  assert.deepEqual(
    kind(s, 0x90).map((m) => m.bytes[2]),
    [40, 96, 127],
  );
});

test('a shift moves the attack by milliseconds, whatever the tempo, and keeps the end', () => {
  for (const bpm of [60, 120, 240]) {
    const s = seq(`  rh.1: \\tempo 4=${bpm} c4{s=30}:4 d4{s=-20}:4 e4:2`);
    const ons = kind(s, 0x90);
    const q = 60 / bpm;
    assert.ok(Math.abs(ons[0].sec - 0.03) < 1e-9);
    assert.ok(Math.abs(ons[1].sec - (q - 0.02)) < 1e-9);
    assert.ok(Math.abs(ons[2].sec - 2 * q) < 1e-9);
    const offs = kind(s, 0x80);
    assert.ok(Math.abs(offs[0].sec - q) < 1e-9);
  }
});

test('a shift cannot move an attack before the start of the piece, and a note keeps a minimal length', () => {
  const s = seq('  rh.1: c4{s=-50}:4 d4{s=600}:8 e4:8 f4:2');
  assert.equal(kind(s, 0x90)[0].sec, 0);
  const d = kind(s, 0x90)[1];
  const dOff = kind(s, 0x80).find((m) => m.bytes[1] === 62);
  assert.ok(dOff && dOff.sec > d.sec);
});

test('a shift adds to the roll of a notated arpeggio', () => {
  const plain = kind(seq('  rh.1: \\arp <c4 e4 g4>:2 R:2'), 0x90);
  const moved = kind(seq('  rh.1: \\arp <c4 e4{s=25} g4>:2 R:2'), 0x90);
  assert.ok(Math.abs(moved[0].sec - plain[0].sec) < 1e-12);
  assert.ok(Math.abs(moved[1].sec - plain[1].sec - 0.025) < 1e-9);
  assert.ok(Math.abs(moved[2].sec - plain[2].sec) < 1e-12);
});

test('a gate scales the sounding length, also of a staccato note; a tied head ignores it', () => {
  const half = kind(seq('  rh.1: c4{g=0.5}:2 R:2'), 0x80);
  assert.ok(Math.abs(half[0].sec - 0.5) < 1e-9);
  const stac = kind(seq('  rh.1: c4{g=0.5}:2-. R:2'), 0x80);
  assert.ok(Math.abs(stac[0].sec - 0.25) < 1e-9);
  const tied = seq('  rh.1: c4{g=0.1}:2~ c4:2');
  assert.equal(kind(tied, 0x90).length, 1);
  assert.ok(Math.abs(kind(tied, 0x80)[0].sec - 2) < 1e-9);
});

test('a lengthened note ends before the next attack of the same key', () => {
  const s = seq('  rh.1: c4{g=3}:4 c4:4 R:2');
  const [off1] = kind(s, 0x80);
  assert.ok(Math.abs(off1.sec - (0.5 - 0.001)) < 1e-9);
  assert.equal(kind(s, 0x90).length, 2);
});

test('the pedal marks of the notation are not played', () => {
  const s = seq('  rh.1: \\ped c4:2 \\unped d4:2');
  assert.equal(kind(s, 0xb0).length, 0);
});

test('the sustain curve sends CC64 on every channel in use, ramps in steps and lets go at the end', () => {
  const s = buildSequence(
    parseText(
      `page 210x297 margin=10 space=1.75\nstaff a clef=G2\nstaff b clef=F4\nsustain m1@0=0 m1@1=1 m1@2=0.5\n\nm1 time=4/4 key=0\n  a.1: c5:1\n  b.1: c3:1\n`,
    ),
  );
  const cc = kind(s, 0xb0).filter((m) => m.bytes[1] === 64 && m.bytes[0] === 0xb0);
  assert.ok(cc.length > 120, 'the rise from 0 to 127 is sent in steps');
  assert.equal(kind(s, 0xb0).filter((m) => m.bytes[0] === 0xb1).length, cc.length);
  const rise = cc.filter((m) => m.sec < 0.5 + 1e-9).map((m) => m.bytes[2]);
  assert.equal(rise[0], 0);
  assert.equal(rise[rise.length - 1], 127);
  assert.ok(rise.every((v, i) => i === 0 || v > rise[i - 1]));
  const last = cc[cc.length - 1];
  assert.equal(last.bytes[2], 0);
  assert.ok(Math.abs(last.sec - 2) < 1e-9);
  const heldAt = cc.filter((m) => Math.abs(m.sec - 1) < 1e-9);
  assert.equal(heldAt.at(-1)?.bytes[2], 64);
});

test('a pedal change comes before the attack it is meant for, a release after the note it follows', () => {
  const s = seq('  rh.1: c4:4 d4:4 e4:2', 'sustain m1@0=1 m1@1=0\n');
  const i = s.msgs.findIndex((m) => m.bytes[0] === 0xb0 && m.bytes[2] === 0 && m.sec > 0.4);
  const j = s.msgs.findIndex((m) => m.bytes[0] === 0x90 && m.bytes[1] === 62);
  assert.ok(i >= 0 && j > i);
});

test('una corda regions send CC67 on and off', () => {
  const s = seq('  rh.1: c4:1', 'soft m1@1-m1@3\n');
  const cc = kind(s, 0xb0).filter((m) => m.bytes[1] === 67);
  assert.deepEqual(
    cc.map((m) => m.bytes[2]),
    [127, 0],
  );
  assert.ok(Math.abs(cc[0].sec - 0.5) < 1e-9 && Math.abs(cc[1].sec - 1.5) < 1e-9);
});

test('a constant tempo ratio scales the time; a flat curve of 1 changes nothing', () => {
  const plain = seq('  rh.1: c4:1');
  const flat = seq('  rh.1: c4:1', 'tempocurve m1@0=1 m1@2=1\n');
  const fast = seq('  rh.1: c4:1', 'tempocurve m1@0=2 m1@2=2\n');
  assert.ok(Math.abs(flat.tickToSec(4 * PPQ) - plain.tickToSec(4 * PPQ)) < 1e-9);
  assert.ok(Math.abs(fast.tickToSec(4 * PPQ) - 1) < 1e-9);
});

test('a varying tempo curve is monotone, bounded by its points, and secToTick inverts tickToSec', () => {
  const s = buildSequence(
    parseText(
      `${HEAD}tempocurve m1@0=1 m1@2=0.8 m2@0=1.2\n\nm1 time=4/4 key=0\n  rh.1: c4:1\nm2 time=4/4\n  rh.1: c4:1\nm3 time=4/4\n  rh.1: c4:1\n`,
    ),
  );
  const plainSec = (t: number) => (t / PPQ) * 0.5;
  assert.ok(s.tickToSec(2 * PPQ) > plainSec(2 * PPQ), 'the slow part takes longer');
  assert.ok(s.tickToSec(12 * PPQ) > plainSec(12 * PPQ) / 1.2 - 1e-9);
  let prev = -1;
  for (let t = 0; t <= 12 * PPQ; t += 700) {
    const sec = s.tickToSec(t);
    assert.ok(sec > prev);
    prev = sec;
    assert.ok(Math.abs(s.secToTick(sec) - t) < 1e-3, `at ${t}`);
  }
});
