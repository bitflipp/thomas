// The Layers menu of the toolbar: one checkbox per layer (see `layers.ts`) and the settings of the layers that are on.
//
// Layers are analyses that point at places in the score; display options such as voice colors are in the View menu.

import { signal } from '@preact/signals';
import type { JSX } from 'preact';
import type { PedalMode } from '../src/analysis/playability.ts';
import { spanName } from '../src/analysis/playability.ts';
import { Dropdown } from './Dropdown.tsx';
import type { ParallelKindChoice } from './layers.ts';
import { HAND_SIZES, handSpan, layers, parallelKinds, pedalMode, spanNeeded } from './layers.ts';

/** Whether the menu is open. */
export const layersOpen = signal(false);

/** The settings of each layer, shown under its checkbox while it is on. */
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
          {need === null
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
          {layers.map((l) => (
            <div class="layer" key={l.id}>
              <label title={l.title}>
                <input
                  type="checkbox"
                  checked={l.on.value}
                  onChange={(e) => (l.on.value = (e.target as HTMLInputElement).checked)}
                />{' '}
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
