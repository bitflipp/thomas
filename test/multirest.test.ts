import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as C from '../src/editor/commands.ts';
import { findCollisions } from '../src/engrave/collide.ts';
import { findMultiRuns } from '../src/engrave/multirest.ts';
import { prepare } from '../src/engrave/prep.ts';
import { engrave } from '../src/engrave/system.ts';
import { importMusicXml } from '../src/musicxml.ts';
import { parseText, writeText } from '../src/textformat.ts';

const HEAD = (on: boolean) => `page 210x297 margin=10 space=1.75${on ? ' multirests=on' : ''}
staff rh clef=G2 name="Piano"
staff lh clef=F4 name="Piano"
brace rh lh
`;

const EMPTY = '  rh.1: R:1\n  lh.1: R:1';
const NOTES = '  rh.1: c5:1\n  lh.1: R:1';

/** A score with one measure per entry: a note measure ('n') or an empty one ('e'). */
const make = (pattern: string, on = true): string =>
  HEAD(on) +
  [...pattern].map((c, i) => `\nm${i + 1}${i === 0 ? ' time=4/4 key=0' : ''}\n${c === 'n' ? NOTES : EMPTY}`).join('') +
  '\n';

const digits = (src: string) => {
  const out = engrave(parseText(src));
  return out.pages[0].prims.filter((p) => p.k === 'rest' && p.t === 'glyph' && /^timeSig\d$/.test(p.name));
};

test('the multi-rests option round-trips through the text format', () => {
  const text = writeText(parseText(make('neen')));
  assert.match(text, /multirests=on/);
  assert.equal(writeText(parseText(text)), text);
  assert.doesNotMatch(writeText(parseText(make('neen', false))), /multirests/);
});

test('runs of two or more empty measures collapse, a single one does not', () => {
  const sc = parseText(make('neeennnee'));
  const runs = findMultiRuns(prepare(sc), new Set());
  assert.deepEqual(
    [...runs.len],
    [
      [1, 3],
      [7, 2],
    ],
  );
  assert.deepEqual([...runs.absorbed], [2, 3, 8]);
});

test('a multi-measure rest is drawn as a bar with the count, once per staff, without collisions', () => {
  const src = make('neeeen');
  const out = engrave(parseText(src));
  const bars = out.pages[0].prims.filter((p) => p.k === 'rest' && p.t === 'line' && p.w === 1);
  assert.equal(bars.length, 2);
  assert.equal(digits(src).length, 2); // The number 4, once per staff.
  assert.deepEqual(findCollisions(out.pages), []);
  // Without the option the measures are drawn as usual.
  assert.equal(digits(make('neeeen', false)).length, 0);
});

test('the swallowed measures have no width and the run keeps its barline at its end only', () => {
  const sc = parseText(make('neeen'));
  const out = engrave(sc);
  const ms = out.layout.measures.filter((m) => m.staff === 0);
  assert.equal(ms[2].x1 - ms[2].x0, 0);
  assert.ok(ms[1].x1 - ms[1].x0 > 5);
  const barlines = out.pages[0].prims.filter((p) => p.k === 'barline' && p.t === 'line' && p.y1 < 20);
  // The start of the system, the end of measure 1, the end of the run and the end of the piece (thin and thick).
  assert.equal(barlines.length, 5);
});

test('a key change, a forced break or a mark ends a run', () => {
  const find = (src: string, forced = new Set<number>()) => [...findMultiRuns(prepare(parseText(src)), forced).len];
  assert.deepEqual(find(make('neeee')), [[1, 4]]);
  assert.deepEqual(find(make('neeee'), new Set([3])), [
    [1, 2],
    [3, 2],
  ]);
  const withKey = parseText(make('neeee'));
  assert.deepEqual(
    [...findMultiRuns(prepare(C.setKeySig(withKey, 3, 2)), new Set()).len],
    [
      [1, 2],
      [3, 2],
    ],
  );
  const withMark = C.addMark(
    parseText(make('neeee')),
    { mi: 3, staff: 'rh', voice: 1, idx: 0 },
    { type: 'text', text: 'x', placement: 'above' },
  );
  assert.deepEqual(
    [...findMultiRuns(prepare(withMark), new Set()).len],
    [
      [1, 2],
      [3, 2],
    ],
  );
});

test('a line never ends inside a run', () => {
  // Many short runs on a narrow line: no system may start with a swallowed measure.
  const src = make('neeen' + 'eeee'.repeat(1) + 'nn'.repeat(12) + 'eee'.repeat(3));
  const sc = parseText(src);
  const out = engrave(sc);
  const absorbed = findMultiRuns(prepare(sc), new Set()).absorbed;
  assert.ok(out.layout.systems.length > 1);
  for (const s of out.layout.systems) assert.ok(!absorbed.has(s.a), `system starts inside a run at ${s.a}`);
});

test('MusicXML that asks for multi-measure rests switches the option on', () => {
  const xml = (extra: string) =>
    `<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>x</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef>${extra}</attributes><note><rest measure="yes"/><duration>4</duration><voice>1</voice></note></measure></part></score-partwise>`;
  assert.equal(
    importMusicXml(xml('<measure-style><multiple-rest>4</multiple-rest></measure-style>')).page.multiRests,
    true,
  );
  assert.equal(importMusicXml(xml('')).page.multiRests, undefined);
});
