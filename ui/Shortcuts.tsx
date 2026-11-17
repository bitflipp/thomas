// The keyboard shortcut dialog (opened with ?). Its table is documentation only: the real bindings
// are in keys.ts.

import { signal } from '@preact/signals';

export const showHelp = signal(false);

const ROWS: [string, string][] = [
  ['N / R / V (Esc)', 'Note input / rest input / select'],
  ['1 – 8', 'Duration whole … 128th (also applies to the selection)'],
  ['.', 'Cycle dots'],
  ['Q / W', 'Previous / next voice for new notes'],
  ['↑ ↓', 'Selected notes: semitone up / down'],
  ['Ctrl ↑ ↓', 'Octave up / down'],
  ['Shift ↑ ↓', 'Letter name up / down (keeps the accidental)'],
  ['← →', 'Select previous / next note (Shift extends)'],
  ['T', 'Tie to the next note'],
  ['S', 'Slur from the first to the last selected note'],
  ['↑ ↓ (grace note selected)', 'Step the grace note up / down'],
  [
    'MIDI in (toolbar)',
    'Enter notes from a MIDI keyboard at the selected note, with the chosen duration; keys pressed together make a chord',
  ],
  ['F', 'Toggle a fermata on the selection'],
  ['Shift T', 'Toggle a trill on the selected notes'],
  ['X', 'Cycle the stem: up, down, automatic'],
  ['Delete', 'Notes become rests; marks, slurs, tuplets are removed'],
  ['Space', 'Play / stop (resumes where it stopped)'],
  ['Home', 'Playhead back to the start'],
  ['F8 / Shift F8', 'Next / previous finding of the chosen layer (chooses the first layer if none is)'],
  ['Alt + click (select)', 'Put the playhead there'],
  ['Ctrl Z / Ctrl Shift Z', 'Undo / redo'],
  [
    'Ctrl C / X / V',
    'Copy / cut / paste notes with their dynamics, ornaments, graces and complete hairpins or pedals (paste starts at the selected note); a copied dynamic, text or tempo mark is pasted onto every selected note',
  ],
  [
    'Ctrl Shift A',
    'Select everything the Properties panel would edit together with the selection (marks of one type, all notes (or all rests), all slurs, ties or tuplets)',
  ],
  ['Ctrl + / −  (wheel)', 'Zoom'],
  ['Ctrl G', 'Go to a measure: asks for its number, Enter selects it and shows it'],
  ['Ctrl E', 'Show the score as text, editable'],
  ['Ctrl I', 'Properties panel'],
  ['Ctrl S', 'Save'],
  ['Alt + click (note input)', 'Replace a tuplet as a whole instead of entering into it'],
  ['Shift / Ctrl + click', 'Add to the selection'],
  [
    'Shift + click (measure)',
    'Select the run of measures from the last clicked one; Ctrl adds one; Ctrl C / V copies and pastes them over the first selected measure',
  ],
  ['Double-click', 'Edit the text or tempo of a mark'],
];

/** The keyboard shortcut dialog (`?`). It documents the bindings of keys.ts but does not define them. */
export function Shortcuts() {
  if (!showHelp.value) return null;
  return (
    <div class="modal" onPointerDown={() => (showHelp.value = false)}>
      <div class="card" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <h3>Keyboard shortcuts</h3>
        <table>
          {ROWS.map(([k, v]) => (
            <tr>
              <td>
                <kbd>{k}</kbd>
              </td>
              <td>{v}</td>
            </tr>
          ))}
        </table>
        <p class="hint">
          Everything here is also available with the mouse: pick a tool on the left, click or drag on the score; the
          right panel edits whatever is selected.
        </p>
        <button type="button" onClick={() => (showHelp.value = false)}>
          Close
        </button>
      </div>
    </div>
  );
}
