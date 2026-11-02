// The application shell: toolbar (file, view, playback), the palette, score pane, Properties panel and the
// optional text pane. It owns file handling (open/save text, MusicXML import, printing to PDF) and
// otherwise only wires the panes to the signals in state.ts.

import { signal } from '@preact/signals';
import { lazy, Suspense } from 'preact/compat';
import { useEffect, useRef } from 'preact/hooks';
import { importMusicXml } from '../src/musicxml.ts';
import { parseText, writeText } from '../src/textformat.ts';
import { Dropdown } from './Dropdown.tsx';
import { Ui } from './icons.tsx';
import { zoomBy } from './interact.ts';
import { installKeys } from './keys.ts';
import { Palette } from './Palette.tsx';
import { Properties } from './Properties.tsx';
import { chooseOutput, midiOut, midiPorts, playing, toggle } from './player.ts';
import { ScorePane } from './ScorePane.tsx';
import { Shortcuts, showHelp } from './Shortcuts.tsx';
import {
  dirty,
  engraved,
  engraveError,
  fileName,
  fit,
  histLen,
  load,
  loadText,
  NEW_SCORE_TEXT,
  printing,
  redo,
  say,
  score,
  showCollisions,
  shownZoom,
  showProperties,
  showText,
  timing,
  toast,
  tool,
  undo,
  voiceColors,
  zoom,
} from './state.ts';

const viewOpen = signal(false);
const TextPane = lazy(() => import('./TextPane.tsx').then((m) => ({ default: m.TextPane })));
const examples = import.meta.glob('../examples/*.txt', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

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
    try {
      load(importMusicXml(src, { warn: (m) => console.warn(m) }), f.name.replace(/\.(musicxml|xml)$/i, '.txt'));
    } catch (e) {
      say(`Import failed: ${(e as Error).message}`, true);
    }
  } else loadText(src, f.name);
}

function printPdf() {
  const res = engraved.value;
  if (!res) return;
  const st =
    document.getElementById('print-page') ??
    document.head.appendChild(Object.assign(document.createElement('style'), { id: 'print-page' }));
  st.textContent = `@page { size: ${res.pages[0].width * res.staffSpace}mm ${res.pages[0].height * res.staffSpace}mm; margin: 0 }\n@media print { .page { height: ${res.pages[0].height * res.staffSpace - 1}mm !important; } }`; // a hair shorter than the sheet: rounding must not push an empty page after each one
  // Pages far from the viewport have no SVG yet: render all of them, wait for the DOM, then print.
  printing.value = true;
  const done = () => {
    printing.value = false;
    removeEventListener('afterprint', done);
  };
  addEventListener('afterprint', done);
  requestAnimationFrame(() => setTimeout(() => print(), 300));
}

export function App() {
  const fileIn = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const off = installKeys();
    const close = (e: Event) => {
      const t = e.target as HTMLElement;
      if (!t.closest?.('.viewmenu')) viewOpen.value = false;
    };
    addEventListener('pointerdown', close, true);
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty.peek()) e.preventDefault();
    };
    addEventListener('beforeunload', beforeUnload);
    const save = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        download(fileName.value, writeText(score.peek()));
        dirty.value = false;
      }
    };
    addEventListener('keydown', save);
    return () => {
      off();
      removeEventListener('pointerdown', close, true);
      removeEventListener('beforeunload', beforeUnload);
      removeEventListener('keydown', save);
    };
  }, []);
  const res = engraved.value;
  const h = histLen.value;
  const tst = toast.value;
  return (
    <div class="app">
      <header class="toolbar">
        <strong class="brand">Thomas</strong>
        <div class="seg">
          <button
            type="button"
            title="New score"
            onClick={() => {
              if (!dirty.value || confirm('Discard unsaved changes?')) {
                loadText(NEW_SCORE_TEXT, 'untitled.txt');
              }
            }}
          >
            New
          </button>
          <button type="button" title="Open a score (.txt) or MusicXML" onClick={() => fileIn.current?.click()}>
            Open…
          </button>
          <button
            type="button"
            title="Save as text file (Ctrl S)"
            onClick={() => {
              download(fileName.value, writeText(score.value));
              dirty.value = false;
            }}
          >
            Save{dirty.value ? ' •' : ''}
          </button>
          <button type="button" title="Print, or save as PDF from the print dialog" onClick={printPdf}>
            Print
          </button>
        </div>
        <input
          ref={fileIn}
          type="file"
          accept=".txt,.musicxml,.xml"
          hidden
          onChange={(e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (f) openFile(f);
            (e.target as HTMLInputElement).value = '';
          }}
        />
        <Dropdown
          value={undefined}
          title="Open an example"
          placeholder="Examples…"
          opts={Object.keys(examples).map((k) => ({ value: k, label: k.replace(/^.*\//, '') }))}
          onChange={(v) => {
            if (!dirty.value || confirm('Discard unsaved changes?')) loadText(examples[v], v.replace(/^.*\//, ''));
          }}
        />
        <span class="sep" />
        <button
          type="button"
          class="play"
          aria-pressed={playing.value}
          title="Play / stop (Space). Resumes where it stopped; Alt+click moves the playhead, Home rewinds"
          onClick={toggle}
        >
          {playing.value ? (
            <>
              <Ui.stop /> Stop
            </>
          ) : (
            <>
              <Ui.play /> Play
            </>
          )}
        </button>
        {midiPorts.value.length > 0 && (
          <Dropdown
            title="MIDI output"
            value={midiOut.value ?? ''}
            opts={midiPorts.value.map((p) => ({ value: p.id, label: p.name }))}
            onChange={chooseOutput}
          />
        )}
        <span class="sep" />
        <div class="seg">
          <button type="button" class="icon" disabled={!h.undo} title="Undo (Ctrl Z)" onClick={undo}>
            <Ui.undo />
          </button>
          <button type="button" class="icon" disabled={!h.redo} title="Redo (Ctrl Shift Z)" onClick={redo}>
            <Ui.redo />
          </button>
        </div>
        <span class="sep" />
        <div class="seg">
          <button type="button" class="icon" title="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
            <Ui.minus />
          </button>
          <span class="val">{Math.round((fit.value ? shownZoom.value : zoom.value) * 100)}%</span>
          <button type="button" class="icon" title="Zoom in" onClick={() => zoomBy(1.2)}>
            <Ui.plus />
          </button>
          <button
            type="button"
            aria-pressed={fit.value}
            title="Fit the pages to the window"
            onClick={() => {
              fit.value = !fit.value;
              zoom.value = 1;
            }}
          >
            Fit
          </button>
        </div>
        <div class="viewmenu" onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" aria-pressed={viewOpen.value} onClick={() => (viewOpen.value = !viewOpen.value)}>
            View ▾
          </button>
          {viewOpen.value && (
            <div class="popover">
              <label>
                <input
                  type="checkbox"
                  checked={voiceColors.value}
                  onChange={(e) => (voiceColors.value = (e.target as HTMLInputElement).checked)}
                />{' '}
                Voice colours
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={showCollisions.value}
                  onChange={(e) => (showCollisions.value = (e.target as HTMLInputElement).checked)}
                />{' '}
                Outline overlaps in red
              </label>
            </div>
          )}
        </div>
        <span class="grow" />
        <span class={`status${engraveError.value ? ' err' : ''}`}>
          {engraveError.value ||
            (res ? `${res.systems} systems · ${res.pages.length} pages · ${Math.round(timing.value)} ms` : '')}
        </span>
        <div class="seg">
          <button
            type="button"
            aria-pressed={showProperties.value}
            title="Properties (Ctrl I)"
            onClick={() => (showProperties.value = !showProperties.value)}
          >
            Properties
          </button>
          <button
            type="button"
            aria-pressed={showText.value}
            title="Text view (Ctrl E)"
            onClick={() => (showText.value = !showText.value)}
          >
            Text
          </button>
          <button
            type="button"
            class="icon"
            aria-pressed={showHelp.value}
            title="Keyboard shortcuts (?)"
            onClick={() => (showHelp.value = !showHelp.value)}
          >
            <Ui.help />
          </button>
        </div>
      </header>
      <div class="main">
        <Palette />
        <ScorePane />
        {showProperties.value && <Properties />}
        {showText.value && (
          <Suspense fallback={null}>
            <TextPane />
          </Suspense>
        )}
      </div>
      <Shortcuts />
      {tst && (
        <div class={`toast${tst.err ? ' err' : ''}`} role="status">
          {tst.msg}
        </div>
      )}
      <span hidden>
        {tool.value}
        {String(!!parseText)}
      </span>
    </div>
  );
}
