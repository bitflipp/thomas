---
name: maintain
description: Run a maintainability pass over this repository (module headers, explanatory comments, dead code, duplicated helpers, over-long functions, lint and tests green). Use when asked for a "maintainability pass", "maintain", cleanup or comment pass. Behavior-preserving only.
---

# maintain

A maintainability pass changes how the code reads, never what it does. It is modeled on the pass in the Git history: `fb0f629` (the pass itself), `c4a68ad` (split `tidy()`), `61c113e` (Biome) and `f87734d` + `d0f8cb7` + `a3350ec` (comment and blank-line style, `tools/blanklines.ts`, CLAUDE.md). Read `CLAUDE.md` first; its "Comment and blank-line style" section is the rule set.

Optional argument: a path or area to limit the pass. Without one, the scope is everything since the last maintenance pass, as if the argument were "Everything since last maintenance": the files changed in `git diff <last pass>..HEAD --stat` (within `src/`, `ui/`, `electron/`, `tools/`, `test/`), not the whole repository. Before starting, run `git log --oneline -n 30 | grep -iE "maintain|style pass"` to find the last pass and that diff to see what changed; spend effort there. Only a request for the whole repository (for example "everything" or "all files") widens the scope to all of those directories.

## Steps

Trace each step: write one line per step to the user when it starts and a one-line result when it ends (files touched, what was removed or split). Keep a running list of anything you decided *not* to change and why.

1. **Baseline.** Run `npm test` and `npm run lint`. Record failures that already exist; they are not yours to hide. Check `git status` and do not mix the pass with unrelated uncommitted work (ask or stash if there is any).
2. **Module headers.** Every file starts with a header comment (what the module is for, how it fits the pipeline `text/MusicXML -> Score -> prepare -> spacing -> ... -> SVG`), a blank line, then the imports. Add or rewrite where missing or stale (new modules from recent commits are the usual gap).
3. **Explanatory comments.** Replace one-line cryptic or trailing comments with multi-line explanations of the *why*: invariants, units (ticks, staff spaces, half-spaces), ordering requirements, idempotency (`spaceMeasure` runs twice), cache keys. Fix comments that no longer match the code. Do not narrate what the code plainly says.
4. **Doc comments.** Functions (declarations and arrow functions bound to a `const`) get `/** ... */`; exported types and non-obvious fields get one too. `//` is for inside bodies and sections.
5. **Sections.** No `// ---- name ---` banners. A section starts with a plain `//` comment of a few lines (what it is for, how it relates to the rest), followed by a blank line.
6. **Comment grammar.** Each comment is a complete sentence: capital letter, ending punctuation, including trailing comments. Exception: a comment starting with an identifier or code.
7. **Dead code.** Find unused exports, parameters, locals, placeholders such as `void x;`, commented-out code, unreachable branches (`grep` for each export's uses across `src ui electron test tools`; the type checker via `npx tsc --noEmit` if configured, and Biome's unused rules). Remove them and fix the call sites. Check dev-only hooks (`window.__t`) and CLI entry points before calling something unused.
8. **Duplicates.** Look for near-identical helpers (the earlier pass replaced a duplicate clef helper). Replace by the existing one, or lift into the module that owns the concept (`context.ts`, `util.ts`, `model.ts`). Only merge when the behavior is really the same.
9. **Long functions.** Split functions that mix several jobs into named passes (as `tidy()` became dissolve, slur and hairpin passes). Keep the order of effects; mind the constraints in CLAUDE.md (idempotent `spaceMeasure`, no `marksOf` on drafts, stable owner tags, cache keys).
10. **Docs in sync.** If structure, commands or conventions changed, update `CLAUDE.md`, and `FORMAT.md` if the text format was touched. Do not describe things the code does not do.
11. **Format and lint.** `npm run lint:fix`, then `npm run lint` must be clean (Biome, import order, `tools/blanklines.ts`). Fix remaining findings by hand; do not disable rules or relax `biome.json`.
12. **Verify behavior is unchanged.** `npm test` must give the same result as the baseline (all green unless it was red before). For engraver changes also confirm the output is identical: render `test/fixtures/study.txt` before and after (`node src/cli.ts render ... out/before` / `out/after`) and `diff` the SVGs. The UI must still build (`npm run ui:build`) if `ui/` was touched.
13. **Dependency audit.** Run `npm audit` and report the result. Do not run `npm audit fix --force` or change dependencies as part of the pass (that is not behavior-preserving): list the findings and let the user decide. (The 6 moderate `minimatch` findings accepted on 2026-11-07 came from `electron-builder`, which has since been removed; any finding now is new.)
14. **Commit.** Only if the user asked for it: one commit, message in the style `Maintainability pass: <what changed, comma-separated>` (for a narrower pass, `Comment style pass: ...`). Split into separate commits when a refactor (step 9) is independent of the comment work. Never commit with failing lint or tests.
15. **Report.** Summarize per step what changed, the test/lint/diff results, the audit result, and the list of things deliberately left alone.

## Rules

- Behavior-preserving: no feature changes, no renamed public text-format syntax, no visual change. If a bug turns up, report it; fix it only in a separate step the user approves.
- Type-stripping constraints hold: no enums, no parameter properties, `.ts` import extensions, `must(x)` instead of `!`.
- Prefer small, reviewable edits file by file; run `npm test` after each larger refactor, not only at the end.
