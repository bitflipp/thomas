// Staff commands: instrument presets, moving and duplicating staves.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as C from '../src/editor/commands.ts';
import { engrave } from '../src/engrave/system.ts';
import { parseText as parse, writeText } from '../src/textformat.ts';

test('staves: instrument presets, moveStaffTo, duplicateStaff', () => {
  const s = parse(readFileSync(new URL('./fixtures/study.txt', import.meta.url), 'utf8'));
  const n = s.staves.length;
  const a = C.addInstrument(s, 'satb', 0);
  assert.equal(a.staves.length, n + 4);
  assert.deepEqual(C.connections(a).slice(0, 3), ['bracket', 'bracket', 'bracket']);
  const m = C.moveStaffTo(a, a.staves[0].id, 3);
  assert.equal(m.staves[3].id, a.staves[0].id);
  const d = C.duplicateStaff(s, s.staves[0].id);
  assert.equal(d.staves.length, n + 1);
});

// Staff labels: full names before the first system (indented), abbreviations before the others.

const LABELED = `page 120x160 margin=10 space=1.75 labels=full,abbr labelsize=2.2
staff a clef=G2 name="Piano" abbr="Pno."
staff b clef=F4
staff c clef=G2 name="Violin I" abbr="Vl. I"
brace a b

${Array.from({ length: 12 }, (_, i) => `m${i + 1}\n  a.1: c5:1\n  b.1: c3:1\n  c.1: g4:1`).join('\n')}
`;

test('staff labels: text format roundtrip and settings commands', () => {
  const s = parse(LABELED);
  assert.deepEqual(
    [s.page.labelsFirst, s.page.labelsLater, s.page.labelSize, s.staves[0].abbr, s.staves[1].name],
    ['full', 'abbr', 2.2, 'Pno.', undefined],
  );
  assert.equal(writeText(s), `# music typesetter score\n${LABELED}`);
  const off = C.setStaffLabels(s, { first: undefined, later: undefined, size: undefined });
  assert.doesNotMatch(writeText(off), /labels/);
  const abbr = C.setStaffAbbr(s, 'c', '');
  assert.equal(abbr.staves[2].abbr, undefined);
  assert.equal(C.setStaffLabels(s, { later: 'full' }).page.labelsLater, 'full');
});

test('staff labels: drawn per system, first system indented, none when off', () => {
  const s = parse(LABELED);
  const e = engrave(s, { respectBreaks: false });
  const texts = e.pages.flatMap((p) => p.prims.filter((p) => p.k === 'stafflabel')) as { s: string }[];
  assert.equal(texts[0].s, 'Piano'); // The pair a/b is labelled once, the second staff has no name.
  assert.equal(texts[1].s, 'Violin I');
  assert.equal(texts[2].s, 'Pno.');
  assert.equal(texts[3].s, 'Vl. I');
  const sys = e.layout.systems;
  assert.ok(sys.length >= 2);
  assert.ok(sys[0].x0 > sys[1].x0); // Indented by the longer labels.
  assert.ok(sys.every((y) => y.x1 <= 120 / 1.75 - 10 / 1.75 + 1e-6)); // Everything stays within the margin.
  const off = engrave(C.setStaffLabels(s, { first: undefined, later: undefined }), { respectBreaks: false });
  assert.equal(off.pages.flatMap((p) => p.prims).filter((p) => p.k === 'stafflabel').length, 0);
  assert.equal(off.layout.systems[0].x0, off.layout.systems[1].x0);
});
