import { signal } from '@preact/signals';

export const showHelp = signal(false);

const ROWS: [string, string][] = [
  ['N / R / V (Esc)', 'Note input / rest input / select'],
  ['1 – 7', 'Duration whole … 64th (also applies to the selection)'],
  ['.', 'Cycle dots'],
  ['Q / W', 'Previous / next voice for new notes'],
  ['↑ ↓', 'Selected notes: semitone up / down'],
  ['Ctrl ↑ ↓', 'Octave up / down'],
  ['Shift ↑ ↓', 'Letter name up / down (keeps the accidental)'],
  ['← →', 'Select previous / next note (Shift extends)'],
  ['T', 'Tie to the next note'],
  ['S', 'Slur from the first to the last selected note'],
  ['X', 'Cycle the stem: up, down, automatic'],
  ['Delete', 'Notes become rests; marks, slurs, tuplets are removed'],
  ['Ctrl Z / Ctrl Shift Z', 'Undo / redo'],
  ['Ctrl C / X / V', 'Copy / cut / paste notes (paste starts at the selected note)'],
  ['Ctrl + / −  (wheel)', 'Zoom'],
  ['Ctrl E', 'Show the score as text, editable'],
  ['Ctrl I', 'Properties panel'],
  ['Ctrl S', 'Save'],
  ['Alt + click (note input)', 'Replace a tuplet as a whole instead of entering into it'],
  ['Shift / Ctrl + click', 'Add to the selection'],
  ['Right-click', 'Context menu: measures, breaks, stems'],
  ['Double-click', 'Edit the text or tempo of a mark'],
];

export function Shortcuts() {
  if (!showHelp.value) return null;
  return (
    <div class="modal" onPointerDown={() => (showHelp.value = false)}>
      <div class="card" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <h3>Keyboard shortcuts</h3>
        <table>{ROWS.map(([k, v]) => <tr><td><kbd>{k}</kbd></td><td>{v}</td></tr>)}</table>
        <p class="hint">Everything here is also available with the mouse: pick a tool on the left, click or drag on the score; the right panel edits whatever is selected.</p>
        <button onClick={() => (showHelp.value = false)}>Close</button>
      </div>
    </div>
  );
}
