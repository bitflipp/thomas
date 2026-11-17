# Thomas

A music notation typesetter and editor. Scores are written in a plain-text format (or imported from MusicXML),
engraved to SVG/PDF with the Leland music font, and edited in a browser or desktop (Electron) UI with playback
over Web MIDI.

- Text format: lossless, line-oriented, diff-friendly. See [FORMAT.md](FORMAT.md).
- Engraver: spacing, line breaking, beams, slurs, ties, lyrics, grace notes, ornaments, repeats and more.
- Editor: note input, selection and Properties panel, undo, MIDI keyboard entry, parallel fifths/octaves check.
- Plans and open items: [ROADMAP.md](ROADMAP.md). Architecture notes: [CLAUDE.md](CLAUDE.md).

## Requirements

- Node.js 22.18 or newer (TypeScript runs directly through type stripping, there is no build step for the CLI).
- `rsvg-convert` (librsvg) for PDF output and for regenerating the icon.

## Setup

```
npm install
npm test
```

## Command line

```
node src/cli.ts render test/fixtures/study.txt out/study --pdf     # out/study-N.svg and out/study.pdf
node src/cli.ts import piece.musicxml out/piece.txt                # MusicXML to the text format
node src/cli.ts check test/fixtures/study.txt --collisions --parallels
```

Run `node src/cli.ts` without arguments for all options.

## Editor

```
npm run ui          # Vite dev server
npm run ui:build    # static build in out/ui, servable by any static server
npm run app         # build and start the Electron desktop app
```

## Development

```
npm run lint        # Biome, blank-line check and tsc --noEmit
npm run lint:fix
npm test
```

## License

The code is released under the [MIT License](LICENSE). The bundled Leland font is by MuseScore BVBA under the
SIL Open Font License 1.1 ([fonts/leland/LICENSE.txt](fonts/leland/LICENSE.txt)).
