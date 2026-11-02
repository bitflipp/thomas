// Keyboard shortcuts (the list shown to the user is in Shortcuts.tsx; keep the two in step).
// `installKeys` adds one global listener that ignores keys while the user types in an input or in the
// text pane's editor. The clipboard for copy/paste is kept here as plain events, not in the system clipboard.

import { eventOf, voiceOf } from '../src/editor/addr.ts';
import * as C from '../src/editor/commands.ts';
import type { Event } from '../src/model.ts';
import { flattenVoice } from '../src/model.ts';
import { chooseDots, chooseDuration, flipStem, nudge, slurSelection, stepSelection, tieSelection } from './actions.ts';
import { cancelDrag, deleteSelection, evRefs, selectSimilar, zoomBy } from './interact.ts';
import { rewind, toggle } from './player.ts';
import { showHelp } from './Shortcuts.tsx';
import type { Tool } from './state.ts';
import { dots, redo, run, say, score, selection, showProperties, showText, tool, undo, voice } from './state.ts';

let clip: Event[] = [];

function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return (
    !!t &&
    (t.tagName === 'INPUT' ||
      t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' ||
      t.isContentEditable ||
      !!t.closest?.('.cm-editor'))
  );
}

function copySel(): boolean {
  const sc = score.peek();
  const refs = [...evRefs()].sort((a, b) => a.mi - b.mi || a.idx - b.idx);
  const evs = refs.map((r) => eventOf(sc, r)).filter((e): e is Event => !!e);
  if (!evs.length) return false;
  clip = JSON.parse(JSON.stringify(evs));
  say(`Copied ${evs.length} event${evs.length > 1 ? 's' : ''}`);
  return true;
}

function paste(): void {
  const refs = evRefs();
  if (!(clip.length && refs.length)) {
    say(clip.length ? 'Select where to paste' : 'Nothing to paste', true);
    return;
  }
  const r = refs[0];
  const sc = score.peek();
  const v = voiceOf(sc, r);
  const te = v && flattenVoice(v)[r.idx];
  if (!te) return;
  run((s) => C.pasteEvents(s, r, te.start, clip));
}

const DURATION_KEYS = [1, 2, 4, 8, 16, 32, 64, 128] as const;
const TOOL_KEYS: Record<string, Tool> = { n: 'note', r: 'rest', v: 'select', l: 'slur' };
const MAX_VOICE = 4;
const ZOOM_STEP = 1.2;

/** Edit shortcuts that must not fire while the user types (undo, redo, clipboard). Returns true if the key was one of them. */
function onEditShortcut(e: KeyboardEvent): boolean {
  switch (e.key.toLowerCase()) {
    case 'z':
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return true;
    case 'y':
      e.preventDefault();
      redo();
      return true;
    case 'c':
      if (copySel()) e.preventDefault();
      return true;
    case 'x':
      if (copySel()) {
        e.preventDefault();
        deleteSelection();
      }
      return true;
    case 'v':
      e.preventDefault();
      paste();
      return true;
    case 'a':
      e.preventDefault();
      if (e.shiftKey) selectSimilar();
      return true;
    default:
      return false;
  }
}

/** View shortcuts (Ctrl/Cmd + key) that work everywhere. Returns true if the key was one of them. */
function onViewShortcut(e: KeyboardEvent): boolean {
  const toggleSignal = (flag: { value: boolean }) => {
    flag.value = !flag.value;
  };
  switch (e.key.toLowerCase()) {
    case 'e':
      toggleSignal(showText);
      break;
    case '+':
    case '=':
      zoomBy(ZOOM_STEP);
      break;
    case '-':
      zoomBy(1 / ZOOM_STEP);
      break;
    case 'i':
      toggleSignal(showProperties);
      break;
    default:
      return false;
  }
  e.preventDefault();
  return true;
}

function onEscape(): void {
  showHelp.value = false;
  cancelDrag();
  if (tool.value !== 'select') tool.value = 'select';
  else selection.value = [];
}

/** Keys with a fixed meaning, regardless of modifiers other than Alt. Returns true if the key was one of them. */
function onNavigationKey(e: KeyboardEvent): boolean {
  switch (e.key) {
    case 'Escape':
      onEscape();
      return true;
    case 'Delete':
    case 'Backspace':
      if (selection.value.length > 0) {
        e.preventDefault();
        deleteSelection();
      }
      return true;
    case 'ArrowUp':
    case 'ArrowDown': {
      if (!evRefs().length) return true;
      e.preventDefault();
      const d = e.key === 'ArrowUp' ? 1 : -1;
      if (e.shiftKey) nudge(undefined, d);
      else nudge(e.ctrlKey ? 12 * d : d);
      return true;
    }
    case 'ArrowLeft':
    case 'ArrowRight':
      if (evRefs().length) {
        e.preventDefault();
        stepSelection(e.key === 'ArrowLeft' ? -1 : 1, e.shiftKey);
      }
      return true;
    case ' ':
      if ((e.target as HTMLElement | null)?.closest?.('button, select, a')) return true;
      e.preventDefault();
      toggle();
      return true;
    case 'Home':
      e.preventDefault();
      rewind();
      return true;
    case '?':
      showHelp.value = !showHelp.value;
      return true;
    case '.':
      chooseDots((dots.value + 1) % 3);
      return true;
    default:
      return false;
  }
}

/** Single letter and digit keys: durations, tools, ties, slurs, stem flip and the voice. */
function onToolKey(e: KeyboardEvent): void {
  const digit = '12345678'.indexOf(e.key);
  if (digit >= 0 && !e.shiftKey) {
    chooseDuration(DURATION_KEYS[digit]);
    return;
  }
  const letter = e.key.toLowerCase();
  if (TOOL_KEYS[letter]) tool.value = TOOL_KEYS[letter];
  else if (letter === 't') tieSelection();
  else if (letter === 's') slurSelection();
  else if (letter === 'x') flipStem();
  else if (letter === 'q') voice.value = Math.max(1, voice.value - 1);
  else if (letter === 'w') voice.value = Math.min(MAX_VOICE, voice.value + 1);
}

function onKey(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !typing(e) && onEditShortcut(e)) return;
  if (mod && onViewShortcut(e)) return;
  if (typing(e) || mod || (e.altKey && e.key.length > 1)) return;
  if (!onNavigationKey(e)) onToolKey(e);
}

export function installKeys(): () => void {
  addEventListener('keydown', onKey);
  return () => removeEventListener('keydown', onKey);
}
