// Import of a Pianizer rendition: matching its notes to the heads of a score and taking over its curves.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PPQ, validate } from '../src/model.ts';
import { buildSequence } from '../src/playback/sequence.ts';
import type { PianizerProject } from '../src/rendition.ts';
import { importRendition } from '../src/rendition.ts';
import { parseText, writeText } from '../src/textformat.ts';

const TEXT = `# music typesetter score
page 210x297 margin=10 space=1.75
staff rh clef=G2

m1 time=4/4 key=0
  rh.1: c4:4 <e4 g4> d4:2
m2 time=4/4
  rh.1: c4:2~ c4:4 e4
`;

const TPB = 480;

/** The project of an unexpressive playing of a score: every sounding note of it, at 480 ticks per quarter. */
function plainProject(text: string): PianizerProject {
  const seq = buildSequence(parseText(text));
  return {
    version: 1,
    ticksPerBeat: TPB,
    notes: seq.notes.map((n) => ({
      pitch: n.midi,
      velocity: n.vel,
      startTick: Math.round((n.start * TPB) / PPQ),
      endTick: Math.round((n.end * TPB) / PPQ),
    })),
  };
}

/** The first head of the score with this MIDI pitch, found by event index in the first voice of a measure. */
function head(text: string, mi: number, idx: number, pi = 0) {
  const ev = parseText(text).measures[mi].staves.rh.voices[0].items.filter((i) => i.kind === 'note')[idx];
  assert.ok(ev && ev.kind === 'note');
  return ev.pitches[pi];
}

test('an unexpressive rendition changes nothing', () => {
  const { score, report } = importRendition(parseText(TEXT), plainProject(TEXT));
  assert.equal(writeText(score), TEXT);
  assert.equal(report.matched, report.notes);
  assert.equal(report.unmatchedCount, 0);
  assert.equal(report.headsWithoutNote, 0);
});

test('velocities, moved and resized notes become vel, shift and gate', () => {
  const project = plainProject(TEXT);
  const byPitch = (p: number, k = 0) => project.notes.filter((n) => n.pitch === p)[k];
  byPitch(60).velocity = 50; // The first c4.
  byPitch(64).startTick += 60; // The e4 of the chord, an eighth of a quarter late (62.5 ms at 120 bpm).
  byPitch(67).endTick -= 120; // The g4 of the chord, a quarter of its length shorter.
  const { score, report } = importRendition(parseText(TEXT), project);
  const out = writeText(score);
  assert.ok(out.includes('c4{v=50}:4'), out);
  assert.equal(head(out, 0, 0).vel, 50);
  const e4 = head(out, 0, 1, 0);
  assert.ok(e4.shift && Math.abs(e4.shift - 62.5) <= 1, `shift ${e4.shift}`);
  assert.equal(e4.vel, undefined);
  assert.equal(head(out, 0, 1, 1).gate, 0.75);
  assert.equal(head(out, 0, 2).gate, undefined);
  assert.equal(report.velocities, 1);
  assert.equal(report.shifts, 1);
  assert.equal(report.gates, 1);
  // The score now plays what the project played.
  const played = buildSequence(score).notes.find((n) => n.midi === 64 && n.start < PPQ * 4);
  assert.ok(played);
  assert.ok(Math.abs((buildSequence(score).msgs.find((m) => m.bytes[1] === 64)?.sec ?? 0) - 0.5625) < 2e-3);
  assert.deepEqual(validate(score), []);
});

test('a tied note is matched as one sounding note and keeps its length', () => {
  const project = plainProject(TEXT);
  const tied = project.notes.filter((n) => n.pitch === 60)[1]; // The c4 of two quarters plus one.
  tied.velocity = 33;
  tied.endTick -= 100;
  const { score } = importRendition(parseText(TEXT), project);
  const first = head(writeText(score), 1, 0);
  assert.equal(first.vel, 33);
  assert.equal(first.gate, undefined);
});

test('the tempo ratio, sustain and una corda curves become the performance', () => {
  const project = plainProject(TEXT);
  project.tempoPoints = [
    { tick: 0, value: 1 },
    { tick: 4 * TPB, value: 0.9 },
    { tick: 12 * TPB, value: 1 },
  ];
  project.pedalPoints = [
    { tick: TPB, value: 1 },
    { tick: 5 * TPB, value: 0.5 },
    { tick: 20 * TPB, value: 0 },
  ];
  project.softPedalRegions = [{ startTick: 2 * TPB, endTick: 6 * TPB }];
  const { score, report } = importRendition(parseText(TEXT), project);
  assert.deepEqual(score.performance?.tempo?.[1], { pos: { mi: 1, tick: 0 }, value: 0.9 });
  assert.deepEqual(score.performance?.tempo?.[2], { pos: { mi: 2 - 1, tick: 4 * PPQ }, value: 1 });
  // The pedal was held before its first point in the project, and the end lies beyond the piece.
  assert.deepEqual(score.performance?.sustain?.[0], { pos: { mi: 0, tick: 0 }, value: 1 });
  assert.deepEqual(score.performance?.sustain?.[1], { pos: { mi: 0, tick: PPQ }, value: 1 });
  assert.deepEqual(score.performance?.sustain?.at(-1), { pos: { mi: 1, tick: 4 * PPQ }, value: 0 });
  assert.deepEqual(score.performance?.soft, [{ from: { mi: 0, tick: 2 * PPQ }, to: { mi: 1, tick: 2 * PPQ } }]);
  assert.equal(report.tempoPoints, 3);
  assert.equal(report.softRegions, 1);
  // The slower part takes longer in the score, as in the project's own tempo curve.
  assert.ok(buildSequence(score).tickToSec(8 * PPQ) > 4);
  assert.deepEqual(validate(score), []);
  const again = parseText(writeText(score));
  assert.deepEqual(again.performance, score.performance);
});

test('an existing expression and performance of the score are replaced', () => {
  const scored = parseText(`${TEXT.replace('c4:4 <e4', 'c4{v=99,s=10,g=0.5}:4 <e4')}`);
  scored.performance = { soft: [{ from: { mi: 0, tick: 0 }, to: { mi: 0, tick: PPQ } }] };
  const { score } = importRendition(scored, plainProject(TEXT));
  assert.equal(writeText(score), TEXT);
  assert.equal(score.performance, undefined);
});

test('notes without a counterpart are reported, muted ones are counted, and small differences in time still match', () => {
  const project = plainProject(TEXT);
  project.notes.push({ pitch: 72, velocity: 70, startTick: 3 * TPB, endTick: 4 * TPB });
  project.notes[0].muted = true;
  project.notes[2].startTick += 50; // Late, but near.
  const { report } = importRendition(parseText(TEXT), project);
  assert.equal(report.unmatchedCount, 1);
  assert.match(report.unmatchedNotes[0], /^m. 1 beat 4 midi 72$/);
  assert.equal(report.muted, 1);
  assert.equal(report.headsWithoutNote, 1);
  assert.equal(report.matched, report.notes - 1);
});

test('repeated notes are matched in order', () => {
  const text = `# music typesetter score\npage 210x297 margin=10 space=1.75\nstaff rh clef=G2\n\nm1 time=4/4 key=0\n  rh.1: c4:8 c4 c4 c4 c4 c4 c4 c4\n`;
  const project = plainProject(text);
  project.notes.forEach((n, i) => {
    n.velocity = 20 + i;
  });
  const { score, report } = importRendition(parseText(text), project, { tolerance: 1 });
  assert.equal(report.matched, 8);
  const vels = parseText(writeText(score)).measures[0].staves.rh.voices[0].items.map((e) =>
    e.kind === 'note' ? e.pitches[0].vel : undefined,
  );
  assert.deepEqual(vels, [20, 21, 22, 23, 24, 25, 26, 27]);
});

test('a unison of two voices is one note in the project: the longest head gets it, the other one sounds alike (velocity only)', () => {
  const text = `# music typesetter score\npage 210x297 margin=10 space=1.75\nstaff rh clef=G2\n\nm1 time=4/4 key=0\n  rh.1: c4:2 d4:2\n  rh.2: c4:4 r:4 d4:2\n`;
  const project = plainProject(text);
  const unison = project.notes.filter((n) => n.pitch === 60);
  assert.equal(unison.length, 2);
  project.notes = project.notes.filter((n) => n !== unison[1]); // The shorter one is dropped, as Pianizer does.
  const long = project.notes.find((n) => n.pitch === 60 && n.endTick - n.startTick === TPB * 2);
  assert.ok(long);
  long.velocity = 55;
  const { score, report } = importRendition(parseText(text), project);
  const [v1, v2] = parseText(writeText(score)).measures[0].staves.rh.voices;
  assert.equal(v1.items[0].kind === 'note' && v1.items[0].pitches[0].vel, 55);
  assert.equal(v2.items[0].kind === 'note' && v2.items[0].pitches[0].vel, 55);
  assert.equal(v2.items[0].kind === 'note' && v2.items[0].pitches[0].gate, undefined);
  assert.equal(report.headsCopied, 1);
});

test('the velocity of a head with several strokes is their mean', () => {
  const text = `# music typesetter score\npage 210x297 margin=10 space=1.75\nstaff rh clef=G2\n\nm1 time=4/4 key=0\n  rh.1: trem1{c4:2 e4:2}\n`;
  const project = plainProject(text);
  const seen = new Map<number, number>();
  for (const n of project.notes) {
    const k = seen.get(n.pitch) ?? 0;
    seen.set(n.pitch, k + 1);
    n.velocity = 40 + (k % 2) * 20; // The strokes of each pitch alternate between 40 and 60.
  }
  const { score } = importRendition(parseText(text), project);
  const trem = parseText(writeText(score)).measures[0].staves.rh.voices[0].items[0];
  assert.ok(trem.kind === 'tremolo');
  const first = trem.items[0];
  assert.ok(first.kind === 'note');
  assert.equal(first.pitches[0].vel, 50);
});

test('a file that is not a project is refused', () => {
  assert.throws(() => importRendition(parseText(TEXT), { nope: 1 } as unknown as PianizerProject), /Pianizer project/);
});

test('the command line writes the score, and refuses another piece unless forced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thomas-rendition-'));
  const scoreFile = join(dir, 'in.txt');
  const projectFile = join(dir, 'p.json');
  const out = join(dir, 'out.txt');
  writeFileSync(scoreFile, TEXT);
  const project = plainProject(TEXT);
  project.notes[0].velocity = 41;
  writeFileSync(projectFile, JSON.stringify(project));
  const cli = new URL('../src/cli.ts', import.meta.url).pathname;
  const stdout = execFileSync('node', [cli, 'import-rendition', projectFile, scoreFile, out], { encoding: 'utf8' });
  assert.match(stdout, /6 of 6 notes matched/);
  assert.ok(readFileSync(out, 'utf8').includes('c4{v=41}'));
  const other = { ...project, notes: project.notes.map((n) => ({ ...n, pitch: n.pitch + 1 })) };
  writeFileSync(projectFile, JSON.stringify(other));
  const refused = spawnSync('node', [cli, 'import-rendition', projectFile, scoreFile, join(dir, 'x.txt')], {
    encoding: 'utf8',
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /fewer than 80%/);
  const forced = spawnSync('node', [cli, 'import-rendition', projectFile, scoreFile, join(dir, 'x.txt'), '--force'], {
    encoding: 'utf8',
  });
  assert.equal(forced.status, 0);
});
