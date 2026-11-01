import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseText, writeText } from '../src/textformat.ts';
import { validate, flattenVoice, marksOf, type Score, type Mark } from '../src/model.ts';
import { beamGroups, simplifyBeams, simplifyTupletBrackets } from '../src/beams.ts';

const HEAD = 'page 210x297 margin=10 space=1.9\nstaff rh clef=G2\n';
const parse = (body: string): Score => parseText(`${HEAD}m1 time=4/4\n${body}\n`);
const voice = (s: Score) => s.measures[0].staves.rh.voices[0];

test('write(parse(text)) is stable for the canonical forms', () => {
  const src = `${HEAD}
m1 time=2/4
  rh.1: trem2{ c5:4. e5 } 3:2(above){ \\nobeam c5:8 d5 e5 } \\8va <c5~ e5>:4 g5:4~
  rh@: @1/4 \\< @3/4 \\! \\unped
`;
  const s = parseText(src);
  const t = writeText(s);
  assert.equal(writeText(parseText(t)), t);
  assert.deepEqual(JSON.parse(JSON.stringify(parseText(t))), JSON.parse(JSON.stringify(s)));
});

test('marks are positioned from the parsed tree (tuplets, end of measure, mark lines)', () => {
  const s = parse('  rh.1: \\p c5:8 3:2{ \\f d5:16 e5 f5 } \\!\n  rh@: @1/2 \\ped');
  const at = (pred: (m: Mark) => boolean) => marksOf(s.measures[0].staves.rh).find(pred)!.tick;
  assert.equal(at((m) => m.type === 'dynamic' && m.text === 'p'), 0);
  assert.equal(at((m) => m.type === 'dynamic' && m.text === 'f'), 1680);
  assert.equal(at((m) => m.type === 'stop'), 1680 + 1680); // 8th, then three 16ths in the time of two 8ths
  assert.equal(at((m) => m.type === 'pedal'), 1680);
});

test('tremolo is a group of exactly two notes', () => {
  const s = parse('  rh.1: trem2{ c5:4 e5 } trem3{ c5:4 e5 }');
  assert.deepEqual(validate(s), []);
  const flat = flattenVoice(voice(s));
  assert.equal(flat[0].tremolo?.beams, 2);
  assert.equal(flat[2].tremolo?.beams, 3);
  assert.notEqual(flat[0].tremolo, flat[2].tremolo);
  const bad = parse('  rh.1: trem2{ c5:8 d5 e5 d5 }');
  assert.match(validate(bad).join(), /exactly two notes/);
});

test('ties: per pitch inside a chord, after the duration for a single note', () => {
  const s = parse('  rh.1: <c5~ e5>:4 g5:4~');
  const [chord, note] = voice(s).items as { pitches: { tie?: boolean }[] }[];
  assert.deepEqual(chord.pitches.map((p) => !!p.tie), [true, false]);
  assert.deepEqual(note.pitches.map((p) => !!p.tie), [true]);
  assert.throws(() => parse('  rh.1: <c5 e5>:4~'), /inside <>/);
});

test('\\nobeam keeps a note out of the automatic beaming', () => {
  const s = parse('  rh.1: c5:8 d5');
  assert.equal(beamGroups(voice(s), 3360).length, 1);
  const t = parse('  rh.1: \\nobeam c5:8 d5');
  assert.equal(beamGroups(voice(t), 3360).length, 0);
});

test('simplifyBeams drops groups the automatic rules reproduce and keeps the others', () => {
  const s = parseText(`${HEAD}m1 time=4/4\n  rh.1: [ c5:8 d5 ] [ e5 f5 ] [ g5 a5 b5 c6 ] [ d6:16 ] c5:4 r:8 [ c5:8 ]\n`);
  const v = s.measures[0].staves.rh.voices[0];
  const before = beamGroups(v, 3360).map((g) => g.length);
  simplifyBeams(v, 3360);
  assert.deepEqual(beamGroups(v, 3360).map((g) => g.length).sort(), [...before].sort());
  const rest = writeText(s).split('\n').find((l) => l.includes('rh.1'))!;
  // [g a b c] spans two beats, which automatic beaming would split: it stays explicit
  assert.match(rest, /\[ g5/);
  assert.ok(!/\[ c5:8 d5 \]/.test(rest));
});

test('simplifyTupletBrackets drops a bracket choice equal to the default', () => {
  const s = parseText(`${HEAD}m1 time=2/4\n  rh.1: 3:2(nobracket){ c5:16 d5 e5 } r:8 3:2(bracket){ c5:8 r d5 }\n`);
  const v = s.measures[0].staves.rh.voices[0];
  simplifyTupletBrackets(v, 3360);
  const [a, b] = v.items as { bracket?: boolean }[];
  assert.equal(a.bracket, undefined); // fully beamed: no bracket anyway
  assert.equal(b.bracket, undefined); // not beamed: bracket anyway
});

test('validate rejects single-note beam groups', () => {
  assert.match(validate(parse('  rh.1: [ c5:8 ] r:8 r:2')).join(), /at least two notes/);
});

test('cross-staff notes: \\staff switches the display staff, sticky and lossless', () => {
  const src = `page 210x297 margin=10 space=1.9
staff rh clef=G2
staff lh clef=F4
m1 time=2/4
  lh.1: c3:16 e3 \\staff rh g4 c5 \\staff lh r:8 d3:8
  rh.1: R:2
`;
  const s = parseText(src);
  const evs = flattenVoice(s.measures[0].staves.lh.voices[0]).map((t) => t.ev.staff);
  assert.deepEqual(evs, [undefined, undefined, 'rh', 'rh', undefined, undefined]);
  assert.deepEqual(validate(s), []);
  assert.equal(writeText(s).includes('\\staff rh g4'), true);
  assert.equal(writeText(parseText(writeText(s))), writeText(s));
  const bad = parseText(src.replace('\\staff rh', '\\staff lh').replace('staff lh r:8', 'staff xx r:8'));
  assert.ok(validate(bad).some((e) => e.includes('cross-staff')));
});
