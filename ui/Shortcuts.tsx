// The keyboard shortcut dialog (opened with ?). Its table is documentation only: the real bindings
// are in keys.ts.

import { signal } from '@preact/signals';

export const showHelp = signal(false);

const ROWS: [string, string][] = [
  ['N / V (Esc)', 'Note input / select'],
  [
    'W (note input)',
    'Repeat the note entered last (of a chord its selected head, else its top note; middle C when there is none)',
  ],
  [
    'Shift+W',
    'Add a chord tone a third above the top of the note just entered (or selected); only that head is selected, so the arrows place it',
  ],
  ['Alt ↑ ↓', 'Select the next head up / down the chord'],
  ['R (note input)', 'Enter a rest'],
  ['S (note input)', 'Open a slur at the note entered last; S again closes it at the note entered last'],
  ['↑ ↓ (note input)', 'Move the note just entered a step up / down the staff (accidental from key and bar)'],
  ['← → Home Backspace (note input)', 'Move the caret by event / to the measure start / step back and clear'],
  ['+ / - (note input)', 'Sharpen / flatten the note just entered (the accidental buttons do the same)'],
  ['Click (note input)', 'Put the caret there; a click on a note selects it and leaves note input'],
  ['Alt+1 – 4', 'Move the selected notes to that voice'],
  ['Alt+Shift+1 – 4', 'Select everything of that voice in the selected measures'],
  [
    '1 – 8',
    'Duration whole … 128th: the selection in select mode (the next note follows it), else the next note (nothing selected: starts note input)',
  ],
  ['Q or .', 'Cycle dots'],
  ['Shift+1 – 4', 'Voice for new notes (the caret keeps its position in time)'],
  ['↑ ↓', 'Selected notes: semitone up / down'],
  ['Ctrl ↑ ↓', 'Octave up / down (also in note input)'],
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
  ['Alt + wheel over findings', 'Step through stacked findings'],
  ['Ctrl G', 'Go to a measure: asks for its number, Enter selects it and shows it'],
  ['Ctrl E', 'Show the score as text, editable'],
  ['Ctrl I', 'Properties panel'],
  [
    'Ctrl Space  (or Ctrl M)',
    'Switch between the score and the Expression view (velocity, timing and pedals of the performance)',
  ],
  [
    '↑ ↓ (Expression pane)',
    'Change the velocity of the selected notes (or the value of the selected curve point); Shift: ten times as much',
  ],
  [
    '1 to 6 (Expression pane)',
    'Open the tools of the selected notes at the pointer: Set, Ramp, Delta (velocity), Shift (ms), Gate (factor of the notated length), Roll (spread the attacks of chords). Ramp: pick a shape, then the first and the last velocity. Escape closes a window',
  ],
  [
    'Click, drag (tempo and sustain lanes)',
    'Click adds a point, drag moves it; time snaps to the grid of the toolbar, the value to 10% (tempo) or 25% (sustain). Right-click or Delete removes it',
  ],
  [
    'Drag (una corda lane)',
    'Paint a region where the soft pedal is down; drag its edges or its body to change it, right-click or Delete removes it',
  ],
  ['Delete (Expression pane)', 'Remove the selected curve point or region'],
  [
    'Right-drag, wheel (Expression pane)',
    'Pan the roll in both directions; the wheel pans sideways, Alt + wheel up and down, Ctrl + wheel zooms the time axis',
  ],
  [
    'Right-click (Expression pane)',
    'On a tempo or sustain lane, remove the point nearest to the pointer; on the una corda lane, the region under it',
  ],
  [
    'Alt (Expression pane)',
    'While dragging: no snapping, any curve value (not only steps of 25% for the sustain and 10% for the tempo), finer steps',
  ],
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
