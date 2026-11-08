# Roadmap

Planned features, in the suggested order. Each item names the layers it touches (model, text format, MusicXML import, engraver, editor, playback); every feature has to go through all of them, with `FORMAT.md` updated and a round-trip test in `test/roundtrip.test.ts`.

Done so far: grace notes (engraving, import, playback, Properties editing), fermatas, trills with upper-note accidental, multi-measure rests, repeats and voltas, lyrics.

## 1. Multi-measure rests (done)
Engraving only, switched on with `multirests=on` (Score tab: "Multi-rests"; a MusicXML `<multiple-rest>` turns it on at import). Open follow-ups:
- A minimum run length setting (now two) and a bar style with a wide H-bar or church-rest symbols for long runs.
- Selecting a swallowed measure in the editor: clicking the bar selects the first measure of the run; the others have no width on the page.
- Marks inside a run (rehearsal marks, tempo changes) end the run for now; a rehearsal mark could sit over the bar.

## 2. Repeats and voltas (done, except the items below)
Repeat signs (`Measure.repeatStart`, `barline=repeat-end`) and voltas (`Measure.ending`) are in the model, text format, MusicXML importer, engraver (`drawRepeatBar` in `finalize.ts`, `volta.ts`) and editor.
- **Open:** repeat counts (`x3`), segno, coda and D.C./D.S. text jumps; `dashed`/`heavy-light` MusicXML barline styles; a start repeat at a system start is drawn after the clef and signatures, not before them.
- **Playback (decided against for now):** repeats and voltas are ignored, the piece plays once front to back. An unrolled play order with a tick map back to the score would be the way, if it is ever needed.

## 3. Lyrics (done, except the items below)
`NoteEvent.lyrics` (`Syllable`: verse, text, syllabic, extend) in the model, text format (`"Ly-"v2"Wor-"_` after the note), MusicXML importer, engraver (`engrave/lyrics.ts`, `separateLyrics` in `spacing.ts`, widths from `textmetrics.ts`) and editor (`setSyllable`, the Lyric box in Properties). Hyphens stay clear of barlines.
- **Open:** a lyric tool on the score (click a syllable, drag); verse numbers before the first syllable; hyphens and extenders across a system break (only a short stub is drawn now); lyrics under cross-staff notes and with several voices on a staff; playback none.
- **Placement:** lyrics are drawn before the other marks, so a dynamic "below" a lyric staff lands under the lyrics (`^` puts it above); a setting for the order of lyrics and dynamics would help vocal scores.
- **Entry:** chord notes take one syllable for the whole chord; a "select similar" kind for lyrics; skipping a tied note is automatic, a manual override is not possible.

## Smaller follow-ups
- **Grace notes in the editor:** click to select or drag a grace head (hit targets via the existing `r`/`n` tags), a palette tool to place one on the staff, chord graces.
- **Trills:** (key-aware upper note in playback is done; accidentals earlier in the measure are not considered), trill lines (`\trill`/`\trilloff`, MusicXML `<wavy-line>`, palette tool, `addTrillLines` in `marks.ts`) are done; open: an accidental over a trill line, a note's own `+tr` inside a line is drawn twice. Mordent and turn are done (`NoteEvent.ornament`, `+mo`/`+mi`/`+tu`/`+ti`, kind `ornament`, Properties "Ornament" row, playback in `addOrnament`); other ornaments (schleifer, tremblement, ...) would follow the same pattern.
- **Fermata:** shapes (short/triangle, long/square) and placement below are done (`fermataShape`, `fermataBelow`; `+fms`, `+fml`, `_`; Properties "Fermata" row; playback holds 1.5x/2x/3x). Open: fermata on barlines, the other MusicXML shapes (double-angled, double-square, half-curve ...).
- **Playback:** dynamics are done (`velAt`; `sf`/`fp` are not shaped within a note); no built-in synth (decided against), repeat/fermata aware tempo handling.
- **Editor:** MIDI keyboard input is open. Done: range selection of measures (Shift-click a run, Ctrl-click adds; the Measure tab edits the run, Ctrl+C/V copies and pastes it, "Select notes" turns it into the events; `copyMeasures`, `pasteMeasures`, `setKeySigRange`, `setTimeSigRange`), and copy and paste of marks and graces (`copyEvents`/`pasteEvents` with a `Clip`, `copyMarks`/`pasteMarks`; graces ride along with their note, there is no grace-only copy).
- **Shortcuts and select similar (done):** `F` toggles a fermata, `Shift+T` a trill; Properties has "All fermatas/trills/graces" buttons (`similarTo(..., by)`). Graces have no key yet.

## Gaps in the finished features
- No round-trip test of the reference piece covers repeats, voltas or lyrics (they have their own tests in `test/repeats.test.ts` and `test/lyrics.test.ts`), and `test/incremental.test.ts` does not generate edits on them: voltas and lyrics are drawn with the marks, which are always redrawn, so they should be safe, but nothing checks it.
- A volta bracket across a system break and a repeat start inside a multi-measure rest run are untested.

## Per-feature checklist
1. Model field and `validate`.
2. Text writer and parser (lossless), `FORMAT.md`.
3. MusicXML importer; regenerate `examples/gewitter.txt` if its output changes.
4. Engraver: tag prims (`tagFrom`), skyline, collision `ALLOW` pairs, `measureSignature` if records change.
5. Editor: commands in `commands.ts`, hit testing, Properties, shortcuts.
6. Playback if it affects sound or time.
7. Tests (round trip, engraving prims, collisions, editor, incremental) and docs.
