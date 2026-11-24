// The application shell: toolbar (file, view, playback), the palette, score pane, Properties panel and the
// optional text pane. It owns file handling (open/save text through the native dialogs, MusicXML import, PDF export) and
// otherwise only wires the panes to the signals in state.ts.

import { signal } from '@preact/signals';
import { lazy, Suspense } from 'preact/compat';
import { useEffect } from 'preact/hooks';
import { importMusicXml } from '../src/musicxml.ts';
import { writeText } from '../src/textformat.ts';
import { Dropdown } from './Dropdown.tsx';
import { Expression } from './Expression.tsx';
import { Ui } from './icons.tsx';
import { zoomBy } from './interact.ts';
import { installKeys } from './keys.ts';
import { LayersMenu } from './Layers.tsx';
import { layersOpen } from './layers.ts';
import { chooseInput, midiIn, midiInPorts } from './midiin.ts';
import { native } from './native.ts';
import { Overview } from './Overview.tsx';
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
  filePath,
  fit,
  histLen,
  load,
  loadText,
  NEW_SCORE_TEXT,
  printing,
  redo,
  say,
  score,
  showExpression,
  showHints,
  shownZoom,
  showProperties,
  showText,
  timing,
  toast,
  undo,
  voiceColors,
  zoom,
} from './state.ts';

const viewOpen = signal(false);
const TextPane = lazy(() => import('./TextPane.tsx').then((m) => ({ default: m.TextPane })));

/** Saves the score to its file, or asks for one when it has none yet (or when `as` is set). */
async function saveFile(as = false) {
  const r = await native.save(writeText(score.peek()), fileName.peek(), as ? null : filePath.peek());
  if (!r) return;
  filePath.value = r.path;
  fileName.value = r.name;
  dirty.value = false;
}

/** Opens a score from a file (text format or MusicXML), after asking whether to discard unsaved changes. */
async function openFile() {
  if (dirty.value && !confirm('Discard unsaved changes?')) return;
  const f = await native.open();
  if (!f) return;
  if (/\.(musicxml|xml)$/i.test(f.name)) {
    try {
      load(importMusicXml(f.data, { warn: (m) => console.warn(m) }), f.name.replace(/\.(musicxml|xml)$/i, '.txt'));
    } catch (e) {
      say(`Import failed: ${(e as Error).message}`, true);
    }
  } else if (loadText(f.data, f.name)) filePath.value = f.path;
}

/** Renders every page, sets the sheet size through `@page` and lets the main process write the PDF. */
async function exportPdf() {
  const res = engraved.value;
  if (!res) return;
  const st =
    document.getElementById('print-page') ??
    document.head.appendChild(Object.assign(document.createElement('style'), { id: 'print-page' }));
  st.textContent = `@page { size: ${res.pages[0].width * res.staffSpace}mm ${res.pages[0].height * res.staffSpace}mm; margin: 0 }\n@media print { .page { height: ${res.pages[0].height * res.staffSpace - 1}mm !important; } }`; // The page is a hair shorter than the sheet, because rounding must not push an empty page after each one.
  // Pages far from the viewport have no SVG yet: render all of them and wait for the DOM before the export.
  printing.value = true;
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 300)));
  try {
    await native.pdf(fileName.peek());
  } finally {
    printing.value = false;
  }
}

/** Installs the global handlers while the editor is mounted: shortcuts, closing the View menu, the open and save keys, the unsaved flag. */
function useGlobalHandlers(): void {
  useEffect(() => {
    const off = installKeys();
    const close = (e: Event) => {
      const t = e.target as HTMLElement;
      if (!t.closest?.('.viewmenu')) viewOpen.value = false;
      if (!t.closest?.('.layersmenu')) layersOpen.value = false;
    };
    addEventListener('pointerdown', close, true);
    const unsaved = dirty.subscribe((d) => native.setUnsaved(d));
    const save = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveFile(e.shiftKey);
      }
    };
    const open = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        openFile();
      }
    };
    addEventListener('keydown', save);
    addEventListener('keydown', open);
    return () => {
      off();
      removeEventListener('pointerdown', close, true);
      unsaved();
      removeEventListener('keydown', save);
      removeEventListener('keydown', open);
    };
  }, []);
}

/** The toolbar: file, playback, undo, zoom, view menu, status and pane switches. */
function Toolbar() {
  const res = engraved.value;
  const h = histLen.value;
  return (
    <header class="toolbar">
      <div class="seg apart">
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
        <button type="button" title="Open a score (.txt) or MusicXML (Ctrl O)" onClick={() => openFile()}>
          Open
        </button>
        <button type="button" title="Save (Ctrl S); Ctrl Shift S saves under a new name" onClick={() => saveFile()}>
          Save{dirty.value ? ' •' : ''}
        </button>
        <button type="button" title="Export as PDF" onClick={exportPdf}>
          Export PDF
        </button>
      </div>
      <span class="sep" />
      <button
        type="button"
        class="play"
        aria-pressed={playing.value}
        title="Play / stop (Space). Starts from the first selected note, else resumes where it stopped; Alt+click moves the playhead, Home rewinds"
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
      <button
        type="button"
        aria-pressed={midiIn.value !== null}
        title="Enter notes from a MIDI keyboard: select where to start, then play"
        onClick={() => chooseInput(midiIn.value === null ? undefined : null)}
      >
        MIDI in
      </button>
      {midiIn.value !== null && midiInPorts.value.length > 1 && (
        <Dropdown
          title="MIDI input"
          value={midiIn.value}
          opts={midiInPorts.value.map((p) => ({ value: p.id, label: p.name }))}
          onChange={(id) => chooseInput(id)}
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
              Voice colors
            </label>
          </div>
        )}
      </div>
      <LayersMenu />
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
          aria-pressed={showExpression.value}
          title="Expression: velocity, timing and pedals (Ctrl M)"
          onClick={() => (showExpression.value = !showExpression.value)}
        >
          Expression
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
          aria-pressed={showHints.value}
          title="Show hint texts (palette, Expression pane)"
          onClick={() => (showHints.value = !showHints.value)}
        >
          <Ui.hint />
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
  );
}

/** The editor window: toolbar, palette, score pane, text pane and Properties. */
export function App() {
  useGlobalHandlers();
  const tst = toast.value;
  return (
    <div class="app">
      <Toolbar />
      <div class="main">
        <Palette />
        <div class="scorecol">
          <ScorePane />
          {showExpression.value && <Expression />}
          <Overview />
        </div>
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
    </div>
  );
}
