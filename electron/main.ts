// The Electron main process: creates the window, serves the built UI, grants MIDI access and does the
// native file work (open/save dialogs, PDF export) that the page asks for through the preload bridge.

import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';

const SCORE_FILTERS = [
  { name: 'Scores', extensions: ['txt', 'musicxml', 'xml'] },
  { name: 'All files', extensions: ['*'] },
];

// The one window (null while closed) and whether its document has unsaved changes, as last reported by the page.
let win: BrowserWindow | null = null;

let unsaved = false;

// The folder of the last file opened or saved, where the next dialog starts.
let lastDir: string | undefined;

/** Creates the main window and loads the built UI. */
function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    title: 'Thomas',
    icon: join(import.meta.dirname, '..', '..', 'build', 'icon.png'),
    backgroundColor: '#ffffff',
    webPreferences: { preload: join(import.meta.dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  const w = win;
  // F12 toggles the DevTools (the page uses Ctrl+Shift+I for itself).
  w.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      w.webContents.toggleDevTools();
      e.preventDefault();
    }
  });
  // The page reports unsaved changes; closing then asks first.
  w.on('close', (e) => {
    if (!unsaved) return;
    const choice = dialog.showMessageBoxSync(w, {
      type: 'question',
      buttons: ['Discard changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Discard unsaved changes?',
    });
    if (choice === 1) e.preventDefault();
  });
  w.on('closed', () => {
    win = null;
  });
  w.loadFile(join(import.meta.dirname, '..', 'ui', 'index.html'));
}

/** Registers the calls the page can make. */
function handlers() {
  ipcMain.handle('open', async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      defaultPath: lastDir,
      properties: ['openFile'],
      filters: SCORE_FILTERS,
    });
    const path = r.filePaths[0];
    if (r.canceled || !path) return null;
    lastDir = dirname(path);
    return { path, name: basename(path), data: await readFile(path, 'utf8') };
  });
  ipcMain.handle('save', async (_e, data: string, name: string, path: string | null) => {
    if (!win) return null;
    let target = path;
    if (!target) {
      const r = await dialog.showSaveDialog(win, {
        defaultPath: lastDir ? join(lastDir, name) : name,
        filters: SCORE_FILTERS,
      });
      if (r.canceled || !r.filePath) return null;
      target = r.filePath;
    }
    await writeFile(target, data, 'utf8');
    lastDir = dirname(target);
    return { path: target, name: basename(target) };
  });
  // The page has set up an `@page` size and rendered every page, so the PDF takes its size from the CSS.
  ipcMain.handle('pdf', async (_e, name: string) => {
    if (!win) return false;
    const r = await dialog.showSaveDialog(win, {
      defaultPath: `${name.replace(/\.[^.]*$/, '')}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return false;
    const pdf = await win.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true });
    await writeFile(r.filePath, pdf);
    return true;
  });
  ipcMain.on('unsaved', (_e, v: boolean) => {
    unsaved = v;
  });
}

app.whenReady().then(() => {
  // Web MIDI is what plays the score: grant it to our own page only.
  app.on('web-contents-created', (_e, wc) => {
    wc.session.setPermissionCheckHandler((_c, permission) => permission === 'midi' || permission === 'midiSysex');
    wc.session.setPermissionRequestHandler((_c, permission, cb) =>
      cb(permission === 'midi' || permission === 'midiSysex'),
    );
  });
  handlers();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
