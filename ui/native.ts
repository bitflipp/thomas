// The native side of the desktop app: the calls that the preload script exposes as `window.native`
// (file dialogs, PDF export, the unsaved-changes flag). The implementation lives in electron/main.ts.

type NativeApi = {
  open(): Promise<{ path: string; name: string; data: string } | null>;
  save(data: string, name: string, path: string | null): Promise<{ path: string; name: string } | null>;
  pdf(name: string): Promise<boolean>;
  setUnsaved(v: boolean): void;
};

/** The bridge to the main process; the editor only runs inside the Electron shell. */
export const native = (window as unknown as { native: NativeApi }).native;
