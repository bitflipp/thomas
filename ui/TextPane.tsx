import { useEffect, useRef, useState } from 'preact/hooks';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { parseText, validate, textOf, commit } from './state.ts';

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
        extensions: [basicSetup, EditorView.updateListener.of((u) => {
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
    });
    return () => { clearTimeout(timer); off(); v.destroy(); };
  }, []);
  return (
    <aside class="textpane">
      <div class="cm-host" ref={host} />
      {err && <div class="diag">{err}</div>}
    </aside>
  );
}
