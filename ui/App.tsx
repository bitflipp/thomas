// The application shell: the toolbar (file, playback, undo, the controls of the mode, the mode selector) and the main
// area of the mode (`mode` in state.ts): Score (palette, score pane, Properties), Expression or Text, each over the
// whole width. It owns file handling (open/save text through the native dialogs, MusicXML import, PDF export) and
// otherwise only wires the panes to the signals in state.ts.

import { computed, signal } from '@preact/signals';
import { lazy, Suspense } from 'preact/compat';
import { useEffect } from 'preact/hooks';
import { importMusicXml } from '../src/musicxml.ts';
import { writeText } from '../src/textformat.ts';
import { Expression, ExpressionTools } from './Expression.tsx';
import { fitRoll, zoomRoll } from './expression.ts';
import { Ui } from './icons.tsx';
import { zoomBy } from './interact.ts';
import { installKeys } from './keys.ts';
import { LayersMenu } from './Layers.tsx';
import { layersOpen } from './layers.ts';
import { chooseInput, listInputs, midiIn, midiInPorts } from './midiin.ts';
import { native } from './native.ts';
import { Overview } from './Overview.tsx';
import { Palette } from './Palette.tsx';
import { PortMenu } from './PortMenu.tsx';
import { Properties } from './Properties.tsx';
import { chooseOutput, listOutputs, midiOut, midiPorts, playing, toggle } from './player.ts';
import { ScorePane } from './ScorePane.tsx';
import { Shortcuts, showHelp } from './Shortcuts.tsx';
import type { Mode } from './state.ts';

import {
  dirty,
  EXPR_BASE_PPQ,
  engraved,
  engraveError,
  exprView,
  fileName,
  filePath,
  fit,
  histLen,
  load,
  loadText,
  mode,
  NEW_SCORE_TEXT,
  printing,
  redo,
  say,
  score,
  showExpression,
  shownZoom,
  showProperties,
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

/** The zoom of the Expression roll alone, so that panning (which changes the rest of the view) does not re-render the zoom. */
const rollPpq = computed(() => exprView.value.ppq);

/**
 * The zoom of the view that is shown: the score (Fit is a mode that keeps the pages fitted to the window) or the
 * Expression roll (zoom as a percentage of the one it starts at, Fit shows the whole piece once).
 */
function ZoomControls() {
  if (showExpression.value) {
    return (
      <div class="seg">
        <button type="button" class="icon" title="Zoom out (Ctrl -)" onClick={() => zoomRoll(1 / 1.2)}>
          <Ui.minus />
        </button>
        <span class="val">{Math.round((rollPpq.value / EXPR_BASE_PPQ) * 100)}%</span>
        <button type="button" class="icon" title="Zoom in (Ctrl +)" onClick={() => zoomRoll(1.2)}>
          <Ui.plus />
        </button>
        <button type="button" title="Show the whole piece" onClick={fitRoll}>
          Fit
        </button>
      </div>
    );
  }
  return (
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
  );
}

/** The modes of the main area, in the order of the toolbar's mode selector. */
const MODES: { mode: Mode; label: string; title: string }[] = [
  { mode: 'score', label: 'Score', title: 'The score, with the palette and Properties' },
  {
    mode: 'expression',
    label: 'Expression',
    title: 'How the piece is played: velocities, timing, tempo and pedals (Ctrl Space)',
  },
  { mode: 'text', label: 'Text', title: 'The score as text (Ctrl E)' },
];

/** The toolbar: file, playback, undo, the controls of the mode (zoom, menus, tools), engraver errors, mode selector and help. */
function Toolbar() {
  const m = mode.value;
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
      <PortMenu
        heading="MIDI output"
        ports={midiPorts.value}
        value={midiOut.value}
        onPick={chooseOutput}
        onOpen={listOutputs}
        empty="None found. Start a synthesizer (e.g. FluidSynth)."
      >
        <button
          type="button"
          class="play"
          aria-pressed={playing.value}
          title="Play / stop (Space). Starts from the playhead, where it stopped; Alt+click moves the playhead, Home rewinds. Right click or ▾ chooses the MIDI output"
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
      </PortMenu>
      {/* Note entry from a MIDI keyboard is for the score; the other modes leave it out. */}
      {m === 'score' && (
        <PortMenu
          heading="MIDI input"
          ports={midiInPorts.value}
          value={midiIn.value}
          onPick={(id) => chooseInput(id)}
          onOpen={listInputs}
          empty="None found. Plug in a keyboard."
        >
          <button
            type="button"
            aria-pressed={midiIn.value !== null}
            title="Enter notes from a MIDI keyboard: select where to start, then play. Right click or ▾ chooses the input"
            onClick={() => chooseInput(midiIn.value === null ? undefined : null)}
          >
            MIDI in
          </button>
        </PortMenu>
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
      {/* The middle of the toolbar belongs to the mode: zoom, View and Layers for the score, zoom and the tools of the
          Expression view there, nothing for the text. */}
      {m === 'score' && (
        <>
          <span class="sep" />
          <ZoomControls />
          <div class="viewmenu" onPointerDown={(e) => e.stopPropagation()}>
            <button type="button" aria-pressed={viewOpen.value} onClick={() => (viewOpen.value = !viewOpen.value)}>
              View ▾
            </button>
            {viewOpen.value && (
              <div class="popover">
                <label>
                  <input
                    type="checkbox"
                    checked={showProperties.value}
                    onChange={(e) => (showProperties.value = (e.target as HTMLInputElement).checked)}
                  />{' '}
                  Properties (Ctrl I)
                </label>
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
        </>
      )}
      {m === 'expression' && (
        <>
          <span class="sep" />
          <ZoomControls />
          <span class="sep" />
          <ExpressionTools />
        </>
      )}
      <span class="grow" />
      {engraveError.value && <span class="status err">{engraveError.value}</span>}
      <div class="seg" title="Mode">
        {MODES.map((x) => (
          <button
            key={x.mode}
            type="button"
            aria-pressed={m === x.mode}
            title={x.title}
            onClick={() => (mode.value = x.mode)}
          >
            {x.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        class="icon"
        aria-pressed={showHelp.value}
        title="Keyboard shortcuts (?)"
        onClick={() => (showHelp.value = !showHelp.value)}
      >
        <Ui.help />
      </button>
    </header>
  );
}

/** The editor window: the toolbar and the main area of the mode (palette, score and Properties; Expression; Text). */
export function App() {
  useGlobalHandlers();
  const m = mode.value;
  const tst = toast.value;
  return (
    <div class="app">
      <Toolbar />
      <div class="main">
        {/* The palette and Properties act on the score; the other modes take the whole width. The score pane stays
            mounted (collapsed) so that its scroll position survives. */}
        {m === 'score' && <Palette />}
        <div class={`scorecol${m === 'expression' ? ' xmax' : m === 'text' ? ' tmax' : ''}`}>
          <ScorePane />
          {m === 'expression' && <Expression />}
          {m !== 'text' && <Overview />}
        </div>
        {m === 'score' && showProperties.value && <Properties />}
        {m === 'text' && (
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
