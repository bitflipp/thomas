# Text format

A score is a plain UTF-8 text file. It is line oriented, one measure per block, so that diffs are readable
and a GUI can address one *measure × staff × voice* as one cell. The internal model (`src/model.ts`,
JSON-serialisable) is the source of truth. The text format is a lossless serialisation of it
(`thomas import` followed by `thomas render` gives the same result as rendering the MusicXML directly,
and `write(parse(text))` equals `text`).

```
# comment
title    "Gewitter"
subtitle "임윤찬 gewidmet"
composer "Philipp Naumann (2026)"
rights   "© Philipp Naumann, licensed under CC BY-SA 4.0"
page 210.1x296.9 margin=10 space=1.91         # mm: width x height, margin, staff space (= the global scale); optional numbers=all|none (measure numbers; default: per system)
staff rh clef=F4 name="Piano"                 # clef: G2, F4, C3, G2_8 (8 below), G2^8 (8 above)
staff lh clef=F4
brace rh lh                                   # or: bracket a b c

m1 time=2/4 key=0                             # key = number of sharps (+) / flats (-)
  rh.1: 12:4(bracket,above,label=6){ trem2{ \tempo 4=115 \p g#3:4. a3:4. } }
  lh.1: \ped ( d3:2~
m2
  rh.1: ...
m5 break=system barline=final                 # break=system|page (before this measure)
```

`space` is the global engraving scale (MuseScore calls it "page size"): everything is laid out in staff spaces, so changing it
rescales the music and re-flows measures, systems and pages, while the page size, margins and the point sizes of title and footer
stay fixed. `thomas render --space <mm>` overrides it without editing the file.

Header attributes of a measure: `time=B/T`, `key=N`, `break=system|page`, `barline=single|double|final`.
The number in `m<N>` is only a label (the measure's number is its position). Lines indented by two spaces belong to the preceding measure: `<staff>.<voice>: <items>`.
Voice numbers are local to a staff (`rh.1`, `rh.2`, `lh.1`, ...). Every voice of a measure must fill the measure exactly
(use `s` spacers to skip time). `thomas check` validates this.

## Events

| Element | Syntax | Example |
|---|---|---|
| Pitch | step, accidentals, octave (`c4` = middle C). `#` sharp, `b` flat, repeatable | `g#3` `eb5` `f##2` `bbb4` (b double-flat) |
| Duration | `:` + base (1 2 4 8 16 32 64) + dots. The base is *sticky* within a line, dots are not | `c4:8. d4 e4:4` |
| Rest | `r` (visible), `s` (invisible spacer), `R` (whole-measure rest) | `r:8` `s:4` `R:2` |
| Displaced rest | `r@<pitch>` | `r@b4:4` |
| Chord | `<pitches>` then duration | `<c4 e4 g4>:2` |
| Tie | `~` after the duration of a single note; inside a chord after each tied pitch | `c4:2~ c4:4` `<c4~ e4>:2` |
| Slur | `(` before the first note, `)` after the last. Optional number (overlap) and side `^` `_` | `( c5:8 d5 e5 )` `(2^ ... )2` |
| Articulation | `->` accent, `-^` marcato, `-.` staccato (after the note; a trailing `^` or `_` forces them above/below, e.g. `c5:8-._`) | `c5:8->` |
| Accidental override | `!` force, `?` cautionary (after the pitch) | `c#4!` `e4?` |
| Arpeggio | `\arp` before a chord | `\arp <c3 g3 e4>:8` |
| Grace notes | `\acc{ … }` (slashed) or `\grace{ … }` before a note; each grace note has an explicit value (8, 16, 32 …), no dots, no time in the measure | `\acc{ d5:8 } c5:4`, `\grace{ b4:16 c5:16 } d5:4` |
| No beam | `\nobeam` keeps a note out of the automatic beaming | `\nobeam c5:8 d5` |
| Stem override | `\stemup`, `\stemdown` (else automatic) | `\stemdown c5:4` |
| Cross-staff | `\staff <id>` draws the following events of the voice on that staff, until `\staff <home>` switches back (resets at each line) | `lh.1: [ c3:16 e3 g3 \staff rh c4 e4 g4 ] \staff lh r:8` |

Pitches are written with sounding octave. Under an octave shift (`\8va`/`\8vb`) the engraver writes them an octave away;
you never write the shifted pitch yourself.

## Groups

| Element | Syntax | Meaning |
|---|---|---|
| Tuplet | `A:N{ ... }` — A notes in the time of N; durations inside are the *written* values | `3:2{ c5:8 d5 e5 }` |
| Tuplet options | `A:N(opts){ }` with `bracket`, `nobracket`, `nonum`, `above`, `below`, `label=K` | `6:4(nobracket,below){ ... }` |
| Beam group | `[ ... ]` forces exactly these events (at least two notes) into one beam | `[ c5:16 d5 e5 f5 ]` |
| Two-note tremolo | `tremN{ ... }` around exactly two notes, drawn with `N` beams between them | `trem2{ c4:4 e4:4 }` |

A cross-staff note keeps its voice (timing, slurs, ties' voice, beams, tuplets) but its head, clef, octave shift and accidentals belong to the staff it is drawn on.
A beam whose notes sit on two staves runs flat between them: stems of the upper staff point down, those of the lower staff up, and the gap between the staves grows to fit it.

Without explicit `[ ]`, eighth notes and shorter are beamed automatically per beat (and not across tuplet boundaries or rests);
write a group only where you want something else, and `\nobeam` to opt a note out. Tuplet brackets are omitted automatically when one
beam covers the whole group; `bracket`/`nobracket` override that. The importer writes only what differs from these defaults.

## Marks (before the event they apply to; at the end of a line they apply to the end of the measure)

| Mark | Syntax |
|---|---|
| Dynamics | `\pppp \ppp \pp \p \mp \mf \f \ff \fff \ffff \sf \sfz \fp \rfz ...`; `^`/`_` forces above/below |
| Hairpin | `\<` crescendo, `\>` diminuendo, `\!` end. With a number to overlap: `\<2` ... `\!2`. Optional `^`/`_` |
| Pedal | `\ped` press, `\unped` release (a change is `\unped \ped`) |
| Octave shift | `\8va` (written an octave lower, line above), `\8vb` (line below), `\8off` ends it. May span measures |
| Clef change | `\clef G2`, `\clef F4`, ... (a change at the first note of a system becomes the system's clef) |
| Tempo | `\tempo 4=115`, `\tempo 4.=60` |
| Text | `\text "dolce"`, `^`/`_` for above/below |

Marks are stored per staff with their time position. When no voice has an event boundary at that position
the writer emits them on a separate mark line, which holds nothing but `@position` tokens and marks:

```
  rh@: @1/4 \< @3/4 \!        # positions in quarter notes: 1/4 = a 16th into the measure
```

## Layout directives

Breaks (`break=system|page`) are optional constraints. Without them the engraver chooses line and page breaks itself
(the importer drops MuseScore's automatic breaks unless `--keep-breaks` is given).
Everything else, such as x/y positions, stem directions, beam slopes, slur shapes, accidentals,
is computed. Overrides exist only where a human decision is needed (`\stemup`, `!`/`?`, slur side, tuplet placement).
