// Analysis pass: turns the Score into per-event layout records (written pitch positions,
// accidentals, stem directions, beam groups ...) before any horizontal/vertical layout.
import {
  STEPS, flattenVoice, measureTicks, pitchStep, timeAt, keyAt,
  type Score, type Clef, type TimedEvent, type NoteEvent, type Event, type TupletGroup, type TremoloGroup, type Pitch, type Mark, type Voice,
} from '../model.ts';
import { beamGroups, beatTicks } from '../beams.ts';

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
  staff: number; // staff index the heads are drawn on (differs from `home` for cross-staff notes)
  home: number; // staff index of the voice (stems, beams, tuplets and slurs belong to it)
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
  tremBeams?: number;
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
  cross?: boolean; // members sit on different staves: the beam runs between them, stems point towards it
  crossY?: [number, number]; // cross beam: top and bottom edge (y in the voice's staff, set when drawn)
}

export interface StaffMeasureL {
  evs: EvL[]; // events drawn on this staff (all voices, incl. cross-staff arrivals), sorted by (start, voice)
  voices: { id: number; evs: EvL[] }[]; // the voices of this staff, with all their events wherever drawn
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
      if (mk.type === 'ottava') ottChanges[staffIdx.get(sid)!].push({ mi, tick: mk.tick, shift: mk.dir === 'up' ? -1 : 1 });
      else if (mk.type === 'stop' && mk.of === 'ottava') ottChanges[staffIdx.get(sid)!].push({ mi, tick: mk.tick, shift: 0 });
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
    const smOf = (si: number) => m.staves[score.staves[si].id] ?? { voices: [], marks: [] };
    // ----- pass 1: events of every voice (a cross-staff event takes clef, octave shift and accidentals of its display staff)
    const voicesOf: { id: number; evs: EvL[] }[][] = [];
    for (let si = 0; si < nS; si++) {
      const sm = smOf(si);
      const voices: { id: number; evs: EvL[] }[] = [];
      const soundingVoices = sm.voices.filter((v) => flattenVoice(v).some((e) => e.ev.kind === 'note' || (e.ev.kind === 'rest' && e.ev.style === 'normal')));
      sm.voices.forEach((v) => {
        const flat = flattenVoice(v);
        const rank = soundingVoices.findIndex((x) => x.id === v.id);
        const evs: EvL[] = flat.map((te) => {
          const ds = te.ev.kind === 'note' && te.ev.staff !== undefined && staffIdx.has(te.ev.staff) ? staffIdx.get(te.ev.staff)! : si;
          const clef = clefAt(ds, mi, te.start);
          const shift = ottAt(ds, mi, te.start, true);
          const e: EvL = {
            id: id++, mi, staff: ds, home: si, voice: v.id, voiceRank: Math.max(0, rank), nVoices: soundingVoices.length,
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
      voicesOf.push(voices);
    }

    // ----- pass 2: accidentals per display staff (state per staff in the measure, processed in time order)
    for (let si = 0; si < nS; si++) {
      const state = new Map<string, number>(); // "step+oct" -> alter
      const all = voicesOf.flatMap((vs) => vs.flatMap((v) => v.evs)).filter((e) => e.staff === si).sort((a, b) => a.start - b.start || a.voice - b.voice);
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
    }
    // tie carry to next measure (keyed by the staff the tied note is drawn on)
    for (const t of tiedFromPrev) t.clear();
    for (const voices of voicesOf) for (const v of voices) {
      const last = v.evs[v.evs.length - 1];
      if (last && last.ev.kind === 'note') for (const np of last.ev.pitches) if (np.tie) tiedFromPrev[last.staff].set(`${v.id}|${pitchStep(np.pitch)}|${np.pitch.alter}`, true);
    }

    for (let si = 0; si < nS; si++) {
      const sm = smOf(si);
      const voices = voicesOf[si];

      // ----- beams
      for (const v of voices) assignBeams(v, sm.voices.find((x) => x.id === v.id)!, bt);

      // ----- two-note tremolos
      for (const v of voices) {
        const pairs = new Map<TremoloGroup, EvL[]>();
        for (const e of v.evs) if (e.te.tremolo && e.ev.kind === 'note') (pairs.get(e.te.tremolo) ?? pairs.set(e.te.tremolo, []).get(e.te.tremolo)!).push(e);
        for (const [g, [a, b]] of pairs) if (b) { a.tremPair = b; b.tremPair = a; a.tremIsFirst = true; a.tremBeams = b.tremBeams = g.beams; }
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

      // ----- cross-staff beams: the stems of the upper staff's notes point down, those of the lower staff's up
      for (const v of voices) {
        const seen = new Set<BeamL>();
        for (const e of v.evs) if (e.beam && !seen.has(e.beam)) {
          seen.add(e.beam);
          const st = new Set(e.beam.notes.map((n) => n.staff));
          if (st.size < 2) continue;
          e.beam.cross = true;
          const top = Math.min(...st);
          for (const n of e.beam.notes) n.stem = n.staff === top ? 'down' : 'up';
        }
      }

      // ----- displaced heads in chords
      for (const v of voices) for (const e of v.evs) if (e.ev.kind === 'note') displaceHeads(e);

      voices.forEach((v) => v.evs.forEach((e) => allEvs.push(e)));
      row.push({ evs: [], voices, marks: sm.marks });
    }
    for (const r of row) r.evs = [];
    for (const r of row) for (const v of r.voices) for (const e of v.evs) row[e.staff].evs.push(e);
    for (const r of row) r.evs.sort((a, b) => a.start - b.start || a.voice - b.voice);
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

function assignBeams(vl: { id: number; evs: EvL[] }, voice: Voice, beatLen: number): void {
  const byEv = new Map(vl.evs.map((e) => [e.ev, e]));
  for (const g of beamGroups(voice, beatLen)) {
    const ems = g.map((ev) => byEv.get(ev)!);
    const b: BeamL = { evs: ems, notes: ems.filter((x) => x.ev.kind === 'note'), dir: 'up' };
    for (const x of ems) x.beam = b;
  }
}
