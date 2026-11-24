// Command line: `thomas <import|import-rendition|render|check> ...` (see USAGE below). A thin wrapper: parsing, engraving
// and drawing all live in the modules imported here; this file only reads and writes files and
// shells out to rsvg-convert for PDF output.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { findParallels, voicesOf } from './analysis/parallels.ts';
import { describe, findCollisions } from './engrave/collide.ts';
import { engrave } from './engrave/system.ts';
import type { Score } from './model.ts';
import { beatOf, validate } from './model.ts';
import { importMusicXml } from './musicxml.ts';
import { pageToSvg } from './render.ts';
import type { PianizerProject } from './rendition.ts';
import { importRendition } from './rendition.ts';
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
  thomas import-rendition <project.json> <in.txt|in.musicxml> <out.txt> [--tolerance <quarters>] [--force]
                                                  take the rendition of a Pianizer project over into the score: velocities,
                                                  attack shifts and gates of the heads, tempo curve, sustain and una corda.
                                                  Notes are matched by pitch and time (--tolerance, default 0.5); with fewer
                                                  than 80% matched nothing is written unless --force
  thomas render  <in.txt|in.musicxml> <out-base> [--pdf] [--no-breaks] [--numbers|--no-numbers] [--space <mm>]
                                                  write <out-base>-<page>.svg (and <out-base>.pdf)
  thomas check   <in.txt|in.musicxml> [--parallels] [--collisions [--mark <out-base>]]
                                                  --parallels lists consecutive fifths and octaves (src/analysis/parallels.ts)
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
  } else if (cmd === 'import-rendition') {
    const ti = args.indexOf('--tolerance');
    const tolerance = ti >= 0 ? Number(args[ti + 1]) : undefined;
    if (tolerance !== undefined && !(tolerance > 0 && tolerance <= 4))
      throw new Error('--tolerance expects quarter notes, e.g. 0.5');
    const pos = args.filter((a, i) => !(a.startsWith('--') || (ti >= 0 && i === ti + 1)));
    if (pos.length !== 3) throw new Error(USAGE);
    const [projectFile, scoreFile, out] = pos;
    const { score, report: r } = importRendition(
      loadScore(scoreFile),
      JSON.parse(readFileSync(projectFile, 'utf8')) as PianizerProject,
      { tolerance },
    );
    const pct = r.notes ? Math.round((100 * r.matched) / r.notes) : 100;
    console.log(
      `${r.matched} of ${r.notes} notes matched (${pct}%), ${r.heads} heads in the score, ${r.headsWithoutNote} without a note${r.headsCopied ? `, ${r.headsCopied} unison heads copied from the one at the same instant` : ''}`,
    );
    console.log(`velocities: ${r.velocities}, shifts: ${r.shifts}, gates: ${r.gates}`);
    console.log(
      `tempo curve: ${r.tempoPoints} points, sustain: ${r.sustainPoints} points, una corda: ${r.softRegions} regions`,
    );
    if (r.muted) console.log(`${r.muted} muted notes of the project are not muted in the score`);
    for (const u of r.unmatchedNotes) console.log(`  no note in the score for ${u}`);
    if (r.unmatchedCount > r.unmatchedNotes.length)
      console.log(`  ... and ${r.unmatchedCount - r.unmatchedNotes.length} more`);
    if (pct < 80 && !args.includes('--force')) {
      console.error(
        'error: fewer than 80% of the notes matched, so this is probably another piece (nothing written; --force writes anyway)',
      );
      process.exit(1);
    }
    writeFileSync(out, writeText(score));
  } else if (cmd === 'check') {
    const s = withSpace(loadScore(must(args.find((a) => !a.startsWith('--')))));
    console.log(`ok: ${s.measures.length} measures, ${s.staves.length} staves`);
    if (args.includes('--parallels')) {
      const gs = findParallels(s);
      for (const g of gs) {
        const beat = beatOf(g.tick);
        const voices = voicesOf(g);
        const maybe = g.level === 'possible' ? ' (possible)' : '';
        console.log(`${g.number}. m. ${g.mi + 1} beat ${beat}: ${g.kinds.join(' + ')} (${voices})${maybe}`);
      }
      console.log(`${gs.length} group${gs.length === 1 ? '' : 's'} of consecutive fifths or octaves`);
    }
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
