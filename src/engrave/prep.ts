// Analysis pass: turns the Score into per-event layout records (written pitch positions,
// accidentals, stem directions, beam groups ...) before any horizontal/vertical layout.
import {
  PPQ, STEPS, flattenVoice, isEvent, measureTicks, pitchStep, timeAt, keyAt, isBeam,
  type Score, type Clef, type TimedEvent, type NoteEvent, type Event, type TupletGroup, type BeamGroup, type Pitch, type Item, type Mark, type Voice,
} from '../model.ts';

export const HALF = 1; // staff positions are in half spaces above the bottom line

export function clefBottomStep(c: Clef): number {
  const sign = c.sign === 'G' ? { s: 'g', o: 4 } : c.sign === 'F' ? { s: 'f', o: 3 } : { s: 'c', o: 4 };
  const signStep = sign.o * 7 + STEPS.indexOf(sign.s as never);
  return signStep - 2 * (c.line - 1) + 7 * (c.octave ?? 0);
}
/** staff position (half-spaces above bottom line) for a written pitch */
export function staffPos(p: Pitch, c: Clef): number { return pitchStep(p) - clefBottomStep(c); }
export function posToY(pos: number): number { return 4 - pos / 2; }

export interface HeadL {
  pos: number; // written staff position
  pitch: Pitch; // sounding pitch
  tie: boolean;
  acc?: { glyph: string; cautionary: boolean };
  displaced: boolean; // moved to the other side of the stem
  dx: number; // x offset relative to the event's notehead x (set during layout)
  accX?: number; // x offset of the accidental glyph's left edge
  shared?: boolean; // unison with a head of the first voice that can serve both: drawn only once
  sharers?: EvL[]; // events of other voices whose stems attach to this head (they share it)
  skipDots?: boolean; // the first voice already draws at least as many dots here
}

export interface EvL {
  id: number;
  mi: number; // measure index
  staff: number; // staff index
  voice: number; // voice id
  voiceRank: number; // 0-based rank among sounding voices in this staff-measure
  nVoices: number;
  te: TimedEvent;
  ev: Event;
  start: number; // tick in measure
  ticks: number;
  clef: Clef;
  heads: HeadL[];
  stem: 'up' | 'down' | null;
  beam?: BeamL;
  tremPair?: EvL; // partner of a two-note tremolo (set on both)
  tremIsFirst?: boolean;
  tupletKeys: TupletGroup[];
  // layout results
  x: number; // absolute x within system of normal notehead left edge
  stemX?: number;
  stemTip?: number; // y
  stemBase?: number; // y
  ottavaShift: number; // -1 = 8va (written lower), +1 = 8vb
  shiftDx: number; // sideways shift of the whole event to avoid clashing with another voice's heads
}

export interface BeamL {
  evs: EvL[]; // all members incl. rests
  notes: EvL[]; // members that are notes
  dir: 'up' | 'down';
}

export interface StaffMeasureL {
  evs: EvL[]; // all events in all voices, sorted by (start, voice)
  voices: { id: number; evs: EvL[] }[];
  marks: Mark[];
}

export interface Prepared {
  score: Score;
  measures: StaffMeasureL[][]; // [measure][staff]
  clefAt: (staff: number, mi: number, tick: number) => Clef;
  measureLen: number[];
  allEvs: EvL[];
}

const ACC_GLYPH: Record<number, string> = { [-2]: 'accidentalDoubleFlat', [-1]: 'accidentalFlat', 0: 'accidentalNatural', 1: 'accidentalSharp', 2: 'accidentalDoubleSharp' };
const SHARP_ORDER = ['f', 'c', 'g', 'd', 'a', 'e', 'b'];

export function keyAlter(fifths: number, step: string): number {
  if (fifths > 0) return SHARP_ORDER.slice(0, fifths).includes(step) ? 1 : 0;
  if (fifths < 0) return [...SHARP_ORDER].reverse().slice(0, -fifths).includes(step) ? -1 : 0;
  return 0;
}

function beatTicks(ts: { beats: number; beatType: number }): number {
  if (ts.beatType === 8 && ts.beats % 3 === 0 && ts.beats > 3) return (PPQ * 3) / 2;
  return (PPQ * 4) / ts.beatType;
}

function levels(base: number): number { return base >= 8 ? Math.log2(base) - 2 : 0; }
export { levels as beamLevels };

export function prepare(score: Score): Prepared {
  const nS = score.staves.length;
  const staffIdx = new Map(score.staves.map((s, i) => [s.id, i]));
  const measureLen = score.measures.map((_, mi) => measureTicks(timeAt(score, mi)));

  // clef timeline per staff: list of {mi,tick,clef}
  const clefChanges: { mi: number; tick: number; clef: Clef }[][] = score.staves.map(() => []);
  score.measures.forEach((m, mi) => {
    for (const [sid, sm] of Object.entries(m.staves)) for (const mk of sm.marks) if (mk.type === 'clef') clefChanges[staffIdx.get(sid)!].push({ mi, tick: mk.tick, clef: mk.clef });
  });
  const clefAt = (s: number, mi: number, tick: number): Clef => {
    let c = score.staves[s].clef;
    for (const ch of clefChanges[s]) if (ch.mi < mi || (ch.mi === mi && ch.tick <= tick)) c = ch.clef; else break;
    return c;
  };

  // ottava timeline per staff
  type Ott = { mi: number; tick: number; shift: number }; // shift: -1 (8va), +1 (8vb), 0 stop
  const ottChanges: Ott[][] = score.staves.map(() => []);
  score.measures.forEach((m, mi) => {
    for (const [sid, sm] of Object.entries(m.staves)) for (const mk of sm.marks) {
      if (mk.type === 'ottava-start') ottChanges[staffIdx.get(sid)!].push({ mi, tick: mk.tick, shift: mk.dir === 'up' ? -1 : 1 });
      else if (mk.type === 'ottava-stop') ottChanges[staffIdx.get(sid)!].push({ mi, tick: mk.tick, shift: 0 });
    }
  });
  const ottAt = (s: number, mi: number, tick: number, isStartIncl: boolean): number => {
    let sh = 0;
    for (const o of ottChanges[s]) {
      const before = o.mi < mi || (o.mi === mi && (o.tick < tick || (o.tick === tick && (isStartIncl ? o.shift !== 0 : true))));
      if (before) sh = o.shift; else break;
    }
    return sh;
  };

  const measures: StaffMeasureL[][] = [];
  const allEvs: EvL[] = [];
  let id = 0;
  const tiedFromPrev: Map<string, boolean>[] = score.staves.map(() => new Map()); // key: voice|pitchstep+alter -> true if previous tied into this

  score.measures.forEach((m, mi) => {
    const key = keyAt(score, mi);
    const bt = beatTicks(timeAt(score, mi));
    const row: StaffMeasureL[] = [];
    for (let si = 0; si < nS; si++) {
      const sid = score.staves[si].id;
      const sm = m.staves[sid] ?? { voices: [], marks: [] };
      const voices: { id: number; evs: EvL[] }[] = [];
      const soundingVoices = sm.voices.filter((v) => flattenVoice(v).some((e) => e.ev.kind === 'note' || (e.ev.kind === 'rest' && !e.ev.hidden && !e.ev.measure)));
      sm.voices.forEach((v) => {
        const flat = flattenVoice(v);
        const rank = soundingVoices.findIndex((x) => x.id === v.id);
        const evs: EvL[] = flat.map((te) => {
          const clef = clefAt(si, mi, te.start);
          const shift = ottAt(si, mi, te.start, true);
          const e: EvL = {
            id: id++, mi, staff: si, voice: v.id, voiceRank: Math.max(0, rank), nVoices: soundingVoices.length,
            te, ev: te.ev, start: te.start, ticks: te.ticks, clef, heads: [], stem: null, x: 0, tupletKeys: te.tuplets, ottavaShift: shift, shiftDx: 0,
          };
          if (te.ev.kind === 'note') {
            e.heads = te.ev.pitches.map((np) => ({
              pitch: np.pitch, tie: !!np.tie, displaced: false, dx: 0,
              pos: staffPos({ ...np.pitch, octave: np.pitch.octave + shift }, clef),
            }));
          }
          return e;
        });
        voices.push({ id: v.id, evs });
      });

      // ----- accidentals (state per staff in the measure, processed in time order)
      const state = new Map<string, number>(); // "step+oct" -> alter
      const all = voices.flatMap((v) => v.evs).sort((a, b) => a.start - b.start || a.voice - b.voice);
      for (const e of all) {
        if (e.ev.kind !== 'note') continue;
        const ne = e.ev as NoteEvent;
        ne.pitches.forEach((np, i) => {
          const h = e.heads[i];
          const k = `${np.pitch.step}${np.pitch.octave}`;
          const cur = state.has(k) ? state.get(k)! : keyAlter(key, np.pitch.step);
          const tiedIn = tiedFromPrev[si].get(`${e.voice}|${pitchStep(np.pitch)}|${np.pitch.alter}`);
          let show = np.pitch.alter !== cur;
          let caut = false;
          if (np.acc === 'force') show = true;
          if (np.acc === 'cautionary') { show = true; caut = true; }
          if (tiedIn && e.start === 0 && np.acc === undefined) show = false;
          if (show) h.acc = { glyph: ACC_GLYPH[np.pitch.alter], cautionary: caut };
          state.set(k, np.pitch.alter);
        });
      }
      // tie carry to next measure
      tiedFromPrev[si].clear();
      for (const v of voices) {
        const last = v.evs[v.evs.length - 1];
        if (last && last.ev.kind === 'note') for (const np of last.ev.pitches) if (np.tie) tiedFromPrev[si].set(`${v.id}|${pitchStep(np.pitch)}|${np.pitch.alter}`, true);
      }

      // ----- beams
      for (const v of voices) assignBeams(v, sm.voices.find((x) => x.id === v.id)!, bt);

      // ----- two-note tremolos
      for (const v of voices) {
        let pending: EvL | null = null;
        for (const e of v.evs) {
          if (e.ev.kind !== 'note') continue;
          const t = e.ev.tremolo2;
          if (t?.role === 'start') pending = e;
          else if (t?.role === 'stop' && pending) { pending.tremPair = e; e.tremPair = pending; pending.tremIsFirst = true; pending = null; }
        }
      }

      // ----- stem directions
      for (const v of voices) {
        const done = new Set<BeamL>();
        for (const e of v.evs) {
          if (e.ev.kind !== 'note' || e.te.ev.dur.base === 1) continue;
          if (e.beam) {
            if (done.has(e.beam)) { e.stem = e.beam.dir; continue; }
            done.add(e.beam);
            e.beam.dir = decideDir(e.beam.notes, e.voiceRank, e.nVoices);
            e.stem = e.beam.dir;
          } else if (e.tremPair && !e.tremIsFirst) {
            e.stem = e.tremPair.stem;
          } else if (e.tremPair && e.tremIsFirst) {
            e.stem = decideDir([e, e.tremPair], e.voiceRank, e.nVoices);
          } else e.stem = decideDir([e], e.voiceRank, e.nVoices);
        }
        for (const e of v.evs) if (e.ev.kind === 'note') {
          const o = e.ev.stem;
          if (o && e.te.ev.dur.base !== 1) {
            e.stem = o;
            if (e.beam) e.beam.dir = o;
          }
        }
      }
      for (const v of voices) for (const e of v.evs) if (e.beam && e.beam.dir) e.stem = e.stem && e.ev.kind === 'note' ? e.beam.dir : e.stem;

      // ----- displaced heads in chords
      for (const v of voices) for (const e of v.evs) if (e.ev.kind === 'note') displaceHeads(e);

      voices.forEach((v) => v.evs.forEach((e) => allEvs.push(e)));
      row.push({
        evs: voices.flatMap((v) => v.evs).sort((a, b) => a.start - b.start || a.voice - b.voice),
        voices,
        marks: sm.marks,
      });
    }
    measures.push(row);
  });
  return { score, measures, clefAt, measureLen, allEvs };
}

function decideDir(notes: EvL[], rank: number, nVoices: number): 'up' | 'down' {
  if (nVoices > 1) return rank === 0 ? 'up' : 'down';
  let hi = -Infinity, lo = Infinity;
  for (const n of notes) for (const h of n.heads) { hi = Math.max(hi, h.pos); lo = Math.min(lo, h.pos); }
  if (hi === -Infinity) return 'up';
  const above = hi - 4, below = 4 - lo; // distance from middle line (position 4)
  return above > below ? 'down' : above < below ? 'up' : (hi + lo) / 2 >= 4 ? 'down' : 'up';
}

function displaceHeads(e: EvL): void {
  const hs = e.heads;
  if (hs.length < 2) return;
  const order = hs.map((_, i) => i).sort((a, b) => hs[a].pos - hs[b].pos);
  const down = e.stem === 'down';
  const seq = down ? [...order].reverse() : order;
  let prev: number | null = null;
  for (const i of seq) {
    if (prev !== null && Math.abs(hs[i].pos - hs[prev].pos) === 1 && !hs[prev].displaced) hs[i].displaced = true;
    prev = i;
  }
}

function eligible(e: EvL): boolean { return e.ev.kind === 'note' && e.ev.dur.base >= 8; }

function assignBeams(vl: { id: number; evs: EvL[] }, voice: Voice, beatLen: number): void {
  const evs = vl.evs;
  const grouped = new Set<EvL>();
  // explicit groups
  const walk = (items: Item[]) => {
    for (const it of items) {
      if (isEvent(it)) continue;
      if (isBeam(it)) {
        const members = collect(it);
        const ems = members.map((ev) => evs.find((x) => x.ev === ev)!);
        for (const m of ems) grouped.add(m);
        makeBeam(ems);
      }
      walk(it.items);
    }
  };
  const collect = (g: BeamGroup | TupletGroup): Event[] => g.items.flatMap((i) => (isEvent(i) ? [i] : collect(i)));
  const makeBeam = (ems: EvL[]) => {
    const notes = ems.filter((x) => x.ev.kind === 'note');
    if (notes.length < 2) return; // singleton: explicit "no beam"
    const b: BeamL = { evs: ems, notes, dir: 'up' };
    for (const x of ems) x.beam = b;
  };
  walk(voice.items);
  // automatic grouping on the rest
  let run: EvL[] = [];
  const flush = () => {
    if (run.length >= 2) makeBeam(run);
    run = [];
  };
  for (const e of evs) {
    if (grouped.has(e) || !eligible(e)) { flush(); continue; }
    if (run.length) {
      const prev = run[run.length - 1];
      const sameTuplets = prev.tupletKeys.length === e.tupletKeys.length && prev.tupletKeys.every((t, i) => t === e.tupletKeys[i]);
      const beatCross = Math.floor(prev.start / beatLen) !== Math.floor(e.start / beatLen);
      if (beatCross || (!sameTuplets && prev.tupletKeys.length + e.tupletKeys.length > 0 && !prev.tupletKeys.some((t) => e.tupletKeys.includes(t)))) flush();
    }
    run.push(e);
  }
  flush();
}
