// Layers: analyses that look at the score and point at places in it (consecutive fifths, playability, the hands).
//
// One layer or none is chosen in the toolbar's Layers menu (`activeLayer`; the layers are independent analyses, and
// one at a time lets them share colors). The chosen layer contributes `Finding`s: places in the score with a short
// label and the notes involved (a layer can also just color notes, like the hands). Everything that shows findings
// is written against this one shape: the score pane paints the notes in the color of their severity (`layerNotes`),
// the stepper in `Findings.tsx` walks through the findings of the chosen layer, and the Overview strip marks their
// measures. Display options that do not analyze anything (voice colors, ...) stay in the View menu.
//
// The findings of the parallels layer are a pure function of the score and its settings (a computed signal), so
// they follow edits without any bookkeeping. The playability and hands layers get theirs from a worker
// (`analysis.ts`), a short pause after the last edit. Nothing here touches the engraving or its cache.

import type { ReadonlySignal } from '@preact/signals';
import { computed, effect, signal } from '@preact/signals';

import { findParallels, voicesOf } from '../src/analysis/parallels.ts';
import type { Analysis, PedalMode } from '../src/analysis/playability.ts';
import { DEFAULT_PLAY } from '../src/analysis/playability.ts';
import type { Ref } from '../src/editor/addr.ts';
import { eventOf, refKey } from '../src/editor/addr.ts';
import { beatOf } from '../src/model.ts';
import { analyze, spanNeeded as solveSpan } from './analysis.ts';
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
  /** Whether the layer only colors notes and has no findings to step through. */
  paintOnly?: true;
}

// The parallels layer: consecutive fifths and octaves, with the choice of which of the two to look for.

/** Which intervals the parallels layer looks for. */
export type ParallelKindChoice = 'both' | 'fifths' | 'octaves';

/** The intervals the parallels layer looks for: both, or only fifths or only octaves. */
export const parallelKinds = signal<ParallelKindChoice>('both');

/** The id of the chosen layer, or null for none. */
export const activeLayer = signal<string | null>(null);

const parallelsOn = computed(() => activeLayer.value === 'parallels');

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

const playabilityOn = computed(() => activeLayer.value === 'playability');

const handsOn = computed(() => activeLayer.value === 'hands');

/** The voices column of a playability finding: the hand, where known. */
const handName = (h: 'L' | 'R' | undefined): string => (h === 'L' ? 'left hand' : h === 'R' ? 'right hand' : '');

/** Whether the Layers menu is open (the span the piece needs is only worked out then). */
export const layersOpen = signal(false);

/** How long the score has to stay unchanged before it is analyzed again, in milliseconds. */
const SETTLE_MS = 120;

/** What the worker last found for the current score and settings. */
const playResult = signal<Analysis>({ findings: [], hands: [], fingers: [] });

/** The widest span the piece needs, in semitones; null when no span helps, undefined while it is being worked out or not asked for. */
export const spanNeeded = signal<number | null | undefined>(undefined);

// The solver runs in a worker (see `analysis.ts`). A change of the score or the settings starts a request after a
// short pause; an answer for an older request is dropped, and until the new one arrives the old findings stay.
let playRequest = 0;

effect(() => {
  if (!(playabilityOn.value || handsOn.value)) {
    playRequest++;
    playResult.value = { findings: [], hands: [], fingers: [] };
    return;
  }
  const sc = score.value;
  const options = { maxSpan: handSpan.value, pedal: pedalMode.value };
  const id = ++playRequest;
  const timer = setTimeout(async () => {
    const found = await analyze(sc, options);
    if (id === playRequest) playResult.value = found;
  }, SETTLE_MS);
  return () => clearTimeout(timer);
});

let spanRequest = 0;

effect(() => {
  if (!(playabilityOn.value && layersOpen.value)) {
    spanRequest++;
    return;
  }
  const sc = score.value;
  const pedal = pedalMode.value;
  const id = ++spanRequest;
  const timer = setTimeout(async () => {
    const span = await solveSpan(sc, pedal);
    if (id === spanRequest) spanNeeded.value = span;
  }, SETTLE_MS);
  return () => clearTimeout(timer);
});

/** The playability findings of the score as findings. */
const playabilityFindings = computed<Finding[]>(() =>
  (playabilityOn.value ? playResult.value.findings : []).map((f) => ({
    layer: 'playability',
    label: f.title,
    detail: f.message,
    voices: handName(f.hand),
    mi: f.mi,
    tick: f.tick,
    refs: f.notes.map((n) => ({ t: 'ev', ...n.ev, pi: n.pi })),
    severity: f.severity,
  })),
);

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
  {
    id: 'hands',
    label: 'Hands',
    title: 'Which hand plays which note, as the playability check infers it (pin a note to a hand in Properties)',
    on: handsOn,
    findings: computed<Finding[]>(() => []),
    paintOnly: true,
  },
];

/** The findings of all layers that are on, in score order. */
export const findings = computed<Finding[]>(() =>
  layers.flatMap((l) => l.findings.value).sort((a, b) => a.mi - b.mi || a.tick - b.tick),
);

/** Whether the chosen layer has findings to step through. */
export const anyLayerOn = computed(() => layers.some((l) => l.on.value && !l.paintOnly));

/** The colors the layers paint notes with: errors, warnings, and the two hands. */
const LAYER_COLORS = { error: '#d6361f', warn: '#e08a00', left: '#00897b', right: '#c2185b' };

/** What a note is painted for; an error wins over a warning, which wins over a hand. */
type Paint = keyof typeof LAYER_COLORS;

const RANK: Record<Paint, number> = { error: 3, warn: 2, left: 1, right: 1 };

/** The fingers to draw on the notes (by `refKey` of the head): while the playability or hands layer is chosen. */
export const layerFingers = computed(() => {
  const out = new Map<string, number>();
  if (playabilityOn.value || handsOn.value)
    for (const f of playResult.value.fingers) out.set(refKey({ t: 'ev', ...f.ev, pi: f.pi }), f.finger);
  return out;
});

/** The notes the layers paint, as `refKey`s with their color: the heads, and the events whose heads are all painted alike or by a finding (which are drawn whole, stem and flags too). */
export const layerNotes = computed(() => {
  const paint = new Map<string, Paint>();
  const put = (k: string, p: Paint) => {
    const old = paint.get(k);
    if (!old || RANK[p] > RANK[old]) paint.set(k, p);
  };
  for (const f of findings.value) for (const r of f.refs) put(refKey(r), f.severity);
  if (handsOn.value)
    for (const h of playResult.value.hands)
      put(refKey({ t: 'ev', ...h.ev, pi: h.pi }), h.hand === 'L' ? 'left' : 'right');
  const sc = score.value;
  const heads = new Map<string, string>();
  const wholeEvents = new Map<string, string>();
  for (const [k, p] of paint) heads.set(k, LAYER_COLORS[p]);
  const seen = new Set<string>();
  for (const f of findings.value
    .flatMap((x) => x.refs)
    .concat(playResult.value.hands.map((h) => ({ t: 'ev' as const, ...h.ev, pi: h.pi })))) {
    if (f.t !== 'ev') continue;
    const evKey = refKey({ ...f, pi: undefined });
    if (seen.has(evKey)) continue;
    seen.add(evKey);
    const e = eventOf(sc, f);
    if (e?.kind !== 'note') continue;
    const ps = e.pitches.map((_, pi) => paint.get(refKey({ ...f, pi })));
    if (ps.some((p) => !p)) continue;
    const top = ps.reduce((a, b) => (RANK[b as Paint] > RANK[a as Paint] ? b : a)) as Paint;
    if (RANK[top] > 1 || ps.every((p) => p === top)) wholeEvents.set(evKey, LAYER_COLORS[top]);
  }
  return { heads, wholeEvents };
});

/** Where the finding starts, as a measure and a beat. */
export function placeOf(f: Finding): string {
  return `m. ${f.mi + 1}, beat ${beatOf(f.tick)}`;
}
