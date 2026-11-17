// The findings control of the toolbar: a stepper through the findings of the chosen layer, and their list.
//
// The notes themselves are painted by the score pane (see `layerNotes` in layers.ts). Here the findings are
// numbered in score order; the arrows and a click on a row select the notes of a finding and scroll to it. The
// Layers menu (`Layers.tsx`) chooses the layer.

import { signal } from '@preact/signals';
import { refKey } from '../src/editor/addr.ts';
import { reveal, select } from './interact.ts';
import type { Finding } from './layers.ts';
import { activeLayer, anyLayerOn, findings, layers, placeOf } from './layers.ts';
import { say, selection } from './state.ts';

/** Whether the list of findings is open. */
export const findingsOpen = signal(false);

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

/** The text of the middle button: the current finding with its label, place and voices, else how many there are and of which kinds. */
function summary(all: Finding[], cur: number): string {
  if (!all.length) return 'No findings';
  if (cur >= 0) {
    const f = all[cur];
    return `${cur + 1}/${all.length} · ${f.label} · ${placeOf(f)} · ${f.voices}`;
  }
  const kinds = [...new Set(all.map((f) => f.label))].join(' + ');
  return `${all.length} ${all.length === 1 ? 'finding' : 'findings'} · ${kinds}`;
}

/** The stepper (previous, "2/5", next) with the list of findings as a popover; shown while a layer is on. */
export function FindingsControl() {
  const all = findings.value;
  const cur = currentIndex(all);
  const n = all.length;
  const text = summary(all, cur);
  // Every text the button can show, stacked in one grid cell, so that it is always as wide as the longest and the next button stays put.
  const texts = [...new Set([summary(all, -1), ...all.map((_, i) => summary(all, i))])];
  return (
    <div class="findingsmenu seg" title="Findings of the chosen layer">
      <button type="button" disabled={!n} title="Previous finding (Shift+F8)" onClick={() => step(-1)}>
        ‹
      </button>
      <button
        type="button"
        aria-pressed={findingsOpen.value}
        onClick={() => (findingsOpen.value = !findingsOpen.value)}
      >
        <span class="summary">
          {texts.map((t) => (
            <span class={t === text ? '' : 'sizer'} aria-hidden={t === text ? undefined : 'true'}>
              {t}
            </span>
          ))}
        </span>
      </button>
      <button type="button" disabled={!n} title="Next finding (F8)" onClick={() => step(1)}>
        ›
      </button>
      {findingsOpen.value && (
        <div class="popover findings">
          {n ? (
            <ol>
              {all.map((f, i) => (
                <li>
                  <button type="button" class={i === cur ? 'on' : ''} title={f.detail} onClick={() => goTo(f)}>
                    <span class={`num ${f.severity}`}>{i + 1}</span>
                    <span>
                      {f.label}
                      <span class="ctx">
                        {' '}
                        · {placeOf(f)} · {f.voices}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <span class="ctx">Nothing found.</span>
          )}
        </div>
      )}
    </div>
  );
}
