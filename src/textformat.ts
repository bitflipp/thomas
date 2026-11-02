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
  MarkBody,
  Measure,
  NoteEvent,
  NotePitch,
  Pitch,
  Placement,
  RestEvent,
  Score,
  StaffMeasure,
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

// ------------------------------------------------------------------ writing

/** Parses a position in quarter notes, an integer or a fraction like `3/2`; it must land on a whole tick. */
function fracParse(s: string): number {
  const [n, d] = s.split('/');
  const t = (Number(n) * PPQ) / Number(d ?? 1);
  if (!Number.isInteger(t)) throw new Error(`bad position ${s}`);
  return t;
}

export function pitchStr(p: Pitch): string {
  const acc = p.alter > 0 ? '#'.repeat(p.alter) : 'b'.repeat(-p.alter);
  return `${p.step}${acc}${p.octave}`;
}
function clefStr(c: Clef): string {
  return `${c.sign}${c.line}${c.octave ? (c.octave > 0 ? '^' : '_') + Math.abs(c.octave * 8) : ''}`;
}
function durStr(d: Dur): string {
  return `${d.base}${'.'.repeat(d.dots)}`;
}
function quote(s: string): string {
  return JSON.stringify(s);
}

const sideStr = (p?: Placement) => (p === 'above' ? '^' : p === 'below' ? '_' : '');
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
};
const simpleKey = (m: MarkBody) => JSON.stringify([m.type, 'of' in m ? m.of : '', 'dir' in m ? m.dir : '']);
const SIMPLE_NAME = new Map(Object.entries(SIMPLE).map(([name, m]) => [simpleKey(m), name]));

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

  eventStr(e: Event): string {
    const idx = this.evIdx++;
    const loc = { ...this.at, idx };
    const pre: string[] = [];
    for (const [k, m] of (e.marks ?? []).entries())
      pre.push(tagged(this.tags, refKey({ t: 'mark', ...loc, k }), markStr(m)));
    if ((e.staff ?? this.home) !== this.curStaff) {
      this.curStaff = e.staff ?? this.home;
      pre.push(`\\staff ${this.curStaff}`);
    }
    for (const s of e.slurStart ?? []) pre.push(`(${idStr(s.id)}${sideStr(s.side)}`);
    if (e.stem) pre.push(e.stem === 'up' ? '\\stemup' : '\\stemdown');
    let core: string;
    let tie = '';
    let arts = '';
    if (e.kind === 'note') {
      if (e.graces?.length) pre.push(...graceStrs(e.graces));
      if (e.arpeggio) pre.push('\\arp');
      if (e.noBeam) pre.push('\\nobeam');
      const ps = e.pitches.map(
        (p) => pitchStr(p.pitch) + (p.acc === 'force' ? '!' : p.acc === 'cautionary' ? '?' : ''),
      );
      // A single note's tie goes after the duration (`c4:8~`); in a chord every pitch is tied on
      // its own, inside the <> (`<c4~ e4>`), because tied and untied pitches can be mixed.
      if (e.pitches.length === 1) {
        core = ps[0];
        if (e.pitches[0].tie) tie = '~';
      } else core = `<${ps.map((x, i) => x + (e.pitches[i].tie ? '~' : '')).join(' ')}>`;
      for (const a of e.art ?? []) arts += a === 'accent' ? '->' : a === 'marcato' ? '-^' : '-.';
      if (e.art?.length && e.artSide) arts += sideStr(e.artSide);
    } else
      core = e.style === 'hidden' ? 's' : e.style === 'measure' ? 'R' : e.display ? `r@${pitchStr(e.display)}` : 'r';
    // Durations are sticky: the base value is written only when it differs from the previous event's.
    // Dots are never sticky (a dotted note would otherwise make everything after it dotted), so they
    // are always written, which also forces the base to be written.
    const d = e.dur.base !== this.lastBase || e.dur.dots ? `:${durStr(e.dur)}` : '';
    this.lastBase = e.dur.base;
    const slurEnd = (e.slurStop ?? []).map((i) => `)${idStr(i)}`).join('');
    // A slur start is glued to the token after it: `(f#2:16 ... d#2)`. Nothing that follows starts with
    // a digit, so an id like in `(2` cannot be mistaken for part of the next token.
    const toks = [...pre, tagged(this.tags, refKey({ t: 'ev', ...loc }), core + d + tie + arts + slurEnd)];
    return toks.reduce(
      (acc, t, i) => (i > 0 && /^\(\d*[\^_]?$/.test(toks[i - 1]) ? acc + t : acc ? `${acc} ${t}` : t),
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

/** Runs of grace notes with the same slash: `\\acc{d5:8 e5:8}` (struck through) or `\\grace{...}`. */
function graceStrs(gs: Grace[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < gs.length; ) {
    const slash = !!gs[i].slash;
    let j = i;
    while (j < gs.length && !!gs[j].slash === slash) j++;
    const body = gs.slice(i, j).map((g) => {
      const ps = g.pitches.map(
        (p) => pitchStr(p.pitch) + (p.acc === 'force' ? '!' : p.acc === 'cautionary' ? '?' : '') + (p.tie ? '~' : ''),
      );
      return `${ps.length === 1 ? ps[0] : `<${ps.join(' ')}>`}:${g.base}`;
    });
    out.push(`\\${slash ? 'acc' : 'grace'}{${body.join(' ')}}`);
    i = j;
  }
  return out;
}

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

function write(score: Score, tags?: Tags): string {
  const L: string[] = [];
  L.push('# music typesetter score');
  const { meta, page } = score;
  for (const k of ['title', 'subtitle', 'composer', 'rights'] as const)
    if (meta[k]) L.push(`${k} ${quote(must(meta[k]))}`);
  L.push(
    `page ${page.width}x${page.height} margin=${page.margin} space=${page.staffSpace}${page.measureNumbers ? ` numbers=${page.measureNumbers}` : ''}`,
  );
  for (const s of score.staves)
    L.push(`staff ${s.id} clef=${clefStr(s.clef)}${s.name ? ` name=${quote(s.name)}` : ''}`);
  for (const g of score.groups) L.push(`${g.kind} ${g.staves.join(' ')}`);
  L.push('');
  score.measures.forEach((m, mi) => {
    const h = [`m${mi + 1}`];
    if (m.time) h.push(`time=${m.time.beats}/${m.time.beatType}`);
    if (m.key !== undefined) h.push(`key=${m.key}`);
    if (m.breakBefore) h.push(`break=${m.breakBefore}`);
    if (m.barline) h.push(`barline=${m.barline}`);
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

// ------------------------------------------------------------------ parsing
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
function parseClef(s: string): Clef {
  const m = /^([GFC])(\d)(?:([\^_])(\d+))?$/.exec(s);
  if (!m) throw new Error(`bad clef ${s}`);
  const c: Clef = { sign: m[1] as Clef['sign'], line: Number(m[2]) };
  if (m[3]) c.octave = (m[3] === '^' ? 1 : -1) * (Number(m[4]) / 8);
  return c;
}
function parseDur(sc: Scanner): Dur {
  const m = sc.take(/\d+\.*/y);
  if (!m) sc.fail('duration expected');
  const dots = (must(m).match(/\./g) ?? []).length;
  const base = Number(must(m).replace(/\./g, ''));
  if (![1, 2, 4, 8, 16, 32, 64].includes(base)) sc.fail(`bad duration ${base}`);
  return { base: base as BaseDur, dots };
}

type Side = 'above' | 'below';
interface PendingEv {
  stem?: 'up' | 'down';
  arpeggio?: boolean;
  noBeam?: boolean;
  graces?: Grace[];
}

/**
 * Parses the items of one voice line, or of a mark line (`markLine`: only marks, each placed by an `@position`).
 * A mark in a voice line belongs to the event that follows it (or to the end of the voice's measure: `end`).
 */
function parseVoiceLine(
  line: string,
  where: string,
  home: string,
  markLine = false,
): { items: Item[]; marks: TimedMark[]; end: MarkBody[] } {
  const sc = new Scanner(line, where);
  type Frame = { kind: 'root' | 'tuplet' | 'beam' | 'tremolo'; items: Item[] };
  const stack: Frame[] = [{ kind: 'root', items: [] }];
  const top = () => stack[stack.length - 1];
  let sticky: BaseDur = 4;
  let at: number | null = markLine ? 0 : null; // explicit position (mark lines)
  let pending: MarkBody[] = [];
  let pendingSlurs: { id: number; side?: Side }[] = [];
  let pendingEv: PendingEv = {};
  let lastEv: Event | null = null;
  let curStaff = home; // set by \staff, sticky within the line
  const marks: TimedMark[] = [];
  let end: MarkBody[] = [];

  const readNP = (): NotePitch => {
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
    }
    return np;
  };
  const flush = (ev: Event | null) => {
    if (ev) {
      if (pending.length) ev.marks = [...(ev.marks ?? []), ...pending];
    } else end = pending;
    pending = [];
  };
  const num = () => {
    const n = sc.take(/\d+/y);
    return n ? Number(n) : 1;
  };
  const placement = (): Side | undefined => {
    const c = sc.peek();
    if (c === '^') {
      sc.i++;
      return 'above';
    }
    if (c === '_') {
      sc.i++;
      return 'below';
    }
    return undefined;
  };
  const withSide = <T extends object>(o: T, side?: Side): T & { placement?: Side } =>
    side ? { ...o, placement: side } : o;
  const addMark = (body: MarkBody) => {
    if (at !== null) marks.push({ ...body, tick: at } as TimedMark);
    else pending.push(body);
  };
  const open = (kind: Frame['kind'], node: TupletGroup | BeamGroup | TremoloGroup) => {
    top().items.push(node);
    stack.push({ kind, items: node.items });
  };
  const close = (kind: Frame['kind'], ch: string) => {
    sc.i++;
    if (top().kind !== kind) sc.fail(`unmatched ${ch}`);
    stack.pop();
  };

  while (!sc.eof()) {
    const c = sc.peek();
    if (c === '[') {
      sc.i++;
      open('beam', { kind: 'beam', items: [] });
      continue;
    }
    if (c === ']') {
      close('beam', ']');
      continue;
    }
    if (c === '}') {
      // closes a tuplet or a tremolo
      if (top().kind !== 'tremolo') close('tuplet', '}');
      else close('tremolo', '}');
      continue;
    }
    if (c === '@') {
      if (!markLine) sc.fail('@ only valid in mark lines');
      sc.i++;
      at = fracParse(sc.take(/[\d/]+/y) ?? sc.fail('position expected'));
      continue;
    }
    if (/\d/.test(c)) {
      // tuplet header  a:b(opts){
      const [a, b] = must(sc.take(/(\d+):(\d+)/y))
        .split(':')
        .map(Number);
      const g: TupletGroup = { kind: 'tuplet', actual: a, normal: b, items: [] };
      if (sc.peek() === '(') {
        for (const x of must(sc.take(/\([^)]*\)/y))
          .slice(1, -1)
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)) {
          if (x === 'bracket') g.bracket = true;
          else if (x === 'nobracket') g.bracket = false;
          else if (x === 'nonum') g.number = 'none';
          else if (x === 'above' || x === 'below') g.placement = x;
          else if (x.startsWith('label=')) g.label = Number(x.slice(6));
          else sc.fail(`bad tuplet option ${x}`);
        }
      }
      if (sc.take(/\{/y) === null) sc.fail('{ expected after tuplet');
      open('tuplet', g);
      continue;
    }
    const trem = sc.take(/trem(\d+)\{/y);
    if (trem) {
      open('tremolo', { kind: 'tremolo', beams: Number(trem.slice(4, -1)), items: [] });
      continue;
    }
    if (c === '(') {
      sc.i++;
      const id = num();
      const side = placement();
      pendingSlurs.push({ id, ...(side ? { side } : {}) });
      continue;
    }
    if (c === ')') {
      sc.i++;
      const id = num();
      if (!lastEv) sc.fail(') without event');
      must(lastEv).slurStop ??= [];
      must(lastEv).slurStop.push(id);
      continue;
    }
    if (c === '\\') {
      sc.i++;
      const name = sc.take(/[A-Za-z0-9]+|[<>!]/y);
      if (!name) sc.fail('command expected');
      if (DYNAMICS.has(must(name))) addMark(withSide({ type: 'dynamic', text: must(name) }, placement()));
      else if (name === '<' || name === '>')
        addMark(withSide({ type: 'hairpin', kind: name === '<' ? 'cresc' : 'dim', id: num() }, placement()));
      else if (name === '!') addMark({ type: 'stop', of: 'hairpin', id: num() });
      else if (Object.hasOwn(SIMPLE, must(name))) addMark(SIMPLE[must(name)]);
      else if (name === 'clef') {
        sc.ws();
        addMark({ type: 'clef', clef: parseClef(must(sc.take(/\S+/y))) });
      } else if (name === 'tempo') {
        sc.ws();
        const m = must(/(\d+)(\.*)=(\d+)/.exec(sc.take(/(\d+)(\.*)=(\d+)/y) ?? sc.fail('tempo like 4=115 expected')));
        const tm: MarkBody = { type: 'tempo', unit: Number(m[1]) as BaseDur, dots: m[2].length, bpm: Number(m[3]) };
        sc.ws();
        if (sc.peek() === '"') tm.text = readString(sc);
        addMark(tm);
      } else if (name === 'text') {
        sc.ws();
        addMark(withSide({ type: 'text', text: readString(sc) }, placement()));
      } else if (name === 'grace' || name === 'acc') {
        sc.ws();
        if (sc.take(/\{/y) === null) sc.fail(`{ expected after \\${name}`);
        for (;;) {
          sc.ws();
          if (sc.peek() === '}') {
            sc.i++;
            break;
          }
          const pitches: NotePitch[] = [];
          if (sc.peek() === '<') {
            sc.i++;
            for (;;) {
              sc.ws();
              if (sc.peek() === '>') {
                sc.i++;
                break;
              }
              pitches.push(readNP());
            }
            if (!pitches.length) sc.fail('empty chord');
          } else pitches.push(readNP());
          if (sc.take(/:/y) === null) sc.fail('grace note duration expected, like d5:8');
          const d = parseDur(sc);
          if (d.dots) sc.fail('grace notes cannot be dotted');
          pendingEv.graces ??= [];
          pendingEv.graces.push({ pitches, base: d.base, ...(name === 'acc' ? { slash: true } : {}) });
        }
      } else if (name === 'arp') pendingEv.arpeggio = true;
      else if (name === 'staff') {
        sc.ws();
        curStaff = sc.take(/\w+/y) ?? sc.fail('staff id expected');
      } else if (name === 'nobeam') pendingEv.noBeam = true;
      else if (name === 'stemup') pendingEv.stem = 'up';
      else if (name === 'stemdown') pendingEv.stem = 'down';
      else sc.fail(`unknown command \\${name}`);
      continue;
    }

    // ---- event. Whatever is left is a note, chord or rest; the prefixes handled above were
    // commands and brackets, which only set up state (`pendingEv`, `pendingSlurs`) for the event.
    if (markLine) sc.fail('events not allowed in mark lines');
    let ev: Event;
    const readDur = (): Dur => {
      if (sc.peek() === ':') {
        sc.i++;
        const d = parseDur(sc);
        sticky = d.base;
        return d;
      }
      return { base: sticky, dots: 0 };
    };
    if (c === 'r' || c === 's' || c === 'R') {
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
      if (pendingEv.graces) sc.fail('grace notes belong in front of a note, not a rest');
      rest.dur = readDur();
      ev = rest;
    } else {
      const ne: NoteEvent = { kind: 'note', dur: { base: 4, dots: 0 }, pitches: [] };
      if (c === '<') {
        sc.i++;
        for (;;) {
          sc.ws();
          if (sc.peek() === '>') {
            sc.i++;
            break;
          }
          ne.pitches.push(readNP());
        }
        if (!ne.pitches.length) sc.fail('empty chord');
      } else ne.pitches.push(readNP());
      ne.dur = readDur();
      if (sc.peek() === '~') {
        if (ne.pitches.length !== 1) sc.fail('tie the pitches of a chord inside <>');
        sc.i++;
        ne.pitches[0].tie = true;
      }
      for (;;) {
        const art = sc.take(/->/y) ? 'accent' : sc.take(/-\^/y) ? 'marcato' : sc.take(/-\./y) ? 'staccato' : undefined;
        if (!art) break;
        ne.art ??= [];
        ne.art.push(art);
      }
      if (ne.art) {
        const side = placement();
        if (side) ne.artSide = side;
      }
      if (pendingEv.graces) ne.graces = pendingEv.graces;
      if (pendingEv.arpeggio) ne.arpeggio = true;
      if (pendingEv.noBeam) ne.noBeam = true;
      ev = ne;
    }
    if (pendingSlurs.length) ev.slurStart = pendingSlurs;
    pendingSlurs = [];
    if (pendingEv.stem) ev.stem = pendingEv.stem;
    if (curStaff !== home) ev.staff = curStaff;
    pendingEv = {};
    flush(ev);
    top().items.push(ev);
    lastEv = ev;
  }
  if (stack.length !== 1) sc.fail('unclosed group');
  flush(null);
  const items = stack[0].items;
  return { items, marks, end };
}

function readString(sc: Scanner): string {
  const m = sc.take(/"(?:[^"\\]|\\.)*"/y);
  if (!m) sc.fail('string expected');
  return JSON.parse(must(m));
}

function kv(tokens: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (const t of tokens) {
    const i = t.indexOf('=');
    if (i > 0) o[t.slice(0, i)] = t.slice(i + 1);
  }
  return o;
}
/** split on whitespace but keep "quoted strings" together */
function tokens(line: string): string[] {
  return line.match(/(?:[^\s"]|"(?:[^"\\]|\\.)*")+/g) ?? [];
}

export function parseText(src: string): Score {
  const score: Score = {
    meta: {},
    page: { width: 210, height: 297, margin: 10, staffSpace: 1.91 },
    staves: [],
    groups: [],
    measures: [],
  };
  let cur: Measure | null = null;
  const timed = new Map<StaffMeasure, TimedMark[]>(); // positioned marks (mark lines), hung on events once the voices are known
  const lines = src.split(/\r?\n/);
  lines.forEach((raw, ln) => {
    const where = `line ${ln + 1}`;
    if (!raw.trim() || raw.trim().startsWith('#')) return;
    try {
      if (/^\s/.test(raw)) {
        if (!cur) throw new Error('voice line outside measure');
        const m = /^\s+(\w+)(?:\.(\d+)|@):\s*(.*)$/.exec(raw);
        if (!m) throw new Error('bad voice line');
        const sid = m[1];
        if (!score.staves.some((s) => s.id === sid)) throw new Error(`unknown staff ${sid}`);
        cur.staves[sid] ??= { voices: [] };
        const sm = cur.staves[sid];
        const markLine = m[2] === undefined;
        const { items, marks, end } = parseVoiceLine(m[3], where, sid, markLine);
        if (!markLine) sm.voices.push({ id: Number(m[2]), items, ...(end.length ? { end } : {}) });
        if (marks.length) (timed.get(sm) ?? must(timed.set(sm, []).get(sm))).push(...marks);
        return;
      }
      const t = tokens(raw.trim());
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
        };
      } else if (head === 'staff') {
        const o = kv(t.slice(2));
        score.staves.push({
          id: t[1],
          clef: parseClef(o.clef ?? 'G2'),
          ...(o.name ? { name: JSON.parse(o.name) } : {}),
        });
      } else if (head === 'brace' || head === 'bracket') score.groups.push({ kind: head, staves: t.slice(1) });
      else if (/^m\d+$/.test(head)) {
        const o = kv(t.slice(1));
        cur = { staves: {} }; // the number in `m<N>` is only a label
        if (o.time) {
          const [b, bt] = o.time.split('/').map(Number);
          cur.time = { beats: b, beatType: bt };
        }
        if (o.key !== undefined) cur.key = Number(o.key);
        if (o.break) cur.breakBefore = o.break as 'system' | 'page';
        if (o.barline) cur.barline = o.barline as Measure['barline'];
        score.measures.push(cur);
      } else throw new Error(`unknown statement ${head}`);
    } catch (e) {
      throw new Error(`${where}: ${(e as Error).message}`);
    }
  });
  for (const m of score.measures)
    for (const sm of Object.values(m.staves)) {
      sm.voices.sort((a, b) => a.id - b.id);
      const tm = timed.get(sm);
      if (tm)
        anchorMarks(
          sm,
          tm.sort((a, b) => a.tick - b.tick),
        );
    }
  return score;
}
