import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as C from '../src/editor/commands.ts';
import { parseText as parse } from '../src/textformat.ts';

test('staves: instrument presets, moveStaffTo, duplicateStaff', () => {
  const s = parse(readFileSync('examples/gewitter.txt', 'utf8'));
  const n = s.staves.length;
  const a = C.addInstrument(s, 'satb', 0);
  assert.equal(a.staves.length, n + 4);
  assert.deepEqual(C.connections(a).slice(0, 3), ['bracket', 'bracket', 'bracket']);
  const m = C.moveStaffTo(a, a.staves[0].id, 3);
  assert.equal(m.staves[3].id, a.staves[0].id);
  const d = C.duplicateStaff(s, s.staves[0].id);
  assert.equal(d.staves.length, n + 1);
});
