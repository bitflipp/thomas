// Actions on the selection, shared by the palette, the inspector and the keyboard shortcuts so that all
// three behave the same. Each one runs a pure command from src/editor/commands.ts on every selected
// event and commits the result as one undoable step; a refusal (`EditError`) is shown in the status
// line instead of changing anything.
import type { BaseDur, Dur } from '../src/model.ts';
import * as C from '../src/editor/commands.ts';
import { eventOf, type EvAddr } from '../src/editor/addr.ts';
import { transposeSemis } from '../src/editor/context.ts';
import { score, selection, run, dur, dots, say, commit } from './state.ts';
import { evRefs } from './interact.ts';

const sortedDesc = (a: EvAddr, b: EvAddr) => a.mi - b.mi || a.staff.localeCompare(b.staff) || a.voice - b.voice || b.idx - a.idx;

/** Apply a new duration to the selected events (from the end so earlier indices stay valid). */
export function setDurationSel(d: Dur): void {
  const refs = [...evRefs()].sort(sortedDesc);
  if (!refs.length) return;
  let s = score.peek();
  try { for (const r of refs) s = C.setDuration(s, r, d); commit(s); }
  catch (e) { if (e instanceof C.EditError) say(e.message, true); else throw e; }
}

export function chooseDuration(base: BaseDur): void {
  dur.value = base;
  if (evRefs().length) setDurationSel({ base, dots: dots.peek() });
}
export function chooseDots(n: number): void {
  dots.value = n;
  const refs = evRefs();
  if (refs.length) { const e = eventOf(score.peek(), refs[0]); setDurationSel({ base: e?.dur.base ?? dur.peek(), dots: n }); }
}

export function setAccidentalSel(alter: number | undefined): void {
  const refs = evRefs();
  if (!refs.length || alter === undefined) return;
  run((s) => C.updateNotes(s, refs, (n) => {
    n.pitches.forEach((np, i) => {
      const t = refs.find((r) => r.pi !== undefined);
      if (t?.pi !== undefined && t.pi !== i) return;
      np.pitch = { ...np.pitch, alter };
    });
  }));
}

export function nudge(semis?: number, steps?: number): void {
  const refs = evRefs();
  if (!refs.length) return;
  run((s) => C.transpose(s, refs, { semis, steps }));
}

export function flipStem(): void {
  const refs = evRefs();
  if (!refs.length) return;
  const first = eventOf(score.peek(), refs[0]);
  const next = first?.stem === 'up' ? 'down' : first?.stem === 'down' ? undefined : 'up';
  run((s) => C.updateEvents(s, refs, (e) => { if (next) e.stem = next; else delete e.stem; }));
}

export function slurSelection(): void {
  const refs = [...evRefs()].sort((a, b) => a.mi - b.mi || a.idx - b.idx);
  if (refs.length < 2) { say('Select at least two notes in one voice', true); return; }
  const a = refs[0], b = refs[refs.length - 1];
  run((s) => C.addSlur(s, a, b));
}

export function tieSelection(): void { const refs = evRefs(); if (refs.length) run((s) => C.toggleTie(s, refs)); }

export function stepSelection(dir: -1 | 1, extend = false): void {
  const sc = score.peek();
  const cur = selection.peek().filter((r) => r.t === 'ev');
  if (!cur.length) return;
  const last = cur[cur.length - 1] as EvAddr;
  const v = sc.measures[last.mi]?.staves[last.staff]?.voices.find((x) => x.id === last.voice);
  if (!v) return;
  let mi = last.mi, idx = last.idx + dir;
  const count = (m: number) => sc.measures[m]?.staves[last.staff]?.voices.find((x) => x.id === last.voice)?.items.reduce((n, it) => n + countEvents(it), 0) ?? 0;
  if (idx < 0) { mi--; if (mi < 0) return; idx = count(mi) - 1; }
  else if (idx >= count(mi)) { mi++; idx = 0; if (mi >= sc.measures.length) return; }
  if (idx < 0 || count(mi) === 0) return;
  const ref = { t: 'ev' as const, mi, staff: last.staff, voice: last.voice, idx };
  selection.value = extend ? [...selection.peek(), ref] : [ref];
}
function countEvents(it: import('../src/model.ts').Item): number { return 'items' in it ? it.items.reduce((n, x) => n + countEvents(x), 0) : 1; }
void transposeSemis;
