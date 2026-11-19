// export-notes: the sounding notes and measure starts handed to Pianizer's compare tool.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportNotes } from '../src/playback/export-notes.ts';
import { parseText } from '../src/textformat.ts';

const HEAD = `page 210x297 margin=10 space=1.75
staff rh clef=G2
staff lh clef=F4
`;

test('ticks are 480 per beat, measure starts are listed, notes sorted', () => {
  const e = exportNotes(
    parseText(`${HEAD}m1 time=2/4 key=0\n  rh.1: c4:4 d4:4\n  lh.1: c3:2\nm2\n  rh.1: e4:2\n  lh.1: R:2\n`),
  );
  assert.equal(e.format, 'thomas-notes');
  assert.equal(e.ticksPerBeat, 480);
  assert.deepEqual(e.measures, [0, 960]);
  assert.equal(e.totalTicks, 1920);
  assert.deepEqual(
    e.notes.map((n) => [n.pitch, n.startTick, n.endTick]),
    [
      [48, 0, 960],
      [60, 0, 480],
      [62, 480, 960],
      [64, 960, 1920],
    ],
  );
});

test('exact duplicate unisons are merged into one note', () => {
  const e = exportNotes(parseText(`${HEAD}m1 time=2/4 key=0\n  rh.1: c4:2\n  rh.2: c4:4 r:4\n`));
  assert.equal(e.notes.filter((n) => n.pitch === 60).length, 1);
  assert.equal(e.notes[0].endTick, 960);
});

test('tuplets land on whole ticks of the 480 grid', () => {
  const e = exportNotes(parseText(`${HEAD}m1 time=2/4 key=0\n  rh.1: 3:2{c5:8 d5 e5} f5:4\n  lh.1: R:2\n`));
  assert.deepEqual(
    e.notes.map((n) => n.startTick),
    [0, 160, 320, 480],
  );
});
