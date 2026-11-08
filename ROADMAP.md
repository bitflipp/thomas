# Roadmap

Planned features, in the suggested order. Each item names the layers it touches (model, text format, MusicXML import, engraver, editor, playback); every feature has to go through all of them, with `FORMAT.md` and `FEATURES.md` updated and a round-trip test in `test/roundtrip.test.ts`.

Done so far: grace notes (engraving, import, playback, Properties editing), fermatas, trills with upper-note accidental.

## 1. Multi-measure rests (done)
Engraving only, switched on with `multirests=on` (Score tab: "Multi-rests"; a MusicXML `<multiple-rest>` turns it on at import). Open follow-ups:
- A minimum run length setting (now two) and a bar style with a wide H-bar or church-rest symbols for long runs.
- Selecting a swallowed measure in the editor: clicking the bar selects the first measure of the run; the others have no width on the page.
- Marks inside a run (rehearsal marks, tempo changes) end the run for now; a rehearsal mark could sit over the bar.

## 2. Repeats and voltas (done, except the items below)
Repeat signs (`Measure.repeatStart`, `barline=repeat-end`) and voltas (`Measure.ending`) are in the model, text format, MusicXML importer, engraver (`drawRepeatBar` in `finalize.ts`, `volta.ts`) and editor.
- **Open:** repeat counts (`x3`), segno, coda and D.C./D.S. text jumps; `dashed`/`heavy-light` MusicXML barline styles; a start repeat at a system start is drawn after the clef and signatures, not before them.
- **Playback (decided against for now):** repeats and voltas are ignored, the piece plays once front to back. An unrolled play order with a tick map back to the score would be the way, if it is ever needed.

## 3. Chord symbols
- **Model:** `Mark` variant `{ type: 'chord', root, alter, quality, extensions, bass? }`, stored structurally (not as a string) so it can be transposed, with a free-text fallback for unparsed symbols.
- **Text format:** `\chord Cmaj7/E`, parsed by a small chord-name grammar; the writer prints the canonical spelling.
- **MusicXML:** `<harmony>` (root, kind, bass, degrees) as a timed mark via `anchorMarks`.
- **Engraver:** a text item in `marks.ts` placed above the staff and kept clear by the skyline, with the usual accidentals (`♯ ♭`) and superscript extensions; spacing may need a minimum column width so neighbouring symbols do not collide.
- **Editor:** a palette tool and a Properties section (root, accidental, quality, bass); transposition commands move chord symbols along with the notes.
- **Playback:** none at first; optional later (play the chord on a separate channel).

## 4. Lyrics
The largest item: it affects horizontal spacing.
- **Model:** `NoteEvent.lyrics?: Syllable[]` per verse (`text`, `syllabic: single | begin | middle | end`, `extend?: boolean` for melismas).
- **Text format:** an attached token after the note (for example `c5:4"Ly-"`) or a separate lyric line per voice, aligned by note; decide in a design pass.
- **MusicXML:** `<lyric>` with `<syllabic>`, `<text>`, `<extend>`, verse numbers.
- **Engraver:** a syllable row under the staff per verse, centred on the head; spacing must widen a column when a syllable is wider than the note's natural space (a new collision constraint in `spaceMeasure`, run twice per measure, so it must stay idempotent). Hyphens between syllables and extender lines for melismas as new spanners; skyline interaction with dynamics below the staff.
- **Editor:** a lyric entry mode: select a note and type, Space and `-` advance to the next note; Properties shows the verse list.
- **Playback:** none.

## Smaller follow-ups
- **Grace notes in the editor:** click to select or drag a grace head (hit targets via the existing `r`/`n` tags), a palette tool to place one on the staff, chord graces.
- **Trills:** key-aware upper note (use the key signature and `alterIn` instead of a whole tone), a wavy line for long trills across several notes, a trill-start/stop mark. Mordent, turn and other ornaments follow the same pattern as `trill`.
- **Fermata:** a stronger or shorter variant (square, triangle), fermata on barlines, placement below the staff.
- **Playback:** dynamics (currently constant velocity per the notes in CLAUDE.md; check `velAt` first), a built-in synth, repeat/fermata aware tempo handling.
- **Editor:** MIDI keyboard input, range selection of measures, copy and paste of marks and graces.
- **Text format:** keyboard shortcuts for the new elements, and a "select similar" kind for graces, trills and fermatas.

## Per-feature checklist
1. Model field and `validate`.
2. Text writer and parser (lossless), `FORMAT.md`.
3. MusicXML importer; regenerate `examples/gewitter.txt` if its output changes.
4. Engraver: tag prims (`tagFrom`), skyline, collision `ALLOW` pairs, `measureSignature` if records change.
5. Editor: commands in `commands.ts`, hit testing, Properties, shortcuts.
6. Playback if it affects sound or time.
7. Tests (round trip, engraving prims, collisions, editor, incremental) and docs.
