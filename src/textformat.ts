// Human-readable text format <-> Score. See FORMAT.md for the grammar.
//
// Writer and parser are exact inverses: write(parse(text)) == text for text the writer produced, and
// parse(write(score)) deep-equals the score (test/roundtrip.test.ts). Any new model field therefore
// needs a writer branch, a parser branch and an importer change together. The writer can additionally
// record where each event, mark, tuplet and measure landed in the output (`writeTextMap`), which the
// editor's text pane uses to show the score selection in the text.

import { refKey } from './editor/addr.ts';

import type {
  BaseDur,
  BeamGroup,
  Clef,
  Dur,
  Event,
  Grace,
  Item,
  LineStart,
  LineStop,
  MarkBody,
  MarkPlacement,
  Measure,
  NoteEvent,
  NotePitch,
  Ornament,
  Pitch,
  RestEvent,
  Score,
  StaffMeasure,
  Syllable,
  TimedMark,
  TremoloGroup,
  TupletGroup,
} from './model.ts';

import { anchorMarks, isBeam, isTremolo, isTuplet, PPQ } from './model.ts';
import { must } from './util.ts';

const DYNAMICS = new Set([
  'pppp',
  'ppp',
  'pp',
  'p',
  'mp',
  'mf',
  'f',
  'ff',
  'fff',
  'ffff',
  'sf',
  'sfz',
  'sfp',
  'sfpp',
  'fp',
  'fz',
  'rf',
  'rfz',
  'pf',
  'n',
  'z',
]);

// Writing: `write` turns a Score into text. It must stay the exact inverse of `parse` below (the
// round-trip test checks both directions), so every model field is written here and read there.

/** Parses a position in quarter notes, an integer or a fraction like `3/2`; it must land on a whole tick. */
function fracParse(s: string): number {
  const [n, d] = s.split('/');
  const t = (Number(n) * PPQ) / Number(d ?? 1);
  if (!Number.isInteger(t)) throw new Error(`bad position ${s}`);
  return t;
}

/** Writes a pitch: step, `#` or `b` per semitone, octave (`c#4`). */
function pitchStr(p: Pitch): string {
  const acc = p.alter > 0 ? '#'.repeat(p.alter) : 'b'.repeat(-p.alter);
  return `${p.step}${acc}${p.octave}`;
}

/** Writes a clef: sign, line and an optional octave shift (`G2`, `G2_8`). */
function clefStr(c: Clef): string {
  return `${c.sign}${c.line}${c.octave ? (c.octave > 0 ? '^' : '_') + Math.abs(c.octave * 8) : ''}`;
}

/** Writes a duration: the note value and one `.` per dot. */
function durStr(d: Dur): string {
  return `${d.base}${'.'.repeat(d.dots)}`;
}

/** `"Ly-"`, `"-ri-"`, `"-ble"`: hyphens join to the previous or next syllable; `v2` before it names the verse and `_` after it an extender. */
function syllableStr(y: Syllable): string {
  const lead = y.syllabic === 'middle' || y.syllabic === 'end' ? '-' : '';
  const trail = y.syllabic === 'middle' || y.syllabic === 'begin' ? '-' : '';
  return `${y.verse > 1 ? `v${y.verse}` : ''}${quote(lead + y.text + trail)}${y.extend ? '_' : ''}`;
}

/** Writes `s` as a quoted string with JSON escapes. */
function quote(s: string): string {
  return JSON.stringify(s);
}

/** Writes a mark placement: `^` above, `_` below, `=` between the staves. */
/** The text-format codes of the ornaments (`+mo` mordent, `+mi` inverted mordent, `+tu` turn, `+ti` inverted turn). */
const ORNAMENT_CODE: Record<Ornament, string> = {
  mordent: '+mo',
  'mordent-inverted': '+mi',
  turn: '+tu',
  'turn-inverted': '+ti',
};

const ORNAMENT_OF_CODE: Record<string, Ornament> = Object.fromEntries(
  Object.entries(ORNAMENT_CODE).map(([o, c]) => [c, o as Ornament]),
);

/** The text-format placement character of a mark: `^` above, `_` below, `=` between staves, nothing for the default. */
const sideStr = (p?: MarkPlacement) => (p === 'above' ? '^' : p === 'below' ? '_' : p === 'between' ? '=' : '');

/** Slur and hairpin ids are written only when they are not 1: the common case of one span at a time needs no number. */
const idStr = (n: number | undefined) => (n && n !== 1 ? String(n) : '');

/**
 * Marks that take no arguments, by their command name (`\ped`, `\8va`, ...). The parser looks a name
 * up here; the writer goes the other way through `SIMPLE_NAME`, matching on the mark's type, `of` and `dir`.
 */
const SIMPLE: Record<string, MarkBody> = {
  ped: { type: 'pedal' },
  unped: { type: 'stop', of: 'pedal' },
  '8va': { type: 'ottava', dir: 'up' },
  '8vb': { type: 'ottava', dir: 'down' },
  '8off': { type: 'stop', of: 'ottava' },
  trill: { type: 'trill' },
  trilloff: { type: 'stop', of: 'trill' },
};

/** The key under which a parameterless mark is looked up in `SIMPLE_NAME`. */
const simpleKey = (m: MarkBody) => JSON.stringify([m.type, 'of' in m ? m.of : '', 'dir' in m ? m.dir : '']);

const SIMPLE_NAME = new Map(Object.entries(SIMPLE).map(([name, m]) => [simpleKey(m), name]));

/** Writes a mark as it appears in a voice line (`\mf`, `<`, `\ped`, ...). */
function markStr(m: MarkBody): string {
  switch (m.type) {
    case 'dynamic':
      return `\\${m.text}${sideStr(m.placement)}`;
    case 'hairpin':
      return `\\${m.kind === 'cresc' ? '<' : '>'}${idStr(m.id)}${sideStr(m.placement)}`;
    case 'stop':
      if (m.of === 'hairpin') return `\\!${idStr(m.id)}`;
      return `\\${SIMPLE_NAME.get(simpleKey(m))}`;
    case 'pedal':
    case 'ottava':
    case 'trill':
      return `\\${SIMPLE_NAME.get(simpleKey(m))}`;
    case 'clef':
      return `\\clef ${clefStr(m.clef)}`;
    case 'tempo':
      return `\\tempo ${m.unit}${'.'.repeat(m.dots)}=${m.bpm}${m.text ? ` ${quote(m.text)}` : ''}`;
    case 'text':
      return `\\text ${quote(m.text)}${sideStr(m.placement)}`;
  }
}

/**
 * Source positions for editors: with tags on, the writer brackets what a model object is written as in private-use
 * sentinels (`\uE000<n>\uE001 ... \uE002`, n indexing `keys`); `writeTextMap` strips them again and returns the ranges.
 */
class Tags {
  keys: string[] = [];
  open(key: string): string {
    this.keys.push(key);
    return `\uE000${this.keys.length - 1}\uE001`;
  }
  tag(key: string, s: string): string {
    return this.open(key) + s + Tags.close;
  }
  static close = '\uE002';
}

/** Wraps `s` in the text-map tag for `key` when a map is being built; otherwise returns `s` unchanged. */
const tagged = (t: Tags | undefined, key: string, s: string): string => (t ? t.tag(key, s) : s);

class VoiceWriter {
  out: string[] = [];
  lastBase: BaseDur | 0 = 0;
  /** The next token continues the previous one without a space (just inside the delimiters of a group). */
  glue = false;
  home: string;
  /** Staff the following events are drawn on; changes are written as `\staff <id>` (cross-staff notes). */
  curStaff: string;
  tags?: Tags;
  at: { mi: number; staff: string; voice: number };
  /** Index of the next event in the voice, counted as `flattenVoice` does (the address used by refs). */
  evIdx = 0;
  /** Current tuplet nesting depth. */
  depth = 0;
  constructor(home: string, at: { mi: number; staff: string; voice: number }, tags?: Tags) {
    this.home = this.curStaff = home;
    this.at = at;
    this.tags = tags;
  }

  /** The tokens written before an event: its marks, staff switch, slur starts, stem and the note options. */
  private prefixTokens(e: Event, loc: { mi: number; staff: string; voice: number; idx: number }): string[] {
    const pre: string[] = [];
    for (const [k, m] of (e.marks ?? []).entries())
      pre.push(tagged(this.tags, refKey({ t: 'mark', ...loc, k }), markStr(m)));
    if ((e.staff ?? this.home) !== this.curStaff) {
      this.curStaff = e.staff ?? this.home;
      pre.push(`\\staff ${this.curStaff}`);
    }
    for (const s of e.slurStart ?? []) pre.push(`(${idStr(s.id)}${sideStr(s.side)}${s.skewed ? '/' : ''}`);
    for (const s of e.lineStart ?? []) if (s.head === undefined) pre.push(`&${idStr(s.id)}${s.dashed ? '.' : ''}`);
    if (e.stem) pre.push(e.stem === 'up' ? '\\stemup' : '\\stemdown');
    if (e.kind === 'note') {
      if (e.graces?.length) pre.push(...graceStrs(e.graces));
      if (e.arpeggio) pre.push('\\arp');
      if (e.noBeam) pre.push('\\nobeam');
    }
    return pre;
  }

  /**
   * The pitches or rest of an event, and what follows the duration: a single note's tie goes after the
   * duration (`c4:8~`); in a chord every pitch is tied on its own, inside the <> (`<c4~ e4>`), because
   * tied and untied pitches can be mixed.
   */
  private coreAndTie(e: Event): { core: string; tie: string } {
    if (e.kind === 'rest')
      return {
        core: e.style === 'hidden' ? 's' : e.style === 'measure' ? 'R' : e.display ? `r@${pitchStr(e.display)}` : 'r',
        tie: '',
      };
    const ps = e.pitches.map((p) => pitchStr(p.pitch) + (p.acc === 'force' ? '!' : p.acc === 'cautionary' ? '?' : ''));
    if (e.pitches.length === 1) return { core: ps[0], tie: tieStr(e.pitches[0]) };
    const heads = (i: number) =>
      (e.lineStart ?? [])
        .filter((s) => s.head === i)
        .map((s) => `&${idStr(s.id)}${s.dashed ? '.' : ''}`)
        .join('') +
      (e.lineStop ?? [])
        .filter((s) => s.head === i)
        .map((s) => `;${idStr(s.id)}`)
        .join('');
    return { core: `<${ps.map((x, i) => x + tieStr(e.pitches[i]) + heads(i)).join(' ')}>`, tie: '' };
  }

  eventStr(e: Event): string {
    const loc = { ...this.at, idx: this.evIdx++ };
    const pre = this.prefixTokens(e, loc);
    const { core, tie } = this.coreAndTie(e);
    let arts = '';
    if (e.kind === 'note') {
      for (const a of e.art ?? []) arts += a === 'accent' ? '->' : a === 'marcato' ? '-^' : '-.';
      if (e.art?.length && e.artSide) arts += sideStr(e.artSide);
      if (e.trill) arts += `+tr${e.trillAcc === undefined ? '' : e.trillAcc > 0 ? '#' : e.trillAcc < 0 ? 'b' : '='}`;
      if (e.ornament) arts += ORNAMENT_CODE[e.ornament];
    }
    if (e.fermata)
      arts += `+fm${e.fermataShape === 'short' ? 's' : e.fermataShape === 'long' ? 'l' : ''}${e.fermataBelow ? '_' : ''}`;
    if (e.kind === 'note') for (const y of e.lyrics ?? []) arts += syllableStr(y);
    // Durations are sticky: the base value is written only when it differs from the previous event's.
    // Dots are never sticky (a dotted note would otherwise make everything after it dotted), so they
    // are always written, which also forces the base to be written.
    const d = e.dur.base !== this.lastBase || e.dur.dots ? `:${durStr(e.dur)}` : '';
    this.lastBase = e.dur.base;
    const slurEnd =
      (e.slurStop ?? []).map((i) => `)${idStr(i)}`).join('') +
      (e.lineStop ?? []).map((x) => (x.head === undefined ? `;${idStr(x.id)}` : '')).join('');
    const toks = [...pre, tagged(this.tags, refKey({ t: 'ev', ...loc }), core + d + tie + arts + slurEnd)];
    // A slur start is glued to the token after it: `(f#2:16 ... d#2)`. Nothing that follows starts with
    // a digit, so an id like in `(2` cannot be mistaken for part of the next token.
    return toks.reduce(
      (acc, t, i) => (i > 0 && /^[(&]\d*[\^_.]?$/.test(toks[i - 1]) ? acc + t : acc ? `${acc} ${t}` : t),
      '',
    );
  }

  items(items: Item[]): void {
    for (const it of items) {
      if (isTuplet(it)) {
        const o: string[] = [];
        if (it.bracket === true) o.push('bracket');
        else if (it.bracket === false) o.push('nobracket');
        if (it.number === 'none') o.push('nonum');
        if (it.placement) o.push(it.placement);
        if (it.label !== undefined) o.push(`label=${it.label}`);
        const key = refKey({ t: 'tuplet', ...this.at, idx: this.evIdx, depth: this.depth });
        this.depth++;
        this.group(`${it.actual}:${it.normal}${o.length ? `(${o.join(',')})` : ''}{`, '}', it.items, key);
        this.depth--;
      } else if (isBeam(it)) this.group('[', ']', it.items);
      else if (isTremolo(it)) this.group(`trem${it.beams}{`, '}', it.items);
      else this.push(this.eventStr(it));
    }
  }
  push(tok: string): void {
    if (this.glue) {
      this.out[this.out.length - 1] += tok;
      this.glue = false;
    } else this.out.push(tok);
  }
  /** A group is written without padding inside its delimiters: `3:2{c5:16 d5 e5}`. */
  group(open: string, close: string, items: Item[], key?: string): void {
    this.push(this.tags && key ? this.tags.open(key) + open : open);
    this.glue = true;
    this.items(items);
    this.glue = false;
    this.out[this.out.length - 1] += close + (this.tags && key ? Tags.close : '');
  }
}

/** The tie of a pitch: `~`, with `^` or `_` after it when the side is forced; empty when untied. */
function tieStr(p: NotePitch): string {
  return p.tie ? `~${p.tieSide === 'above' ? '^' : p.tieSide === 'below' ? '_' : ''}` : '';
}

/** Reads the `^` or `_` that forces the side of a tie just read. */
function tieSideAfter(sc: Scanner): 'above' | 'below' | undefined {
  if (sc.peek() === '^') {
    sc.i++;
    return 'above';
  }
  if (sc.peek() === '_') {
    sc.i++;
    return 'below';
  }
  return undefined;
}

/** Runs of grace notes with the same slash: `\\acc{d5:8 e5:8}` (struck through) or `\\grace{...}`. */
function graceStrs(gs: Grace[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < gs.length; ) {
    const slash = !!gs[i].slash;
    let j = i;
    while (j < gs.length && !!gs[j].slash === slash) j++;
    const body = gs.slice(i, j).map((g) => {
      const ps = g.pitches.map(
        (p) => pitchStr(p.pitch) + (p.acc === 'force' ? '!' : p.acc === 'cautionary' ? '?' : '') + tieStr(p),
      );
      return `${ps.length === 1 ? ps[0] : `<${ps.join(' ')}>`}:${g.base}`;
    });
    out.push(`\\${slash ? 'acc' : 'grace'}{${body.join(' ')}}`);
    i = j;
  }
  return out;
}

/** Writes the voice lines of one staff-measure, one per voice, into `lines`. */
function writeStaffMeasure(sm: StaffMeasure, sid: string, mi: number, lines: string[], tags?: Tags): void {
  for (const v of sm.voices) {
    const at = { mi, staff: sid, voice: v.id };
    const w = new VoiceWriter(sid, at, tags);
    w.items(v.items);
    for (const [k, m] of (v.end ?? []).entries())
      w.out.push(tagged(tags, refKey({ t: 'mark', ...at, idx: -1, k }), markStr(m)));
    lines.push(`  ${sid}.${v.id}: ${w.out.join(' ')}`);
  }
}

/** ` labels=full,abbr labelsize=2`: the staff label settings of the page statement (nothing when they are off). */
function labelsStr(page: Score['page']): string {
  if (!(page.labelsFirst || page.labelsLater)) return '';
  return ` labels=${page.labelsFirst ?? 'none'},${page.labelsLater ?? 'none'}${page.labelSize ? ` labelsize=${page.labelSize}` : ''}`;
}

/** The staff label fields of a `page` statement's attributes: `labels=<first>,<later>` (full, abbr or none) and `labelsize=<n>`. */
function parseLabels(o: Record<string, string>): Partial<Score['page']> {
  const mode = (v: string | undefined) => (v === 'full' || v === 'abbr' ? v : undefined);
  const [first, later] = (o.labels ?? '').split(',');
  const out: Partial<Score['page']> = {};
  if (mode(first)) out.labelsFirst = mode(first);
  if (mode(later)) out.labelsLater = mode(later);
  if (o.labelsize) out.labelSize = Number(o.labelsize);
  return out;
}

/**
 * Writes the whole score; with `tags` the output also carries the markers from which `writeTextMap` derives the
 * places of the model objects.
 */
function write(score: Score, tags?: Tags): string {
  const L: string[] = [];
  L.push('# music typesetter score');
  const { meta, page } = score;
  for (const k of ['title', 'subtitle', 'composer', 'rights'] as const)
    if (meta[k]) L.push(`${k} ${quote(must(meta[k]))}`);
  L.push(
    `page ${page.width}x${page.height} margin=${page.margin} space=${page.staffSpace}${page.measureNumbers ? ` numbers=${page.measureNumbers}` : ''}${page.multiRests ? ' multirests=on' : ''}${labelsStr(page)}`,
  );
  for (const s of score.staves)
    L.push(
      `staff ${s.id} clef=${clefStr(s.clef)}${s.name ? ` name=${quote(s.name)}` : ''}${s.abbr ? ` abbr=${quote(s.abbr)}` : ''}`,
    );
  for (const g of score.groups) L.push(`${g.kind} ${g.staves.join(' ')}`);
  L.push('');
  score.measures.forEach((m, mi) => {
    const h = [`m${mi + 1}`];
    if (m.time) h.push(`time=${m.time.beats}/${m.time.beatType}`);
    if (m.key !== undefined) h.push(`key=${m.key}`);
    if (m.breakBefore) h.push(`break=${m.breakBefore}`);
    if (m.barline) h.push(`barline=${m.barline}`);
    if (m.repeatStart) h.push('start=repeat');
    if (m.ending) h.push(`ending=${m.ending.join(',')}`);
    const first = L.length;
    L.push(h.join(' '));
    for (const s of score.staves) {
      const sm = m.staves[s.id];
      if (sm) writeStaffMeasure(sm, s.id, mi, L, tags);
    }
    if (tags) {
      L[first] = tags.open(refKey({ t: 'measure', mi })) + L[first];
      L[L.length - 1] += Tags.close;
    }
  });
  return `${L.join('\n')}\n`;
}

/** Writes a score in the text format (see FORMAT.md). The inverse of `parseText`. */
export function writeText(score: Score): string {
  return write(score);
}

/** The text and where each model object sits in it: `refKey` (see editor/addr.ts) -> [from, to) offsets. */
export function writeTextMap(score: Score): { text: string; ranges: Map<string, [number, number][]> } {
  const tags = new Tags();
  const raw = write(score, tags);
  const ranges = new Map<string, [number, number][]>();
  const stack: { key: string; from: number }[] = [];
  let text = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\uE000') {
      const j = raw.indexOf('\uE001', i);
      stack.push({ key: tags.keys[Number(raw.slice(i + 1, j))], from: text.length });
      i = j;
    } else if (c === '\uE002') {
      const { key, from } = must(stack.pop());
      (ranges.get(key) ?? must(ranges.set(key, []).get(key))).push([from, text.length]);
    } else text += c;
  }
  return { text, ranges };
}

// Parsing: `parse` turns the text back into a Score.
// A hand-written scanner over the text, one voice line at a time; errors carry the line (`where`).

class Scanner {
  i = 0;
  s: string;
  where: string;
  constructor(s: string, where: string) {
    this.s = s;
    this.where = where;
  }
  eof(): boolean {
    this.ws();
    return this.i >= this.s.length;
  }
  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }
  peek(): string {
    return this.s[this.i] ?? '';
  }
  take(re: RegExp): string | null {
    re.lastIndex = this.i;
    const m = re.exec(this.s);
    if (!m || m.index !== this.i) return null;
    this.i += m[0].length;
    return m[0];
  }
  fail(msg: string): never {
    throw new Error(`${this.where}: ${msg} at "${this.s.slice(this.i, this.i + 20)}"`);
  }
}

/** Parses a pitch at the scanner's position. */
function parsePitch(sc: Scanner): Pitch {
  const m = sc.take(/[a-g][#b]*-?\d/y);
  if (!m) sc.fail('pitch expected');
  const step = must(m)[0] as Pitch['step'];
  const rest = must(m).slice(1);
  const octave = Number(must(rest.match(/-?\d$/))[0]);
  const accs = rest.slice(0, rest.length - String(octave).length);
  const alter = accs.split('').reduce((a, c) => a + (c === '#' ? 1 : -1), 0);
  return { step, alter, octave };
}

/** Parses a clef token such as `G2` or `F4`. */
function parseClef(s: string): Clef {
  const m = /^([GFC])(\d)(?:([\^_])(\d+))?$/.exec(s);
  if (!m) throw new Error(`bad clef ${s}`);
  const c: Clef = { sign: m[1] as Clef['sign'], line: Number(m[2]) };
  if (m[3]) c.octave = (m[3] === '^' ? 1 : -1) * (Number(m[4]) / 8);
  return c;
}

/** Parses a duration (note value and dots) at the scanner's position. */
function parseDur(sc: Scanner): Dur {
  const m = sc.take(/\d+\.*/y);
  if (!m) sc.fail('duration expected');
  const dots = (must(m).match(/\./g) ?? []).length;
  const base = Number(must(m).replace(/\./g, ''));
  if (![1, 2, 4, 8, 16, 32, 64, 128].includes(base)) sc.fail(`bad duration ${base}`);
  if (base === 128 && dots) sc.fail('a 128th cannot be dotted');
  return { base: base as BaseDur, dots };
}

type Side = 'above' | 'below';

interface PendingEv {
  stem?: 'up' | 'down';
  arpeggio?: boolean;
  noBeam?: boolean;
  graces?: Grace[];
}

type Frame = { kind: 'root' | 'tuplet' | 'beam' | 'tremolo'; items: Item[] };

/** The result of parsing one voice line. */
interface VoiceLine {
  items: Item[];
  marks: TimedMark[];
  end: MarkBody[];
}

/**
 * Parses the items of one voice line, or of a mark line (`markLine`: only marks, each placed by an `@position`).
 * A mark in a voice line belongs to the event that follows it (or to the end of the voice's measure: `end`).
 * Brackets, commands and slur starts only set up state (`pendingEv`, `pendingSlurs`, `pending`) for the event that follows.
 */
class VoiceLineParser {
  private sc: Scanner;
  private markLine: boolean;
  private home: string;
  private stack: Frame[] = [{ kind: 'root', items: [] }];
  private sticky: BaseDur = 4;
  /** Explicit position (mark lines). */
  private at: number | null;
  private pending: MarkBody[] = [];
  private pendingSlurs: { id: number; side?: Side }[] = [];
  private pendingLines: LineStart[] = [];
  /** Line ends written on the pitches of the chord being read (`<c4&1 e4;2>`), which go to the event with their pitch index. */
  private headLines: { starts: LineStart[]; stops: LineStop[] } = { starts: [], stops: [] };
  private pendingEv: PendingEv = {};
  private lastEv: Event | null = null;
  /** Set by \staff, sticky within the line. */
  private curStaff: string;
  private marks: TimedMark[] = [];
  private end: MarkBody[] = [];

  constructor(line: string, where: string, home: string, markLine: boolean) {
    this.sc = new Scanner(line, where);
    this.markLine = markLine;
    this.home = home;
    this.curStaff = home;
    this.at = markLine ? 0 : null;
  }

  parse(): VoiceLine {
    while (!this.sc.eof()) this.readItem();
    if (this.stack.length !== 1) this.sc.fail('unclosed group');
    this.flush(null);
    return { items: this.stack[0].items, marks: this.marks, end: this.end };
  }

  private get top(): Frame {
    return this.stack[this.stack.length - 1];
  }

  private readItem(): void {
    const sc = this.sc;
    const c = sc.peek();
    if (c === '[' || c === ']' || c === '}') this.readBracket(c);
    else if (c === '@') this.readPosition();
    else if (/\d/.test(c)) this.readTupletHeader();
    else if (this.readTremoloOpen()) return;
    else if (c === '(') this.readSlurStart();
    else if (c === ')') this.readSlurStop();
    else if (c === '&') this.readLineStart();
    else if (c === ';') this.readLineStop();
    else if (c === '\\') this.readCommand();
    else this.readEvent(c);
  }

  private open(kind: Frame['kind'], node: TupletGroup | BeamGroup | TremoloGroup): void {
    this.top.items.push(node);
    this.stack.push({ kind, items: node.items });
  }

  private close(kind: Frame['kind'], ch: string): void {
    this.sc.i++;
    if (this.top.kind !== kind) this.sc.fail(`unmatched ${ch}`);
    this.stack.pop();
  }

  private readBracket(c: string): void {
    if (c === '[') {
      this.sc.i++;
      this.open('beam', { kind: 'beam', items: [] });
    } else if (c === ']') this.close('beam', ']');
    else if (this.top.kind !== 'tremolo')
      this.close('tuplet', '}'); // The character '}' closes a tuplet or a tremolo.
    else this.close('tremolo', '}');
  }

  private readPosition(): void {
    if (!this.markLine) this.sc.fail('@ only valid in mark lines');
    this.sc.i++;
    this.at = fracParse(this.sc.take(/[\d/]+/y) ?? this.sc.fail('position expected'));
  }

  /** Tuplet header  a:b(opts){ */
  private readTupletHeader(): void {
    const sc = this.sc;
    const [actual, normal] = must(sc.take(/(\d+):(\d+)/y))
      .split(':')
      .map(Number);
    const g: TupletGroup = { kind: 'tuplet', actual, normal, items: [] };
    if (sc.peek() === '(') {
      const options = must(sc.take(/\([^)]*\)/y))
        .slice(1, -1)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      for (const x of options) this.applyTupletOption(g, x);
    }
    if (sc.take(/\{/y) === null) sc.fail('{ expected after tuplet');
    this.open('tuplet', g);
  }

  private applyTupletOption(g: TupletGroup, x: string): void {
    if (x === 'bracket') g.bracket = true;
    else if (x === 'nobracket') g.bracket = false;
    else if (x === 'nonum') g.number = 'none';
    else if (x === 'above' || x === 'below') g.placement = x;
    else if (x.startsWith('label=')) g.label = Number(x.slice(6));
    else this.sc.fail(`bad tuplet option ${x}`);
  }

  private readTremoloOpen(): boolean {
    const trem = this.sc.take(/trem(\d+)\{/y);
    if (!trem) return false;
    this.open('tremolo', { kind: 'tremolo', beams: Number(trem.slice(4, -1)), items: [] });
    return true;
  }

  private num(): number {
    const n = this.sc.take(/\d+/y);
    return n ? Number(n) : 1;
  }

  private placement(): Side | undefined {
    const c = this.sc.peek();
    if (c === '^') {
      this.sc.i++;
      return 'above';
    }
    if (c === '_') {
      this.sc.i++;
      return 'below';
    }
    return undefined;
  }

  private readSlurStart(): void {
    this.sc.i++;
    const id = this.num();
    const side = this.placement();
    const skewed = this.sc.take(/\//y);
    this.pendingSlurs.push({ id, ...(side ? { side } : {}), ...(skewed ? { skewed: true } : {}) });
  }

  private readSlurStop(): void {
    this.sc.i++;
    const id = this.num();
    const last = this.lastEv;
    if (!last) this.sc.fail(') without event');
    const ev = must(last);
    ev.slurStop ??= [];
    ev.slurStop.push(id);
  }

  private readLineStart(): void {
    this.sc.i++;
    const id = this.num();
    const dashed = this.sc.take(/\./y);
    this.pendingLines.push({ id, ...(dashed ? { dashed: true } : {}) });
  }

  private readLineStop(): void {
    this.sc.i++;
    const id = this.num();
    if (!this.lastEv) this.sc.fail('; without event');
    const ev = must(this.lastEv);
    ev.lineStop ??= [];
    ev.lineStop.push({ id });
  }

  /** A mark belongs to the next event (or the end of the measure), or in a mark line to its position. */
  private addMark(body: MarkBody): void {
    if (this.at !== null) this.marks.push({ ...body, tick: this.at } as TimedMark);
    else this.pending.push(body);
  }

  /** `between` (`=`) is for dynamics, hairpins and text. */
  private addMarkWithSide<T extends MarkBody>(body: T, between = false): void {
    let side: MarkPlacement | undefined;
    if (between && this.sc.peek() === '=') {
      this.sc.i++;
      side = 'between';
    } else side = this.placement();
    this.addMark(side ? ({ ...body, placement: side } as MarkBody) : body);
  }

  /** Hands the pending marks to the event, or to the end of the measure if there is none. */
  private flush(ev: Event | null): void {
    if (ev) {
      if (this.pending.length) ev.marks = [...(ev.marks ?? []), ...this.pending];
    } else this.end = this.pending;
    this.pending = [];
  }

  private readCommand(): void {
    const sc = this.sc;
    sc.i++;
    const name = sc.take(/[A-Za-z0-9]+|[<>!]/y) ?? sc.fail('command expected');
    if (this.readMarkCommand(name)) return;
    switch (name) {
      case 'clef':
        sc.ws();
        this.addMark({ type: 'clef', clef: parseClef(must(sc.take(/\S+/y))) });
        break;
      case 'tempo':
        this.readTempo();
        break;
      case 'text':
        sc.ws();
        this.addMarkWithSide({ type: 'text', text: readString(sc) }, true);
        break;
      case 'grace':
      case 'acc':
        this.readGraceBlock(name);
        break;
      case 'arp':
        this.pendingEv.arpeggio = true;
        break;
      case 'staff':
        sc.ws();
        this.curStaff = sc.take(/\w+/y) ?? sc.fail('staff id expected');
        break;
      case 'nobeam':
        this.pendingEv.noBeam = true;
        break;
      case 'stemup':
        this.pendingEv.stem = 'up';
        break;
      case 'stemdown':
        this.pendingEv.stem = 'down';
        break;
      default:
        sc.fail(`unknown command \\${name}`);
    }
  }

  /** Commands that are marks without further syntax: dynamics, hairpins, the simple table. Returns false for other commands. */
  private readMarkCommand(name: string): boolean {
    if (DYNAMICS.has(name)) this.addMarkWithSide({ type: 'dynamic', text: name }, true);
    else if (name === '<' || name === '>')
      this.addMarkWithSide({ type: 'hairpin', kind: name === '<' ? 'cresc' : 'dim', id: this.num() }, true);
    else if (name === '!') this.addMark({ type: 'stop', of: 'hairpin', id: this.num() });
    else if (Object.hasOwn(SIMPLE, name)) this.addMark(SIMPLE[name]);
    else return false;
    return true;
  }

  private readTempo(): void {
    const sc = this.sc;
    sc.ws();
    const m = must(/(\d+)(\.*)=(\d+)/.exec(sc.take(/(\d+)(\.*)=(\d+)/y) ?? sc.fail('tempo like 4=115 expected')));
    const tempo: MarkBody = { type: 'tempo', unit: Number(m[1]) as BaseDur, dots: m[2].length, bpm: Number(m[3]) };
    sc.ws();
    if (sc.peek() === '"') tempo.text = readString(sc);
    this.addMark(tempo);
  }

  private readNotePitch(): NotePitch {
    const sc = this.sc;
    const np: NotePitch = { pitch: parsePitch(sc) };
    if (sc.peek() === '!') {
      sc.i++;
      np.acc = 'force';
    } else if (sc.peek() === '?') {
      sc.i++;
      np.acc = 'cautionary';
    }
    if (sc.peek() === '~') {
      sc.i++;
      np.tie = true;
      const side = tieSideAfter(sc);
      if (side) np.tieSide = side;
    }
    return np;
  }

  /** A single pitch, or a chord <...> of pitches. */
  private readPitches(): NotePitch[] {
    const sc = this.sc;
    if (sc.peek() !== '<') return [this.readNotePitch()];
    sc.i++;
    const pitches: NotePitch[] = [];
    for (;;) {
      sc.ws();
      if (sc.peek() === '>') {
        sc.i++;
        break;
      }
      pitches.push(this.readNotePitch());
      const head = pitches.length - 1;
      for (;;) {
        if (sc.take(/&/y)) {
          const id = this.num();
          this.headLines.starts.push({ id, ...(sc.take(/\./y) ? { dashed: true } : {}), head });
        } else if (sc.take(/;/y)) this.headLines.stops.push({ id: this.num(), head });
        else break;
      }
    }
    if (!pitches.length) sc.fail('empty chord');
    return pitches;
  }

  /** \grace{...} and \acc{...} (slashed): grace notes for the next note. */
  private readGraceBlock(name: 'grace' | 'acc'): void {
    const sc = this.sc;
    sc.ws();
    if (sc.take(/\{/y) === null) sc.fail(`{ expected after \\${name}`);
    for (;;) {
      sc.ws();
      if (sc.peek() === '}') {
        sc.i++;
        return;
      }
      const pitches = this.readPitches();
      if (sc.take(/:/y) === null) sc.fail('grace note duration expected, like d5:8');
      const d = parseDur(sc);
      if (d.dots) sc.fail('grace notes cannot be dotted');
      this.pendingEv.graces ??= [];
      this.pendingEv.graces.push({ pitches, base: d.base, ...(name === 'acc' ? { slash: true } : {}) });
    }
  }

  /** An explicit duration (which becomes the new default), else the last one used. */
  private readDur(): Dur {
    if (this.sc.peek() !== ':') return { base: this.sticky, dots: 0 };
    this.sc.i++;
    const d = parseDur(this.sc);
    this.sticky = d.base;
    return d;
  }

  private readRest(c: string): RestEvent {
    const sc = this.sc;
    sc.i++;
    const rest: RestEvent = {
      kind: 'rest',
      style: c === 's' ? 'hidden' : c === 'R' ? 'measure' : 'normal',
      dur: { base: 4, dots: 0 },
    };
    if (c === 'r' && sc.peek() === '@') {
      sc.i++;
      rest.display = parsePitch(sc);
    }
    if (this.pendingEv.graces) sc.fail('grace notes belong in front of a note, not a rest');
    rest.dur = this.readDur();
    this.readFermata(rest);
    return rest;
  }

  /** Reads `+fm`, with `s` (short) or `l` (long) for the shape and `_` for below, if there is one. */
  private readFermata(ev: NoteEvent | RestEvent): void {
    const m = this.sc.take(/\+fm([sl])?(_)?/y);
    if (!m) return;
    ev.fermata = true;
    const [, shape, below] = must(/^\+fm([sl])?(_)?$/.exec(m));
    if (shape) ev.fermataShape = shape === 's' ? 'short' : 'long';
    if (below) ev.fermataBelow = true;
  }

  private readNoteEvent(): NoteEvent {
    const sc = this.sc;
    const note: NoteEvent = { kind: 'note', dur: { base: 4, dots: 0 }, pitches: this.readPitches() };
    note.dur = this.readDur();
    if (sc.peek() === '~') {
      if (note.pitches.length !== 1) sc.fail('tie the pitches of a chord inside <>');
      sc.i++;
      note.pitches[0].tie = true;
      const side = tieSideAfter(sc);
      if (side) note.pitches[0].tieSide = side;
    }
    for (;;) {
      const art = sc.take(/->/y) ? 'accent' : sc.take(/-\^/y) ? 'marcato' : sc.take(/-\./y) ? 'staccato' : undefined;
      if (!art) break;
      note.art ??= [];
      note.art.push(art);
    }
    if (note.art) {
      const side = this.placement();
      if (side) note.artSide = side;
    }
    const tr = sc.take(/\+tr([#b=])?/y);
    if (tr) {
      note.trill = true;
      if (tr.endsWith('#')) note.trillAcc = 1;
      else if (tr.endsWith('b')) note.trillAcc = -1;
      else if (tr.endsWith('=')) note.trillAcc = 0;
    }
    const orn = sc.take(/\+(?:mo|mi|tu|ti)/y);
    if (orn) note.ornament = must(ORNAMENT_OF_CODE[orn]);
    this.readFermata(note);
    for (;;) {
      const m = sc.take(/(?:v(\d+))?("(?:[^"\\]|\\.)*")(_)?/y);
      if (!m) break;
      const [, verse, str, extend] = must(/^(?:v(\d+))?("(?:[^"\\]|\\.)*")(_)?$/.exec(m));
      note.lyrics ??= [];
      note.lyrics.push(parseSyllable(verse ? Number(verse) : 1, JSON.parse(str), extend === '_'));
    }
    if (this.pendingEv.graces) note.graces = this.pendingEv.graces;
    if (this.pendingEv.arpeggio) note.arpeggio = true;
    if (this.pendingEv.noBeam) note.noBeam = true;
    return note;
  }

  /** Whatever is left is a note, chord or rest; the prefixes handled before were commands and brackets. */
  private readEvent(c: string): void {
    if (this.markLine) this.sc.fail('events not allowed in mark lines');
    const ev: Event = c === 'r' || c === 's' || c === 'R' ? this.readRest(c) : this.readNoteEvent();
    if (this.pendingSlurs.length) ev.slurStart = this.pendingSlurs;
    this.pendingSlurs = [];
    if (this.pendingLines.length || this.headLines.starts.length)
      ev.lineStart = [...this.pendingLines, ...this.headLines.starts];
    if (this.headLines.stops.length) ev.lineStop = this.headLines.stops;
    this.pendingLines = [];
    this.headLines = { starts: [], stops: [] };
    if (this.pendingEv.stem) ev.stem = this.pendingEv.stem;
    if (this.curStaff !== this.home) ev.staff = this.curStaff;
    this.pendingEv = {};
    this.flush(ev);
    this.top.items.push(ev);
    this.lastEv = ev;
  }
}

/**
 * Parses one voice line. `home` is the staff the line is written under; `markLine` marks a `@` line that holds
 * timed marks only.
 */
function parseVoiceLine(line: string, where: string, home: string, markLine = false): VoiceLine {
  return new VoiceLineParser(line, where, home, markLine).parse();
}

/** The inverse of `syllableStr` for the quoted part: leading and trailing hyphens give the syllabic. */
function parseSyllable(verse: number, s: string, extend: boolean): Syllable {
  const lead = s.length > 1 && s.startsWith('-');
  const rest = lead ? s.slice(1) : s;
  const trail = rest.length > 1 && rest.endsWith('-');
  const syllable: Syllable = {
    verse,
    text: trail ? rest.slice(0, -1) : rest,
    syllabic: lead ? (trail ? 'middle' : 'end') : trail ? 'begin' : 'single',
  };
  if (extend) syllable.extend = true;
  return syllable;
}

/** Reads a quoted string at the scanner's position. */
function readString(sc: Scanner): string {
  const m = sc.take(/"(?:[^"\\]|\\.)*"/y);
  if (!m) sc.fail('string expected');
  return JSON.parse(must(m));
}

/** Collects the `key=value` tokens into a record; tokens without `=` are ignored. */
function kv(tokens: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (const t of tokens) {
    const i = t.indexOf('=');
    if (i > 0) o[t.slice(0, i)] = t.slice(i + 1);
  }
  return o;
}

/** Splits on whitespace but keeps "quoted strings" together. */
function tokens(line: string): string[] {
  return line.match(/(?:[^\s"]|"(?:[^"\\]|\\.)*")+/g) ?? [];
}

/** The state of reading a text file line by line. */
interface TextState {
  score: Score;
  /** The measure being read; voice lines belong to it. */
  cur: Measure | null;
  /** Positioned marks (mark lines), hung on events once the voices are known. */
  timed: Map<StaffMeasure, TimedMark[]>;
}

/** An indented line: the voice (`s1.1: ...`) or mark line (`s1@: ...`) of a staff in the current measure. */
function parseVoiceStatement(st: TextState, raw: string, where: string): void {
  if (!st.cur) throw new Error('voice line outside measure');
  const m = /^\s+(\w+)(?:\.(\d+)|@):\s*(.*)$/.exec(raw);
  if (!m) throw new Error('bad voice line');
  const sid = m[1];
  if (!st.score.staves.some((s) => s.id === sid)) throw new Error(`unknown staff ${sid}`);
  st.cur.staves[sid] ??= { voices: [] };
  const sm = st.cur.staves[sid];
  const markLine = m[2] === undefined;
  const { items, marks, end } = parseVoiceLine(m[3], where, sid, markLine);
  if (!markLine) sm.voices.push({ id: Number(m[2]), items, ...(end.length ? { end } : {}) });
  if (marks.length) st.timed.set(sm, [...(st.timed.get(sm) ?? []), ...marks]);
}

/** `m<N> time=3/4 key=2 break=system barline=final start=repeat ending=1,2`: starts a measure. */
function parseMeasureStatement(st: TextState, t: string[]): void {
  const o = kv(t.slice(1));
  const measure: Measure = { staves: {} }; // The number in `m<N>` is only a label.
  if (o.time) {
    const [beats, beatType] = o.time.split('/').map(Number);
    measure.time = { beats, beatType };
  }
  if (o.key !== undefined) measure.key = Number(o.key);
  if (o.break) measure.breakBefore = o.break as 'system' | 'page';
  if (o.barline) measure.barline = o.barline as Measure['barline'];
  if (o.start === 'repeat') measure.repeatStart = true;
  if (o.ending) measure.ending = o.ending.split(',').map(Number);
  st.score.measures.push(measure);
  st.cur = measure;
}

/** An unindented line: a header statement (title, page, staff, group) or a measure start. */
function parseStatement(st: TextState, t: string[]): void {
  const { score } = st;
  const head = t[0];
  if (head === 'title' || head === 'subtitle' || head === 'composer' || head === 'rights')
    score.meta[head] = JSON.parse(t[1]);
  else if (head === 'page') {
    const [w, h] = t[1].split('x').map(Number);
    const o = kv(t.slice(2));
    score.page = {
      width: w,
      height: h,
      margin: Number(o.margin ?? 10),
      staffSpace: Number(o.space ?? 1.91),
      ...(o.numbers === 'all' || o.numbers === 'none' ? { measureNumbers: o.numbers } : {}),
      ...(o.multirests === 'on' ? { multiRests: true } : {}),
      ...parseLabels(o),
    };
  } else if (head === 'staff') {
    const o = kv(t.slice(2));
    score.staves.push({
      id: t[1],
      clef: parseClef(o.clef ?? 'G2'),
      ...(o.name ? { name: JSON.parse(o.name) } : {}),
      ...(o.abbr ? { abbr: JSON.parse(o.abbr) } : {}),
    });
  } else if (head === 'brace' || head === 'bracket') score.groups.push({ kind: head, staves: t.slice(1) });
  else if (/^m\d+$/.test(head)) parseMeasureStatement(st, t);
  else throw new Error(`unknown statement ${head}`);
}

/** Parses the text format (see FORMAT.md) into a `Score`; errors name the line. */
export function parseText(src: string): Score {
  const st: TextState = {
    score: {
      meta: {},
      page: { width: 210, height: 297, margin: 10, staffSpace: 1.91 },
      staves: [],
      groups: [],
      measures: [],
    },
    cur: null,
    timed: new Map(),
  };
  src.split(/\r?\n/).forEach((raw, ln) => {
    const where = `line ${ln + 1}`;
    if (!raw.trim() || raw.trim().startsWith('#')) return;
    try {
      if (/^\s/.test(raw)) parseVoiceStatement(st, raw, where);
      else parseStatement(st, tokens(raw.trim()));
    } catch (e) {
      throw new Error(`${where}: ${(e as Error).message}`);
    }
  });
  for (const m of st.score.measures)
    for (const sm of Object.values(m.staves)) {
      sm.voices.sort((a, b) => a.id - b.id);
      const marks = st.timed.get(sm);
      if (marks)
        anchorMarks(
          sm,
          marks.sort((a, b) => a.tick - b.tick),
        );
    }
  return st.score;
}
