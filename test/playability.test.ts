// The playability check: hand inference, spans, leaps, the pedal setting and the required span, on small scores.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlayFinding } from '../src/analysis/playability.ts';
import { findPlayability, requiredSpan, spanName } from '../src/analysis/playability.ts';
import { parseText } from '../src/textformat.ts';

/** A two-staff score from the lines of the voices of one 4/4 measure each (`rh.1: ...`, `lh.1: ...`), at 120 bpm. */
const score = (...measures: string[][]) =>
  parseText(
    `page 210x297 margin=10 space=1.75
staff rh clef=G2
staff lh clef=F4
brace rh lh
${measures.map((lines, i) => `m${i + 1}${i === 0 ? ' time=4/4' : ''}\n${lines.map((l) => `  ${l}`).join('\n')}`).join('\n')}
`,
  );

/** The findings as "severity/kind" strings. */
const kinds = (fs: PlayFinding[]) => fs.map((f) => `${f.severity}/${f.kind}`);

test('an ordinary two-hand passage has no findings', () => {
  const fs = findPlayability(score(['rh.1: <e4 g4 c5>:2 <d4 g4 b4>:2', 'lh.1: c3:2 g2:2']));
  assert.deepEqual(fs, []);
});

test('interval names: 2nd, 3rd, octave, ninth, tenth', () => {
  assert.deepEqual([2, 4, 12, 14, 16, 19].map(spanName), ['2nd', '3rd', 'octave', '9th', '10th', '12th']);
});

test('a chord in one staff that is too wide for one hand is split between the hands, not reported', () => {
  const fs = findPlayability(score(['rh.1: <c3 e3 g3 c4 e4 g4>:1', 'lh.1: R:1']));
  assert.deepEqual(fs, []);
});

test('three keys spread over four octaves cannot be played by two hands', () => {
  const fs = findPlayability(score(['rh.1: <c2 c4 c6>:1', 'lh.1: R:1']));
  assert.deepEqual(kinds(fs), ['error/span']);
  assert.match(fs[0].message, /15th/);
  assert.equal(fs[0].notes.length, 2);
});

test('eleven keys at once are too many for ten fingers', () => {
  const fs = findPlayability(score(['rh.1: <c2 e2 g2 c3 e3 g3 c4 e4 g4 c5 e5>:1', 'lh.1: R:1']));
  assert.deepEqual(kinds(fs), ['error/count']);
});

test('a note below A0 or above C8 is outside the keyboard', () => {
  const fs = findPlayability(score(['rh.1: c9:1', 'lh.1: c0:1']));
  assert.deepEqual(kinds(fs), ['error/range', 'error/range']);
});

test('a stretch near the span limit is a warning, beyond it an error', () => {
  // Ten keys at once leave no choice: five in each hand. The lower hand spans a ninth (14 semitones).
  const ten = score(['rh.1: <c2 d2 e2 f2 d3 c5 d5 e5 f5 g5>:1', 'lh.1: R:1']);
  assert.deepEqual(findPlayability(ten, { maxSpan: 20 }), []);
  assert.deepEqual(kinds(findPlayability(ten, { maxSpan: 14 })), ['warn/span']);
  assert.deepEqual(kinds(findPlayability(ten, { maxSpan: 12 })), ['error/span']);
});

test('a leap that two hands cannot share and no hand has time for is an error', () => {
  // Both hands play five-key chords, then both have to be about four octaves away within a sixteenth (125 ms).
  const fs = findPlayability(score(['rh.1: <c2 g2 c3 e3 g3>:16 <c6 g6 c7 e7 g7>:16 r:8 r:4 r:2', 'lh.1: R:1']));
  assert.ok(kinds(fs).includes('error/leap'), kinds(fs).join());
});

test('fast leaps within the span of a hand are not leaps', () => {
  // Fifths and octaves in thirty-seconds (62 ms) are within a hand's reach, however fast.
  const fs = findPlayability(score(['rh.1: c4:32 g4:32 c4:32 c5:32 g4:32 c4:32 r:8 r:4 r:2', 'lh.1: R:1']));
  assert.deepEqual(fs, []);
});

test('the same leap with enough time is fine', () => {
  const fs = findPlayability(score(['rh.1: <c2 g2 c3 e3 g3>:2 <c6 g6 c7 e7 g7>:2', 'lh.1: R:1']));
  assert.deepEqual(fs, []);
});

test('the pedal setting decides whether held notes pin the hands', () => {
  // A low and a high note are held for the whole measure while a middle note is struck: one hand cannot take two of them.
  const lines = ['rh.1: <c2 c6>:1', 'lh.1: r:4 e4:4 r:2'];
  assert.deepEqual(kinds(findPlayability(score(lines), { pedal: 'never' })), ['error/span']);
  assert.deepEqual(kinds(findPlayability(score(lines), { pedal: 'explicit' })), ['error/span']);
  assert.deepEqual(findPlayability(score(lines), { pedal: 'assumed' }), []);
  const pedaled = score(['rh.1: \\ped <c2 c6>:1', 'lh.1: r:4 e4:4 r:2'], ['rh.1: \\unped R:1', 'lh.1: R:1']);
  assert.deepEqual(findPlayability(pedaled, { pedal: 'explicit' }), []);
});

test('a staccato note is let go at once, so it pins nothing', () => {
  const fs = findPlayability(score(['rh.1: <c2 c6>:1-.', 'lh.1: r:4 e4:4 r:2']), { pedal: 'never' });
  assert.deepEqual(fs, []);
});

test('a piece of single notes needs no span', () => {
  assert.equal(requiredSpan(score(['rh.1: c4:4 e4 g4 c5', 'lh.1: R:1'])), 0);
});

test('required span: what the widest unavoidable hand needs', () => {
  assert.equal(requiredSpan(score(['rh.1: <c2 c4 c6>:1', 'lh.1: R:1'])), 24);
  assert.equal(requiredSpan(score(['rh.1: <c4 e4 g4>:1', 'lh.1: c3:1'])), 7);
});
