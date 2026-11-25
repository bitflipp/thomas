// Keyboard note input: the caret (where the next note goes), entering a note by repeating the last one (and moving it
// with the arrow keys), rests, slurs, stepping and deleting back. The caret keeps its position in time when the voice
// changes, so that one voice can be entered after the other over the same bars. A click in `interact.ts` places it.

import { signal } from '@preact/signals';
import type { EvAddr } from '../src/editor/addr.ts';
import { eventOf, voiceOf } from '../src/editor/addr.ts';
import * as C from '../src/editor/commands.ts';
import { comparePitch, plainAlter, transposeSteps } from '../src/editor/context.ts';
import { xOfTick } from '../src/editor/hit.ts';
import { eventAtTick } from '../src/editor/voice.ts';
import type { Pitch, Score } from '../src/model.ts';
import { flattenVoice, lengthOf } from '../src/model.ts';
import { editHeads } from './actions.ts';
import { pageEls, selectEventAt } from './interact.ts';
import type { Caret } from './state.ts';
import { acc, caret, dots, dur, engraved, run, say, score, selection, voice } from './state.ts';

/** The note entered last: where it is, so that W repeats it and S puts a slur end on it. */
let prev: { mi: number; staff: string; voice: number; tick: number } | null = null;

/** The pitches of the note entered last, kept when the caret moves away or a rest follows, for W in another voice or place. */
let remembered: Pitch[] | null = null;

/** Forgets where the note entered last is, keeping its pitches (as they are now, after arrow keys) in `remembered`. */
function forgetPrev(): void {
  const v = prev && voiceOf(score.peek(), prev);
  const e = v && flattenVoice(v).find((t) => t.start === prev?.tick)?.ev;
  if (e?.kind === 'note') remembered = e.pitches.map((p) => ({ ...p.pitch }));
  prev = null;
}

/** The caret, kept inside the score (measures may have been deleted since it was set). */
function current(sc: Score): Caret | null {
  const c = caret.peek();
  if (!c) return null;
  const mi = Math.min(c.mi, sc.measures.length - 1);
  if (!sc.staves.some((s) => s.id === c.staff)) return null;
  return { ...c, mi, tick: Math.min(c.tick, lengthOf(sc, mi)) };
}

/** The ticks at which events of the voice start in a measure (just 0 when the voice is empty there). */
function onsets(sc: Score, mi: number, staff: string, voiceId: number): number[] {
  const v = voiceOf(sc, { mi, staff, voice: voiceId });
  return v ? [...new Set(flattenVoice(v).map((t) => t.start))] : [0];
}

/** Puts the caret at `c`, forgets the note entered last and scrolls it into view. */
export function placeCaret(c: Caret): void {
  caret.value = c;
  forgetPrev();
  revealCaret();
}

/** Moves the caret to the previous or next event start of the current voice, across barlines. */
export function moveCaret(dir: -1 | 1): void {
  const sc = score.peek();
  const c = current(sc);
  if (!c) return;
  const here = onsets(sc, c.mi, c.staff, voice.peek());
  if (dir > 0) {
    const t = here.find((x) => x > c.tick);
    if (t !== undefined) placeCaret({ ...c, tick: t });
    else if (c.mi + 1 < sc.measures.length) placeCaret({ ...c, mi: c.mi + 1, tick: 0 });
  } else {
    const t = [...here].reverse().find((x) => x < c.tick);
    if (t !== undefined) placeCaret({ ...c, tick: t });
    else if (c.mi > 0)
      placeCaret({ ...c, mi: c.mi - 1, tick: Math.max(...onsets(sc, c.mi - 1, c.staff, voice.peek())) });
  }
}

/** Moves the caret to the start of its measure, or of the previous measure when it is already there. */
export function caretToMeasureStart(): void {
  const c = current(score.peek());
  if (!c) return;
  placeCaret(c.tick > 0 || c.mi === 0 ? { ...c, tick: 0 } : { ...c, mi: c.mi - 1, tick: 0 });
}

/** Moves the caret to another staff, keeping the measure and, as far as possible, the position. */
export function caretToStaff(dir: -1 | 1): void {
  const sc = score.peek();
  const c = current(sc);
  if (!c) return;
  const i = sc.staves.findIndex((s) => s.id === c.staff) + dir;
  if (i >= 0 && i < sc.staves.length) placeCaret({ ...c, staff: sc.staves[i].id });
}

/** The sounding length of the event that starts at `tick` of the voice in `sc`, or 0. */
function ticksAt(sc: Score, loc: { mi: number; staff: string; voice: number }, tick: number): number {
  const v = voiceOf(sc, { ...loc });
  const at = v && eventAtTick(v.items, tick);
  return at && at.start === tick ? at.ticks : 0;
}

/** The caret after an event of `ticks` entered at `c`; the score gets a new last measure when the caret runs off the end. */
function advance(sc: Score, c: Caret, ticks: number): { score: Score; caret: Caret } {
  const tick = c.tick + ticks;
  if (tick < lengthOf(sc, c.mi)) return { score: sc, caret: { ...c, tick } };
  const s = c.mi + 1 >= sc.measures.length ? C.insertMeasures(sc, sc.measures.length) : sc;
  return { score: s, caret: { ...c, mi: c.mi + 1, tick: 0 } };
}

/** Enters a note at the caret and moves the caret on. Returns whether it was entered. */
function enterPitch(c: Caret, pitch: Pitch): boolean {
  const loc = { mi: c.mi, staff: c.staff, voice: voice.peek() };
  const d = { base: dur.peek(), dots: dots.peek() };
  let next: Caret | undefined;
  const ok = run((s) => {
    const s1 = C.enterNote(s, loc, c.tick, d, pitch);
    const r = advance(s1, c, ticksAt(s1, loc, c.tick));
    next = r.caret;
    return r.score;
  });
  if (!ok) return false;
  selectEventAt(loc, c.tick);
  acc.value = undefined;
  prev = { ...loc, tick: c.tick };
  if (slurFrom.peek() === 'next') slurFrom.value = prev;
  if (next) caret.value = next;
  revealCaret();
  return true;
}

/**
 * The pitches to repeat: the note entered last, else the last note before the caret in the voice (this or the previous
 * measure), else the note entered last anywhere.
 */
function noteBefore(sc: Score, c: Caret): Pitch[] | undefined {
  const vid = voice.peek();
  const find = (mi: number, before: number) => {
    const v = voiceOf(sc, { mi, staff: c.staff, voice: vid });
    return v && [...flattenVoice(v)].reverse().find((t) => t.start < before && t.ev.kind === 'note')?.ev;
  };
  const at = prev && voiceOf(sc, prev);
  const p = at && flattenVoice(at).find((t) => t.start === prev?.tick)?.ev;
  const e = p ?? find(c.mi, c.tick) ?? (c.mi > 0 ? find(c.mi - 1, Number.POSITIVE_INFINITY) : undefined);
  if (e?.kind === 'note') return e.pitches.map((x) => ({ ...x.pitch }));
  return remembered ?? undefined;
}

/** The note W enters when there is nothing to repeat. */
const MIDDLE_C: Pitch = { step: 'c', octave: 4, alter: 0 };

/**
 * Enters one note at the caret in the current duration (key W): the pitch of the note entered last, of its selected
 * head when it is a chord with one head selected, else its top note; middle C when there is nothing to repeat.
 */
export function repeatNote(): void {
  const sc = score.peek();
  const c = current(sc);
  if (!c) return;
  const n = noteBefore(sc, c);
  const sel = selection.peek();
  const head = sel.length === 1 && sel[0].t === 'ev' ? sel[0].pi : undefined;
  const pitch = n ? (n[head ?? n.length - 1] ?? n[n.length - 1]) : MIDDLE_C;
  enterPitch(c, pitch);
}

/**
 * Where an open slur starts: a note, `'next'` for the next note entered, or null. S opens it at the note entered last
 * (or at the next one when nothing was entered yet) and closes it at the note entered last.
 */
export const slurFrom = signal<{ mi: number; staff: string; voice: number; tick: number } | 'next' | null>(null);

/** The address of the event that starts at `p.tick` in its voice. */
function addrAt(sc: Score, p: { mi: number; staff: string; voice: number; tick: number }): EvAddr | undefined {
  const v = voiceOf(sc, p);
  const te = v && flattenVoice(v).find((t) => t.start === p.tick);
  return te && { mi: p.mi, staff: p.staff, voice: p.voice, idx: te.index };
}

/** Opens a slur at the note entered last, or closes the open one there. */
export function toggleSlur(): void {
  const from = slurFrom.peek();
  if (!from) {
    slurFrom.value = prev ?? 'next';
    return;
  }
  slurFrom.value = null;
  if (from === 'next' || !prev) return;
  const sc = score.peek();
  const a = addrAt(sc, from);
  const b = addrAt(sc, prev);
  if (!(a && b)) {
    say('The slur lost its notes', true);
    return;
  }
  const to = prev;
  if (run((s) => C.addSlur(s, a, b))) selectEventAt(to, to.tick);
}

/** Moves the selected notes (a selected head only) a step up or down the staff; the alteration is what the key and the measure give there. */
export function stepNotes(d: 1 | -1): void {
  const refs = selection.peek().filter((r) => r.t === 'ev');
  if (!refs.length) return;
  editHeads((s0) =>
    refs.reduce((s, r) => {
      const v = voiceOf(s, r);
      const te = v && flattenVoice(v)[r.idx];
      if (te?.ev.kind !== 'note') return s;
      return C.updateNotes(s, [r], (n) => {
        n.pitches.forEach((np, i) => {
          if (r.pi !== undefined && i !== r.pi) return;
          const q = transposeSteps(np.pitch, d);
          np.pitch = { ...q, alter: plainAlter(s, r.staff, r.mi, te.start, q.step, q.octave) };
        });
        n.pitches.sort((x, y) => comparePitch(x.pitch, y.pitch));
      });
    }, s0),
  );
}

/**
 * Adds a tone a third above the top of the note just entered (or the selected note), in the key, and selects only that
 * head, so that the arrow keys put it in place. The caret stays where it is.
 */
export function addChordTone(): void {
  const sc = score.peek();
  const sel = selection.peek().find((r) => r.t === 'ev');
  const at = prev ? addrAt(sc, prev) : sel?.t === 'ev' ? sel : undefined;
  const v = at && voiceOf(sc, at);
  const te = v && at && flattenVoice(v)[at.idx];
  if (!(at && te && te.ev.kind === 'note')) {
    say('Enter or select a note first', true);
    return;
  }
  const top = te.ev.pitches[te.ev.pitches.length - 1].pitch;
  const q = transposeSteps(top, 2);
  const pitch = { ...q, alter: plainAlter(sc, at.staff, at.mi, te.start, q.step, q.octave) };
  const loc = { mi: at.mi, staff: at.staff, voice: at.voice };
  if (!run((s) => C.enterNote(s, loc, te.start, te.ev.dur, pitch, { chord: true }))) return;
  const e = eventOf(score.peek(), at);
  const pi = e?.kind === 'note' ? e.pitches.findIndex((p) => comparePitch(p.pitch, pitch) === 0) : -1;
  selection.value = [{ t: 'ev', ...loc, idx: at.idx, ...(pi >= 0 ? { pi } : {}) }];
}

/** Enters a rest at the caret and moves the caret on (key R). */
export function enterRestAtCaret(): void {
  const sc = score.peek();
  const c = current(sc);
  if (!c) return;
  const loc = { mi: c.mi, staff: c.staff, voice: voice.peek() };
  const d = { base: dur.peek(), dots: dots.peek() };
  let next: Caret | undefined;
  if (
    !run((s) => {
      const s1 = C.enterRest(s, loc, c.tick, d);
      const r = advance(s1, c, ticksAt(s1, loc, c.tick));
      next = r.caret;
      return r.score;
    })
  )
    return;
  selectEventAt(loc, c.tick);
  forgetPrev();
  if (next) caret.value = next;
  revealCaret();
}

/** Steps the caret back over the previous event of the voice and turns that event into a rest. */
export function backspaceAtCaret(): void {
  const sc = score.peek();
  const c = current(sc);
  if (!c) return;
  const vid = voice.peek();
  let mi = c.mi;
  let tick = [...onsets(sc, mi, c.staff, vid)].reverse().find((t) => t < c.tick);
  if (tick === undefined) {
    if (mi === 0) return;
    mi--;
    tick = Math.max(...onsets(sc, mi, c.staff, vid));
  }
  const v = voiceOf(sc, { mi, staff: c.staff, voice: vid });
  const te = v && flattenVoice(v).find((t) => t.start === tick);
  if (te && te.ev.kind === 'note') run((s) => C.deleteEvents(s, [{ mi, staff: c.staff, voice: vid, idx: te.index }]));
  caret.value = { mi, staff: c.staff, tick };
  forgetPrev();
  selection.value = [];
  revealCaret();
}

/** Raises or lowers the selected notes (a selected head only) by an accidental. */
export function alterLast(d: 1 | -1): void {
  const refs = selection.peek().filter((r) => r.t === 'ev');
  if (!refs.length) return;
  const onlyHead = refs.find((r) => r.pi !== undefined)?.pi;
  run((s) =>
    C.updateNotes(s, refs, (n) => {
      n.pitches.forEach((np, i) => {
        if (onlyHead === undefined || i === onlyHead)
          np.pitch = { ...np.pitch, alter: Math.max(-2, Math.min(2, np.pitch.alter + d)) };
      });
    }),
  );
}

/** Scrolls the score pane just enough to bring the caret into view (a third of the way down when it was out of it). */
export function revealCaret(): void {
  const res = engraved.peek();
  const c = current(score.peek());
  if (!(res && c)) return;
  const si = score.peek().staves.findIndex((s) => s.id === c.staff);
  const g = res.layout.measures.find((m) => m.mi === c.mi && m.staff === si);
  const pg = g && pageEls[g.page];
  const box = pg?.closest('.scroll');
  if (!(g && pg && box)) return;
  const k = pg.clientWidth / res.pages[g.page].width;
  const y = pg.getBoundingClientRect().top - box.getBoundingClientRect().top + g.y * k;
  if (y < 40 || y + 60 * k > box.clientHeight)
    box.scrollTo({ top: Math.max(0, box.scrollTop + y - box.clientHeight / 3), behavior: 'instant' });
}

/** The page position of the caret (x, top of the staff), for drawing it; undefined when it is not on a drawn measure. */
export function caretGeom(c: Caret): { page: number; x: number; y: number } | undefined {
  const res = engraved.value;
  const sc = score.value;
  if (!res) return undefined;
  const si = sc.staves.findIndex((s) => s.id === c.staff);
  const mi = Math.min(c.mi, sc.measures.length - 1);
  const g = res.layout.measures.find((m) => m.mi === mi && m.staff === si);
  return g && { page: g.page, x: xOfTick(g, lengthOf(sc, mi), c.tick), y: g.y };
}
