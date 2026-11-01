// Application state: the score (immutable, with undo history), selection, tool settings, and what is derived from them.
//
// Everything is a preact signal. The score signal holds an immutable `Score`; an edit replaces it
// (`commit`), so undo is just a stack of earlier values (structural sharing keeps that cheap). The
// engraving, hit index and text are derived by effects from the score, so no component recomputes them.
import { signal, computed, effect, batch } from '@preact/signals';
import { parseText, writeText, writeTextMap } from '../src/textformat.ts';
import { validate, type BaseDur, type Clef, type Score } from '../src/model.ts';
import { engrave, type Engraved } from '../src/engrave/system.ts';
import { buildHitIndex, type HitIndex } from '../src/editor/hit.ts';
import { EditError } from '../src/editor/commands.ts';
import type { Ref } from '../src/editor/addr.ts';

// ---------------------------------------------------------------- document

const EMPTY = `page 210x297 margin=10 space=1.75
staff rh clef=G2 name="Piano"
staff lh clef=F4 name="Piano"
brace rh lh
title "Untitled"

m1 time=4/4 key=0
  rh.1: R:1
  lh.1: R:1
m2
  rh.1: R:1
  lh.1: R:1
m3
  rh.1: R:1
  lh.1: R:1
m4 barline=final
  rh.1: R:1
  lh.1: R:1
`;
export const NEW_SCORE_TEXT = EMPTY;

export const score = signal<Score>(parseText(EMPTY));
export const fileName = signal('score.txt');
export const dirty = signal(false);
/** Counts documents opened or created (not edits). */
export const docId = signal(0);
const past: Score[] = [], future: Score[] = [];
export const histLen = signal({ undo: 0, redo: 0 });
const syncHist = () => { histLen.value = { undo: past.length, redo: future.length }; };

export const toast = signal<{ msg: string; err: boolean; id: number } | null>(null);
let toastId = 0, toastTimer: ReturnType<typeof setTimeout> | undefined;
export function say(msg: string, err = false): void {
  const id = ++toastId;
  toast.value = { msg, err, id };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (toast.value?.id === id) toast.value = null; }, err ? 4500 : 2200);
}

export function commit(next: Score): void {
  const cur = score.peek();
  if (next === cur) return;
  past.push(cur);
  if (past.length > 300) past.shift();
  future.length = 0;
  batch(() => { score.value = next; dirty.value = true; });
  syncHist();
}
/** Run an edit command on the current score; a refusal is shown to the user instead of thrown. Returns whether it applied. */
export function run(fn: (s: Score) => Score): boolean {
  try { commit(fn(score.peek())); return true; }
  catch (e) {
    if (e instanceof EditError) { say(e.message, true); return false; }
    console.error(e); say(`Unexpected error: ${(e as Error).message}`, true); return false;
  }
}
export function undo(): void {
  const p = past.pop();
  if (!p) return;
  future.push(score.peek());
  batch(() => { score.value = p; dirty.value = true; });
  syncHist();
}
export function redo(): void {
  const f = future.pop();
  if (!f) return;
  past.push(score.peek());
  batch(() => { score.value = f; dirty.value = true; });
  syncHist();
}
/** Replace the whole document (open/new): history restarts. */
export function load(s: Score, name?: string): void {
  past.length = 0; future.length = 0; syncHist();
  batch(() => { score.value = s; selection.value = []; dirty.value = false; docId.value++; if (name) fileName.value = name; });
}
export function loadText(t: string, name?: string): boolean {
  try {
    const s = parseText(t);
    const errs = validate(s);
    if (errs.length) { say(errs[0], true); return false; }
    load(s, name);
    return true;
  } catch (e) { say((e as Error).message, true); return false; }
}

// ---------------------------------------------------------------- view

export const zoom = signal(1);
export const fit = signal(true); // fit pages to the pane width
export const showText = signal(false);
export const showInspector = signal(true);
export const space = signal<number | null>(null);
export const showCollisions = signal(false);
export const voiceColors = signal(true);
/** Ink colour of each voice when voice colours are on (voice 1 stays black). */
export const VOICE_COLORS: Record<number, string> = { 2: '#1a8f4a', 3: '#d9780a', 4: '#8e44ad' };
export const timing = signal(0);

/** Set once the music font is loaded; nothing is engraved before. */
export const ready = signal(false);
export const engraved = signal<Engraved | null>(null);
export const hit = signal<HitIndex | null>(null);
export const engraveError = signal('');

effect(() => {
  const s0 = score.value, sp = space.value, nums = score.value.page.measureNumbers ?? 'system';
  if (!ready.value) return;
  const s = sp ? { ...s0, page: { ...s0.page, staffSpace: sp } } : s0;
  const t0 = performance.now();
  try {
    const opts = { respectBreaks: true, measureNumbers: nums, warn: (m: string) => console.warn(m) };
    let res = engrave(s, opts);
    if (res.systems === 1) res = engrave(s, { ...opts, fillLast: true }); // a score of one short line: spread it out, there is room to work in
    const h = buildHitIndex(s0, res);
    batch(() => { engraved.value = res; hit.value = h; engraveError.value = ''; });
  } catch (e) {
    console.error(e);
    engraveError.value = `Engraver: ${(e as Error).message}`;
  }
  timing.value = performance.now() - t0;
});

// ---------------------------------------------------------------- selection and tools

export const selection = signal<Ref[]>([]);

export type Tool = 'select' | 'note' | 'rest' | 'slur' | 'cresc' | 'dim' | 'pedal' | '8va' | '8vb' | 'dynamic' | 'text' | 'tempo' | 'clef' | 'tuplet';
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

// ---------------------------------------------------------------- persistence (per-browser convenience only)

const KEY = 'thomas.autosave';
export function restore(): string | null { try { return localStorage.getItem(KEY); } catch { return null; } }
let saveTimer: ReturnType<typeof setTimeout> | undefined;
effect(() => {
  const s = score.value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(KEY, writeText(s)); } catch { /* storage may be unavailable */ } }, 800);
});

/** The score as text, with the places of its parts (for showing the selection there). */
export const textMap = computed(() => writeTextMap(score.value));
export const textOf = computed(() => textMap.value.text);
export { parseText, validate };
