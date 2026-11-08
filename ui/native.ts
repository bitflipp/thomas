// The native side of the editor: file dialogs, PDF export and the unsaved-changes flag. In the desktop
// app they are the calls that the preload script exposes as `window.native` (implemented in
// electron/main.ts); in a plain browser (the built UI served by any static server) the same calls are
// made with the File System Access API where there is one (Chromium), else with a file input and a
// download, and PDF export is the browser's print dialog.

type NativeApi = {
  open(): Promise<{ path: string; name: string; data: string } | null>;
  save(data: string, name: string, path: string | null): Promise<{ path: string; name: string } | null>;
  pdf(name: string): Promise<boolean>;
  setUnsaved(v: boolean): void;
};

/** The File System Access API is not in the DOM typings of every setup: just what is used here. */
type FileHandle = {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
};

type Picker = {
  showOpenFilePicker?: (o: unknown) => Promise<FileHandle[]>;
  showSaveFilePicker?: (o: unknown) => Promise<FileHandle>;
};

const TYPES = [{ description: 'Scores', accept: { 'text/plain': ['.txt'], 'application/xml': ['.musicxml', '.xml'] } }];

/** The handles of the files opened or saved in this page, by the path the editor keeps for them (the name; there are no real paths in a browser). */
const handles = new Map<string, FileHandle>();

/** A user cancelling a picker rejects with an AbortError, which is no failure. */
const cancelled = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/** Lets the user choose a file through an `<input type=file>` (the fallback without a file picker API). */
function pickWithInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.musicxml,.xml';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

const browserApi: NativeApi = {
  async open() {
    const w = window as unknown as Picker;
    try {
      if (w.showOpenFilePicker) {
        const [h] = await w.showOpenFilePicker({ types: TYPES });
        handles.set(h.name, h);
        return { path: h.name, name: h.name, data: await (await h.getFile()).text() };
      }
      const f = await pickWithInput();
      return f ? { path: f.name, name: f.name, data: await f.text() } : null;
    } catch (e) {
      if (cancelled(e)) return null;
      throw e;
    }
  },
  async save(data, name, path) {
    const w = window as unknown as Picker;
    try {
      let h = path ? handles.get(path) : undefined;
      if (!h && w.showSaveFilePicker) {
        h = await w.showSaveFilePicker({ suggestedName: name, types: TYPES });
        handles.set(h.name, h);
      }
      if (h) {
        const out = await h.createWritable();
        await out.write(data);
        await out.close();
        return { path: h.name, name: h.name };
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([data], { type: 'text/plain' }));
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
      return { path: name, name };
    } catch (e) {
      if (cancelled(e)) return null;
      throw e;
    }
  },
  pdf() {
    window.print(); // The page sets up its `@page` size; "Save as PDF" is the printer to choose.
    return Promise.resolve(true);
  },
  setUnsaved(v) {
    window.onbeforeunload = v ? (e) => e.preventDefault() : null;
  },
};

/** The bridge to the main process in the desktop app, else the browser implementation. */
export const native: NativeApi = (window as unknown as { native?: NativeApi }).native ?? browserApi;

/** Whether paths are real file paths that survive a restart (the desktop app), not browser handles. */
export const hasRealPaths = (window as unknown as { native?: NativeApi }).native !== undefined;
