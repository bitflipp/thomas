// Stepping through the findings of the chosen layer from the keyboard (F8 / Shift+F8).
//
// The notes and the titles of the findings are drawn in the score pane (`layerNotes` in layers.ts,
// `FindingsSvg` in ScorePane.tsx). Here a step selects the notes of a finding and scrolls to it. The
// Layers menu (`Layers.tsx`) chooses the layer.

import { refKey } from '../src/editor/addr.ts';
import { reveal, select } from './interact.ts';
import type { Finding } from './layers.ts';
import { activeLayer, anyLayerOn, findings, layers } from './layers.ts';
import { say, selection } from './state.ts';

/** The index of the finding whose notes are all selected, or -1. */
function currentIndex(all: Finding[]): number {
  const sel = new Set(selection.value.map(refKey));
  return all.findIndex((f) => f.refs.every((r) => sel.has(refKey(r))));
}

/** Selects the finding and scrolls to it. */
function goTo(f: Finding): void {
  select(f.refs);
  reveal(f.refs[0]);
}

/** Selects the next (`dir` 1) or previous (-1) finding, wrapping round; from no finding, the next one is the first and the previous the last. */
function step(dir: 1 | -1): void {
  const all = findings.peek();
  if (!all.length) {
    say('No findings');
    return;
  }
  const cur = currentIndex(all);
  goTo(all[cur < 0 ? (dir > 0 ? 0 : all.length - 1) : (cur + dir + all.length) % all.length]);
}

/** Steps through the findings from the keyboard (F8 / Shift+F8), choosing the first layer if none is. */
export function stepFindings(dir: 1 | -1): void {
  if (!anyLayerOn.peek()) activeLayer.value = layers[0].id;
  step(dir);
}
