# Feature inventory: `gewitter.musicxml`

Source: MusicXML 4.0 partwise, exported by MuseScore Studio 4.7.6.
The numbers are occurrence counts in the file, so they show how much each feature matters.

## 1. Overview

| Item | Value |
|---|---|
| Work | "Gewitter", Philipp Naumann (2026), dedicated to 임윤찬 (Korean text, so Unicode and CJK glyph fallback are needed) |
| Parts | 1 (Piano), 2 staves (grand staff), 120 measures |
| Meter / key | 2/4 throughout, C major / no key signature, no meter or key changes |
| Tempo | ♩ = 115 (a single metronome mark) |
| Layout | 7 pages, 24 systems, manual page and system breaks, page 1100×1555 tenths |
| Divisions | 120 per quarter (the finest value is a 32nd = 15) |

## 2. Features to support

### 2.1 Score and page level
- **Metadata:** title, subtitle (dedication), composer (right-aligned), rights or copyright line.
- **Credits:** the title block appears on page 1 only. The copyright footer is repeated on every page, centred, 9 pt.
- **Page numbers:** `page-number` is carried on each `print new-page`.
- **Page geometry:** page size, margins (even and odd pages), and scaling (7.64 mm = 40 tenths, so staff space = 1.91 mm).
- **Manual breaks:** 6 forced page breaks and 24 forced system breaks. The typesetter should also have its own automatic line and page breaking, with the manual breaks acting as overrides.
- **System layout:** system margins, system distance and top-system distance. Staff distance within a system (31×) is fixed by the file.
- **Appearance defaults:** line widths for staff, stem, beam, barlines, ledger, slur and tie (tip and middle), pedal, octave-shift, wedge and tuplet bracket. Also grace and cue note scale, though no grace or cue notes are used.
- **Fonts:** music font (Leland, an SMuFL font), text font (Edwin). Support SMuFL fonts and metadata for glyph anchors and engraving defaults.
- **Part name:** present but hidden (`print-object="no"`). Name and abbreviation visibility are options.

### 2.2 Staves, clefs, barlines
- Grand staff (2 staves, one part). The file has no explicit brace, but a brace and connected barlines are the usual rendering.
- **Clefs:** G2 and F4. Both staves *start* in F, and there are 26 further clef changes (G↔F), about half of them in the middle of a measure (small clefs) and half at measure starts. The typesetter must handle both, plus the courtesy clef at the start of a new system.
- **Barlines:** regular single barlines and a final light-heavy barline.
- **Measure numbers:** the file numbers its measures, but does not say whether to print them. Make it an option.
- **Whole-measure rests:** 16 measures use `<rest measure="yes"/>`. They are centred in the measure and shown as a whole rest.
- **Transposing:** none.

### 2.3 Notes and rhythm
- **Pitch:** step, octave (0 to 7 used, with ledger lines up to several lines), and alterations. Both the sounding pitch and the spelling are kept.
- **Accidentals:** sharp (202), flat (266), natural (37), double-flat (15), double-sharp (9), and 3 cautionary accidentals (parenthesised or not). Accidental logic is needed:
  - per-measure carry-over
  - cancellation by naturals
  - octave independence
  - chord stacking, so accidentals in a chord are laid out in columns to avoid collisions.
- **Durations:** 32nd (156), 16th (901), eighth (127), quarter (175), half (99). Measure rests at whole-measure length.
- **Dots:** 100, all single dots.
- **Chords:** 108 additional chord tones, so chords of 2 or more notes. Seconds in a chord need displaced note heads.
- **Rests:** 53 (36 plain, 1 with display position, 16 whole-measure). Rests in multi-voice textures need vertical offsets so they do not collide.
- **Stems:** explicit direction, up (761) and down (660). The typesetter can choose by default, but must honour overrides.
- **Ties:** 36 pairs, including some across barlines. Some have a forced orientation (over).
- **Voices:** up to **4 voices over 2 staves** (voices 1 and 2 on staff 1, voices 5 and 6 on staff 2 in MuseScore numbering).
  - Voices need independent rhythms, collision-avoidance (rests, note heads and stems) and, in the source, `backup` and `forward` (8) are used for positioning.
  - The human-readable model should use voices local to each staff instead of cursor-moving primitives.

### 2.4 Beaming and tuplets
- **Beams:** up to 3 beam levels (8th, 16th, 32nd), with forward and backward hooks (9 total). Beaming must follow the metre, and explicit group overrides must be possible.
- **Tuplets**, 489 notes in total, with many combinations:
  | actual:normal | notes | type |
  |---|---|---|
  | 6:4 | 298 | sextuplets of 16ths |
  | 12:4 | 90 | 12 in the time of 4 sixteenths, with dotted quarters in them |
  | 5:4 | 35 | quintuplets |
  | 3:2 | 30 | triplets |
  | 2:1 | 36 | duplets |
  - Features: bracket yes or no (4 yes, 101 no), number shown or hidden (35 hidden), placement above or below.
  - **Beams carry tuplets:** a bracket is often omitted when a beam covers the group.
  - Tuplets can span a beamed group together with ties and slurs.
- **Tremolos:** 63 *two-note* (fingered) tremolos with 2 beams, as `trem2{ }` groups. These are drawn as beams between the two notes, with the stems joined.
  - They frequently occur inside tuplets.

### 2.5 Articulation, expression, ornaments
- **Articulations:** accent (23), strong accent / marcato (6), staccato (3).
- **Slurs:** 83 pairs, numbers 1 and 2 (so they can overlap or nest), orientation over/under and placement above/below are sometimes forced. Slurs cross barlines and, possibly, systems. This needs split slurs at line breaks. Bezier hints are exported but will be recomputed.
- **Arpeggio:** 33, as a vertical wavy line before a chord. All of them are on the lower staff (staff 2), so no cross-staff arpeggio is needed yet.
- **Dynamics:** p (4), mp (1), f (6), ff (1). Placement is above or below. The export also gives MIDI velocity, which can be ignored for typesetting.
- **Hairpins:** 16 crescendo and 13 diminuendo wedges, with spread. They are numbered (1 and 2) to allow overlap. Hairpins can cross barlines, and could be split across systems.
- **Pedal:** 81 start and stop pairs, with a line and the "Ped." sign (`sign="yes" line="yes"`) and release marks. Pedal changes appear as adjacent stops and starts.
- **Octave shifts:** 9 pairs, 8va (7, `down`) and 8vb (2, `up`) with a dashed line and a closing hook. Notes under the shift are written an octave away from the sounding pitch.
- **Tempo marking:** metronome mark ♩ = 115 above the first system.
- **Not used (but plan the architecture to allow them later):** words and expression text, rehearsal marks, repeats and voltas, mordents and turns, lyrics, chord symbols, fingering, key or time changes, cue notes.

## 3. Cross-cutting layout requirements

These are the things that decide the quality of the result.

1. **Horizontal spacing:** proportional to duration with minimum widths, aligned across both staves and all voices. Needs to cope with tuplets in one voice against straight 16ths in another.
2. **Justification:** stretch systems to the full width (except the last), with consistent staff spacing.
3. **Line and page breaking:** optimal (Knuth-Plass style) breaking, with forced breaks as constraints.
4. **Vertical collision handling:** dynamics, hairpins, pedal lines, tempo and octave lines placed outside the staff and stacked without overlap. Pedal and dynamics stay below the lower staff or between the staves.
5. **Stem, beam and slur geometry:** beam slope rules, beams across staves are not used here, and slur curvature that avoids notes.
6. **Ledger lines and octave shifts:** many notes are far above or below the staves (octaves 0 and 1 and 7).
7. **Output:** SVG and PDF. Page-sized, vector, with an SMuFL font embedded.

## 4. Representation, architecture, decisions

- The implemented text format is specified in [FORMAT.md](FORMAT.md) (the draft that stood here was replaced by it).
- Architecture and commands are in [CLAUDE.md](CLAUDE.md).
- Decisions taken: TypeScript on Node (no build step), SVG and PDF output, general-purpose (not tied to this piece),
  all positions recomputed (`default-x`/`default-y` are dropped), voice numbers normalised per staff,
  MuseScore's automatic system/page breaks are dropped on import (`--keep-breaks` keeps them) and so are its explicit stem directions (`--keep-stems` keeps them).

## 5. Status of the features in section 2

All features listed in section 2 are implemented and rendered for `gewitter.musicxml`, except:

- Courtesy clefs at the end of a system before a clef change on the next system (not drawn).
- Mid-piece key signature changes: the signature is drawn at system starts, but not as a change mid-system.
- Whole-measure rests are drawn as a whole rest; with `multirests=on` runs of two or more empty measures are drawn as one multi-measure rest.
- Ledger lines for rests displaced far outside the staff.
- **Cross-staff notes** (`examples/tango.txt`): notes of one voice written on the other staff of the piano, usually arpeggio figures whose beam runs between the staves. Imported as `\staff <id>` switches within the voice.
