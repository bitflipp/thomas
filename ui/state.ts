// Application state: the score (immutable, with undo history), selection, tool settings, and what is derived from them.
//
// Everything is a preact signal. The score signal holds an immutable `Score`; an edit replaces it
// (`commit`), so undo is just a stack of earlier values (structural sharing keeps that cheap). The
// engraving, hit index and text are derived by effects from the score, so no component recomputes them.

import { batch, computed, effect, signal } from '@preact/signals';

import type { Ref } from '../src/editor/addr.ts';
import { EditError } from '../src/editor/commands.ts';
import type { HitIndex } from '../src/editor/hit.ts';
import { buildHitIndex } from '../src/editor/hit.ts';
import type { Engraved, EngraveOptions } from '../src/engrave/system.ts';
import { createEngraveCache, engrave } from '../src/engrave/system.ts';
import type { BaseDur, Clef, Score } from '../src/model.ts';
import { validate } from '../src/model.ts';
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

// View settings: zoom, which panes are shown, colours and other display options. None of them
// is part of the score.

export const zoom = signal(1);
export const shownZoom = signal(1); // This is the zoom the pages are displayed at (it differs from `zoom` while fitting).
export const fit = signal(true); // When set, the pages are fitted to the pane width.
export const showText = signal(false);
export const showProperties = signal(true);
export const space = signal<number | null>(null);
export const showCollisions = signal(false);

/** True while the PDF print dialog is being prepared: every page then generates its SVG, whether near the viewport or not. */
export const printing = signal(false);

export const voiceColors = signal(true);

/** Ink colour of each voice when voice colours are on (voice 1 stays black). */
export const VOICE_COLORS: Record<number, string> = { 2: '#1a8f4a', 3: '#d9780a', 4: '#8e44ad' };

export const timing = signal(0);

/** Set once the music font is loaded; nothing is engraved before. */
export const ready = signal(false);

export const engraved = signal<Engraved | null>(null);
export const hit = signal<HitIndex | null>(null);
export const engraveError = signal('');

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
  const s0 = score.value;
  const sp = space.value;
  const nums = score.value.page.measureNumbers ?? 'system';
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
  | 'rest'
  | 'slur'
  | 'line'
  | 'cresc'
  | 'dim'
  | 'pedal'
  | '8va'
  | '8vb'
  | 'dynamic'
  | 'text'
  | 'tempo'
  | 'clef'
  | 'tuplet';

export const tool = signal<Tool>('select');
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
