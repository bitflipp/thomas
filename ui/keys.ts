// Keyboard shortcuts (the list shown to the user is in Shortcuts.tsx; keep the two in step).
// `installKeys` adds one global listener that ignores keys while the user types in an input or in the
// text pane's editor. The clipboard for copy/paste is kept here as plain events, not in the system clipboard.
import { PPQ, flattenVoice, type Event } from '../src/model.ts';
import * as C from '../src/editor/commands.ts';
import { eventOf, voiceOf } from '../src/editor/addr.ts';
import { score, selection, tool, dur, dots, zoom, fit, showText, showInspector, undo, redo, run, say, voice, type Tool } from './state.ts';
import { chooseDuration, chooseDots, nudge, flipStem, slurSelection, tieSelection, stepSelection } from './actions.ts';
import { deleteSelection, evRefs, cancelDrag, menu, zoomBy } from './interact.ts';
import { toggle, rewind } from './player.ts';
import { showHelp } from './Shortcuts.tsx';

let clip: Event[] = [];

function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || !!t.closest?.('.cm-editor'));
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
  if (!clip.length || !refs.length) { say(clip.length ? 'Select where to paste' : 'Nothing to paste', true); return; }
  const r = refs[0], sc = score.peek();
  const v = voiceOf(sc, r), te = v && flattenVoice(v)[r.idx];
  if (!te) return;
  run((s) => C.pasteEvents(s, r, te.start, clip));
}

export function installKeys(): () => void {
  const onKey = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !typing(e)) {
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (k === 'y') { e.preventDefault(); redo(); return; }
      if (k === 'c') { if (copySel()) e.preventDefault(); return; }
      if (k === 'x') { if (copySel()) { e.preventDefault(); deleteSelection(); } return; }
      if (k === 'v') { e.preventDefault(); paste(); return; }
      if (k === 'a') { e.preventDefault(); return; }
    }
    if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); showText.value = !showText.value; return; }
    if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoomBy(1.2); return; }
    if (mod && e.key === '-') { e.preventDefault(); zoomBy(1 / 1.2); return; }
    if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); showInspector.value = !showInspector.value; return; }
    if (typing(e) || mod || e.altKey && e.key.length > 1) return;
    const key = e.key;
    const hasSel = selection.value.length > 0;
    switch (key) {
      case 'Escape': showHelp.value = false; menu.value = null; cancelDrag(); if (tool.value !== 'select') tool.value = 'select'; else selection.value = []; return;
      case 'Delete': case 'Backspace': if (hasSel) { e.preventDefault(); deleteSelection(); } return;
      case 'ArrowUp': case 'ArrowDown': {
        if (!evRefs().length) return;
        e.preventDefault();
        const d = key === 'ArrowUp' ? 1 : -1;
        if (e.shiftKey) nudge(undefined, d); else nudge(e.ctrlKey ? 12 * d : d);
        return;
      }
      case 'ArrowLeft': case 'ArrowRight': if (evRefs().length) { e.preventDefault(); stepSelection(key === 'ArrowLeft' ? -1 : 1, e.shiftKey); } return;
      case ' ': if ((e.target as HTMLElement | null)?.closest?.('button, select, a')) return; e.preventDefault(); toggle(); return;
      case 'Home': e.preventDefault(); rewind(); return;
      case '?': showHelp.value = !showHelp.value; return;
      case '.': chooseDots((dots.value + 1) % 3); return;
      default: break;
    }
    const digit = '1234567'.indexOf(key);
    if (digit >= 0 && !e.shiftKey) { chooseDuration([1, 2, 4, 8, 16, 32, 64][digit] as never); return; }
    const toolKeys: Record<string, Tool> = { n: 'note', r: 'rest', v: 'select', l: 'slur' };
    const lk = key.toLowerCase();
    if (toolKeys[lk]) { tool.value = toolKeys[lk]; return; }
    if (lk === 't') tieSelection();
    else if (lk === 's') slurSelection();
    else if (lk === 'x') flipStem();
    else if (lk === 'q' || lk === 'w') voice.value = lk === 'q' ? Math.max(1, voice.value - 1) : Math.min(4, voice.value + 1);
    void dur; void PPQ;
  };
  addEventListener('keydown', onKey);
  return () => removeEventListener('keydown', onKey);
}
