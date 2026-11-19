// Layers: analyses that look at the score and point at places in it (consecutive fifths).
//
// One layer or none is chosen in the toolbar's Layers menu (`activeLayer`; the layers are independent analyses, and
// one at a time lets them share colors). The chosen layer contributes `Finding`s: places in the score with a short
// label and the notes involved. Everything that shows findings
// is written against this one shape: the score pane paints the notes in the color of their severity (`layerNotes`),
// the stepper in `Findings.tsx` walks through the findings of the chosen layer, and the Overview strip marks their
// measures. Display options that do not analyze anything (voice colors, ...) stay in the View menu.
//
// The findings of the parallels layer are a pure function of the score and its settings (a computed signal), so
// they follow edits without any bookkeeping. Nothing here touches the engraving or its cache.

import type { ReadonlySignal } from '@preact/signals';
import { computed, signal } from '@preact/signals';

import { findParallels, voicesOf } from '../src/analysis/parallels.ts';
import type { Ref } from '../src/editor/addr.ts';
import { eventOf, refKey } from '../src/editor/addr.ts';
import { beatOf } from '../src/model.ts';
import { score } from './state.ts';

/** One place a layer points at. */
export interface Finding {
  /** The id of the layer that found it. */
  layer: string;
  /** What was found, in a few words, such as "2 fifths + 1 octave". */
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

/** A layer: a title, and the findings it contributes while it is the chosen one. */
export interface Layer {
  id: string;
  /** The name in the Layers menu. */
  label: string;
  /** The tooltip of the menu entry. */
  title: string;
  /** Whether this is the chosen layer. */
  on: ReadonlySignal<boolean>;
  /** The findings, in score order; empty while the layer is off. */
  findings: ReadonlySignal<Finding[]>;
}

// The parallels layer: consecutive fifths and octaves, with the choice of which of the two to look for.

/** Which intervals the parallels layer looks for. */
export type ParallelKindChoice = 'both' | 'fifths' | 'octaves';

/** The intervals the parallels layer looks for: both, or only fifths or only octaves. */
export const parallelKinds = signal<ParallelKindChoice>('both');

/** The id of the chosen layer, or null for none. */
export const activeLayer = signal<string | null>(null);

const parallelsOn = computed(() => activeLayer.value === 'parallels');

/** A count with its noun in the right number: "1 fifth", "2 fifths". */
function countOf(kind: 'fifths' | 'octaves', n: number): string {
  return `${n} ${n === 1 ? kind.slice(0, -1) : kind}`;
}

/** The groups of consecutive fifths and octaves of the score as findings. */
const parallelFindings = computed<Finding[]>(() => {
  if (!parallelsOn.value) return [];
  const k = parallelKinds.value;
  return findParallels(score.value, k === 'both' ? ['fifths', 'octaves'] : [k]).map((g) => ({
    layer: 'parallels',
    label: g.kinds.map((k) => countOf(k, g.counts[k] ?? 1)).join(' + '),
    voices: voicesOf(g),
    mi: g.mi,
    tick: g.tick,
    refs: g.notes.map((n) => ({ t: 'ev', ...n.ev, pi: n.pi })),
    severity: 'error' as const,
  }));
});

/** Whether the Layers menu is open. */
export const layersOpen = signal(false);

/** All layers, in the order of the Layers menu. */
export const layers: Layer[] = [
  {
    id: 'parallels',
    label: 'Parallels',
    title: 'Consecutive fifths and octaves',
    on: parallelsOn,
    findings: parallelFindings,
  },
];

/** The findings of all layers that are on, in score order. */
export const findings = computed<Finding[]>(() =>
  layers.flatMap((l) => l.findings.value).sort((a, b) => a.mi - b.mi || a.tick - b.tick),
);

/** Whether the chosen layer has findings to step through. */
export const anyLayerOn = computed(() => layers.some((l) => l.on.value));

/** The colors the layers paint notes with: errors and warnings. */
const LAYER_COLORS = { error: '#d6361f', warn: '#e08a00' };

/** What a note is painted for; an error wins over a warning. */
type Paint = keyof typeof LAYER_COLORS;

const RANK: Record<Paint, number> = { error: 2, warn: 1 };

/** The notes the layers paint, as `refKey`s with their color: the heads, and the events whose heads are all painted alike or by a finding (which are drawn whole, stem and flags too). */
export const layerNotes = computed(() => {
  const paint = new Map<string, Paint>();
  const put = (k: string, p: Paint) => {
    const old = paint.get(k);
    if (!old || RANK[p] > RANK[old]) paint.set(k, p);
  };
  for (const f of findings.value) for (const r of f.refs) put(refKey(r), f.severity);
  const sc = score.value;
  const heads = new Map<string, string>();
  const wholeEvents = new Map<string, string>();
  for (const [k, p] of paint) heads.set(k, LAYER_COLORS[p]);
  const seen = new Set<string>();
  for (const f of findings.value.flatMap((x) => x.refs)) {
    if (f.t !== 'ev') continue;
    const evKey = refKey({ ...f, pi: undefined });
    if (seen.has(evKey)) continue;
    seen.add(evKey);
    const e = eventOf(sc, f);
    if (e?.kind !== 'note') continue;
    const ps = e.pitches.map((_, pi) => paint.get(refKey({ ...f, pi })));
    if (ps.some((p) => !p)) continue;
    const top = ps.reduce((a, b) => (RANK[b as Paint] > RANK[a as Paint] ? b : a)) as Paint;
    if (top === 'error' || ps.every((p) => p === top)) wholeEvents.set(evKey, LAYER_COLORS[top]);
  }
  return { heads, wholeEvents };
});

/** Where the finding starts, as a measure and a beat. */
export function placeOf(f: Finding): string {
  return `m. ${f.mi + 1}, beat ${beatOf(f.tick)}`;
}
