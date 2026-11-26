// Application state: the score (immutable, with undo history), selection, tool settings, and what is derived from them.
//
// Everything is a preact signal. The score signal holds an immutable `Score`; an edit replaces it
// (`commit`), so undo is just a stack of earlier values (structural sharing keeps that cheap). The
// engraving and hit index are derived by effects from the shown score (in note input the would-be score, see below), the
// text from the score, so no component recomputes them.

import { batch, computed, effect, signal } from '@preact/signals';

import type { EvAddr, Ref } from '../src/editor/addr.ts';
import { voiceOf } from '../src/editor/addr.ts';
import { EditError } from '../src/editor/commands.ts';
import type { HitIndex } from '../src/editor/hit.ts';
import { buildHitIndex } from '../src/editor/hit.ts';
import type { Engraved, EngraveOptions } from '../src/engrave/system.ts';
import { createEngraveCache, engrave } from '../src/engrave/system.ts';
import type { BaseDur, Clef, Pitch, Score } from '../src/model.ts';
import { flattenVoice, validate } from '../src/model.ts';
import { parseText, writeText, writeTextMap } from '../src/textformat.ts';

// The document: the score signal with its undo/redo history, the file name and dirty flag, toast
// messages, and the functions that change the score (`commit`, `run`, `undo`, `redo`, `load`).

const EMPTY = `page 210x297 margin=10 space=1.75
staff s1 clef=G2 name="Piano"
staff s2 clef=F4 name="Piano"
brace s1 s2
title "Untitled"

m1 time=4/4 key=0
  s1.1: R:1
  s2.1: R:1
m2
  s1.1: R:1
  s2.1: R:1
m3
  s1.1: R:1
  s2.1: R:1
m4 barline=final
  s1.1: R:1
  s2.1: R:1
`;

export const NEW_SCORE_TEXT = EMPTY;

export const score = signal<Score>(parseText(EMPTY));
export const fileName = signal('score.txt');

/** The path of the file the score was opened from or saved to, null for a score that has no file yet. */
export const filePath = signal<string | null>(null);

export const dirty = signal(false);

/** Counts documents opened or created (not edits). */
export const docId = signal(0);

const past: Score[] = [];
const future: Score[] = [];
export const histLen = signal({ undo: 0, redo: 0 });

/** Publishes the sizes of the undo and redo stacks. */
const syncHist = () => {
  histLen.value = { undo: past.length, redo: future.length };
};

export const toast = signal<{ msg: string; err: boolean; id: number } | null>(null);
let toastId = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** Shows a message in the status line for a few seconds; `err` marks it as an error. */
export function say(msg: string, err = false): void {
  const id = ++toastId;
  toast.value = { msg, err, id };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      if (toast.value?.id === id) toast.value = null;
    },
    err ? 4500 : 2200,
  );
}

/** Makes `next` the current score as one undoable step (and marks the document as changed). */
export function commit(next: Score): void {
  const cur = score.peek();
  if (next === cur) return;
  past.push(cur);
  if (past.length > 300) past.shift();
  future.length = 0;
  batch(() => {
    score.value = next;
    dirty.value = true;
  });
  syncHist();
}

/** Run an edit command on the current score; a refusal is shown to the user instead of thrown. Returns whether it applied. */
export function run(fn: (s: Score) => Score): boolean {
  try {
    commit(fn(score.peek()));
    return true;
  } catch (e) {
    if (e instanceof EditError) {
      say(e.message, true);
      return false;
    }
    console.error(e);
    say(`Unexpected error: ${(e as Error).message}`, true);
    return false;
  }
}

/** Steps back to the previous score. */
export function undo(): void {
  const p = past.pop();
  if (!p) return;
  future.push(score.peek());
  batch(() => {
    score.value = p;
    dirty.value = true;
  });
  syncHist();
}

/** Steps forward again after an undo. */
export function redo(): void {
  const f = future.pop();
  if (!f) return;
  past.push(score.peek());
  batch(() => {
    score.value = f;
    dirty.value = true;
  });
  syncHist();
}

/** Replace the whole document (open/new): history restarts. */
export function load(s: Score, name?: string): void {
  past.length = 0;
  future.length = 0;
  syncHist();
  batch(() => {
    score.value = s;
    selection.value = [];
    dirty.value = false;
    filePath.value = null;
    docId.value++;
    if (name) fileName.value = name;
  });
}

/**
 * Loads a score from text-format source as a new document; false (with a message) if it does not parse or
 * validate.
 */
export function loadText(t: string, name?: string): boolean {
  try {
    const s = parseText(t);
    const errs = validate(s);
    if (errs.length) {
      say(errs[0], true);
      return false;
    }
    load(s, name);
    return true;
  } catch (e) {
    say((e as Error).message, true);
    return false;
  }
}

// View settings: zoom, which panes are shown, colors and other display options. None of them
// is part of the score.

export const zoom = signal(1);
export const shownZoom = signal(1); // This is the zoom the pages are displayed at (it differs from `zoom` while fitting).
export const fit = signal(true); // When set, the pages are fitted to the pane width.
export const showProperties = signal(true);

/** What the main area shows: the score (with the palette and Properties), the Expression view, or the score as text. */
export type Mode = 'score' | 'expression' | 'text';

/** The mode of the main area, chosen in the toolbar (Ctrl Space or Ctrl M: Expression, Ctrl E: Text). */
export const mode = signal<Mode>('score');

/** Whether the Expression view is shown in place of the score. */
export const showExpression = computed(() => mode.value === 'expression');

/** Switches to `m`, or back to the score when `m` is shown already (the shortcuts of the modes). */
export function toggleMode(m: Mode): void {
  mode.value = mode.peek() === m ? 'score' : m;
}

/** The zoom of the Expression roll at the start, in pixels per quarter note; the toolbar shows the zoom as a percentage of it. */
export const EXPR_BASE_PPQ = 56;

/**
 * The part of the piece the Expression pane shows: the tick at its left edge, the width of a quarter note in pixels (the
 * zoom, which changes only the width of the notes) and how far the roll is scrolled down from its highest pitch in pixels
 * (negative until the pane has placed it on the music).
 */
export const exprView = signal({ left: 0, ppq: EXPR_BASE_PPQ, top: -1 });

export const space = signal<number | null>(null);

/** True while the PDF print dialog is being prepared: every page then generates its SVG, whether near the viewport or not. */
export const printing = signal(false);

export const voiceColors = signal(true);

/** Ink color of each voice when voice colors are on (voice 1 stays black). */
export const VOICE_COLORS: Record<number, string> = { 2: '#1a8f4a', 3: '#d9780a', 4: '#8e44ad' };

export const timing = signal(0);

/** Set once the music font is loaded; nothing is engraved before. */
export const ready = signal(false);

export const engraved = signal<Engraved | null>(null);
export const hit = signal<HitIndex | null>(null);
export const engraveError = signal('');

// The score that is engraved and shown. In note input it is the would-be score: the score with the note the next W
// (or Shift+W) would enter already in it, so that the measure is spaced, beamed and split into rests exactly as it will
// be. `caret.ts` supplies the would-be score through `previewSource`; the engraving, the hit index and the drawing
// follow `shown`, everything else (playback, text, undo, layers) the real score. Refs from the hit index name things
// in the shown score, so a click turns them back with `realRef`.

/** A would-be score: the score with one note entered, the address of that note and, when only a head of it is new (a chord tone), that head. */
export interface Preview {
  score: Score;
  at: EvAddr;
  pi?: number;
}

/** Gives the would-be score of note input, or null when nothing is about to be entered (or the entry would be refused). */
export const previewSource = signal<() => Preview | null>(() => null);

/** The would-be score of note input, or null (recomputed whenever what decides the next note changes). */
export const preview = computed(() => previewSource.value());

/** The score that is engraved: the would-be score in note input, else the score. */
export const shown = computed(() => preview.value?.score ?? score.value);

/** Whether `r` names the note of the preview (or, for a chord tone, its new head). */
export function isPreviewNote(pv: Preview, r: Ref): boolean {
  const a = pv.at;
  return (
    r.t === 'ev' &&
    r.mi === a.mi &&
    r.staff === a.staff &&
    r.voice === a.voice &&
    r.idx === a.idx &&
    (pv.pi === undefined || r.pi === pv.pi)
  );
}

/** The index, in the same voice of score `b`, of the event that starts where event `r.idx` of score `a` starts. */
function sameStart(r: EvAddr, a: Score, b: Score): number | undefined {
  const va = voiceOf(a, r);
  const te = va && flattenVoice(va)[r.idx];
  const vb = voiceOf(b, r);
  return te && vb ? flattenVoice(vb).find((t) => t.start === te.start)?.index : undefined;
}

/**
 * Moves ref `r` between the score and the shown score (`toShown`): an event (or a tie, slur, mark ... hanging on one)
 * is found by the tick it starts at in its voice, and a head index steps over the new head of a chord tone. Undefined
 * when there is no such event there (the note of the preview, or a note it overwrites).
 */
function moveRef(r: Ref, toShown: boolean): Ref | undefined {
  const pv = preview.peek();
  if (!pv || r.t === 'measure') return r;
  if (!toShown && isPreviewNote(pv, r)) return undefined;
  const idx = toShown ? sameStart(r, score.peek(), pv.score) : sameStart(r, pv.score, score.peek());
  if (idx === undefined) return undefined;
  const out = { ...r, idx } as Ref;
  if (out.t === 'ev' && out.pi !== undefined && pv.pi !== undefined) {
    const a = pv.at;
    const chord = a.mi === r.mi && a.staff === r.staff && a.voice === r.voice && a.idx === (toShown ? idx : r.idx);
    if (chord && toShown && out.pi >= pv.pi) out.pi++;
    else if (chord && !toShown && out.pi > pv.pi) out.pi--;
  }
  return out;
}

/** The ref in the score of a ref from the shown score (from the hit index); undefined for the note of the preview. */
export const realRef = (r: Ref): Ref | undefined => moveRef(r, false);

/** The ref in the shown score of a ref in the score (from the selection), for drawing it; undefined when it is overwritten there. */
export const shownRef = (r: Ref): Ref | undefined => moveRef(r, true);

/** Kept from one edit to the next, so that only what an edit touched is engraved again. */
const engraveCache = createEngraveCache();

/** The page setup with the staff space of the zoom setting: the same object as long as neither changes (the cache compares it). */
let spacedPage: { from: Score['page']; sp: number; page: Score['page'] } | undefined;

/** The page setup with staff space `sp`; the same object as long as `page` and `sp` stay the same. */
function pageWithSpace(page: Score['page'], sp: number): Score['page'] {
  if (!(spacedPage && spacedPage.from === page && spacedPage.sp === sp))
    spacedPage = { from: page, sp, page: { ...page, staffSpace: sp } };
  return spacedPage.page;
}

effect(() => {
  const s0 = shown.value;
  const sp = space.value;
  const nums = s0.page.measureNumbers ?? 'system';
  if (!ready.value) return;
  const s = sp ? { ...s0, page: pageWithSpace(s0.page, sp) } : s0;
  const t0 = performance.now();
  try {
    const opts: EngraveOptions = {
      respectBreaks: true,
      measureNumbers: nums,
      warn: (m: string) => console.warn(m),
      cache: engraveCache,
      ghostRests: true,
    };
    let res = engrave(s, opts);
    if (res.systems === 1) res = engrave(s, { ...opts, fillLast: true }); // A score of one short line is spread out, because there is room to work in.
    const h = buildHitIndex(s0, res);
    batch(() => {
      engraved.value = res;
      hit.value = h;
      engraveError.value = '';
    });
  } catch (e) {
    console.error(e);
    engraveError.value = `Engraver: ${(e as Error).message}`;
  }
  timing.value = performance.now() - t0;
});

// Selection and tools: what is selected in the score and which tool the pointer currently uses,
// together with the note settings (duration, dots, accidental, voice) that go with note input.

export const selection = signal<Ref[]>([]);

export type Tool =
  | 'select'
  | 'note'
  | 'slur'
  | 'line'
  | 'cresc'
  | 'dim'
  | 'pedal'
  | 'trill'
  | '8va'
  | '8vb'
  | 'dynamic'
  | 'text'
  | 'tempo'
  | 'clef'
  | 'tuplet'
  | 'grace';

export const tool = signal<Tool>('select');

/** Whether notes are being entered (the caret is shown), in which case the palette sets the next note and never the selection. */
export const entering = (): boolean => tool.value === 'note';

/**
 * The caret of note input: the position in the staff and measure where the next note goes. The voice is the palette's
 * `voice`, so that changing voice keeps the position in time.
 */
export interface Caret {
  mi: number;
  staff: string;
  tick: number;
}

export const caret = signal<Caret | null>(null);

/**
 * The pitch of the next note in note input, chosen before it is entered; null: the pitch of the note before the caret.
 * Entering a note keeps its pitch here, so that W enters it again; a click that puts the caret clears it.
 */
export const nextPitch = signal<Pitch | null>(null);

/**
 * Switches the tool. Entering note input puts the caret on the first selected event (or leaves it where it was)
 * and clears the selection, so that nothing selected is changed by accident.
 */
export function setTool(t: Tool): void {
  if (t === 'note') {
    nextPitch.value = null;
    const r = selection.peek().find((x) => x.t === 'ev');
    const v = r && voiceOf(score.peek(), r);
    const te = v && r && flattenVoice(v)[r.idx];
    if (r && te) caret.value = { mi: r.mi, staff: r.staff, tick: te.start };
    else if (!caret.peek()) caret.value = { mi: 0, staff: score.peek().staves[0].id, tick: 0 };
    selection.value = [];
  }
  tool.value = t;
}

export const dur = signal<BaseDur>(8);
export const dots = signal(0);

/** Accidental for new notes: undefined = whatever the key and the measure imply. */
export const acc = signal<number | undefined>(undefined);

export const voice = signal(1);
export const dynText = signal('mf');
export const clefArg = signal<Clef>({ sign: 'G', line: 2 });
export const tupletArg = signal<[number, number]>([3, 2]);
export const tempoArg = signal({ unit: 4 as BaseDur, dots: 0, bpm: 120 });
export const textArg = signal('dolce');

// Persistence: the score is autosaved to localStorage shortly after each change, so that a reload
// brings it back. This is a convenience of one browser only; the file the user saves is the real copy,
// and storage may be unavailable, so every access is guarded.

const KEY = 'thomas.autosave';

/** The autosaved text of the last session, if storage allows reading it. */
export function restore(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

const FILE_KEY = 'thomas.file';

/** Reads the stored file identity of the last session (null when there is none or storage is unavailable). */
function readStoredFile(): { path: string; name: string } | null {
  try {
    const v = JSON.parse(localStorage.getItem(FILE_KEY) ?? 'null');
    return v && typeof v.path === 'string' && typeof v.name === 'string' ? v : null;
  } catch {
    return null;
  }
}

// Read before the effect below runs, which would otherwise overwrite it with the empty initial state.
const storedFile = readStoredFile();

/** The path and name of the file the autosaved score belongs to, if it was saved or opened from one. */
export function restoreFile(): { path: string; name: string } | null {
  return storedFile;
}

effect(() => {
  const path = filePath.value;
  const name = fileName.value;
  try {
    if (path) localStorage.setItem(FILE_KEY, JSON.stringify({ path, name }));
    else localStorage.removeItem(FILE_KEY);
  } catch {
    /* storage may be unavailable */
  }
});

// The window title shows the file's path (the name in a browser) and an unsaved mark; a score without a file
// shows just the application name.
effect(() => {
  const file = filePath.value;
  document.title = `${dirty.value ? '• ' : ''}${file ? `${file} – ` : ''}Thomas`;
});

let saveTimer: ReturnType<typeof setTimeout> | undefined;

effect(() => {
  const s = score.value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, writeText(s));
    } catch {
      /* storage may be unavailable */
    }
  }, 800);
});

/** The score as text, with the places of its parts (for showing the selection there). */
export const textMap = computed(() => writeTextMap(score.value));

export const textOf = computed(() => textMap.value.text);
export { parseText, validate };
