// The parallel fifths and octaves check: the rules of the conseq tool on small scores.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { ParallelGroup } from '../src/analysis/parallels.ts';
import { findParallels } from '../src/analysis/parallels.ts';
import { parseText } from '../src/textformat.ts';

/** A two-staff score from the lines of voices of measures: each measure is `[rh voice 1, lh voice 1, ...]` lines. */
const score = (...measures: string[][]) =>
  parseText(
    `page 210x297 margin=10 space=1.75
staff rh clef=G2
staff lh clef=F4
brace rh lh
${measures.map((lines, i) => `m${i + 1}${i === 0 ? ' time=4/4' : ''}\n${lines.map((l) => `  ${l}`).join('\n')}`).join('\n')}
`,
  );

/** The group's notes as "measure:staff.voice:event/head" strings. */
const where = (g: ParallelGroup) =>
  g.notes.map((n) => `${n.ev.mi + 1}:${n.ev.staff}.${n.ev.voice}:${n.ev.idx}/${n.pi}`);

test('parallel fifths between two voices are found, with the notes of both intervals', () => {
  const gs = findParallels(score(['rh.1: g4:2 a4', 'lh.1: c4:2 d4']));
  assert.equal(gs.length, 1);
  assert.deepEqual(gs[0].kinds, ['fifths']);
  assert.deepEqual(where(gs[0]), ['1:lh.1:0/0', '1:rh.1:0/0', '1:lh.1:1/0', '1:rh.1:1/0']);
  assert.equal(gs[0].number, 1);
  assert.deepEqual([gs[0].mi, gs[0].tick], [0, 0]);
});

test('four fifths in a row are three intervals whose corners go round without crossing', () => {
  const [g] = findParallels(score(['rh.1: g4 a4 b4 c5', 'lh.1: c4 d4 e4 f4']));
  assert.equal(g.intervals.length, 3);
  // The corners: one voice then the other at one attack, then the other then the first at the next.
  assert.deepEqual(
    g.intervals[0].notes.map((n) => `${n.ev.staff}${n.ev.idx}`),
    ['rh0', 'lh0', 'lh1', 'rh1'],
  );
});

test('other motion is not flagged: oblique, contrary into a fifth, a fifth followed by a sixth', () => {
  assert.deepEqual(findParallels(score(['rh.1: g4:2 g4', 'lh.1: c4:2 e4'])), []);
  assert.equal(findParallels(score(['rh.1: b4:2 a4', 'lh.1: e4:2 d4'])).length, 1); // Descending fifths are parallel too.
  assert.deepEqual(findParallels(score(['rh.1: g4:2 a4', 'lh.1: c4:2 e4'])), []);
  assert.deepEqual(findParallels(score(['rh.1: g4:2 b4', 'lh.1: c4:2 g3'])), []);
});

test('octaves across the staves; the kinds can be chosen', () => {
  const s = score(['rh.1: c5:2 d5', 'lh.1: c4:2 d4']);
  const gs = findParallels(s);
  assert.equal(gs.length, 1);
  assert.deepEqual(gs[0].kinds, ['octaves']);
  assert.deepEqual(findParallels(s, ['fifths']), []);
  assert.equal(findParallels(s, ['octaves']).length, 1);
});

test('compound intervals count: a twelfth moving to a twelfth', () => {
  assert.equal(findParallels(score(['rh.1: g5:2 a5', 'lh.1: c4:2 d4']), ['fifths']).length, 1);
});

test('an octave inside one voice (a doubling) is allowed, a fifth inside a chord moving on is not', () => {
  assert.deepEqual(findParallels(score(['rh.1: <c4 c5>:2 <d4 d5>', 'lh.1: R:1'])), []);
  const gs = findParallels(score(['rh.1: <c4 g4>:2 <d4 a4>', 'lh.1: R:1']));
  assert.equal(gs.length, 1);
  assert.equal(gs[0].notes.length, 4);
});

test('the lower note of an octave doubling in a staff is ignored, an octave between the staves is not', () => {
  // The right hand doubles the line at the octave: both notes are a fifth above the bass, but that is one finding.
  const doubled = findParallels(score(['rh.1: <g4 g5>:2 <a4 a5>', 'lh.1: c3:2 d3']));
  assert.equal(doubled.length, 1);
  assert.equal(doubled[0].notes.length, 4);
  assert.deepEqual(
    doubled[0].notes.map((n) => n.pi),
    [0, 1, 0, 1],
  );
  assert.equal(doubled[0].intervals.length, 1);
  // Octaves between the hands are kept, however the notes are doubled.
  assert.equal(findParallels(score(['rh.1: g4:2 a4', 'lh.1: g3:2 a3'])).length, 1);
});

test('a tie continuation is not an attack: a held fifth is one interval, a repeated one is two', () => {
  assert.deepEqual(findParallels(score(['rh.1: g4:2~ g4', 'lh.1: c4:2~ c4'])), []);
  assert.deepEqual(findParallels(score(['rh.1: g4:2~ g4', 'lh.1: c4:2 c4'])), []);
  const repeated = findParallels(score(['rh.1: g4:2 g4', 'lh.1: c4:2 c4']));
  assert.equal(repeated.length, 1);
  // The second fifth sounds again after a tie-free repeat; a tie from the previous measure counts as held.
  const across = score(['rh.1: g4:1~', 'lh.1: c4:1~'], ['rh.1: g4:2 a4', 'lh.1: c4:2 d4']);
  assert.equal(findParallels(across).length, 1); // The held fifth leads into a4/d4 in measure 2.
  assert.deepEqual(
    where(findParallels(across)[0]).map((x) => x.slice(0, 1)),
    ['2', '2', '2', '2'],
  ); // The tied-over notes of measure 1 are not part of it.
});

test('rest look-through: a shared rest does not hide the parallel, an attack in between does', () => {
  const rest = findParallels(score(['rh.1: g4:4 r a4 r', 'lh.1: c4:4 r d4 r']));
  assert.equal(rest.length, 1);
  assert.equal(rest[0].notes.length, 4);
  assert.deepEqual(findParallels(score(['rh.1: g4:4 r a4 r', 'lh.1: c4:4 e4 d4 r'])), []);
});

test('rest look-through across the notes of one voice: chord, rest, chord', () => {
  assert.equal(findParallels(score(['rh.1: <c4 g4>:4 r <d4 a4> r', 'lh.1: R:1'])).length, 1);
});

test('no interval is made up between notes that never sounded together', () => {
  // The previous g4/c4 never overlapped (c4 comes after g4 has gone), so a4/d4 is no consecutive fifth.
  assert.deepEqual(findParallels(score(['rh.1: g4:4 r:2. | a4:4 r:2.'.split(' | ')[0], 'lh.1: r:4 c4:4 r:2'])), []);
});

test('a long rest does not separate fifths that nothing came between', () => {
  const s = score(['rh.1: g4:4 a4 r:2', 'lh.1: c4:4 d4 r:2'], ['rh.1: R:1', 'lh.1: R:1'], ['rh.1: b4:1', 'lh.1: e4:1']);
  assert.equal(findParallels(s).length, 1);
});

test('violations that share a note are one group, others are separate and numbered in score order', () => {
  const chain = findParallels(score(['rh.1: g4:4 a4 b4 r', 'lh.1: c4:4 d4 e4 r']));
  assert.equal(chain.length, 1);
  assert.equal(chain[0].notes.length, 6);
  const apart = findParallels(
    score(
      ['rh.1: g4:4 a4 r:2', 'lh.1: c4:4 d4 r:2'],
      ['rh.1: e5:1', 'lh.1: c4:1'],
      ['rh.1: r:2 b4:4 c5', 'lh.1: r:2 e4:4 f4'],
    ),
  );
  assert.deepEqual(
    apart.map((g) => [g.number, g.mi, g.tick]),
    [
      [1, 0, 0],
      [2, 2, 3360 * 2],
    ],
  );
});

test('fifths and octaves that share a note are one group of both kinds', () => {
  // Three voices: a fifth and an octave from the same top note moving together.
  const s = score(['rh.1: g5:2 a5', 'rh.2: c5:2 d5', 'lh.1: c4:2 d4']);
  const gs = findParallels(s);
  assert.equal(gs.length, 1);
  assert.deepEqual(gs[0].kinds, ['fifths', 'octaves']);
});

test('grace notes and rests are ignored', () => {
  assert.deepEqual(findParallels(score(['rh.1: \\acc{g4:8} a4:2 r', 'lh.1: c4:2 d4'])), []);
});

test('the study fixture can be checked', () => {
  const s = parseText(readFileSync(new URL('./fixtures/study.txt', import.meta.url), 'utf8'));
  for (const g of findParallels(s)) assert.ok(g.notes.length >= 4);
});

test('a chord of four going on to a chord of three: the fifth is possible when only some mergers give it', () => {
  // C-E-G-B to D-F#-A: G may go to F# (no fifth above the bass) or to A (C-G becomes D-A).
  const gs = findParallels(score(['rh.1: <c4 e4 g4 b4>:2 <d4 f#4 a4>', 'lh.1: R:1']));
  assert.equal(gs.length, 1);
  assert.equal(gs[0].level, 'possible');
  assert.deepEqual(gs[0].kinds, ['fifths']);
});

test('chords of equal size and separate voices are certain, the outer notes of a chord always are', () => {
  assert.equal(findParallels(score(['rh.1: <c4 e4 g4>:2 <d4 f4 a4>', 'lh.1: R:1']))[0].level, 'certain');
  assert.equal(findParallels(score(['rh.1: <c4 e4 g4>:2 <d4 a4>', 'lh.1: R:1']))[0].level, 'certain');
  assert.equal(findParallels(score(['rh.1: <e4 f4 g4>:2 <f4 a4>', 'lh.1: c3:2 d3']))[0].level, 'certain');
});

test('a pair that the voice-leading of equal chords does not lead into the interval is no violation', () => {
  // Note by note c-g-b goes to b-d-a, so the fifth c-g goes to a third, and d-a is reached from g-b.
  assert.deepEqual(findParallels(score(['rh.1: <c4 g4 b4>:2 <b3 d4 a4>', 'lh.1: R:1'])), []);
  // A chord that splits may lead g to either of the new notes: possible, not certain.
  assert.equal(findParallels(score(['rh.1: <c4 g4>:2 <d4 f4 a4 e5>', 'lh.1: R:1']))[0].level, 'possible');
});

test('a doubled octave still counts as a line: b-e-b going to c#-e-g# is contrary motion, not a fifth', () => {
  assert.deepEqual(findParallels(score(['rh.1: <b4 e5 b5>:2 <c#5 e5 g#5>', 'lh.1: R:1'])), []);
});
