<p align="center"><img src="icon.svg" alt="Thomas icon" width="128" height="128"></p>

# Thomas

A music notation typesetter and editor that engraves scores to SVG and PDF, with a browser and desktop editor.

Scores are plain text (or imported from MusicXML) and are engraved with the Leland music font. The text format is lossless and line-oriented, so diffs stay readable, and the editor works on the same model: what you click and what you type end up in the same score.

## Features

- **Plain-text format**: one measure per block, lossless (`write(parse(text)) == text`); the grammar is in [FORMAT.md](FORMAT.md)
- **MusicXML import**: tuplets, beams, grace notes, lyrics, repeats and ornaments are rebuilt into the model
- **Engraver**: spacing, line and page breaking, beams, ties, slurs, tuplets, cross-staff notes, multi-measure rests, repeats and voltas, lyrics, grace notes, fermatas, trills and ornaments, with collision checking
- **Editor**: note and rest input, selection and marquee, drag to change pitch, a Properties panel, undo/redo, copy and paste of notes and measures, and the score as editable text next to the engraving
- **Overview strip**: one bar per measure with landmarks, the visible part of the score, and a hover preview of any system
- **Playback and MIDI input**: plays over Web MIDI with dynamics, hairpins and pedal; notes can be entered from a MIDI keyboard
- **Parallels check**: consecutive fifths and octaves are marked in the score, with a stepper to jump between them
- **Output**: SVG per page, PDF through `rsvg-convert`, or print from the editor
- **Desktop app**: the same editor in an Electron window with native file dialogs

## Usage

### Command line

```
npm install
node src/cli.ts render test/fixtures/study.txt out/study --pdf     # out/study-N.svg and out/study.pdf
node src/cli.ts import piece.musicxml out/piece.txt                # MusicXML to the text format
node src/cli.ts check test/fixtures/study.txt --collisions --parallels
```

Run `node src/cli.ts` without arguments for all options.

### Editor in the browser

```
npm run ui                          # Vite dev server
npm run ui:build                    # static build in out/ui
python3 -m http.server -d out/ui    # serve it with any static server
```

### Desktop app (Electron)

```
npm run app           # or: just run-electron
just install-desktop
```

`just install-desktop` installs a `thomas.desktop` launcher and the icon under `~/.local/share`, pointing at this checkout, so Thomas shows up in your application launcher.

### Shortcuts

Press `?` in the editor for the full list.

| Key | Action |
|---|---|
| `1`-`8` | Note duration |
| `T` / `S` | Tie / slur the selection |
| `F` / `Shift+T` | Toggle fermata / trill |
| `X` | Flip stem or tie |
| `Q` / `W` | Previous / next voice |
| `Up` / `Down` | Transpose by a semitone (`Ctrl`: an octave, `Shift`: a staff step) |
| `Left` / `Right` | Select the previous / next note |
| `Space` / `Home` | Play or pause / rewind |
| `F8` / `Shift+F8` | Next / previous parallels finding |
| `Ctrl+Z`, `Ctrl+Shift+Z` | Undo / redo |
| `Ctrl+E` / `Ctrl+I` | Show or hide the text / Properties panel |
| `Ctrl+G` | Go to measure |
| `Ctrl` `+` / `-` | Zoom in / out |
| `Esc` | Cancel / deselect |

## Requirements

- Node.js 22.18 or newer (TypeScript runs directly through type stripping, there is no build step for the CLI)
- `rsvg-convert` (librsvg) for PDF output and for regenerating the icon
- A modern browser for the editor, or `npm install` for the Electron desktop app (plus [just](https://just.systems) for the recipes)

## Development

```
npm run lint        # Biome, blank-line check and tsc --noEmit
npm run lint:fix
npm test
```

Architecture notes are in [CLAUDE.md](CLAUDE.md), planned work in [ROADMAP.md](ROADMAP.md).

## AI assistance

Parts of this project were written with AI assistance. The model involved:

- Claude

## License

MIT. The bundled Leland font is by MuseScore BVBA under the SIL Open Font License 1.1 ([fonts/leland/LICENSE.txt](fonts/leland/LICENSE.txt)).
