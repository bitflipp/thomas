import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importMusicXml } from '../src/musicxml.ts';
import { writeText, parseText } from '../src/textformat.ts';
import { validate } from '../src/model.ts';

const xml = readFileSync(new URL('../gewitter.musicxml', import.meta.url), 'utf8');

test('MusicXML imports and validates', () => {
  const s = importMusicXml(xml);
  assert.equal(validate(s).length, 0);
  assert.equal(s.measures.length, 120);
});

test('text format round-trips losslessly', () => {
  const s = importMusicXml(xml);
  const txt = writeText(s);
  const s2 = parseText(txt);
  assert.deepEqual(JSON.parse(JSON.stringify(s2)), JSON.parse(JSON.stringify(s)));
  assert.equal(writeText(s2), txt);
});
