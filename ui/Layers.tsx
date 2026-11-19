// The Layers menu of the toolbar: one radio button per layer (see `layers.ts`; one layer or none is chosen).
//
// Layers are analyses that point at places in the score; display options such as voice colors are in the View menu.

import { activeLayer, layers, layersOpen } from './layers.ts';

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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
