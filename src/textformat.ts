// Human-readable text format <-> Score.   See FORMAT.md for the grammar.
import {
  PPQ, STEPS, gcd, baseTicks, flattenVoice, isBeam, isTuplet, measureTicks, timeAt,
  type Score, type Item, type Event, type NoteEvent, type RestEvent, type Dur, type BaseDur, type Mark, type Clef,
  type Pitch, type NotePitch, type Voice, type TupletGroup, type BeamGroup, type Measure, type Articulation, type StaffMeasure,
  type MarkBody,
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

function markStr(m: MarkBody): string {
  const pl = (p?: string) => (p === 'above' ? '^' : p === 'below' ? '_' : '');
  switch (m.type) {
    case 'dynamic': return `\\${m.text}${pl(m.placement)}`;
    case 'hairpin': return `\\${m.kind === 'cresc' ? '<' : '>'}${m.id !== 1 ? m.id : ''}${pl(m.placement)}`;
    case 'hairpin-stop': return `\\!${m.id !== 1 ? m.id : ''}`;
    case 'pedal-start': return '\\ped';
    case 'pedal-stop': return '\\unped';
    case 'ottava-start': return m.dir === 'up' ? '\\8va' : '\\8vb';
    case 'ottava-stop': return '\\8off';
    case 'clef': return `\\clef ${clefStr(m.clef)}`;
    case 'tempo': return `\\tempo ${m.unit}${'.'.repeat(m.dots)}=${m.bpm}${m.text ? ' ' + quote(m.text) : ''}`;
    case 'text': return `\\text ${quote(m.text)}${pl(m.placement)}`;
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
    for (const s of e.slurStart ?? []) pre.push('(' + (s.id !== 1 ? s.id : '') + (s.side === 'above' ? '^' : s.side === 'below' ? '_' : ''));
    if (e.stem) pre.push(e.stem === 'up' ? '\\stemup' : '\\stemdown');
    let core: string;
    let post = '';
    if (e.kind === 'note') {
      if (e.arpeggio) pre.push('\\arp');
      if (e.tremolo2) pre.push(e.tremolo2.role === 'start' ? `\\trem${e.tremolo2.beams}` : '\\tremend');
      const allTied = e.pitches.length > 0 && e.pitches.every((p) => p.tie);
      const ps = e.pitches.map((p) => pitchStr(p.pitch) + (p.acc === 'force' ? '!' : p.acc === 'cautionary' ? '?' : '') + (!allTied && p.tie ? '~' : ''));
      core = e.pitches.length === 1 ? ps[0] : `<${ps.join(' ')}>`;
      if (allTied) post += '~';
      for (const a of e.art ?? []) post += a === 'accent' ? '->' : a === 'marcato' ? '-^' : '-.';
      if (e.art?.length && e.artSide) post += e.artSide === 'above' ? '^' : '_';
    } else core = e.hidden ? 's' : e.measure ? 'R' : e.display ? `r@${pitchStr(e.display)}` : 'r';
    // duration (sticky, base only; dots always written)
    let d = '';
    if (e.dur.base !== this.lastBase || e.dur.dots) d = ':' + durStr(e.dur);
    this.lastBase = e.dur.base;
    // tie marker must follow the duration
    const slurEnd = (e.slurStop ?? []).map((i) => ')' + (i !== 1 ? i : '')).join('');
    const tie = post.startsWith('~') ? '~' : '';
    const rest = tie ? post.slice(1) : post;
    return [...pre, core + d + tie + rest + slurEnd].join(' ');
  }

  items(items: Item[]): void {
    for (const it of items) {
      if (isTuplet(it)) {
        const o: string[] = [];
        if (it.bracket === true) o.push('bracket'); else if (it.bracket === false) o.push('nobracket');
        if (it.number === 'none') o.push('nonum');
        if (it.placement) o.push(it.placement);
        if (it.label !== undefined) o.push(`label=${it.label}`);
        this.out.push(`${it.actual}:${it.normal}${o.length ? `(${o.join(',')})` : ''}{`);
        this.items(it.items);
        this.out.push('}');
      } else if (isBeam(it)) {
        this.out.push('[');
        this.items(it.items);
        this.out.push(']');
      } else this.out.push(this.eventStr(it));
    }
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
    const h = [`m${m.number}`];
    if (m.time) h.push(`time=${m.time.beats}/${m.time.beatType}`);
    if (m.key !== undefined) h.push(`key=${m.key}`);
    if (m.breakBefore) h.push(`break=${m.breakBefore}`);
    if (m.barline) h.push(`barline=${m.barline}`);
    L.push(h.join(' '));
    for (const s of score.staves) {
      const sm = m.staves[s.id];
      if (sm) writeStaffMeasure(sm, s.id, L);
    }
    void mi;
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

function parseVoiceLine(line: string, where: string, marksOut: Mark[]): Item[] {
  const sc = new Scanner(line, where);
  type Frame = { kind: 'root' | 'tuplet' | 'beam'; items: Item[]; node?: TupletGroup | BeamGroup };
  const stack: Frame[] = [{ kind: 'root', items: [] }];
  const top = () => stack[stack.length - 1];
  let sticky: BaseDur = 4;
  let tick = 0;
  let pending: MarkBody[] = [];
  let pendingSlurs: { id: number; side?: 'above' | 'below' }[] = [];
  let pendingEv: Partial<NoteEvent & RestEvent> = {};
  let lastEv: Event | null = null;
  // time-modification stack for tick tracking
  const tmStack: [number, number][] = [];
  const flush = () => { for (const p of pending) marksOut.push({ ...p, tick } as Mark); pending = []; };

  const evTicks = (d: Dur) => {
    let t = baseTicks(d);
    for (const [a, n] of tmStack) t = (t * n) / a;
    return t;
  };
  const placement = (): 'above' | 'below' | undefined => {
    const c = sc.peek();
    if (c === '^') { sc.i++; return 'above'; }
    if (c === '_') { sc.i++; return 'below'; }
    return undefined;
  };

  while (!sc.eof()) {
    const c = sc.peek();
    if (c === '[') { sc.i++; const g: BeamGroup = { kind: 'beam', items: [] }; top().items.push(g); stack.push({ kind: 'beam', items: g.items, node: g }); continue; }
    if (c === ']') { sc.i++; if (top().kind !== 'beam') sc.fail('unmatched ]'); stack.pop(); continue; }
    if (c === '}') { sc.i++; if (top().kind !== 'tuplet') sc.fail('unmatched }'); stack.pop(); tmStack.pop(); continue; }
    if (/\d/.test(c)) { // tuplet header  a:b(opts){
      const h = sc.take(/(\d+):(\d+)/y)!;
      const [a, b] = h.split(':').map(Number);
      const g: TupletGroup = { kind: 'tuplet', actual: a, normal: b, items: [] };
      if (sc.peek() === '(') {
        const o = sc.take(/\([^)]*\)/y)!.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean);
        for (const x of o) {
          if (x === 'bracket') g.bracket = true; else if (x === 'nobracket') g.bracket = false;
          else if (x === 'nonum') g.number = 'none';
          else if (x === 'above' || x === 'below') g.placement = x;
          else if (x.startsWith('label=')) g.label = Number(x.slice(6));
          else sc.fail(`bad tuplet option ${x}`);
        }
      }
      if (sc.take(/\{/y) === null) sc.fail('{ expected after tuplet');
      top().items.push(g);
      stack.push({ kind: 'tuplet', items: g.items, node: g });
      tmStack.push([a, b]);
      continue;
    }
    if (c === '(') {
      sc.i++;
      const num = sc.take(/\d+/y);
      const side = placement();
      pendingSlurs.push({ id: num ? Number(num) : 1, ...(side ? { side } : {}) });
      continue;
    }
    if (c === ')') {
      sc.i++;
      const num = sc.take(/\d+/y);
      if (!lastEv) sc.fail(') without event');
      (lastEv!.slurStop ??= []).push(num ? Number(num) : 1);
      continue;
    }
    if (c === '\\') {
      sc.i++;
      const name = sc.take(/[A-Za-z0-9]+|[<>!]/y);
      if (!name) sc.fail('command expected');
      if (DYNAMICS.has(name!)) { const p = placement(); pending.push({ type: 'dynamic', text: name!, ...(p ? { placement: p } : {}) }); }
      else if (name === '<' || name === '>') {
        const num = sc.take(/\d+/y); const p = placement();
        pending.push({ type: 'hairpin', kind: name === '<' ? 'cresc' : 'dim', id: num ? Number(num) : 1, ...(p ? { placement: p } : {}) });
      } else if (name === '!') { const num = sc.take(/\d+/y); pending.push({ type: 'hairpin-stop', id: num ? Number(num) : 1 }); }
      else if (name === 'ped') pending.push({ type: 'pedal-start' });
      else if (name === 'unped') pending.push({ type: 'pedal-stop' });
      else if (name === '8va') pending.push({ type: 'ottava-start', dir: 'up' });
      else if (name === '8vb') pending.push({ type: 'ottava-start', dir: 'down' });
      else if (name === '8off') pending.push({ type: 'ottava-stop' });
      else if (name === 'clef') { sc.ws(); pending.push({ type: 'clef', clef: parseClef(sc.take(/\S+/y)!) }); }
      else if (name === 'tempo') {
        sc.ws();
        const m = sc.take(/(\d+)(\.*)=(\d+)/y);
        if (!m) sc.fail('tempo like 4=115 expected');
        const mm = /(\d+)(\.*)=(\d+)/.exec(m!)!;
        const tm: Mark = { type: 'tempo', unit: Number(mm[1]) as BaseDur, dots: mm[2].length, bpm: Number(mm[3]), tick };
        sc.ws();
        if (sc.peek() === '"') tm.text = readString(sc);
        pending.push(tm);
      } else if (name === 'text') {
        sc.ws(); const str = readString(sc); const p = placement();
        pending.push({ type: 'text', text: str, ...(p ? { placement: p } : {}) });
      } else if (name === 'arp') pendingEv.arpeggio = true;
      else if (name === 'stemup') pendingEv.stem = 'up';
      else if (name === 'stemdown') pendingEv.stem = 'down';
      else if (name === 'tremend') pendingEv.tremolo2 = { role: 'stop', beams: 2 };
      else if (/^trem\d$/.test(name!)) pendingEv.tremolo2 = { role: 'start', beams: Number(name!.slice(4)) };
      else sc.fail(`unknown command \\${name}`);
      continue;
    }
    if (c === '@') { sc.fail('@ only valid in mark lines'); }

    // ---- event
    let ev: Event;
    const readDur = (): Dur => {
      if (sc.peek() === ':') { sc.i++; const d = parseDur(sc); sticky = d.base; return d; }
      return { base: sticky, dots: 0 };
    };
    if (c === 'r' || c === 's' || c === 'R') {
      sc.i++;
      const rest: RestEvent = { kind: 'rest', dur: { base: 4, dots: 0 } };
      if (c === 's') rest.hidden = true;
      if (c === 'R') rest.measure = true;
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
      } else ne.pitches.push(readNP());
      ne.dur = readDur();
      if (sc.peek() === '~') { sc.i++; for (const p of ne.pitches) p.tie = true; }
      for (;;) {
        if (sc.take(/->/y)) (ne.art ??= []).push('accent' as Articulation);
        else if (sc.take(/-\^/y)) (ne.art ??= []).push('marcato');
        else if (sc.take(/-\./y)) (ne.art ??= []).push('staccato');
        else break;
      }
      if (ne.art) { if (sc.take(/\^/y)) ne.artSide = 'above'; else if (sc.take(/_/y)) ne.artSide = 'below'; }
      ev = ne;
    }
    if (pendingSlurs.length) ev.slurStart = pendingSlurs;
    pendingSlurs = [];
    if (pendingEv.stem) ev.stem = pendingEv.stem;
    if (ev.kind === 'note') {
      if (pendingEv.arpeggio) ev.arpeggio = true;
      if (pendingEv.tremolo2) ev.tremolo2 = pendingEv.tremolo2;
    }
    pendingEv = {};
    flush();
    top().items.push(ev);
    lastEv = ev;
    tick += evTicks(ev.dur);
  }
  if (stack.length !== 1) sc.fail('unclosed group');
  flush();
  return stack[0].items;
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
        if (m[2] !== undefined) {
          const marks: Mark[] = [];
          const v: Voice = { id: Number(m[2]), items: parseVoiceLine(m[3], where, marks) };
          sm.voices.push(v);
          sm.marks.push(...marks);
        } else { // mark line: @pos \mark ...
          const sc = new Scanner(m[3], where);
          let tick = 0;
          const pend: Mark[] = [];
          while (!sc.eof()) {
            if (sc.peek() === '@') { sc.i++; tick = fracParse(sc.take(/[\d/]+/y)!); continue; }
            const rest = m[3].slice(sc.i);
            const end = rest.search(/\s@/);
            const chunk = end < 0 ? rest : rest.slice(0, end);
            const mk: Mark[] = [];
            const tmp = parseVoiceLine(chunk, where, mk);
            if (tmp.length) throw new Error('events not allowed in mark line');
            for (const x of mk) pend.push({ ...x, tick });
            sc.i += chunk.length;
          }
          sm.marks.push(...pend);
        }
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
        cur = { number: Number(head.slice(1)), staves: {} };
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
  void STEPS; void measureTicks; void timeAt;
  return score;
}
