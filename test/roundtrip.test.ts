import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validate } from '../src/model.ts';
import { parseText, writeText } from '../src/textformat.ts';

// The reference piece in the text format (generated from its MusicXML by `import`, see CLAUDE.md).
const txt = readFileSync(new URL('../examples/gewitter.txt', import.meta.url), 'utf8');

test('the reference piece parses and validates', () => {
  const s = parseText(txt);
  assert.equal(validate(s).length, 0);
  assert.equal(s.measures.length, 120);
});

test('text format round-trips losslessly', () => {
  const s = parseText(txt);
  assert.equal(writeText(s), txt);
  const s2 = parseText(writeText(s));
  assert.deepEqual(JSON.parse(JSON.stringify(s2)), JSON.parse(JSON.stringify(s)));
});
