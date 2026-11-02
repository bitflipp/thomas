# thomas — a music typesetter

Text (or MusicXML) in, engraved SVG/PDF out. It reads a human-readable score format (see [FORMAT.md](FORMAT.md)),
computes the whole layout and draws it with the SMuFL font Bravura. Everything the sample piece
`gewitter.musicxml` needs is supported (see [FEATURES.md](FEATURES.md)).

```
npm install
node src/cli.ts import gewitter.musicxml examples/gewitter.txt   # MusicXML -> text
node src/cli.ts render examples/gewitter.txt out/gewitter --pdf  # text -> out/gewitter-N.svg + out/gewitter.pdf
node src/cli.ts render gewitter.musicxml out/g                   # MusicXML works directly too
node src/cli.ts check examples/gewitter.txt                      # validate measure lengths etc.
npm test
```

Requires Node ≥ 22.18 (runs TypeScript directly, no build step) and `rsvg-convert` for PDF output.
Render options: `--pdf`, `--no-breaks` (ignore `break=` in the score), `--numbers` (number every measure; default is the first measure of each system but the first), `--no-numbers`.
Import options: `--keep-breaks`, `--keep-stems`.

## Editor

```
npm run ui          # dev server (Vite); open the printed URL
npm run ui:build    # static build in out/ui
```

A mouse-first score editor in the browser, running the same engraver. Pick a tool on the left and click or drag on the score:
enter notes and rests (a ghost note shows where it lands; clicking a note adds or removes a chord tone), drag a note to change its
pitch or move it to the other staff, drag between notes for slurs, along a staff for hairpins, pedal and 8va/8vb, click for dynamics,
text, tempo and clef changes, click a note or rest to make a tuplet. The panel on the right edits whatever is selected (duration, dots,
accidentals, stems, articulations, ties, grouping, marks, tuplets, measures: time, key, barlines, breaks). Undo/redo everywhere, copy/paste
of notes, autosave in the browser, printing (PDF via the print dialog). `Ctrl E` shows the score as text (the format of FORMAT.md) next to it, editable;
`?` lists the keyboard shortcuts. Opens `.txt` scores and MusicXML.

## Layout of the code

| File | Purpose |
|---|---|
| `src/model.ts` | Score model (JSON-serialisable), tick arithmetic, validation |
| `src/xml.ts`, `src/musicxml*.ts` | Small XML parser; MusicXML → model (entry, measure reader, voice builder) |
| `src/textformat.ts` | Model ⇄ text (writer and parser) |
| `src/smufl.ts` | Bravura glyph outlines (as SVG paths) and metrics |
| `src/engrave/prep.ts` | Analysis: clef/ottava state, written pitch positions, accidentals, beaming, stem directions |
| `src/engrave/spacing.ts` | Columns per measure, extents, accidental stacking, stretchable spacing |
| `src/engrave/draw.ts` | Heads, stems, flags, beams, tremolos, tuplets, articulations, arpeggios |
| `src/engrave/spanners.ts`, `marks.ts` | Ties and slurs; dynamics, hairpins, pedal, octave shifts, tempo (collision-aware via skylines) |
| `src/engrave/linebreak.ts`, `justify.ts` | Line breaking (dynamic programming); stretching a system to the line |
| `src/engrave/staffgap.ts`, `finalize.ts`, `signatures.ts`, `paginate.ts` | Staff distances, staff furniture (clefs, key/time signatures, barlines, braces), pagination |
| `src/engrave/system.ts` | `engrave`: runs the whole pipeline |
| `src/render.ts` | Scene → SVG (glyphs are embedded as paths, so the SVG is self-contained apart from text) |
| `src/editor/` | Editing without a UI: Immer-based commands (`commands.ts`, `voice.ts`), addresses, musical context, hit testing and snapping (`hit.ts`) |
| `ui/` | The browser editor (Vite + Preact + CodeMirror) |
| `tools/crop.py` | Dev helper: render a region of a page SVG to PNG |

Pipeline: parse → `prepare` → `spaceMeasure` per measure → `planSystems` → justify → draw notes → spanners/marks →
finalize systems → paginate → SVG.

## Known limits

Single-staff-per-voice only (no cross-staff beams), no grace notes, lyrics, repeats/voltas, fermatas, trills,
chord symbols, or multi-measure rests yet. See the end of FEATURES.md. Text in titles uses system fonts via `font-family`
(Liberation Serif / Noto Serif CJK), the music itself does not.
