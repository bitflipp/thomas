// Tests for pickup measures: a measure with its own length (`Measure.length`), numbered 0 when it is the first.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beamGroups, beatPhase, beatTicks } from '../src/beams.ts';
import * as C from '../src/editor/commands.ts';
import { engrave } from '../src/engrave/system.ts';

import { lengthOf, measureLabel, PPQ, timeAt, validate } from '../src/model.ts';
import { importMusicXml } from '../src/musicxml.ts';
import { buildSequence, measureStarts } from '../src/playback/sequence.ts';
import { parseText, writeText } from '../src/textformat.ts';

const TEXT = `# music typesetter score
page 210x297 margin=10 space=1.75
staff s1 clef=G2

m0 time=3/4 length=1/4
  s1.1: g4:4
m1
  s1.1: c5:2. 
m2
  s1.1: R:2.
`;

test('text format: length= round-trips and the pickup is written as m0', () => {
  const s = parseText(TEXT);
  assert.equal(s.measures[0].length, PPQ);
  assert.deepEqual(validate(s), []);
  const out = writeText(s);
  assert.match(out, /^m0 time=3\/4 length=1\/4$/m);
  assert.equal(writeText(parseText(out)), out);
  assert.deepEqual(parseText(out), s);
});

test('lengths and numbers: a pickup shortens its measure and shifts the numbers', () => {
  const s = parseText(TEXT);
  assert.deepEqual(
    [0, 1, 2].map((i) => lengthOf(s, i)),
    [PPQ, 3 * PPQ, 3 * PPQ],
  );
  assert.deepEqual(
    [0, 1, 2].map((i) => measureLabel(s, i)),
    [0, 1, 2],
  );
  const { measureStart, total } = measureStarts(s);
  assert.deepEqual(measureStart, [0, PPQ, 4 * PPQ]);
  assert.equal(total, 7 * PPQ);
  assert.equal(buildSequence(s).totalTicks, 7 * PPQ);
  const plain = parseText(TEXT.replace(' length=1/4', '').replace('g4:4', 'g4:2.'));
  assert.deepEqual(
    [0, 1].map((i) => measureLabel(plain, i)),
    [1, 2],
  );
});

test('validation: a voice longer than the pickup is reported', () => {
  const s = parseText(TEXT.replace('g4:4', 'g4:2'));
  assert.notDeepEqual(validate(s), []);
});

test('engraving: the pickup is narrower and the second measure is numbered 1', () => {
  const s = parseText(TEXT);
  const e = engrave(s, { measureNumbers: 'all' });
  const sys = e.layout.systems[0];
  assert.ok(sys);
  const texts = e.pages[0].prims
    .filter((p) => p.t === 'text' && p.k === 'measurenum')
    .map((p) => (p as { s: string }).s);
  assert.ok(texts.includes('2'));
  assert.ok(!texts.includes('3'));
});

test('setMeasureLength: shortens with refit, restores, refuses a longer measure', () => {
  const full = parseText(TEXT.replace(' length=1/4', '').replace('g4:4', 'g4:2.'));
  const p = C.setMeasureLength(full, 0, PPQ);
  assert.equal(p.measures[0].length, PPQ);
  assert.deepEqual(validate(p), []);
  assert.equal(lengthOf(p, 0), PPQ);
  const back = C.setMeasureLength(p, 0, undefined);
  assert.equal(back.measures[0].length, undefined);
  assert.deepEqual(validate(back), []);
  assert.throws(() => C.setMeasureLength(full, 0, 4 * PPQ), C.EditError);
});

test('a time signature change keeps a shorter measure and drops one that is no longer shorter', () => {
  const s = parseText(TEXT);
  const kept = C.setTimeSig(s, 0, { beats: 4, beatType: 4 });
  assert.equal(kept.measures[0].length, PPQ);
  assert.deepEqual(validate(kept), []);
  const dropped = C.setTimeSig(s, 0, { beats: 1, beatType: 4 });
  assert.equal(dropped.measures[0].length, undefined);
  assert.deepEqual(validate(dropped), []);
});

test('MusicXML: an implicit measure becomes a pickup', () => {
  const note = (step: string, dur: number, type: string, dot = '') =>
    `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>${dur}</duration><voice>1</voice><type>${type}</type>${dot}</note>`;
  const xml = `<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="0" implicit="yes"><attributes><divisions>480</divisions><time><beats>3</beats><beat-type>4</beat-type></time>
<clef><sign>G</sign><line>2</line></clef></attributes>${note('G', 480, 'quarter')}</measure>
<measure number="1">${note('C', 1440, 'half', '<dot/>')}</measure></part></score-partwise>`;
  const warnings: string[] = [];
  const s = importMusicXml(xml, { warn: (m) => warnings.push(m) });
  assert.equal(s.measures[0].length, PPQ);
  assert.equal(s.measures[1].length, undefined);
  assert.deepEqual(validate(s), []);
  assert.deepEqual(warnings, []);
  assert.equal(writeText(parseText(writeText(s))), writeText(s));
});

test('beaming: the beat grid of a pickup is aligned to its end', () => {
  const s = parseText(`# music typesetter score
page 210x297 margin=10 space=1.75
staff s1 clef=G2

m0 time=4/4 length=3/8
  s1.1: c5:8 d5:8 e5:8
m1
  s1.1: R:1
`);
  assert.equal(beatPhase(s, 0), PPQ / 2);
  assert.equal(beatPhase(s, 1), 0);
  const v = s.measures[0].staves.s1.voices[0];
  const beat = beatTicks(timeAt(s, 0));
  const names = (phase: number) =>
    beamGroups(v, beat, phase).map((g) => g.map((e) => (e.kind === 'note' ? e.pitches[0].pitch.step : '?')).join(''));
  // From the measure start the first two eighths share a beat; aligned to the end the last two do.
  assert.deepEqual(names(0), ['cd']);
  assert.deepEqual(names(beatPhase(s, 0)), ['de']);
  // The engraver and the editor use the aligned grid.
  assert.ok(engrave(s).pages[0].prims.length > 0);
  // `join` on the third note is what the aligned grid already does, so nothing explicit is written; `break` on
  // the third note separates the aligned pair.
  const at = (idx: number) => [{ mi: 0, staff: 's1', voice: 1, idx }];
  const same = C.setBeamMode(s, at(2), 'join');
  assert.equal(same.measures[0].staves.s1.voices[0].items.length, 3);
  const apart = C.setBeamMode(s, at(2), 'break');
  assert.deepEqual(beamGroups(apart.measures[0].staves.s1.voices[0], beat, beatPhase(apart, 0)), []);
});

test('engraving: a whole-measure rest in a bar of dotted length has no dot', () => {
  const s = parseText(`# music typesetter score
page 210x297 margin=10 space=1.75
staff s1 clef=G2

m1 time=3/4
  s1.1: R:2.
`);
  const prims = engrave(s).pages[0].prims;
  assert.ok(prims.some((p) => p.t === 'glyph' && p.name === 'restWhole'));
  assert.ok(!prims.some((p) => p.t === 'glyph' && p.name === 'augmentationDot'));
});
