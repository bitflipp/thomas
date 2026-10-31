# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

TypeScript runs directly on Node (≥ 22.18, type stripping; no build step, no linter). PDF output needs `rsvg-convert`.

```
npm test                                          # all tests (node --test test/)
node --test --test-name-pattern="ledger" test/    # a single test by name
node src/cli.ts render examples/gewitter.txt out/gewitter --pdf   # -> out/gewitter-N.svg + .pdf
node src/cli.ts check examples/gewitter.txt --collisions --mark out/mk   # list overlaps; out/mk-N.svg boxes them in red
node src/cli.ts import gewitter.musicxml examples/gewitter.txt     # MusicXML -> text format
node src/cli.ts check <file>                      # validate measure lengths
python3 tools/crop.py out/gewitter-2.svg x y w h out.png [px]      # render a region (staff spaces) to PNG
```

Because `node` strips types only: no enums, no constructor parameter properties, and imports need the `.ts` extension.

## Architecture

Pipeline: text/MusicXML → `Score` model → `prepare` → per-measure spacing → line breaking → justification → drawing into per-staff primitive lists → spanners/marks → system finalisation → pagination → SVG (`render.ts`).

- **`src/model.ts` is the source of truth.** Everything is in integer ticks (`PPQ = 3360` per quarter). A voice is a tree of `Item`s (events, `TupletGroup`, `BeamGroup`), flattened by `flattenVoice`. Time-positioned marks (dynamics, hairpins, pedal, ottava, clef changes, tempo) live in a per-staff `marks` list, not on events. Hairpins/pedal/ottava are start/stop pairs matched later across measures and systems.
- **`src/textformat.ts` must stay lossless**: `write(parse(text)) == text` and `parse(write(score))` deep-equals the model; `test/roundtrip.test.ts` checks it on the full piece. When adding a model field, update the writer, the parser, and the importer together. `FORMAT.md` is the grammar and is the user-facing spec.
- **`src/musicxml.ts`** drops all MuseScore positions and (by default) its automatic breaks; voices are renumbered per staff. Tuplets and beams are rebuilt from start/stop ranges into nested groups.
- **Engraver (`src/engrave/`)**: all units are staff spaces, y points down, staff-local y=0 is the top line, and staff positions count half-spaces above the bottom line (`posToY` in `prep.ts`).
  - `prep.ts` builds `EvL` records (written positions after ottava/clef, accidentals, beam groups, stem directions) shared by all later phases. Layout results are written back onto these objects (`e.x`, `heads[].dx`/`accX`/`shared`, `shiftDx`, `geomOf` WeakMap in `draw.ts`).
  - `spaceMeasure` runs **twice per measure** (normal and "first in system", which skips a clef change at tick 0). Its mutations of `EvL`/`HeadL` must therefore be idempotent (`layoutColumnStaff` resets them first); a bug here once doubled head offsets.
  - Spacing is `x_j = max(prev + f·ideal, collision constraints)`. `f` is solved by bisection per system; `planSystems` (DP in `system.ts`) allows compression down to `COMPRESS`.
  - Drawing is staff-local per system; `spanners.ts` runs after all systems exist (slurs/ties/marks can cross systems) and uses `Skyline` boxes for collision avoidance. `finalize` in `system.ts` then fixes staff distances from the skyline extents.
- **Collisions (`src/engrave/collide.ts`)**: every prim carries `k` (kind), `o` (owner) and `g` (groups) tags set where it is pushed (`tagFrom`/`oid` in `scene.ts`). `findCollisions(pages)` reports any overlap not in `ALLOW` (pairs of kinds, scope `own`/`any`); staff lines and untagged prims are ignored. Pairs of box-like shapes are compared by bounding box, others by outline. `test/collisions.test.ts` runs it on the whole piece; `KNOWN` there lists tolerated leftovers. New drawing code must tag its prims.
- **`src/smufl.ts`**: Bravura outlines via opentype.js; `CP` maps glyph names to codepoints. `checkCodepoints()` verifies the table against the font metadata advances; run it when adding glyphs.

## Conventions worth knowing

- `examples/gewitter.txt` is generated from `gewitter.musicxml` (the reference piece covering every supported feature; see `FEATURES.md`). Regenerate it with `import` after importer changes.
- Engraving tests assert on emitted primitives (`engrave(...).pages[0].prims`), not on pixels. Visual checks are done by rendering and viewing crops; `out/` is git-ignored.
