// The Layers menu of the toolbar: one radio button per layer (see `layers.ts`; one layer or none is chosen) and the
// settings of the chosen layer.
//
// Layers are analyses that point at places in the score; display options such as voice colors are in the View menu.

import type { JSX } from 'preact';
import type { PedalMode } from '../src/analysis/playability.ts';
import { spanName } from '../src/analysis/playability.ts';
import { Dropdown } from './Dropdown.tsx';
import type { ParallelKindChoice } from './layers.ts';

import {
  activeLayer,
  HAND_SIZES,
  handSpan,
  layers,
  layersOpen,
  parallelKinds,
  pedalMode,
  spanNeeded,
} from './layers.ts';

/** The settings of each layer, shown under its radio button while it is chosen. */
const SETTINGS: Record<string, () => JSX.Element> = {
  parallels: () => (
    <Dropdown<ParallelKindChoice>
      value={parallelKinds.value}
      opts={[
        { value: 'both', label: 'Fifths and octaves' },
        { value: 'fifths', label: 'Fifths' },
        { value: 'octaves', label: 'Octaves' },
      ]}
      onChange={(v) => (parallelKinds.value = v)}
      title="Which parallel intervals to mark"
    />
  ),
  playability: () => {
    const need = spanNeeded.value;
    return (
      <>
        <Dropdown<number>
          value={handSpan.value}
          opts={HAND_SIZES}
          onChange={(v) => (handSpan.value = v)}
          title="The widest span of one hand (thumb to little finger) the check allows; the default stays below what most adults reach"
        />
        <Dropdown<PedalMode>
          value={pedalMode.value}
          opts={[
            { value: 'assumed', label: 'Pedal assumed' },
            { value: 'explicit', label: 'Pedal as marked' },
            { value: 'never', label: 'No pedal' },
          ]}
          onChange={(v) => (pedalMode.value = v)}
          title="Whether the sustain pedal can carry notes that the fingers would otherwise have to hold"
        />
        <span class="ctx">
          {need === undefined
            ? 'Working out the span the piece needs...'
            : need === null
              ? 'No span helps this piece'
              : need === 0
                ? 'No stretch needed'
                : `The piece needs a span of a ${spanName(need)}`}
        </span>
      </>
    );
  },
};

/** The "Layers" button and its popover. */
export function LayersMenu() {
  return (
    <div class="layersmenu" onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" aria-pressed={layersOpen.value} onClick={() => (layersOpen.value = !layersOpen.value)}>
        Layers ▾
      </button>
      {layersOpen.value && (
        <div class="popover">
          <div class="layer">
            <label>
              <input
                type="radio"
                name="layer"
                checked={activeLayer.value === null}
                onChange={() => (activeLayer.value = null)}
              />{' '}
              Off
            </label>
          </div>
          {layers.map((l) => (
            <div class="layer" key={l.id}>
              <label title={l.title}>
                <input type="radio" name="layer" checked={l.on.value} onChange={() => (activeLayer.value = l.id)} />{' '}
                {l.label}
              </label>
              {l.on.value && SETTINGS[l.id]?.()}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
