// Layers: analyses that look at the score and point at places in it (consecutive fifths, and later playability).
//
// A layer is switched on in the toolbar's Layers menu and then contributes `Finding`s: places in the score with a
// short label and the notes involved. Everything that shows findings is written against this one shape: the
// notes are drawn in the warning color by the score pane (`layerNotes`), the stepper in `Findings.tsx` walks
// through all findings of the layers that are on, and the Overview strip marks their measures. Display options
// that do not analyze anything (voice colors, ...) stay in the View menu.
//
// A layer's findings are a pure function of the score and its settings (a computed signal), so they follow edits
// without any bookkeeping. Nothing here touches the engraving or its cache.

import type { ReadonlySignal } from '@preact/signals';
import { computed, signal } from '@preact/signals';

import type { ParallelGroup } from '../src/analysis/parallels.ts';
import { findParallels } from '../src/analysis/parallels.ts';
import type { PedalMode } from '../src/analysis/playability.ts';
import { DEFAULT_PLAY, findPlayability, requiredSpan } from '../src/analysis/playability.ts';
import type { Ref } from '../src/editor/addr.ts';
import { eventOf, refKey } from '../src/editor/addr.ts';
import { PPQ } from '../src/model.ts';
import { score } from './state.ts';

/** One place a layer points at. */
export interface Finding {
  /** The id of the layer that found it. */
  layer: string;
  /** What was found, in a few words, such as "fifths + octaves". */
  label: string;
  /** A longer explanation, shown as a tooltip. */
  detail?: string;
  /** The voices involved, such as "rh.1 + lh.1". */
  voices: string;
  /** The measure and the tick in it where the finding starts. */
  mi: number;
  tick: number;
  /** The notes involved, as head refs. */
  refs: Ref[];
  /** An error is drawn in red, a warning in orange. */
  severity: 'error' | 'warn';
}

/** A layer: a switch, a title, and the findings it contributes while the switch is on. */
export interface Layer {
  id: string;
  /** The name in the Layers menu. */
  label: string;
  /** The tooltip of the menu entry. */
  title: string;
  on: ReadonlySignal<boolean> & { value: boolean };
  /** The findings, in score order; empty while the layer is off. */
  findings: ReadonlySignal<Finding[]>;
}

// The parallels layer: consecutive fifths and octaves, with the choice of which of the two to look for.

/** Which intervals the parallels layer looks for. */
export type ParallelKindChoice = 'both' | 'fifths' | 'octaves';

/** The intervals the parallels layer looks for: both, or only fifths or only octaves. */
export const parallelKinds = signal<ParallelKindChoice>('both');

const parallelsOn = signal(false);

/** The voices in the group, such as "rh.1 + lh.1". */
function voicesOf(g: ParallelGroup): string {
  return [...new Set(g.notes.map((n) => `${n.ev.staff}.${n.ev.voice}`))].join(' + ');
}

/** The groups of consecutive fifths and octaves of the score as findings. */
const parallelFindings = computed<Finding[]>(() => {
  if (!parallelsOn.value) return [];
  const k = parallelKinds.value;
  return findParallels(score.value, k === 'both' ? ['fifths', 'octaves'] : [k]).map((g) => ({
    layer: 'parallels',
    label: g.kinds.join(' + '),
    voices: voicesOf(g),
    mi: g.mi,
    tick: g.tick,
    refs: g.notes.map((n) => ({ t: 'ev', ...n.ev, pi: n.pi })),
    severity: 'error' as const,
  }));
});

// The playability layer: spans, leaps and note counts that the hands cannot manage, with the hand size and pedal setting.

/** The hand sizes to choose from: the widest span of one hand in semitones, thumb to little finger. */
export const HAND_SIZES = [
  { value: 12, label: 'Small (octave)' },
  { value: 14, label: 'Medium (9th)' },
  { value: 16, label: 'Large (10th)' },
  { value: 19, label: 'Very large (12th)' },
];

/** The widest span of one hand the layer allows, in semitones. */
export const handSpan = signal(DEFAULT_PLAY.maxSpan);

/** Whether the sustain pedal is assumed to carry held notes. */
export const pedalMode = signal<PedalMode>(DEFAULT_PLAY.pedal);

const playabilityOn = signal(false);

/** The voices column of a playability finding: the hand, where known. */
const handName = (h: 'L' | 'R' | undefined): string => (h === 'L' ? 'left hand' : h === 'R' ? 'right hand' : '');

/** The playability findings of the score as findings. */
const playabilityFindings = computed<Finding[]>(() => {
  if (!playabilityOn.value) return [];
  return findPlayability(score.value, { maxSpan: handSpan.value, pedal: pedalMode.value }).map((f) => ({
    layer: 'playability',
    label: f.title,
    detail: f.message,
    voices: handName(f.hand),
    mi: f.mi,
    tick: f.tick,
    refs: f.notes.map((n) => ({ t: 'ev', ...n.ev, pi: n.pi })),
    severity: f.severity,
  }));
});

/** The widest span the piece needs, in semitones, or null when no span helps; read only while the Layers menu shows it. */
export const spanNeeded = computed(() => requiredSpan(score.value, pedalMode.value));

/** All layers, in the order of the Layers menu. */
export const layers: Layer[] = [
  {
    id: 'parallels',
    label: 'Parallels',
    title: 'Consecutive fifths and octaves',
    on: parallelsOn,
    findings: parallelFindings,
  },
  {
    id: 'playability',
    label: 'Playability',
    title: 'Chords, spans and leaps that two hands cannot manage',
    on: playabilityOn,
    findings: playabilityFindings,
  },
];

/** The findings of all layers that are on, in score order. */
export const findings = computed<Finding[]>(() =>
  layers.flatMap((l) => l.findings.value).sort((a, b) => a.mi - b.mi || a.tick - b.tick),
);

/** Whether any layer is on. */
export const anyLayerOn = computed(() => layers.some((l) => l.on.value));

/** The notes in `findings` as `refKey`s with their severity (an error wins over a warning): the heads, and the events all of whose heads are involved (which are drawn whole). */
export const layerNotes = computed(() => {
  const heads = new Map<string, Finding['severity']>();
  const wholeEvents = new Map<string, Finding['severity']>();
  const all = findings.value;
  const put = (m: Map<string, Finding['severity']>, k: string, sev: Finding['severity']) => {
    if (m.get(k) !== 'error') m.set(k, sev);
  };
  for (const f of all) for (const r of f.refs) put(heads, refKey(r), f.severity);
  const sc = score.value;
  for (const f of all)
    for (const r of f.refs) {
      if (r.t !== 'ev') continue;
      const e = eventOf(sc, r);
      if (e?.kind === 'note' && e.pitches.every((_, pi) => heads.has(refKey({ ...r, pi }))))
        put(
          wholeEvents,
          refKey({ ...r, pi: undefined }),
          e.pitches.some((_, pi) => heads.get(refKey({ ...r, pi })) === 'error') ? 'error' : 'warn',
        );
    }
  return { heads, wholeEvents };
});

/** Where the finding starts, as a measure and a beat. */
export function placeOf(f: Finding): string {
  const beat = Math.round((f.tick / PPQ + 1) * 100) / 100;
  return `m. ${f.mi + 1}, beat ${beat}`;
}
