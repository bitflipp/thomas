import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseText, writeText } from '../src/textformat.ts';
import { validate, flattenVoice, PPQ } from '../src/model.ts';
import { prepare } from '../src/engrave/prep.ts';
import { engrave } from '../src/engrave/system.ts';
import { HEAD_SCALE } from '../src/engrave/spacing.ts';
import { pageToSvg } from '../src/render.ts';
import { findCollisions, describe } from '../src/engrave/collide.ts';

const HEAD = `title "T"
page 210x297 margin=10 space=1.91
staff rh clef=G2
staff lh clef=F4
brace rh lh
`;

test('durations: tuplets, dots and sticky durations', () => {
  const s = parseText(`${HEAD}
m1 time=2/4 key=0
  rh.1: 6:4{ c5:16 d5 e5 f5 g5 a5 } r:8. e5:16
  lh.1: R:2
`);
  assert.deepEqual(validate(s), []);
  const flat = flattenVoice(s.measures[0].staves.rh.voices[0]);
  assert.equal(flat[0].ticks, (PPQ / 4) * 4 / 6);
  assert.equal(flat.length, 8);
});

test('validation catches wrong measure length', () => {
  const s = parseText(`${HEAD}
m1 time=2/4
  rh.1: c5:4 d5:4 e5:4
`);
  assert.ok(validate(s).some((e) => e.includes('too long')));
});

test('accidentals follow key signature and measure state', () => {
  const s = parseText(`${HEAD}
m1 time=4/4 key=2
  rh.1: f#5:4 f5:4 f5:4 f#5:4
`);
  const p = prepare(s);
  const heads = p.measures[0][0].evs.map((e) => e.heads[0].acc?.glyph);
  // key of D major: f# is in the key signature; f natural needs a natural sign; repeat needs none
  assert.deepEqual(heads, [undefined, 'accidentalNatural', undefined, 'accidentalSharp']);
});

test('auto beaming groups by beat, explicit groups override', () => {
  const s = parseText(`${HEAD}
m1 time=2/4
  rh.1: c5:8 d5 e5 f5
  lh.1: [ c3:8 d3 ] [ e3 f3 ]
`);
  const p = prepare(s);
  const rh = p.measures[0][0].evs;
  assert.equal(rh[0].beam, rh[1].beam);
  assert.notEqual(rh[1].beam, rh[2].beam);
  assert.equal(rh[2].beam, rh[3].beam);
});

test('stems: single voice follows pitch, two voices split', () => {
  const s = parseText(`${HEAD}
m1 time=2/4
  rh.1: c6:4 c4
  rh.2: e4:2
`);
  const p = prepare(s);
  const evs = p.measures[0][0].voices;
  assert.equal(evs[0].evs[0].stem, 'up');
  assert.equal(evs[1].evs[0].stem, 'down');
});

test('engraving produces valid-looking SVG pages', () => {
  const s = parseText(`${HEAD}
m1 time=2/4
  rh.1: \\p ( c5:8 d5 e5 f5 ) \\<
  lh.1: \\ped c3:4 d3 \\unped
m2
  rh.1: \\! <c5 e5 g5>:2->
  lh.1: \\8vb c2:2
`);
  const res = engrave(s);
  assert.equal(res.pages.length, 1);
  const svg = pageToSvg(res.pages[0], res.staffSpace);
  assert.match(svg, /^<\?xml/);
  assert.ok(svg.includes('</svg>'));
  assert.ok(!svg.includes('NaN'));
});

test('text writer output re-parses to the same text', () => {
  const s = parseText(`${HEAD}
m1 time=2/4
  rh.1: ( c5:8 d5 e5 f5 )
  lh.1: c3:2~
m2
  rh.1: R:2
  lh.1: c3:4 \\clef G2 d4
`);
  const t = writeText(s);
  assert.equal(writeText(parseText(t)), t);
});

const prims = (src: string) => engrave(parseText(src)).pages[0].prims;
const ledgers = (ps: ReturnType<typeof prims>) => ps.filter((p) => p.t === 'line' && p.y1 === p.y2 && p.w === 0.16 && p.x2 - p.x1 < 3);

test('identical primes (same pitch and duration) in two voices share one notehead', () => {
  const ps = prims(`${HEAD}
m1 time=2/4
  rh.1: c5:4 d5:4
  rh.2: c5:4 c5:4
  lh.1: R:2
`);
  // c5 shared, d5, second c5 -> 3 heads, not 4
  assert.equal(ps.filter((p) => p.t === 'glyph' && p.name === 'noteheadBlack').length, 3);
});

test('primes of different duration keep separate heads', () => {
  const ps = prims(`${HEAD}
m1 time=2/4
  rh.1: c5:4 d5:4
  rh.2: c5:2
  lh.1: R:2
`);
  assert.equal(ps.filter((p) => p.t === 'glyph' && /^notehead/.test(p.name)).length, 3);
});

test('ledger lines only where a head sits on or beyond them', () => {
  const none = ledgers(prims(`${HEAD}
m1 time=2/4
  rh.1: d4:4 g5:4
  lh.1: R:2
`)); // d4 = space below the staff, g5 = space above: no ledger lines
  assert.equal(none.length, 0);
  const one = ledgers(prims(`${HEAD}
m1 time=2/4
  rh.1: c4:4 a5:4
  lh.1: R:2
`)); // c4 on the first line below, a5 on the first line above
  assert.equal(one.length, 2);
  const two = ledgers(prims(`${HEAD}
m1 time=2/4
  rh.1: b3:4 e6:4
  lh.1: R:2
`)); // b3 needs the c4 line; e6 needs a5, c6, e6
  assert.equal(two.length, 4);
});

test('unisons with different durations share a head when stems are opposite and the head shape is equal', () => {
  const ps = prims(`${HEAD}
m1 time=2/4
  rh.1: c5:4. r:8
  rh.2: c5:16 e4 e4:8 r:4
  lh.1: R:2
`);
  // dotted quarter c5 (stem up) and 16th c5 (stem down): one head; plus two e4 heads
  assert.equal(ps.filter((p) => p.t === 'glyph' && p.name === 'noteheadBlack').length, 3);
  assert.equal(ps.filter((p) => p.t === 'glyph' && p.name === 'augmentationDot').length, 1);
});

test('unison of a half note and a quarter note keeps two heads (different head shape)', () => {
  const ps = prims(`${HEAD}
m1 time=2/4
  rh.1: c5:4 r:4
  rh.2: c5:2
  lh.1: R:2
`);
  assert.equal(ps.filter((p) => p.t === 'glyph' && /^notehead/.test(p.name)).length, 2);
});

test('a voice shifted aside keeps its stem attached to its (shifted) head', () => {
  const ps = prims(`${HEAD}
m1 time=2/4
  rh.1: f4:4 r:4
  rh.2: g4:4 r:4
  lh.1: R:2
`);
  const heads = ps.filter((p) => p.t === 'glyph' && p.name === 'noteheadBlack') as { x: number; y: number }[];
  assert.equal(heads.length, 2);
  const vlines = ps.filter((p) => p.t === 'line' && p.x1 === p.x2 && p.w === 0.12) as { x1: number }[];
  assert.equal(vlines.length, 2);
  // g (voice 2, stem down) is shifted right by one head width; both stems end up on (almost) the same x
  assert.ok(Math.abs(vlines[0].x1 - vlines[1].x1) < 0.2, `stems at ${vlines.map((l) => l.x1)}`);
  const xs = heads.map((h) => h.x).sort((a, b) => a - b);
  assert.ok(Math.abs(xs[1] - xs[0] - 1.18 * HEAD_SCALE) < 0.01);
});

test('measure numbers: shown at the start of every system but the first', () => {
  const body = Array.from({ length: 30 }, (_, i) => `m${i + 1}${i === 0 ? ' time=2/4' : ''}\n  rh.1: c5:8 d5 e5 f5\n  lh.1: R:2`).join('\n');
  const res = engrave(parseText(`${HEAD}\n${body}\n`));
  const nums = res.pages.flatMap((p) => p.prims.filter((x) => x.t === 'text' && x.italic && /^\d+$/.test(x.s)));
  assert.ok(res.systems > 1);
  assert.equal(nums.length, res.systems - 1);
  assert.ok(!nums.some((n) => n.t === 'text' && n.s === '1'));
});

test('a pedal carried over a system break restarts with "(Ped.)"', () => {
  const s = parseText(`${HEAD}
m1 time=2/4
  rh.1: R:2
  lh.1: \\ped c3:4 d3
m2 break=system
  rh.1: R:2
  lh.1: e3:4 f3 \\unped
`);
  const ps = engrave(s).pages[0].prims;
  assert.ok(ps.some((p) => p.t === 'glyph' && p.name === 'keyboardPedalParensLeft'));
});

test('cross-staff beam: stems point at a beam between the staves, which keep a gap that fits it', () => {
  const s = parseText(`${HEAD}
m1 time=2/4
  lh.1: [ c3:16 e3 g3 \\staff rh c5 e5 g5 ]  \\staff lh r:8
  rh.1: R:2
`);
  assert.deepEqual(validate(s), []);
  const p = prepare(s);
  const evs = p.measures[0][1].voices[0].evs;
  assert.deepEqual(evs.slice(0, 6).map((e) => e.staff), [1, 1, 1, 0, 0, 0]);
  assert.ok(evs.every((e) => e.home === 1));
  assert.ok(evs[0].beam!.cross);
  assert.deepEqual(evs.slice(0, 6).map((e) => e.stem), ['up', 'up', 'up', 'down', 'down', 'down']);
  assert.equal(p.measures[0][0].evs.filter((e) => e.ev.kind === 'note').length, 3); // the rh column holds the arrivals
  const prims = engrave(s).pages[0].prims;
  const beams = prims.filter((q) => q.k === 'beam');
  assert.ok(beams.length > 0);
  const stems = prims.filter((q) => q.k === 'stem') as { y1: number; y2: number; x1: number }[];
  assert.equal(stems.length, 6);
  // all stems end on the same flat beam: the longest stem of a note below it and of a note above it meet at one y
  const tips = new Set(stems.map((q) => Math.round(q.y2 * 100)));
  assert.ok(tips.size <= 2, `tips ${[...tips]}`);
  assert.deepEqual(findCollisions(engrave(s).pages).map(describe), []);
});
