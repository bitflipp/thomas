// Marks above and below the staves: dynamics, hairpins, pedal, octave shifts, tempo and text.
//
// Placed over the whole piece for one staff at a time: the marks are collected into `Item`s per
// system (spans such as hairpins are split at system breaks), then stacked in rows above and below
// the staff, each row clearing the skyline and the rows nearer the staff.
import type { Mark, MarkPlacement } from '../model.ts';
import { loadSmufl } from '../smufl.ts';
import { must } from '../util.ts';
import type { SysCtx } from './draw.ts';
import { D, geomOf, xAtTick } from './draw.ts';
import type { EvL, Prepared } from './prep.ts';
import type { Kind, Prim } from './scene.ts';
import { oid } from './scene.ts';
import { HEAD_SCALE, headWidth, STEM_T } from './spacing.ts';

const sm = loadSmufl();

type Side = 'above' | 'below';

/** One mark as laid out on a system: extent for stacking and a drawing function taking its reference y. */
interface Item {
  kind: 'dyn' | 'hair' | 'pedal' | 'ott' | 'tempo' | 'text';
  x0: number;
  x1: number;
  side: Side;
  /** Extent above / below the reference line. */
  up: number;
  down: number;
  draw: (ref: number) => Prim[];
  /** Moves a text-like item horizontally (set for tempo and text). */
  move?: (dx: number) => void;
  /** The model mark (the start mark of a span). */
  src?: Mark;
  /** Placed between the staves: its `side` is the one facing the neighbouring staff. */
  between?: boolean;
  /** Row and order within the stack on one side: lower rows are nearer the staff. */
  row: number;
  order: number;
}

/** Gap between a row of marks and what it clears. */
const ROW_CLEARANCE = 0.55;
/** The hairpin's centre sits this far above the dynamic baseline. */
const HAIRPIN_OFFSET = 0.55;

/** A span mark (hairpin, pedal, ottava) from its start mark to the matching stop, which may be in a later measure or system. */
interface Span {
  mark: Mark & { type: string };
  mi: number;
  end?: { mark: Mark; mi: number };
}

/** The pieces of a span within one system; `first`/`last` tell which ends are real (the others are open at a system break). */
interface Piece {
  si: number;
  x0: number;
  x1: number;
  first: boolean;
  last: boolean;
}

/** Where on the notes a span snaps to: its first piece starts at `start`, its last ends at `end`. */
type Snap = { start: 'stem' | 'headL'; end: 'stem' | 'headR' };

/** Everything the mark placement of one staff works on. */
interface StaffMarks {
  systems: SysCtx[];
  /** System index of each measure. */
  sysOf: number[];
  prep: Prepared;
  staff: number;
}

/** Glyphs of a dynamic like `mf`, its advance width, its extent above and below the baseline, and where its ink starts and ends (for centring on the notehead). */
function dynRun(text: string): { names: string[]; w: number; up: number; down: number; ink0: number; ink1: number } {
  const map: Record<string, string> = {
    p: 'dynamicPiano',
    m: 'dynamicMezzo',
    f: 'dynamicForte',
    r: 'dynamicRinforzando',
    s: 'dynamicSforzando',
    z: 'dynamicZ',
    n: 'dynamicNiente',
  };
  const names = text
    .split('')
    .map((c) => map[c])
    .filter(Boolean);
  let w = 0;
  let up = 0;
  let down = 0;
  let ink0 = 0;
  let ink1 = 0;
  names.forEach((n, i) => {
    const b = sm.bbox(n);
    if (i === 0) ink0 = b.x0;
    ink1 = w + b.x1;
    w += sm.adv(n);
    up = Math.max(up, b.y1);
    down = Math.max(down, -b.y0);
  });
  return { names, w, up, down, ink0, ink1 };
}

/** Centre of the notehead(s) sounding at `tick` (falls back to the column x plus half a head). */
function xHeadCentre(evs: EvL[], tick: number, x: number, other?: EvL[]): number {
  for (const list of other ? [evs, other] : [evs]) {
    const e = list.find((q) => q.ev.kind === 'note' && q.start === tick);
    const g = e && geomOf.get(e);
    if (g) return (g.headL + g.headR) / 2;
  }
  return x + 0.6;
}

/** The side of staff `s` that faces its neighbour: below, unless it is the last staff, and the staff there (none for a single staff). */
function facing(sm0: StaffMarks): { side: Side; neighbour?: number } {
  const n = sm0.systems[0].prep.score.staves.length;
  if (sm0.staff + 1 < n) return { side: 'below', neighbour: sm0.staff + 1 };
  return { side: 'above', neighbour: sm0.staff > 0 ? sm0.staff - 1 : undefined };
}

/** The side of a dynamic or hairpin; `between` goes to the side facing the neighbouring staff. */
function markSide(sm0: StaffMarks, p: MarkPlacement | undefined): Side {
  return p === 'between' ? facing(sm0).side : (p ?? 'below');
}

function dynamicItem(sm0: StaffMarks, mi: number, m: Mark & { type: 'dynamic' }): Item {
  const sys = sm0.systems[sm0.sysOf[mi]];
  const run = dynRun(m.text);
  const x = xAtTick(sys, mi, m.tick);
  const nb = m.placement === 'between' ? facing(sm0).neighbour : undefined;
  const centre = xHeadCentre(
    sm0.prep.measures[mi][sm0.staff].evs,
    m.tick,
    x,
    nb === undefined ? undefined : sm0.prep.measures[mi][nb].evs,
  );
  let left = centre - (run.ink0 + run.ink1) / 2; // origin so that the visible ink is centred on the notehead
  // Never straddle a barline: slide the run beside it, to the left, except for a dynamic at the
  // start of a measure, which stays in that measure.
  for (let k = sys.a; k <= sys.b; k++) {
    const barX = sys.mx[k] + sys.placed[k].endX;
    if (barX > left + run.ink0 - 0.2 && barX < left + run.ink1 + 0.2)
      left = m.tick === 0 && k === mi - 1 ? barX + 0.35 - run.ink0 : barX - 0.35 - run.ink1;
  }
  return {
    src: m,
    kind: 'dyn',
    x0: left + run.ink0,
    x1: left + run.ink1,
    side: markSide(sm0, m.placement),
    between: m.placement === 'between',
    up: run.up,
    down: run.down,
    row: 0,
    order: 0,
    draw: (ref) => {
      let px = left;
      return run.names.map((n) => {
        const p: Prim = { t: 'glyph', name: n, x: px, y: ref };
        px += sm.adv(n);
        return p;
      });
    },
  };
}

function tempoItem(m: Mark & { type: 'tempo' }, x0: number): Item {
  let x = x0;
  // Drawn exactly like a staff note: the same head glyph and scale, stem 3.5 long.
  const head = m.unit === 2 ? 'noteheadHalf' : 'noteheadBlack';
  const hw = headWidth(m.unit === 2 ? 2 : 4);
  const noteBox = { x1: hw };
  const label = `= ${m.bpm}`;
  const size = 2.5;
  const textWidth = label.length * size * 0.55;
  const dotsWidth = m.dots * 0.5;
  return {
    src: m,
    kind: 'tempo',
    move(dx) {
      x += dx;
      this.x0 += dx;
      this.x1 += dx;
    },
    x0: x,
    x1: x + noteBox.x1 + dotsWidth + 0.75 + textWidth,
    side: 'above',
    up: 3.7,
    down: 1.8,
    row: 0,
    order: 0,
    draw: (ref) => {
      const out: Prim[] = [
        { t: 'glyph', name: head, x, y: ref, sx: HEAD_SCALE, sy: 1 },
        { t: 'line', x1: x + hw - STEM_T / 2, y1: ref - 0.17, x2: x + hw - STEM_T / 2, y2: ref - 3.5, w: STEM_T },
      ];
      for (let k = 0; k < m.dots; k++)
        out.push({ t: 'glyph', name: 'augmentationDot', x: x + noteBox.x1 + 0.2 + k * 0.5, y: ref });
      out.push({ t: 'text', x: x + noteBox.x1 + dotsWidth + 0.75, y: ref + 0.5, s: label, size, bold: true });
      return out;
    },
  };
}

function textItem(sm0: StaffMarks, m: Mark & { type: 'text' }, x0: number): Item {
  let x = x0;
  const size = 2.0;
  return {
    src: m,
    kind: 'text',
    move(dx) {
      x += dx;
      this.x0 += dx;
      this.x1 += dx;
    },
    x0: x,
    x1: x + m.text.length * size * 0.5,
    side: markSide(sm0, m.placement ?? 'above'),
    between: m.placement === 'between',
    up: 1.5,
    down: 0.5,
    row: 0,
    order: 1,
    draw: (ref) => [{ t: 'text', x, y: ref, s: m.text, size, italic: true }],
  };
}

/** The spans of a staff, each start paired with its stop. */
interface Spans {
  hairpins: Span[];
  pedals: Span[];
  octaveShifts: Span[];
}

/**
 * Collects the marks of the staff in time order: dynamics, tempo and text become items at once, spans
 * are paired start to stop. Hairpins match by id, pedal and ottava by being the next stop of their
 * kind; a span without a stop runs to the end of the piece.
 */
function collectMarks(sm0: StaffMarks, items: Item[][]): Spans {
  const spans: Spans = { hairpins: [], pedals: [], octaveShifts: [] };
  const openHairpins = new Map<number, Span>();
  let openPedal: Span | null = null;
  let openOctave: Span | null = null;
  sm0.prep.measures.forEach((measure, mi) => {
    const si = sm0.sysOf[mi];
    for (const m of measure[sm0.staff].marks) {
      switch (m.type) {
        case 'dynamic':
          items[si].push(dynamicItem(sm0, mi, m));
          break;
        case 'tempo':
          items[si].push(tempoItem(m, xAtTick(sm0.systems[si], mi, m.tick)));
          break;
        case 'text':
          items[si].push(textItem(sm0, m, xAtTick(sm0.systems[si], mi, m.tick)));
          break;
        case 'hairpin': {
          const span: Span = { mark: m, mi };
          openHairpins.set(m.id, span);
          spans.hairpins.push(span);
          break;
        }
        case 'pedal':
          if (openPedal && !openPedal.end) openPedal.end = { mark: m, mi };
          openPedal = { mark: m, mi };
          spans.pedals.push(openPedal);
          break;
        case 'ottava':
          openOctave = { mark: m, mi };
          spans.octaveShifts.push(openOctave);
          break;
        case 'stop':
          if (m.of === 'hairpin') {
            const span = openHairpins.get(m.id);
            if (span) {
              span.end = { mark: m, mi };
              openHairpins.delete(m.id);
            }
          } else if (m.of === 'pedal') {
            if (openPedal) {
              openPedal.end = { mark: m, mi };
              openPedal = null;
            }
          } else if (openOctave) {
            openOctave.end = { mark: m, mi };
            openOctave = null;
          }
          break;
        default:
          break;
      }
    }
  });
  return spans;
}

/**
 * x of the stem (head centre if stemless) of the note starting at `tick` ('at') or of the last note
 * before it ('before'), in system coordinates.
 */
function noteX(
  sm0: StaffMarks,
  mi: number,
  tick: number,
  mode: 'at' | 'before',
  what: 'stem' | 'headL' | 'headR',
): number | undefined {
  const notesOf = (k: number) => sm0.prep.measures[k][sm0.staff].evs.filter((q) => q.ev.kind === 'note');
  let e: EvL | undefined;
  if (mode === 'at') e = notesOf(mi).find((q) => q.start === tick);
  else {
    e = notesOf(mi)
      .filter((q) => q.start < tick)
      .pop();
    if (!e && mi > 0 && sm0.sysOf[mi - 1] === sm0.sysOf[mi]) e = notesOf(mi - 1).pop();
  }
  const g = e && geomOf.get(e);
  if (!g) return undefined;
  if (what === 'headL') return g.headL;
  if (what === 'headR') return g.headR;
  return must(e).stem ? g.stemX : (g.headL + g.headR) / 2;
}

/**
 * A span as one piece per system it crosses. `startOff`/`endOff` move the ends from the note column;
 * with `snap` they snap to the first and last note instead.
 */
function spanPieces(sm0: StaffMarks, sp: Span, startOff: number, endOff: number, snap?: Snap): Piece[] {
  const { systems, sysOf, prep } = sm0;
  const lastMi = prep.measures.length - 1;
  const m0 = sp.mi;
  const t0 = sp.mark.tick;
  const m1 = sp.end ? sp.end.mi : lastMi;
  const t1 = sp.end ? (sp.end.mark as Mark).tick : prep.measureLen[lastMi];
  const out: Piece[] = [];
  const s0 = sysOf[m0];
  const s1 = sysOf[m1];
  for (let si = s0; si <= s1; si++) {
    const ctx = systems[si];
    const first = si === s0;
    const last = si === s1;
    const sx = snap && first ? noteX(sm0, m0, t0, 'at', snap.start) : undefined;
    const ex = snap && last && sp.end ? noteX(sm0, m1, t1, 'before', snap.end) : undefined;
    const x0 = first ? (sx ?? xAtTick(ctx, m0, t0) + startOff) : ctx.prefix;
    const x1 = last ? (ex ?? xAtTick(ctx, m1, t1) + endOff) : ctx.width - 0.3;
    if (x1 - x0 > 0.3) out.push({ si, x0, x1, first, last });
  }
  return out;
}

/**
 * Hairpins: two lines opening (cresc) or closing (dim) over the length. A piece that ends at a system
 * break stays half open there, so that the next piece continues at the same width. Every hairpin
 * starts at the notehead and ends at the stem, not at the plain x of the first and last note.
 */
function addHairpins(sm0: StaffMarks, spans: Span[], items: Item[][]): void {
  const wide = 1.15;
  const mid = wide * 0.55;
  const thickness = D.hairpinThickness as number;
  for (const sp of spans) {
    const m = sp.mark as Mark & { type: 'hairpin' };
    for (const p of spanPieces(sm0, sp, 0, -0.5, { start: 'headL', end: 'stem' })) {
      const o0 = m.kind === 'cresc' ? (p.first ? 0 : mid) : p.first ? wide : mid;
      const o1 = m.kind === 'cresc' ? (p.last ? wide : mid) : p.last ? 0 : mid;
      const extent = Math.max(o0, o1) / 2 + thickness;
      const item: Item = {
        src: sp.mark as Mark,
        kind: 'hair',
        x0: p.x0,
        x1: p.x1,
        side: markSide(sm0, m.placement),
        between: m.placement === 'between',
        up: extent,
        down: extent,
        row: 0,
        order: 0,
        // x0 and x1 are read when drawing: placement may shorten the hairpin next to a dynamic
        draw: (ref) => [
          { t: 'line', x1: item.x0, y1: ref - o0 / 2, x2: item.x1, y2: ref - o1 / 2, w: thickness },
          { t: 'line', x1: item.x0, y1: ref + o0 / 2, x2: item.x1, y2: ref + o1 / 2, w: thickness },
        ],
      };
      items[p.si].push(item);
    }
  }
}

/** Pedal: `Ped.` at the press and a line to the release (a hook up at a real end). A continuation on a later system starts with `(Ped.)`. */
function addPedals(sm0: StaffMarks, spans: Span[], items: Item[][]): void {
  const pedBox = sm.bbox('keyboardPedalPed');
  const pedWidth = sm.adv('keyboardPedalPed');
  const thickness = D.pedalLineThickness as number;
  for (const sp of spans)
    for (const p of spanPieces(sm0, sp, -0.2, -0.5))
      items[p.si].push({
        src: sp.mark as Mark,
        kind: 'pedal',
        x0: p.x0,
        x1: p.x1,
        side: 'below',
        up: pedBox.y1,
        down: -pedBox.y0,
        row: 1,
        order: 0,
        draw: (ref) => {
          const out: Prim[] = [];
          let lineX = p.x0;
          if (p.first) {
            out.push({ t: 'glyph', name: 'keyboardPedalPed', x: p.x0, y: ref });
            lineX = p.x0 + pedWidth + 0.3;
          } else if (p.x1 - p.x0 > pedWidth + 2) {
            // continuation of a pedal from the previous system: "(Ped.)"
            const leftParen = sm.adv('keyboardPedalParensLeft');
            out.push({ t: 'glyph', name: 'keyboardPedalParensLeft', x: p.x0, y: ref });
            out.push({ t: 'glyph', name: 'keyboardPedalPed', x: p.x0 + leftParen, y: ref });
            out.push({ t: 'glyph', name: 'keyboardPedalParensRight', x: p.x0 + leftParen + pedWidth, y: ref });
            lineX = p.x0 + leftParen + pedWidth + sm.adv('keyboardPedalParensRight') + 0.3;
          }
          const lineY = ref - 0.25;
          if (p.x1 - lineX > 0.2) out.push({ t: 'line', x1: lineX, y1: lineY, x2: p.x1, y2: lineY, w: thickness });
          if (p.last && sp.end) out.push({ t: 'line', x1: p.x1, y1: lineY, x2: p.x1, y2: lineY - 0.9, w: thickness });
          return out;
        },
      });
}

/** Octave shifts: the `8va`/`8vb` label at the start, a dashed line, and at a real end a hook pointing towards the staff. A continuation on a later system has the line only. */
function addOctaveShifts(sm0: StaffMarks, spans: Span[], items: Item[][]): void {
  for (const sp of spans) {
    const m = sp.mark as Mark & { type: 'ottava' };
    const above = m.dir === 'up';
    const glyph = above ? 'ottavaAlta' : 'ottavaBassa';
    const box = sm.bbox(glyph);
    const glyphWidth = sm.adv(glyph);
    for (const p of spanPieces(sm0, sp, -0.2, 0.7))
      items[p.si].push({
        src: m,
        kind: 'ott',
        x0: p.x0,
        x1: p.x1,
        side: above ? 'above' : 'below',
        up: Math.max(box.y1, 0.8),
        down: Math.max(-box.y0, 0.8),
        row: 0,
        order: -1,
        draw: (ref) => {
          const out: Prim[] = [];
          let lineX = p.x0;
          if (p.first) {
            out.push({ t: 'glyph', name: glyph, x: p.x0, y: ref });
            lineX = p.x0 + glyphWidth + 0.3;
          }
          const thickness = D.octaveLineThickness as number;
          const lineY = ref - (box.y1 + box.y0) / 2;
          out.push({ t: 'line', x1: lineX, y1: lineY, x2: p.x1, y2: lineY, w: thickness, dash: [0.5, 0.35] });
          if (p.last && sp.end)
            out.push({ t: 'line', x1: p.x1, y1: lineY, x2: p.x1, y2: lineY + (above ? 0.9 : -0.9), w: thickness });
          return out;
        },
      });
  }
}

/** A hairpin stops short of a dynamic that follows it and starts after one that precedes it, leaving 0.3 spaces; the dynamic itself never moves. */
function keepHairpinsOffDynamics(its: Item[]): void {
  for (const hp of its.filter((i) => i.kind === 'hair')) {
    for (const d of its.filter((i) => i.kind === 'dyn' && i.side === hp.side)) {
      if (d.x0 < hp.x1 + 0.3 && d.x1 > hp.x1 - 1.0 && d.x0 > hp.x0) hp.x1 = Math.min(hp.x1, d.x0 - 0.3);
      else if (d.x1 > hp.x0 - 0.3 && d.x0 < hp.x0 + 1.0 && d.x1 < hp.x1) hp.x0 = Math.max(hp.x0, d.x1 + 0.3);
    }
  }
}

const TEXT_PAD = 0.6;

/** Text and tempo marks that would sit over a dynamic (or each other) on the same side slide right of it, leaving some padding. */
function spreadHorizontally(list: Item[]): void {
  const movers = list.filter((i) => i.move).sort((a, b) => a.x0 - b.x0);
  const fixed = list.filter((i) => i.kind === 'dyn');
  const placed: Item[] = [];
  for (const it of movers) {
    for (const o of [...fixed, ...placed].sort((a, b) => a.x0 - b.x0)) {
      if (o.x0 < it.x1 + TEXT_PAD && o.x1 + TEXT_PAD > it.x0 && o.x0 <= it.x1 && o.x1 >= it.x0 - TEXT_PAD)
        it.move?.(o.x1 + TEXT_PAD - it.x0);
    }
    placed.push(it);
  }
}

/**
 * Groups items of one side that share a baseline: all dynamics and hairpins over the whole system, so
 * that a row of them reads as a line, and all pedal lines; every other item (and pedal and ottava rows
 * go outside the dynamics) is a group of its own.
 */
function baselineGroups(list: Item[]): Item[][] {
  const groups: Item[][] = [];
  const shared = new Map<'dyn' | 'pedal', Item[]>();
  for (const it of list) {
    const key =
      it.kind === 'dyn' || it.kind === 'hair' || (it.kind === 'text' && it.between)
        ? 'dyn'
        : it.kind === 'pedal'
          ? 'pedal'
          : undefined;
    if (!key) {
      groups.push([it]);
      continue;
    }
    let group = shared.get(key);
    if (!group) {
      group = [];
      shared.set(key, group);
      groups.push(group);
    }
    group.push(it);
  }
  return groups;
}

/** Owner tags of mark pieces by (mark, first measure of the system), so that drawing a mark again tags its primitives the same. */
const pieceOwners = new WeakMap<object, Map<number, number>>();
function pieceOwner(src: Mark, systemStart: number): number {
  let m = pieceOwners.get(src);
  if (!m) {
    m = new Map();
    pieceOwners.set(src, m);
  }
  let o = m.get(systemStart);
  if (o === undefined) {
    o = oid({});
    m.set(systemStart, o);
  }
  return o;
}

/** Puts one group on a common baseline just clear of the skyline and draws it. */
function placeGroup(ctx: SysCtx, s: number, group: Item[], side: Side): void {
  const sky = ctx.sky[s];
  let ref = side === 'below' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  for (const it of group) {
    if (side === 'below') {
      const hairOffset = it.kind === 'hair' ? HAIRPIN_OFFSET : 0;
      ref = Math.max(ref, sky.bottom(it.x0, it.x1, 4) + ROW_CLEARANCE + it.up + hairOffset);
    } else {
      // a dynamic stays close to the notes, under any slur arching over them
      ref = Math.min(ref, sky.top(it.x0, it.x1, 0, it.kind === 'dyn') - ROW_CLEARANCE - it.down);
    }
  }
  for (const it of group) {
    const y = it.kind === 'hair' ? ref - HAIRPIN_OFFSET : ref;
    const kind: Kind = it.kind === 'hair' ? 'hairpin' : it.kind === 'ott' ? 'ottava' : it.kind;
    const owner = it.src ? pieceOwner(it.src, ctx.a) : oid(it);
    for (const p of it.draw(y)) {
      p.k = kind;
      p.o = owner;
      p.r = it.src;
      if (it.kind === 'dyn' || it.kind === 'hair' || it.between) p.a = ref;
      ctx.prims[s].push(p);
    }
    sky.add(it.x0, it.x1, y - it.up, y + it.down);
    const box = sky.boxes[sky.boxes.length - 1];
    if (it.between) box.btw = true;
    if (it.kind === 'dyn' || it.kind === 'hair' || it.between) box.o = owner;
  }
}

/** Stacks the items of one system on each side of staff `s`: first dynamics and hairpins are made not to touch, then the rows are placed. */
function stackItems(ctx: SysCtx, s: number, items: Item[]): void {
  keepHairpinsOffDynamics(items);
  for (const side of ['above', 'below'] as const) {
    const list = items.filter((i) => i.side === side).sort((a, b) => a.row - b.row || a.order - b.order || a.x0 - b.x0);
    spreadHorizontally(list);
    for (const group of baselineGroups(list)) placeGroup(ctx, s, group, side);
  }
}

/**
 * Places all marks of staff `s` over the whole piece: collects them, splits spans into per-system
 * pieces, then stacks them in rows above/below the staff. Dynamics and hairpins of one side share a
 * baseline over the system; pedal and ottava lines get their own rows.
 */
export function drawMarks(systems: SysCtx[], sysOf: number[], s: number): void {
  const sm0: StaffMarks = { systems, sysOf, prep: systems[0].prep, staff: s };
  const items: Item[][] = systems.map(() => []);
  const spans = collectMarks(sm0, items);
  addHairpins(sm0, spans.hairpins, items);
  addPedals(sm0, spans.pedals, items);
  addOctaveShifts(sm0, spans.octaveShifts, items);
  systems.forEach((ctx, si) => {
    stackItems(ctx, s, items[si]);
  });
}
