import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beamLinks, beamModes, beatTicks } from '../src/beams.ts';
import { indexScore } from '../src/editor/addr.ts';
import * as C from '../src/editor/commands.ts';
import { dependentNotes } from '../src/editor/hit.ts';
import type { Score } from '../src/model.ts';
import { flattenVoice, marksOf, validate } from '../src/model.ts';
import { parseText, writeText } from '../src/textformat.ts';

const base = (m = '  rh.1: R:2\n  lh.1: R:2') => `page 210x297 margin=10 space=1.75
staff rh clef=G2
staff lh clef=F4
brace rh lh
m1 time=2/4
${m}
m2
  rh.1: R:2
  lh.1: R:2
`;

const load = (t = base()): Score => parseText(t);

const ok = (s: Score) => {
  assert.deepEqual(validate(s), []);
  assert.equal(writeText(parseText(writeText(s))), writeText(s));
  return s;
};

const loc = { mi: 0, staff: 'rh', voice: 1 };
const PPQ4 = 3360;
const c4 = { step: 'c' as const, alter: 0, octave: 4 };

const show = (s: Score, mi = 0, st = 'rh') =>
  writeText(s)
    .split('\n')
    .filter((l) => l.startsWith(`  ${st}.`) && true)[mi] ?? '';

test('enterNote into a measure rest leaves rests around it', () => {
  const s = ok(C.enterNote(load(), loc, PPQ4 / 2, { base: 8, dots: 0 }, c4));
  assert.match(show(s), /r:8 c4 r:4/);
});

test('a longer note swallows what follows, a shorter one leaves rests', () => {
  let s = C.enterNote(load(), loc, 0, { base: 4, dots: 0 }, c4);
  s = C.enterNote(s, loc, PPQ4, { base: 4, dots: 0 }, c4);
  s = ok(C.setDuration(s, { ...loc, idx: 0 }, { base: 2, dots: 0 }));
  assert.equal(flattenVoice(s.measures[0].staves.rh.voices[0]).length, 1);
  s = ok(C.setDuration(s, { ...loc, idx: 0 }, { base: 8, dots: 0 }));
  assert.match(show(s), /c4:8 r r:4/);
});

test('chord toggling and delete', () => {
  let s = C.enterNote(load(), loc, 0, { base: 4, dots: 0 }, c4);
  s = ok(C.enterNote(s, loc, 0, { base: 4, dots: 0 }, { ...c4, step: 'e' }, { chord: true }));
  assert.match(show(s), /<c4 e4>:4/);
  s = ok(C.enterNote(s, loc, 0, { base: 4, dots: 0 }, { ...c4, step: 'e' }, { chord: true }));
  assert.match(show(s), /c4:4/);
  s = ok(C.deleteEvents(s, [{ ...loc, idx: 0 }]));
  assert.match(show(s), /r:4/);
});

test('tuplets: make, enter inside, refuse to overflow', () => {
  let s = C.makeTuplet(load(), { ...loc, idx: 0 }, 3, 2);
  ok(s);
  const q = (PPQ4 * 2) / 3; // This is a third of the half-note span, for a tuplet written as a 4th.
  void q;
  s = ok(C.enterNote(s, loc, 0, { base: 4, dots: 0 }, c4));
  assert.match(show(s), /3:2\{c4:4 /);
  assert.throws(() => C.enterNote(s, loc, 0, { base: 1, dots: 0 }, c4), /fit/);
});

test('slurs get free numbers and tidy removes dangling ones', () => {
  let s = C.enterNote(load(), loc, 0, { base: 4, dots: 0 }, c4);
  s = C.enterNote(s, loc, PPQ4, { base: 4, dots: 0 }, c4);
  s = ok(C.addSlur(s, { ...loc, idx: 0 }, { ...loc, idx: 1 }));
  assert.match(show(s), /\(c4:4 c4\)/);
  s = ok(C.deleteEvents(s, [{ ...loc, idx: 1 }]));
  assert.doesNotMatch(show(s), /\(/);
});

test('marks and spans', () => {
  let s = C.enterNote(load(), loc, 0, { base: 4, dots: 0 }, c4);
  s = ok(C.addMark(s, { ...loc, idx: 0 }, { type: 'dynamic', text: 'mf' }));
  s = ok(C.addSpanOver(s, 'cresc', { ...loc, idx: 0 }, { ...loc, mi: 1, idx: 0 }));
  assert.equal(marksOf(s.measures[1].staves.rh)[0].type, 'stop');
  const idx = indexScore(s);
  const mk = marksOf(s.measures[0].staves.rh).find((m) => m.type === 'hairpin')!;
  s = ok(C.removeMark(s, idx.mark.get(mk)!));
  assert.equal(marksOf(s.measures[1].staves.rh).length, 0);
});

test('a mark is added to and moved between events', () => {
  let s = C.enterNote(load(), loc, 0, { base: 4, dots: 0 }, c4);
  s = C.enterNote(s, loc, PPQ4, { base: 4, dots: 0 }, c4);
  s = ok(C.addMark(s, { ...loc, idx: 0 }, { type: 'dynamic', text: 'mf' }));
  s = ok(C.addMark(s, { ...loc, idx: 0 }, { type: 'dynamic', text: 'f' })); // The new dynamic replaces the one on that event.
  const dyn = () =>
    marksOf(s.measures[0].staves.rh)
      .filter((m) => m.type === 'dynamic')
      .map((m) => `${(m as { text: string }).text}@${m.tick}`)
      .join();
  assert.equal(dyn(), 'f@0');
  s = ok(C.moveMark(s, { ...loc, idx: 0, k: 0 }, { ...loc, idx: 1 }));
  assert.equal(dyn(), `f@${PPQ4}`);
});

test('marks hang on events: they follow a changed note, and a hairpin goes when the note carrying one end is replaced', () => {
  let s = C.enterNote(load(), loc, 0, { base: 4, dots: 0 }, c4);
  s = C.enterNote(s, loc, PPQ4, { base: 4, dots: 0 }, c4);
  s = ok(C.addMark(s, { ...loc, idx: 0 }, { type: 'dynamic', text: 'mf' }));
  s = ok(C.addSpanOver(s, 'cresc', { ...loc, idx: 0 }, { ...loc, idx: 0 })); // The span ends where the second note starts.
  const types = () =>
    marksOf(s.measures[0].staves.rh)
      .map((m) => `${m.type}@${m.tick}`)
      .join();
  assert.equal(types(), `dynamic@0,hairpin@0,stop@${PPQ4}`);
  s = ok(C.enterNote(s, loc, 0, { base: 4, dots: 0 }, { step: 'd', alter: 0, octave: 4 })); // This puts another note in place of the first.
  assert.equal(types(), `dynamic@0,hairpin@0,stop@${PPQ4}`);
  s = ok(C.setDuration(s, { ...loc, idx: 0 }, { base: 8, dots: 0 }));
  assert.equal(types(), `dynamic@0,hairpin@0,stop@${PPQ4}`); // The note after it stays where it was.
  s = ok(C.enterNote(s, loc, 0, { base: 2, dots: 0 }, c4)); // The half note covers the event that carried the stop.
  assert.equal(types(), 'dynamic@0');
});

test('measures: time change refits, delete and insert', () => {
  let s = C.enterNote(load(), loc, PPQ4, { base: 4, dots: 0 }, c4);
  s = ok(C.setTimeSig(s, 0, { beats: 3, beatType: 4 }));
  s = ok(C.setTimeSig(s, 0, { beats: 1, beatType: 4 }));
  s = ok(C.insertMeasures(s, 1, 2));
  assert.equal(s.measures.length, 4);
  s = ok(C.deleteMeasures(s, 0, 1));
  assert.equal(s.measures.length, 2);
  assert.throws(() => C.deleteMeasures(s, 0, 1), /at least one/);
});

test('ties, transposition, cross-staff', () => {
  let s = C.enterNote(load(), loc, 0, { base: 4, dots: 0 }, c4);
  s = ok(C.toggleTie(s, [{ ...loc, idx: 0 }]));
  assert.match(show(s), /c4:4~/);
  s = ok(C.transpose(s, [{ ...loc, idx: 0 }], { semis: 1 }));
  assert.match(show(s), /c#4/);
  s = ok(C.setStaffOf(s, [{ ...loc, idx: 0 }], 'lh'));
  assert.match(show(s), /\\staff lh/);
});

import { readFileSync } from 'node:fs';
import { buildHitIndex, hitTest, marquee, measureAt, snapTick } from '../src/editor/hit.ts';
import { engrave } from '../src/engrave/system.ts';

test('hit index: every note head of the example is found where it is drawn', () => {
  const s = parseText(readFileSync(new URL('../examples/tango.txt', import.meta.url), 'utf8'));
  const res = engrave(s, { respectBreaks: true });
  const h = buildHitIndex(s, res);
  let heads = 0;
  let found = 0;
  for (const t of h.targets) {
    if (t.k !== 'head') continue;
    heads++;
    const b = t.boxes[0];
    const got = hitTest(h, t.page, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, 0.05);
    if (got && got.ref.t === 'ev' && t.ref.t === 'ev' && got.ref.mi === t.ref.mi && got.ref.staff === t.ref.staff)
      found++;
  }
  assert.ok(heads > 500);
  assert.ok(found / heads > 0.97, `${found}/${heads}`);
});

test('slots: a point in a measure maps to the measure, staff and a nearby column', () => {
  const s = parseText(readFileSync(new URL('../examples/tango.txt', import.meta.url), 'utf8'));
  const res = engrave(s, { respectBreaks: true });
  const g = res.layout.measures.find((m) => m.mi === 2 && m.staff === 1)!;
  const got = measureAt(res.layout, g.page, (g.x0 + g.x1) / 2, g.y + 2)!;
  assert.equal(got.mi, 2);
  assert.equal(got.staff, 1);
  const sn = snapTick(g, 3360 * 4, g.cols[2].x + 0.1, 840);
  assert.equal(sn.tick, g.cols[2].tick);
  const h = buildHitIndex(s, res);
  const refs = marquee(h, g.page, { x0: g.x0, x1: g.x1, y0: g.y - 3, y1: g.y + 7 });
  assert.ok(refs.length > 0 && refs.every((r) => r.t === 'ev'));
});

test('beam groups and tremolos', () => {
  let s = load();
  for (let i = 0; i < 4; i++) s = C.enterNote(s, loc, (i * 3360) / 2, { base: 8, dots: 0 }, c4);
  s = ok(C.makeBeam(s, loc, 0, 3));
  assert.match(show(s), /\[c4:8 c4 c4 c4\]/);
  s = ok(C.ungroup(s, { ...loc, idx: 1 }));
  assert.doesNotMatch(show(s), /\[/);
  s = ok(C.makeBeam(s, loc, 0, 3));
  s = ok(C.makeTremolo(s, loc, 0, 1, 2)); // This dissolves the longer beam group around the pair.
  assert.doesNotMatch(show(s), /\[/);
  s = ok(C.ungroup(s, { ...loc, idx: 1 }));
  s = ok(C.makeBeam(s, loc, 0, 1));
  s = ok(C.makeTremolo(s, loc, 0, 1, 2)); // This replaces the two-note beam.
  assert.doesNotMatch(show(s), /\[/);
  assert.match(show(s), /trem2\{/);
  s = ok(C.makeTremolo(s, loc, 0, 1, 3)); // This changes the beams without nesting.
  assert.match(show(s), /trem3\{/);
  assert.doesNotMatch(show(s), /trem\d\{trem/);
  assert.throws(() => C.makeTremolo(s, loc, 2, 4), /exactly two/);
  s = ok(C.deleteEvents(s, [{ ...loc, idx: 1 }]));
  assert.doesNotMatch(show(s), /trem/);
});

test('paste copies events one after another and drops slur flags', () => {
  let s = C.enterNote(load(), loc, 0, { base: 4, dots: 0 }, c4);
  s = C.enterNote(s, loc, 3360, { base: 4, dots: 0 }, { ...c4, step: 'e' });
  s = C.addSlur(s, { ...loc, idx: 0 }, { ...loc, idx: 1 });
  const evs = [0, 1].map((i) => flattenVoice(s.measures[0].staves.rh.voices[0])[i].ev);
  s = ok(C.pasteEvents(s, { mi: 1, staff: 'rh', voice: 1 }, 0, evs));
  assert.match(show(s, 1), /c4:4 e4$/);
  assert.doesNotMatch(show(s, 1), /\(/);
  assert.throws(() => C.pasteEvents(s, { mi: 1, staff: 'rh', voice: 1 }, 3360 * 2, evs), /fit|Does not/);
});

test('staves: add, connect, move, remove', () => {
  let s = ok(C.addStaff(load(), { clef: { sign: 'F', line: 4 }, name: 'Bass' }));
  assert.equal(s.staves.length, 3);
  assert.equal(s.groups.length, 1); // The original brace is kept.
  s = ok(C.setConnection(s, 1, 'bracket'));
  assert.deepEqual(C.connections(s), ['brace', 'bracket']);
  s = ok(C.moveStaff(s, 's3', -1));
  assert.deepEqual(
    s.staves.map((x) => x.id),
    ['rh', 's3', 'lh'],
  );
  s = ok(C.addStaff(s, { clef: { sign: 'G', line: 2 }, at: 1 }));
  assert.equal(C.connections(s)[0], undefined);
  s = ok(C.removeStaff(s, 's3'));
  s = ok(C.setStaffName(s, 'rh', 'Piano'));
  s = ok(C.removeStaff(s, 's4'));
  assert.throws(() => C.removeStaff(C.removeStaff(s, 'lh'), 'rh'), /at least one/);
  s = ok(C.setMeasureNumbers(s, 'all'));
  assert.match(writeText(s), /numbers=all/);
});

test('cross-staff references vanish with their staff', () => {
  let s = C.enterNote(load(), loc, 0, { base: 4, dots: 0 }, c4);
  s = C.setStaffOf(s, [{ ...loc, idx: 0 }], 'lh');
  s = ok(C.removeStaff(s, 'lh'));
  assert.doesNotMatch(writeText(s), /staff lh/);
});

test('a selected hairpin names the events it hangs on, and the text format keeps the voice that carries a mark', () => {
  const s = parseText(
    '# music typesetter score\nstaff rh clef=G2\n\nm1 time=4/4 key=0\n  rh.1: c5:2 d5\n  rh.2: \\< e4:2 r \\!\n',
  );
  const idx = indexScore(s);
  const mk = marksOf(s.measures[0].staves.rh).find((m) => m.type === 'hairpin')!;
  const a = idx.mark.get(mk)!;
  assert.deepEqual([a.voice, a.idx], [2, 0]);
  assert.deepEqual(
    dependentNotes(s, { t: 'mark', ...a }).map((x) => [x.voice, x.idx]),
    [
      [2, 0],
      [2, 1],
    ],
  );
  assert.equal(marksOf(s.measures[0].staves.rh).find((m) => m.type === 'stop')!.idx, -1); // The stop is at the end of the measure, on voice 2.
  assert.deepEqual(JSON.parse(JSON.stringify(parseText(writeText(s)))), JSON.parse(JSON.stringify(s)));
});

test('a line drawn from note to note hangs on those events (a stop goes before the starts at its position; the voice end when it ends on the last event)', () => {
  let s = C.enterNote(
    load(base().replace('time=2/4', 'time=4/4').replace(/R:2/g, 'R:1')),
    loc,
    0,
    { base: 4, dots: 0 },
    c4,
  );
  s = C.enterNote(s, loc, PPQ4, { base: 4, dots: 0 }, c4); // The voice is a quarter, a quarter and a half rest.
  s = ok(C.addSpanOver(s, 'pedal', { ...loc, idx: 2 }, { ...loc, idx: 2 })); // The span ends on the last event of the voice.
  s = ok(C.addSpanOver(s, 'pedal', { ...loc, idx: 1 }, { ...loc, idx: 0 })); // The span is drawn backwards and ends where the first one starts.
  const m = marksOf(s.measures[0].staves.rh).map((x) => `${x.type === 'stop' ? 'stop' : x.type}@${x.tick}`);
  assert.deepEqual(m, ['pedal@0', `stop@${2 * PPQ4}`, `pedal@${2 * PPQ4}`, `stop@${4 * PPQ4}`]);
  assert.throws(() => C.addSpanOver(s, 'cresc', { ...loc, idx: 0 }, { ...loc, staff: 'lh', idx: 0 }), /one staff/);
});

test('a hairpin that stops before a note belongs to the note before it, also across a measure line (gewitter m33-34)', async () => {
  const { readFileSync } = await import('node:fs');
  const s = parseText(readFileSync(new URL('../examples/gewitter.txt', import.meta.url), 'utf8'));
  const mk = marksOf(s.measures[32].staves.s2).find((m) => m.type === 'hairpin')!;
  const a = indexScore(s).mark.get(mk)!;
  const ns = dependentNotes(s, { t: 'mark', ...a });
  assert.deepEqual(
    ns.map((x) => [x.mi, x.idx]),
    [
      [32, 2],
      [33, 3],
    ],
  ); // The note is eb2 in m33, the last 16th before the quintuplet in m34.
});

test('the end of a slur on a unison head shared with another voice is still found (gewitter m78-79, voice 2)', async () => {
  const { readFileSync } = await import('node:fs');
  const { engrave } = await import('../src/engrave/system.ts');
  const { buildHitIndex, noteBoxes } = await import('../src/editor/hit.ts');
  const s = parseText(readFileSync(new URL('../examples/gewitter.txt', import.meta.url), 'utf8'));
  const h = buildHitIndex(s, engrave(s));
  const t = h.targets.find((x) => x.ref.t === 'slur' && x.ref.mi === 77 && x.ref.voice === 2)!;
  const notes = dependentNotes(s, t.ref);
  assert.equal(notes.length, 2);
  assert.equal(noteBoxes(h, t.page, notes).length, 2);
});

test('halving the rest of an empty bar gives ordinary half rests, not a whole-bar rest', () => {
  const s = ok(
    C.setDuration(
      load(
        base('  rh.1: R:1\n  lh.1: R:1')
          .replace('time=2/4', 'time=4/4')
          .replace(/\nm2\n.*\n.*\n$/, '\n'),
      ),
      { ...loc, idx: 0 },
      { base: 2, dots: 0 },
    ),
  );
  const rests = flattenVoice(s.measures[0].staves.rh.voices[0]).map(
    (t) => t.ev as { kind: string; style: string; dur: { base: number } },
  );
  assert.deepEqual(
    rests.map((r) => [r.kind, r.style, r.dur.base]),
    [
      ['rest', 'normal', 2],
      ['rest', 'normal', 2],
    ],
  );
});

test('beam modes per note', () => {
  let s = load();
  for (let i = 0; i < 4; i++) s = C.enterNote(s, loc, (i * 3360) / 2, { base: 8, dots: 0 }, c4);
  const at = (idx: number) => ({ ...loc, idx });
  const modes = () => beamModes(s.measures[0].staves.rh.voices[0], beatTicks({ beats: 2, beatType: 4 }));
  assert.deepEqual(modes(), ['auto', 'auto', 'auto', 'auto']);
  s = ok(C.setBeamMode(s, [at(2)], 'join')); // This joins across the beat.
  assert.match(show(s), /\[c4:8 c4 c4 c4\]/);
  assert.deepEqual(modes(), ['auto', 'auto', 'join', 'auto']);
  s = ok(C.setBeamMode(s, [at(2)], 'auto'));
  assert.doesNotMatch(show(s), /\[|nobeam/);
  s = ok(C.setBeamMode(s, [at(1)], 'none'));
  assert.match(show(s), /c4:8 \\nobeam c4 c4 c4$/);
  assert.deepEqual(modes(), ['auto', 'none', 'auto', 'auto']);
  s = ok(C.setBeamMode(s, [at(1)], 'auto'));
  assert.doesNotMatch(show(s), /nobeam/);
  s = ok(C.setBeamMode(s, [at(2)], 'none'));
  s = ok(C.setBeamMode(s, [at(2)], 'break')); // The flag is gone, and the note starts a beam with its successor.
  assert.doesNotMatch(show(s), /nobeam|\[/);
  s = ok(C.setBeamMode(s, [at(1)], 'break')); // The note is alone, and so is its partner in the beat, so one flag does both.
  assert.deepEqual(beamLinks(s.measures[0].staves.rh.voices[0], 3360), [false, false, false, true]);
  assert.deepEqual(modes(), ['auto', 'none', 'auto', 'auto']);
  s = ok(C.setBeamMode(s, [at(1)], 'auto'));
  s = ok(C.setBeamMode(s, [at(1)], 'none'));
  s = ok(C.setBeamMode(s, [at(2)], 'join')); // Joining takes the flag of the previous note away.
  assert.deepEqual(modes(), ['auto', 'auto', 'join', 'auto']);
  assert.throws(() => C.setBeamMode(s, [at(0)], 'join'), /previous measure/);
  s = ok(C.setBeamMode(s, [at(1), at(3)], 'break')); // This cuts two of the three links of the beam over four notes.
  assert.deepEqual(beamLinks(s.measures[0].staves.rh.voices[0], 3360), [false, false, true, false]);
  s = ok(C.setBeamMode(s, [at(1), at(3)], 'auto')); // This goes back to the beam over four notes.
  assert.match(show(s), /\[c4:8 c4 c4 c4\]/);
  s = ok(C.setBeamMode(s, [at(2)], 'auto'));
  assert.doesNotMatch(show(s), /\[|nobeam/);
});

test('breaking a sixteenth beam in the middle', () => {
  let s = load();
  for (let i = 0; i < 4; i++) s = C.enterNote(s, loc, i * 840, { base: 16, dots: 0 }, c4);
  s = ok(C.setBeamMode(s, [{ ...loc, idx: 2 }], 'break'));
  assert.match(show(s), /\[c4:16 c4\] \[c4 c4\]/);
  s = ok(C.setBeamMode(s, [{ ...loc, idx: 2 }], 'join'));
  assert.doesNotMatch(show(s), /\[/);
  s = C.enterNote(s, loc, 4 * 840, { base: 4, dots: 0 }, c4);
  assert.throws(() => C.setBeamMode(s, [{ ...loc, idx: 4 }], 'join'), /eighth/);
});

test('select similar finds equal marks across the score, and one edit changes them all', async () => {
  const { similarTo } = await import('../src/editor/similar.ts');
  let s = load();
  for (const t of [0, PPQ4, PPQ4 * 2 + 0]) if (t < PPQ4 * 2) s = C.enterNote(s, loc, t, { base: 4, dots: 0 }, c4);
  s = ok(C.addMark(s, { ...loc, idx: 0 }, { type: 'dynamic', text: 'p' }));
  s = ok(C.addMark(s, { ...loc, idx: 1 }, { type: 'dynamic', text: 'f' }));
  s = ok(C.addMark(s, { ...loc, mi: 1, idx: 0 }, { type: 'dynamic', text: 'p' }));
  const first = marksOf(s.measures[0].staves.rh).find((m) => m.type === 'dynamic' && m.text === 'p')!;
  const refs = similarTo(s, { t: 'mark', ...loc, idx: first.idx, k: first.k });
  assert.equal(refs.length, 3); // These are all dynamics, not just the p's.
  s = ok(C.updateMarks(s, refs as never, { text: 'mp' } as never));
  const texts = [0, 1].flatMap((mi) =>
    marksOf(s.measures[mi].staves.rh).flatMap((m) => (m.type === 'dynamic' ? [m.text] : [])),
  );
  assert.deepEqual(texts.sort(), ['mp', 'mp', 'mp']);
});

test('fermata, trill and grace commands', () => {
  const a = { mi: 0, staff: 'rh', voice: 1, idx: 0 };
  let s = ok(C.enterNote(load(), loc, 0, { base: 4, dots: 0 }, c4));
  s = ok(C.toggleFermata(s, [a]));
  assert.match(show(s), /\+fm/);
  s = ok(C.toggleFermata(s, [a]));
  assert.doesNotMatch(show(s), /\+fm/);
  s = ok(C.toggleTrill(s, [a]));
  assert.match(show(s), /\+tr/);
  assert.throws(() => C.toggleTrill(s, [{ ...a, idx: 1 }]), C.EditError);
  const g = { pitches: [{ pitch: { step: 'd' as const, alter: 0, octave: 4 } }], base: 8 as const, slash: true };
  s = ok(C.addGrace(s, a, g));
  assert.match(show(s), /\\acc\{/);
  s = ok(C.updateGrace(s, a, 0, { slash: false, base: 16 }));
  assert.match(show(s), /\\grace\{ ?d4:16/);
  s = ok(C.transposeGrace(s, a, 0, 1));
  assert.match(show(s), /e4:16/);
  assert.throws(() => C.addGrace(s, { ...a, idx: 1 }, g), C.EditError);
  s = ok(C.removeGrace(s, a, 0));
  assert.doesNotMatch(show(s), /grace/);
});
