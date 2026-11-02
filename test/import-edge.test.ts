import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engrave } from '../src/engrave/system.ts';
import { validate } from '../src/model.ts';
import { importMusicXml } from '../src/musicxml.ts';
import { parseText, writeText } from '../src/textformat.ts';

/** One-staff MusicXML (divisions = 480 per quarter, 4/4) with the given `<note>` bodies in measure 1. */
function xmlOf(body: string): string {
  return `<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>480</divisions><time><beats>4</beats><beat-type>4</beat-type></time>
<clef><sign>G</sign><line>2</line></clef></attributes>${body}</measure></part></score-partwise>`;
}
const note = (step: string, dur: number, type: string) =>
  `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>${dur}</duration><voice>1</voice><type>${type}</type></note>`;
const rest = (dur: number, type: string) =>
  `<note><rest/><duration>${dur}</duration><voice>1</voice><type>${type}</type></note>`;

test('128th notes: text round-trip, import and engraving', () => {
  const s = parseText(
    '# music typesetter score\nstaff s1 clef=G2\n\nm1 time=1/16\n  s1.1: c4:128 d4 e4 f4 g4 a4 b4 c5\n',
  );
  assert.equal(validate(s).length, 0);
  assert.equal(writeText(parseText(writeText(s))), writeText(s));
  assert.throws(() => parseText('staff s1 clef=G2\n\nm1 time=1/16\n  s1.1: c4:128. r:128\n'));
  const imp = importMusicXml(
    xmlOf(`${note('C', 15, '128th')}${rest(465, 'half')}${note('D', 1440, 'half')}${rest(480, 'quarter')}`),
  );
  const first = imp.measures[0].staves.s1.voices[0].items[0];
  assert.deepEqual((first as { dur: unknown }).dur, { base: 128, dots: 0 });
  assert.ok(engrave(s).pages[0].prims.length > 0);
});

test('a source measure longer than its time signature is split, notes across the cut are tied', () => {
  // 8 quarters in 4/4; the D starts on an off-beat so it crosses the cut.
  const body = `${note('C', 240, 'eighth').repeat(7)}${note('D', 480, 'quarter')}${note('E', 240, 'eighth').repeat(7)}`;
  const warnings: string[] = [];
  const s = importMusicXml(xmlOf(body), { warn: (m) => warnings.push(m) });
  assert.equal(s.measures.length, 2);
  assert.equal(validate(s).length, 0);
  assert.ok(warnings.some((w) => /split into 2/.test(w)));
  const txt = writeText(s);
  assert.equal(writeText(parseText(txt)), txt);
});

test('a beam that starts after the leading rest of a tuplet nests the tuplet inside the beam', () => {
  const n = (step: string, beam: string, extra = '') =>
    `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>80</duration><voice>1</voice><type>16th</type>${extra}<beam number="1">${beam}</beam></note>`;
  const tm = '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>';
  const start = '<notations><tuplet type="start"/></notations>';
  const stop = '<notations><tuplet type="stop"/></notations>';
  const body = `<note><rest/><duration>80</duration><voice>1</voice><type>16th</type>${tm}${start}</note>${n('D', 'begin', tm)}${n('E', 'continue', tm + stop)}${n('F', 'continue').replace('<duration>80', '<duration>120')}${n('G', 'end').replace('<duration>80', '<duration>120')}<note><rest/><duration>1440</duration><voice>1</voice><type>half</type><dot/></note>`;
  const warnings: string[] = [];
  const s = importMusicXml(xmlOf(body), { warn: (m) => warnings.push(m) });
  assert.deepEqual(warnings, []);
  const items = s.measures[0].staves.s1.voices[0].items;
  assert.equal(items[0].kind, 'beam');
  assert.equal((items[0] as { items: { kind: string }[] }).items[0].kind, 'tuplet');
});
