// Human-readable text format <-> Score.   See FORMAT.md for the grammar.
import {
  PPQ, gcd, flattenVoice, isBeam, isTuplet, isTremolo,
  type Score, type Item, type Event, type NoteEvent, type RestEvent, type Dur, type BaseDur, type Mark, type Clef,
  type Pitch, type NotePitch, type TupletGroup, type BeamGroup, type TremoloGroup, type Measure, type StaffMeasure,
  type MarkBody, type Placement,
} from './model.ts';

const DYNAMICS = new Set(['pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'ffff', 'sf', 'sfz', 'sfp', 'sfpp', 'fp', 'fz', 'rf', 'rfz', 'pf', 'n', 'z']);

// ------------------------------------------------------------------ writing

function fracStr(tick: number): string {
  if (tick === 0) return '0';
  const g = gcd(tick, PPQ);
  const n = tick / g, d = PPQ / g;
  return d === 1 ? String(n) : `${n}/${d}`;
}
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
function durStr(d: Dur): string { return `${d.base}${'.'.repeat(d.dots)}`; }
function quote(s: string): string { return JSON.stringify(s); }

const sideStr = (p?: Placement) => (p === 'above' ? '^' : p === 'below' ? '_' : '');
const idStr = (n: number | undefined) => (n && n !== 1 ? String(n) : ''); // overlap numbers: 1 is implicit

// Marks without arguments; the writer looks them up by value, the parser by name.
const SIMPLE: Record<string, MarkBody> = {
  ped: { type: 'pedal' }, unped: { type: 'stop', of: 'pedal' },
  '8va': { type: 'ottava', dir: 'up' }, '8vb': { type: 'ottava', dir: 'down' }, '8off': { type: 'stop', of: 'ottava' },
};
const simpleKey = (m: MarkBody) => JSON.stringify([m.type, 'of' in m ? m.of : '', 'dir' in m ? m.dir : '']);
const SIMPLE_NAME = new Map(Object.entries(SIMPLE).map(([name, m]) => [simpleKey(m), name]));

function markStr(m: MarkBody): string {
  switch (m.type) {
    case 'dynamic': return `\\${m.text}${sideStr(m.placement)}`;
    case 'hairpin': return `\\${m.kind === 'cresc' ? '<' : '>'}${idStr(m.id)}${sideStr(m.placement)}`;
    case 'stop': if (m.of === 'hairpin') return `\\!${idStr(m.id)}`; return `\\${SIMPLE_NAME.get(simpleKey(m))}`;
    case 'pedal': case 'ottava': return `\\${SIMPLE_NAME.get(simpleKey(m))}`;
    case 'clef': return `\\clef ${clefStr(m.clef)}`;
    case 'tempo': return `\\tempo ${m.unit}${'.'.repeat(m.dots)}=${m.bpm}${m.text ? ' ' + quote(m.text) : ''}`;
    case 'text': return `\\text ${quote(m.text)}${sideStr(m.placement)}`;
  }
}

class VoiceWriter {
  out: string[] = [];
  lastBase: BaseDur | 0 = 0;
  marksAt: Map<number, string[]>;
  flat: ReturnType<typeof flattenVoice>;
  eventIdx = 0;
  constructor(marksAt: Map<number, string[]>, flat: ReturnType<typeof flattenVoice>) { this.marksAt = marksAt; this.flat = flat; }

  eventStr(e: Event): string {
    const pre: string[] = [];
    const t = this.flat[this.eventIdx++].start;
    const mk = this.marksAt.get(t);
    if (mk) { pre.push(...mk); this.marksAt.delete(t); }
    for (const s of e.slurStart ?? []) pre.push('(' + idStr(s.id) + sideStr(s.side));
    if (e.stem) pre.push(e.stem === 'up' ? '\\stemup' : '\\stemdown');
    let core: string;
    let tie = '';
    let arts = '';
    if (e.kind === 'note') {
      if (e.arpeggio) pre.push('\\arp');
      if (e.noBeam) pre.push('\\nobeam');
      const ps = e.pitches.map((p) => pitchStr(p.pitch) + (p.acc === 'force' ? '!' : p.acc === 'cautionary' ? '?' : ''));
      if (e.pitches.length === 1) { core = ps[0]; if (e.pitches[0].tie) tie = '~'; } // a chord ties per pitch, inside <>
      else core = `<${ps.map((x, i) => x + (e.pitches[i].tie ? '~' : '')).join(' ')}>`;
      for (const a of e.art ?? []) arts += a === 'accent' ? '->' : a === 'marcato' ? '-^' : '-.';
      if (e.art?.length && e.artSide) arts += sideStr(e.artSide);
    } else core = e.style === 'hidden' ? 's' : e.style === 'measure' ? 'R' : e.display ? `r@${pitchStr(e.display)}` : 'r';
    // duration (sticky, base only; dots always written)
    const d = e.dur.base !== this.lastBase || e.dur.dots ? ':' + durStr(e.dur) : '';
    this.lastBase = e.dur.base;
    const slurEnd = (e.slurStop ?? []).map((i) => ')' + idStr(i)).join('');
    return [...pre, core + d + tie + arts + slurEnd].join(' ');
  }

  items(items: Item[]): void {
    for (const it of items) {
      if (isTuplet(it)) {
        const o: string[] = [];
        if (it.bracket === true) o.push('bracket'); else if (it.bracket === false) o.push('nobracket');
        if (it.number === 'none') o.push('nonum');
        if (it.placement) o.push(it.placement);
        if (it.label !== undefined) o.push(`label=${it.label}`);
        this.group(`${it.actual}:${it.normal}${o.length ? `(${o.join(',')})` : ''}{`, '}', it.items);
      } else if (isBeam(it)) this.group('[', ']', it.items);
      else if (isTremolo(it)) this.group(`trem${it.beams}{`, '}', it.items);
      else this.out.push(this.eventStr(it));
    }
  }
  group(open: string, close: string, items: Item[]): void {
    this.out.push(open);
    this.items(items);
    this.out.push(close);
  }
}

function writeStaffMeasure(sm: StaffMeasure, sid: string, lines: string[]): void {
  const flats = sm.voices.map((v) => flattenVoice(v));
  // assign marks to a voice that has an event boundary at that tick
  const perVoice: Map<number, string[]>[] = sm.voices.map(() => new Map());
  const orphans: Mark[] = [];
  for (const m of sm.marks) {
    let placed = false;
    for (let vi = 0; vi < sm.voices.length && !placed; vi++) {
      const f = flats[vi];
      const ok = f.some((e) => e.start === m.tick) || (f.length > 0 && f[f.length - 1].start + f[f.length - 1].ticks === m.tick);
      if (ok) { (perVoice[vi].get(m.tick) ?? perVoice[vi].set(m.tick, []).get(m.tick)!).push(markStr(m)); placed = true; }
    }
    if (!placed) orphans.push(m);
  }
  sm.voices.forEach((v, vi) => {
    const w = new VoiceWriter(perVoice[vi], flats[vi]);
    w.items(v.items);
    const endT = flats[vi].length ? flats[vi][flats[vi].length - 1].start + flats[vi][flats[vi].length - 1].ticks : 0;
    const tail = perVoice[vi].get(endT);
    if (tail) w.out.push(...tail);
    lines.push(`  ${sid}.${v.id}: ${w.out.join(' ')}`);
  });
  if (orphans.length) lines.push(`  ${sid}@: ${orphans.map((m) => `@${fracStr(m.tick)} ${markStr(m)}`).join(' ')}`);
}

export function writeText(score: Score): string {
  const L: string[] = [];
  L.push('# music typesetter score');
  const { meta, page } = score;
  for (const k of ['title', 'subtitle', 'composer', 'rights'] as const) if (meta[k]) L.push(`${k} ${quote(meta[k]!)}`);
  L.push(`page ${page.width}x${page.height} margin=${page.margin} space=${page.staffSpace}`);
  for (const s of score.staves) L.push(`staff ${s.id} clef=${clefStr(s.clef)}${s.name ? ` name=${quote(s.name)}` : ''}`);
  for (const g of score.groups) L.push(`${g.kind} ${g.staves.join(' ')}`);
  L.push('');
  score.measures.forEach((m, mi) => {
    const h = [`m${mi + 1}`];
    if (m.time) h.push(`time=${m.time.beats}/${m.time.beatType}`);
    if (m.key !== undefined) h.push(`key=${m.key}`);
    if (m.breakBefore) h.push(`break=${m.breakBefore}`);
    if (m.barline) h.push(`barline=${m.barline}`);
    L.push(h.join(' '));
    for (const s of score.staves) {
      const sm = m.staves[s.id];
      if (sm) writeStaffMeasure(sm, s.id, L);
    }
  });
  return L.join('\n') + '\n';
}

// ------------------------------------------------------------------ parsing

class Scanner {
  i = 0;
  s: string;
  where: string;
  constructor(s: string, where: string) { this.s = s; this.where = where; }
  eof(): boolean { this.ws(); return this.i >= this.s.length; }
  ws(): void { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++; }
  peek(): string { return this.s[this.i] ?? ''; }
  take(re: RegExp): string | null {
    re.lastIndex = this.i;
    const m = re.exec(this.s);
    if (!m || m.index !== this.i) return null;
    this.i += m[0].length;
    return m[0];
  }
  fail(msg: string): never { throw new Error(`${this.where}: ${msg} at "${this.s.slice(this.i, this.i + 20)}"`); }
}

function parsePitch(sc: Scanner): Pitch {
  const m = sc.take(/[a-g][#b]*-?\d/y);
  if (!m) sc.fail('pitch expected');
  const step = m![0] as Pitch['step'];
  const rest = m!.slice(1);
  const octave = Number(rest.match(/-?\d$/)![0]);
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
  const dots = (m!.match(/\./g) ?? []).length;
  const base = Number(m!.replace(/\./g, ''));
  if (![1, 2, 4, 8, 16, 32, 64].includes(base)) sc.fail(`bad duration ${base}`);
  return { base: base as BaseDur, dots };
}

type Side = 'above' | 'below';
interface PendingEv { stem?: 'up' | 'down'; arpeggio?: boolean; noBeam?: boolean }

/**
 * Parses the items of one voice line, or of a mark line (`markLine`: only marks, each placed by an `@position`).
 * A mark in a voice line belongs to the event that follows it (or to the end of the measure); its tick is
 * resolved afterwards from the parsed tree, so tuplet arithmetic lives in `flattenVoice` only.
 */
function parseVoiceLine(line: string, where: string, markLine = false): { items: Item[]; marks: Mark[] } {
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
  const marks: Mark[] = [];
  const later: { body: MarkBody; ev: Event | null }[] = [];

  const flush = (ev: Event | null) => { for (const body of pending) later.push({ body, ev }); pending = []; };
  const num = () => { const n = sc.take(/\d+/y); return n ? Number(n) : 1; };
  const placement = (): Side | undefined => {
    const c = sc.peek();
    if (c === '^') { sc.i++; return 'above'; }
    if (c === '_') { sc.i++; return 'below'; }
    return undefined;
  };
  const withSide = <T extends object>(o: T, side?: Side): T & { placement?: Side } => (side ? { ...o, placement: side } : o);
  const addMark = (body: MarkBody) => { if (at !== null) marks.push({ ...body, tick: at } as Mark); else pending.push(body); };
  const open = (kind: Frame['kind'], node: TupletGroup | BeamGroup | TremoloGroup) => { top().items.push(node); stack.push({ kind, items: node.items }); };
  const close = (kind: Frame['kind'], ch: string) => { sc.i++; if (top().kind !== kind) sc.fail(`unmatched ${ch}`); stack.pop(); };

  while (!sc.eof()) {
    const c = sc.peek();
    if (c === '[') { sc.i++; open('beam', { kind: 'beam', items: [] }); continue; }
    if (c === ']') { close('beam', ']'); continue; }
    if (c === '}') { // closes a tuplet or a tremolo
      if (top().kind !== 'tremolo') close('tuplet', '}'); else close('tremolo', '}');
      continue;
    }
    if (c === '@') {
      if (!markLine) sc.fail('@ only valid in mark lines');
      sc.i++;
      at = fracParse(sc.take(/[\d/]+/y) ?? sc.fail('position expected'));
      continue;
    }
    if (/\d/.test(c)) { // tuplet header  a:b(opts){
      const [a, b] = sc.take(/(\d+):(\d+)/y)!.split(':').map(Number);
      const g: TupletGroup = { kind: 'tuplet', actual: a, normal: b, items: [] };
      if (sc.peek() === '(') {
        for (const x of sc.take(/\([^)]*\)/y)!.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean)) {
          if (x === 'bracket') g.bracket = true; else if (x === 'nobracket') g.bracket = false;
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
    if (trem) { open('tremolo', { kind: 'tremolo', beams: Number(trem.slice(4, -1)), items: [] }); continue; }
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
      (lastEv!.slurStop ??= []).push(id);
      continue;
    }
    if (c === '\\') {
      sc.i++;
      const name = sc.take(/[A-Za-z0-9]+|[<>!]/y);
      if (!name) sc.fail('command expected');
      if (DYNAMICS.has(name!)) addMark(withSide({ type: 'dynamic', text: name! }, placement()));
      else if (name === '<' || name === '>') addMark(withSide({ type: 'hairpin', kind: name === '<' ? 'cresc' : 'dim', id: num() }, placement()));
      else if (name === '!') addMark({ type: 'stop', of: 'hairpin', id: num() });
      else if (Object.hasOwn(SIMPLE, name!)) addMark(SIMPLE[name!]);
      else if (name === 'clef') { sc.ws(); addMark({ type: 'clef', clef: parseClef(sc.take(/\S+/y)!) }); }
      else if (name === 'tempo') {
        sc.ws();
        const m = /(\d+)(\.*)=(\d+)/.exec(sc.take(/(\d+)(\.*)=(\d+)/y) ?? sc.fail('tempo like 4=115 expected'))!;
        const tm: MarkBody = { type: 'tempo', unit: Number(m[1]) as BaseDur, dots: m[2].length, bpm: Number(m[3]) };
        sc.ws();
        if (sc.peek() === '"') tm.text = readString(sc);
        addMark(tm);
      } else if (name === 'text') { sc.ws(); addMark(withSide({ type: 'text', text: readString(sc) }, placement())); }
      else if (name === 'arp') pendingEv.arpeggio = true;
      else if (name === 'nobeam') pendingEv.noBeam = true;
      else if (name === 'stemup') pendingEv.stem = 'up';
      else if (name === 'stemdown') pendingEv.stem = 'down';
      else sc.fail(`unknown command \\${name}`);
      continue;
    }

    // ---- event
    if (markLine) sc.fail('events not allowed in mark lines');
    let ev: Event;
    const readDur = (): Dur => {
      if (sc.peek() === ':') { sc.i++; const d = parseDur(sc); sticky = d.base; return d; }
      return { base: sticky, dots: 0 };
    };
    if (c === 'r' || c === 's' || c === 'R') {
      sc.i++;
      const rest: RestEvent = { kind: 'rest', style: c === 's' ? 'hidden' : c === 'R' ? 'measure' : 'normal', dur: { base: 4, dots: 0 } };
      if (c === 'r' && sc.peek() === '@') { sc.i++; rest.display = parsePitch(sc); }
      rest.dur = readDur();
      ev = rest;
    } else {
      const ne: NoteEvent = { kind: 'note', dur: { base: 4, dots: 0 }, pitches: [] };
      const readNP = (): NotePitch => {
        const np: NotePitch = { pitch: parsePitch(sc) };
        if (sc.peek() === '!') { sc.i++; np.acc = 'force'; } else if (sc.peek() === '?') { sc.i++; np.acc = 'cautionary'; }
        if (sc.peek() === '~') { sc.i++; np.tie = true; }
        return np;
      };
      if (c === '<') {
        sc.i++;
        for (;;) { sc.ws(); if (sc.peek() === '>') { sc.i++; break; } ne.pitches.push(readNP()); }
        if (!ne.pitches.length) sc.fail('empty chord');
      } else ne.pitches.push(readNP());
      ne.dur = readDur();
      if (sc.peek() === '~') {
        if (ne.pitches.length !== 1) sc.fail('tie the pitches of a chord inside <>');
        sc.i++; ne.pitches[0].tie = true;
      }
      for (;;) {
        if (sc.take(/->/y)) (ne.art ??= []).push('accent');
        else if (sc.take(/-\^/y)) (ne.art ??= []).push('marcato');
        else if (sc.take(/-\./y)) (ne.art ??= []).push('staccato');
        else break;
      }
      if (ne.art) { const side = placement(); if (side) ne.artSide = side; }
      if (pendingEv.arpeggio) ne.arpeggio = true;
      if (pendingEv.noBeam) ne.noBeam = true;
      ev = ne;
    }
    if (pendingSlurs.length) ev.slurStart = pendingSlurs;
    pendingSlurs = [];
    if (pendingEv.stem) ev.stem = pendingEv.stem;
    pendingEv = {};
    flush(ev);
    top().items.push(ev);
    lastEv = ev;
  }
  if (stack.length !== 1) sc.fail('unclosed group');
  flush(null);
  const items = stack[0].items;
  if (later.length) {
    const flat = flattenVoice({ id: 0, items });
    const start = new Map(flat.map((t) => [t.ev, t.start]));
    const end = flat.length ? flat[flat.length - 1].start + flat[flat.length - 1].ticks : 0;
    for (const { body, ev } of later) marks.push({ ...body, tick: ev ? start.get(ev)! : end } as Mark);
  }
  return { items, marks };
}

function readString(sc: Scanner): string {
  const m = sc.take(/"(?:[^"\\]|\\.)*"/y);
  if (!m) sc.fail('string expected');
  return JSON.parse(m!);
}

function kv(tokens: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (const t of tokens) { const i = t.indexOf('='); if (i > 0) o[t.slice(0, i)] = t.slice(i + 1); }
  return o;
}
/** split on whitespace but keep "quoted strings" together */
function tokens(line: string): string[] {
  return line.match(/(?:[^\s"]|"(?:[^"\\]|\\.)*")+/g) ?? [];
}

export function parseText(src: string): Score {
  const score: Score = { meta: {}, page: { width: 210, height: 297, margin: 10, staffSpace: 1.91 }, staves: [], groups: [], measures: [] };
  let cur: Measure | null = null;
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
        const sm = (cur.staves[sid] ??= { voices: [], marks: [] });
        const markLine = m[2] === undefined;
        const { items, marks } = parseVoiceLine(m[3], where, markLine);
        if (!markLine) sm.voices.push({ id: Number(m[2]), items });
        sm.marks.push(...marks);
        return;
      }
      const t = tokens(raw.trim());
      const head = t[0];
      if (head === 'title' || head === 'subtitle' || head === 'composer' || head === 'rights') score.meta[head] = JSON.parse(t[1]);
      else if (head === 'page') {
        const [w, h] = t[1].split('x').map(Number);
        const o = kv(t.slice(2));
        score.page = { width: w, height: h, margin: Number(o.margin ?? 10), staffSpace: Number(o.space ?? 1.91) };
      } else if (head === 'staff') {
        const o = kv(t.slice(2));
        score.staves.push({ id: t[1], clef: parseClef(o.clef ?? 'G2'), ...(o.name ? { name: JSON.parse(o.name) } : {}) });
      } else if (head === 'brace' || head === 'bracket') score.groups.push({ kind: head, staves: t.slice(1) });
      else if (/^m\d+$/.test(head)) {
        const o = kv(t.slice(1));
        cur = { staves: {} }; // the number in `m<N>` is only a label
        if (o.time) { const [b, bt] = o.time.split('/').map(Number); cur.time = { beats: b, beatType: bt }; }
        if (o.key !== undefined) cur.key = Number(o.key);
        if (o.break) cur.breakBefore = o.break as 'system' | 'page';
        if (o.barline) cur.barline = o.barline as Measure['barline'];
        score.measures.push(cur);
      } else throw new Error(`unknown statement ${head}`);
    } catch (e) {
      throw new Error(`${where}: ${(e as Error).message}`);
    }
  });
  for (const m of score.measures) for (const sm of Object.values(m.staves)) { sm.voices.sort((a, b) => a.id - b.id); sm.marks.sort((a, b) => a.tick - b.tick); }
  return score;
}
