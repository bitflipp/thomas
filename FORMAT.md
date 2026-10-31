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
page 210.1x296.9 margin=10 space=1.91         # mm: width x height, margin, staff space
staff rh clef=F4 name="Piano"                 # clef: G2, F4, C3, G2_8 (8 below), G2^8 (8 above)
staff lh clef=F4
brace rh lh                                   # or: bracket a b c

m1 time=2/4 key=0                             # key = number of sharps (+) / flats (-)
  rh.1: 12:4(bracket,above,label=6){ \tempo 4=115 \p \trem2 g#3:4. \tremend a3:4. }
  lh.1: \ped ( d3:2~
m2
  rh.1: ...
m5 break=system barline=final                 # break=system|page (before this measure)
```

Header attributes of a measure: `time=B/T`, `key=N`, `break=system|page`, `barline=single|double|final`.
Lines indented by two spaces belong to the preceding measure: `<staff>.<voice>: <items>`.
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
| Tie | `~` after a note, or after the chord (all notes), or after a pitch inside a chord | `c4:2~ c4:4` `<c4~ e4>` |
| Slur | `(` before the first note, `)` after the last. Optional number (overlap) and side `^` `_` | `( c5:8 d5 e5 )` `(2^ ... )2` |
| Articulation | `->` accent, `-^` marcato, `-.` staccato (after the note) | `c5:8->` |
| Accidental override | `!` force, `?` cautionary (after the pitch) | `c#4!` `e4?` |
| Arpeggio | `\arp` before a chord | `\arp <c3 g3 e4>:8` |
| Two-note tremolo | `\tremN` on the first, `\tremend` on the second note | `\trem2 c4:4 \tremend e4:4` |
| Stem override | `\stemup`, `\stemdown` (else automatic) | `\stemdown c5:4` |

Pitches are written with sounding octave. Under an octave shift (`\8va`/`\8vb`) the engraver writes them an octave away;
you never write the shifted pitch yourself.

## Groups

| Element | Syntax | Meaning |
|---|---|---|
| Tuplet | `A:N{ ... }` — A notes in the time of N; durations inside are the *written* values | `3:2{ c5:8 d5 e5 }` |
| Tuplet options | `A:N(opts){ }` with `bracket`, `nobracket`, `nonum`, `above`, `below`, `label=K` | `6:4(nobracket,below){ ... }` |
| Beam group | `[ ... ]` forces exactly these events into one beam. A group with one note means "unbeamed" | `[ c5:16 d5 e5 f5 ]` |

Without explicit `[ ]`, eighth notes and shorter are beamed automatically per beat (and not across tuplet boundaries or rests).
Tuplet brackets are omitted automatically when one beam covers the whole group.

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
the writer emits them on a separate mark line:

```
  rh@: @1/4 \< @3/4 \!        # positions in quarter notes: 1/4 = a 16th into the measure
```

## Layout directives

Breaks (`break=system|page`) are optional constraints. Without them the engraver chooses line and page breaks itself
(the importer drops MuseScore's automatic breaks unless `--keep-breaks` is given).
Everything else, such as x/y positions, stem directions, beam slopes, slur shapes, accidentals,
is computed. Overrides exist only where a human decision is needed (`\stemup`, `!`/`?`, slur side, tuplet placement).
