// The Layers menu of the toolbar: one radio button per layer (see `layers.ts`; one layer or none is chosen) and the
// settings of the chosen layer.
//
// Layers are analyses that point at places in the score; display options such as voice colors are in the View menu.

import type { JSX } from 'preact';
import { Dropdown } from './Dropdown.tsx';
import type { ParallelKindChoice } from './layers.ts';

import { activeLayer, layers, layersOpen, parallelKinds } from './layers.ts';

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
