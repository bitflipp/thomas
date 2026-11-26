// Keyboard note input: the caret (where the next note goes) and the next note's pitch, which is chosen before the note
// is entered (the arrow keys, + and -, the accidental buttons; the score pane shows the score with the note in it),
// entering it (W) or adding it to a chord (Shift+W), rests, slurs, moving the caret and deleting back.
// The caret keeps its position in time when the voice changes, so that one voice can be entered after the other over
// the same bars. A click in `interact.ts` places it, the key bindings are in `keys.ts`, and every change to the score
// is a command from src/editor/commands.ts committed through `run`, one undo step per key.

import { batch, signal } from '@preact/signals';
import type { EvAddr } from '../src/editor/addr.ts';
import { eventOf, voiceOf } from '../src/editor/addr.ts';
import * as C from '../src/editor/commands.ts';
import { comparePitch, plainAlter, transposeSteps } from '../src/editor/context.ts';
import { xOfTick } from '../src/editor/hit.ts';
import { eventAtTick } from '../src/editor/voice.ts';
import type { Dur, NoteEvent, Pitch, Score, TimedEvent } from '../src/model.ts';
import { flattenVoice, lengthOf } from '../src/model.ts';
import { pageEls } from './interact.ts';
import type { Caret, Preview } from './state.ts';

import {
  caret,
  dots,
  dur,
  engraved,
  entering,
  nextPitch,
  previewSource,
  run,
  say,
  score,
  selection,
  voice,
} from './state.ts';

/** Where an event starts: measure, staff, voice and the tick in the measure. Ticks survive edits that indices do not. */
type Place = { mi: number; staff: string; voice: number; tick: number };

/** The event of the voice that starts at `p.tick`, if any. */
function startingAt(sc: Score, p: Place): TimedEvent | undefined {
  const v = voiceOf(sc, p);
  return v && flattenVoice(v).find((t) => t.start === p.tick);
}

/** Counts changes to the note entered last (`prev`, `entryCaret`), so that the preview follows them. */
const entryRev = signal(0);

/** The note entered last: where it is, so that Shift+W adds to it and S puts a slur end on it. */
let prev: Place | null = null;

/** Forgets where the note entered last is. */
function forgetPrev(): void {
  prev = null;
  entryRev.value++;
}

/** The caret the last entry left; the note entered last only counts while the caret is still there. */
let entryCaret: Caret | null = null;

/** The note entered last, while the caret stays where that entry left it and the voice is unchanged; else null. */
function lastEntered(): typeof prev {
  return prev && caret.peek() === entryCaret && prev.voice === voice.peek() ? prev : null;
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

/** Moves the caret to `c`, forgets the note entered last and scrolls it into view; the next pitch stays as it is. */
function moveCaretTo(c: Caret): void {
  batch(() => {
    caret.value = c;
    forgetPrev();
  });
  revealCaret();
}

/** Puts the caret at `c` (a click): like moving it there, but the next pitch is taken from the notes there again. */
export function placeCaret(c: Caret): void {
  batch(() => {
    nextPitch.value = null;
    moveCaretTo(c);
  });
}

/** Moves the caret to the previous or next event start of the current voice, across barlines. */
export function moveCaret(dir: -1 | 1): void {
  const sc = score.peek();
  const c = current(sc);
  if (!c) return;
  const here = onsets(sc, c.mi, c.staff, voice.peek());
  if (dir > 0) {
    const t = here.find((x) => x > c.tick);
    if (t !== undefined) moveCaretTo({ ...c, tick: t });
    else if (c.mi + 1 < sc.measures.length) moveCaretTo({ ...c, mi: c.mi + 1, tick: 0 });
  } else {
    const t = [...here].reverse().find((x) => x < c.tick);
    if (t !== undefined) moveCaretTo({ ...c, tick: t });
    else if (c.mi > 0)
      moveCaretTo({ ...c, mi: c.mi - 1, tick: Math.max(...onsets(sc, c.mi - 1, c.staff, voice.peek())) });
  }
}

/** Moves the caret to the start of its measure, or of the previous measure when it is already there. */
export function caretToMeasureStart(): void {
  const c = current(score.peek());
  if (!c) return;
  moveCaretTo(c.tick > 0 || c.mi === 0 ? { ...c, tick: 0 } : { ...c, mi: c.mi - 1, tick: 0 });
}

/** The sounding length of the event that starts at `tick` of the voice in `sc`, or 0. */
function ticksAt(sc: Score, loc: { mi: number; staff: string; voice: number }, tick: number): number {
  const v = voiceOf(sc, loc);
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

/**
 * Runs `put`, which enters an event at the caret `c` in voice `loc`, and advances the caret past it in the same undo
 * step (adding a measure at the end when needed). Returns the caret after the event, or undefined when it was refused.
 */
function enterAndAdvance(
  c: Caret,
  loc: { mi: number; staff: string; voice: number },
  put: (s: Score) => Score,
): Caret | undefined {
  let next: Caret | undefined;
  const ok = run((s) => {
    const s1 = put(s);
    const r = advance(s1, c, ticksAt(s1, loc, c.tick));
    next = r.caret;
    return r.score;
  });
  return ok ? next : undefined;
}

/** Enters a note at the caret and moves the caret on. Returns whether it was entered. */
function enterPitch(c: Caret, pitch: Pitch): boolean {
  const loc = { mi: c.mi, staff: c.staff, voice: voice.peek() };
  const d = { base: dur.peek(), dots: dots.peek() };
  const next = enterAndAdvance(c, loc, (s) => C.enterNote(s, loc, c.tick, d, pitch));
  if (!next) return false;
  prev = { ...loc, tick: c.tick };
  if (slurFrom.peek() === 'next') slurFrom.value = prev;
  batch(() => {
    selection.value = [];
    nextPitch.value = pitch;
    caret.value = next;
    entryCaret = next;
    entryRev.value++;
  });
  revealCaret();
  return true;
}

/** The top note of the last note before the caret in the voice (in this or the previous measure). */
function noteBefore(sc: Score, c: Caret): Pitch | undefined {
  const vid = voice.peek();
  const find = (mi: number, before: number) => {
    const v = voiceOf(sc, { mi, staff: c.staff, voice: vid });
    return v && [...flattenVoice(v)].reverse().find((t) => t.start < before && t.ev.kind === 'note')?.ev;
  };
  const e = find(c.mi, c.tick) ?? (c.mi > 0 ? find(c.mi - 1, Number.POSITIVE_INFINITY) : undefined);
  return e?.kind === 'note' ? { ...e.pitches[e.pitches.length - 1].pitch } : undefined;
}

/** The note W enters when there is nothing to start from. */
const MIDDLE_C: Pitch = { step: 'c', octave: 4, alter: 0 };

/**
 * The pitch W enters at caret `c`: the one chosen for the next note (`nextPitch`), else the top of the note before the
 * caret, else middle C.
 */
function pitchAt(sc: Score, c: Caret): Pitch {
  return nextPitch.peek() ?? noteBefore(sc, c) ?? MIDDLE_C;
}

/** Enters the next note at the caret in the current duration (key W), with the pitch the preview shows. */
export function enterNext(): void {
  const sc = score.peek();
  const c = current(sc);
  if (c) enterPitch(c, pitchAt(sc, c));
}

/**
 * Changes the pitch of the next note by `f`, starting from the pitch the preview shows: with `chord` (Shift held) the
 * tone Shift+W would add (`chordTone`), at the chord's position. With `skip`, `f` is applied again while the result is a
 * pitch the chord already has, so that stepping through a chord never lands on one of its notes.
 */
function changeNext(f: (p: Pitch, sc: Score, at: Caret) => Pitch, chord = false, skip = false): void {
  const sc = score.peek();
  const c = current(sc);
  if (!c) return;
  const t = chord ? chordTone(sc) : undefined;
  const at = t ? { mi: t.at.mi, staff: t.at.staff, tick: t.te.start } : c;
  const has = (p: Pitch) => !!t && hasPitch(t.te.ev, p);
  let p = f(t ? t.pitch : pitchAt(sc, c), sc, at);
  for (let i = 0; skip && i < 8 && has(p); i++) p = f(p, sc, at);
  nextPitch.value = p;
}

/** Whether chord `ev` has pitch `p` (with the same spelling). */
function hasPitch(ev: NoteEvent, p: Pitch): boolean {
  return ev.pitches.some((np) => comparePitch(np.pitch, p) === 0);
}

/**
 * Moves the next note (with `chord`: the tone to add to the chord) a step up or down the staff; the alteration is what
 * the key and the measure give there.
 */
export function stepNext(d: 1 | -1, chord = false): void {
  changeNext(
    (p, sc, at) => {
      const q = transposeSteps(p, d);
      return { ...q, alter: plainAlter(sc, at.staff, at.mi, at.tick, q.step, q.octave) };
    },
    chord,
    true,
  );
}

/** Moves the next note (with `chord`: the tone to add to the chord) an octave up or down, keeping its spelling. */
export function octaveNext(d: 1 | -1, chord = false): void {
  changeNext((p) => transposeSteps(p, 7 * d), chord, true);
}

/** Raises or lowers the next note (with `chord`: the tone to add to the chord) by an accidental (keys + and -). */
export function alterNext(d: 1 | -1, chord = false): void {
  changeNext((p) => ({ ...p, alter: Math.max(-2, Math.min(2, p.alter + d)) }), chord);
}

/**
 * The accidental the next note carries, for the palette: its alteration where the key and the measure would give
 * another one, else undefined. Reading it subscribes to what decides the next note.
 */
export function nextAccidental(): number | undefined {
  const n = nextNote();
  if (!n || n.chord) return undefined;
  const plain = plainAlter(score.peek(), n.staff, n.mi, n.tick, n.pitch.step, n.pitch.octave);
  return n.pitch.alter !== plain ? n.pitch.alter : undefined;
}

/** Picks an accidental in the palette for the next note; picking the one it already carries takes it off. */
export function pickNextAccidental(a: number): void {
  const off = nextAccidental() === a;
  changeNext((p, sc, c) => ({ ...p, alter: off ? plainAlter(sc, c.staff, c.mi, c.tick, p.step, p.octave) : a }));
}

/**
 * Where an open slur starts: a note, `'next'` for the next note entered, or null. S opens it at the note entered last
 * (or at the next one when nothing was entered yet) and closes it at the note entered last.
 */
export const slurFrom = signal<Place | 'next' | null>(null);

/** The address of the event that starts at `p.tick` in its voice. */
function addrAt(sc: Score, p: Place): EvAddr | undefined {
  const te = startingAt(sc, p);
  return te && { mi: p.mi, staff: p.staff, voice: p.voice, idx: te.index };
}

/** Opens a slur at the note entered last, or closes the open one there. */
export function toggleSlur(): void {
  const from = slurFrom.peek();
  const to = lastEntered();
  if (!from) {
    slurFrom.value = to ?? 'next';
    return;
  }
  slurFrom.value = null;
  if (from === 'next' || !to) return;
  const sc = score.peek();
  const a = addrAt(sc, from);
  const b = addrAt(sc, to);
  if (!(a && b)) {
    say('The slur lost its notes', true);
    return;
  }
  run((s) => C.addSlur(s, a, b));
}

/**
 * The note Shift+W adds to. In note input: the note just entered while the caret is still behind it, else the note at
 * the caret, else the one before it in the voice. In select mode: the selected note.
 */
function chordTarget(sc: Score): EvAddr | undefined {
  if (!entering()) {
    const sel = selection.peek().find((r) => r.t === 'ev');
    return sel?.t === 'ev' ? sel : undefined;
  }
  const le = lastEntered();
  if (le) return addrAt(sc, le);
  const c = current(sc);
  const v = c && voiceOf(sc, { mi: c.mi, staff: c.staff, voice: voice.peek() });
  if (!(c && v)) return undefined;
  const te =
    flattenVoice(v).find((t) => t.start === c.tick && t.ev.kind === 'note') ??
    [...flattenVoice(v)].reverse().find((t) => t.start < c.tick && t.ev.kind === 'note');
  return te && { mi: c.mi, staff: c.staff, voice: voice.peek(), idx: te.index };
}

/**
 * The tone Shift+W adds to the target note (`chordTarget`). In note input it is the pitch of the next note, unless the
 * chord has it already; otherwise (and in select mode) a third above the top of the chord, in the key.
 */
function chordTone(sc: Score): { at: EvAddr; te: TimedEvent & { ev: NoteEvent }; pitch: Pitch } | undefined {
  const at = chordTarget(sc);
  const v = at && voiceOf(sc, at);
  const te = v && at && flattenVoice(v)[at.idx];
  if (!(at && te && te.ev.kind === 'note')) return undefined;
  const c = entering() ? current(sc) : null;
  const want = c ? pitchAt(sc, c) : undefined;
  let pitch = want && !hasPitch(te.ev, want) ? want : undefined;
  if (!pitch) {
    const q = transposeSteps(te.ev.pitches[te.ev.pitches.length - 1].pitch, 2);
    pitch = { ...q, alter: plainAlter(sc, at.staff, at.mi, te.start, q.step, q.octave) };
  }
  return { at, te: te as TimedEvent & { ev: NoteEvent }, pitch };
}

/**
 * Adds a tone to the target note (`chordTarget`; the pitch is `chordTone`'s). In note input the caret stays where it is
 * and the added pitch becomes the next note's, so that the arrows choose the next tone from there; in select mode
 * only the new head is selected, so that the arrows put it in place.
 */
export function addChordTone(): void {
  const t = chordTone(score.peek());
  if (!t) {
    say('Enter or select a note first', true);
    return;
  }
  const { at, te, pitch } = t;
  const loc = { mi: at.mi, staff: at.staff, voice: at.voice };
  if (!run((s) => C.enterNote(s, loc, te.start, te.ev.dur, pitch, { chord: true }))) return;
  if (entering()) {
    nextPitch.value = pitch;
    return;
  }
  const e = eventOf(score.peek(), at);
  const pi = e?.kind === 'note' ? e.pitches.findIndex((p) => comparePitch(p.pitch, pitch) === 0) : -1;
  selection.value = [{ t: 'ev', ...loc, idx: at.idx, ...(pi >= 0 ? { pi } : {}) }];
}

/** Whether Shift is held, so that the preview shows the chord tone Shift+W would add instead of the note W enters. */
const shiftHeld = signal(false);

/** Follows the Shift key for `shiftHeld`; returns the function that stops it. */
export function trackShift(): () => void {
  const on = (e: KeyboardEvent) => {
    if (e.shiftKey !== shiftHeld.peek()) shiftHeld.value = e.shiftKey;
  };
  const off = () => {
    shiftHeld.value = false;
  };
  addEventListener('keydown', on);
  addEventListener('keyup', on);
  addEventListener('blur', off);
  return () => {
    removeEventListener('keydown', on);
    removeEventListener('keyup', on);
    removeEventListener('blur', off);
  };
}

/** The note the next W (or with `chord`, Shift+W) would enter: where, in which voice, its pitch and duration. */
export type NextNote = {
  mi: number;
  staff: string;
  voice: number;
  tick: number;
  pitch: Pitch;
  dur: Dur;
  chord: boolean;
};

/**
 * The next entry in note input: what Shift+W would add while Shift is held (when there is a note to add to), else what
 * W would enter. Reads the signals it depends on, so that whatever is computed from it follows the caret, the score,
 * the next pitch, the voice, the duration, the Shift key and the note entered last.
 */
export function nextNote(): NextNote | undefined {
  const sc = score.value;
  const c0 = caret.value;
  const d = { base: dur.value, dots: dots.value };
  const vid = voice.value;
  // The next pitch and the note entered last decide the pitch and the chord (through `peek` in `pitchAt` and
  // `chordTarget`); reading them here makes the caller depend on them.
  nextPitch.value;
  entryRev.value;
  if (!(c0 && entering())) return undefined;
  if (shiftHeld.value) {
    const t = chordTone(sc);
    if (t) return { ...t.at, tick: t.te.start, pitch: t.pitch, dur: t.te.ev.dur, chord: true };
  }
  const c = current(sc);
  if (!c) return undefined;
  return { mi: c.mi, staff: c.staff, voice: vid, tick: c.tick, pitch: pitchAt(sc, c), dur: d, chord: false };
}

/**
 * The would-be score of the next entry (`nextNote`), built by the same commands as W and Shift+W (with the measure W
 * adds at the end of the score); null when there is nothing to enter or the entry would be refused.
 */
function wouldBe(): Preview | null {
  const n = nextNote();
  if (!n) return null;
  try {
    return build(n);
  } catch (e) {
    if (e instanceof C.EditError) return null;
    throw e;
  }
}

/** The would-be score of entry `n`; throws the command's `EditError` when the entry is refused. */
function build(n: NextNote): Preview | null {
  const loc = { mi: n.mi, staff: n.staff, voice: n.voice };
  const s1 = C.enterNote(score.peek(), loc, n.tick, n.dur, n.pitch, n.chord ? { chord: true } : {});
  const te = startingAt(s1, { ...loc, tick: n.tick });
  if (te?.ev.kind !== 'note') return null;
  const at = { ...loc, idx: te.index };
  if (n.chord) return { score: s1, at, pi: te.ev.pitches.findIndex((p) => comparePitch(p.pitch, n.pitch) === 0) };
  return { score: advance(s1, { mi: n.mi, staff: n.staff, tick: n.tick }, te.ticks).score, at };
}

/** Why entry `n` would be refused (the command's message), or undefined when it would not be. */
export function refusalOf(n: NextNote): string | undefined {
  try {
    build(n);
    return undefined;
  } catch (e) {
    if (e instanceof C.EditError) return e.message;
    throw e;
  }
}

previewSource.value = wouldBe;

/** Enters a rest at the caret and moves the caret on (key R). */
export function enterRestAtCaret(): void {
  const sc = score.peek();
  const c = current(sc);
  if (!c) return;
  const loc = { mi: c.mi, staff: c.staff, voice: voice.peek() };
  const d = { base: dur.peek(), dots: dots.peek() };
  const next = enterAndAdvance(c, loc, (s) => C.enterRest(s, loc, c.tick, d));
  if (!next) return;
  batch(() => {
    selection.value = [];
    forgetPrev();
    caret.value = next;
  });
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
  const te = startingAt(sc, { mi, staff: c.staff, voice: vid, tick });
  if (te && te.ev.kind === 'note') run((s) => C.deleteEvents(s, [{ mi, staff: c.staff, voice: vid, idx: te.index }]));
  caret.value = { mi, staff: c.staff, tick };
  forgetPrev();
  selection.value = [];
  revealCaret();
}

/** Scrolls the score pane just enough to bring the caret into view (a third of the way down when it was out of it). */
function revealCaret(): void {
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
