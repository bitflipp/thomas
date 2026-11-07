// The preload script: exposes the few native calls of the main process to the page as `window.native`.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('native', {
  open: () => ipcRenderer.invoke('open'),
  save: (data: string, name: string, path: string | null) => ipcRenderer.invoke('save', data, name, path),
  pdf: (name: string) => ipcRenderer.invoke('pdf', name),
  setUnsaved: (v: boolean) => ipcRenderer.send('unsaved', v),
});
