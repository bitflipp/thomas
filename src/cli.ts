// Command line: `thomas <import|render|check> ...` (see USAGE below). A thin wrapper: parsing, engraving
// and drawing all live in the modules imported here; this file only reads and writes files and
// shells out to rsvg-convert for PDF output.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { describe, findCollisions } from './engrave/collide.ts';
import { engrave } from './engrave/system.ts';
import type { Score } from './model.ts';
import { validate } from './model.ts';
import { importMusicXml } from './musicxml.ts';
import { pageToSvg } from './render.ts';
import { parseText, writeText } from './textformat.ts';
import { must } from './util.ts';

/** Reads a score from a text-format, MusicXML or JSON file, chosen by the file extension. */
function loadScore(path: string, flags = new Set<string>()): Score {
  const src = readFileSync(path, 'utf8');
  const warn = (m: string) => console.error('warn:', m);
  const score = /\.(musicxml|xml)$/i.test(path)
    ? importMusicXml(src, { warn, keepBreaks: flags.has('--keep-breaks'), keepStems: flags.has('--keep-stems') })
    : path.endsWith('.json')
      ? (JSON.parse(src) as Score)
      : parseText(src);
  const errs = validate(score);
  if (errs.length) {
    for (const e of errs.slice(0, 10)) console.error('invalid:', e);
    throw new Error(`${errs.length} validation problems`);
  }
  return score;
}

const USAGE = `usage:
  thomas import  <in.musicxml> <out.txt> [--keep-breaks] [--keep-stems]
                                                  convert MusicXML to the text format
  thomas render  <in.txt|in.musicxml> <out-base> [--pdf] [--no-breaks] [--numbers|--no-numbers] [--space <mm>]
                                                  write <out-base>-<page>.svg (and <out-base>.pdf)
  thomas check   <in.txt|in.musicxml> [--collisions [--mark <out-base>]]
                                                  validate; with --collisions also engrave and list overlapping
                                                  elements (see src/engrave/collide.ts); --mark writes <out-base>-<page>.svg
                                                  with every collision boxed in red
  --space <mm> (render, check) overrides the staff space, the global engraving scale (default: the file's page line)`;

const [cmd, ...rawArgs] = process.argv.slice(2);

// `--space <mm>` / `--space=<mm>` overrides the staff space, the global engraving scale of the score's
// page setup. It applies to every command that engraves, so it is pulled out before the commands
// look at their positional arguments and flags.
let spaceOverride: number | undefined;

const args: string[] = [];

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === '--space' || a.startsWith('--space=')) {
    const v = Number(a.includes('=') ? a.slice(8) : rawArgs[++i]);
    if (!(v > 0.5 && v < 10)) {
      console.error('--space expects a staff space in mm, e.g. 1.75');
      process.exit(1);
    }
    spaceOverride = v;
  } else args.push(a);
}

/** Applies the `--space` override (staff-space size in mm) to the score's page, if one was given. */
const withSpace = (s: Score): Score => {
  if (spaceOverride) s.page.staffSpace = spaceOverride;
  return s;
};

try {
  if (cmd === 'import') {
    const flags = new Set(args.filter((a) => a.startsWith('--')));
    const [inp, out] = args.filter((a) => !a.startsWith('--'));
    writeFileSync(out, writeText(loadScore(inp, flags)));
  } else if (cmd === 'check') {
    const s = withSpace(loadScore(must(args.find((a) => !a.startsWith('--')))));
    console.log(`ok: ${s.measures.length} measures, ${s.staves.length} staves`);
    if (args.includes('--collisions')) {
      const res = engrave(s, { respectBreaks: true, measureNumbers: s.page.measureNumbers ?? 'system' });
      const cs = findCollisions(res.pages);
      for (const c of cs) console.log(describe(c));
      console.log(`${cs.length} collision${cs.length === 1 ? '' : 's'}`);
      const mi = args.indexOf('--mark');
      if (mi >= 0) {
        const base = args[mi + 1];
        mkdirSync(dirname(base) || '.', { recursive: true });
        res.pages.forEach((p, i) => {
          const boxes = cs
            .filter((c) => c.page === i + 1)
            .map(
              (c) =>
                `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="none" stroke="red" stroke-width="0.12"/>`,
            )
            .join('');
          writeFileSync(`${base}-${i + 1}.svg`, pageToSvg(p, res.staffSpace).replace('</svg>', `${boxes}</svg>`));
        });
      }
      if (cs.length) process.exitCode = 1;
    }
  } else if (cmd === 'render') {
    const flags = new Set(args.filter((a) => a.startsWith('--')));
    const [inp, base] = args.filter((a) => !a.startsWith('--'));
    const score = withSpace(loadScore(inp, flags));
    const res = engrave(score, {
      respectBreaks: !flags.has('--no-breaks'),
      measureNumbers: flags.has('--no-numbers')
        ? 'none'
        : flags.has('--numbers')
          ? 'all'
          : (score.page.measureNumbers ?? 'system'),
      warn: (m) => console.error('warn:', m),
    });
    mkdirSync(dirname(base) || '.', { recursive: true });
    const files = res.pages.map((p, i) => {
      const f = `${base}-${i + 1}.svg`;
      writeFileSync(f, pageToSvg(p, res.staffSpace));
      return f;
    });
    console.error(`${res.systems} systems on ${res.pages.length} pages`);
    if (flags.has('--pdf')) {
      execFileSync('rsvg-convert', ['-f', 'pdf', '-o', `${base}.pdf`, ...files]);
      console.error(`wrote ${basename(base)}.pdf`);
    }
  } else console.error(USAGE);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
