import { useEffect, useRef, useState } from 'preact/hooks';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet } from '@codemirror/view';
import { effect } from '@preact/signals';
import { refKey, type Ref } from '../src/editor/addr.ts';
import { dependentNotes } from '../src/editor/hit.ts';
import { parseText, validate, textOf, textMap, selection, score, commit } from './state.ts';

// The selection of the score pane, shown in the text: the selected parts, and the notes they depend on (a slur's ends ...).
const setMarks = StateEffect.define<{ from: number; to: number; cls: string }[]>();
const marks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) if (e.is(setMarks)) set = Decoration.set(e.value.filter((m) => m.to > m.from).map((m) => Decoration.mark({ class: m.cls }).range(m.from, m.to)), true);
    return set;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Ranges in the text for the selected refs; the first one to scroll to. */
function selectedRanges(refs: readonly Ref[]): { from: number; to: number; cls: string }[] {
  const { ranges } = textMap.peek(), sc = score.peek();
  const out: { from: number; to: number; cls: string }[] = [];
  const add = (key: string, cls: string) => { for (const [from, to] of ranges.get(key) ?? []) out.push({ from, to, cls }); };
  for (const r of refs) {
    // heads, ties and slurs are written as part of their note
    const own: Ref = r.t === 'ev' || r.t === 'tie' || r.t === 'slur' ? { t: 'ev', mi: r.mi, staff: r.staff, voice: r.voice, idx: r.idx } : r;
    add(refKey(own), 'cm-ref-sel');
    for (const a of dependentNotes(sc, r)) add(refKey({ t: 'ev', ...a }), 'cm-ref-dep');
  }
  return out;
}

/** The score as text (FORMAT.md). Editing here re-parses after a pause; a valid result becomes one undoable edit. */
export function TextPane() {
  const host = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let programmatic = false, fromEditor = false;
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: textOf.peek(),
        extensions: [basicSetup, marks, EditorView.updateListener.of((u) => {
          if (!u.docChanged || programmatic) return;
          clearTimeout(timer);
          timer = setTimeout(() => {
            try {
              const s = parseText(u.state.doc.toString());
              const errs = validate(s);
              if (errs.length) { setErr(errs.slice(0, 8).join('\n')); return; }
              setErr('');
              fromEditor = true;
              try { commit(s); } finally { fromEditor = false; }
            } catch (e) { setErr((e as Error).message); }
          }, 350);
        })],
      }),
    });
    // changes made elsewhere (mouse editing, undo) flow into the editor, unless this editor is where they came from
    const off = textOf.subscribe((t) => {
      if (fromEditor || t === v.state.doc.toString()) return;
      programmatic = true;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } });
      programmatic = false;
      setErr('');
      showSelection();
    });
    // the selection of the score pane, when the editor still shows exactly the text it was computed for
    function showSelection(): void {
      if (v.state.doc.toString() !== textMap.peek().text) { v.dispatch({ effects: setMarks.of([]) }); return; }
      const rs = selectedRanges(selection.peek());
      const first = rs.find((r) => r.cls === 'cm-ref-sel') ?? rs[0];
      v.dispatch({ effects: [setMarks.of(rs), ...(first ? [EditorView.scrollIntoView(first.from, { y: 'nearest', yMargin: 40 })] : [])] });
    }
    const offSel = effect(() => { selection.value; textMap.value; showSelection(); });
    return () => { clearTimeout(timer); off(); offSel(); v.destroy(); };
  }, []);
  return (
    <aside class="textpane">
      <div class="cm-host" ref={host} />
      {err && <div class="diag">{err}</div>}
    </aside>
  );
}
