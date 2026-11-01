// The application shell: toolbar (file, view, playback), the palette, score pane, inspector and the
// optional text pane. It owns file handling (open/save text, MusicXML import, printing to PDF) and
// otherwise only wires the panes to the signals in state.ts.
import { lazy, Suspense } from 'preact/compat';
import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { importMusicXml } from '../src/musicxml.ts';
import { writeText } from '../src/textformat.ts';
import {
  score, zoom, fit, showText, showInspector, showCollisions, engraved, timing, engraveError, histLen, undo, redo, fileName, dirty,
  loadText, load, toast, NEW_SCORE_TEXT, say, tool, voiceColors, printing,
} from './state.ts';
import { menu, zoomBy } from './interact.ts';
import { installKeys } from './keys.ts';
import { Palette } from './Palette.tsx';
import { Inspector } from './Inspector.tsx';
import { ScorePane } from './ScorePane.tsx';
import { parseText } from '../src/textformat.ts';
import { playing, toggle, midiPorts, midiOut, chooseOutput } from './player.ts';
import { Shortcuts, showHelp } from './Shortcuts.tsx';

const viewOpen = signal(false);
const TextPane = lazy(() => import('./TextPane.tsx').then((m) => ({ default: m.TextPane })));
const examples = import.meta.glob('../examples/*.txt', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function download(name: string, data: string, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function openFile(f: File) {
  if (dirty.value && !confirm('Discard unsaved changes?')) return;
  const src = await f.text();
  if (/\.(musicxml|xml)$/i.test(f.name)) {
    try { load(importMusicXml(src, { warn: (m) => console.warn(m) }), f.name.replace(/\.(musicxml|xml)$/i, '.txt')); }
    catch (e) { say(`Import failed: ${(e as Error).message}`, true); }
  } else loadText(src, f.name);
}

function printPdf() {
  const res = engraved.value;
  if (!res) return;
  const st = document.getElementById('print-page') ?? document.head.appendChild(Object.assign(document.createElement('style'), { id: 'print-page' }));
  st.textContent = `@page { size: ${res.pages[0].width * res.staffSpace}mm ${res.pages[0].height * res.staffSpace}mm; margin: 0 }\n@media print { .page { height: ${res.pages[0].height * res.staffSpace - 1}mm !important; } }`; // a hair shorter than the sheet: rounding must not push an empty page after each one
  // Pages far from the viewport have no SVG yet: render all of them, wait for the DOM, then print.
  printing.value = true;
  const done = () => { printing.value = false; removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  requestAnimationFrame(() => setTimeout(() => print(), 300));
}

/** Keep the context menu inside the viewport: flip to the other side of the click point when it would overflow. */
function placeMenu(el: HTMLUListElement | null) {
  const m = menu.value;
  if (!el || !m) return;
  const r = el.getBoundingClientRect(), pad = 4;
  const x = m.x + r.width + pad > innerWidth ? m.x - r.width : m.x;
  const y = m.y + r.height + pad > innerHeight ? m.y - r.height : m.y;
  el.style.left = `${Math.max(pad, x)}px`;
  el.style.top = `${Math.max(pad, y)}px`;
}

export function App() {
  const fileIn = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const off = installKeys();
    const close = (e: Event) => { const t = e.target as HTMLElement; if (!t.closest?.('.ctxmenu')) menu.value = null; if (!t.closest?.('.viewmenu')) viewOpen.value = false; };
    addEventListener('pointerdown', close, true);
    const beforeUnload = (e: BeforeUnloadEvent) => { if (dirty.peek()) e.preventDefault(); };
    addEventListener('beforeunload', beforeUnload);
    const save = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); download(fileName.value, writeText(score.peek())); dirty.value = false; } };
    addEventListener('keydown', save);
    return () => { off(); removeEventListener('pointerdown', close, true); removeEventListener('beforeunload', beforeUnload); removeEventListener('keydown', save); };
  }, []);
  const res = engraved.value;
  const h = histLen.value;
  const tst = toast.value;
  const m = menu.value;
  return (
    <div class="app">
      <header class="toolbar">
        <strong class="brand">Thomas</strong>
        <button title="New score" onClick={() => { if (!dirty.value || confirm('Discard unsaved changes?')) { loadText(NEW_SCORE_TEXT, 'untitled.txt'); } }}>New</button>
        <button title="Open a score (.txt) or MusicXML" onClick={() => fileIn.current?.click()}>Open…</button>
        <input ref={fileIn} type="file" accept=".txt,.musicxml,.xml" hidden onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) openFile(f); (e.target as HTMLInputElement).value = ''; }} />
        <select value="" title="Open an example" onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v && (!dirty.value || confirm('Discard unsaved changes?'))) loadText(examples[v], v.replace(/^.*\//, '')); }}>
          <option value="">Examples…</option>
          {Object.keys(examples).map((k) => <option value={k}>{k.replace(/^.*\//, '')}</option>)}
        </select>
        <button title="Save as text file (Ctrl S)" onClick={() => { download(fileName.value, writeText(score.value)); dirty.value = false; }}>Save{dirty.value ? ' •' : ''}</button>
        <button title="Print, or save as PDF from the print dialog" onClick={printPdf}>Print</button>
        <span class="sep" />
        <button class="play" aria-pressed={playing.value} title="Play / stop (Space). Resumes where it stopped; Alt+click moves the playhead, Home rewinds" onClick={toggle}>{playing.value ? '■ Stop' : '▶ Play'}</button>
        {midiPorts.value.length > 0 && (
          <select title="MIDI output" value={midiOut.value ?? ''} onChange={(e) => chooseOutput((e.target as HTMLSelectElement).value)}>
            {midiPorts.value.map((p) => <option value={p.id}>{p.name}</option>)}
          </select>
        )}
        <span class="sep" />
        <button disabled={!h.undo} title="Undo (Ctrl Z)" onClick={undo}>↶</button>
        <button disabled={!h.redo} title="Redo (Ctrl Shift Z)" onClick={redo}>↷</button>
        <span class="sep" />
        <button title="Zoom out" onClick={() => zoomBy(1 / 1.2)}>−</button>
        <span class="status zoomv">{fit.value ? 'fit' : `${Math.round(zoom.value * 100)}%`}</span>
        <button title="Zoom in" onClick={() => zoomBy(1.2)}>+</button>
        <button aria-pressed={fit.value} title="Fit the pages to the window" onClick={() => { fit.value = !fit.value; zoom.value = 1; }}>Fit</button>
        <div class="viewmenu" onPointerDown={(e) => e.stopPropagation()}>
          <button aria-pressed={viewOpen.value} onClick={() => (viewOpen.value = !viewOpen.value)}>View ▾</button>
          {viewOpen.value && (
            <div class="popover">
              <label><input type="checkbox" checked={voiceColors.value} onChange={(e) => (voiceColors.value = (e.target as HTMLInputElement).checked)} /> Voice colours</label>
              <label><input type="checkbox" checked={showCollisions.value} onChange={(e) => (showCollisions.value = (e.target as HTMLInputElement).checked)} /> Outline overlaps in red</label>
            </div>
          )}
        </div>
        <span class="grow" />
        <span class={`status${engraveError.value ? ' err' : ''}`}>
          {engraveError.value || (res ? `${res.systems} systems · ${res.pages.length} pages · ${Math.round(timing.value)} ms` : '')}
        </span>
        <button aria-pressed={showInspector.value} title="Properties (Ctrl I)" onClick={() => (showInspector.value = !showInspector.value)}>Properties</button>
        <button aria-pressed={showText.value} title="Text view (Ctrl E)" onClick={() => (showText.value = !showText.value)}>Text</button>
        <button title="Keyboard shortcuts (?)" onClick={() => (showHelp.value = !showHelp.value)}>?</button>
      </header>
      <div class="main">
        <Palette />
        <ScorePane />
        {showInspector.value && <Inspector />}
        {showText.value && <Suspense fallback={null}><TextPane /></Suspense>}
      </div>
      <Shortcuts />
      {tst && <div class={`toast${tst.err ? ' err' : ''}`} role="status">{tst.msg}</div>}
      {m && (
        <ul class="ctxmenu" ref={(el) => placeMenu(el)} style={{ left: `${m.x}px`, top: `${m.y}px` }} onPointerDown={(e) => e.stopPropagation()}>
          {m.items.map((it) => it.sep ? <li class="sep" /> : <li><button class={it.danger ? 'danger' : ''} onClick={() => { menu.value = null; it.run(); }}>{it.label}</button></li>)}
        </ul>
      )}
      <span hidden>{tool.value}{String(!!parseText)}</span>
    </div>
  );
}
