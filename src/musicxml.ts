// MusicXML (partwise) -> Score
import { parseXml, child, children, text, type XNode } from './xml.ts';
import {
  PPQ, STEPS, baseTicks, measureTicks,
  type Score, type Measure, type Item, type Event, type NoteEvent, type RestEvent,
  type Dur, type BaseDur, type Clef, type Mark, type TupletGroup, type BeamGroup, type Step, type StaffDef,
  type Articulation, type Pitch, type TimeSig,
} from './model.ts';
import { beatTicks, simplifyBeams, simplifyTupletBrackets } from './beams.ts';

export interface ImportOptions { keepStems?: boolean; keepBreaks?: boolean; warn?: (msg: string) => void }

const TYPE_BASE: Record<string, BaseDur> = { whole: 1, half: 2, quarter: 4, eighth: 8, '16th': 16, '32nd': 32, '64th': 64 };

export function ticksToDur(t: number): Dur | null {
  for (const base of [1, 2, 4, 8, 16, 32, 64] as BaseDur[])
    for (let dots = 0; dots <= 3; dots++) if (baseTicks({ base, dots }) === t) return { base, dots };
  return null;
}

interface RawNote {
  tick: number; ticks: number; staff: number; voice: number;
  ev: Event;
  tmRatio?: [number, number]; // actual, normal
  tupStart?: { bracket?: boolean; number?: 'none'; placement?: 'above' | 'below'; label?: number }[];
  tupStop: number;
  beam1?: string;
  trem?: { role: 'start' | 'stop'; beams: number };
}

export function importMusicXml(xml: string, opts: ImportOptions = {}): Score {
  const warn = opts.warn ?? (() => {});
  const root = parseXml(xml);
  if (root.tag !== 'score-partwise') throw new Error('only score-partwise MusicXML is supported');

  // ---- metadata & page
  const meta: Score['meta'] = {};
  for (const c of children(root, 'credit')) {
    const type = text(c, 'credit-type');
    const words = children(c, 'credit-words').map((w) => w.text.trim()).join(' ');
    if (!words) continue;
    if (type === 'title' && !meta.title) meta.title = words;
    else if (type === 'subtitle' && !meta.subtitle) meta.subtitle = words;
    else if (type === 'composer' && !meta.composer) meta.composer = words;
    else if (type === 'rights' && !meta.rights) meta.rights = words;
  }
  meta.title ??= text(child(root, 'work'), 'work-title');
  meta.composer ??= root.children.find((c) => c.tag === 'identification')?.children.find((c) => c.tag === 'creator' && c.attrs.type === 'composer')?.text.trim();
  meta.rights ??= text(child(root, 'identification'), 'rights');

  const defaults = child(root, 'defaults');
  const mm = Number(text(child(defaults, 'scaling'), 'millimeters') ?? 7);
  const tenths = Number(text(child(defaults, 'scaling'), 'tenths') ?? 40);
  const mmPerTenth = mm / tenths;
  const pl = child(defaults, 'page-layout');
  const pw = Number(text(pl, 'page-width') ?? 1100), ph = Number(text(pl, 'page-height') ?? 1550);
  const pm = child(pl, 'page-margins');
  const margin = pm ? Number(text(pm, 'left-margin') ?? 50) * mmPerTenth : 10;
  const page = {
    width: round(pw * mmPerTenth, 1), height: round(ph * mmPerTenth, 1),
    margin: round(margin, 1), staffSpace: round(10 * mmPerTenth, 3),
  };

  // ---- parts & staves
  const partList = child(root, 'part-list');
  const scoreParts = children(partList, 'score-part');
  const parts = children(root, 'part');
  const staves: StaffDef[] = [];
  const groups: Score['groups'] = [];
  const partStaffIds: string[][] = [];
  let staffCounter = 0;
  const partStaffCount = parts.map((p) => {
    const a = child(child(p, 'measure'), 'attributes');
    return Number(text(a, 'staves') ?? 1);
  });
  parts.forEach((p, pi) => {
    const sp = scoreParts.find((s) => s.attrs.id === p.attrs.id);
    const sound = text(child(sp, 'score-instrument'), 'instrument-sound') ?? '';
    const n = partStaffCount[pi];
    const ids: string[] = [];
    for (let k = 0; k < n; k++) {
      staffCounter++;
      const id = parts.length === 1 && n === 2 && sound.startsWith('keyboard') ? (k === 0 ? 'rh' : 'lh') : `s${staffCounter}`;
      ids.push(id);
      staves.push({ id, clef: { sign: 'G', line: 2 }, name: text(sp, 'part-name') });
    }
    if (n > 1) groups.push({ kind: sound.startsWith('keyboard') || /harp/.test(sound) ? 'brace' : 'bracket', staves: ids });
    partStaffIds.push(ids);
  });

  // ---- measures
  const measures: Measure[] = [];
  const nMeasures = Math.max(...parts.map((p) => children(p, 'measure').length));
  const voiceNums = new Map<string, number[]>(); // staffId -> sorted source voice numbers
  const raw: Map<string, RawNote[]>[] = []; // per measure: key staffId|voice
  const rawMarks: { staffId: string; mark: Mark }[][] = [];
  const curDivisions: number[] = parts.map(() => 1);

  for (let mi = 0; mi < nMeasures; mi++) {
    const measure: Measure = { staves: {} };
    measures.push(measure);
    const raws = new Map<string, RawNote[]>();
    raw.push(raws);
    const marks: { staffId: string; mark: Mark }[] = [];
    rawMarks.push(marks);

    parts.forEach((part, pi) => {
      const mx = children(part, 'measure')[mi];
      if (!mx) return;
      const ids = partStaffIds[pi];
      const sid = (n: number) => ids[Math.max(0, n - 1)];
      const t = (div: number) => {
        const x = (div * PPQ) / curDivisions[pi];
        if (!Number.isInteger(x)) throw new Error(`m${mi + 1}: duration ${div}/${curDivisions[pi]} not representable`);
        return x;
      };
      let cursor = 0, lastStart = 0, lastLen = 0;
      let prev: RawNote | undefined;
      const pendingGraces = new Map<number, import('./model.ts').Grace[]>(); // voice -> grace notes waiting for their note
      const homeStaff = new Map<number, number>(); // voice -> staff of its first note (cross-staff notes stay in their voice)
      if (pi === 0 && mx.attrs.implicit === 'yes') warn(`m${mi + 1}: implicit (pickup) measure not specially handled`);
      for (const el of mx.children) {
        switch (el.tag) {
          case 'attributes': {
            const dv = text(el, 'divisions');
            if (dv) curDivisions[pi] = Number(dv);
            const key = child(el, 'key');
            if (key && pi === 0) measure.key = Number(text(key, 'fifths') ?? 0);
            const time = child(el, 'time');
            if (time && pi === 0) measure.time = { beats: Number(text(time, 'beats')), beatType: Number(text(time, 'beat-type')) };
            for (const c of children(el, 'clef')) {
              const clef: Clef = { sign: text(c, 'sign') as Clef['sign'], line: Number(text(c, 'line') ?? 2) };
              const oc = text(c, 'clef-octave-change');
              if (oc) clef.octave = Number(oc);
              const id = sid(Number(c.attrs.number ?? 1));
              if (mi === 0 && cursor === 0) staves.find((s) => s.id === id)!.clef = clef;
              else marks.push({ staffId: id, mark: { type: 'clef', clef, tick: t(cursor) } });
            }
            break;
          }
          case 'backup': cursor -= Number(text(el, 'duration')); break;
          case 'forward': cursor += Number(text(el, 'duration')); break;
          case 'print':
            if (pi === 0 && opts.keepBreaks) {
              if (el.attrs['new-page'] === 'yes') measure.breakBefore = 'page';
              else if (el.attrs['new-system'] === 'yes' && mi > 0) measure.breakBefore = 'system';
            }
            break;
          case 'barline':
            if (pi === 0 && text(el, 'bar-style') === 'light-heavy') measure.barline = 'final';
            else if (pi === 0 && text(el, 'bar-style') === 'light-light') measure.barline = 'double';
            break;
          case 'direction': {
            const staffN = Number(text(el, 'staff') ?? 1);
            const staffId = sid(staffN);
            const tick = t(cursor);
            const placement = el.attrs.placement as 'above' | 'below' | undefined;
            for (const dt of children(el, 'direction-type')) {
              for (const d of dt.children) {
                if (d.tag === 'dynamics') {
                  const name = d.children[0]?.tag;
                  if (name) marks.push({ staffId, mark: { type: 'dynamic', text: name === 'other-dynamics' ? d.children[0].text.trim() : name, placement: placement === 'above' ? 'above' : undefined, tick } });
                } else if (d.tag === 'wedge') {
                  const id = Number(d.attrs.number ?? 1);
                  if (d.attrs.type === 'stop') marks.push({ staffId, mark: { type: 'stop', of: 'hairpin', id, tick } });
                  else marks.push({ staffId, mark: { type: 'hairpin', kind: d.attrs.type === 'crescendo' ? 'cresc' : 'dim', id, placement: placement === 'above' ? 'above' : undefined, tick } });
                } else if (d.tag === 'pedal') {
                  const ty = d.attrs.type;
                  if (ty === 'stop' || ty === 'change') marks.push({ staffId, mark: { type: 'stop', of: 'pedal', tick } });
                  if (ty === 'start' || ty === 'change') marks.push({ staffId, mark: { type: 'pedal', tick } });
                } else if (d.tag === 'octave-shift') {
                  if (d.attrs.size && d.attrs.size !== '8') throw new Error(`octave-shift size ${d.attrs.size} unsupported`);
                  if (d.attrs.type === 'stop') marks.push({ staffId, mark: { type: 'stop', of: 'ottava', tick } });
                  else marks.push({ staffId, mark: { type: 'ottava', dir: d.attrs.type === 'down' ? 'up' : 'down', tick } });
                } else if (d.tag === 'metronome') {
                  const unit = TYPE_BASE[text(d, 'beat-unit') ?? 'quarter'];
                  const dots = children(d, 'beat-unit-dot').length;
                  const bpm = Number(text(d, 'per-minute'));
                  if (unit && bpm) marks.push({ staffId, mark: { type: 'tempo', unit, dots, bpm, tick } });
                } else if (d.tag === 'words') {
                  marks.push({ staffId, mark: { type: 'text', text: d.text.trim(), placement: placement === 'below' ? 'below' : undefined, tick } });
                } else if (d.tag !== 'sound') warn(`m${mi + 1}: unsupported direction <${d.tag}>`);
              }
            }
            break;
          }
          case 'note': {
            const isChord = !!child(el, 'chord');
            const dur = Number(text(el, 'duration') ?? 0);
            const staffN = Number(text(el, 'staff') ?? 1);
            const voice = Number(text(el, 'voice') ?? 1);
            if (!homeStaff.has(voice)) homeStaff.set(voice, staffN);
            const staffId = sid(homeStaff.get(voice)!);
            const graceEl = child(el, 'grace');
            if (graceEl) { // collected, then attached to the next note of the voice
              if (!child(el, 'pitch')) break;
              const gl = pendingGraces.get(voice) ?? pendingGraces.set(voice, []).get(voice)!;
              if (isChord && gl.length) { gl[gl.length - 1].pitches.push(readPitch(el, mi)); break; }
              const tn = text(el, 'type');
              const base = tn && TYPE_BASE[tn] ? TYPE_BASE[tn] : 8;
              gl.push({ pitches: [readPitch(el, mi)], base, ...(graceEl.attrs.slash === 'yes' ? { slash: true } : {}) });
              break;
            }
            const typeName = text(el, 'type');
            const rest = child(el, 'rest');
            const isMeasureRest = rest?.attrs.measure === 'yes';
            let d: Dur | null;
            if (typeName && TYPE_BASE[typeName]) d = { base: TYPE_BASE[typeName], dots: children(el, 'dot').length };
            else d = ticksToDur(t(dur)) ?? { base: 1, dots: 0 };
            if (isChord && prev) {
              const ev = prev.ev as NoteEvent;
              ev.pitches.push(readPitch(el, mi));
              readNotations(el, ev, true);
              break;
            }
            const tick = t(cursor);
            const rn: RawNote = { tick, ticks: t(dur), staff: staffN, voice, ev: undefined as unknown as Event, tupStop: 0 };
            if (rest) {
              const ev: RestEvent = { kind: 'rest', style: isMeasureRest ? 'measure' : 'normal', dur: d };
              const ds = text(rest, 'display-step'), dop = text(rest, 'display-octave');
              if (ds && dop) ev.display = { step: ds.toLowerCase() as Step, alter: 0, octave: Number(dop) };
              rn.ev = ev;
            } else {
              const ev: NoteEvent = { kind: 'note', dur: d, pitches: [readPitch(el, mi)] };
              const gr = pendingGraces.get(voice);
              if (gr) { ev.graces = gr; pendingGraces.delete(voice); }
              rn.trem = readNotations(el, ev, false);
              rn.ev = ev;
            }
            const tmEl = child(el, 'time-modification');
            if (tmEl) rn.tmRatio = [Number(text(tmEl, 'actual-notes')), Number(text(tmEl, 'normal-notes'))];
            if (!child(el, 'chord') && sid(staffN) !== staffId) rn.ev.staff = sid(staffN); // cross-staff note
            const stemT = text(el, 'stem');
            if (opts.keepStems && (stemT === 'up' || stemT === 'down')) rn.ev.stem = stemT;
            // tuplets
            for (const tup of children(child(el, 'notations'), 'tuplet')) {
              if (tup.attrs.type === 'start') {
                const o: NonNullable<RawNote['tupStart']>[number] = {};
                if (tup.attrs.bracket) o.bracket = tup.attrs.bracket === 'yes';
                if (tup.attrs['show-number'] === 'none') o.number = 'none';
                if (tup.attrs.placement) o.placement = tup.attrs.placement as 'above' | 'below';
                const an = text(child(tup, 'tuplet-actual'), 'tuplet-number');
                if (an) o.label = Number(an);
                (rn.tupStart ??= []).push(o);
              } else rn.tupStop++;
            }
            rn.beam1 = children(el, 'beam').find((b) => b.attrs.number === '1')?.text.trim();
            const key = `${staffId}|${voice}`;
            if (!raws.has(key)) raws.set(key, []);
            raws.get(key)!.push(rn);
            prev = rn;
            lastStart = cursor; lastLen = dur;
            cursor += dur;
            break;
          }
        }
      }
      if (pendingGraces.size) warn(`m${mi + 1}: grace notes at the end of a measure dropped`);
      void lastStart; void lastLen;
    });
  }

  // voice numbering per staff
  for (const raws of raw)
    for (const key of raws.keys()) {
      const [sid, v] = key.split('|');
      const arr = voiceNums.get(sid) ?? [];
      if (!arr.includes(Number(v))) arr.push(Number(v));
      voiceNums.set(sid, arr);
    }
  for (const arr of voiceNums.values()) arr.sort((a, b) => a - b);

  // ---- build voices
  let timeNow: TimeSig = { beats: 4, beatType: 4 };
  for (let mi = 0; mi < nMeasures; mi++) {
    const measure = measures[mi];
    if (measure.time) timeNow = measure.time;
    const mlen = measureTicks(timeNow);
    for (const [key, notes] of raw[mi]) {
      const [sid, v] = key.split('|');
      const vid = voiceNums.get(sid)!.indexOf(Number(v)) + 1;
      const voice = { id: vid, items: buildVoice(notes, mlen, mi + 1, warn) };
      // leave out what the engraver's automatic beaming / bracket choice does anyway
      simplifyBeams(voice, beatTicks(timeNow));
      simplifyTupletBrackets(voice, beatTicks(timeNow));
      const sm = (measure.staves[sid] ??= { voices: [], marks: [] });
      sm.voices.push(voice);
    }
    for (const sm of Object.values(measure.staves)) sm.voices.sort((a, b) => a.id - b.id);
    for (const { staffId, mark } of rawMarks[mi]) (measure.staves[staffId] ??= { voices: [], marks: [] }).marks.push(mark);
    for (const sm of Object.values(measure.staves)) sm.marks.sort((a, b) => a.tick - b.tick);
  }
  if (!measures[0].time) measures[0].time = timeNow;
  return { meta, page, staves, groups, measures };
}

function round(x: number, d: number): number { const f = 10 ** d; return Math.round(x * f) / f; }

function readPitch(el: XNode, mi: number): import('./model.ts').NotePitch {
  const p = child(el, 'pitch');
  if (!p) throw new Error(`m${mi + 1}: unpitched notes not supported`);
  const step = text(p, 'step')!.toLowerCase() as Step;
  if (!STEPS.includes(step)) throw new Error('bad step');
  const pitch: Pitch = { step, alter: Number(text(p, 'alter') ?? 0), octave: Number(text(p, 'octave')) };
  if (!Number.isInteger(pitch.alter)) throw new Error(`m${mi + 1}: microtones unsupported`);
  const np: import('./model.ts').NotePitch = { pitch };
  if (children(el, 'tie').some((t) => t.attrs.type === 'start')) np.tie = true;
  const acc = child(el, 'accidental');
  if (acc?.attrs.cautionary === 'yes') np.acc = 'force';
  return np;
}

function readNotations(el: XNode, ev: NoteEvent | RestEvent, isChord: boolean): RawNote['trem'] {
  if (ev.kind !== 'note') return;
  const n = child(el, 'notations');
  if (!n) return;
  if (!isChord) {
    for (const s of children(n, 'slur')) {
      const id = Number(s.attrs.number ?? 1);
      if (s.attrs.type === 'start') {
        const side = (s.attrs.placement ?? (s.attrs.orientation === 'over' ? 'above' : s.attrs.orientation === 'under' ? 'below' : undefined)) as 'above' | 'below' | undefined;
        (ev.slurStart ??= []).push(side ? { id, side } : { id });
      } else if (s.attrs.type === 'stop') (ev.slurStop ??= []).push(id);
    }
  }
  if (child(n, 'arpeggiate')) ev.arpeggio = true;
  const art = child(n, 'articulations');
  if (art && !isChord) {
    const list: Articulation[] = [];
    for (const a of art.children) {
      if (a.tag === 'accent') list.push('accent');
      else if (a.tag === 'strong-accent') list.push('marcato');
      else if (a.tag === 'staccato') list.push('staccato');
    }
    if (list.length) ev.art = list;
    const pl = art.children.map((a) => a.attrs.placement).find((x) => x === 'above' || x === 'below');
    if (list.length && pl) ev.artSide = pl as 'above' | 'below';
  }
  const orn = child(n, 'ornaments');
  const trem = child(orn, 'tremolo');
  if (trem && (trem.attrs.type === 'start' || trem.attrs.type === 'stop') && !isChord)
    return { role: trem.attrs.type, beams: Number(trem.text.trim() || 2) };
}

function decomposeGap(ticks: number): Dur[] {
  const out: Dur[] = [];
  while (ticks > 0) {
    let found: Dur | null = null;
    for (const base of [1, 2, 4, 8, 16, 32, 64] as BaseDur[])
      for (const dots of [2, 1, 0]) {
        const bt = baseTicks({ base, dots });
        if (bt <= ticks && (!found || bt > baseTicks(found))) found = { base, dots };
      }
    if (!found) throw new Error(`cannot represent gap of ${ticks} ticks`);
    out.push(found);
    ticks -= baseTicks(found);
  }
  return out;
}

function buildVoice(notes: RawNote[], mlen: number, mnum: number, warn: (m: string) => void): Item[] {
  // 1. fill gaps with hidden rests; check continuity
  const evs: { ev: Event; tm?: [number, number]; tupStart?: RawNote['tupStart']; tupStop: number; beam1?: string; trem?: RawNote['trem'] }[] = [];
  let pos = 0;
  for (const n of notes) {
    if (n.tick < pos) throw new Error(`m${mnum}: overlapping events in one voice`);
    if (n.tick > pos) for (const d of decomposeGap(n.tick - pos)) evs.push({ ev: { kind: 'rest', style: 'hidden', dur: d }, tupStop: 0 });
    evs.push({ ev: n.ev, tm: n.tmRatio, tupStart: n.tupStart, tupStop: n.tupStop, beam1: n.beam1, trem: n.trem });
    pos = n.tick + n.ticks;
    // consistency check of notated duration vs. real duration
    let expect = baseTicks(n.ev.dur);
    if (n.tmRatio) expect = (expect * n.tmRatio[1]) / n.tmRatio[0];
    if (expect !== n.ticks && !(n.ev.kind === 'rest' && n.ev.style === 'measure')) warn(`m${mnum}: notated duration ${expect} != sounding ${n.ticks}`);
  }
  if (pos > mlen) warn(`m${mnum}: voice longer than measure`);
  // a voice that stops early is implicitly padded with rests (as MuseScore does)
  if (pos < mlen) for (const d of decomposeGap(mlen - pos)) evs.push({ ev: { kind: 'rest', style: 'hidden', dur: d }, tupStop: 0 });

  // 2. tuplet ranges
  type Range = { a: number; b: number; make: () => Item; rank: number }; // rank: nesting order for identical ranges, outer first
  const ranges: Range[] = [];
  const open: { a: number; o: NonNullable<RawNote['tupStart']>[number]; ratio: [number, number] }[] = [];
  let implicit: { a: number; ratio: [number, number] } | null = null;
  const closeImplicit = (b: number) => {
    if (!implicit) return;
    const { a, ratio } = implicit;
    ranges.push({ a, b, rank: 3, make: () => ({ kind: 'tuplet', actual: ratio[0], normal: ratio[1], bracket: false, number: 'none', items: [] }) });
    implicit = null;
  };
  evs.forEach((e, i) => {
    if (e.tupStart) {
      closeImplicit(i - 1);
      for (const o of e.tupStart) {
        if (!e.tm) { warn(`m${mnum}: tuplet without time-modification`); continue; }
        open.push({ a: i, o, ratio: e.tm });
      }
    } else if (e.tm) {
      if (!open.length) {
        if (implicit && (implicit.ratio[0] !== e.tm[0] || implicit.ratio[1] !== e.tm[1])) closeImplicit(i - 1);
        implicit ??= { a: i, ratio: e.tm };
      }
    } else closeImplicit(i - 1);
    for (let k = 0; k < e.tupStop; k++) {
      const t = open.pop();
      if (!t) continue;
      const { a, o, ratio } = t;
      ranges.push({
        a, b: i, rank: 3, make: () => {
          const g: TupletGroup = { kind: 'tuplet', actual: ratio[0], normal: ratio[1], items: [] };
          if (o.bracket !== undefined) g.bracket = o.bracket;
          if (o.number) g.number = o.number;
          if (o.placement) g.placement = o.placement;
          if (o.label !== undefined && o.label !== ratio[0]) g.label = o.label;
          return g;
        },
      });
    }
  });
  closeImplicit(evs.length - 1);
  if (open.length) warn(`m${mnum}: unterminated tuplet`);

  // two-note tremolos
  let tstart: { i: number; beams: number } | null = null;
  evs.forEach((e, i) => {
    if (e.trem?.role === 'start') tstart = { i, beams: e.trem.beams };
    else if (e.trem?.role === 'stop' && tstart) { const { i: a, beams } = tstart; ranges.push({ a, b: i, rank: 2, make: () => ({ kind: 'tremolo', beams, items: [] }) }); tstart = null; }
  });
  if (tstart) warn(`m${mnum}: tremolo without end`);

  // 3. beam ranges (beam level 1) incl. singletons for beamable-but-unbeamed events
  const brs: Range[] = [];
  let bstart = -1;
  evs.forEach((e, i) => {
    if (e.beam1 === 'begin') bstart = i;
    else if (e.beam1 === 'end' && bstart >= 0) { brs.push({ a: bstart, b: i, rank: 1, make: () => ({ kind: 'beam', items: [] }) }); bstart = -1; }
    else if (!e.beam1 && bstart < 0 && e.ev.kind === 'note' && e.ev.dur.base >= 8)
      brs.push({ a: i, b: i, rank: 1, make: () => ({ kind: 'beam', items: [] }) });
  });
  const all = [...ranges, ...brs];
  // outer first: start asc, end desc; for identical ranges tuplet outside tremolo outside beam
  all.sort((x, y) => x.a - y.a || y.b - x.b || y.rank - x.rank);

  // 4. nest
  interface Open { b: number; node: { items: Item[] } }
  const rootItems: Item[] = [];
  const stack: Open[] = [{ b: Infinity, node: { items: rootItems } }];
  let ri = 0;
  for (let i = 0; i < evs.length; i++) {
    while (stack.length > 1 && stack[stack.length - 1].b < i) stack.pop();
    while (ri < all.length && all[ri].a === i) {
      const r = all[ri++];
      const parent = stack[stack.length - 1];
      let b = r.b;
      if (b > parent.b) { warn(`m${mnum}: ${r.rank === 3 ? 'tuplet' : r.rank === 2 ? 'tremolo' : 'beam'} crosses group boundary, truncated`); b = parent.b; }
      const node = r.make() as TupletGroup | BeamGroup | TremoloGroup;
      parent.node.items.push(node);
      stack.push({ b, node });
    }
    stack[stack.length - 1].node.items.push(evs[i].ev);
  }
  return rootItems;
}
