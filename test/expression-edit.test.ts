// Editing expression and performance: the commands behind the Expression pane.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deleteMeasures, insertMeasures, setTimeSig } from '../src/editor/commands.ts';

import {
  headInfos,
  nudgeShift,
  nudgeVelocity,
  rampVelocity,
  resetExpression,
  rollChord,
  selectedHeads,
  setGate,
  setHeadValues,
  setShift,
  setVelocity,
} from '../src/editor/expression.ts';

import {
  addSoftRegion,
  clearCurve,
  curveTicks,
  moveCurvePoint,
  removeCurvePoints,
  removeSoftRegions,
  setCurvePoint,
  setSoftRegion,
  softTicks,
} from '../src/editor/performance.ts';

import { PPQ, validate } from '../src/model.ts';
import { buildSequence } from '../src/playback/sequence.ts';
import { parseText, writeText } from '../src/textformat.ts';

const HEAD = `# music typesetter score
page 210x297 margin=10 space=1.75
staff rh clef=G2
`;

const TEXT = `${HEAD}
m1 time=4/4 key=0
  rh.1: \\mf c4:4 <e4 g4 c5> d4:2
m2 time=4/4
  rh.1: \\arp <c4 e4 g4>:2 R
m3 time=4/4
  rh.1: R:1
`;

/** The ids of the heads of event `idx` of measure `mi`. */
const heads = (mi: number, idx: number, n = 1) =>
  Array.from({ length: n }, (_, pi) => ({ mi, staff: 'rh', voice: 1, idx, pi }));

test('selected heads: a chord gives all its heads, a ref with pi one, a measure everything', () => {
  const s = parseText(TEXT);
  const chord = { t: 'ev' as const, mi: 0, staff: 'rh', voice: 1, idx: 1 };
  assert.equal(selectedHeads(s, [chord]).length, 3);
  assert.deepEqual(
    selectedHeads(s, [{ ...chord, pi: 2 }]).map((h) => h.pi),
    [2],
  );
  assert.equal(selectedHeads(s, [{ t: 'measure', mi: 0 }]).length, 5);
  assert.equal(selectedHeads(s, [{ t: 'measure', mi: 2 }]).length, 0);
  assert.equal(selectedHeads(s, [chord, { ...chord, pi: 1 }]).length, 3);
});

test('velocity, shift and gate are set and reset, and a score without any is canonical text', () => {
  const s0 = parseText(TEXT);
  const h = heads(0, 1, 3);
  const s1 = setGate(setShift(setVelocity(s0, h.slice(0, 1), 70), h.slice(1, 2), -12.34), h.slice(2), 0.5);
  const [a, b, c] = (parseText(writeText(s1)).measures[0].staves.rh.voices[0].items[1] as { pitches: object[] })
    .pitches;
  assert.deepEqual(
    [a, b, c].map((x) => Object.keys(x).filter((k) => k !== 'pitch')),
    [['vel'], ['shift'], ['gate']],
  );
  assert.equal((b as { shift: number }).shift, -12.3);
  const s2 = resetExpression(s1, h);
  assert.equal(writeText(s2), TEXT);
  // The neutral values are not stored.
  const s3 = setGate(setShift(s0, h, 0), h, 1);
  assert.equal(writeText(s3), writeText(s0));
  // Velocity is clamped to what MIDI can play.
  const s4 = setVelocity(s0, h.slice(0, 1), 300);
  assert.ok(writeText(s4).includes('{v=127}'));
});

test('head infos tell what each head sounds like and whether the head sets it', () => {
  const s = setVelocity(parseText(TEXT), heads(0, 1, 3).slice(0, 1), 33);
  const infos = headInfos(s);
  const e4 = infos.find((i) => i.midi === 64 && i.head.mi === 0);
  assert.ok(e4);
  assert.equal(e4.vel, 33);
  assert.deepEqual(e4.has, { vel: true, shift: false, gate: false });
  const g4 = infos.find((i) => i.midi === 67 && i.head.mi === 0);
  assert.equal(g4?.vel, 80); // From the mezzo forte.
  assert.deepEqual(g4?.has, { vel: false, shift: false, gate: false });
});

test('nudging a velocity starts from what the head sounds like now', () => {
  const s0 = parseText(TEXT);
  const h = heads(0, 1, 3);
  const s1 = nudgeVelocity(setVelocity(s0, h.slice(0, 1), 60), h, 10);
  assert.deepEqual(
    headInfos(s1)
      .filter((i) => i.head.mi === 0 && i.head.idx === 1)
      .map((i) => i.vel),
    [70, 90, 90],
  );
  const s2 = nudgeVelocity(s1, h, 1000);
  assert.ok(headInfos(s2).every((i) => i.vel <= 127));
  const s3 = nudgeShift(nudgeShift(s0, h, 5), h.slice(0, 1), -8);
  assert.deepEqual(
    headInfos(s3)
      .filter((i) => i.head.mi === 0 && i.head.idx === 1)
      .map((i) => i.shift),
    [-3, 5, 5],
  );
});

test('a ramp goes from the first to the last attack in the chosen shape; chords get one value', () => {
  const s0 = parseText(TEXT);
  const all = selectedHeads(s0, [{ t: 'measure', mi: 0 }]);
  const lin = rampVelocity(s0, all, 40, 100);
  const v = (s: typeof s0) =>
    headInfos(s)
      .filter((i) => i.head.mi === 0)
      .map((i) => i.vel);
  assert.deepEqual(v(lin), [40, 70, 70, 70, 100]); // The chord starts half way between the first and the last attack.
  const ease = rampVelocity(s0, all, 40, 100, 'ease-in');
  assert.deepEqual(v(ease), [40, 55, 55, 55, 100]);
  assert.throws(() => rampVelocity(s0, [], 1, 2), /Select/);
});

test('rolling a chord spreads the attacks over the span, from the top or the bottom, and a notated arpeggio is not rolled twice', () => {
  const s0 = parseText(TEXT);
  const seqOf = (s: typeof s0) => buildSequence(s);
  const at = (s: typeof s0, midi: number, measure: number) => {
    const seq = seqOf(s);
    const t = seq.measureStart[measure];
    return seq.notes
      .filter((n) => n.midi === midi && n.start >= t && n.start < t + 4 * PPQ && n.head)
      .map((n) => seq.tickToSec(n.start) + n.shift / 1000)[0];
  };
  const chord = heads(0, 1, 3);
  const down = rollChord(s0, chord, { span: 90, dir: 'down', anchor: 'last' });
  const base = 0.5; // The chord starts a quarter into the piece, at 120 bpm.
  assert.ok(Math.abs(at(down, 72, 0) - (base - 0.09)) < 1e-6);
  assert.ok(Math.abs(at(down, 67, 0) - (base - 0.045)) < 1e-6);
  assert.ok(Math.abs(at(down, 64, 0) - base) < 1e-6);
  // The chord of measure 2 has a notated arpeggio; the rolled attacks are exactly 20 ms apart all the same.
  const arp = rollChord(s0, heads(1, 0, 3), { span: 40, dir: 'up', anchor: 'first' });
  const t0 = at(arp, 60, 1);
  assert.ok(Math.abs(at(arp, 64, 1) - t0 - 0.02) < 1e-6);
  assert.ok(Math.abs(at(arp, 67, 1) - t0 - 0.04) < 1e-6);
  assert.throws(() => rollChord(s0, heads(0, 0), { span: 40, dir: 'up', anchor: 'first' }), /chord/);
});

test('a tremolo is not part of a rolled chord', () => {
  const text = `${HEAD}\nm1 time=4/4 key=0\n  rh.1: trem1{c4:2 e4:2}\n`;
  const s0 = parseText(text);
  const all = selectedHeads(s0, [{ t: 'measure', mi: 0 }]);
  assert.equal(all.length, 2);
  assert.throws(() => rollChord(s0, all, { span: 40, dir: 'up', anchor: 'first' }), /chord/);
});

test('setHeadValues refuses a head that does not exist', () => {
  assert.throws(
    () =>
      setHeadValues(parseText(TEXT), [{ head: { mi: 0, staff: 'rh', voice: 1, idx: 0, pi: 4 }, values: { vel: 1 } }]),
    /No such note/,
  );
  assert.throws(
    () =>
      setHeadValues(parseText(TEXT), [{ head: { mi: 7, staff: 'rh', voice: 1, idx: 0, pi: 0 }, values: { vel: 1 } }]),
    /No such note/,
  );
});

test('curve points are added in order, replaced at the same place, moved between their neighbors and removed', () => {
  let s = parseText(TEXT);
  s = setCurvePoint(s, 'tempo', 4 * PPQ, 0.9);
  s = setCurvePoint(s, 'tempo', 0, 1);
  s = setCurvePoint(s, 'tempo', 8 * PPQ, 1.1);
  s = setCurvePoint(s, 'tempo', 4 * PPQ, 0.95);
  assert.deepEqual(curveTicks(s, 'tempo'), [
    { tick: 0, value: 1 },
    { tick: 4 * PPQ, value: 0.95 },
    { tick: 8 * PPQ, value: 1.1 },
  ]);
  assert.deepEqual(validate(s), []);
  assert.deepEqual(s.performance?.tempo?.[1].pos, { mi: 1, tick: 0 });
  // Moving past a neighbor stops one tick short of it.
  s = moveCurvePoint(s, 'tempo', 1, 9 * PPQ, 0.8);
  assert.deepEqual(curveTicks(s, 'tempo')[1], { tick: 8 * PPQ - 1, value: 0.8 });
  s = removeCurvePoints(s, 'tempo', [0, 2]);
  assert.equal(curveTicks(s, 'tempo').length, 1);
  assert.equal(clearCurve(s, 'tempo').performance, undefined);
  assert.equal(writeText(clearCurve(s, 'tempo')), TEXT);
  // Values stay in range, and a point at the very end belongs to the last measure.
  s = setCurvePoint(s, 'sustain', 99 * PPQ, 5);
  assert.deepEqual(s.performance?.sustain, [{ pos: { mi: 2, tick: 4 * PPQ }, value: 1 }]);
  assert.deepEqual(validate(s), []);
});

test('una corda regions merge when they touch, resize and go', () => {
  let s = parseText(TEXT);
  s = addSoftRegion(s, 2 * PPQ, 4 * PPQ);
  s = addSoftRegion(s, 8 * PPQ, 6 * PPQ);
  assert.deepEqual(softTicks(s), [
    { from: 2 * PPQ, to: 4 * PPQ },
    { from: 6 * PPQ, to: 8 * PPQ },
  ]);
  s = addSoftRegion(s, 4 * PPQ, 6 * PPQ);
  assert.deepEqual(softTicks(s), [{ from: 2 * PPQ, to: 8 * PPQ }]);
  s = setSoftRegion(s, 0, 3 * PPQ, 5 * PPQ);
  assert.deepEqual(softTicks(s), [{ from: 3 * PPQ, to: 5 * PPQ }]);
  assert.throws(() => addSoftRegion(s, PPQ, PPQ), /empty/);
  assert.equal(removeSoftRegions(s, [0]).performance, undefined);
});

test('the anchors of the performance follow measures that are inserted or deleted, and stay valid when a measure shrinks', () => {
  let s = parseText(TEXT);
  s = setCurvePoint(s, 'sustain', 5 * PPQ, 1); // Measure 2, a quarter in.
  s = setCurvePoint(s, 'sustain', 10 * PPQ, 0.5); // Measure 3.
  s = addSoftRegion(s, 3 * PPQ, 6 * PPQ);
  const more = insertMeasures(s, 1, 2);
  assert.deepEqual(
    more.performance?.sustain?.map((p) => p.pos.mi),
    [3, 4],
  );
  assert.deepEqual(more.performance?.soft, [{ from: { mi: 0, tick: 3 * PPQ }, to: { mi: 3, tick: 2 * PPQ } }]);
  assert.deepEqual(validate(more), []);
  const cut = deleteMeasures(s, 1, 1);
  assert.deepEqual(
    cut.performance?.sustain?.map((p) => [p.pos.mi, p.value]),
    [[1, 0.5]],
  );
  assert.deepEqual(cut.performance?.soft, [{ from: { mi: 0, tick: 3 * PPQ }, to: { mi: 1, tick: 0 } }]);
  assert.deepEqual(validate(cut), []);
  // A shorter measure takes its points to its end; a measure that goes loses them.
  const short = setTimeSig(setCurvePoint(parseText(TEXT), 'sustain', 3 * PPQ + 1000, 1), 0, { beats: 2, beatType: 4 });
  assert.deepEqual(validate(short), []);
  assert.deepEqual(short.performance?.sustain?.[0].pos.tick, 2 * PPQ);
});
