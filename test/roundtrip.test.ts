// The text format must be lossless on the study fixture: write(parse(text)) == text.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validate } from '../src/model.ts';
import { parseText, writeText } from '../src/textformat.ts';

// The study fixture, a short piece that uses most features of the format.
const txt = readFileSync(new URL('./fixtures/study.txt', import.meta.url), 'utf8');

test('the study fixture parses and validates', () => {
  const s = parseText(txt);
  assert.equal(validate(s).length, 0);
  assert.equal(s.measures.length, 14);
});

test('text format round-trips losslessly', () => {
  const s = parseText(txt);
  assert.equal(writeText(s), txt);
  const s2 = parseText(writeText(s));
  assert.deepEqual(JSON.parse(JSON.stringify(s2)), JSON.parse(JSON.stringify(s)));
});
