// The parallel fifths and octaves control of the toolbar: a stepper through the findings and their list.
//
// The notes themselves are drawn in the warning colour by the score pane (see `parallelNotes` in state.ts).
// Here the groups are numbered in score order; the arrows and a click on a row select the notes of a group
// and scroll to it.

import { signal } from '@preact/signals';
import type { ParallelGroup } from '../src/analysis/parallels.ts';
import type { Ref } from '../src/editor/addr.ts';
import { refKey } from '../src/editor/addr.ts';
import { PPQ } from '../src/model.ts';
import { reveal, select } from './interact.ts';
import { parallels, say, selection, showParallels } from './state.ts';

/** Whether the list of findings is open. */
export const parallelsOpen = signal(false);

/** Where the group starts, as a measure and a beat. */
function placeOf(g: ParallelGroup): string {
  const beat = Math.round((g.tick / PPQ + 1) * 100) / 100;
  return `m. ${g.mi + 1}, beat ${beat}`;
}

/** The voices in the group, such as "rh.1 + lh.1". */
function voicesOf(g: ParallelGroup): string {
  return [...new Set(g.notes.map((n) => `${n.ev.staff}.${n.ev.voice}`))].join(' + ');
}

/** The refs of the notes in the group. */
function refsOf(g: ParallelGroup): Ref[] {
  return g.notes.map((n) => ({ t: 'ev', ...n.ev, pi: n.pi }));
}

/** The index of the group whose notes are all selected, or -1. */
function currentIndex(groups: ParallelGroup[]): number {
  const sel = new Set(selection.value.map(refKey));
  return groups.findIndex((g) => refsOf(g).every((r) => sel.has(refKey(r))));
}

/** Selects group `i` and scrolls to it. */
function goTo(g: ParallelGroup): void {
  const refs = refsOf(g);
  select(refs);
  reveal(refs[0]);
}

/** Selects the next (`dir` 1) or previous (-1) group, wrapping round; from no group, the next one is the first and the previous the last. */
function step(dir: 1 | -1): void {
  const groups = parallels.peek();
  if (!groups.length) {
    say('No consecutive fifths or octaves');
    return;
  }
  const cur = currentIndex(groups);
  goTo(groups[cur < 0 ? (dir > 0 ? 0 : groups.length - 1) : (cur + dir + groups.length) % groups.length]);
}

/** Steps through the findings from the keyboard (F8 / Shift+F8), turning the check on first if it is off. */
export function stepParallels(dir: 1 | -1): void {
  showParallels.value = true;
  step(dir);
}

/** The text of the middle button: the current group with its kind, place and voices, else how many there are and of which kinds. */
function summary(groups: ParallelGroup[], cur: number): string {
  if (!groups.length) return 'No parallels';
  if (cur >= 0) {
    const g = groups[cur];
    return `${cur + 1}/${groups.length} · ${g.kinds.join(' + ')} · ${placeOf(g)} · ${voicesOf(g)}`;
  }
  const kinds = [...new Set(groups.flatMap((g) => g.kinds))].join(' + ');
  return `${groups.length} ${groups.length === 1 ? 'finding' : 'findings'} · ${kinds}`;
}

/** The stepper (previous, "2/5", next) with the list of findings as a popover; shown while the check is on. */
export function ParallelsControl() {
  const groups = parallels.value;
  const cur = currentIndex(groups);
  const n = groups.length;
  const text = summary(groups, cur);
  // Every text the button can show, stacked in one grid cell, so that it is always as wide as the longest and the next button stays put.
  const texts = [...new Set([summary(groups, -1), ...groups.map((_, i) => summary(groups, i))])];
  return (
    <div class="parallelmenu seg" title="Consecutive fifths and octaves">
      <button type="button" disabled={!n} title="Previous finding (Shift+F8)" onClick={() => step(-1)}>
        ‹
      </button>
      <button
        type="button"
        aria-pressed={parallelsOpen.value}
        onClick={() => (parallelsOpen.value = !parallelsOpen.value)}
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
      {parallelsOpen.value && (
        <div class="popover parallels">
          {n ? (
            <ol>
              {groups.map((g, i) => (
                <li>
                  <button type="button" class={i === cur ? 'on' : ''} onClick={() => goTo(g)}>
                    <span class="num">{g.number}</span>
                    <span>
                      {g.kinds.join(' + ')}
                      <span class="ctx">
                        {' '}
                        · {placeOf(g)} · {voicesOf(g)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <span class="ctx">No consecutive fifths or octaves.</span>
          )}
        </div>
      )}
    </div>
  );
}
