// Checks (and with --fix repairs) the blank lines between top-level items of TypeScript files.
//
// Biome formats everything inside a line but has no rule for blank lines between declarations, so this
// small checker enforces one convention on the top level of every file:
//   1. Two top-level items are separated by exactly one blank line. The exception is a run of one-line
//      declarations without comments of their own (imports, constants, type aliases), which may stand
//      directly one below the other.
//   2. A comment that documents a declaration (`/** ... */`, or a `//` block directly above code) sits
//      right above it, with no blank line in between. A `//` block followed by a blank line is a free-
//      standing section comment and is an item of its own.
//   3. A `/** ... */` comment is always attached to a declaration, never left alone.
//
// Usage: node tools/blanklines.ts [--fix] [file ...]   (default: all tracked .ts and .tsx files)

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

interface LineInfo {
  /** Nesting depth of brackets at the start of the line. */
  depth: number;
  /** True when the line starts inside a block comment or a template literal. */
  inside: boolean;
}

/** Keywords after which a `/` starts a regular expression instead of dividing. */
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else']);

/** Scans the source once and records the depth and the comment/string state at the start of each line. */
function analyze(text: string): LineInfo[] {
  const infos: LineInfo[] = [{ depth: 0, inside: false }];
  let depth = 0;
  // A stack of the contexts we are nested in: a bracket, or the `${` of a template literal.
  const stack: string[] = [];
  let mode: 'code' | 'block' | 'template' = 'code';
  let prev = ''; // The last significant character (or word) in code, to tell a regex from a division.
  let i = 0;
  const newline = () => infos.push({ depth, inside: mode !== 'code' });
  while (i < text.length) {
    const c = text[i];
    if (c === '\n') {
      i++;
      newline();
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && text[i + 1] === '/') {
        mode = 'code';
        i += 2;
      } else i++;
      continue;
    }
    if (mode === 'template') {
      if (c === '\\') i += 2;
      else if (c === '`') {
        mode = 'code';
        prev = '`';
        i++;
      } else if (c === '$' && text[i + 1] === '{') {
        stack.push('${');
        depth++;
        mode = 'code';
        prev = '{';
        i += 2;
      } else i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      mode = 'block';
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
      i++;
      prev = c;
      continue;
    }
    if (c === '`') {
      mode = 'template';
      i++;
      continue;
    }
    if (c === '/' && (prev === '' || '(,=:[!&|?{};'.includes(prev) || REGEX_AFTER_WORD.has(prev))) {
      i++;
      let inClass = false;
      while (i < text.length && text[i] !== '\n' && (inClass || text[i] !== '/')) {
        if (text[i] === '\\') i++;
        else if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        i++;
      }
      i++;
      prev = '/';
      continue;
    }
    if ('([{'.includes(c)) {
      stack.push(c);
      depth++;
    } else if (')]}'.includes(c)) {
      if (c === '}' && stack[stack.length - 1] === '${') {
        stack.pop();
        depth--;
        mode = 'template';
        i++;
        continue;
      }
      stack.pop();
      depth--;
    }
    if (/\w/.test(c)) {
      let j = i;
      while (j < text.length && /[\w$]/.test(text[j])) j++;
      prev = text.slice(i, j);
      i = j;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  while (infos.length < text.split('\n').length) infos.push({ depth, inside: mode !== 'code' });
  return infos;
}

interface Item {
  /** First and last line (0-based, inclusive), including attached comments. */
  from: number;
  to: number;
  /** Does the item start with a comment, and is that a `/**` comment standing alone? */
  commented: boolean;
  /** A `//` block or `/**` comment with no code after it (only separated from the next item by a blank). */
  onlyComment: boolean;
  jsdoc: boolean;
  /** Last line of the leading comment, if the item starts with one. */
  commentTo?: number;
}

interface Problem {
  line: number;
  message: string;
}

/** Splits the file into top-level items and returns the problems found. `fixes` collects blank lines to insert or remove. */
function check(lines: string[]): {
  problems: Problem[];
  insertBefore: Set<number>;
  insertAfter: Set<number>;
  removeBlank: Set<number>;
} {
  const infos = analyze(lines.join('\n'));
  const starts: number[] = [];
  const isComment = (l: string) => /^(\/\/|\/\*)/.test(l);
  for (let n = 0; n < lines.length; n++) {
    const l = lines[n];
    const info = infos[n];
    if (info.inside || l === '' || /^[\s})\]>*]/.test(l)) continue;
    if (/^\*\//.test(l)) continue;
    starts.push(n);
  }
  // Join consecutive comment lines with the line that follows into one item.
  const items: Item[] = [];
  let k = 0;
  while (k < starts.length) {
    const from = starts[k];
    let commentEnd = -1;
    let jsdoc = false;
    let kk = k;
    // A run of comment starts (`//` lines are separate starts) that touch each other forms one comment.
    while (kk < starts.length && isComment(lines[starts[kk]])) {
      if (lines[starts[kk]].startsWith('/**')) jsdoc = true;
      commentEnd = kk;
      kk++;
      // The next start must follow the comment directly (a block comment may span several lines).
      if (kk < starts.length) {
        let last = starts[kk - 1];
        if (lines[last].startsWith('/*') && !lines[last].includes('*/')) {
          while (last < lines.length && !lines[last].includes('*/')) last++;
        }
        if (starts[kk] !== last + 1) break;
      }
    }
    if (commentEnd >= 0) {
      let last = starts[commentEnd];
      if (lines[last].startsWith('/*') && !lines[last].includes('*/')) while (!lines[last].includes('*/')) last++;
      const nextStart = starts[commentEnd + 1];
      if (nextStart !== undefined && nextStart === last + 1 && !isComment(lines[nextStart])) {
        // The comment is attached to the declaration that follows.
        const end = (starts[commentEnd + 2] ?? lines.length) - 1;
        items.push({ from, to: trimEnd(lines, end), commented: true, onlyComment: false, jsdoc, commentTo: last });
        k = commentEnd + 2;
      } else {
        items.push({ from, to: last, commented: true, onlyComment: true, jsdoc });
        k = commentEnd + 1;
      }
      continue;
    }
    const end = (starts[k + 1] ?? lines.length) - 1;
    items.push({ from, to: trimEnd(lines, end), commented: false, onlyComment: false, jsdoc: false });
    k++;
  }
  const problems: Problem[] = [];
  const insertBefore = new Set<number>();
  const removeBlank = new Set<number>();
  const insertAfter = new Set<number>();
  for (let n = 0; n < items.length; n++) {
    const it = items[n];
    if (it.onlyComment && it.jsdoc)
      problems.push({ line: it.from + 1, message: 'A /** comment must sit directly above its declaration' });
    // A comment above the imports is the file's header, which stands apart from the code.
    if (it.commentTo !== undefined && /^import\b/.test(lines[it.commentTo + 1])) {
      problems.push({ line: it.commentTo + 2, message: 'Missing blank line after the file header comment' });
      insertAfter.add(it.commentTo);
    }
    const prev = items[n - 1];
    if (!prev) continue;
    const gap = it.from - prev.to - 1;
    const compact =
      !(it.commented || prev.commented) && prev.to === prev.from && it.to === it.from && !prev.onlyComment;
    if (gap === 0 && !compact) {
      problems.push({ line: it.from + 1, message: 'Missing blank line before this item' });
      insertBefore.add(it.from);
    }
  }
  // Rule 2: no blank line between an attached comment and its declaration is guaranteed by construction;
  // a `/**` comment followed by a blank line was reported above.
  return { problems, insertBefore, insertAfter, removeBlank };
}

/** The last non-blank line at or before `end`. */
function trimEnd(lines: string[], end: number): number {
  let e = end;
  while (e > 0 && lines[e] === '') e--;
  return e;
}

const args = process.argv.slice(2);
const fix = args.includes('--fix');
const given = args.filter((a) => !a.startsWith('--'));
const files = given.length
  ? given
  : execFileSync('git', ['ls-files', '*.ts', '*.tsx'], { encoding: 'utf8' }).split('\n').filter(Boolean);

let failed = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const { problems, insertBefore, insertAfter } = check(lines);
  if (!problems.length) continue;
  for (const p of problems) console.error(`${file}:${p.line}: ${p.message}`);
  if (fix && (insertBefore.size || insertAfter.size)) {
    const out: string[] = [];
    lines.forEach((l, n) => {
      if (insertBefore.has(n)) out.push('');
      out.push(l);
      if (insertAfter.has(n)) out.push('');
    });
    writeFileSync(file, out.join('\n'));
  } else failed += problems.length;
}
if (failed) {
  console.error(`${failed} blank-line problem(s); run with --fix to repair the missing ones.`);
  process.exit(1);
}
