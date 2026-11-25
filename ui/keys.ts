// Keyboard shortcuts (the list shown to the user is in Shortcuts.tsx; keep the two in step).
// `installKeys` adds one global listener that ignores keys while the user types in an input or in the
// text pane's editor. The clipboard for copy/paste is kept here as plain events, not in the system clipboard.

import type { Ref } from '../src/editor/addr.ts';
import { voiceOf } from '../src/editor/addr.ts';
import * as C from '../src/editor/commands.ts';
import type { MarkBody } from '../src/model.ts';
import { flattenVoice } from '../src/model.ts';

import {
  chooseDots,
  chooseDuration,
  flipStemOrTie,
  moveSelectionToVoice,
  nudge,
  selectVoice,
  shownDuration,
  slurSelection,
  stepHead,
  stepSelection,
  tieSelection,
  toggleOrnament,
} from './actions.ts';

import {
  addChordTone,
  alterLast,
  backspaceAtCaret,
  caretToMeasureStart,
  enterRestAtCaret,
  moveCaret,
  repeatNote,
  slurFrom,
  stepNotes,
  toggleSlur,
} from './caret.ts';

import { stepFindings } from './Findings.tsx';
import { cancelDrag, deleteSelection, evRefs, graceRefs, measureRefs, selectSimilar, zoomBy } from './interact.ts';
import { focusGoto } from './Overview.tsx';
import { rewind, toggle } from './player.ts';
import { showHelp } from './Shortcuts.tsx';
import type { Tool } from './state.ts';

import {
  entering,
  redo,
  run,
  say,
  score,
  selection,
  setTool,
  showExpression,
  showProperties,
  showText,
  tool,
  undo,
  voice,
} from './state.ts';

/** What Ctrl+C took: events with their complete marks, or point marks to hang on the selected events. */
let clip: { events: C.Clip } | { marks: MarkBody[] } | { measures: C.MeasureClip } | undefined;

/** Whether the key event comes from a text input, where shortcuts must not fire. */
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

/** Copies the selected events, or else the selected dynamics, text and tempo marks; false if neither is selected. */
function copySel(): boolean {
  const sc = score.peek();
  const refs = [...evRefs()].sort((a, b) => a.mi - b.mi || a.idx - b.idx);
  try {
    if (refs.length) {
      const events = C.copyEvents(sc, refs);
      clip = { events };
      say(`Copied ${refs.length} event${refs.length > 1 ? 's' : ''}`);
      return true;
    }
    const ms = measureRefs();
    if (ms.length && selection.peek().every((r) => r.t === 'measure')) {
      clip = { measures: C.copyMeasures(sc, ms[0], ms[ms.length - 1]) };
      say(`Copied ${ms.length} measure${ms.length > 1 ? 's' : ''}`);
      return true;
    }
    const marks = selection.peek().filter((r): r is Extract<Ref, { t: 'mark' }> => r.t === 'mark');
    if (!marks.length) return false;
    clip = { marks: C.copyMarks(sc, marks) };
    say(`Copied ${clip.marks.length} mark${clip.marks.length > 1 ? 's' : ''}`);
    return true;
  } catch (e) {
    if (e instanceof C.EditError) say(e.message, true);
    else throw e;
    return false;
  }
}

/** Pastes the copied events from the first selected event on, or hangs the copied marks on every selected event. */
function paste(): void {
  if (clip && 'measures' in clip) {
    const at = measureRefs()[0];
    if (at === undefined) say('Select the measure to paste over', true);
    else {
      const ms = clip.measures;
      run((s) => C.pasteMeasures(s, at, ms));
    }
    return;
  }
  const refs = evRefs();
  if (!(clip && refs.length)) {
    say(clip ? 'Select where to paste' : 'Nothing to paste', true);
    return;
  }
  if ('marks' in clip) {
    const marks = clip.marks;
    run((s) => C.pasteMarks(s, refs, marks));
    return;
  }
  const events = clip.events;
  const r = refs[0];
  const sc = score.peek();
  const v = voiceOf(sc, r);
  const te = v && flattenVoice(v)[r.idx];
  if (!te) return;
  run((s) => C.pasteEvents(s, r, te.start, events));
}

const DURATION_KEYS = [1, 2, 4, 8, 16, 32, 64, 128] as const;
const TOOL_KEYS: Record<string, Tool> = { n: 'note', v: 'select', l: 'slur' };
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
  // Ctrl Space is told by its physical key, since an input method may report another `key` for it.
  if (e.code === 'Space') {
    toggleSignal(showExpression);
    e.preventDefault();
    return true;
  }
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
    case 'm':
      toggleSignal(showExpression);
      break;
    case 'g':
      focusGoto();
      break;
    default:
      return false;
  }
  e.preventDefault();
  return true;
}

/** Escape closes the help, cancels a drag, returns to the select tool and then clears the selection. */
function onEscape(): void {
  showHelp.value = false;
  cancelDrag();
  slurFrom.value = null;
  if (tool.value !== 'select') setTool('select');
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
      if (!(evRefs().length || graceRefs().length)) return true;
      e.preventDefault();
      const d = e.key === 'ArrowUp' ? 1 : -1;
      if (e.shiftKey) nudge(undefined, d);
      else nudge(d);
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
    case 'F8':
      e.preventDefault();
      stepFindings(e.shiftKey ? -1 : 1);
      return true;
    case '?':
      showHelp.value = !showHelp.value;
      return true;
    case '.':
      chooseDots((shownDuration().dots + 1) % 3);
      return true;
    default:
      return false;
  }
}

/** Single letter and digit keys: durations, tools, ties, slurs, stem flip and the voice. */
function onToolKey(e: KeyboardEvent): void {
  const vd = /^Digit([1-4])$/.exec(e.code);
  if (e.shiftKey && !e.altKey && vd) {
    // Shift+1..4 chooses the voice to enter into; the caret keeps its place in time.
    voice.value = Number(vd[1]);
    return;
  }
  if (e.altKey && vd) {
    // Alt+1..4 moves the selected notes to that voice, Alt+Shift+1..4 selects the voice.
    if (e.shiftKey) selectVoice(Number(vd[1]));
    else moveSelectionToVoice(Number(vd[1]));
    return;
  }
  const digit = '12345678'.indexOf(e.key);
  if (digit >= 0 && !e.shiftKey) {
    chooseDuration(DURATION_KEYS[digit]);
    return;
  }
  const letter = e.key.toLowerCase();
  if (TOOL_KEYS[letter]) setTool(TOOL_KEYS[letter]);
  else if (letter === 't' && !e.shiftKey) tieSelection();
  else if (letter === 's') slurSelection();
  else if (letter === 'f') toggleOrnament('fermata');
  else if (letter === 't' && e.shiftKey) toggleOrnament('trill');
  else if (letter === 'x') flipStemOrTie();
  else if (letter === 'q') chooseDots((shownDuration().dots + 1) % 3);
  else if (letter === 'w' && e.shiftKey) addChordTone();
}

/** Keys of note input with the caret: letters enter notes, R a rest, arrows move the caret. Returns true if the key was one of them. */
function onCaretKey(e: KeyboardEvent): boolean {
  if (e.altKey) return false;
  const k = e.key.toLowerCase();
  if (k === 'w') {
    if (e.shiftKey) addChordTone();
    else repeatNote();
  } else if (k === 'r') enterRestAtCaret();
  else if (k === 's') toggleSlur();
  else if (e.key === 'ArrowLeft') moveCaret(-1);
  else if (e.key === 'ArrowRight') moveCaret(1);
  else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.ctrlKey)
    stepNotes(e.key === 'ArrowUp' ? 1 : -1);
  else if (e.key === 'Backspace') backspaceAtCaret();
  else if (e.key === 'Home') caretToMeasureStart();
  else if (e.key === '+' || e.key === '=') alterLast(1);
  else if (e.key === '-') alterLast(-1);
  else return false;
  e.preventDefault();
  return true;
}

/** The global key handler: editing and view shortcuts with Ctrl or Cmd, then the single-key bindings. */
function onKey(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !typing(e) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    // Ctrl+Up/Down moves the selected notes an octave, keeping their spelling.
    e.preventDefault();
    const d = e.key === 'ArrowUp' ? 7 : -7;
    nudge(undefined, d);
    return;
  }
  if (mod && !typing(e) && onEditShortcut(e)) return;
  if (mod && onViewShortcut(e)) return;
  if (!(typing(e) || mod) && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    // Alt+Up/Down selects the next head up or down the chord.
    e.preventDefault();
    stepHead(e.key === 'ArrowUp' ? 1 : -1);
    return;
  }
  if (typing(e) || mod || (e.altKey && e.key.length > 1)) return;
  if (entering() && onCaretKey(e)) return;
  if (!onNavigationKey(e)) onToolKey(e);
}

/** Installs the key handler and returns the function that removes it. */
export function installKeys(): () => void {
  addEventListener('keydown', onKey);
  return () => removeEventListener('keydown', onKey);
}
