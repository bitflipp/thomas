// Actions on the selection, shared by the palette, the Properties panel and the keyboard shortcuts so that all
// three behave the same. Each one runs a pure command from src/editor/commands.ts on every selected
// event and commits the result as one undoable step; a refusal (`EditError`) is shown in the status
// line instead of changing anything.

import { effect } from '@preact/signals';
import type { EvAddr, Ref } from '../src/editor/addr.ts';
import { eventOf, voiceOf } from '../src/editor/addr.ts';
import * as C from '../src/editor/commands.ts';
import { alterBefore, comparePitch } from '../src/editor/context.ts';
import { drawnTieSide } from '../src/editor/hit.ts';
import type { BaseDur, Dur, Score } from '../src/model.ts';
import { flattenVoice } from '../src/model.ts';
import { evRefs, graceRefs, sameSystem } from './interact.ts';
import { acc, caret, commit, dots, dur, entering, hit, run, say, score, selection, setTool, voice } from './state.ts';

/**
 * Orders event addresses from the end of the score backward, so that edits applied in this order keep earlier
 * indices valid.
 */
const sortedDesc = (a: EvAddr, b: EvAddr) =>
  a.mi - b.mi || a.staff.localeCompare(b.staff) || a.voice - b.voice || b.idx - a.idx;

/** Apply a new duration to the selected events (from the end so earlier indices stay valid). */
function setDurationSel(d: Dur): void {
  const refs = [...evRefs()].sort(sortedDesc);
  if (!refs.length) return;
  let s = score.peek();
  try {
    for (const r of refs) s = C.setDuration(s, r, d);
    commit(s);
  } catch (e) {
    if (e instanceof C.EditError) say(e.message, true);
    else throw e;
  }
}

// The next note's value follows the selection: selecting a note or rest makes its duration and dots the input
// settings, and its voice the input voice, so that entering notes afterwards continues with what was last seen.

effect(() => {
  const sel = selection.value;
  if (entering()) return;
  const r = sel.find((x) => x.t === 'ev');
  const e = r && eventOf(score.peek(), r);
  if (!e) return;
  dur.value = e.dur.base;
  dots.value = e.dur.dots;
  voice.value = r.voice;
});

/** Whether the palette's duration, dot and accidental buttons act on the selected events (select mode, events selected). */
export function editsSelection(): boolean {
  return !entering() && evRefs().length > 0;
}

/** The note value the duration buttons show: the first selected event's when they edit the selection, else the next note's. */
export function shownDuration(): { base: BaseDur; dots: number } {
  const e = editsSelection() ? eventOf(score.value, evRefs()[0]) : undefined;
  return e ? { base: e.dur.base, dots: e.dur.dots } : { base: dur.value, dots: dots.value };
}

/**
 * Picks a note value. In note input it sets the next note's value and never touches the score. In select
 * mode it changes the selected events and the next note follows; with nothing selected it sets the next note's
 * value and switches to note input.
 */
export function chooseDuration(base: BaseDur): void {
  if (editsSelection()) {
    dur.value = base;
    setDurationSel({ base, dots: shownDuration().dots });
    return;
  }
  dur.value = base;
  if (!entering()) setTool('note');
}

/** Picks the number of dots, by the same rule as `chooseDuration`. */
export function chooseDots(n: number): void {
  if (editsSelection()) {
    dots.value = n;
    setDurationSel({ base: shownDuration().base, dots: n });
    return;
  }
  dots.value = n;
  if (!entering()) setTool('note');
}

/**
 * The pitches of the selected notes that an accidental applies to (one head of a chord when a head is selected),
 * each with the alteration in force before it (key signature and earlier accidentals in the measure).
 */
function selectedPitches(): { alter: number; before: number }[] {
  const sc = score.value;
  const refs = evRefs();
  const head = refs.find((r) => r.pi !== undefined)?.pi;
  return refs.flatMap((r) => {
    const e = eventOf(sc, r);
    if (e?.kind !== 'note') return [];
    return e.pitches
      .filter((_, i) => head === undefined || i === head)
      .map((p) => ({ alter: p.pitch.alter, before: alterBefore(sc, r, p.pitch) }));
  });
}

/**
 * The accidental applied to a pitch: its alteration unless it is a natural with nothing to cancel (no key signature
 * or earlier accidental on that step), so a note altered by the key or an earlier accidental counts.
 */
const appliedAlter = (p: { alter: number; before: number }): number | undefined =>
  p.alter !== 0 || p.before !== 0 ? p.alter : undefined;

/**
 * The accidental applied to the selected notes for the palette: `undefined` when nothing is selected or none is
 * applied, `mixed` when they differ. Reading it subscribes to the selection and the score.
 */
export function selectedAlter(): number | 'mixed' | undefined {
  const alters = new Set(selectedPitches().map(appliedAlter));
  if (alters.size > 1) return 'mixed';
  return [...alters][0];
}

/**
 * Picks an accidental in the palette. With notes selected it alters them; clicking the accidental they already have
 * takes it off (a natural that cancels something goes back to what is in force before the note, anything else
 * becomes natural). The input tool is left alone then; without notes selected it toggles the input tool's accidental.
 */
export function chooseAccidental(a: number): void {
  const ps = selectedPitches();
  if (!ps.length) {
    acc.value = acc.value === a ? undefined : a;
    return;
  }
  if (selectedAlter() !== a) setAccidentalSel(a);
  else if (a !== 0) setAccidentalSel(0);
  else if (new Set(ps.map((p) => p.before)).size === 1) setAccidentalSel(ps[0].before);
}

/**
 * Sets the alteration of the selected notes (of one pitch of a chord when a single head is selected); `undefined`
 * does nothing.
 */
function setAccidentalSel(alter: number | undefined): void {
  const refs = evRefs();
  if (!refs.length || alter === undefined) return;
  run((s) =>
    C.updateNotes(s, refs, (n) => {
      n.pitches.forEach((np, i) => {
        const t = refs.find((r) => r.pi !== undefined);
        if (t?.pi !== undefined && t.pi !== i) return;
        np.pitch = { ...np.pitch, alter };
      });
    }),
  );
}

/** Transposes the selection by `semis` semitones or `steps` diatonic steps. */
export function nudge(semis?: number, steps?: number): void {
  const graces = graceRefs();
  if (graces.length && !evRefs().length) {
    // A grace note moves by letter-name steps; a semitone key press is one step, an octave key press seven.
    const n = steps ?? (Math.abs(semis ?? 0) >= 12 ? Math.sign(semis ?? 0) * 7 : (semis ?? 0));
    run((s) => graces.reduce((x, r) => C.transposeGrace(x, r, r.gi, n), s));
    return;
  }
  const refs = evRefs();
  if (!refs.length) return;
  editHeads((s) => C.transpose(s, refs, { semis, steps }));
}

/**
 * Runs an edit that moves selected heads of chords, then selects each moved head again. A chord is kept in pitch order,
 * so a head that passes another changes its index; it is found as the pitch that is not one of the others.
 */
export function editHeads(edit: (s: Score) => Score): boolean {
  const before = selection.peek();
  const sc0 = score.peek();
  if (!run(edit)) return false;
  const sc = score.peek();
  selection.value = before.map((r) => {
    if (r.t !== 'ev' || r.pi === undefined) return r;
    const a = eventOf(sc0, r);
    const b = eventOf(sc, r);
    if (a?.kind !== 'note' || b?.kind !== 'note') return r;
    const others = a.pitches.filter((_, i) => i !== r.pi).map((p) => p.pitch);
    const pi = b.pitches.findIndex((p) => {
      const k = others.findIndex((o) => comparePitch(o, p.pitch) === 0);
      if (k < 0) return true;
      others.splice(k, 1);
      return false;
    });
    return { ...r, pi: pi < 0 ? Math.min(r.pi, b.pitches.length - 1) : pi };
  });
  return true;
}

/** Selects the next head up or down the chord of the selected note (the top or bottom one when the whole note is selected). */
export function stepHead(d: 1 | -1): void {
  const refs = evRefs();
  if (refs.length !== 1) return;
  const r = refs[0];
  const e = eventOf(score.peek(), r);
  if (e?.kind !== 'note') return;
  const n = e.pitches.length;
  const pi = r.pi === undefined ? (d > 0 ? n - 1 : 0) : Math.max(0, Math.min(n - 1, r.pi + d));
  selection.value = [{ ...r, pi }];
}

/** Cycles the stem direction of the selected events: up, down, automatic. */
export function flipStem(): void {
  const refs = evRefs();
  if (!refs.length) return;
  const first = eventOf(score.peek(), refs[0]);
  const next = first?.stem === 'up' ? 'down' : first?.stem === 'down' ? undefined : 'up';
  run((s) =>
    C.updateEvents(s, refs, (e) => {
      if (next) e.stem = next;
      else delete e.stem;
    }),
  );
}

/** The two voices (of one staff) that the selected events belong to, or undefined when it is not exactly two. */
export function flippableVoices(): { staff: string; a: number; b: number; mis: number[] } | undefined {
  const refs = evRefs();
  if (!refs.length) return undefined;
  const staff = refs[0].staff;
  if (refs.some((r) => r.staff !== staff)) return undefined;
  const voices = [...new Set(refs.map((r) => r.voice))].sort((x, y) => x - y);
  if (voices.length !== 2) return undefined;
  const mis = [...new Set(refs.map((r) => r.mi))].sort((x, y) => x - y);
  return { staff, a: voices[0], b: voices[1], mis };
}

/** Exchanges the two voices of the selection in the measures it touches. */
export function flipVoices(): void {
  const f = flippableVoices();
  if (!f) {
    say('Select notes of two voices in one staff', true);
    return;
  }
  run((s) => C.flipVoices(s, f.staff, f.a, f.b, f.mis));
}

/** Slurs the selected notes of one voice from the first to the last. */
export function slurSelection(): void {
  const refs = [...evRefs()].sort((a, b) => a.mi - b.mi || a.idx - b.idx);
  if (refs.length < 2) {
    say('Select at least two notes in one voice', true);
    return;
  }
  const a = refs[0];
  const b = refs[refs.length - 1];
  run((s) => C.addSlur(s, a, b));
}

/** A line between the first and the last selected note (any voices or staves, but one system). */
export function lineSelection(): void {
  const refs = [...evRefs()].sort((a, b) => a.mi - b.mi || a.idx - b.idx);
  const h = hit.peek();
  if (refs.length !== 2) {
    say('Select two notes', true);
    return;
  }
  if (h && !sameSystem(h, refs[0], refs[1])) {
    say('A line joins notes of one system', true);
    return;
  }
  run((s) => C.addLine(s, refs[0], refs[1]));
}

/** Toggles the ties of the selected notes. */
export function tieSelection(): void {
  const refs = evRefs();
  if (refs.length) run((s) => C.toggleTie(s, refs));
}

/** Flips the side of the selected ties, or of the ties of the selected notes. */
export function flipTie(): void {
  const h = hit.peek();
  const ties = selection.peek().filter((r): r is Extract<Ref, { t: 'tie' }> => r.t === 'tie');
  const refs: (EvAddr & { pi?: number })[] = ties.length ? ties : evRefs();
  if (!refs.length) return;
  run((s) => C.flipTie(s, refs, (a, pi) => (h && drawnTieSide(h, a, pi)) || 'above'));
}

/** X: flips the selected ties when there are any, else the stems of the selected notes. */
export function flipStemOrTie(): void {
  if (selection.peek().some((r) => r.t === 'tie')) flipTie();
  else flipStem();
}

/** Toggles a fermata or a trill on the selected events (a trill only on notes). */
export function toggleOrnament(which: 'fermata' | 'trill'): void {
  const refs = evRefs();
  if (refs.length) run((s) => (which === 'fermata' ? C.toggleFermata(s, refs) : C.toggleTrill(s, refs)));
}

/** Moves the selection to the previous or next event in the voice; `extend` adds it instead. */
export function stepSelection(dir: -1 | 1, extend = false): void {
  const sc = score.peek();
  const cur = selection.peek().filter((r) => r.t === 'ev');
  if (!cur.length) return;
  const last = cur[cur.length - 1] as EvAddr;
  const v = sc.measures[last.mi]?.staves[last.staff]?.voices.find((x) => x.id === last.voice);
  if (!v) return;
  let mi = last.mi;
  let idx = last.idx + dir;
  const count = (m: number) =>
    sc.measures[m]?.staves[last.staff]?.voices
      .find((x) => x.id === last.voice)
      ?.items.reduce((n, it) => n + countEvents(it), 0) ?? 0;
  if (idx < 0) {
    mi--;
    if (mi < 0) return;
    idx = count(mi) - 1;
  } else if (idx >= count(mi)) {
    mi++;
    idx = 0;
    if (mi >= sc.measures.length) return;
  }
  if (idx < 0 || count(mi) === 0) return;
  const ref = { t: 'ev' as const, mi, staff: last.staff, voice: last.voice, idx };
  selection.value = extend ? [...selection.peek(), ref] : [ref];
}

/** The number of events in an item (a tuplet or beam counts its members). */
function countEvents(it: import('../src/model.ts').Item): number {
  return 'items' in it ? it.items.reduce((n, x) => n + countEvents(x), 0) : 1;
}

/** Moves the selected notes to voice `n` of their staff (same ticks), leaves rests behind, and selects them there. */
export function moveSelectionToVoice(n: number): void {
  const sc = score.peek();
  const refs = evRefs();
  if (!refs.length) {
    say('Select notes to move', true);
    return;
  }
  const starts = refs.flatMap((r) => {
    const v = voiceOf(sc, r);
    const te = v && flattenVoice(v)[r.idx];
    return te && te.ev.kind === 'note' && r.voice !== n ? [{ mi: r.mi, staff: r.staff, tick: te.start }] : [];
  });
  if (!run((s) => C.moveToVoice(s, refs, n))) return;
  const after = score.peek();
  voice.value = n;
  selection.value = starts.flatMap((p) => {
    const v = voiceOf(after, { mi: p.mi, staff: p.staff, voice: n });
    const te = v && flattenVoice(v).find((t) => t.start === p.tick);
    return te ? [{ t: 'ev' as const, mi: p.mi, staff: p.staff, voice: n, idx: te.index }] : [];
  });
}

/**
 * Selects every event of voice `n` in the measures of the selection (the whole score when nothing is selected), on
 * the staff of the selection or of the caret, and makes `n` the input voice.
 */
export function selectVoice(n: number): void {
  const sc = score.peek();
  const sel = selection.peek();
  const mis = sel.flatMap((r) => (r.t === 'measure' || 'mi' in r ? [r.mi] : []));
  const first = sel.find((r) => r.t === 'ev');
  const staff = first?.t === 'ev' ? first.staff : (caret.peek()?.staff ?? sc.staves[0].id);
  const a = mis.length ? Math.min(...mis) : 0;
  const b = mis.length ? Math.max(...mis) : sc.measures.length - 1;
  const refs: Ref[] = [];
  for (let mi = a; mi <= b; mi++) {
    const v = voiceOf(sc, { mi, staff, voice: n });
    if (v) for (const te of flattenVoice(v)) refs.push({ t: 'ev', mi, staff, voice: n, idx: te.index });
  }
  if (!refs.length) {
    say(`Voice ${n} has nothing there`, true);
    return;
  }
  voice.value = n;
  selection.value = refs;
}
