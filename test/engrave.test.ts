// Engraver tests: they assert on the emitted primitives and on collisions, not on pixels.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe, findCollisions } from '../src/engrave/collide.ts';
import { prepare } from '../src/engrave/prep.ts';
import type { Prim } from '../src/engrave/scene.ts';
import { headWidth } from '../src/engrave/spacing.ts';
import { engrave } from '../src/engrave/system.ts';
import { flattenVoice, PPQ, validate } from '../src/model.ts';
import { pageToSvg } from '../src/render.ts';
import { loadSmufl } from '../src/smufl.ts';
import { parseText, writeText } from '../src/textformat.ts';
import { must } from '../src/util.ts';

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
  assert.equal(flat[0].ticks, ((PPQ / 4) * 4) / 6);
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
  // Key of D major: f# is in the key signature and needs no accidental; an f natural needs a
  // natural sign; and a repeated f natural in the same measure needs none again.
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

const ledgers = (ps: ReturnType<typeof prims>) =>
  ps.filter((p) => p.t === 'line' && p.y1 === p.y2 && p.w === 0.16 && p.x2 - p.x1 < 3);

test('identical primes (same pitch and duration) in two voices share one notehead', () => {
  const ps = prims(`${HEAD}
m1 time=2/4
  rh.1: c5:4 d5:4
  rh.2: c5:4 c5:4
  lh.1: R:2
`);
  // Two voices play c5 together: the unison shares one head, so with d5 and the second c5
  // there are 3 heads, not 4.
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
  const none = ledgers(
    prims(`${HEAD}
m1 time=2/4
  rh.1: d4:4 g5:4
  lh.1: R:2
`),
  ); // The note d4 is in the space below the staff and g5 in the space above, so there are no ledger lines.
  assert.equal(none.length, 0);
  const one = ledgers(
    prims(`${HEAD}
m1 time=2/4
  rh.1: c4:4 a5:4
  lh.1: R:2
`),
  ); // The note c4 is on the first line below and a5 on the first line above.
  assert.equal(one.length, 2);
  const two = ledgers(
    prims(`${HEAD}
m1 time=2/4
  rh.1: b3:4 e6:4
  lh.1: R:2
`),
  ); // The note b3 needs the c4 line, and e6 needs a5, c6 and e6.
  assert.equal(two.length, 4);
});

test('a ledger line does not extend over a chord head that stands in the space before it', () => {
  const ps = prims(`${HEAD}
m1 time=2/4
  rh.1: <e5 g5 a5>:4 r:4
  lh.1: R:2
`);
  const line = ps.find((p) => p.k === 'ledger');
  const heads = ps.filter((p) => p.t === 'glyph' && /^notehead/.test(p.name));
  // The line serves a5 only, so it starts right of the g5 head (the second one), which sits in the space under it.
  assert.ok(line?.t === 'line' && heads[1].t === 'glyph' && line.x1 > heads[1].x + 0.5);
});

test('a symmetric slur still clears the tuplet numbers under it', () => {
  const t = `${HEAD}
m1 time=4/4
  rh.1: (^3:2{c5:8 e5 g5} 3:2{a4 g4 e4} 3:2{c5:8 e5 g5} 3:2{a4 g4 e4})
  lh.1: R:1
`;
  const hits = findCollisions(engrave(parseText(t)).pages);
  assert.deepEqual(
    hits.filter((c) => c.a.k === 'slur' || c.b.k === 'slur'),
    [],
  );
});

test('unisons with different durations share a head when stems are opposite and the head shape is equal', () => {
  const ps = prims(`${HEAD}
m1 time=2/4
  rh.1: c5:4. r:8
  rh.2: c5:16 e4 e4:8 r:4
  lh.1: R:2
`);
  // A dotted quarter c5 (stem up) and a 16th c5 (stem down) share a head, with two e4 heads
  // that makes 3 heads, and only one dot: the shared head is not given a second, lesser dot.
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
  // The g of voice 2 (stem down) is a step above the f of voice 1 (stem up), so their heads clash
  // and voice 2 is shifted right by one head width. The up-stem of the f runs on the right of its
  // head, so after the shift both stems stand at (almost) the same x.
  assert.ok(Math.abs(vlines[0].x1 - vlines[1].x1) < 0.2, `stems at ${vlines.map((l) => l.x1)}`);
  const xs = heads.map((h) => h.x).sort((a, b) => a - b);
  assert.ok(Math.abs(xs[1] - xs[0] - headWidth(4)) < 0.01);
});

test('measure numbers: shown at the start of every system but the first', () => {
  const body = Array.from(
    { length: 30 },
    (_, i) => `m${i + 1}${i === 0 ? ' time=2/4' : ''}\n  rh.1: c5:8 d5 e5 f5\n  lh.1: R:2`,
  ).join('\n');
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

test('a time change at the start of a system is printed there and announced at the end of the one before', () => {
  const s = parseText(`${HEAD}
m1 time=2/4
  rh.1: R:2
  lh.1: R:2
m2 time=3/4 break=system
  rh.1: R:2.
  lh.1: R:2.
`);
  const res = engrave(s);
  const threes = res.pages[0].prims.filter((p) => p.t === 'glyph' && p.name === 'timeSig3' && p.k === 'timesig');
  // One per staff at the start of the second system, and one per staff as a courtesy at the end of the first.
  assert.equal(threes.length, 4);
  const [first, second] = res.layout.systems;
  const xs = threes.map((p) => (p.t === 'glyph' ? p.x : 0));
  assert.equal(xs.filter((x) => x > first.x1 - 3 && x < first.x1).length, 2);
  assert.equal(xs.filter((x) => x < second.x0 + 8).length, 2);
  assert.deepEqual(findCollisions(res.pages), []);
});

test('a tie inside the staff stops short of a time change it crosses and goes on after it', () => {
  const s = parseText(`${HEAD}
m1 time=2/4
  rh.1: r:4 c5:4~
  lh.1: R:2
m2 time=3/4
  rh.1: c5:2.
  lh.1: R:2.
`);
  const res = engrave(s);
  const ties = res.pages[0].prims.filter((p) => p.k === 'tie');
  assert.equal(ties.length, 2);
  assert.deepEqual(findCollisions(res.pages), []);
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
  assert.deepEqual(
    evs.slice(0, 6).map((e) => e.staff),
    [1, 1, 1, 0, 0, 0],
  );
  assert.ok(evs.every((e) => e.home === 1));
  assert.ok(evs[0].beam!.cross);
  assert.deepEqual(
    evs.slice(0, 6).map((e) => e.stem),
    ['up', 'up', 'up', 'down', 'down', 'down'],
  );
  assert.equal(p.measures[0][0].evs.filter((e) => e.ev.kind === 'note').length, 3); // The rh column holds the arrivals.
  const prims = engrave(s).pages[0].prims;
  const beams = prims.filter((q) => q.k === 'beam');
  assert.ok(beams.length > 0);
  const stems = prims.filter((q) => q.k === 'stem') as { y1: number; y2: number; x1: number }[];
  assert.equal(stems.length, 6);
  // All stems end on the same flat beam (a cross-staff beam): the stems of the notes below it
  // and of the notes above it meet it at one y, which the rounded tip positions show.
  const tips = new Set(stems.map((q) => Math.round(q.y2 * 100)));
  assert.ok(tips.size <= 2, `tips ${[...tips]}`);
  assert.deepEqual(findCollisions(engrave(s).pages).map(describe), []);
});

test('a measure too dense for one line is squeezed to fit instead of overflowing', () => {
  const notes = Array.from({ length: 32 }, (_x, i) => `${'cdefgab'[i % 7]}4${i === 0 ? ':32' : ''}`).join(' ');
  const s = parseText(`${HEAD}
m1 time=4/4
  rh.1: ${notes}
  lh.1: R:1
`);
  const warnings: string[] = [];
  const res = engrave(s, { warn: (m) => warnings.push(m) });
  assert.deepEqual(warnings, []);
  assert.equal(res.pages[0].prims.length > 0, true);
});

test('a dynamic placed between the staves is centered in the gap, from either staff', () => {
  const body = (rh: string, lh: string) => `${HEAD}
m1 time=4/4 key=0
  rh.1: ${rh}
  lh.1: ${lh}
`;
  for (const src of [body('\\f= c5:1', 'c3:1'), body('c5:1', '\\f= c3:1')]) {
    const score = parseText(src);
    assert.deepEqual(parseText(writeText(score)), score);
    const prims = engrave(score).pages[0].prims;
    const lines = prims.filter((p) => p.k === 'staff' && p.t === 'line').map((p) => (p as { y1: number }).y1);
    const dyn = prims.find((p) => p.k === 'dyn');
    assert.ok(dyn && dyn.t === 'glyph');
    const box = loadSmufl().bbox(dyn.name);
    const center = dyn.y - (box.y1 + box.y0) / 2;
    assert.ok(
      Math.abs(center - (lines[4] + lines[5]) / 2) < 0.05,
      `ink center ${center} vs gap ${lines[4]}..${lines[5]}`,
    );
  }
});

test('ghost rests: hidden rests are drawn as selectable ghosts only on request, and change nothing else', () => {
  const s = parseText(`${HEAD}
m1 time=4/4 key=0
  rh.1: c5:8 d5 e5 f5 g5:2
  rh.2: s:4 e4:4 s:2
  lh.1: R:1
`);
  const plain = engrave(s);
  const ghosted = engrave(s, { ghostRests: true });
  assert.equal(plain.pages[0].prims.filter((p) => p.ghost).length, 0);
  const ghosts = ghosted.pages[0].prims.filter((p) => p.ghost);
  assert.equal(ghosts.length, 2);
  assert.ok(ghosts.every((p) => p.k === 'rest' && p.r));
  // Owner ids count up over runs, so they differ between any two engravings.
  const bare = (ps: Prim[]) => ps.map(({ o: _o, g: _g, ...p }) => p);
  assert.deepEqual(bare(ghosted.pages[0].prims.filter((p) => !p.ghost)), bare(plain.pages[0].prims));
  assert.ok(!pageToSvg(ghosted.pages[0], ghosted.staffSpace).includes('restQuarter'));
  assert.ok(pageToSvg(ghosted.pages[0], ghosted.staffSpace, { ghosts: true }).includes('restQuarter'));
});

test('a rest moves to its voice row only while another voice shows something, not over hidden rests', () => {
  const s = parseText(`${HEAD}
m1 time=4/4 key=0
  rh.1: r:4 c5:4 r:2
  rh.2: e4:4 s:4 s:2
  lh.1: R:1
`);
  const prims = engrave(s).pages[0].prims;
  const glyph = (name: string) => must(prims.find((p) => p.t === 'glyph' && p.name === name));
  const quarter = glyph('restQuarter');
  const half = glyph('restHalf');
  assert.ok(quarter.t === 'glyph' && half.t === 'glyph');
  // The quarter rest is above the note of voice 2; the half rest is over hidden rests only, so it stays centered.
  // Both on voice rows they would be 3 spaces apart; with the half rest centered, 1.5.
  assert.equal(half.y - quarter.y, 1.5);
});

test('a whole-measure rest is centered between the key change that opens the bar and the barline', () => {
  const s = parseText(`${HEAD}
m1 time=4/4 key=0
  rh.1: c5:1
  lh.1: c3:1
m2 key=3
  rh.1: R:1
  lh.1: c3:1
m3
  rh.1: c5:1
  lh.1: c3:1
`);
  const prims = engrave(s).pages[0].prims;
  const rest = must(prims.find((p) => p.t === 'glyph' && p.name === 'restWhole'));
  const sharps = prims.filter((p) => p.t === 'glyph' && p.name === 'accidentalSharp' && p.x > 0);
  const bars = prims.filter((p) => p.k === 'barline' && p.t === 'line').map((p) => (p.t === 'line' ? p.x1 : 0));
  assert.ok(rest.t === 'glyph');
  // The key change in front of m2 is the last run of sharps before the rest; the bar ends at the next barline.
  const keyEnd = Math.max(
    ...sharps
      .filter((p) => p.t === 'glyph' && p.x < rest.x)
      .map((p) => (p.t === 'glyph' ? p.x + loadSmufl().adv(p.name) : 0)),
  );
  const barEnd = Math.min(...bars.filter((x) => x > rest.x));
  const center = rest.x + loadSmufl().adv('restWhole') / 2;
  // The key change is a little wider than its glyphs, the barline a little thicker than a point: allow for both.
  assert.ok(Math.abs(center - (keyEnd + barEnd) / 2) < 0.4, `rest at ${center}, bar from ${keyEnd} to ${barEnd}`);
});

test('ghost rests of a voice with only hidden rests sit on that voice side, clear of the other voice', () => {
  const s = parseText(`${HEAD}
m1 time=4/4 key=0
  rh.1: c4:4 d4 e4 f4
  rh.2: s:4 s s s
  lh.1: R:1
`);
  const prims = engrave(s, { ghostRests: true }).pages[0].prims;
  const heads = prims.filter((p) => p.t === 'glyph' && p.k === 'head');
  const ghosts = prims.filter((p) => p.ghost);
  assert.equal(ghosts.length, 4);
  // Voice 2 goes below: every ghost is lower on the page than every head of voice 1.
  const lowestHead = Math.max(...heads.map((p) => (p.t === 'glyph' ? p.y : 0)));
  assert.ok(ghosts.every((p) => p.t === 'glyph' && p.y > lowestHead));
});

test('an ottava stop at a note ends the line before it, so the note is written at pitch', () => {
  const s = parseText(`${HEAD}
m1 time=2/4 key=0
  rh.1: c5:8 \\8va e6 g6 \\8off f6
`);
  const evs = prepare(s).measures[0][0].evs;
  assert.deepEqual(
    evs.map((e) => e.ottavaShift),
    [0, -1, -1, 0],
  );
});
